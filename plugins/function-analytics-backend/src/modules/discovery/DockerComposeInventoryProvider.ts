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
import { ServiceInventoryProvider, DiscoveredService } from '../../lib/providers';
import {
  detectLanguage,
  detectEntrypoint,
  SupportedLanguage,
} from '../language/LanguageDetector';

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

const COMPOSE_FILENAMES = [
  'docker-compose.otel.yml',
  'docker-compose.otel.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'docker/docker-compose.yml',
  'docker/docker-compose.yaml',
  'deploy/docker-compose.yml',
  'deploy/docker-compose.yaml',
];

async function findDockerfile(
  dir: string,
): Promise<{ found: boolean; name: string }> {
  for (const name of ['Dockerfile', 'dockerfile', 'DockerFile', 'Dockerfile.dev']) {
    if (await fs.pathExists(path.join(dir, name))) {
      return { found: true, name };
    }
  }
  return { found: false, name: 'Dockerfile' };
}

/**
 * Discovers services defined in docker-compose files.
 *
 * Parses docker-compose.yml (and variants) to extract services that have a
 * `build:` context. Filters out infrastructure images (Jaeger, Redis, etc.).
 *
 * Extracted from ServiceDiscoveryEngine.ts Phase 4 + extractServicesFromCompose().
 */
export class DockerComposeInventoryProvider implements ServiceInventoryProvider {
  readonly type = 'docker-compose';

  constructor(private readonly infraPatterns: string[] = []) {}

  async discoverServices(repoPath: string): Promise<DiscoveredService[]> {
    let portCounter = 8080;

    for (const filename of COMPOSE_FILENAMES) {
      const composePath = path.join(repoPath, filename);
      if (!(await fs.pathExists(composePath))) continue;

      return this.extractFromCompose(composePath, repoPath, portCounter);
    }

    return [];
  }

  private async extractFromCompose(
    composePath: string,
    repoRoot: string,
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

    for (const [svcName, svcRaw] of Object.entries(composeData.services)) {
      const svc = svcRaw as any;

      // Skip infra images
      if (INFRA_IMAGE_KEYWORDS.some(k => svc.image?.toLowerCase().includes(k)))
        continue;
      if (this.infraPatterns.some(p => svcName.toLowerCase().includes(p)))
        continue;

      // Only include services with a build context
      if (!svc.build) continue;

      const buildContext =
        typeof svc.build === 'string' ? svc.build : svc.build?.context || '.';
      const contextAbs = path.resolve(path.dirname(composePath), buildContext);
      const contextRel = path.relative(repoRoot, contextAbs);

      let language: SupportedLanguage | string = 'unknown';
      try {
        language = (await detectLanguage(contextAbs)) || 'unknown';
      } catch {
        // best-effort
      }

      const dockerfile = await findDockerfile(contextAbs);
      let entrypoint: string | undefined;
      if (language !== 'unknown') {
        entrypoint = await detectEntrypoint(contextAbs, language as SupportedLanguage);
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
}
