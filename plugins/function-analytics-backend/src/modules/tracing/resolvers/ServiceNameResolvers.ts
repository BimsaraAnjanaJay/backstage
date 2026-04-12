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

import { ServiceNameResolver } from '../../../lib/providers';

/**
 * Resolves service names using an explicit static mapping table.
 *
 * Configured via `fra.tracing.serviceNameMappings` in app-config.yaml.
 * Example: { "spring-petclinic-customers-service": "customers-service" }
 *
 * Priority: 1 (highest — explicit overrides always win)
 */
export class StaticMappingResolver implements ServiceNameResolver {
  readonly name = 'StaticMappingResolver';

  constructor(
    private readonly mappings: Record<string, string>,
  ) {}

  resolve(catalogName: string, knownTelemetryNames: string[]): string | undefined {
    const mapped = this.mappings[catalogName];
    if (mapped && knownTelemetryNames.includes(mapped)) return mapped;
    return undefined;
  }
}

/**
 * Resolves by exact match — catalog name is already the telemetry name.
 *
 * Extracted from jaegerService.ts line 328 (first candidate check).
 * Priority: 2
 */
export class ExactMatchResolver implements ServiceNameResolver {
  readonly name = 'ExactMatchResolver';

  resolve(catalogName: string, knownTelemetryNames: string[]): string | undefined {
    return knownTelemetryNames.includes(catalogName) ? catalogName : undefined;
  }
}

/**
 * Tries adding or removing common suffixes (-service, -svc).
 *
 * Extracted from jaegerService.ts lines 301-307.
 * Priority: 3
 */
export class SuffixVariantResolver implements ServiceNameResolver {
  readonly name = 'SuffixVariantResolver';

  private static readonly SUFFIXES = ['-service', '-svc'];

  resolve(catalogName: string, knownTelemetryNames: string[]): string | undefined {
    const candidates: string[] = [];

    for (const suffix of SuffixVariantResolver.SUFFIXES) {
      // Try adding suffix
      if (!catalogName.endsWith(suffix)) {
        candidates.push(`${catalogName}${suffix}`);
      }
      // Try removing suffix
      if (catalogName.endsWith(suffix)) {
        candidates.push(catalogName.replace(new RegExp(`${suffix}$`), ''));
      }
    }

    for (const c of candidates) {
      if (knownTelemetryNames.includes(c)) return c;
    }
    return undefined;
  }
}

/**
 * Progressively strips leading dash-separated segments from the catalog name.
 *
 * Example: "spring-petclinic-customers-service"
 *   → "petclinic-customers-service"
 *   → "customers-service"
 *   → "customers"  (also tries with suffix stripped)
 *
 * Extracted from jaegerService.ts lines 310-325.
 * Priority: 4
 */
export class PrefixStripResolver implements ServiceNameResolver {
  readonly name = 'PrefixStripResolver';

  resolve(catalogName: string, knownTelemetryNames: string[]): string | undefined {
    const parts = catalogName.split('-');
    if (parts.length < 2) return undefined;

    for (let i = 1; i < parts.length - 1; i++) {
      const stripped = parts.slice(i).join('-');

      if (knownTelemetryNames.includes(stripped)) return stripped;

      // Also try with suffix stripped
      for (const suffix of ['-service', '-svc']) {
        if (stripped.endsWith(suffix)) {
          const withoutSuffix = stripped.replace(new RegExp(`${suffix}$`), '');
          if (
            withoutSuffix !== stripped &&
            knownTelemetryNames.includes(withoutSuffix)
          ) {
            return withoutSuffix;
          }
        }
      }
    }

    return undefined;
  }
}
