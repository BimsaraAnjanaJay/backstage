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
  /** Actual Dockerfile filename as found on disk (e.g. 'Dockerfile' or 'dockerfile') */
  dockerfileName: string;
  entrypoint?: string;
}

/**
 * Discovers microservices within a repository root directory.
 *
 * Phase 1: Replicates the original depth-1 scan from router.ts `detectServices()`.
 * Infra services (jaeger, redis, mongo …) are filtered using FraConfig.infraServicePatterns.
 * Port allocation starts at 8080 (sequential), matching original behaviour.
 *
 * Phase 2 will add:
 *   - Monorepo config readers (nx.json, lerna.json, pnpm-workspace.yaml)
 *   - Multi-signal confidence scoring
 *   - Shared-library detection
 *   - Docker-Compose and K8s manifest parsing
 */
export async function detectServices(
  repoPath: string,
  config: FraConfig = new FraConfig(),
): Promise<DiscoveredService[]> {
  const services: DiscoveredService[] = [];
  let entries: fs.Dirent[];

  try {
    entries = await fs.readdir(repoPath, { withFileTypes: true });
  } catch {
    return services;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    // Skip known infra services
    const lowerName = entry.name.toLowerCase();
    if (
      config.infraServicePatterns.some(pattern => lowerName.includes(pattern))
    ) {
      continue;
    }

    const servicePath = path.join(repoPath, entry.name);
    const language = await detectLanguage(servicePath);

    if (language) {
      // Detect the actual Dockerfile name — some repos use lowercase 'dockerfile'
      const dockerfileNames = ['Dockerfile', 'dockerfile', 'DockerFile'];
      let dockerfileName = 'Dockerfile';
      let hasDockerfile = false;
      for (const name of dockerfileNames) {
        if (await fs.pathExists(path.join(servicePath, name))) {
          dockerfileName = name;
          hasDockerfile = true;
          break;
        }
      }

      const entrypoint = await detectEntrypoint(servicePath, language);

      services.push({
        name: entry.name,
        language,
        path: entry.name,
        port: 8080 + services.length,
        hasDockerfile,
        dockerfileName,
        entrypoint,
      });
    }
  }

  return services;
}
