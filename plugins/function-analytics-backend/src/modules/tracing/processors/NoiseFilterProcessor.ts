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

import {
  SpanProcessor,
  NormalizedSpan,
  NormalizedTrace,
} from '../../../lib/providers';

// ─── Unified noise list ────────────────────────────────────────────────────
// Merged from FunctionCallAnalyzer.ts NOISE_PATTERNS, TracePreprocessor.ts
// NOISE_OPERATIONS + INFRA_SPAN_PATTERNS, and jaegerService.ts frontend filters.

/** Substring / prefix patterns — checked case-insensitively. */
const NOISE_PATTERNS: string[] = [
  // Health / readiness / metrics endpoints
  'health',
  'metrics',
  '/metrics',
  '/health',
  '/ready',
  '/live',
  '/status',
  'health-check',
  'prometheus',
  'otlp',
  'zipkin',
  'jaeger',
  'metrics-placeholder',
  // Framework middleware / router spans
  'express.middleware',
  'express.',
  'expressinit',
  'middleware -',
  'router -',
  'corsmiddleware',
  'jsonparser',
  'request handler',
  // Low-level I/O and networking.
  // Node.js OTel @opentelemetry/instrumentation-fs emits span names like
  // "fs realpathSync" (space-separated), which the fallback sanitizer converts
  // to "fs_realpathSync". Cover dot, underscore, and space variants.
  'fs.',
  'fs_',
  'fs ',
  'net.',
  'net_',
  'net ',
  'dns.',
  'dns_',
  'dns ',
  'dns.lookup',
  'tcp.connect',
  'tcp.',
  // Database client libraries (also caught by DbSpanProcessor, but belt-and-suspenders)
  'pg.',
  'mongodb.',
  'mongoose.',
  'sequelize.',
  'knex.',
  'redis.',
  'amqp.',
  'rabbitmq.',
  // Infra clients
  'grpc.',
  // Spring Boot actuator (from frontend jaegerService.ts)
  '/actuator',
  // Telemetry pipeline
  'otlp',
];

/** Exact names that are always noise. */
const NOISE_EXACT = new Set<string>([
  'http',
  'https',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'tcp',
  'dns',
  'unknown',
  'unknown_function',
  'anonymous',
  'connect',
  'lookup',
  'query',
  'close',
  'open',
  'read',
  'write',
  'stat',
  'access',
  'readfilesync',
  'readfile',
  'realpathsync',
  'statsync',
  'lstatsync',
  '',
  '*',
  '**',
  '/**',
  '/*',
]);

/** Regex patterns that are always noise — checked against the raw operation name. */
const NOISE_REGEX: RegExp[] = [
  // Wildcard routes: GET /**, POST /**, /** — framework catch-all patterns
  /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\/\*+$/i,
  /^\/\*+$/,
];

/** FRA custom tag — if set, the span has an explicit app-level function name. */
const FRA_FUNCTION_NAME_TAG = 'fra.function_name';

/**
 * Service names that are never microservices under analysis.
 * Spans from these services are dropped regardless of their operation name.
 * This prevents the Backstage backend (the plugin host) from appearing as a
 * currentService — its outgoing HTTP client spans (traffic probing, Jaeger API
 * calls) would otherwise show 100% external calls and trigger false relocations.
 */
const INFRA_SERVICE_NAMES = new Set([
  'backstage',
  'backstage-backend',
  'jaeger',
  'jaeger-query',
  'jaeger-all-in-one',
]);

/**
 * Filters out infrastructure / framework noise spans.
 *
 * Merges noise lists from FunctionCallAnalyzer, TracePreprocessor, and the
 * frontend jaegerService into a single unified filter. Respects custom
 * allowlist/blocklist from FraConfig.
 */
export class NoiseFilterProcessor implements SpanProcessor {
  readonly name = 'NoiseFilterProcessor';

  private readonly customAllowlist: Set<string>;
  private readonly customBlocklist: string[];

  constructor(options?: {
    customAllowlist?: string[];
    customBlocklist?: string[];
  }) {
    this.customAllowlist = new Set(
      (options?.customAllowlist || []).map(s => s.toLowerCase()),
    );
    this.customBlocklist = options?.customBlocklist || [];
  }

  process(
    span: NormalizedSpan,
    _trace: NormalizedTrace,
  ): NormalizedSpan | undefined {
    const op = span.operationName;

    // Drop spans from the Backstage process itself and other infra services
    if (INFRA_SERVICE_NAMES.has(span.serviceName)) return undefined;

    // If FRA tag explicitly names the function, always keep the span
    const fraName = span.tags[FRA_FUNCTION_NAME_TAG];
    if (fraName && fraName !== 'unknown') return span;

    // Check custom allowlist
    if (op && this.customAllowlist.has(op.toLowerCase())) return span;

    // Check custom blocklist
    if (this.isInCustomBlocklist(op)) return undefined;

    // Check unified noise filters
    if (this.isNoise(op)) return undefined;

    return span;
  }

  private isNoise(name: string): boolean {
    if (!name) return true;
    if (NOISE_EXACT.has(name)) return true;

    const lower = name.toLowerCase();
    if (NOISE_EXACT.has(lower)) return true;

    // Node.js OTel SDK emits spans as "fs realpathSync" (space) or "fs_readFileSync"
    // (underscore after sanitization). Catch both formats.
    if (/^[a-z][a-z0-9]*[_ ][A-Za-z]/.test(name)) return true;

    if (NOISE_REGEX.some(r => r.test(name))) return true;

    return NOISE_PATTERNS.some(p => {
      const lp = p.toLowerCase();
      return lower === lp || lower.startsWith(lp) || lower.includes(lp);
    });
  }

  private isInCustomBlocklist(name: string): boolean {
    if (!name || this.customBlocklist.length === 0) return false;
    const lower = name.toLowerCase();
    return this.customBlocklist.some(p => lower.includes(p.toLowerCase()));
  }
}
