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
import { simpleGit, SimpleGit } from 'simple-git';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as yaml from 'yaml';
import { spawn } from 'child_process';
import { preprocessTraces } from '../lib/preprocess';
import { analyzeFunctionCalls } from '../lib/analysis';
import { applyDecisionLogic } from '../lib/decision';

/**
 * Dependencies of the function-analytics router
 */
export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
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

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, response) => {
    logger.info('Function Analytics health check');
    response.json({ status: 'ok' });
  });

  router.get('/analyze', async (req, res) => {
    try {
      const service = (req.query.service as string) || 'all';
      logger.info(`Analyzing function calls for service: ${service}`);

      // Construct Jaeger API URL through Backstage proxy
      const jaegerUrl = `http://localhost:7007/api/proxy/jaeger/api/traces?service=${service}&limit=500`;

      logger.info(`Fetching traces from Jaeger: ${jaegerUrl}`);

      // Fetch traces from Jaeger
      const response = await fetch(jaegerUrl);

      if (!response.ok) {
        throw new Error(
          `Jaeger API returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();

      // Ensure data structure is correct
      const traces = Array.isArray(data) ? data : data.data || [];

      logger.info(`Fetched ${traces.length} traces from Jaeger`);

      // Step 1: Preprocess traces
      const cleaned = preprocessTraces(traces);
      logger.info(`Preprocessed ${cleaned.length} function calls`);

      // Step 2: Analyze function calls
      const analyzed = analyzeFunctionCalls(cleaned);
      logger.info(`Analyzed ${analyzed.length} unique functions`);

      // Step 3: Apply decision logic
      const decisions = applyDecisionLogic(analyzed);
      logger.info(`Generated ${decisions.length} relocation recommendations`);

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
      const tmpDir = path.join(
        process.cwd(),
        '..',
        '..',
        'microservices',
        repoName,
      );

      await fs.ensureDir(path.dirname(tmpDir));
      if (await fs.pathExists(tmpDir)) {
        logger.info(
          `Repository already exists at ${tmpDir}, using existing copy`,
        );
      } else {
        const git: SimpleGit = simpleGit();
        logger.info(`Cloning repository to ${tmpDir}`);
        await git.clone(repoUrl, tmpDir);
      }

      // Fix outdated Dockerfiles
      await fixDockerfiles(tmpDir, logger);

      const services = await detectServices(tmpDir);

      return res.json({
        repoName,
        services,
        tmpDir,
      });
    } catch (error) {
      logger.error(`Service detection failed: ${error}`);
      return res
        .status(500)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // POST /microservice/generate - Generate configuration files
  router.post('/microservice/generate', async (req, res) => {
    const { repoName, repoUrl, services, step } = req.body;

    try {
      logger.info(`Generating ${step} for ${repoName}`);

      const tmpDir = path.join(
        process.cwd(),
        '..',
        '..',
        'microservices',
        repoName,
      );
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
          content = generateCatalogInfo(repoName, repoUrl, services);
          await fs.writeFile(path.join(tmpDir, 'catalog-info.yaml'), content);

          const configPath = path.join(
            process.cwd(),
            '..',
            '..',
            'app-config.yaml',
          );
          if (await fs.pathExists(configPath)) {
            let appConfig = await fs.readFile(configPath, 'utf-8');
            const catalogEntry = `    - type: file\n      target: ../../microservices/${repoName}/catalog-info.yaml\n      rules:\n        - allow: [System, Component, API, Resource]`;

            if (!appConfig.includes(`microservices/${repoName}`)) {
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

      return res.json({
        success: true,
        message,
        content,
      });
    } catch (error) {
      logger.error(`Configuration generation failed: ${error}`);
      return res
        .status(500)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // POST /microservice/deploy - Deploy services
  router.post('/microservice/deploy', async (req, res) => {
    const { repoName, services } = req.body;

    try {
      logger.info(`Deploying services for ${repoName}`);

      const microservicesDir = path.join(
        process.cwd(),
        '..',
        '..',
        'microservices',
        repoName,
      );

      // Fix Dockerfiles before deploying
      await fixDockerfiles(microservicesDir, logger);

      // Try to deploy with all services first
      logger.info('Attempting to deploy all services...');
      const dockerCompose = spawn(
        'docker-compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'up',
          '-d',
          '--build',
          '--remove-orphans',
          '--no-log-prefix',
        ],
        {
          cwd: microservicesDir,
          shell: true,
          timeout: 300000, // 5 minute timeout
        },
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
        // Only log warnings, not all stderr (Docker Compose logs to stderr)
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
            // Extract the actual error message
            const match = errorMsg.match(/ERROR:(.+?)(?:\n|$)/i);
            const shortError = match
              ? match[1].trim()
              : `Docker Compose exited with code ${code}`;

            // Try to identify which service failed
            const serviceMatch = errorMsg.match(/\[([^\]]+)\s+\d+\/\d+\]/);
            const failedService = serviceMatch ? serviceMatch[1] : 'unknown';

            reject(
              new Error(
                `Service '${failedService}' failed to build: ${shortError}\n\nTip: Java services may need Maven wrapper fixes. Check the Dockerfile.\n\nFull output:\n${errorMsg.substring(
                  0,
                  1000,
                )}`,
              ),
            );
          }
        });
      });

      // Wait a bit for services to stabilize
      logger.info('Waiting for services to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check which services actually started
      const psCommand = spawn(
        'docker-compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'ps',
          '--services',
          '--filter',
          'status=running',
        ],
        {
          cwd: microservicesDir,
          shell: true,
        },
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
        jaegerUrl: 'http://localhost:16686',
      });
    } catch (error) {
      logger.error(`Deployment failed: ${error}`);
      return res
        .status(500)
        .json({
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // POST /service/deploy-and-trace - Auto-deploy service and generate traces
  router.post('/service/deploy-and-trace', async (req, res) => {
    const { serviceName, jaegerServiceName, repoName } = req.body;

    try {
      logger.info(
        `🚀 Auto-deploying service: ${serviceName} (Jaeger: ${
          jaegerServiceName || serviceName
        })`,
      );

      const microservicesDir = path.join(
        process.cwd(),
        '..',
        '..',
        'microservices',
        repoName,
      );

      // Check if repository exists
      if (!(await fs.pathExists(microservicesDir))) {
        return res.status(404).json({
          success: false,
          error: `Repository "${repoName}" not found. Please configure the microservice first.`,
        });
      }

      // Fix Dockerfiles before deploying
      logger.info('🔧 Fixing Dockerfiles...');
      await fixDockerfiles(microservicesDir, logger);

      // Check if docker-compose.otel.yml exists, generate it if not
      const composeFilePath = path.join(
        microservicesDir,
        'docker-compose.otel.yml',
      );
      const composeFile = 'docker-compose.otel.yml';

      if (!(await fs.pathExists(composeFilePath))) {
        logger.info('📝 Generating docker-compose.otel.yml with Jaeger...');

        // Detect services in the repository
        const services = await detectServices(microservicesDir);

        if (services.length === 0) {
          return res.status(404).json({
            success: false,
            error:
              'No services detected in repository. Check if the repository has valid microservices.',
          });
        }

        // Generate docker-compose with Jaeger
        const dockerComposeContent = generateDockerCompose(services);
        await fs.writeFile(composeFilePath, dockerComposeContent);
        logger.info(
          `✅ Generated docker-compose.otel.yml with ${services.length} services + Jaeger`,
        );
      } else {
        logger.info('✅ docker-compose.otel.yml already exists');
      }

      logger.info(`📦 Starting containers from ${composeFile}...`);

      // Deploy with Docker Compose
      const dockerDeploy = spawn(
        'docker-compose',
        ['-f', composeFile, 'up', '-d', '--remove-orphans', '--no-log-prefix'],
        {
          cwd: microservicesDir,
          shell: true,
          timeout: 180000, // 3 minutes
        },
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
          if (code === 0) {
            resolve(code);
          } else {
            reject(
              new Error(`Deployment failed with code ${code}\n${deployError}`),
            );
          }
        });
      });

      logger.info('⏳ Waiting 15 seconds for services to initialize...');
      await new Promise(resolve => setTimeout(resolve, 15000));

      // Verify running services
      const psCommand = spawn(
        'docker-compose',
        ['-f', composeFile, 'ps', '--services', '--filter', 'status=running'],
        {
          cwd: microservicesDir,
          shell: true,
        },
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

      // Verify Jaeger is running
      const jaegerRunning = serviceList.includes('jaeger');
      if (!jaegerRunning) {
        logger.warn('⚠️ Jaeger container not found in running services!');
      } else {
        logger.info('✅ Jaeger is running on http://localhost:16686');
      }

      // Get service port from docker-compose file
      const composeContent = await fs.readFile(
        path.join(microservicesDir, composeFile),
        'utf-8',
      );
      const composeData = yaml.parse(composeContent);

      let servicePort = 5000;
      const serviceConfig = composeData.services?.[serviceName];
      if (serviceConfig?.ports) {
        const portMapping = Array.isArray(serviceConfig.ports)
          ? serviceConfig.ports[0]
          : serviceConfig.ports;
        const portMatch = String(portMapping).match(/(\d+):/);
        if (portMatch) {
          servicePort = parseInt(portMatch[1], 10);
        }
      }

      logger.info(
        `🔄 Generating traces for ${serviceName} on port ${servicePort}...`,
      );

      // Generate traces by making HTTP requests
      const serviceUrl = `http://localhost:${servicePort}`;
      const endpoints = [
        '/',
        '/health',
        '/api',
        '/api/quote',
        '/api/quotes',
        '/api/todos',
        '/api/users',
      ];

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

      // Wait for traces to propagate to Jaeger
      logger.info('⏳ Waiting for traces to propagate to Jaeger...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify traces in Jaeger
      const targetServiceName = jaegerServiceName || serviceName;
      const jaegerUrl = `http://localhost:16686/api/traces?service=${encodeURIComponent(
        targetServiceName,
      )}&lookback=5m&limit=100`;

      let tracesFound = 0;
      try {
        const jaegerResponse = await fetch(jaegerUrl);
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
        jaegerUrl: 'http://localhost:16686',
      });
    } catch (error) {
      logger.error(`Failed to deploy and trace: ${error}`);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /service/start-jaeger - start Jaeger container for a given repo
  router.post('/service/start-jaeger', async (req, res) => {
    const { repoName } = req.body || {};

    try {
      const repo = repoName || '';
      logger.info(`📊 Starting Jaeger for repo: ${repo || 'default'}`);

      // If repoName provided, use it; otherwise find docker-compose in any microservices dir
      let microservicesDir = '';
      if (repo) {
        microservicesDir = path.join(
          process.cwd(),
          '..',
          '..',
          'microservices',
          repo,
        );
        if (!(await fs.pathExists(microservicesDir))) {
          logger.warn(`⚠️ Repo directory not found: ${microservicesDir}`);
          return res.status(404).json({
            success: false,
            error: `Repository "${repo}" not found at ${microservicesDir}`,
          });
        }
      } else {
        // Find first directory with docker-compose.otel.yml
        const microservicesBase = path.join(
          process.cwd(),
          '..',
          '..',
          'microservices',
        );
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
        logger.error(`❌ Compose file not found: ${composePath}`);
        return res.status(404).json({
          success: false,
          error: `${composeFile} not found - please generate configuration files first`,
        });
      }

      logger.info(
        `🚀 Starting Jaeger via docker-compose in ${microservicesDir}`,
      );

      const dockerUp = spawn(
        'docker-compose',
        ['-f', composeFile, 'up', '-d', 'jaeger'],
        {
          cwd: microservicesDir,
          shell: true,
          timeout: 120000,
        },
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
      // Give Jaeger more time to fully start and become responsive
      await new Promise(r => setTimeout(r, 15000));

      // Health check - verify Jaeger is actually responding
      logger.info(
        '🔍 Checking Jaeger health at http://localhost:16686/api/services',
      );
      let jaegerHealthy = false;
      let healthCheckAttempts = 0;
      const maxAttempts = 5;

      while (healthCheckAttempts < maxAttempts && !jaegerHealthy) {
        try {
          const healthResponse = await fetch(
            'http://localhost:16686/api/services',
            {
              timeout: 5000,
            },
          );
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
          if (healthCheckAttempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 2000));
          }
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
      const microservicesDir = path.join(
        process.cwd(),
        '..',
        '..',
        'microservices',
        repoName,
      );

      // Auto-clone repository if it doesn't exist
      if (!(await fs.pathExists(microservicesDir))) {
        if (!gitHubUrl) {
          logger.warn(
            `⚠️ Repository directory not found and no GitHub URL provided for auto-cloning: ${repoName}`,
          );
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
          const git: SimpleGit = simpleGit();
          await git.clone(gitHubUrl, microservicesDir);
          logger.info(
            `✅ Repository cloned successfully to ${microservicesDir}`,
          );
        } catch (cloneErr) {
          logger.error(`❌ Failed to clone repository: ${cloneErr}`);
          return res.status(500).json({
            success: false,
            error: `Failed to clone repository: ${
              cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
            }`,
          });
        }
      }

      logger.info(`🚀 Deploying all services from repo: ${repoName}`);

      // Detect all services
      const services = await detectServices(microservicesDir);
      if (services.length === 0) {
        return res
          .status(400)
          .json({
            success: false,
            error: 'No services detected in repository',
          });
      }

      logger.info(
        `✅ Detected ${services.length} services: ${services
          .map(s => s.name)
          .join(', ')}`,
      );

      // Fix Dockerfiles
      logger.info('🔧 Fixing Dockerfiles...');
      await fixDockerfiles(microservicesDir, logger);

      // Generate compose if needed
      const composeFilePath = path.join(
        microservicesDir,
        'docker-compose.otel.yml',
      );
      if (!(await fs.pathExists(composeFilePath))) {
        logger.info('📝 Generating docker-compose.otel.yml...');
        const dockerComposeContent = generateDockerCompose(services);
        await fs.writeFile(composeFilePath, dockerComposeContent);
      }

      logger.info('📦 Starting all containers...');
      const dockerUp = spawn(
        'docker-compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'up',
          '-d',
          '--remove-orphans',
          '--no-log-prefix',
        ],
        {
          cwd: microservicesDir,
          shell: true,
          timeout: 180000,
        },
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

      // Get running services
      const ps = spawn(
        'docker-compose',
        [
          '-f',
          'docker-compose.otel.yml',
          'ps',
          '--services',
          '--filter',
          'status=running',
        ],
        {
          cwd: microservicesDir,
          shell: true,
        },
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
      return res
        .status(500)
        .json({
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

      const microservicesDir = path.join(
        process.cwd(),
        '..',
        '..',
        'microservices',
        repoName,
      );

      // Check if docker-compose file exists
      const composeFile = (await fs.pathExists(
        path.join(microservicesDir, 'docker-compose.yml'),
      ))
        ? 'docker-compose.yml'
        : 'docker-compose.otel.yml';

      if (!(await fs.pathExists(path.join(microservicesDir, composeFile)))) {
        throw new Error(`No docker-compose file found in ${microservicesDir}`);
      }

      // Start services
      logger.info(`Starting services with docker-compose...`);
      const dockerUp = spawn(
        'docker-compose',
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
          if (code === 0) {
            resolve(code);
          } else {
            reject(
              new Error(
                `Docker Compose up failed with code ${code}\n${upOutput}`,
              ),
            );
          }
        });
      });

      // Wait for services to be ready
      logger.info(`Waiting for services to initialize...`);
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Get service info from docker-compose
      const dockerPs = spawn(
        'docker-compose',
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

      // Parse service info
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

      // Generate traces by making requests
      logger.info(`Generating traces for ${serviceName}...`);
      const traceCount = 20;
      const traces = [];

      // Find service port
      const serviceInfo = runningServices.find(
        (s: any) =>
          s.Service?.toLowerCase().includes(serviceName.toLowerCase()) ||
          s.Name?.toLowerCase().includes(serviceName.toLowerCase()),
      );

      if (serviceInfo && serviceInfo.Publishers) {
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
              quote: data.quote?.substring(0, 50),
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

      // Wait a bit for traces to be collected
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Fetch traces from Jaeger
      logger.info(`Fetching traces from Jaeger for ${serviceName}...`);
      const jaegerUrl = `http://localhost:16686/api/traces?service=${serviceName}&lookback=5m&limit=100`;
      const jaegerResponse = await fetch(jaegerUrl);
      const jaegerData = await jaegerResponse.json();
      const traceList = jaegerData.data || [];

      logger.info(
        `✅ Service started and ${traceList.length} traces generated`,
      );

      // Log detailed trace information to console
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
        console.log(`\n==============================\n`);
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

  return router;
}

// Helper functions

function extractRepoName(repoUrl: string): string {
  const match = repoUrl.match(/\/([^\/]+?)(\.git)?$/);
  return match ? match[1] : 'microservice';
}

async function fixDockerfiles(
  repoPath: string,
  logger: LoggerService,
): Promise<void> {
  const imageReplacements: Record<string, string> = {
    // Node.js - upgrade old versions to LTS (order matters - most specific first)
    'node:6-alpine': 'node:20-alpine',
    'node:8-alpine': 'node:20-alpine',
    'node:10-alpine': 'node:20-alpine',
    'node:12-alpine': 'node:20-alpine',
    'node:14-alpine': 'node:20-alpine',
    'node:6': 'node:20-alpine',
    'node:8': 'node:20-alpine',
    'node:10': 'node:20-alpine',
    'node:12': 'node:20-alpine',
    'node:14': 'node:20-alpine',

    // Python - upgrade to supported versions
    'python:2.7-alpine': 'python:3.11-alpine',
    'python:3.6-alpine': 'python:3.11-alpine',
    'python:3.7-alpine': 'python:3.11-alpine',
    'python:2.7': 'python:3.11-alpine',
    'python:3.6': 'python:3.11-alpine',
    'python:3.7': 'python:3.11-alpine',

    // Java - replace deprecated OpenJDK with Eclipse Temurin JDK (includes compiler)
    'openjdk:8-jre-alpine': 'eclipse-temurin:17-jdk-alpine',
    'openjdk:8-alpine': 'eclipse-temurin:17-jdk-alpine',
    'openjdk:11-alpine': 'eclipse-temurin:17-jdk-alpine',
    'openjdk:8-jre': 'eclipse-temurin:17-jdk-alpine',
    'openjdk:8': 'eclipse-temurin:17-jdk-alpine',
    'openjdk:11': 'eclipse-temurin:17-jdk-alpine',

    // Go - upgrade to latest
    'golang:1.12-alpine': 'golang:1.21-alpine',
    'golang:1.14-alpine': 'golang:1.21-alpine',
    'golang:1.12': 'golang:1.21-alpine',
    'golang:1.14': 'golang:1.21-alpine',
  };

  const entries = await fs.readdir(repoPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const dockerfilePath = path.join(repoPath, entry.name, 'Dockerfile');

    if (await fs.pathExists(dockerfilePath)) {
      let content = await fs.readFile(dockerfilePath, 'utf-8');
      const originalContent = content;
      let modified = false;

      // Replace outdated base images - process each line to avoid double replacements
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().toUpperCase().startsWith('FROM')) {
          for (const [oldImage, newImage] of Object.entries(
            imageReplacements,
          )) {
            // Match the exact image name after FROM
            const regex = new RegExp(
              `^(\\s*FROM\\s+)${oldImage.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
              )}(\\s|$)`,
              'i',
            );
            if (regex.test(line)) {
              lines[i] = line.replace(regex, `$1${newImage}$2`);
              modified = true;
              logger.info(
                `Replaced ${oldImage} with ${newImage} in ${entry.name}/Dockerfile`,
              );
              break; // Only replace once per line
            }
          }
        }
      }

      if (modified) {
        content = lines.join('\n');
      }

      // Fix common Dockerfile issues for old Node.js versions
      if (
        content.includes('node:') &&
        content.includes('npm install') &&
        !content.includes('npm install -g npm')
      ) {
        const npmLines = content.split('\n');
        const fromIndex = npmLines.findIndex(
          line =>
            line.trim().toUpperCase().startsWith('FROM') &&
            line.includes('node:'),
        );
        if (fromIndex >= 0 && fromIndex < npmLines.length - 1) {
          // Insert npm update after FROM line
          const indent = npmLines[fromIndex].match(/^\s*/)?.[0] || '';
          npmLines.splice(
            fromIndex + 1,
            0,
            `${indent}RUN npm install -g npm@latest`,
          );
          content = npmLines.join('\n');
          modified = true;
          logger.info(`Added npm update to ${entry.name}/Dockerfile`);
        }
      }

      // Fix Maven wrapper issues in Java services
      if (content.includes('openjdk') || content.includes('temurin')) {
        const javaLines = content.split('\n');

        // Fix mvnw permissions and line endings - add sed/dos2unix before any RUN ./mvnw commands
        let mvnwFixed = false;
        for (let i = 0; i < javaLines.length; i++) {
          if (javaLines[i].includes('./mvnw') && !mvnwFixed) {
            // Find the COPY mvnw line
            let copyIndex = -1;
            for (let j = i - 1; j >= 0; j--) {
              if (
                javaLines[j].includes('COPY') &&
                (javaLines[j].includes('mvnw') || javaLines[j].includes('.mvn'))
              ) {
                copyIndex = j;
                break;
              }
            }

            if (copyIndex >= 0) {
              // Check if chmod/dos2unix already exists
              let hasChmod = false;
              for (let k = copyIndex; k < i; k++) {
                if (
                  (javaLines[k].includes('chmod') ||
                    javaLines[k].includes('dos2unix') ||
                    javaLines[k].includes('sed')) &&
                  javaLines[k].includes('mvnw')
                ) {
                  hasChmod = true;
                  break;
                }
              }

              if (!hasChmod) {
                const indent = javaLines[copyIndex].match(/^\s*/)?.[0] || '';
                // Insert dos2unix and chmod after the last COPY mvnw related line
                let insertIndex = copyIndex;
                while (
                  insertIndex < javaLines.length - 1 &&
                  javaLines[insertIndex + 1].includes('COPY')
                ) {
                  insertIndex++;
                }
                // First fix line endings with dos2unix, then make executable
                javaLines.splice(
                  insertIndex + 1,
                  0,
                  `${indent}RUN dos2unix mvnw 2>/dev/null || sed -i 's/\\r$//' mvnw || true`,
                  `${indent}RUN chmod +x mvnw`,
                );
                modified = true;
                mvnwFixed = true;
                logger.info(
                  `Added dos2unix and mvnw chmod to ${entry.name}/Dockerfile`,
                );
              }
            }
          }
        }

        content = javaLines.join('\n');
      }

      if (modified && content !== originalContent) {
        await fs.writeFile(dockerfilePath, content);
        logger.info(`Updated Dockerfile for service: ${entry.name}`);
      }
    }
  }
}

async function detectServices(repoPath: string): Promise<any[]> {
  const services: any[] = [];
  const entries = await fs.readdir(repoPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const servicePath = path.join(repoPath, entry.name);
    const language = await detectLanguage(servicePath);

    if (language) {
      const hasDockerfile = await fs.pathExists(
        path.join(servicePath, 'Dockerfile'),
      );
      const entrypoint = await detectEntrypoint(servicePath, language);

      services.push({
        name: entry.name,
        language,
        path: entry.name,
        port: 8080 + services.length,
        hasDockerfile,
        entrypoint,
      });
    }
  }

  return services;
}

async function detectLanguage(servicePath: string): Promise<string | null> {
  if (await fs.pathExists(path.join(servicePath, 'package.json'))) {
    return 'nodejs';
  }
  if (
    (await fs.pathExists(path.join(servicePath, 'requirements.txt'))) ||
    (await fs.pathExists(path.join(servicePath, 'setup.py'))) ||
    (await fs.pathExists(path.join(servicePath, 'main.py')))
  ) {
    return 'python';
  }
  if (await fs.pathExists(path.join(servicePath, 'go.mod'))) {
    return 'go';
  }
  if (
    (await fs.pathExists(path.join(servicePath, 'pom.xml'))) ||
    (await fs.pathExists(path.join(servicePath, 'build.gradle')))
  ) {
    return 'java';
  }
  return null;
}

async function detectEntrypoint(
  servicePath: string,
  language: string,
): Promise<string | undefined> {
  try {
    if (language === 'nodejs') {
      const pkgJson = await fs.readFile(
        path.join(servicePath, 'package.json'),
        'utf-8',
      );
      const pkg = JSON.parse(pkgJson);
      return pkg.main || 'index.js';
    } else if (language === 'python') {
      if (await fs.pathExists(path.join(servicePath, 'main.py'))) {
        return 'main.py';
      } else if (await fs.pathExists(path.join(servicePath, 'app.py'))) {
        return 'app.py';
      }
    }
  } catch (err) {
    // Ignore errors
  }
  return undefined;
}

function generateDockerCompose(services: any[]): string {
  const compose: any = {
    services: {
      jaeger: {
        image: 'jaegertracing/all-in-one:latest',
        container_name: 'jaeger',
        environment: ['COLLECTOR_OTLP_ENABLED=true'],
        ports: [
          '16686:16686',
          '4318:4318',
          '4317:4317',
          '14268:14268',
          '9411:9411',
        ],
        networks: ['microservices'],
      },
    },
    networks: {
      microservices: { driver: 'bridge' },
    },
  };

  for (const service of services) {
    const serviceConfig: any = {
      build: {
        context: `./${service.path}`,
        dockerfile: 'Dockerfile',
      },
      container_name: service.name,
      environment: [
        'OTEL_TRACES_EXPORTER=otlp',
        `OTEL_SERVICE_NAME=${service.name}`,
        'OTEL_RESOURCE_ATTRIBUTES=service.namespace=production',
      ],
      ports: [`${service.port}:${service.port}`],
      depends_on: ['jaeger'],
      networks: ['microservices'],
    };

    if (service.language === 'nodejs') {
      serviceConfig.environment.push(
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318',
      );
      const entrypoint = service.entrypoint || 'index.js';
      serviceConfig.command = `sh -c "npm install && npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node && node --require @opentelemetry/auto-instrumentations-node/register ${entrypoint}"`;
    } else if (service.language === 'python') {
      serviceConfig.environment.push(
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
      );
      const entrypoint = service.entrypoint || 'main.py';
      serviceConfig.command = `sh -c "pip install opentelemetry-distro opentelemetry-exporter-otlp && opentelemetry-bootstrap -a install && opentelemetry-instrument python ${entrypoint}"`;
    } else if (service.language === 'go' || service.language === 'java') {
      serviceConfig.environment.push(
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317',
      );
    }

    compose.services[service.name] = serviceConfig;
  }

  return yaml.stringify(compose);
}

function generateCatalogInfo(
  repoName: string,
  repoUrl: string,
  services: any[],
): string {
  const catalog: any[] = [
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'System',
      metadata: {
        name: repoName,
        title: repoName
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (l: string) => l.toUpperCase()),
        description: `Microservices system from ${repoUrl}`,
        annotations: {
          'github.com/project-slug': extractGithubSlug(repoUrl),
        },
      },
      spec: {
        owner: 'team-platform',
        domain: 'microservices',
      },
    },
  ];

  for (const service of services) {
    catalog.push({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: service.name,
        title: service.name
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (l: string) => l.toUpperCase()),
        description: `${service.language} microservice`,
        annotations: {
          'jaegertracing.io/service-name': service.name,
          'tracing.opentelemetry/instrumented': 'true',
          'github.com/project-slug': extractGithubSlug(repoUrl),
        },
      },
      spec: {
        type: 'service',
        lifecycle: 'production',
        owner: 'team-backend',
        system: repoName,
      },
    });
  }

  return catalog.map(item => yaml.stringify(item)).join('\n---\n');
}

function extractGithubSlug(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[\/:](.+?)(\.git)?$/);
  return match ? match[1] : repoUrl;
}

function generateGoTracing(): string {
  return `package main

import (
    "context"
    "log"
    "os"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

func initTracer() func() {
    ctx := context.Background()

    endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint == "" {
        endpoint = "localhost:4317"
    }

    serviceName := os.Getenv("OTEL_SERVICE_NAME")
    if serviceName == "" {
        serviceName = "unknown-service"
    }

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(endpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        log.Fatalf("Failed to create exporter: %v", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
        ),
    )
    if err != nil {
        log.Fatalf("Failed to create resource: %v", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
    )

    otel.SetTracerProvider(tp)

    return func() {
        ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
        if err := tp.Shutdown(ctx); err != nil {
            log.Printf("Error shutting down tracer provider: %v", err)
        }
    }
}
`;
}

function generatePowerShellScript(repoName: string, services: any[]): string {
  return `#!/usr/bin/env pwsh
Write-Host "🚀 Starting ${repoName} microservices with OpenTelemetry tracing" -ForegroundColor Cyan

# Start Docker Compose
Write-Host "📦 Starting services..." -ForegroundColor Yellow
docker-compose -f docker-compose.otel.yml up -d

# Wait for services
Write-Host "⏳ Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

Write-Host "\\n✅ All services started!" -ForegroundColor Green
Write-Host "\\n📊 Access Points:" -ForegroundColor Cyan
Write-Host "  Jaeger UI: http://localhost:16686" -ForegroundColor White
${services
  .map(
    (s: any) =>
      `Write-Host "  ${s.name}: http://localhost:${s.port}" -ForegroundColor White`,
  )
  .join('\n')}
Write-Host "  Function Analytics: http://localhost:3000/function-analytics" -ForegroundColor White
`;
}

function generateBashScript(repoName: string, services: any[]): string {
  return `#!/bin/bash
echo "🚀 Starting ${repoName} microservices with OpenTelemetry tracing"

# Start Docker Compose
echo "📦 Starting services..."
docker-compose -f docker-compose.otel.yml up -d

# Wait for services
echo "⏳ Waiting for services to start..."
sleep 15

echo "✅ All services started!"
echo ""
echo "📊 Access Points:"
echo "  Jaeger UI: http://localhost:16686"
${services
  .map((s: any) => `echo "  ${s.name}: http://localhost:${s.port}"`)
  .join('\n')}
echo "  Function Analytics: http://localhost:3000/function-analytics"
`;
}
