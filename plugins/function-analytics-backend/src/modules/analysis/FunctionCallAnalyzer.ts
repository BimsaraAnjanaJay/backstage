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

import { FunctionAnalysis } from '../../lib/types';

// ─── Minimum observations required to emit a result ────────────────────────
// Functions with fewer total calls are kept internally for cohesion math but
// are flagged with low confidence by RelocationDecisionEngine.
const MIN_SAMPLE_THRESHOLD = 5;

// ─── Noise patterns ─────────────────────────────────────────────────────────
// Anything matching here is an infrastructure / framework span, not an app
// function. Checked case-insensitively as prefix, suffix, or substring.
const NOISE_PATTERNS: string[] = [
  'health',
  'metrics',
  '/metrics',
  '/health',
  '/ready',
  '/live',
  '/status',
  'express.middleware',
  'middleware -',
  'router -',
  'corsmiddleware',
  'fs.',
  'net.',
  'dns.',
  'dns.lookup',
  'tcp.connect',
  'connect',
  'lookup',
  'readfilesync',
  'readfile',
  'realpathsync',
  'statsync',
  'lstatsync',
  'access',
  'expressinit',
  'jsonparser',
  'query',
  'tcp',
  'dns',
  'close',
  'open',
  'read',
  'write',
  'stat',
  'request handler',
  'anonymous',
  'unknown_function',
  'pg.',
  'mongodb.',
  'mongoose.',
  'sequelize.',
  'knex.',
  'grpc.',
  'redis.',
  'amqp.',
  'rabbitmq.',
  'prometheus',
  'zipkin',
  'otlp',
  'jaeger',
];

// Exact names that are always noise
const NOISE_EXACT = new Set([
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
  '',
  '*',
  '**',
  '/**',
  '/*', // glob wildcards from Spring Cloud Gateway / catch-all routes
]);

// ─── FRA custom attribute keys (polyglot-benchmark convention) ───────────────
// Services that instrument with the FRA SDK set these span attributes.
// When present they are authoritative and override operationName heuristics.
const FRA_FUNCTION_NAME_TAG = 'fra.function_name';
const FRA_INVOCATION_TYPE_TAG = 'fra.invocation_type'; // "internal" | "external"
const FRA_CALLER_SERVICE_TAG = 'fra.caller_service';
const FRA_HOST_SERVICE_TAG = 'fra.host_service';

// OpenTelemetry semantic convention tags checked for function name
const SEMCONV_FUNCTION_TAGS = [
  'code.function',
  'function.name',
  'method.name',
  'rpc.method',
];

/**
 * Extract a span tag value by key. Returns undefined when not found.
 */
function getTag(tags: any[] | undefined, key: string): string | undefined {
  if (!tags || !Array.isArray(tags)) return undefined;
  const t = tags.find((x: any) => x.key === key);
  return t !== undefined ? String(t.value) : undefined;
}

/**
 * Determines whether an operation name looks like infrastructure noise.
 */
function isNoise(name: string): boolean {
  if (!name) return true;
  if (NOISE_EXACT.has(name)) return true;
  const lower = name.toLowerCase();
  if (NOISE_EXACT.has(lower)) return true;
  return NOISE_PATTERNS.some(p => {
    const lp = p.toLowerCase();
    return lower === lp || lower.startsWith(lp) || lower.includes(lp);
  });
}

/**
 * Normalizes a raw span operationName to a clean function name.
 *
 * Priority:
 *   1. fra.function_name tag (FRA benchmark convention)
 *   2. code.function / function.name / method.name OTel semconv tags
 *   3. "ClassName.methodName" patterns from operation name
 *   4. HTTP "METHOD /path/endpoint" → last path segment
 *   5. Raw operationName with special chars collapsed to underscores
 */
function resolveSpanFunctionName(operationName: string, tags: any[]): string {
  // 1. FRA-specific attribute — exact app-level function name
  const fraName = getTag(tags, FRA_FUNCTION_NAME_TAG);
  if (fraName && fraName !== 'unknown') return fraName;

  // 2. OTel semantic convention attributes
  for (const key of SEMCONV_FUNCTION_TAGS) {
    const v = getTag(tags, key);
    if (v && v !== 'unknown') return v;
  }

  if (!operationName) return 'unknown_function';
  const op = operationName.trim();

  // 3. "Controller.method" or "Service.method" dotted patterns
  const dottedMatch = op.match(
    /^([A-Za-z0-9]+(?:Controller|Service|Repository|Handler|Manager))\.([A-Za-z0-9_]+)/,
  );
  if (dottedMatch) return `${dottedMatch[1]}.${dottedMatch[2]}`;

  // Plain "word.word" (e.g. "auth.validateToken") — keep as-is if it looks like a function
  const simpleDotted = op.match(
    /^([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)$/,
  );
  if (simpleDotted) return op;

  // 4. HTTP patterns  →  extract endpoint name
  const httpMatch = op.match(
    /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.*)/i,
  );
  if (httpMatch) {
    const pathPart = httpMatch[1].split('?')[0]; // strip query string
    const segments = pathPart.split('/').filter(Boolean);
    // Use last non-parameter segment (parameters look like :id or {id})
    const meaningful = segments.filter(
      s => !s.startsWith(':') && !s.startsWith('{') && !/^\d+$/.test(s),
    );
    if (meaningful.length > 0) return meaningful[meaningful.length - 1];
    return (
      pathPart
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '') || 'handler'
    );
  }

  // 5. Fallback — sanitize the raw name
  return (
    op
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'unknown_function'
  );
}

interface FunctionStats {
  fn: string;
  service: string;
  internalCalls: number;
  externalCalls: number;
  internalLatencies: number[];
  externalLatencies: number[];
  callers: Map<string, number>;
}

/**
 * Analyzes raw Jaeger traces and produces per-function call statistics.
 *
 * Improvements over the original:
 *  - Reads FRA custom span attributes (fra.function_name, fra.invocation_type,
 *    fra.caller_service) for exact app-level function identification.
 *  - Falls back to OTel semantic convention tags, then operationName heuristics.
 *  - Tracks all caller services (not just dominant) for cohesion computation.
 *  - Emits sampleCount so RelocationDecisionEngine can weight confidence.
 *  - Filters results with fewer than MIN_SAMPLE_THRESHOLD observations.
 */
export function analyzeFunctionCalls(rawTraces: any[]): FunctionAnalysis[] {
  const functionStats = new Map<string, FunctionStats>();

  for (const trace of rawTraces) {
    if (!trace.spans || !Array.isArray(trace.spans)) continue;

    // Build spanID → serviceName lookup for the whole trace
    const spanServiceMap = new Map<string, string>();
    for (const span of trace.spans) {
      const proc = trace.processes?.[span.processID];
      if (proc?.serviceName) spanServiceMap.set(span.spanID, proc.serviceName);
    }

    for (const span of trace.spans) {
      const proc = trace.processes?.[span.processID];
      if (!proc) continue;

      const serviceName: string = proc.serviceName;
      const tags: any[] = span.tags || [];

      // ── Determine authoritative function name ──────────────────────────
      const rawOp: string = span.operationName || '';

      // Skip obvious infra / framework spans by operation name
      if (isNoise(rawOp)) {
        // Still accept if FRA tag provides an explicit function name
        const fraFn = getTag(tags, FRA_FUNCTION_NAME_TAG);
        if (!fraFn || fraFn === 'unknown') continue;
      }

      // Skip database spans — they are storage-layer ops, not application functions.
      // Detected by: db.system tag, db.operation tag, or operation name that looks
      // like a SQL statement (INSERT/SELECT/UPDATE/DELETE optionally followed by
      // a UUID batch identifier, e.g. "INSERT_b198ab44-89f3-48b7-9d38-e19d53e6d37d.pets").
      const hasDbTag =
        getTag(tags, 'db.system') ||
        getTag(tags, 'db.operation') ||
        getTag(tags, 'db.statement');
      const looksLikeSql =
        /^(INSERT|SELECT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE|CREATE|DROP|ALTER)[\s_]/i.test(
          rawOp,
        );
      if (hasDbTag || looksLikeSql) continue;

      // Skip pure outgoing client HTTP spans with no path info (span.kind=client
      // and operation is just a method verb or Eureka/Zipkin URL). These represent
      // calls *made by* the service, not functions *in* the service.
      const spanKind = getTag(tags, 'span.kind') || '';
      const httpUrl =
        getTag(tags, 'http.url') || getTag(tags, 'url.full') || '';
      if (
        spanKind === 'client' &&
        !getTag(tags, FRA_FUNCTION_NAME_TAG) &&
        (httpUrl.includes('eureka') ||
          httpUrl.includes('zipkin') ||
          httpUrl.includes(':9411') ||
          httpUrl.includes(':8761'))
      )
        continue;

      const functionName = resolveSpanFunctionName(rawOp, tags);
      if (!functionName || functionName === 'unknown_function') continue;

      // ── Determine caller service ───────────────────────────────────────
      // Priority: fra.caller_service tag → parent span service → 'external (client)'
      let callerService: string = getTag(tags, FRA_CALLER_SERVICE_TAG) || '';

      if (!callerService || callerService === 'unknown') {
        // Walk parent references
        if (span.references?.length > 0) {
          const parentRef = span.references.find(
            (r: any) => r.refType === 'CHILD_OF',
          );
          if (parentRef) {
            callerService = spanServiceMap.get(parentRef.spanID) || '';
          }
        }
      }

      // Normalise artificial / test callers
      if (
        !callerService ||
        callerService === 'unknown' ||
        callerService.includes('backstage') ||
        callerService.includes('traffic-generator')
      ) {
        // Check FRA invocation type tag to decide external vs internal
        const fraType = getTag(tags, FRA_INVOCATION_TYPE_TAG);
        if (fraType === 'internal') {
          callerService = serviceName; // same service → internal call
        } else {
          callerService = 'external (client)';
        }
      }

      // Skip backstage-generated probes — they pollute the internal/external ratio
      if (callerService.includes('backstage-backend')) continue;

      // ── Determine invocation type ──────────────────────────────────────
      // fra.invocation_type is authoritative when present
      const fraInvocationType = getTag(tags, FRA_INVOCATION_TYPE_TAG);
      const isInternal =
        fraInvocationType === 'internal' ||
        (!fraInvocationType && callerService === serviceName);

      // Also check fra.host_service: if set, verify it matches serviceName
      const fraHostService = getTag(tags, FRA_HOST_SERVICE_TAG);
      if (fraHostService && fraHostService !== serviceName) {
        // This span is an observation from the wrong service — skip
        continue;
      }

      const latencyMs = (span.duration || 0) / 1000;
      const key = `${serviceName}::${functionName}`;

      if (!functionStats.has(key)) {
        functionStats.set(key, {
          fn: functionName,
          service: serviceName,
          internalCalls: 0,
          externalCalls: 0,
          internalLatencies: [],
          externalLatencies: [],
          callers: new Map(),
        });
      }

      const stats = functionStats.get(key)!;

      if (isInternal) {
        stats.internalCalls++;
        stats.internalLatencies.push(latencyMs);
      } else {
        stats.externalCalls++;
        stats.externalLatencies.push(latencyMs);
        stats.callers.set(
          callerService,
          (stats.callers.get(callerService) || 0) + 1,
        );
      }
    }
  }

  const avg = (arr: number[]): number =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const results: FunctionAnalysis[] = [];

  for (const stats of functionStats.values()) {
    const totalCalls = stats.internalCalls + stats.externalCalls;
    if (totalCalls < MIN_SAMPLE_THRESHOLD) continue;

    // Dominant external caller
    let dominantCaller = 'none';
    let dominantCount = 0;
    const callerServices: Record<string, number> = {};
    for (const [caller, count] of stats.callers.entries()) {
      callerServices[caller] = count;
      if (count > dominantCount) {
        dominantCount = count;
        dominantCaller = caller;
      }
    }

    const dominantPercent = totalCalls > 0 ? dominantCount / totalCalls : 0;

    results.push({
      functionName: stats.fn,
      currentService: stats.service,
      internalCalls: stats.internalCalls,
      externalCalls: stats.externalCalls,
      dominantCaller,
      dominantPercent,
      avgInternalLatency: avg(stats.internalLatencies),
      avgExternalLatency: avg(stats.externalLatencies),
      sampleCount: totalCalls,
      callerServices,
    });
  }

  return results;
}
