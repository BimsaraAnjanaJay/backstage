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

import * as yaml from 'yaml';
import { DiscoveredService } from '../discovery/ServiceDiscoveryEngine';
import { FraConfig } from '../config/FraConfig';

/**
 * Extracts the GitHub org/repo slug from a full Git URL.
 * Extracted verbatim from router.ts `extractGithubSlug()`.
 */
export function extractGithubSlug(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[\/:](.+?)(\.git)?$/);
  return match ? match[1] : repoUrl;
}

/**
 * Builds a multi-document catalog-info.yaml string containing a System entity
 * and one Component entity per discovered service.
 *
 * Owner and lifecycle are now read from FraConfig instead of being hardcoded,
 * which is the only behaviour change vs the original `generateCatalogInfo()`.
 * Defaults match the original values (owner: team-platform / team-backend,
 * lifecycle: production).
 *
 * Phase 5 will add CatalogEntityMerger to preserve existing annotations.
 */
export function buildCatalogInfo(
  repoName: string,
  repoUrl: string,
  services: DiscoveredService[],
  config: FraConfig = new FraConfig(),
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
        owner: config.catalogDefaultOwner,
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
        lifecycle: config.catalogDefaultLifecycle,
        owner: config.catalogDefaultOwner,
        system: repoName,
      },
    });
  }

  return catalog.map(item => yaml.stringify(item)).join('\n---\n');
}
