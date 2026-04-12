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

import { ServiceInventoryProvider, DiscoveredService } from '../../lib/providers';

/** Configuration entry for a statically-defined service. */
export interface StaticServiceEntry {
  name: string;
  port: number;
  language: string;
  path?: string;
}

/**
 * Returns a fixed list of services from configuration.
 *
 * Useful when services cannot be discovered automatically (e.g. external
 * services, legacy deployments, or services running outside the repo).
 *
 * Configured via `fra.discovery.staticServices` in app-config.yaml.
 */
export class StaticInventoryProvider implements ServiceInventoryProvider {
  readonly type = 'static';

  constructor(private readonly services: StaticServiceEntry[]) {}

  async discoverServices(_repoPath: string): Promise<DiscoveredService[]> {
    return this.services.map(s => ({
      name: s.name,
      language: s.language,
      path: s.path || s.name,
      port: s.port,
      hasDockerfile: false,
      dockerfileName: 'Dockerfile',
    }));
  }
}
