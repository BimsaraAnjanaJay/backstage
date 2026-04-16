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
  // Spring framework internals (auto-instrumentation creates many of these)
  'org.springframework.',
  'springframework.',
  'spring.scheduled',
  'dispatcherservlet',
  'requestmappinghandlermapping',
  // ASP.NET / Kestrel framework noise
  'microsoft.aspnetcore.',
  'kestrel.',
  // Low-level I/O and networking
  'fs.',
  'net.',
  'dns.',
  'dns.lookup',
  'tcp.connect',
  'tcp.',
  'socket.',
  // Database client libraries (also caught by DbSpanProcessor, but belt-and-suspenders)
  'pg.',
  'mongodb.',
  'mongoose.',
  'sequelize.',
  'knex.',
  'redis.',
  'amqp.',
  'rabbitmq.',
  'cassandra.',
  'elasticsearch.',
  // Infra clients
  'grpc.',
  'grpc.health.v1.health/check',
  'grpc.reflection',
  // Spring Boot actuator (from frontend jaegerService.ts)
  '/actuator',
  '/info',
  '/env',
  '/beans',
  // Service discovery / config polling
  'eureka.',
  'consul.',
  'discovery.',
  'configserver.',
  'configservice.',
  'registry.',
  // Messaging system polling / housekeeping (keep actual produce/consume,
  // drop background polls)
  'kafka.consumer.poll',
  'kafka.metadata',
  'kafka.commit',
  'kafka.heartbeat',
  // Telemetry self-spans
  'opentelemetry.',
  'otel.',
  'otelcol',
  // Service mesh sidecars
  'envoy.',
  'istio.',
  'linkerd.',
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

/** FRA custom tag — if set, the span has an explicit app-level function name. */
const FRA_FUNCTION_NAME_TAG = 'fra.function_name';

/** OTel HTTP route tags — if set, the span has a framework-resolved endpoint. */
const HTTP_ROUTE_TAGS = ['http.route', 'url.template'];

/** Health-check style routes that are noise even when http.route is set. */
const HEALTH_ROUTE_PATTERNS = [
  '/health',
  '/healthz',
  '/ready',
  '/readyz',
  '/live',
  '/livez',
  '/metrics',
  '/actuator',
  '/info',
];

function isHealthCheckRoute(route: string): boolean {
  const lower = route.toLowerCase();
  return HEALTH_ROUTE_PATTERNS.some(p => lower.includes(p));
}

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

    // If FRA tag explicitly names the function, always keep the span
    const fraName = span.tags[FRA_FUNCTION_NAME_TAG];
    if (fraName && fraName !== 'unknown') return span;

    // If standard OTel HTTP route is set, keep the span — framework
    // auto-instrumentation has already identified an application endpoint.
    // Health-check / metrics routes are still dropped.
    for (const k of HTTP_ROUTE_TAGS) {
      const route = span.tags[k];
      if (route && !isHealthCheckRoute(route)) return span;
    }

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
