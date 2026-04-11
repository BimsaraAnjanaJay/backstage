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

import * as fs from 'fs-extra';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  detectLanguage,
  detectEntrypoint,
  SupportedLanguage,
} from '../language/LanguageDetector';
import { FraConfig } from '../config/FraConfig';

export interface DiscoveredService {
  name: string;
  language: SupportedLanguage | string;
  /** Relative path from repoRoot */
  path: string;
  port: number;
  hasDockerfile: boolean;
  /** Actual Dockerfile filename as found on disk */
  dockerfileName: string;
  entrypoint?: string;
  /** True when the service was extracted from a docker-compose file */
  fromCompose?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function findDockerfile(
  dir: string,
): Promise<{ found: boolean; name: string }> {
  for (const name of [
    'Dockerfile',
    'dockerfile',
    'DockerFile',
    'Dockerfile.dev',
  ]) {
    if (await fs.pathExists(path.join(dir, name))) {
      return { found: true, name };
    }
  }
  return { found: false, name: 'Dockerfile' };
}

/** Whether an entry name looks like a shared library / infra module (not a runnable service). */
function isSharedLibOrInfra(name: string, infraPatterns: string[]): boolean {
  const lower = name.toLowerCase();
  if (infraPatterns.some(p => lower.includes(p))) return true;
  // Maven module names that are shared libs, not deployable services
  const libPatterns = [
    'common',
    'commons',
    'shared',
    'lib',
    'core',
    'api',
    'model',
    'domain',
    'util',
    'utils',
    'dto',
    'mbg',
    'generator',
  ];
  return libPatterns.some(
    p => lower === p || lower.endsWith(`-${p}`) || lower.startsWith(`${p}-`),
  );
}

/**
 * Parses an existing docker-compose file and extracts services that have a
 * build context, so we don't miss services in monorepos that don't have their
 * own package.json/pom.xml at depth 1.
 *
 * Returns an array of DiscoveredService (language = 'unknown' when not detectable
 * from the compose file alone).
 */
async function extractServicesFromCompose(
  composePath: string,
  repoRoot: string,
  infraPatterns: string[],
  portStart: number,
): Promise<DiscoveredService[]> {
  const results: DiscoveredService[] = [];
  let composeData: any;
  try {
    const raw = await fs.readFile(composePath, 'utf-8');
    composeData = yaml.parse(raw);
  } catch {
    return results;
  }

  if (!composeData?.services) return results;

  const INFRA_IMAGE_KEYWORDS = [
    'jaeger',
    'zipkin',
    'prometheus',
    'grafana',
    'mongo',
    'redis',
    'postgres',
    'mysql',
    'mariadb',
    'rabbitmq',
    'kafka',
    'zookeeper',
    'elasticsearch',
    'kibana',
    'nginx',
    'traefik',
    'otel-collector',
    'opentelemetry-collector',
  ];

  for (const [svcName, svcRaw] of Object.entries(composeData.services)) {
    const svc = svcRaw as any;

    // Skip infra images
    if (INFRA_IMAGE_KEYWORDS.some(k => svc.image?.toLowerCase().includes(k)))
      continue;
    if (infraPatterns.some(p => svcName.toLowerCase().includes(p))) continue;

    // Only include services with a build context (i.e., built from source)
    if (!svc.build) continue;

    const buildContext =
      typeof svc.build === 'string' ? svc.build : svc.build?.context || '.';
    const contextAbs = path.resolve(path.dirname(composePath), buildContext);
    const contextRel = path.relative(repoRoot, contextAbs);

    // Detect language in build context
    let language: SupportedLanguage | string = 'unknown';
    try {
      language = (await detectLanguage(contextAbs)) || 'unknown';
    } catch {
      // best-effort
    }

    const dockerfile = await findDockerfile(contextAbs);
    let entrypoint: string | undefined;
    if (language !== 'unknown') {
      entrypoint = await detectEntrypoint(
        contextAbs,
        language as SupportedLanguage,
      );
    }

    // Extract host port from ports mapping
    let port = portStart + results.length;
    if (Array.isArray(svc.ports) && svc.ports.length > 0) {
      const portStr = String(svc.ports[0]).split(':')[0];
      const parsed = parseInt(portStr, 10);
      if (!isNaN(parsed)) port = parsed;
    }

    results.push({
      name: svcName,
      language,
      path: contextRel || svcName,
      port,
      hasDockerfile: dockerfile.found,
      dockerfileName: dockerfile.name,
      entrypoint,
      fromCompose: true,
    });
  }

  return results;
}

/**
 * Discovers microservices within a repository root directory.
 *
 * Strategy (in priority order):
 *
 * 1. **Depth-1 scan**: Directories at repo root that contain language markers
 *    (package.json, pom.xml, etc.).  Infra services are filtered out.
 *
 * 2. **Depth-2 scan for Maven/Gradle multi-module**: When a depth-1 directory
 *    has a parent `pom.xml` or `settings.gradle` but NO independent build file,
 *    scan its subdirectories for individual module services.
 *    This handles `spring-petclinic-microservices`, `mall-swarm`, etc.
 *
 * 3. **src/ layout scan**: When services live under a top-level `src/`
 *    directory (e.g. Google Online Boutique), scan `src/<service>/`.
 *
 * 4. **Compose-defined services**: Parse the root `docker-compose.yml` (or
 *    `.yaml`, including `docker-compose.otel.yml`) and extract services that
 *    have a `build:` context. This catches monorepos where services share a
 *    single Dockerfile (lightweight-otel-demo) and overrides port numbers.
 *
 * 5. **Deduplication**: Services discovered from compose always win over
 *    directory scan for the same path (compose has correct port mappings).
 */
export async function detectServices(
  repoPath: string,
  config: FraConfig = new FraConfig(),
): Promise<DiscoveredService[]> {
  const infraPatterns = config.infraServicePatterns;
  let portCounter = 8080;

  const allServices = new Map<string, DiscoveredService>(); // keyed by relative path

  // ── Phase 1: depth-1 directory scan ─────────────────────────────────────
  let rootEntries: fs.Dirent[] = [];
  try {
    rootEntries = await fs.readdir(repoPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (isSharedLibOrInfra(entry.name, infraPatterns)) continue;

    const servicePath = path.join(repoPath, entry.name);
    const language = await detectLanguage(servicePath);

    if (language) {
      const dockerfile = await findDockerfile(servicePath);
      const entrypoint = await detectEntrypoint(servicePath, language);

      const svc: DiscoveredService = {
        name: entry.name,
        language,
        path: entry.name,
        port: portCounter++,
        hasDockerfile: dockerfile.found,
        dockerfileName: dockerfile.name,
        entrypoint,
      };
      allServices.set(entry.name, svc);
    }
  }

  // ── Phase 2: depth-2 scan for Maven/Gradle multi-module repos ───────────
  // A depth-1 directory is a "multi-module parent" when it contains pom.xml
  // (or settings.gradle) BUT does NOT itself define a runnable service (no src/main
  // with Java files, no own package.json entrypoint, etc.).
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (isSharedLibOrInfra(entry.name, infraPatterns)) continue;

    const depth1Path = path.join(repoPath, entry.name);

    // Detect multi-module Java root: has pom.xml or settings.gradle at this level
    const isJavaMultiModule =
      (await fs.pathExists(path.join(depth1Path, 'pom.xml'))) ||
      (await fs.pathExists(path.join(depth1Path, 'settings.gradle'))) ||
      (await fs.pathExists(path.join(depth1Path, 'settings.gradle.kts')));

    if (!isJavaMultiModule) continue;

    // Already fully detected as a standalone service at depth-1 — skip
    const existingAtDepth1 = allServices.get(entry.name);
    if (existingAtDepth1 && existingAtDepth1.hasDockerfile) continue;

    let depth2Entries: fs.Dirent[] = [];
    try {
      depth2Entries = await fs.readdir(depth1Path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const subEntry of depth2Entries) {
      if (!subEntry.isDirectory() || subEntry.name.startsWith('.')) continue;
      if (isSharedLibOrInfra(subEntry.name, infraPatterns)) continue;

      const subPath = path.join(depth1Path, subEntry.name);
      const language = await detectLanguage(subPath);
      if (!language) continue;

      const relPath = path.join(entry.name, subEntry.name);
      if (allServices.has(relPath)) continue; // already discovered

      const dockerfile = await findDockerfile(subPath);
      const entrypoint = await detectEntrypoint(subPath, language);

      allServices.set(relPath, {
        name: subEntry.name,
        language,
        path: relPath,
        port: portCounter++,
        hasDockerfile: dockerfile.found,
        dockerfileName: dockerfile.name,
        entrypoint,
      });
    }
  }

  // ── Phase 3: scan common monorepo "src/" layout ─────────────────────────
  // Repos like Google Online Boutique put all services under src/.
  // If src/ exists and is not already captured, scan it at depth-1.
  const srcDir = path.join(repoPath, 'src');
  if (await fs.pathExists(srcDir)) {
    let srcEntries: fs.Dirent[] = [];
    try {
      srcEntries = await fs.readdir(srcDir, { withFileTypes: true });
    } catch {
      /* ignore */
    }

    for (const entry of srcEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (isSharedLibOrInfra(entry.name, infraPatterns)) continue;

      const subPath = path.join(srcDir, entry.name);
      const relPath = path.join('src', entry.name);
      if (allServices.has(relPath) || allServices.has(entry.name)) continue;

      const language = await detectLanguage(subPath);
      if (!language) continue;

      const dockerfile = await findDockerfile(subPath);
      const entrypoint = await detectEntrypoint(subPath, language);

      allServices.set(relPath, {
        name: entry.name,
        language,
        path: relPath,
        port: portCounter++,
        hasDockerfile: dockerfile.found,
        dockerfileName: dockerfile.name,
        entrypoint,
      });
    }
  }

  // ── Phase 4: Compose-defined services ────────────────────────────────────
  // Find the root docker-compose file (supports both .yml and .yaml extensions,
  // otel variant, and common subdirectory locations).
  const composeCandidates = [
    path.join(repoPath, 'docker-compose.otel.yml'),
    path.join(repoPath, 'docker-compose.otel.yaml'),
    path.join(repoPath, 'docker-compose.yml'),
    path.join(repoPath, 'docker-compose.yaml'),
    path.join(repoPath, 'docker', 'docker-compose.yml'),
    path.join(repoPath, 'docker', 'docker-compose.yaml'),
    path.join(repoPath, 'deploy', 'docker-compose.yml'),
    path.join(repoPath, 'deploy', 'docker-compose.yaml'),
  ];

  for (const composePath of composeCandidates) {
    if (!(await fs.pathExists(composePath))) continue;

    const composeServices = await extractServicesFromCompose(
      composePath,
      repoPath,
      infraPatterns,
      portCounter,
    );

    for (const svc of composeServices) {
      // Compose service wins over directory scan (has correct ports)
      if (!allServices.has(svc.path)) {
        allServices.set(svc.path, svc);
        portCounter = Math.max(portCounter, svc.port + 1);
      }
    }
    break; // only use the first compose file found
  }

  return Array.from(allServices.values());
}
