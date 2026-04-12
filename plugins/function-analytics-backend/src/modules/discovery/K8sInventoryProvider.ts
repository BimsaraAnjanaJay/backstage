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

import fetch from 'node-fetch';
import { ServiceInventoryProvider, DiscoveredService } from '../../lib/providers';

/** Infra deployment names to filter out by keyword. */
const INFRA_KEYWORDS = [
  'jaeger',
  'zipkin',
  'prometheus',
  'grafana',
  'mongo',
  'redis',
  'postgres',
  'mysql',
  'rabbitmq',
  'kafka',
  'zookeeper',
  'elasticsearch',
  'nginx',
  'traefik',
  'otel-collector',
];

/**
 * Discovers services from Kubernetes deployments in a given namespace.
 *
 * Queries the Kubernetes API for Deployment resources and converts them
 * into DiscoveredService entries. Language detection is not possible from
 * K8s metadata alone, so language is set to 'unknown'.
 */
export class K8sInventoryProvider implements ServiceInventoryProvider {
  readonly type = 'k8s';

  constructor(
    private readonly namespace: string = 'default',
    /** K8s API server URL. Defaults to in-cluster service account. */
    private readonly apiServer: string = 'https://kubernetes.default.svc',
    private readonly token?: string,
  ) {}

  async discoverServices(_repoPath: string): Promise<DiscoveredService[]> {
    const url = `${this.apiServer}/apis/apps/v1/namespaces/${this.namespace}/deployments`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return [];

      const data = (await res.json()) as any;
      const items = data.items || [];
      const services: DiscoveredService[] = [];

      for (const item of items) {
        const name = item.metadata?.name || '';
        if (!name) continue;

        // Filter out infrastructure deployments
        if (INFRA_KEYWORDS.some(k => name.toLowerCase().includes(k))) continue;

        // Extract container port if available
        const containers = item.spec?.template?.spec?.containers || [];
        let port = 8080;
        if (containers.length > 0 && containers[0].ports?.length > 0) {
          port = containers[0].ports[0].containerPort || 8080;
        }

        services.push({
          name,
          language: 'unknown',
          path: name,
          port,
          hasDockerfile: false,
          dockerfileName: 'Dockerfile',
        });
      }

      return services;
    } catch {
      return [];
    }
  }
}
