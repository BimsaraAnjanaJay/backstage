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
  JAVA_AGENT_DOWNLOAD,
  OTEL_AGENT_HOST_PATH,
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

// File patterns for standalone traffic generator scripts that can be run on the host.
// These are checked ONLY when no Docker-native traffic generator service is found in compose.
const NATIVE_TRAFFIC_SCRIPTS: Array<{
  file: string;
  runner: string;
  args?: string[];
}> = [
    { file: 'traffic-generator.js', runner: 'node' },
    { file: 'traffic_generator.js', runner: 'node' },
    { file: 'generate-traffic.js', runner: 'node' },
    { file: 'load-test.js', runner: 'node' },
    { file: 'traffic-generator.py', runner: 'python3' },
    { file: 'traffic_generator.py', runner: 'python3' },
    { file: 'generate_traffic.py', runner: 'python3' },
    { file: 'traffic-generator.sh', runner: 'sh' },
    { file: 'generate-traffic.sh', runner: 'sh' },
  ];

// Names/patterns that identify a traffic-generator Docker service in compose files.
// Used to decide whether to invoke it via `docker compose up` (inside Docker)
// rather than running the script directly on the host.
const DOCKER_TRAFFIC_SERVICE_PATTERNS = [
  'traffic-generator',
  'traffic_generator',
  'trafficgenerator',
  'load-generator',
  'load_generator',
  'loadgenerator',
  'load-test',
];

/**
 * Tries to run a repo's traffic generator. Strategy (in priority order):
 *
 * 1. **Docker-native**: If the compose file defines a service whose name matches
 *    a traffic-generator pattern, run it via `docker compose up` so it runs
 *    inside the Docker network where cross-service DNS works correctly.
 *
 * 2. **Host-native script**: If a known traffic generator script file exists but
 *    is NOT already handled by Docker (e.g. lightweight-otel-demo), run it on
 *    the host with localhost URLs injected via environment variables.
 *
 * 3. **Fallback probing**: Probe each service URL with HTTP GET requests.
 *
 * @param repoDir     - absolute path to the cloned repository root
 * @param serviceUrls - host-accessible URLs (used for fallback probing & gateway detection)
 * @param logger      - Backstage logger
 * @param composeFile - compose file name inside repoDir
 */
async function generateTrafficForRepo(
  repoDir: string,
  serviceUrls: string[],
  logger: LoggerService,
  composeFile = 'docker-compose.otel.yml',
): Promise<number> {
  const composePath = path.join(repoDir, composeFile);

  // ── 1. Docker-native traffic generator ──────────────────────────────────
  // When the repo's compose file already defines a traffic-generator service,
  // run it inside Docker so it can resolve cross-service hostnames.
  if (await fs.pathExists(composePath)) {
    try {
      const composeData = yaml.parse(await fs.readFile(composePath, 'utf-8'));
      const trafficServiceName = Object.keys(composeData.services || {}).find(
        name =>
          DOCKER_TRAFFIC_SERVICE_PATTERNS.some(p =>
            name.toLowerCase().replace(/-/g, '').includes(p.replace(/-/g, '')),
          ),
      );

      if (trafficServiceName) {
        logger.info(
          `🐳 Found Docker-native traffic generator service: '${trafficServiceName}' — starting via docker compose`,
        );

        // Stop any previous run of the traffic generator to avoid duplicate workers
        await new Promise<void>(resolve => {
          const stop = spawn(
            'docker compose',
            ['-f', composeFile, 'rm', '-sf', trafficServiceName],
            { cwd: repoDir, shell: true },
          );
          stop.on('close', () => resolve());
        });

        await new Promise<void>((resolve, reject) => {
          const up = spawn(
            'docker compose',
            ['-f', composeFile, 'up', '-d', trafficServiceName],
            { cwd: repoDir, shell: true, timeout: 60000 },
          );
          up.stderr?.on('data', (d: Buffer) => logger.info(`[docker-traffic] ${d.toString().trim()}`));
          up.stdout?.on('data', (d: Buffer) => logger.info(`[docker-traffic] ${d.toString().trim()}`));
          up.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`docker compose up ${trafficServiceName} exited ${code}`));
          });
          up.on('error', reject);
        });

        // Give the traffic generator time to exercise the services
        const trafficDurationMs = 60000;
        logger.info(`⏳ Letting Docker traffic generator run for ${trafficDurationMs / 1000}s...`);
        await new Promise(r => setTimeout(r, trafficDurationMs));

        // Count approximate successful requests from container logs
        let logOutput = '';
        await new Promise<void>(resolve => {
          const logs = spawn(
            'docker compose',
            ['-f', composeFile, 'logs', '--no-log-prefix', '--tail=500', trafficServiceName],
            { cwd: repoDir, shell: true },
          );
          logs.stdout?.on('data', (d: Buffer) => {
            const line = d.toString();
            logOutput += line;
            if (line.trim()) logger.info(`[traffic] ${line.trim()}`);
          });
          logs.on('close', () => resolve());
        });

        const successCount = (logOutput.match(/status=20[01]|created|succeeded|201|\bcreated\b/gi) || []).length;
        logger.info(`✅ Docker traffic generator: ~${successCount} successful requests logged`);
        return Math.max(successCount, 1); // return at least 1 so callers know traffic ran
      }
    } catch (e) {
      logger.warn(`⚠️ Could not check compose for traffic service: ${e}`);
    }
  }

  // ── 2. Host-side native script (NOT in compose) ──────────────────────────
  // For repos like lightweight-otel-demo that ship a standalone traffic-generator.js
  // not defined as a Docker service — run it on the host with localhost URLs.
  for (const candidate of NATIVE_TRAFFIC_SCRIPTS) {
    const scriptPath = path.join(repoDir, candidate.file);
    if (await fs.pathExists(scriptPath)) {
      logger.info(
        `🚦 Found host-side traffic generator: ${candidate.file} — running via ${candidate.runner}`,
      );

      // Ensure npm dependencies are installed
      if (candidate.runner === 'node') {
        const pkgJson = path.join(repoDir, 'package.json');
        const nodeModules = path.join(repoDir, 'node_modules');
        if ((await fs.pathExists(pkgJson)) && !(await fs.pathExists(nodeModules))) {
          logger.info('📦 Running npm install before traffic generator...');
          await new Promise<void>(resolve => {
            const npm = spawn('npm', ['install', '--prefer-offline'], { cwd: repoDir, shell: true });
            npm.on('close', () => resolve());
          });
        }
      }

      // Resolve gateway URL from compose host-port mappings
      let gatewayUrl = serviceUrls[0] || 'http://localhost:8080';
      try {
        if (await fs.pathExists(composePath)) {
          const composeData = yaml.parse(await fs.readFile(composePath, 'utf-8'));
          for (const [svcName, svcRaw] of Object.entries(composeData.services || {})) {
            const s = svcRaw as any;
            if (s.image?.includes('jaeger')) continue;
            if (Array.isArray(s.ports) && s.ports.length > 0) {
              const hostPort = String(s.ports[0]).split(':')[0];
              if (
                svcName.toLowerCase().includes('gateway') ||
                (s.container_name || '').toLowerCase().includes('gateway') ||
                (s.image || '').toLowerCase().includes('gateway')
              ) {
                gatewayUrl = `http://localhost:${hostPort}`;
                break;
              }
              gatewayUrl = `http://localhost:${hostPort}`;
            }
          }
        }
      } catch {
        // keep default
      }

      logger.info(`🌐 Using GATEWAY_URL=${gatewayUrl} for host-side traffic generator`);

      let resolved = 0;
      await new Promise<void>(resolve => {
        const proc = spawn(
          candidate.runner,
          [...(candidate.args || []), candidate.file],
          {
            cwd: repoDir,
            shell: true,
            env: { ...process.env, GATEWAY_URL: gatewayUrl },
            timeout: 120000,
          },
        );
        proc.stdout?.on('data', (d: Buffer) => {
          const line = d.toString().trim();
          if (line) logger.info(`[traffic] ${line}`);
          resolved += (line.match(/succeeded|200|201/gi) || []).length;
        });
        proc.stderr?.on('data', (d: Buffer) => {
          const line = d.toString().trim();
          if (line) logger.warn(`[traffic] ${line}`);
        });
        proc.on('close', code => {
          logger.info(`✅ Host traffic generator exited code=${code}, ~${resolved} requests`);
          resolve();
        });
        proc.on('error', err => {
          logger.warn(`⚠️ Traffic generator error: ${err}`);
          resolve();
        });
      });

      return resolved;
    }
  }

  // ── 3. Fallback: probe each service's endpoints ──────────────────────────
  logger.info(
    `🔁 No traffic generator found — probing ${serviceUrls.length} service(s) directly`,
  );

  const REQUESTS_PER_SERVICE = Math.max(50, Math.ceil(250 / Math.max(serviceUrls.length, 1)));
  let totalSuccess = 0;

  for (const serviceUrl of serviceUrls) {
    const endpoints: Array<{ path: string; method: string }> = [
      { path: '/', method: 'GET' },
      { path: '/health', method: 'GET' },
    ];

    // Quick readiness wait (up to 30 s)
    let ready = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const probe = await fetch(`${serviceUrl}/`, { method: 'GET' });
        if (probe.status < 500) { ready = true; break; }
      } catch {
        // not ready yet
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!ready) {
      logger.warn(`⚠️ Service at ${serviceUrl} did not respond — skipping`);
      continue;
    }

    let success = 0;
    for (let i = 0; i < REQUESTS_PER_SERVICE; i++) {
      const ep = endpoints[i % endpoints.length];
      try {
        const resp = await fetch(`${serviceUrl}${ep.path}`, {
          method: ep.method,
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.status < 500) success++;
      } catch {
        // ignore
      }
      await new Promise(r => setTimeout(r, 50));
    }
    logger.info(`✅ ${serviceUrl}: ${success}/${REQUESTS_PER_SERVICE} requests succeeded`);
    totalSuccess += success;
  }

  return totalSuccess;
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
          `Fetching traces for ${targetServices.length
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
              `[Backend Step 1] Jaeger returned ${d.data?.length || 0
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
        `[Backend Step 2] Trace Parser found ${analyzed.length
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
          const rootComposePath = path.join(tmpDir, 'docker-compose.yml');
          if (await fs.pathExists(rootComposePath)) {
            const composeContent = await fs.readFile(rootComposePath, 'utf-8');
            content = injectOtelIntoComposeContent(composeContent);
          } else {
            content = generateDockerCompose(services);
          }
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
            // We moved the real app-config.yaml update to the deploy endpoint
            // to prevent the dev server from restarting in the middle of the wizard!
          }
          message = 'Backstage catalog file created';
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

      // After successfully deploying, update app-config.yaml to include the catalog-info
      // We do this here instead of during generation so the UI has time to redirect to Trace Viewer before the auto-restart!
      try {
        const configPath = path.join(process.cwd(), '..', '..', 'app-config.yaml');
        if (await fs.pathExists(configPath)) {
          let appConfig = await fs.readFile(configPath, 'utf-8');
          const relPath = path.relative(path.join(process.cwd(), '..', '..'), microservicesDir).replace(/\\/g, '/');
          const catalogEntry = `    - type: file\n      target: ../../${relPath}/catalog-info.yaml\n      rules:\n        - allow: [System, Component, API, Resource]`;

          if (!appConfig.includes(`${relPath}`)) {
            appConfig = appConfig.replace(
              /(catalog:[\s\S]*?locations:[\s\S]*?)((?:\n\s{4}- type:|\nscaffolder:))/,
              `$1\n${catalogEntry}$2`,
            );
            // Write it in the background to give the HTTP response time to finish and the frontend to navigate
            setTimeout(() => {
              fs.writeFile(configPath, appConfig).catch(e => logger.error(`Failed to update app-config: ${e}`));
            }, 1000);
          }
        }
      } catch (e) {
        logger.warn(`Failed to process app-config.yaml update: ${e}`);
      }

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
        `🚀 Auto-deploying service: ${serviceName} (Jaeger: ${jaegerServiceName || serviceName
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

      // ── Pre-deploy cleanup: remove conflicting named containers ────────────
      // Docker refuses to start if a container with the same name already exists
      // from a previous deployment (possibly from a different compose project).
      // We forcefully remove any matching containers before bringing up new ones.
      try {
        const composeForCleanup = yaml.parse(
          await fs.readFile(composeFilePath, 'utf-8'),
        );
        const namedContainers: string[] = Object.values(
          composeForCleanup.services || {},
        )
          .map((s: any) => s.container_name)
          .filter(Boolean);

        if (namedContainers.length > 0) {
          logger.info(
            `🧹 Removing ${namedContainers.length} potentially conflicting containers...`,
          );
          await new Promise<void>(resolve => {
            // `docker rm -f` silently ignores containers that don't exist
            const rm = spawn(
              'docker',
              ['rm', '-f', ...namedContainers],
              { shell: true },
            );
            rm.stderr?.on('data', (d: Buffer) => {
              const line = d.toString().trim();
              // Only log real errors, not "no such container" noise
              if (line && !line.includes('No such container')) {
                logger.warn(`[cleanup] ${line}`);
              }
            });
            rm.on('close', () => resolve());
          });
          logger.info('🧹 Pre-deploy cleanup done');
        }
      } catch {
        // Non-fatal — proceed with deployment
      }

      // ── Ensure OTel Java agent is available on the host ─────────────────
      // The compose file bind-mounts OTEL_AGENT_HOST_PATH into each Java container.
      // Download it now if it doesn't already exist (cached for subsequent deploys).
      try {
        const agentDir = path.dirname(OTEL_AGENT_HOST_PATH);
        await fs.ensureDir(agentDir);
        if (!(await fs.pathExists(OTEL_AGENT_HOST_PATH))) {
          logger.info(
            `⬇️  Downloading OTel Java agent to ${OTEL_AGENT_HOST_PATH}...`,
          );
          await new Promise<void>((resolve, reject) => {
            const dl = spawn(
              'sh',
              [
                '-c',
                `wget -qO '${OTEL_AGENT_HOST_PATH}' '${JAVA_AGENT_DOWNLOAD}' 2>/dev/null || ` +
                `curl -sLo '${OTEL_AGENT_HOST_PATH}' '${JAVA_AGENT_DOWNLOAD}'`,
              ],
              { shell: false },
            );
            dl.on('close', code => {
              if (code === 0) {
                logger.info('✅ OTel Java agent downloaded successfully');
                resolve();
              } else {
                logger.warn(
                  '⚠️ OTel Java agent download failed — Java tracing may not work',
                );
                resolve(); // non-fatal
              }
            });
            dl.on('error', () => resolve()); // non-fatal
          });
        } else {
          logger.info(
            `✅ OTel Java agent already cached at ${OTEL_AGENT_HOST_PATH}`,
          );
        }
      } catch {
        logger.warn('⚠️ Could not ensure OTel agent — Java tracing may not work');
      }

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
      const endpoints: { path: string, method: string }[] =
        Array.isArray(testEndpoints) && testEndpoints.length > 0
          ? testEndpoints.map(e => ({ path: e, method: 'GET' }))
          : [{ path: '/', method: 'GET' }, { path: '/health', method: 'GET' }];

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
                /app\.(get|post|put|delete|patch)\(['"`]([\/\w\-\{\}\?\=\:]+)['"`]/g;
              let match;
              // eslint-disable-next-line no-cond-assign
              while ((match = routeRegex.exec(fileContent)) !== null) {
                const method = match[1].toUpperCase();
                let endpointPath = match[2];
                // basic replacement to ensure the endpoint does not throw 404
                endpointPath = endpointPath.split('?')[0].replace(/:\w+/g, '1');
                if (!endpoints.find(e => e.path === endpointPath && e.method === method)) {
                  endpoints.push({ path: endpointPath, method });
                }
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
        `Discovered endpoints to trace for ${actualServiceName}: ${endpoints.map(e => `${e.method} ${e.path}`).join(', ')}`,
      );

      // Wait for the service to be reachable (npm install + OTEL setup can take 60-180s)
      {
        const readinessMaxMs = 180000;
        const readinessPollMs = 5000;
        const readinessStart = Date.now();
        let serviceReady = false;
        logger.info(
          `⏳ Waiting for ${serviceName} to become ready on port ${servicePort} (up to ${readinessMaxMs / 1000
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
            `⚠️ ${serviceName} did not respond within ${readinessMaxMs / 1000
            }s — generating traces anyway`,
          );
        }
      }

      // Use the generalized traffic generator — tries native scripts first,
      // falls back to probing endpoints discovered above.
      const successCount = await generateTrafficForRepo(
        microservicesDir,
        [serviceUrl],
        logger,
        composeFile,
      );

      logger.info(`✅ Generated ${successCount} successful requests for ${serviceName}`);
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

      const jaegerTracesUrl = `${config.jaegerBaseUrl
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

    // Remove any lingering /jaeger container so docker compose can create it fresh
    await new Promise<void>(resolve => {
      const rm = spawn('docker', ['rm', '-f', 'jaeger'], { shell: true });
      rm.on('close', () => resolve());
    });

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
          error: `Failed to clone repository: ${cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
            }`,
        });
      }
    }

    logger.info(`🚀 Deploying all services from repo: ${repoName}`);

    const services = await detectServices(microservicesDir, config);
    const rootComposePath = path.join(microservicesDir, 'docker-compose.yml');
    const hasRootCompose = await fs.pathExists(rootComposePath);

    if (!hasRootCompose && services.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No services detected and no docker-compose.yml found in repository',
      });
    }

    if (services.length > 0) {
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
    if (hasRootCompose) {
      // Prefer root docker-compose.yml — it has correct ports, env vars, and inter-service URLs.
      // injectOtelIntoComposeContent adds Jaeger (if absent) and OTEL env vars without overriding
      // anything the repo already configured correctly.
      logger.info('📝 Using root docker-compose.yml with OTEL injection...');
      const rootContent = await fs.readFile(rootComposePath, 'utf-8');
      await fs.writeFile(composeFilePath, injectOtelIntoComposeContent(rootContent));
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
        '--build',
        '--remove-orphans',
        '--no-log-prefix',
      ],
      { cwd: microservicesDir, shell: true, timeout: 300000 },
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

    // ── Generate traffic for all deployed (non-jaeger) services ────────────
    // Read the compose file to get host ports for each service.
    const serviceUrls: string[] = [];
    try {
      const composeContent = await fs.readFile(
        path.join(microservicesDir, 'docker-compose.otel.yml'),
        'utf-8',
      );
      const composeData = yaml.parse(composeContent);
      for (const [svcName, svcRaw] of Object.entries(composeData.services || {})) {
        const svc = svcRaw as any;
        if (svcName === 'jaeger' || svc.image?.includes('jaeger')) continue;
        if (Array.isArray(svc.ports) && svc.ports.length > 0) {
          const hostPort = String(svc.ports[0]).split(':')[0];
          serviceUrls.push(`http://localhost:${hostPort}`);
        }
      }
    } catch (e) {
      logger.warn(`Could not parse compose file for service URLs: ${e}`);
    }

    logger.info(`🚦 Generating traffic for ${serviceUrls.length} service(s)...`);
    const totalTraffic = await generateTrafficForRepo(
      microservicesDir,
      serviceUrls,
      logger,
      'docker-compose.otel.yml',
    );
    logger.info(`✅ Traffic generation complete: ${totalTraffic} successful requests`);
    logger.info('⏳ Waiting for traces to propagate to Jaeger...');
    await new Promise(r => setTimeout(r, 8000));

    // Resolve jaegerServiceNames from OTEL_SERVICE_NAME env vars in compose
    const servicesToTrace: Array<{ serviceName: string; jaegerServiceName: string }> = [];
    try {
      const composeContent = await fs.readFile(
        path.join(microservicesDir, 'docker-compose.otel.yml'),
        'utf-8',
      );
      const composeData = yaml.parse(composeContent);
      for (const [svcName, svcRaw] of Object.entries(composeData.services || {})) {
        const svc = svcRaw as any;
        if (svcName === 'jaeger' || svc.image?.includes('jaeger')) continue;
        let jaegerName = svcName;
        const envList: string[] = Array.isArray(svc.environment) ? svc.environment : [];
        const otelEnv = envList.find(
          (e: string) => typeof e === 'string' && e.startsWith('OTEL_SERVICE_NAME='),
        );
        if (otelEnv) jaegerName = otelEnv.split('=').slice(1).join('=');
        servicesToTrace.push({ serviceName: svcName, jaegerServiceName: jaegerName });
      }
    } catch {
      // fallback to discovered services list
      services.filter(s => s.name !== 'jaeger').forEach(s =>
        servicesToTrace.push({ serviceName: s.name, jaegerServiceName: s.name }),
      );
    }

    return res.json({
      success: true,
      repoName,
      servicesDetected: services.length,
      servicesRunning: runningList.length,
      services: services.map(s => s.name),
      servicesToTrace,
      jaegerRunning: runningList.includes('jaeger'),
      tracesGenerated: totalTraffic,
      message: `✅ Deployed ${runningList.length} containers, generated ${totalTraffic} traffic requests`,
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
    const traceCount = 250;
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
          await new Promise(resolve => setTimeout(resolve, 50));
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
          `  Duration: ${trace.duration}µs | Spans: ${trace.spans?.length || 0
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
