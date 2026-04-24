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
import * as net from 'net';

// Modules
import { FraConfig } from '../modules/config/FraConfig';
import { detectServices } from '../modules/discovery/ServiceDiscoveryEngine';
import { fixDockerfiles } from '../modules/orchestration/DockerfileFixerAdapter';
import { createServerWrappers } from '../modules/orchestration/ServerWrapperGenerator';
import {
  generateDockerCompose,
  injectOtelIntoComposeContent,
  patchOtelMethodsInclude,
  patchComposeWithKubernetesEnv,
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
import { applyDecisionLogic } from '../modules/analysis/RelocationDecisionEngine';
import { enrichWithCodeLocations } from '../modules/analysis/TraceToCodeMapper';
import {
  buildAllRegistries,
  buildRegistryLookup,
} from '../modules/static-analysis/FunctionRegistryBuilder';
import { ProviderRegistry } from '../lib/ProviderRegistry';
import { FraPipeline } from '../lib/FraPipeline';
import { SyntheticTraceProvider } from '../modules/tracing/SyntheticTraceGenerator';

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

// ─── Pre-flight helpers ──────────────────────────────────────────────────────

/**
 * Returns true if the service name or image matches known database/infra patterns.
 * Used to deprioritize infra services in fallback logic.
 */
function isInfraService(name: string, cfg: any): boolean {
  const infraPatterns = [
    'mongo',
    'redis',
    'postgres',
    'mysql',
    'rabbitmq',
    'kafka',
    'elasticsearch',
    'cassandra',
    'zookeeper',
    'nats',
    'etcd',
    'prometheus',
    'grafana',
    'zipkin',
  ];
  const suffixPatterns = ['-db', '-cache', '-queue', '-mq', '-store'];
  const lname = name.toLowerCase();
  const limage = ((cfg?.image as string) || '').toLowerCase();
  return (
    infraPatterns.some(p => lname.includes(p) || limage.includes(p)) ||
    suffixPatterns.some(s => lname.endsWith(s))
  );
}

/**
 * Returns true if the Docker daemon is reachable (docker info succeeds).
 */
async function isDockerAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn('docker', ['info'], { shell: true, timeout: 10000 });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Returns true if the given TCP port is already in use on localhost.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Reads a compose file, detects ports that are already bound on the host,
 * and returns the list of conflicting service names.
 */
async function detectPortConflicts(
  composeFilePath: string,
  logger: LoggerService,
): Promise<string[]> {
  const conflicts: string[] = [];
  try {
    const composeData = yaml.parse(await fs.readFile(composeFilePath, 'utf-8'));
    for (const [svcName, svcRaw] of Object.entries(
      composeData.services || {},
    )) {
      const svc = svcRaw as any;
      if (!Array.isArray(svc.ports)) continue;
      for (const portDef of svc.ports) {
        const hostPort = parseInt(String(portDef).split(':')[0], 10);
        if (!isNaN(hostPort) && (await isPortInUse(hostPort))) {
          logger.warn(
            `Port ${hostPort} (service: ${svcName}) is already in use on the host`,
          );
          conflicts.push(svcName);
          break;
        }
      }
    }
  } catch {
    // Non-fatal
  }
  return conflicts;
}

/**
 * Finds the first existing docker-compose file in a repo directory.
 * Checks standard names and common subdirectory locations.
 */
async function findRootComposeFile(repoDir: string): Promise<string | null> {
  const candidates = [
    path.join(repoDir, 'docker-compose.yml'),
    path.join(repoDir, 'docker-compose.yaml'),
    path.join(repoDir, 'docker', 'docker-compose.yml'),
    path.join(repoDir, 'docker', 'docker-compose.yaml'),
    path.join(repoDir, 'deploy', 'docker-compose.yml'),
    path.join(repoDir, 'deploy', 'docker-compose.yaml'),
  ];
  for (const c of candidates) {
    if (await fs.pathExists(c)) return c;
  }
  return null;
}

/**
 * Builds individual services one-by-one when the full `docker compose up --build`
 * fails. This prevents one broken Dockerfile from stopping all other services.
 *
 * Returns the list of service names that built and started successfully.
 */
async function buildServicesWithRecovery(
  repoDir: string,
  composeFile: string,
  logger: LoggerService,
): Promise<{ succeeded: string[]; failed: string[] }> {
  // Get service names from compose
  let serviceNames: string[] = [];
  try {
    const composeData = yaml.parse(
      await fs.readFile(path.join(repoDir, composeFile), 'utf-8'),
    );
    serviceNames = Object.keys(composeData.services || {});
  } catch {
    return { succeeded: [], failed: [] };
  }

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const svcName of serviceNames) {
    await new Promise<void>(resolve => {
      const proc = spawn(
        'docker compose',
        ['-f', composeFile, 'up', '-d', '--build', '--no-deps', svcName],
        { cwd: repoDir, shell: true, timeout: 300000 },
      );
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => {
        const txt = d.toString();
        stderr += txt;
        if (
          txt.toLowerCase().includes('error') ||
          txt.toLowerCase().includes('failed')
        ) {
          logger.warn(`[${svcName}] ${txt.trim()}`);
        }
      });
      proc.stdout?.on('data', (d: Buffer) =>
        logger.info(`[${svcName}] ${d.toString().trim()}`),
      );
      proc.on('close', code => {
        if (code === 0) {
          logger.info(`✅ Service '${svcName}' started successfully`);
          succeeded.push(svcName);
        } else {
          logger.warn(
            `⚠️ Service '${svcName}' failed to build/start (code ${code}): ${stderr.slice(
              -300,
            )}`,
          );
          failed.push(svcName);
        }
        resolve();
      });
      proc.on('error', () => {
        failed.push(svcName);
        resolve();
      });
    });
  }

  return { succeeded, failed };
}

/**
 * Discovers API endpoints for a service by querying Spring Actuator mappings
 * or OpenAPI specs. Returns an array of `{ path, method }` objects ready for
 * probing. Falls back to an empty array when neither is available.
 *
 * Covers:
 * - Spring Boot Actuator `/actuator/mappings`
 * - OpenAPI v3 `/v3/api-docs`
 * - Swagger v2 `/v2/api-docs`
 */
async function discoverApiEndpoints(
  serviceUrl: string,
): Promise<Array<{ path: string; method: string }>> {
  const routes: Array<{ path: string; method: string }> = [];

  // ── 1. Spring Boot Actuator mappings ──────────────────────────────────────
  try {
    const resp = await fetch(`${serviceUrl}/actuator/mappings`, {
      timeout: 5000,
    } as any);
    if (resp.ok) {
      const data = (await resp.json()) as any;
      // Spring Boot 2+ structure: contexts.<name>.mappings.dispatcherServlets.dispatcherServlet
      for (const ctx of Object.values(data?.contexts || {})) {
        const servlets =
          (ctx as any)?.mappings?.dispatcherServlets?.dispatcherServlet || [];
        for (const mapping of servlets) {
          const cond = mapping?.details?.requestMappingConditions;
          if (!cond) continue;
          const methods: string[] = cond.methods?.length
            ? cond.methods
            : ['GET'];
          let patterns: string[] = [];
          if (cond.patterns?.length) {
            patterns = cond.patterns;
          } else if (cond.patternValues?.length) {
            patterns = cond.patternValues;
          }
          for (const pattern of patterns) {
            if (pattern.includes('actuator') || pattern.includes('error'))
              continue;
            // Replace {pathVar} and wildcards with simple test values
            const testPath = pattern
              .replace(/\{[^}]+\}/g, '1')
              .replace(/\*+/g, '');
            if (testPath && testPath !== '/') {
              routes.push({ path: testPath, method: methods[0] || 'GET' });
            }
          }
          if (routes.length >= 50) break;
        }
        if (routes.length >= 50) break;
      }
    }
  } catch {
    // Actuator not available — try OpenAPI
  }

  // ── 2. OpenAPI v3 /v3/api-docs ────────────────────────────────────────────
  if (routes.length === 0) {
    try {
      const resp = await fetch(`${serviceUrl}/v3/api-docs`, {
        timeout: 5000,
      } as any);
      if (resp.ok) {
        const spec = (await resp.json()) as any;
        for (const [routePath, methods] of Object.entries(spec?.paths || {})) {
          for (const method of Object.keys(methods as any)) {
            if (!['get', 'post', 'put', 'delete', 'patch'].includes(method))
              continue;
            const testPath = routePath.replace(/\{[^}]+\}/g, '1');
            routes.push({ path: testPath, method: method.toUpperCase() });
            if (routes.length >= 50) break;
          }
          if (routes.length >= 50) break;
        }
      }
    } catch {
      // OpenAPI v3 not available
    }
  }

  // ── 3. Swagger v2 /v2/api-docs ────────────────────────────────────────────
  if (routes.length === 0) {
    try {
      const resp = await fetch(`${serviceUrl}/v2/api-docs`, {
        timeout: 5000,
      } as any);
      if (resp.ok) {
        const spec = (await resp.json()) as any;
        for (const [routePath, methods] of Object.entries(spec?.paths || {})) {
          for (const method of Object.keys(methods as any)) {
            if (!['get', 'post', 'put', 'delete', 'patch'].includes(method))
              continue;
            const testPath = routePath.replace(/\{[^}]+\}/g, '1');
            routes.push({ path: testPath, method: method.toUpperCase() });
            if (routes.length >= 50) break;
          }
          if (routes.length >= 50) break;
        }
      }
    } catch {
      // Swagger not available
    }
  }

  return routes;
}

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
          up.stderr?.on('data', (d: Buffer) =>
            logger.info(`[docker-traffic] ${d.toString().trim()}`),
          );
          up.stdout?.on('data', (d: Buffer) =>
            logger.info(`[docker-traffic] ${d.toString().trim()}`),
          );
          up.on('close', code => {
            if (code === 0) resolve();
            else
              reject(
                new Error(
                  `docker compose up ${trafficServiceName} exited ${code}`,
                ),
              );
          });
          up.on('error', reject);
        });

        // Give the traffic generator time to exercise the services
        const trafficDurationMs = 60000;
        logger.info(
          `⏳ Letting Docker traffic generator run for ${
            trafficDurationMs / 1000
          }s...`,
        );
        await new Promise(r => setTimeout(r, trafficDurationMs));

        // Count approximate successful requests from container logs
        let logOutput = '';
        await new Promise<void>(resolve => {
          const logs = spawn(
            'docker compose',
            [
              '-f',
              composeFile,
              'logs',
              '--no-log-prefix',
              '--tail=500',
              trafficServiceName,
            ],
            { cwd: repoDir, shell: true },
          );
          logs.stdout?.on('data', (d: Buffer) => {
            const line = d.toString();
            logOutput += line;
            if (line.trim()) logger.info(`[traffic] ${line.trim()}`);
          });
          logs.on('close', () => resolve());
        });

        const successCount = (
          logOutput.match(
            /status=20[01]|created|succeeded|201|\bcreated\b/gi,
          ) || []
        ).length;
        logger.info(
          `✅ Docker traffic generator: ~${successCount} successful requests logged`,
        );
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
        if (
          (await fs.pathExists(pkgJson)) &&
          !(await fs.pathExists(nodeModules))
        ) {
          logger.info('📦 Running npm install before traffic generator...');
          await new Promise<void>(resolve => {
            const npm = spawn('npm', ['install', '--prefer-offline'], {
              cwd: repoDir,
              shell: true,
            });
            npm.on('close', () => resolve());
          });
        }
      }

      // Resolve gateway URL from compose host-port mappings
      let gatewayUrl = serviceUrls[0] || 'http://localhost:8080';
      try {
        if (await fs.pathExists(composePath)) {
          const composeData = yaml.parse(
            await fs.readFile(composePath, 'utf-8'),
          );
          for (const [svcName, svcRaw] of Object.entries(
            composeData.services || {},
          )) {
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

      logger.info(
        `🌐 Using GATEWAY_URL=${gatewayUrl} for host-side traffic generator`,
      );

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
          logger.info(
            `✅ Host traffic generator exited code=${code}, ~${resolved} requests`,
          );
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

  // ── 2.5. Experiment gateway: POST /run-experiment on any gateway service ──
  // Detects repos like polyglot-fra-benchmark that expose a gateway endpoint
  // which triggers properly-labelled internal/external benchmark traffic.
  logger.info(
    `🔬 Checking for experiment gateway in ${serviceUrls.length} discovered service(s)...`,
  );
  for (const serviceUrl of serviceUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000); // 3-min timeout
      try {
        const resp = await fetch(`${serviceUrl}/run-experiment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rounds: 1, sleep_between_rounds_ms: 0 }),
          signal: controller.signal,
        });
        if (resp.ok) {
          const data = (await resp.json()) as any;
          const summaries: any[] = data.summaries || [];
          const totalExt = summaries.reduce(
            (a: number, s: any) => a + (s.totalExternalCalls || 0),
            0,
          );
          const totalInt = summaries.reduce(
            (a: number, s: any) => a + (s.totalInternalCalls || 0),
            0,
          );
          logger.info(
            `✅ Experiment gateway at ${serviceUrl}: ${totalExt} external + ${totalInt} internal calls`,
          );
          return totalExt + totalInt;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // not an experiment gateway or service unavailable — try next
    }
  }

  // ── 3. Fallback: probe each service's endpoints ──────────────────────────
  logger.info(
    `🔁 No traffic generator found — probing ${serviceUrls.length} service(s) directly`,
  );

  const REQUESTS_PER_SERVICE = Math.max(
    30,
    Math.ceil(200 / Math.max(serviceUrls.length, 1)),
  );
  let totalSuccess = 0;

  for (const serviceUrl of serviceUrls) {
    // Quick readiness check (up to 10s — health check in full-analysis pipeline
    // already waited up to 90s, so we just need a brief confirmation here)
    let ready = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const probe = await fetch(`${serviceUrl}/`, {
          method: 'GET',
          ...({ timeout: 4000 } as any),
        });
        if (probe.status < 500) {
          ready = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!ready) {
      logger.warn(`⚠️ Service at ${serviceUrl} did not respond — skipping`);
      continue;
    }

    // Discover actual API endpoints via Actuator/OpenAPI before falling back to '/'
    let discoveredEndpoints = await discoverApiEndpoints(serviceUrl);
    if (discoveredEndpoints.length > 0) {
      logger.info(
        `📋 Discovered ${discoveredEndpoints.length} API endpoint(s) for ${serviceUrl} via Actuator/OpenAPI`,
      );
    } else {
      discoveredEndpoints = [{ path: '/', method: 'GET' }];
    }

    let success = 0;
    for (let i = 0; i < REQUESTS_PER_SERVICE; i++) {
      const ep = discoveredEndpoints[i % discoveredEndpoints.length];
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
    logger.info(
      `✅ ${serviceUrl}: ${success}/${REQUESTS_PER_SERVICE} requests succeeded`,
    );
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

  // GET /analyze - fetch traces and produce relocation recommendations via FraPipeline
  router.get('/analyze', async (req, res) => {
    try {
      const service = (req.query.service as string) || 'all';
      const lookbackParam = (req.query.lookback as string) || '1h';

      // Parse lookback to hours
      let lookbackHours = 1;
      const lookbackLower = lookbackParam.toLowerCase();
      if (lookbackLower === '7d') {
        lookbackHours = 168;
      } else {
        const match = lookbackLower.match(/^(\d+)h$/);
        if (match) lookbackHours = parseInt(match[1], 10);
      }

      logger.info(
        `Analyzing function calls for service: ${service} with lookback: ${lookbackHours}h`,
      );

      const registry = ProviderRegistry.fromConfig(config);
      const pipeline = new FraPipeline(registry, config, logger);
      const decisions = await pipeline.analyze({
        service,
        lookbackHours,
        maxTraces: config.maxTracesPerService,
      });

      const servicesFilter = req.query.services as string | undefined;
      if (servicesFilter) {
        const serviceList = servicesFilter.split(',').map(s => s.trim());
        const filtered = decisions.filter(d =>
          serviceList.some(
            s =>
              d.currentService === s ||
              d.currentService.includes(s) ||
              s.includes(d.currentService),
          ),
        );
        return res.json(filtered);
      }

      return res.json(decisions);
    } catch (error) {
      logger.error(`Error analyzing function calls: ${error}`);
      return res.status(500).json({
        error: 'Failed to analyze function calls',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /fra/config - returns active FRA configuration as JSON
  router.get('/fra/config', (_req, res) => {
    return res.json(config.toJSON());
  });

  // GET /fra/providers - lists all registered provider type names
  router.get('/fra/providers', (_req, res) => {
    const registry = ProviderRegistry.fromConfig(config);
    return res.json(registry.listProviders());
  });

  // POST /microservice/detect - Detect services in repository and build function registries
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
        logger.info(`Shallow-cloning repository to ${tmpDir} (--depth=1)...`);
        await git.clone(repoUrl, tmpDir, ['--depth=1', '--single-branch']);
      }

      await fixDockerfiles(tmpDir, logger);

      const services = await detectServices(tmpDir, config);

      // Build static function registries for all detected services in parallel.
      // These are persisted to disk so /registry/:repoName can serve them later
      // and so the /analyze endpoint can cross-reference span names.
      logger.info(
        `Building function registries for ${services.length} services...`,
      );
      try {
        const registries = await buildAllRegistries(services, tmpDir);
        const registryPath = path.join(tmpDir, 'function-registry.json');
        await fs.writeFile(registryPath, JSON.stringify(registries, null, 2));
        const totalFunctions = registries.reduce(
          (s, r) => s + r.functions.length,
          0,
        );
        logger.info(
          `Function registry built: ${totalFunctions} app functions across ${registries.length} services → ${registryPath}`,
        );
      } catch (regErr) {
        logger.warn(`Function registry build failed (non-fatal): ${regErr}`);
      }

      return res.json({ repoName, services, tmpDir });
    } catch (error) {
      logger.error(`Service detection failed: ${error}`);
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /registry/:repoName - Return the static function registry for a repo
  router.get('/registry/:repoName', async (req, res) => {
    const { repoName } = req.params;
    try {
      const registryPath = path.join(
        config.repoPath(repoName),
        'function-registry.json',
      );
      if (!(await fs.pathExists(registryPath))) {
        return res.status(404).json({
          error: 'Registry not found. Run /microservice/detect first.',
        });
      }
      const registries = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
      const lookup = buildRegistryLookup(registries);
      const summary = registries.map((r: any) => ({
        service: r.service,
        language: r.language,
        functionCount: r.functions.length,
        functions: r.functions.map((f: any) => f.name),
      }));
      return res.json({
        repoName,
        registries: summary,
        totalFunctions: registries.reduce(
          (s: number, r: any) => s + r.functions.length,
          0,
        ),
        serviceCount: registries.length,
        lookupKeys: Array.from(lookup.keys()),
      });
    } catch (error) {
      logger.error(`Registry fetch failed: ${error}`);
      return res.status(500).json({ error: String(error) });
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
            content = injectOtelIntoComposeContent(composeContent, tmpDir);
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

      // ── Pre-flight: Docker daemon check ────────────────────────────────────
      if (!(await isDockerAvailable())) {
        return res.status(503).json({
          error:
            'Docker daemon is not running. Please start Docker Desktop or the Docker service and try again.',
          errorType: 'docker_unavailable',
        });
      }

      const microservicesDir = config.repoPath(repoName);

      await fixDockerfiles(microservicesDir, logger);

      const composeFile = 'docker-compose.otel.yml';
      const composeFilePath = path.join(microservicesDir, composeFile);

      // ── Port conflict pre-check ────────────────────────────────────────────
      if (await fs.pathExists(composeFilePath)) {
        const conflicting = await detectPortConflicts(composeFilePath, logger);
        if (conflicting.length > 0) {
          logger.warn(
            `Port conflicts detected for: ${conflicting.join(
              ', ',
            )} — proceeding anyway (containers may fail)`,
          );
        }
      }

      logger.info('Attempting to deploy all services...');
      let fullDeploySucceeded = false;
      let output = '';
      let errorOutput = '';

      // Remove any lingering /jaeger container so docker compose can create it fresh
      await new Promise<void>(resolve => {
        const rm = spawn('docker', ['rm', '-f', 'jaeger'], { shell: true });
        rm.on('close', () => resolve());
      });

      const dockerCompose = spawn(
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

      await new Promise<void>(resolve => {
        dockerCompose.on('close', code => {
          fullDeploySucceeded = code === 0;
          resolve();
        });
        dockerCompose.on('error', () => resolve());
      });

      // ── Per-service recovery if full deploy failed ─────────────────────────
      if (!fullDeploySucceeded) {
        logger.warn(
          'Full docker compose up failed — attempting per-service recovery...',
        );
        const { succeeded, failed } = await buildServicesWithRecovery(
          microservicesDir,
          composeFile,
          logger,
        );
        if (succeeded.length === 0) {
          const errorMsg = errorOutput || output;
          const match = errorMsg.match(/ERROR:(.+?)(?:\n|$)/i);
          const shortError = match
            ? match[1].trim()
            : `All services failed to build`;
          throw new Error(
            `All services failed to build: ${shortError}\n\nCheck Dockerfiles and build logs.\n\nFull output:\n${errorMsg.substring(
              0,
              1000,
            )}`,
          );
        }
        logger.info(
          `Recovery: ${succeeded.length} services up, ${
            failed.length
          } failed (${failed.join(', ')})`,
        );
      }

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
        const configPath = path.join(
          process.cwd(),
          '..',
          '..',
          'app-config.yaml',
        );
        if (await fs.pathExists(configPath)) {
          let appConfig = await fs.readFile(configPath, 'utf-8');
          const relPath = path
            .relative(path.join(process.cwd(), '..', '..'), microservicesDir)
            .replace(/\\/g, '/');
          const catalogEntry = `    - type: file\n      target: ../../${relPath}/catalog-info.yaml\n      rules:\n        - allow: [System, Component, API, Resource]`;

          if (!appConfig.includes(`${relPath}`)) {
            appConfig = appConfig.replace(
              /(catalog:[\s\S]*?locations:[\s\S]*?)((?:\n\s{4}- type:|\nscaffolder:))/,
              `$1\n${catalogEntry}$2`,
            );
            // Write it in the background to give the HTTP response time to finish and the frontend to navigate
            setTimeout(() => {
              fs.writeFile(configPath, appConfig).catch(e =>
                logger.error(`Failed to update app-config: ${e}`),
              );
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

      // ── Pre-flight: Docker daemon check ────────────────────────────────────
      if (!(await isDockerAvailable())) {
        return res.status(503).json({
          success: false,
          error:
            'Docker daemon is not running. Please start Docker Desktop or the Docker service and try again.',
          errorType: 'docker_unavailable',
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

      if (await fs.pathExists(composeFilePath)) {
        // Repo already ships a docker-compose.otel.yml (e.g. polyglot-fra-benchmark).
        // Preserve it — it has correct OTel settings, agent mounts, env vars, etc.
        logger.info(
          '✅ Repository already has docker-compose.otel.yml — using it as-is',
        );
      } else {
        // Support docker-compose.yml, docker-compose.yaml, and compose in docker/ subdir
        const rootComposePath = await findRootComposeFile(microservicesDir);
        if (rootComposePath) {
          // Prefer the repo's own docker-compose — it has correct ports, volumes,
          // environment variables, and service dependencies already configured.
          // We inject Jaeger + OTEL on top of it.
          logger.info(
            `📝 Found compose at ${path.relative(
              microservicesDir,
              rootComposePath,
            )} — injecting OTEL...`,
          );
          const composeContent = await fs.readFile(rootComposePath, 'utf-8');
          await fs.writeFile(
            composeFilePath,
            injectOtelIntoComposeContent(composeContent, microservicesDir),
          );
          logger.info(
            '✅ docker-compose.otel.yml written from existing compose + OTEL',
          );
        } else {
          // No root compose — discover services and generate one from scratch
          logger.info(
            '📝 No root docker-compose file found — generating from service discovery...',
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

      // ── Port conflict pre-check ────────────────────────────────────────────
      const portConflicts = await detectPortConflicts(composeFilePath, logger);
      if (portConflicts.length > 0) {
        logger.warn(
          `⚠️ Port conflicts for: ${portConflicts.join(
            ', ',
          )} — proceeding (services may fail to bind)`,
        );
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
            const rm = spawn('docker', ['rm', '-f', ...namedContainers], {
              shell: true,
            });
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
          await new Promise<void>((resolve, _reject) => {
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
        logger.warn(
          '⚠️ Could not ensure OTel agent — Java tracing may not work',
        );
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
      let deploySucceeded = false;

      dockerDeploy.stdout?.on('data', data => {
        deployOutput += data.toString();
        logger.info(data.toString());
      });
      dockerDeploy.stderr?.on('data', data => {
        const txt = data.toString();
        deployError += txt;
        if (
          txt.toLowerCase().includes('error') ||
          txt.toLowerCase().includes('failed')
        ) {
          logger.warn(`[deploy] ${txt.trim()}`);
        }
      });

      await new Promise<void>(resolve => {
        dockerDeploy.on('close', code => {
          deploySucceeded = code === 0;
          resolve();
        });
        dockerDeploy.on('error', () => resolve());
      });

      // ── Per-service recovery when full deploy fails ────────────────────────
      if (!deploySucceeded) {
        logger.warn(
          '⚠️ Full docker compose up failed — attempting per-service recovery...',
        );
        const { succeeded: recoveredSvcs, failed: failedSvcs } =
          await buildServicesWithRecovery(
            microservicesDir,
            composeFile,
            logger,
          );

        if (recoveredSvcs.length === 0) {
          // Categorise the error for better frontend messages
          const errLower = (deployError + deployOutput).toLowerCase();
          let errorType = 'build_failed';
          let errorHint =
            'Check Dockerfiles and build context for each service.';
          if (
            errLower.includes('network') ||
            errLower.includes('connection refused') ||
            errLower.includes('name or service not known')
          ) {
            errorType = 'network_error';
            errorHint =
              'A network error occurred. Check your internet connection and Docker network settings.';
          } else if (
            errLower.includes('port') ||
            errLower.includes('address already in use')
          ) {
            errorType = 'port_conflict';
            errorHint = `A port is already in use. Conflicting services: ${
              portConflicts.join(', ') || 'unknown'
            }. Stop other services using those ports.`;
          } else if (
            errLower.includes('no space left') ||
            errLower.includes('disk')
          ) {
            errorType = 'disk_full';
            errorHint =
              'Disk space is low. Run "docker system prune" to free space.';
          }
          throw Object.assign(
            new Error(
              `All services failed to start. ${errorHint}\n\nBuild output:\n${(
                deployError + deployOutput
              ).slice(-800)}`,
            ),
            { errorType },
          );
        }

        logger.info(
          `🔁 Recovery: ${recoveredSvcs.length} services up, ${
            failedSvcs.length
          } failed (${failedSvcs.join(', ')})`,
        );
      }

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
        // Prefer non-infra services as fallback; if none found, accept any service with ports
        let infraFallbackName: string | undefined;
        let infraFallbackCfg: any;

        for (const [name, cfg] of Object.entries(composeData.services || {})) {
          if (name.includes('jaeger') || (cfg as any).image?.includes('jaeger'))
            continue;
          if (!(cfg as any).ports) continue;

          if (isInfraService(name, cfg)) {
            // Remember first infra service as last-resort fallback
            if (!infraFallbackName) {
              infraFallbackName = name;
              infraFallbackCfg = cfg;
            }
            continue;
          }

          serviceConfig = cfg;
          actualServiceName = name;
          logger.info(
            `Service '${serviceName}' not found. Using fallback service '${name}'.`,
          );
          break;
        }

        // If no non-infra service found, fall back to infra service
        if (!serviceConfig && infraFallbackName) {
          serviceConfig = infraFallbackCfg;
          actualServiceName = infraFallbackName;
          logger.info(
            `Service '${serviceName}' not found. Using fallback service '${infraFallbackName}'.`,
          );
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
      const endpoints: { path: string; method: string }[] =
        Array.isArray(testEndpoints) && testEndpoints.length > 0
          ? testEndpoints.map(e => ({ path: e, method: 'GET' }))
          : [
              { path: '/', method: 'GET' },
              { path: '/health', method: 'GET' },
            ];

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
                if (
                  !endpoints.find(
                    e => e.path === endpointPath && e.method === method,
                  )
                ) {
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
        `Discovered endpoints to trace for ${actualServiceName}: ${endpoints
          .map(e => `${e.method} ${e.path}`)
          .join(', ')}`,
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

      // Use the generalized traffic generator — tries native scripts first,
      // falls back to probing endpoints discovered above.
      const successCount = await generateTrafficForRepo(
        microservicesDir,
        [serviceUrl],
        logger,
        composeFile,
      );

      logger.info(
        `✅ Generated ${successCount} successful requests for ${serviceName}`,
      );
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
      const errObj = error as any;
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorType: errObj?.errorType ?? 'unknown',
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

      // Remove any lingering Jaeger container(s) so docker compose can create it fresh.
      // Container name varies per repo (jaeger, jaeger-lightweight, etc.) so we list by filter.
      await new Promise<void>(resolve => {
        const ls = spawn(
          'docker',
          ['ps', '-a', '--filter', 'name=jaeger', '--format', '{{.Names}}'],
          { shell: true },
        );
        let names = '';
        ls.stdout?.on('data', (d: Buffer) => {
          names += d.toString();
        });
        ls.on('close', () => {
          const toRemove = names
            .split('\n')
            .map(n => n.trim())
            .filter(Boolean);
          if (toRemove.length === 0) {
            resolve();
            return;
          }
          const rm = spawn('docker', ['rm', '-f', ...toRemove], {
            shell: true,
          });
          rm.on('close', () => resolve());
        });
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
            error: `Failed to clone repository: ${
              cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
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
          error:
            'No services detected and no docker-compose.yml found in repository',
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
        await fs.writeFile(
          composeFilePath,
          injectOtelIntoComposeContent(rootContent, microservicesDir),
        );
      } else {
        await fs.writeFile(composeFilePath, generateDockerCompose(services));
      }

      logger.info('📦 Starting all containers...');

      // Remove any lingering Jaeger container(s) so docker compose can create it fresh.
      // Container name varies per repo (jaeger, jaeger-lightweight, etc.) so we list by filter.
      await new Promise<void>(resolve => {
        const ls = spawn(
          'docker',
          ['ps', '-a', '--filter', 'name=jaeger', '--format', '{{.Names}}'],
          { shell: true },
        );
        let names = '';
        ls.stdout?.on('data', (d: Buffer) => {
          names += d.toString();
        });
        ls.on('close', () => {
          const toRemove = names
            .split('\n')
            .map(n => n.trim())
            .filter(Boolean);
          if (toRemove.length === 0) {
            resolve();
            return;
          }
          const rm = spawn('docker', ['rm', '-f', ...toRemove], {
            shell: true,
          });
          rm.on('close', () => resolve());
        });
      });

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
        for (const [svcName, svcRaw] of Object.entries(
          composeData.services || {},
        )) {
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

      logger.info(
        `🚦 Generating traffic for ${serviceUrls.length} service(s)...`,
      );
      const totalTraffic = await generateTrafficForRepo(
        microservicesDir,
        serviceUrls,
        logger,
        'docker-compose.otel.yml',
      );
      logger.info(
        `✅ Traffic generation complete: ${totalTraffic} successful requests`,
      );
      logger.info('⏳ Waiting for traces to propagate to Jaeger...');
      await new Promise(r => setTimeout(r, 8000));

      // Resolve jaegerServiceNames from OTEL_SERVICE_NAME env vars in compose
      const servicesToTrace: Array<{
        serviceName: string;
        jaegerServiceName: string;
      }> = [];
      try {
        const composeContent = await fs.readFile(
          path.join(microservicesDir, 'docker-compose.otel.yml'),
          'utf-8',
        );
        const composeData = yaml.parse(composeContent);
        for (const [svcName, svcRaw] of Object.entries(
          composeData.services || {},
        )) {
          const svc = svcRaw as any;
          if (svcName === 'jaeger' || svc.image?.includes('jaeger')) continue;
          let jaegerName = svcName;
          const envList: string[] = Array.isArray(svc.environment)
            ? svc.environment
            : [];
          const otelEnv = envList.find(
            (e: string) =>
              typeof e === 'string' && e.startsWith('OTEL_SERVICE_NAME='),
          );
          if (otelEnv) jaegerName = otelEnv.split('=').slice(1).join('=');
          servicesToTrace.push({
            serviceName: svcName,
            jaegerServiceName: jaegerName,
          });
        }
      } catch {
        // fallback to discovered services list
        services
          .filter(s => s.name !== 'jaeger')
          .forEach(s =>
            servicesToTrace.push({
              serviceName: s.name,
              jaegerServiceName: s.name,
            }),
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

      // Remove any lingering Jaeger container(s) so docker compose can create it fresh.
      // Container name varies per repo (jaeger, jaeger-lightweight, etc.) so we list by filter.
      await new Promise<void>(resolve => {
        const ls = spawn(
          'docker',
          ['ps', '-a', '--filter', 'name=jaeger', '--format', '{{.Names}}'],
          { shell: true },
        );
        let names = '';
        ls.stdout?.on('data', (d: Buffer) => {
          names += d.toString();
        });
        ls.on('close', () => {
          const toRemove = names
            .split('\n')
            .map(n => n.trim())
            .filter(Boolean);
          if (toRemove.length === 0) {
            resolve();
            return;
          }
          const rm = spawn('docker', ['rm', '-f', ...toRemove], {
            shell: true,
          });
          rm.on('close', () => resolve());
        });
      });

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

  // ---------------------------------------------------------------------------
  // In-memory job store for async analysis jobs
  // ---------------------------------------------------------------------------
  interface JobStatus {
    status:
      | 'cloning'
      | 'detecting'
      | 'deploying'
      | 'tracing'
      | 'analyzing'
      | 'done'
      | 'error';
    progress: number;
    currentStep: string;
    logs: string[];
    error?: string;
    result?: any;
  }

  const jobStore = new Map<string, JobStatus>();

  // POST /fra/detect-services - detect microservices in a repository
  //
  // If the repo is already cloned locally: detect synchronously and return results.
  // If the repo needs cloning: kick off a background clone+detect job and return a
  // jobId immediately so the frontend can poll /fra/detect-job/:jobId/status instead
  // of waiting for a potentially multi-minute clone to complete synchronously.
  router.post('/fra/detect-services', async (req, res) => {
    try {
      const { repoUrl } = req.body;
      if (!repoUrl) {
        return res.status(400).json({ error: 'repoUrl is required' });
      }

      const repoName = extractRepoName(repoUrl);
      const repoPath = config.repoPath(repoName);

      // Fast path: repo already cloned — run detection synchronously
      // Guard: if directory exists but has no .git folder it's a broken/empty clone —
      // delete it so the slow path re-clones cleanly.
      if (await fs.pathExists(repoPath)) {
        const hasGit = await fs.pathExists(path.join(repoPath, '.git'));
        if (!hasGit) {
          logger.warn(
            `${repoPath} exists but has no .git — removing and re-cloning`,
          );
          await fs.remove(repoPath);
        } else {
          try {
            const services = await detectServices(repoPath, config);
            return res.json({ repoName, services, repoPath, cloning: false });
          } catch (detErr) {
            logger.error(`Service detection error: ${detErr}`);
            return res.status(500).json({
              error: 'Failed to detect services',
              message:
                detErr instanceof Error ? detErr.message : String(detErr),
            });
          }
        }
      }

      // Slow path: repo not yet cloned — start background job and return immediately
      // so large repos (e.g. DeathStarBench ~500 MB) don't time out the HTTP request.
      const jobId = `detect-${Date.now()}`;
      const job: JobStatus = {
        status: 'cloning',
        progress: 5,
        currentStep: 'Cloning repository',
        logs: [`Cloning ${repoUrl}...`],
      };
      jobStore.set(jobId, job);

      // Fire-and-forget
      (async () => {
        try {
          await fs.ensureDir(path.dirname(repoPath));
          await simpleGit().clone(repoUrl, repoPath, [
            '--depth=1',
            '--single-branch',
          ]);
          job.logs.push('Repository cloned.');
          job.progress = 70;
          job.currentStep = 'Detecting services';

          const services = await detectServices(repoPath, config);
          job.logs.push(`Detected ${services.length} service(s).`);
          job.status = 'done';
          job.progress = 100;
          job.currentStep = 'Complete';
          job.result = { repoName, services, repoPath, cloning: false };
        } catch (err) {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          job.currentStep = 'Error';
          job.logs.push(`Error: ${job.error}`);
          logger.error(`Background detect-services failed: ${err}`);
          // Remove partially-cloned directory so next attempt retries cleanly
          await fs.remove(repoPath).catch(() => {});
        }
      })();

      // Return job ID so frontend can poll
      return res.status(202).json({
        repoName,
        cloning: true,
        jobId,
        message:
          'Repository is being cloned. Poll /fra/detect-job/:jobId/status for results.',
      });
    } catch (error) {
      logger.error(`Error detecting services: ${error}`);
      return res.status(500).json({
        error: 'Failed to detect services',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /fra/detect-job/:jobId/status - poll the result of a background detect-services job
  router.get('/fra/detect-job/:jobId/status', (req, res) => {
    const { jobId } = req.params;
    const job = jobStore.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    // When done, return the full result inline (same shape as synchronous detect-services)
    if (job.status === 'done' && job.result) {
      return res.json({ ...job.result, jobStatus: 'done', logs: job.logs });
    }
    return res.json({
      jobStatus: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      logs: job.logs,
      error: job.error,
    });
  });

  // POST /fra/run-full-analysis - kick off a full async analysis pipeline
  router.post('/fra/run-full-analysis', async (req, res) => {
    try {
      const {
        repoUrl,
        lookbackHours,
        selectedServices,
        externalCallThreshold,
        confidenceMargin,
      } = req.body;
      if (!repoUrl) {
        return res.status(400).json({ error: 'repoUrl is required' });
      }

      // Build a job-local config that overrides the analysis thresholds when
      // the user has changed them in the frontend settings dialog.
      const jobConfig =
        externalCallThreshold !== undefined || confidenceMargin !== undefined
          ? new FraConfig({
              analysis: {
                externalCallThreshold:
                  externalCallThreshold ?? config.externalCallThreshold,
                confidenceMargin: confidenceMargin ?? config.confidenceMargin,
                minSampleSizeForHighConfidence:
                  config.minSampleSizeForHighConfidence,
                noiseFilter: {
                  customAllowlist: config.noiseFilterAllowlist,
                  customBlocklist: config.noiseFilterBlocklist,
                },
              },
            })
          : config;

      const jobId = `job-${Date.now()}`;
      const job: JobStatus = {
        status: 'cloning',
        progress: 0,
        currentStep: 'Initializing',
        logs: [],
      };
      jobStore.set(jobId, job);

      const addLog = (msg: string) => {
        job.logs.push(msg);
        logger.info(`[Job ${jobId}] ${msg}`);
      };

      // Fire-and-forget async work
      (async () => {
        try {
          // Step 1 - Clone
          job.status = 'cloning';
          job.progress = 10;
          job.currentStep = 'Cloning repository';
          addLog('Cloning repository...');
          const repoName = extractRepoName(repoUrl);
          const repoPath = config.repoPath(repoName);
          if (!(await fs.pathExists(repoPath))) {
            await fs.ensureDir(path.dirname(repoPath));
            await simpleGit().clone(repoUrl, repoPath, [
              '--depth=1',
              '--single-branch',
            ]);
          }
          addLog('Repository cloned.');

          // Pre-flight check
          if (!(await isDockerAvailable())) {
            throw new Error(
              'Docker daemon is not running. Please start Docker and try again.',
            );
          }

          // Step 2 - Detect services
          job.status = 'detecting';
          job.progress = 20;
          job.currentStep = 'Detecting services';
          addLog('Detecting services...');
          const services = await detectServices(repoPath, config);
          addLog(`Detected ${services.length} service(s).`);

          // Filter to selected services if specified
          const activeServices =
            selectedServices && selectedServices.length > 0
              ? services.filter((s: any) => selectedServices.includes(s.name))
              : services;
          addLog(
            `Using ${activeServices.length} of ${services.length} detected services.`,
          );

          // Build function registries for code location mapping
          let registries: any[] = [];
          try {
            registries = await buildAllRegistries(activeServices, repoPath);
            addLog(
              `Built function registries: ${registries.reduce(
                (s: number, r: any) => s + r.functions.length,
                0,
              )} functions across ${registries.length} services.`,
            );
          } catch (regErr) {
            addLog(
              `Warning: Function registry build failed (non-fatal): ${regErr}`,
            );
          }

          // Generate catalog-info.yaml
          try {
            const catalogYaml = buildCatalogInfo(
              repoName,
              repoUrl,
              activeServices,
              config,
            );
            await fs.writeFile(
              path.join(repoPath, 'catalog-info.yaml'),
              catalogYaml,
            );
            addLog('Generated catalog-info.yaml');
          } catch (catErr) {
            addLog(
              `Warning: Catalog info generation failed (non-fatal): ${catErr}`,
            );
          }

          // Step 3 - Fix Dockerfiles + generate compose
          job.status = 'deploying';
          job.progress = 30;
          job.currentStep = 'Preparing Docker environment';
          addLog('Fixing Dockerfiles and generating compose file...');
          await fixDockerfiles(repoPath, logger);
          const rootComposePath = path.join(repoPath, 'docker-compose.yml');
          const composeFilePath = path.join(
            repoPath,
            'docker-compose.otel.yml',
          );
          // Determine whether an existing docker-compose.otel.yml was generated by FRA
          // (stale — must be regenerated) or shipped by the repo (preserve it).
          const FRA_COMPOSE_MARKER = '# Auto-generated by FRA plugin';
          let existingComposeFraGenerated = false;
          if (await fs.pathExists(composeFilePath)) {
            const existingContent = await fs
              .readFile(composeFilePath, 'utf-8')
              .catch(() => '');
            existingComposeFraGenerated =
              existingContent.includes(FRA_COMPOSE_MARKER);
          }

          if (
            (await fs.pathExists(composeFilePath)) &&
            !existingComposeFraGenerated
          ) {
            // Repo ships its own docker-compose.otel.yml (e.g. polyglot-fra-benchmark).
            // Preserve it — it has correct OTel settings, agent mounts, env vars, etc.
            addLog(
              'Using existing docker-compose.otel.yml from repository (skipping generation).',
            );
          } else {
            let composeContent: string;
            if (await fs.pathExists(rootComposePath)) {
              const rootContent = await fs.readFile(rootComposePath, 'utf-8');
              composeContent = injectOtelIntoComposeContent(
                rootContent,
                repoPath,
              );
            } else {
              composeContent = generateDockerCompose(activeServices);
            }
            // Patch in inter-service env vars from Kubernetes manifests (e.g.
            // SHIPPING_SERVICE_ADDR) that services need to find each other.
            composeContent = await patchComposeWithKubernetesEnv(
              composeContent,
              repoPath,
            );
            await fs.writeFile(
              composeFilePath,
              `${FRA_COMPOSE_MARKER}\n${composeContent}`,
            );
          }
          addLog('Docker compose file ready.');

          // Patch OTEL_INSTRUMENTATION_METHODS_INCLUDE for each Java service to use
          // the service's actual package prefix (e.g. 'auth.*[*]' instead of 'com.*[*]').
          // This is the key step that enables method-level span collection for repos
          // that use non-standard Java namespaces (e.g. train-ticket uses 'auth', 'user',
          // 'travel' as top-level packages — none of which match com/org/io patterns).
          try {
            patchOtelMethodsInclude(composeFilePath, repoPath);
            addLog(
              'Patched OTEL_INSTRUMENTATION_METHODS_INCLUDE for Java services based on detected package prefixes.',
            );
          } catch (patchErr) {
            addLog(
              `Warning: OTel methods include patch failed (non-fatal): ${patchErr}`,
            );
          }

          // Fix common issues in docker-compose.otel.yml that prevent builds:
          // 1. dockerfile case-sensitivity: 'Dockerfile' vs 'dockerfile' on Linux
          // 2. command overrides that reference non-existent files (e.g. otel-server.js)
          // 3. missing Dockerfile for Java/Go services — generate one automatically
          try {
            const composeForFix = yaml.parse(
              await fs.readFile(composeFilePath, 'utf-8'),
            );
            let fixedAny = false;
            const rootHasMavenParent = await fs.pathExists(
              path.join(repoPath, 'pom.xml'),
            );
            const rootHasGradleParent =
              (await fs.pathExists(path.join(repoPath, 'build.gradle'))) ||
              (await fs.pathExists(path.join(repoPath, 'build.gradle.kts')));

            for (const [svcName, svcRaw] of Object.entries(
              composeForFix.services || {},
            )) {
              const svc = svcRaw as any;
              if (!svc?.build?.context) continue;

              const ctxDir = path.resolve(repoPath, svc.build.context);
              const declaredDockerfile = svc.build.dockerfile as
                | string
                | undefined;
              const dockerfileName = declaredDockerfile || 'Dockerfile';
              const fullDockerfilePath = path.join(ctxDir, dockerfileName);

              // ── Fix 1: Dockerfile case sensitivity ────────────────────────
              if (!(await fs.pathExists(fullDockerfilePath))) {
                const lower = path.join(ctxDir, dockerfileName.toLowerCase());
                if (await fs.pathExists(lower)) {
                  svc.build.dockerfile = dockerfileName.toLowerCase();
                  fixedAny = true;
                  continue; // Dockerfile found, nothing more to do for this service
                }

                // ── Fix 2: Generate missing Dockerfile ───────────────────────
                const svcHasMaven = await fs.pathExists(
                  path.join(ctxDir, 'pom.xml'),
                );
                const svcHasGradle =
                  (await fs.pathExists(path.join(ctxDir, 'build.gradle'))) ||
                  (await fs.pathExists(path.join(ctxDir, 'build.gradle.kts')));
                const svcHasGo = await fs.pathExists(
                  path.join(ctxDir, 'go.mod'),
                );
                const svcHasNode = await fs.pathExists(
                  path.join(ctxDir, 'package.json'),
                );

                if (svcHasMaven && rootHasMavenParent) {
                  // Multi-module Maven: build from repo root so parent POM + sibling
                  // modules are on the classpath. Uses `-pl <module> -am` to build only
                  // the target module and its dependencies.
                  const moduleDir = path.relative(repoPath, ctxDir);
                  const generatedDockerfileName = `Dockerfile.fra-${svcName}`;
                  const generatedDockerfilePath = path.join(
                    repoPath,
                    generatedDockerfileName,
                  );
                  await fs.writeFile(
                    generatedDockerfilePath,
                    `# Auto-generated by FRA plugin for multi-module Maven service: ${svcName}
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /workspace
COPY . .
RUN mvn install -pl ${moduleDir} -am -DskipTests --no-transfer-progress --batch-mode

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /workspace/${moduleDir}/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/tmp/otel-agent.jar", "-jar", "app.jar"]
`,
                  );
                  svc.build.context = '.';
                  svc.build.dockerfile = generatedDockerfileName;
                  fixedAny = true;
                  addLog(
                    `Generated Dockerfile for multi-module Maven service: ${svcName} (module: ${moduleDir})`,
                  );
                } else if (svcHasMaven) {
                  // Standalone Maven module
                  await fs.writeFile(
                    path.join(ctxDir, 'Dockerfile'),
                    `# Auto-generated by FRA plugin
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn package -DskipTests --no-transfer-progress --batch-mode

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/tmp/otel-agent.jar", "-jar", "app.jar"]
`,
                  );
                  svc.build.dockerfile = 'Dockerfile';
                  fixedAny = true;
                  addLog(
                    `Generated Dockerfile for standalone Maven service: ${svcName}`,
                  );
                } else if (svcHasGradle && rootHasGradleParent) {
                  // Multi-module Gradle
                  const moduleDir = path.relative(repoPath, ctxDir);
                  const generatedDockerfileName = `Dockerfile.fra-${svcName}`;
                  const generatedDockerfilePath = path.join(
                    repoPath,
                    generatedDockerfileName,
                  );
                  await fs.writeFile(
                    generatedDockerfilePath,
                    `# Auto-generated by FRA plugin for multi-module Gradle service: ${svcName}
FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /workspace
COPY . .
RUN chmod +x gradlew 2>/dev/null; ./gradlew :${svcName}:build -x test --no-daemon 2>/dev/null || gradle :${svcName}:build -x test --no-daemon

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /workspace/${moduleDir}/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/tmp/otel-agent.jar", "-jar", "app.jar"]
`,
                  );
                  svc.build.context = '.';
                  svc.build.dockerfile = generatedDockerfileName;
                  fixedAny = true;
                  addLog(
                    `Generated Dockerfile for multi-module Gradle service: ${svcName}`,
                  );
                } else if (svcHasGradle) {
                  await fs.writeFile(
                    path.join(ctxDir, 'Dockerfile'),
                    `# Auto-generated by FRA plugin
FROM eclipse-temurin:17-jdk-alpine AS build
WORKDIR /app
COPY . .
RUN chmod +x gradlew 2>/dev/null; ./gradlew build -x test --no-daemon 2>/dev/null || gradle build -x test --no-daemon

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/tmp/otel-agent.jar", "-jar", "app.jar"]
`,
                  );
                  svc.build.dockerfile = 'Dockerfile';
                  fixedAny = true;
                  addLog(
                    `Generated Dockerfile for standalone Gradle service: ${svcName}`,
                  );
                } else if (svcHasGo) {
                  await fs.writeFile(
                    path.join(ctxDir, 'Dockerfile'),
                    `# Auto-generated by FRA plugin
FROM golang:1.21-alpine AS build
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go build -o service ./...

FROM alpine:latest
WORKDIR /app
COPY --from=build /app/service .
EXPOSE 8080
CMD ["./service"]
`,
                  );
                  svc.build.dockerfile = 'Dockerfile';
                  fixedAny = true;
                  addLog(`Generated Dockerfile for Go service: ${svcName}`);
                } else if (svcHasNode) {
                  await fs.writeFile(
                    path.join(ctxDir, 'Dockerfile'),
                    `# Auto-generated by FRA plugin
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
`,
                  );
                  svc.build.dockerfile = 'Dockerfile';
                  fixedAny = true;
                  addLog(
                    `Generated Dockerfile for Node.js service: ${svcName}`,
                  );
                } else {
                  // No build system detected — remove the build stanza so Docker doesn't fail.
                  // The service will be skipped (no image = no container).
                  delete svc.build;
                  fixedAny = true;
                  addLog(
                    `Warning: No Dockerfile or known build system found for ${svcName} — removing from compose.`,
                  );
                }
              }

              // ── Fix 4: Existing Dockerfile calls `mvn` but base image has no Maven ──
              // e.g. `FROM eclipse-temurin:17-jdk-alpine` + `RUN mvn package` → exit 127
              // Fix: replace the build-stage FROM with `maven:3.9-eclipse-temurin-17`
              // which ships both Maven and a compatible JDK.
              // Not applied when the Dockerfile uses the Maven wrapper (./mvnw) since
              // the wrapper downloads Maven itself.
              if (svc?.build?.context) {
                const resolvedCtx2 = path.resolve(repoPath, svc.build.context);
                const dfName2 =
                  (svc.build.dockerfile as string | undefined) || 'Dockerfile';
                const dfPath2 = path.join(resolvedCtx2, dfName2);
                if (await fs.pathExists(dfPath2)) {
                  const dfContent = await fs.readFile(dfPath2, 'utf-8');
                  const callsMvn = /^\s*RUN\s+mvn\b/m.test(dfContent);
                  const usesMvnWrapper = /^\s*RUN\s+\.\/mvnw\b/m.test(
                    dfContent,
                  );
                  const alreadyMavenImage = /^FROM\s+maven:/im.test(dfContent);
                  if (callsMvn && !usesMvnWrapper && !alreadyMavenImage) {
                    // Replace JDK-only build-stage image with Maven image
                    const patched = dfContent.replace(
                      /^(FROM\s+)(eclipse-temurin:[^\s]+|openjdk:[^\s]+)(\s+AS\s+build\b.*)?$/im,
                      (_match, _from, _img, asClause) =>
                        `FROM maven:3.9-eclipse-temurin-17${asClause || ''}`,
                    );
                    if (patched !== dfContent) {
                      await fs.writeFile(dfPath2, patched);
                      fixedAny = true;
                      addLog(
                        `Patched ${dfName2} for ${svcName}: replaced JDK-only build image with maven:3.9-eclipse-temurin-17`,
                      );
                    }
                  }
                }
              }

              // ── Fix 3: Invalid command overrides ─────────────────────────
              if (svc.command && svc?.build?.context) {
                const resolvedCtx = path.resolve(repoPath, svc.build.context);
                const cmdParts: string[] = Array.isArray(svc.command)
                  ? svc.command
                  : String(svc.command).split(/\s+/);
                const scriptArg = cmdParts.find(
                  p =>
                    p.endsWith('.js') || p.endsWith('.py') || p.endsWith('.sh'),
                );
                if (scriptArg) {
                  const scriptPath = path.join(resolvedCtx, scriptArg);
                  if (!(await fs.pathExists(scriptPath))) {
                    delete svc.command;
                    fixedAny = true;
                  }
                }
              }
            }

            if (fixedAny) {
              await fs.writeFile(
                composeFilePath,
                yaml.stringify(composeForFix),
              );
              addLog('docker-compose.otel.yml pre-flight fixes applied.');
            }
          } catch (fixErr) {
            addLog(`Warning: compose pre-flight fix failed: ${fixErr}`);
          }

          // Step 4 - Tear down any previously running containers, then compose up
          job.progress = 50;
          job.currentStep = 'Starting containers';

          // Stop all running containers so ports are freed up for the new stack.
          // We intentionally only STOP (not remove) to preserve container state/logs.
          // Named containers that would conflict are removed specifically below.
          addLog('Stopping all running Docker containers...');
          await new Promise<void>(resolve => {
            const list = spawn('docker', ['ps', '-q'], { shell: true });
            let ids = '';
            list.stdout?.on('data', (d: Buffer) => {
              ids += d.toString();
            });
            list.on('close', () => {
              const runningIds = ids
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean);
              if (runningIds.length === 0) {
                resolve();
                return;
              }
              const stop = spawn('docker', ['stop', ...runningIds], {
                shell: true,
                timeout: 60000,
              });
              stop.on('close', () => resolve());
            });
          });

          // Remove ONLY named containers from our compose file so `docker compose up`
          // can recreate them without "container name already in use" conflicts.
          // All other stopped containers are left untouched.
          try {
            const composeForNames = yaml.parse(
              await fs.readFile(composeFilePath, 'utf-8'),
            );
            const namedContainers: string[] = Object.values(
              composeForNames.services || {},
            )
              .map((s: any) => s.container_name)
              .filter(Boolean);
            if (namedContainers.length > 0) {
              await new Promise<void>(resolve => {
                const rm = spawn('docker', ['rm', '-f', ...namedContainers], {
                  shell: true,
                  timeout: 30000,
                });
                rm.on('close', () => resolve());
              });
            }
          } catch {
            /* best-effort */
          }

          // Bring down compose-managed stacks to clean up Docker networks
          if (await fs.pathExists(composeFilePath)) {
            await new Promise<void>(resolve => {
              const down = spawn(
                'docker compose',
                ['-f', 'docker-compose.otel.yml', 'down', '--remove-orphans'],
                { cwd: repoPath, shell: true, timeout: 60000 },
              );
              down.on('close', () => resolve());
            });
          }
          if (await fs.pathExists(rootComposePath)) {
            await new Promise<void>(resolve => {
              const down = spawn(
                'docker compose',
                ['-f', 'docker-compose.yml', 'down', '--remove-orphans'],
                { cwd: repoPath, shell: true, timeout: 60000 },
              );
              down.on('close', () => resolve());
            });
          }
          addLog('Container cleanup complete.');

          try {
            const agentDir = path.dirname(OTEL_AGENT_HOST_PATH);
            await fs.ensureDir(agentDir);
            if (!(await fs.pathExists(OTEL_AGENT_HOST_PATH))) {
              addLog(
                `Downloading OTel Java agent to ${OTEL_AGENT_HOST_PATH}...`,
              );
              await new Promise<void>(resolve => {
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
                  if (code === 0)
                    addLog('OTel Java agent downloaded successfully.');
                  else
                    addLog(
                      'Warning: OTel Java agent download failed — Java tracing may not work.',
                    );
                  resolve();
                });
                dl.on('error', () => resolve());
              });
            } else {
              addLog(
                `OTel Java agent already cached at ${OTEL_AGENT_HOST_PATH}`,
              );
            }
          } catch {
            addLog(
              'Warning: Could not ensure OTel Java agent — Java tracing may not work.',
            );
          }

          addLog('Starting docker compose...');
          try {
            await new Promise<void>((resolve, reject) => {
              const dockerUp = spawn(
                'docker compose',
                [
                  '-f',
                  'docker-compose.otel.yml',
                  'up',
                  '-d',
                  '--build',
                  '--remove-orphans',
                ],
                { cwd: repoPath, shell: true, timeout: 300000 },
              );
              let stderr = '';
              // Stream stderr line-by-line to the job log so build errors are visible
              dockerUp.stderr?.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed) {
                    stderr += `${trimmed}\n`;
                    // Only forward lines that look like errors or warnings (skip progress bars)
                    if (
                      /error|failed|warning|warn|fatal/i.test(trimmed) &&
                      !/^\s*#/.test(trimmed)
                    ) {
                      addLog(`[compose] ${trimmed}`);
                    }
                  }
                }
              });
              dockerUp.stdout?.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (
                    trimmed &&
                    /started|created|built|pulling|pulled/i.test(trimmed)
                  ) {
                    addLog(`[compose] ${trimmed}`);
                  }
                }
              });
              dockerUp.on('close', code => {
                if (code !== 0)
                  reject(
                    new Error(
                      `docker compose up failed (exit ${code}): ${stderr.slice(
                        -2000,
                      )}`,
                    ),
                  );
                else resolve();
              });
            });
            addLog('docker compose up completed.');
            // Log which containers are actually running
            await new Promise<void>(resolve => {
              const ps = spawn(
                'docker',
                [
                  'compose',
                  '-f',
                  'docker-compose.otel.yml',
                  'ps',
                  '--format',
                  'table {{.Name}}\t{{.Status}}\t{{.Ports}}',
                ],
                { cwd: repoPath, shell: true },
              );
              let psOut = '';
              ps.stdout?.on('data', (d: Buffer) => {
                psOut += d.toString();
              });
              ps.on('close', () => {
                if (psOut.trim())
                  addLog(`Running containers:\n${psOut.trim()}`);
                resolve();
              });
            });
          } catch (composeErr) {
            addLog(
              `Full compose up failed: ${
                composeErr instanceof Error
                  ? composeErr.message
                  : String(composeErr)
              }`,
            );
            addLog('Attempting per-service recovery...');
            try {
              await buildServicesWithRecovery(
                repoPath,
                'docker-compose.otel.yml',
                logger,
              );
              addLog('Per-service recovery completed.');
            } catch (recoveryErr) {
              addLog(
                `Warning: Per-service recovery also had issues: ${recoveryErr}`,
              );
            }
          }

          // Step 5 - Wait for services + health checks
          job.progress = 60;
          job.currentStep = 'Waiting for services to start';
          addLog('Waiting 15s for services to initialize...');
          await new Promise(r => setTimeout(r, 15000));

          // Verify Jaeger is accessible before proceeding.
          {
            const jaegerHealthUrl = `${config.jaegerBaseUrl}/services`;
            let jaegerReady = false;
            for (let attempt = 1; attempt <= 6 && !jaegerReady; attempt++) {
              try {
                const probe = await fetch(jaegerHealthUrl, {
                  timeout: 5000,
                } as any);
                if (probe.ok) {
                  jaegerReady = true;
                  break;
                }
              } catch {
                // not yet
              }
              if (!jaegerReady && attempt < 6) {
                addLog(
                  `Jaeger not ready yet (attempt ${attempt}/6), retrying in 5s...`,
                );
                await new Promise(r => setTimeout(r, 5000));
              }
            }
            if (jaegerReady) {
              addLog('Jaeger is healthy and responding.');
            } else {
              addLog(
                'Warning: Jaeger did not respond after retries. Analysis may return no results.',
              );
            }
          }

          // Wait for all application services to be health-ready before generating traffic.
          // This is critical for slow-starting services like Spring Boot with the OTel Java
          // agent — if traffic starts before the service is ready, internal generators crash
          // (ECONNREFUSED) and take the whole traffic-generation chain down.
          {
            const composeForHealth = yaml.parse(
              await fs.readFile(composeFilePath, 'utf-8'),
            );
            const HEALTH_SKIP = [
              'jaeger',
              'zipkin',
              'prometheus',
              'grafana',
              'otel-collector',
              'opentelemetry-collector',
              'mongo',
              'redis',
              'postgres',
              'mysql',
              'kafka',
              'rabbitmq',
              'zookeeper',
            ];
            // Probe ports only — any HTTP response (even 404) means the server is up.
            // We try several common health paths but accept ANY status code as "ready"
            // because many services don't implement /health at all.
            const HEALTH_PATHS = [
              '/health',
              '/healthz',
              '/actuator/health',
              '/ping',
              '/status',
              '/',
            ];
            const svcPorts: Array<{ name: string; port: string }> = [];
            for (const [svcName, svcRaw] of Object.entries(
              composeForHealth.services || {},
            )) {
              const svc = svcRaw as any;
              const imgLower = (svc.image || '').toLowerCase();
              if (
                HEALTH_SKIP.some(
                  p =>
                    svcName.toLowerCase().includes(p) || imgLower.includes(p),
                )
              )
                continue;
              if (Array.isArray(svc.ports) && svc.ports.length > 0) {
                const hostPort = String(svc.ports[0]).split(':')[0];
                svcPorts.push({ name: svcName, port: hostPort });
              }
            }

            /** Returns true if ANY HTTP request to the port gets a response (any status). */
            const isPortResponding = async (port: string): Promise<boolean> => {
              for (const p of HEALTH_PATHS) {
                try {
                  await fetch(`http://localhost:${port}${p}`, {
                    timeout: 3000,
                  } as any);
                  return true; // got any HTTP response → server is up
                } catch (e: any) {
                  // ECONNREFUSED / ECONNRESET / timeout → server not up yet; try next path
                  if (e?.code === 'ECONNREFUSED') break; // no point trying other paths on same port
                }
              }
              return false;
            };

            if (svcPorts.length > 0) {
              addLog(
                `Waiting for ${svcPorts.length} application service(s) to be ready...`,
              );
              // Up to 90s total: check every 5s
              for (let attempt = 1; attempt <= 18; attempt++) {
                const results = await Promise.all(
                  svcPorts.map(async ({ name, port }) => ({
                    name,
                    ok: await isPortResponding(port),
                  })),
                );
                const notReady = results.filter(r => !r.ok).map(r => r.name);
                if (notReady.length === 0) {
                  addLog('All application services are healthy and ready.');
                  break;
                }
                if (attempt < 18) {
                  addLog(
                    `Services not ready yet (${notReady.join(
                      ', ',
                    )}), retrying in 5s... (${attempt}/18)`,
                  );
                  await new Promise(r => setTimeout(r, 5000));
                } else {
                  addLog(
                    `Warning: Some services did not become healthy after 90s: ${notReady.join(
                      ', ',
                    )}. Proceeding anyway.`,
                  );
                }
              }
            }
          }

          // Step 6 - Generate traffic
          job.status = 'tracing';
          job.progress = 70;
          job.currentStep = 'Generating traffic';
          addLog('Generating traffic...');
          const serviceUrls: string[] = [];
          const composeContent = await fs.readFile(composeFilePath, 'utf-8');
          const composeData = yaml.parse(composeContent);

          // Infrastructure image patterns that should NOT be probed for HTTP traffic
          const INFRA_TRAFFIC_SKIP = [
            'jaeger',
            'zipkin',
            'openzipkin',
            'prometheus',
            'grafana',
            'otel/opentelemetry-collector',
            'opentelemetry-collector',
            'mongo',
            'redis',
            'postgres',
            'mysql',
            'kafka',
            'rabbitmq',
          ];
          for (const [svcName, svcRaw] of Object.entries(
            composeData.services || {},
          )) {
            const svc = svcRaw as any;
            const imgLower = (svc.image || '').toLowerCase();
            if (
              INFRA_TRAFFIC_SKIP.some(
                p => svcName.toLowerCase().includes(p) || imgLower.includes(p),
              )
            )
              continue;
            if (Array.isArray(svc.ports) && svc.ports.length > 0) {
              const hostPort = String(svc.ports[0]).split(':')[0];
              serviceUrls.push(`http://localhost:${hostPort}`);
            }
          }
          if (serviceUrls.length === 0) {
            addLog(
              'Warning: No service URLs discovered from compose ports. Will attempt fallback probing.',
            );
          }
          const trafficCount = await generateTrafficForRepo(
            repoPath,
            serviceUrls,
            logger,
            'docker-compose.otel.yml',
          );
          addLog(
            `Traffic generation complete: ${trafficCount} successful requests.`,
          );
          if (trafficCount === 0) {
            addLog(
              'Warning: Zero traffic generated. Analysis may have limited data.',
            );
          }

          // Step 7 - Wait for traces to flush
          job.progress = 80;
          job.currentStep = 'Waiting for traces to flush';
          addLog('Waiting 10s for traces to flush...');
          await new Promise(r => setTimeout(r, 10000));

          // Step 8 - Run FraPipeline
          job.status = 'analyzing';
          job.progress = 90;
          job.currentStep = 'Analyzing traces';
          addLog('Running FraPipeline analysis...');
          const registry = ProviderRegistry.fromConfig(jobConfig);
          const pipeline = new FraPipeline(registry, jobConfig, logger);
          const lookback = lookbackHours || 2;
          const totalRegistryFunctions = registries.reduce(
            (s: number, r: any) => s + r.functions.length,
            0,
          );
          addLog(
            `[checkpoint-1] Registry: ${registries.length} services, ${totalRegistryFunctions} functions total.`,
          );
          let results: import('../lib/types').RelocationResult[];
          try {
            results = await pipeline.analyze(
              {
                service: 'all',
                lookbackHours: lookback,
                maxTraces: jobConfig.maxTracesPerService,
              },
              registries,
            );

            addLog(
              `[checkpoint-2] Real trace analysis returned ${results.length} results.`,
            );

            // augmentWithStaticCoverage always fills results with every registry
            // function at sampleCount=0 when Jaeger has no microservice spans.
            // results.length is therefore never 0 — checking it is wrong.
            // Instead check whether ANY function has real trace observations.
            const hasRealTraceData = results.some(
              (r: any) => r.sampleCount > 0,
            );
            addLog(
              `[checkpoint-2b] hasRealTraceData=${hasRealTraceData} (${
                results.filter((r: any) => r.sampleCount > 0).length
              } functions with observations).`,
            );

            if (!hasRealTraceData && totalRegistryFunctions > 0) {
              throw new Error(
                'No microservice traces found — all functions have 0 observations (Jaeger has only infra spans).',
              );
            }
          } catch (pipelineErr) {
            // Live tracing backend unreachable or empty — fall back to synthetic trace analysis.
            // SyntheticTraceProvider generates realistic call patterns from the static
            // function registry so the relocation engine can still produce useful results.
            addLog(
              `[checkpoint-3] Trace analysis failed or empty: ${
                pipelineErr instanceof Error
                  ? pipelineErr.message
                  : String(pipelineErr)
              }`,
            );
            addLog('Falling back to synthetic trace analysis...');
            try {
              addLog(
                `[checkpoint-4] Generating synthetic traces for ${totalRegistryFunctions} functions across ${registries.length} services.`,
              );
              const syntheticRegistry = ProviderRegistry.fromConfig(jobConfig);
              syntheticRegistry.registerTraceSource(
                new SyntheticTraceProvider(registries),
              );
              const syntheticPipeline = new FraPipeline(
                syntheticRegistry,
                jobConfig,
                logger,
              );
              results = await syntheticPipeline.analyze(
                {
                  service: 'all',
                  lookbackHours: 1,
                  maxTraces: jobConfig.maxTracesPerService,
                },
                registries,
              );
              addLog(
                `[checkpoint-5] Synthetic analysis complete: ${results.length} recommendations.`,
              );
              job.result = {
                services,
                results,
                repoName,
                repoUrl,
                tracingAvailable: false,
                syntheticTraces: true,
              };
              job.status = 'done';
              job.progress = 100;
              job.currentStep =
                'Complete (synthetic trace analysis — no live backend)';
              addLog(
                `Full analysis complete using synthetic traces (${results.length} recommendations).`,
              );
            } catch (syntheticErr) {
              // Last-resort: zero-call static-only output
              addLog(
                `[checkpoint-6] Synthetic analysis failed: ${
                  syntheticErr instanceof Error
                    ? syntheticErr.message
                    : String(syntheticErr)
                }. Returning static-only results.`,
              );
              const zeroAnalysis = registries.flatMap((reg: any) =>
                reg.functions.map((fn: any) => ({
                  functionName: fn.name,
                  currentService: reg.service,
                  internalCalls: 0,
                  externalCalls: 0,
                  dominantCaller: 'none',
                  dominantPercent: 0,
                  avgInternalLatency: 0,
                  avgExternalLatency: 0,
                  p95InternalLatency: 0,
                  p95ExternalLatency: 0,
                  p99InternalLatency: 0,
                  p99ExternalLatency: 0,
                  sampleCount: 0,
                  callerServices: {},
                  patternStability: 1.0,
                  staticCoverage: 'covered' as const,
                })),
              );
              const zeroDecisions = applyDecisionLogic(zeroAnalysis, jobConfig);
              results = enrichWithCodeLocations(zeroDecisions, registries);
              job.result = {
                services,
                results,
                repoName,
                repoUrl,
                tracingAvailable: false,
              };
              job.status = 'done';
              job.progress = 100;
              job.currentStep = 'Complete (static analysis only — no traces)';
              addLog('Full analysis complete (static analysis only).');
            }
            return;
          }
          job.result = {
            services,
            results,
            repoName,
            repoUrl,
            tracingAvailable: true,
          };

          // Done
          job.status = 'done';
          job.progress = 100;
          job.currentStep = 'Complete';
          addLog('Full analysis complete.');
        } catch (err) {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          job.currentStep = 'Error';
          addLog(`Error: ${job.error}`);
        }
      })();

      return res.status(202).json({ jobId });
    } catch (error) {
      logger.error(`Error starting full analysis: ${error}`);
      return res.status(500).json({
        error: 'Failed to start full analysis',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /fra/job/:jobId/status - poll the status of an async analysis job
  router.get('/fra/job/:jobId/status', (req, res) => {
    const { jobId } = req.params;
    const job = jobStore.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  });

  return router;
}

// Keep deprecated helpers for any external callers (thin re-exports to modules)
export { extractRepoName } from '../modules/ingestion/RepositoryIngestor';
export { ingestRepository } from '../modules/ingestion/RepositoryIngestor';
