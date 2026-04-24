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
import {
  ServiceInventoryProvider,
  DiscoveredService,
} from '../../lib/providers';
import {
  detectLanguage,
  detectEntrypoint,
  SupportedLanguage,
} from '../language/LanguageDetector';

/** Names that indicate a shared library / infra module, not a runnable service. */
const LIB_PATTERNS = [
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
  // API-spec / contract directories — not runnable services
  'openapi',
  'swagger',
  'proto',
  'protos',
  'grpc',
  'graphql',
  'schema',
  'schemas',
  // Example / tutorial / analysis directories — not deployable microservices
  'quickstart',
  'sample',
  'samples',
  'example',
  'examples',
  'tutorial',
  'analysis',
  'benchmark',
  'scripts',
  'tools',
  'docs',
  'documentation',
];

function isSharedLibOrInfra(name: string, infraPatterns: string[]): boolean {
  const lower = name.toLowerCase();
  if (infraPatterns.some(p => lower.includes(p))) return true;
  return LIB_PATTERNS.some(
    p => lower === p || lower.endsWith(`-${p}`) || lower.startsWith(`${p}-`),
  );
}

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

/**
 * Discovers services by scanning the repo filesystem.
 *
 * Three scan phases:
 * 1. Depth-1: directories at repo root with language markers
 * 2. Depth-2: Maven/Gradle multi-module subdirectories
 * 3. src/ layout: services under top-level src/ directory
 *
 * Extracted from ServiceDiscoveryEngine.ts Phases 1-3.
 */
export class MonorepoInventoryProvider implements ServiceInventoryProvider {
  readonly type = 'monorepo';

  constructor(private readonly infraPatterns: string[] = []) {}

  async discoverServices(repoPath: string): Promise<DiscoveredService[]> {
    let portCounter = 8080;
    const allServices = new Map<string, DiscoveredService>();

    let rootEntries: fs.Dirent[] = [];
    try {
      rootEntries = await fs.readdir(repoPath, { withFileTypes: true });
    } catch {
      return [];
    }

    // ── Phase 1: depth-1 directory scan ─────────────────────────────────
    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (isSharedLibOrInfra(entry.name, this.infraPatterns)) continue;

      const servicePath = path.join(repoPath, entry.name);
      const language = await detectLanguage(servicePath);

      if (language) {
        const dockerfile = await findDockerfile(servicePath);
        const entrypoint = await detectEntrypoint(servicePath, language);

        allServices.set(entry.name, {
          name: entry.name,
          language,
          path: entry.name,
          port: portCounter++,
          hasDockerfile: dockerfile.found,
          dockerfileName: dockerfile.name,
          entrypoint,
        });
      }
    }

    // ── Phase 2: depth-2 for Maven/Gradle multi-module ──────────────────
    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (isSharedLibOrInfra(entry.name, this.infraPatterns)) continue;

      const depth1Path = path.join(repoPath, entry.name);

      const isJavaMultiModule =
        (await fs.pathExists(path.join(depth1Path, 'pom.xml'))) ||
        (await fs.pathExists(path.join(depth1Path, 'settings.gradle'))) ||
        (await fs.pathExists(path.join(depth1Path, 'settings.gradle.kts')));

      if (!isJavaMultiModule) continue;

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
        if (isSharedLibOrInfra(subEntry.name, this.infraPatterns)) continue;

        const subPath = path.join(depth1Path, subEntry.name);
        const language = await detectLanguage(subPath);
        if (!language) continue;

        const relPath = path.join(entry.name, subEntry.name);
        if (allServices.has(relPath)) continue;

        const dockerfile = await findDockerfile(subPath);
        const entrypoint = await detectEntrypoint(
          subPath,
          language as SupportedLanguage,
        );

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

    // ── Phase 3: src/ layout scan ───────────────────────────────────────
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
        if (isSharedLibOrInfra(entry.name, this.infraPatterns)) continue;

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

    return Array.from(allServices.values());
  }
}
