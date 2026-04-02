/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import express from 'express';
import Router from 'express-promise-router';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import fetch from 'node-fetch';
import { simpleGit } from 'simple-git';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as yaml from 'yaml';
import { spawn } from 'child_process';

// Modules
import { FraConfig } from '../modules/config/FraConfig';
import { detectServices } from '../modules/discovery/ServiceDiscoveryEngine';
import { fixDockerfiles } from '../modules/orchestration/DockerfileFixerAdapter';
import { createServerWrappers } from '../modules/orchestration/ServerWrapperGenerator';
import {
  generateDockerCompose,
  injectOtelIntoComposeContent,
} from '../modules/orchestration/DockerComposeAdapter';
import { buildCatalogInfo } from '../modules/catalog/CatalogEntityBuilder';
import { extractRepoName } from '../modules/ingestion/RepositoryIngestor';
import { generateGoTracing } from '../modules/orchestration/CodeGenerationAdapter';
import {
  generatePowerShellScript,
  generateBashScript,
} from '../modules/orchestration/ScriptGenerationAdapter';
import { analyzeFunctionCalls } from '../modules/analysis/FunctionCallAnalyzer';
import { applyDecisionLogic } from '../modules/analysis/RelocationDecisionEngine';

/**
 * Dependencies of the function-analytics router
 */
export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  /** Optional FraConfig — defaults to FraConfig.defaults() when not provided */
  config?: FraConfig;
}

/**
 * Creates an express.Router with endpoints for function analytics
 *
 * @param options - the dependencies of the router
 * @returns an express.Router
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger } = options;
  const config = options.config ?? new FraConfig();

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, response) => {
    logger.info('Function Analytics health check');
    response.json({ status: 'ok' });
  });

  // GET /analyze - fetch traces from Jaeger and produce relocation recommendations
  router.get('/analyze', async (req, res) => {
    try {
      const service = (req.query.service as string) || 'all';
      const lookbackParam = (req.query.lookback as string) || '1h';

      let lookback = lookbackParam.toLowerCase();
      if (lookback === '7d') lookback = '168h';

      logger.info(
        `Analyzing function calls for service: ${service} with lookback: ${lookback}`,
      );

      let allTraces: any[] = [];
      const jaegerBase = config.jaegerBaseUrl;

      const fetchWithTimeout = async (url: string, timeoutMs = 5000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(url, { signal: controller.signal as any });
          return r;
        } finally {
          clearTimeout(timer);
        }
      };

      if (service === 'all' || service === '') {
        logger.info('Fetching list of all services from Jaeger');
        let services: string[] = [];
        try {
          const servicesRes = await fetchWithTimeout(`${jaegerBase}/services`);
          if (servicesRes.ok) {
            const servicesData = await servicesRes.json();
            services = (servicesData.data || []) as string[];
          }
        } catch (e) {
          logger.warn(`Could not fetch service list: ${e}`);
        }

        const targetServices = services.filter(
          svc =>
            !svc.startsWith('jaeger') &&
            !svc.startsWith('unknown_service:') &&
            svc !== 'jaeger-query' &&
            svc !== 'jaeger-all-in-one',
        );

        logger.info(
          `Fetching traces for ${
            targetServices.length
          } services: ${targetServices.join(', ')}`,
        );

        const traceResults = await Promise.allSettled(
          targetServices.map(async svc => {
            const jaegerUrl = `${jaegerBase}/traces?service=${encodeURIComponent(
              svc,
            )}&limit=${config.maxTracesPerService}&lookback=${lookback}`;
            const r = await fetchWithTimeout(jaegerUrl);
            logger.info(
              `[Backend Step 1] Fetching raw traces for ${svc} via: ${jaegerUrl}`,
            );
            if (!r.ok) return [];
            const d = await r.json();
            logger.info(
              `[Backend Step 1] Jaeger returned ${
                d.data?.length || 0
              } span records for ${svc}`,
            );
            return (d.data || []) as any[];
          }),
        );

        for (const result of traceResults) {
          if (result.status === 'fulfilled') {
            for (const trace of result.value) {
              if (!allTraces.some(t => t.traceID === trace.traceID)) {
                allTraces.push(trace);
              }
            }
          }
        }
      } else {
        const jaegerUrl = `${jaegerBase}/traces?service=${encodeURIComponent(
          service,
        )}&limit=${config.maxTracesPerService}&lookback=${lookback}`;
        logger.info(`Fetching traces from Jaeger: ${jaegerUrl}`);
        const response = await fetchWithTimeout(jaegerUrl);
        if (!response.ok) {
          throw new Error(
            `Jaeger API returned ${response.status}: ${response.statusText}`,
          );
        }
        const data = await response.json();
        allTraces = Array.isArray(data) ? data : data.data || [];
      }

      logger.info(`Fetched ${allTraces.length} unique traces from Jaeger`);

      const analyzed = analyzeFunctionCalls(allTraces);
      logger.info(
        `[Backend Step 2] Trace Parser found ${
          analyzed.length
        } unique functions. Preview: ${JSON.stringify(analyzed).substring(
          0,
          300,
        )}`,
      );

      const decisions = applyDecisionLogic(analyzed, config);
      logger.info(
        `[Backend Step 3] Final Relocation Decisions generated: ${JSON.stringify(
          decisions,
        ).substring(0, 300)}`,
      );

      return res.json(decisions);
    } catch (error) {
      logger.error(`Error analyzing function calls: ${error}`);
      return res.status(500).json({
        error: 'Failed to analyze function calls',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /microservice/detect - Detect services in repository
  router.post('/microservice/detect', async (req, res) => {
    const { repoUrl } = req.body;

    try {
      logger.info(`Detecting services in repository: ${repoUrl}`);

      const repoName = extractRepoName(repoUrl);
      const tmpDir = config.repoPath(repoName);

      await fs.ensureDir(path.dirname(tmpDir));
      if (await fs.pathExists(tmpDir)) {
        logger.info(
          `Repository already exists at ${tmpDir}, using existing copy`,
        );
      } else {
        const git = simpleGit();
        logger.info(`Cloning repository to ${tmpDir}`);
        await git.clone(repoUrl, tmpDir);
      }

      await fixDockerfiles(tmpDir, logger);

      const services = await detectServices(tmpDir, config);

      return res.json({ repoName, services, tmpDir });
    } catch (error) {
      logger.error(`Service detection failed: ${error}`);
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /microservice/generate - Generate configuration files
  router.post('/microservice/generate', async (req, res) => {
    const { repoName, repoUrl, services, step } = req.body;

    try {
      logger.info(`Generating ${step} for ${repoName}`);

      const tmpDir = config.repoPath(repoName);
      let content = '';
      let message = '';

      switch (step) {
        case 'docker-compose': {
          content = generateDockerCompose(services);
          await fs.writeFile(
            path.join(tmpDir, 'docker-compose.otel.yml'),
            content,
          );
          message = 'Docker Compose file created with Jaeger and OpenTelemetry';
          break;
        }

        case 'catalog-info': {
          content = buildCatalogInfo(repoName, repoUrl, services, config);
          await fs.writeFile(path.join(tmpDir, 'catalog-info.yaml'), content);

          const configPath = path.join(
            process.cwd(),
            '..',
            '..',
            'app-config.yaml',
          );
          if (await fs.pathExists(configPath)) {
            let appConfig = await fs.readFile(configPath, 'utf-8');
            const relPath = path
              .relative(path.join(process.cwd(), '..', '..'), tmpDir)
              .replace(/\\/g, '/');
            const catalogEntry = `    - type: file\n      target: ../../${relPath}/catalog-info.yaml\n      rules:\n        - allow: [System, Component, API, Resource]`;

            if (!appConfig.includes(`${relPath}`)) {
              appConfig = appConfig.replace(
                /(catalog:[\s\S]*?locations:[\s\S]*?)((?:\n\s{4}- type:|\nscaffolder:))/,
                `$1\n${catalogEntry}$2`,
              );
              await fs.writeFile(configPath, appConfig);
            }
          }
          message =
            'Backstage catalog file created and app-config.yaml updated';
          break;
        }

        case 'instrumentation': {
          for (const service of services) {
            if (service.language === 'go') {
              const tracingCode = generateGoTracing();
              await fs.writeFile(
                path.join(tmpDir, service.path, 'tracing.go'),
                tracingCode,
              );
            }
          }
          message = 'Instrumentation code generated';
          break;
        }

        case 'scripts': {
          const psScript = generatePowerShellScript(repoName, services);
          const bashScript = generateBashScript(repoName, services);
          await fs.writeFile(path.join(tmpDir, 'start-services.ps1'), psScript);
          await fs.writeFile(
            path.join(tmpDir, 'start-services.sh'),
            bashScript,
          );
          await fs.chmod(path.join(tmpDir, 'start-services.sh'), 0o755);
          message = 'Startup scripts created';
          break;
        }

        default: {
          message = `Unknown generation step: ${step}`;
          content = '';
          break;
        }
      }

      return res.json({ success: true, message, content });
    } catch (error) {
      logger.error(`Configuration generation failed: ${error}`);
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /microservice/deploy - Deploy services via Docker Compose
  router.post('/microservice/deploy', async (req, res) => {
    const { repoName, services } = req.body;

    try {
      logger.info(`Deploying services for ${repoName}`);

      const microservicesDir = config.repoPath(repoName);

      await fixDockerfiles(microservicesDir, logger);

      logger.info('Attempting to deploy all services...');
      const dockerCompose = spawn(
        'docker compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'up',
          '-d',
          '--build',
          '--remove-orphans',
          '--no-log-prefix',
        ],
        { cwd: microservicesDir, shell: true, timeout: 300000 },
      );

      let output = '';
      let errorOutput = '';

      dockerCompose.stdout?.on('data', data => {
        const text = data.toString();
        output += text;
        logger.info(text);
      });

      dockerCompose.stderr?.on('data', data => {
        const text = data.toString();
        errorOutput += text;
        if (
          text.toLowerCase().includes('error') ||
          text.toLowerCase().includes('failed')
        ) {
          logger.error(text);
        } else {
          logger.info(text);
        }
      });

      await new Promise((resolve, reject) => {
        dockerCompose.on('close', code => {
          if (code === 0) {
            resolve(code);
          } else {
            const errorMsg = errorOutput || output;
            const match = errorMsg.match(/ERROR:(.+?)(?:\n|$)/i);
            const shortError = match
              ? match[1].trim()
              : `Docker Compose exited with code ${code}`;
            const serviceMatch = errorMsg.match(/\[([^\]]+)\s+\d+\/\d+\]/);
            const failedService = serviceMatch ? serviceMatch[1] : 'unknown';
            reject(
              new Error(
                `Service '${failedService}' failed to build: ${shortError}\n\nTip: Java services may need Maven wrapper fixes.\n\nFull output:\n${errorMsg.substring(
                  0,
                  1000,
                )}`,
              ),
            );
          }
        });
      });

      logger.info('Waiting for services to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      const psCommand = spawn(
        'docker compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'ps',
          '--services',
          '--filter',
          'status=running',
        ],
        { cwd: microservicesDir, shell: true },
      );

      let runningServices = '';
      psCommand.stdout?.on('data', data => {
        runningServices += data.toString();
      });
      await new Promise(resolve => {
        psCommand.on('close', () => resolve(null));
      });

      const serviceList = runningServices.split('\n').filter(s => s.trim());
      logger.info(`Running services: ${serviceList.join(', ')}`);

      return res.json({
        success: true,
        message: `${serviceList.length} service(s) deployed successfully`,
        services: services.map((s: any) => ({
          name: s.name,
          url: `http://localhost:${s.port}`,
          port: s.port,
          running: serviceList.includes(s.name),
        })),
        jaegerUrl: config.jaegerBaseUrl.replace('/api', ''),
      });
    } catch (error) {
      logger.error(`Deployment failed: ${error}`);
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /service/deploy-and-trace - Auto-deploy service and generate traces
  router.post('/service/deploy-and-trace', async (req, res) => {
    const { serviceName, jaegerServiceName, repoName, testEndpoints } =
      req.body;

    try {
      logger.info(
        `🚀 Auto-deploying service: ${serviceName} (Jaeger: ${
          jaegerServiceName || serviceName
        })`,
      );

      const microservicesDir = config.repoPath(repoName);

      if (!(await fs.pathExists(microservicesDir))) {
        return res.status(404).json({
          success: false,
          error: `Repository "${repoName}" not found. Please configure the microservice first.`,
        });
      }

      logger.info('🔧 Fixing Dockerfiles...');
      await fixDockerfiles(microservicesDir, logger);

      await createServerWrappers(microservicesDir, logger);
      const composeFilePath = path.join(
        microservicesDir,
        'docker-compose.otel.yml',
      );
      const composeFile = 'docker-compose.otel.yml';

      {
        const rootComposePath = path.join(
          microservicesDir,
          'docker-compose.yml',
        );
        if (await fs.pathExists(rootComposePath)) {
          // Prefer the repo's own docker-compose.yml — it has correct ports, volumes,
          // environment variables, and service dependencies already configured.
          // We inject Jaeger + OTEL on top of it.
          logger.info(
            '📝 Found root docker-compose.yml — injecting OTEL into existing compose...',
          );
          const composeContent = await fs.readFile(rootComposePath, 'utf-8');
          await fs.writeFile(
            composeFilePath,
            injectOtelIntoComposeContent(composeContent),
          );
          logger.info(
            '✅ docker-compose.otel.yml written from existing compose + OTEL',
          );
        } else {
          // No root compose — discover services and generate one from scratch
          logger.info(
            '📝 No root docker-compose.yml found — generating from service discovery...',
          );
          const services = await detectServices(microservicesDir, config);
          if (services.length === 0) {
            return res.status(404).json({
              success: false,
              error:
                'No services detected in repository. Check if the repository has valid microservices.',
            });
          }
          const dockerComposeContent = generateDockerCompose(services);
          await fs.writeFile(composeFilePath, dockerComposeContent);
          logger.info(
            `✅ Generated docker-compose.otel.yml with ${services.length} services + Jaeger`,
          );
        }
      }

      logger.info(`📦 Starting containers from ${composeFile}...`);

      const dockerDeploy = spawn(
        'docker compose',
        [
          '-f',
          composeFile,
          'up',
          '-d',
          '--build',
          '--remove-orphans',
          '--no-log-prefix',
        ],
        { cwd: microservicesDir, shell: true, timeout: 300000 },
      );

      let deployOutput = '';
      let deployError = '';

      dockerDeploy.stdout?.on('data', data => {
        deployOutput += data.toString();
        logger.info(data.toString());
      });
      dockerDeploy.stderr?.on('data', data => {
        deployError += data.toString();
      });

      await new Promise((resolve, reject) => {
        dockerDeploy.on('close', code => {
          if (code === 0) resolve(code);
          else
            reject(
              new Error(`Deployment failed with code ${code}\n${deployError}`),
            );
        });
      });

      logger.info('⏳ Waiting 5 seconds for containers to start...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      const psCommand = spawn(
        'docker compose',
        ['-f', composeFile, 'ps', '--services', '--filter', 'status=running'],
        { cwd: microservicesDir, shell: true },
      );

      let runningServices = '';
      psCommand.stdout?.on('data', data => {
        runningServices += data.toString();
      });
      await new Promise(resolve => {
        psCommand.on('close', () => resolve(null));
      });

      const serviceList = runningServices.split('\n').filter(s => s.trim());
      logger.info(`✅ Running services: ${serviceList.join(', ')}`);

      const jaegerRunning = serviceList.includes('jaeger');
      if (!jaegerRunning) {
        logger.warn('⚠️ Jaeger container not found in running services!');
      } else {
        logger.info(
          `✅ Jaeger is running on ${config.jaegerBaseUrl.replace('/api', '')}`,
        );
      }

      const composeContent = await fs.readFile(
        path.join(microservicesDir, composeFile),
        'utf-8',
      );
      const composeData = yaml.parse(composeContent);

      let servicePort = 5000;
      let serviceConfig = composeData.services?.[serviceName];
      let actualServiceName = serviceName;

      if (!serviceConfig) {
        for (const [name, cfg] of Object.entries(composeData.services || {})) {
          if (name.includes('jaeger') || (cfg as any).image?.includes('jaeger'))
            continue;
          const containerName = (cfg as any).container_name || '';
          if (
            serviceName.includes(name) ||
            name.includes(serviceName.replace('lightweight-', '')) ||
            containerName.includes(serviceName.replace('lightweight-', ''))
          ) {
            serviceConfig = cfg;
            actualServiceName = name;
            logger.info(
              `Fuzzy matched service '${serviceName}' to compose service '${name}'.`,
            );
            break;
          }
        }
      }

      if (!serviceConfig) {
        for (const [name, cfg] of Object.entries(composeData.services || {})) {
          if (name.includes('jaeger') || (cfg as any).image?.includes('jaeger'))
            continue;
          if ((cfg as any).ports) {
            serviceConfig = cfg;
            actualServiceName = name;
            logger.info(
              `Service '${serviceName}' not found. Using fallback service '${name}'.`,
            );
            break;
          }
        }
      }

      if (serviceConfig?.ports) {
        const portMapping = Array.isArray(serviceConfig.ports)
          ? serviceConfig.ports[0]
          : serviceConfig.ports;
        const portMatch = String(portMapping).match(/^(\d+):|:(\d+)$/);
        if (portMatch) servicePort = parseInt(portMatch[1] || portMatch[2], 10);
      }

      logger.info(
        `🔄 Generating traces for ${serviceName} on port ${servicePort}...`,
      );

      const serviceUrl = `http://localhost:${servicePort}`;
      const endpoints: string[] =
        Array.isArray(testEndpoints) && testEndpoints.length > 0
          ? testEndpoints
          : ['/', '/health'];

      if (!testEndpoints || testEndpoints.length === 0) {
        try {
          const files = await fs.readdir(
            path.join(microservicesDir, actualServiceName),
          );
          for (const file of files) {
            if (file.endsWith('.js') || file.endsWith('.ts')) {
              const fileContent = await fs.readFile(
                path.join(microservicesDir, actualServiceName, file),
                'utf8',
              );
              const routeRegex =
                /app\.(get|post|put|delete|patch)\(['"`]([\/\w\-\{\}\?\=]+)['"`]/g;
              let match;
              // eslint-disable-next-line no-cond-assign
              while ((match = routeRegex.exec(fileContent)) !== null) {
                let endpoint = match[2];
                endpoint = endpoint.split('?')[0].replace(/:\w+/g, '123');
                if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
              }
            }
          }
        } catch (e) {
          logger.warn(
            `Could not automatically discover routes for ${actualServiceName}: ${e}`,
          );
        }
      }

      logger.info(
        `Discovered endpoints to trace for ${actualServiceName}: ${endpoints.join(
          ', ',
        )}`,
      );

      // Wait for the service to be reachable (npm install + OTEL setup can take 60-180s)
      {
        const readinessMaxMs = 180000;
        const readinessPollMs = 5000;
        const readinessStart = Date.now();
        let serviceReady = false;
        logger.info(
          `⏳ Waiting for ${serviceName} to become ready on port ${servicePort} (up to ${
            readinessMaxMs / 1000
          }s)...`,
        );
        while (Date.now() - readinessStart < readinessMaxMs) {
          try {
            const probe = await fetch(`${serviceUrl}/`, { method: 'GET' });
            if (probe.status < 500) {
              serviceReady = true;
              logger.info(`✅ ${serviceName} is ready (HTTP ${probe.status})`);
              break;
            }
          } catch {
            // not ready yet — keep waiting
          }
          const elapsed = Math.round((Date.now() - readinessStart) / 1000);
          logger.info(
            `⏳ ${serviceName} not ready yet (${elapsed}s elapsed), retrying...`,
          );
          await new Promise(resolve => setTimeout(resolve, readinessPollMs));
        }
        if (!serviceReady) {
          logger.warn(
            `⚠️ ${serviceName} did not respond within ${
              readinessMaxMs / 1000
            }s — generating traces anyway`,
          );
        }
      }

      let successCount = 0;
      for (let i = 0; i < 20; i++) {
        const endpoint = endpoints[i % endpoints.length];
        try {
          const response = await fetch(`${serviceUrl}${endpoint}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          successCount++;
          logger.info(`Request ${i + 1}/20: ${response.status} ${endpoint}`);
        } catch (err) {
          logger.warn(`Request ${i + 1}/20 failed: ${err}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      logger.info(`✅ Generated ${successCount}/20 requests to ${serviceName}`);
      logger.info('⏳ Waiting for traces to propagate to Jaeger...');
      await new Promise(resolve => setTimeout(resolve, 8000));

      let targetServiceName = jaegerServiceName || actualServiceName;
      if (serviceConfig?.environment) {
        const otelEnv = serviceConfig.environment.find(
          (e: string) =>
            typeof e === 'string' && e.startsWith('OTEL_SERVICE_NAME='),
        );
        if (otelEnv) targetServiceName = otelEnv.split('=')[1];
      }

      const jaegerTracesUrl = `${
        config.jaegerBaseUrl
      }/traces?service=${encodeURIComponent(
        targetServiceName,
      )}&lookback=5m&limit=100`;
      let tracesFound = 0;
      try {
        const jaegerResponse = await fetch(jaegerTracesUrl);
        const jaegerData = await jaegerResponse.json();
        tracesFound = jaegerData.data?.length || 0;
        logger.info(
          `📊 Found ${tracesFound} traces in Jaeger for ${targetServiceName}`,
        );
      } catch (err) {
        logger.warn(`Failed to fetch traces from Jaeger: ${err}`);
      }

      return res.json({
        success: true,
        message: `Service deployed and ${tracesFound} traces generated`,
        serviceName,
        jaegerServiceName: targetServiceName,
        deployed: true,
        jaegerRunning: serviceList.includes('jaeger'),
        tracesGenerated: successCount,
        tracesInJaeger: tracesFound,
        serviceUrl,
        servicePort,
        runningServices: serviceList,
        jaegerUrl: config.jaegerBaseUrl.replace('/api', ''),
      });
    } catch (error) {
      logger.error(`Failed to deploy and trace: ${error}`);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /service/start-jaeger - Start Jaeger container for a given repo
  router.post('/service/start-jaeger', async (req, res) => {
    const { repoName } = req.body || {};

    try {
      const repo = repoName || '';
      logger.info(`📊 Starting Jaeger for repo: ${repo || 'default'}`);

      let microservicesDir = '';
      if (repo) {
        microservicesDir = config.repoPath(repo);
        if (!(await fs.pathExists(microservicesDir))) {
          logger.warn(`⚠️ Repo directory not found: ${microservicesDir}`);
          return res.status(404).json({
            success: false,
            error: `Repository "${repo}" not found at ${microservicesDir}`,
          });
        }
      } else {
        const microservicesBase = config.workspaceRoot;
        if (await fs.pathExists(microservicesBase)) {
          const dirs = await fs.readdir(microservicesBase);
          for (const dir of dirs) {
            const composePath = path.join(
              microservicesBase,
              dir,
              'docker-compose.otel.yml',
            );
            if (await fs.pathExists(composePath)) {
              microservicesDir = path.join(microservicesBase, dir);
              logger.info(`📂 Found docker-compose in: ${microservicesDir}`);
              break;
            }
          }
        }
      }

      if (!microservicesDir) {
        logger.error(
          '❌ docker-compose.otel.yml not found in any microservices directory',
        );
        return res.status(404).json({
          success: false,
          error:
            'docker-compose.otel.yml not found - please run configuration first',
        });
      }

      const composeFile = 'docker-compose.otel.yml';
      const composePath = path.join(microservicesDir, composeFile);
      if (!(await fs.pathExists(composePath))) {
        return res.status(404).json({
          success: false,
          error: `${composeFile} not found - please generate configuration files first`,
        });
      }

      logger.info(
        `🚀 Starting Jaeger via docker-compose in ${microservicesDir}`,
      );

      const dockerUp = spawn(
        'docker compose',
        ['-f', composeFile, 'up', '-d', 'jaeger'],
        { cwd: microservicesDir, shell: true, timeout: 120000 },
      );

      let out = '';
      let err = '';
      dockerUp.stdout?.on('data', d => {
        out += d.toString();
        logger.info(`[docker-compose stdout] ${d.toString()}`);
      });
      dockerUp.stderr?.on('data', d => {
        err += d.toString();
        logger.warn(`[docker-compose stderr] ${d.toString()}`);
      });

      await new Promise((resolve, reject) => {
        dockerUp.on('close', code => {
          if (code === 0) {
            logger.info('✅ docker-compose command completed successfully');
            resolve(null);
          } else {
            logger.error(`❌ docker-compose exit code: ${code}`);
            reject(new Error(`docker-compose exit ${code}: ${err}`));
          }
        });
      });

      logger.info('⏳ Waiting for Jaeger to initialize (15 seconds)...');
      await new Promise(r => setTimeout(r, 15000));

      const jaegerHealthUrl = `${config.jaegerBaseUrl}/services`;
      logger.info(`🔍 Checking Jaeger health at ${jaegerHealthUrl}`);
      let jaegerHealthy = false;
      let healthCheckAttempts = 0;
      const maxAttempts = 5;

      while (healthCheckAttempts < maxAttempts && !jaegerHealthy) {
        try {
          const healthResponse = await fetch(jaegerHealthUrl, {
            timeout: 5000,
          } as any);
          if (healthResponse.ok) {
            logger.info('✅ Jaeger is healthy and responding');
            jaegerHealthy = true;
            break;
          }
        } catch (healthErr) {
          healthCheckAttempts++;
          logger.warn(
            `⚠️ Health check attempt ${healthCheckAttempts}/${maxAttempts} failed: ${healthErr}`,
          );
          if (healthCheckAttempts < maxAttempts)
            await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (!jaegerHealthy) {
        logger.warn(
          '⚠️ Jaeger health check failed, but continuing (may be initializing)',
        );
      }

      logger.info('✅ Jaeger startup process completed');
      return res.json({
        success: true,
        jaegerRunning: jaegerHealthy,
        message: jaegerHealthy
          ? 'Jaeger started and healthy'
          : 'Jaeger started (still initializing)',
      });
    } catch (e) {
      logger.error(`❌ Failed to start Jaeger: ${e}`);
      return res.status(500).json({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // POST /service/deploy-all-and-trace - Auto-detect all services in repo and deploy+trace
  router.post('/service/deploy-all-and-trace', async (req, res) => {
    const { repoName, gitHubUrl } = req.body || {};

    if (!repoName) {
      return res
        .status(400)
        .json({ success: false, error: 'repoName is required' });
    }

    try {
      const microservicesDir = config.repoPath(repoName);

      if (!(await fs.pathExists(microservicesDir))) {
        if (!gitHubUrl) {
          return res.status(404).json({
            success: false,
            error: `Repository "${repoName}" not found. Please provide gitHubUrl for auto-cloning.`,
          });
        }

        logger.info(
          `📥 Auto-cloning repository from ${gitHubUrl} to ${microservicesDir}`,
        );
        await fs.ensureDir(path.dirname(microservicesDir));

        try {
          const git = simpleGit();
          await git.clone(gitHubUrl, microservicesDir);
          logger.info(
            `✅ Repository cloned successfully to ${microservicesDir}`,
          );
        } catch (cloneErr) {
          return res.status(500).json({
            success: false,
            error: `Failed to clone repository: ${
              cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
            }`,
          });
        }
      }

      logger.info(`🚀 Deploying all services from repo: ${repoName}`);

      const services = await detectServices(microservicesDir, config);
      let usingRootCompose = false;

      if (services.length === 0) {
        const rootComposePath = path.join(
          microservicesDir,
          'docker-compose.yml',
        );
        if (await fs.pathExists(rootComposePath)) {
          logger.info('📝 Root docker-compose.yml found for full deployment!');
          usingRootCompose = true;
        } else {
          return res
            .status(400)
            .json({
              success: false,
              error: 'No services detected in repository',
            });
        }
      } else {
        logger.info(
          `✅ Detected ${services.length} services: ${services
            .map(s => s.name)
            .join(', ')}`,
        );
      }

      logger.info('🔧 Fixing Dockerfiles...');
      await fixDockerfiles(microservicesDir, logger);

      const composeFilePath = path.join(
        microservicesDir,
        'docker-compose.otel.yml',
      );
      logger.info('📝 Generating docker-compose.otel.yml...');
      if (usingRootCompose) {
        const rootContent = await fs.readFile(
          path.join(microservicesDir, 'docker-compose.yml'),
          'utf-8',
        );
        await fs.writeFile(
          composeFilePath,
          rootContent.replace(
            /OTEL_EXPORTER_OTLP_ENDPOINT/g,
            'OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process\n      - OTEL_EXPORTER_OTLP_ENDPOINT',
          ),
        );
      } else {
        await fs.writeFile(composeFilePath, generateDockerCompose(services));
      }

      logger.info('📦 Starting all containers...');
      const dockerUp = spawn(
        'docker compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'up',
          '-d',
          '--remove-orphans',
          '--no-log-prefix',
        ],
        { cwd: microservicesDir, shell: true, timeout: 180000 },
      );

      let deployErr = '';
      dockerUp.stderr?.on('data', d => {
        deployErr += d.toString();
      });
      dockerUp.stdout?.on('data', d => {
        logger.info(d.toString());
      });

      await new Promise((resolve, reject) => {
        dockerUp.on('close', code => {
          if (code === 0) resolve(null);
          else reject(new Error(`docker-compose exit ${code}: ${deployErr}`));
        });
      });

      logger.info('⏳ Waiting for services to initialize...');
      await new Promise(r => setTimeout(r, 15000));

      const ps = spawn(
        'docker compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'ps',
          '--services',
          '--filter',
          'status=running',
        ],
        { cwd: microservicesDir, shell: true },
      );

      let psOut = '';
      ps.stdout?.on('data', d => {
        psOut += d.toString();
      });
      await new Promise(r => {
        ps.on('close', () => r(null));
      });

      const runningList = psOut.split('\n').filter(s => s.trim());
      logger.info(`✅ Running: ${runningList.join(', ')}`);

      return res.json({
        success: true,
        repoName,
        servicesDetected: services.length,
        servicesRunning: runningList.length,
        services: services.map(s => s.name),
        servicesToTrace: services
          .filter(s => s.name !== 'jaeger')
          .map(s => ({ serviceName: s.name, jaegerServiceName: s.name })),
        jaegerRunning: runningList.includes('jaeger'),
        message: `✅ Deployed ${runningList.length} containers`,
      });
    } catch (e) {
      logger.error(`Failed to deploy all services: ${e}`);
      return res.status(500).json({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // POST /service/start-and-trace - Start service and generate traces
  router.post('/service/start-and-trace', async (req, res) => {
    const { serviceName, repoName } = req.body;

    try {
      logger.info(`Starting service ${serviceName} and generating traces`);

      const microservicesDir = config.repoPath(repoName);

      const composeFile = (await fs.pathExists(
        path.join(microservicesDir, 'docker-compose.yml'),
      ))
        ? 'docker-compose.yml'
        : 'docker-compose.otel.yml';

      if (!(await fs.pathExists(path.join(microservicesDir, composeFile)))) {
        throw new Error(`No docker-compose file found in ${microservicesDir}`);
      }

      logger.info('Starting services with docker-compose...');
      const dockerUp = spawn(
        'docker compose',
        ['-f', composeFile, 'up', '-d'],
        {
          cwd: microservicesDir,
          shell: true,
        },
      );

      let upOutput = '';
      dockerUp.stdout?.on('data', data => {
        upOutput += data.toString();
        logger.info(data.toString());
      });
      dockerUp.stderr?.on('data', data => {
        upOutput += data.toString();
      });

      await new Promise((resolve, reject) => {
        dockerUp.on('close', code => {
          if (code === 0) resolve(code);
          else
            reject(
              new Error(
                `Docker Compose up failed with code ${code}\n${upOutput}`,
              ),
            );
        });
      });

      logger.info('Waiting for services to initialize...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      const dockerPs = spawn(
        'docker compose',
        ['-f', composeFile, 'ps', '--format', 'json'],
        {
          cwd: microservicesDir,
          shell: true,
        },
      );

      let psOutput = '';
      dockerPs.stdout?.on('data', data => {
        psOutput += data.toString();
      });
      await new Promise(resolve => {
        dockerPs.on('close', () => resolve(null));
      });

      const runningServices = psOutput
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      logger.info(`Found ${runningServices.length} running services`);

      logger.info(`Generating traces for ${serviceName}...`);
      const traceCount = 20;
      const traces = [];

      const serviceInfo = runningServices.find(
        (s: any) =>
          s.Service?.toLowerCase().includes(serviceName.toLowerCase()) ||
          s.Name?.toLowerCase().includes(serviceName.toLowerCase()),
      );

      if (serviceInfo?.Publishers) {
        const portMatch = serviceInfo.Publishers[0]?.URL?.match(/:(\d+)$/);
        const port = portMatch ? portMatch[1] : '5000';

        logger.info(
          `Making ${traceCount} requests to http://localhost:${port}/api/quote`,
        );

        for (let i = 0; i < traceCount; i++) {
          try {
            const response = await fetch(`http://localhost:${port}/api/quote`);
            const data = await response.json();
            traces.push({
              request: i + 1,
              status: response.status,
              quote: (data as any).quote?.substring(0, 50),
            });
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (err) {
            logger.warn(`Request ${i + 1} failed: ${err}`);
          }
        }
      } else {
        logger.warn(
          `Could not find port for ${serviceName}, skipping trace generation`,
        );
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      logger.info(`Fetching traces from Jaeger for ${serviceName}...`);
      const jaegerTracesUrl = `${config.jaegerBaseUrl}/traces?service=${serviceName}&lookback=5m&limit=100`;
      const jaegerResponse = await fetch(jaegerTracesUrl);
      const jaegerData = await jaegerResponse.json();
      const traceList = (jaegerData as any).data || [];

      logger.info(
        `✅ Service started and ${traceList.length} traces generated`,
      );

      if (traceList.length > 0) {
        console.log(`\n📊 === TRACES FOR ${serviceName.toUpperCase()} ===`);
        traceList.slice(0, 10).forEach((trace: any, idx: number) => {
          console.log(`\n[Trace ${idx + 1}] ID: ${trace.traceID}`);
          console.log(
            `  Duration: ${trace.duration}µs | Spans: ${
              trace.spans?.length || 0
            }`,
          );
          trace.spans?.forEach((span: any) => {
            console.log(
              `    └─ [${span.operationName}] (${span.duration}µs) | Service: ${span.processID}`,
            );
            if (span.tags?.length) {
              span.tags.slice(0, 5).forEach((tag: any) => {
                if (tag.value && typeof tag.value === 'object') {
                  console.log(
                    `       • ${tag.key}: ${JSON.stringify(tag.value).substring(
                      0,
                      60,
                    )}`,
                  );
                } else {
                  console.log(`       • ${tag.key}: ${tag.value}`);
                }
              });
            }
          });
        });
        console.log('\n==============================\n');
      }

      return res.json({
        success: true,
        message: `Service ${serviceName} started and ${traceList.length} traces generated`,
        serviceName,
        tracesGenerated: traces.length,
        tracesInJaeger: traceList.length,
        traces: traceList.slice(0, 10).map((t: any) => ({
          traceID: t.traceID,
          spans: t.spans?.length || 0,
          duration: t.spans?.[0]?.duration || 0,
        })),
        runningServices: runningServices.map((s: any) => ({
          name: s.Service || s.Name,
          status: s.State,
        })),
      });
    } catch (error) {
      logger.error(`Failed to start service and generate traces: ${error}`);
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        success: false,
      });
    }
  });

  // GET /fra/config - Expose current FRA configuration to the frontend
  router.get('/fra/config', (_req, res) => {
    res.json({
      tracing: {
        backends: config.tracingBackends,
        defaultLookbackHours: config.defaultLookbackHours,
        maxTracesPerService: config.maxTracesPerService,
      },
      discovery: {
        minConfidenceThreshold: config.minConfidenceThreshold,
        maxScanDepth: config.maxScanDepth,
      },
      analysis: {
        externalCallThreshold: config.externalCallThreshold,
        confidenceMargin: config.confidenceMargin,
      },
      catalog: {
        defaultOwner: config.catalogDefaultOwner,
        defaultLifecycle: config.catalogDefaultLifecycle,
      },
    });
  });

  return router;
}

// Keep deprecated helpers for any external callers (thin re-exports to modules)
export { extractRepoName } from '../modules/ingestion/RepositoryIngestor';
export { ingestRepository } from '../modules/ingestion/RepositoryIngestor';
