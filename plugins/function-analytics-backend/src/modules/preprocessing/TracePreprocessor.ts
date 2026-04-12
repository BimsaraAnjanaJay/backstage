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

import { CleanedCall } from '../../lib/types';

// ─── FRA custom attribute keys (polyglot-benchmark convention) ───────────────
const FRA_FUNCTION_NAME_TAG = 'fra.function_name';
const FRA_CALLER_SERVICE_TAG = 'fra.caller_service';
const FRA_INVOCATION_TYPE_TAG = 'fra.invocation_type';

// ─── OTel semantic convention function name attributes ───────────────────────
const SEMCONV_FUNCTION_TAGS = [
  'code.function',
  'function.name',
  'method.name',
  'rpc.method',
];

/**
 * Health, metrics, and observability probe endpoints — never app functions.
 */
const NOISE_OPERATIONS: string[] = [
  '/health',
  '/status',
  '/metrics',
  '/ready',
  '/live',
  'health-check',
  'prometheus',
  'otlp',
  'zipkin',
  'metrics-placeholder',
];

/**
 * Framework/infra span prefixes/substrings.
 */
const INFRA_SPAN_PATTERNS: string[] = [
  'middleware -',
  'router -',
  'express.',
  'expressInit',
  'jsonParser',
  'corsmiddleware',
  'dns.',
  'tcp.',
  'net.',
  'fs.',
  'pg.',
  'mongodb.',
  'mongoose.',
  'sequelize.',
  'knex.',
  'grpc.',
  'redis.',
];

/** Exact span names that are pure infrastructure noise. */
const INFRA_EXACT = new Set([
  'connect',
  'lookup',
  'query',
  'close',
  'open',
  'read',
  'write',
  'stat',
  'access',
  'tcp',
  'dns',
  'http',
  'https',
  'unknown_function',
  'anonymous',
  'request handler',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]);

function getTag(tags: any[] | undefined, key: string): string | undefined {
  if (!tags || !Array.isArray(tags)) return undefined;
  const t = tags.find((x: any) => x.key === key);
  return t !== undefined ? String(t.value) : undefined;
}

function isInfraSpan(operationName: string): boolean {
  if (!operationName) return true;
  const lower = operationName.toLowerCase();
  if (INFRA_EXACT.has(operationName) || INFRA_EXACT.has(lower)) return true;
  return INFRA_SPAN_PATTERNS.some(
    p => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase()),
  );
}

/**
 * Resolves the clean function name from a span.
 *
 * Priority:
 *  1. fra.function_name tag (FRA benchmark — exact app function)
 *  2. OTel semconv code.function / function.name / method.name
 *  3. HTTP "METHOD /path" → last meaningful path segment
 *  4. "Class.method" dotted patterns
 *  5. Sanitised operationName
 */
function normalizeFunctionName(operationName: string, tags: any[]): string {
  // 1. FRA tag
  const fraName = getTag(tags, FRA_FUNCTION_NAME_TAG);
  if (fraName && fraName !== 'unknown') return fraName;

  // 2. OTel semantic convention
  for (const key of SEMCONV_FUNCTION_TAGS) {
    const v = getTag(tags, key);
    if (v && v !== 'unknown') return v;
  }

  if (!operationName) return 'unknown_function';

  // 3. HTTP pattern — extract endpoint name
  const httpMatch = operationName.match(
    /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.*)/i,
  );
  if (httpMatch) {
    const pathPart = httpMatch[1].split('?')[0];
    const segments = pathPart.split('/').filter(Boolean);
    const meaningful = segments.filter(
      s => !s.startsWith(':') && !s.startsWith('{') && !/^\d+$/.test(s),
    );
    if (meaningful.length > 0) return meaningful[meaningful.length - 1];
  }

  // 4. Dotted patterns
  const dottedMatch = operationName.match(/^([A-Za-z0-9]+)\.([A-Za-z0-9_]+)/);
  if (dottedMatch) return operationName;

  // 5. Sanitize
  return operationName
    .replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Preprocesses raw Jaeger trace data into cleaned function calls.
 *
 * Enhancements:
 *  - Reads fra.function_name, fra.caller_service, fra.invocation_type tags.
 *  - Falls back to OTel semconv tags, then operationName heuristics.
 *  - Uses fra.invocation_type = "internal" to set callerService = calleeService.
 */
export function preprocessTraces(rawTraces: any[]): CleanedCall[] {
  const cleanedCalls: CleanedCall[] = [];

  if (!rawTraces || !Array.isArray(rawTraces)) return cleanedCalls;

  for (const trace of rawTraces) {
    if (!trace.spans || !Array.isArray(trace.spans)) continue;

    const spanMap = new Map<string, any>();
    for (const span of trace.spans) {
      spanMap.set(span.spanID, span);
    }

    for (const span of trace.spans) {
      const operationName: string = span.operationName || '';
      const tags: any[] = span.tags || [];
      const calleeService: string =
        trace.processes?.[span.processID]?.serviceName || 'unknown';
      const duration: number = span.duration || 0;

      // Check for FRA function name tag first — if present, this is an app span
      const fraFunctionName = getTag(tags, FRA_FUNCTION_NAME_TAG);
      const hasExplicitFraName =
        !!fraFunctionName && fraFunctionName !== 'unknown';

      // Skip noise unless FRA tag explicitly names the function
      if (!hasExplicitFraName) {
        if (
          NOISE_OPERATIONS.some(noise =>
            operationName.toLowerCase().includes(noise.toLowerCase()),
          )
        ) {
          continue;
        }
        if (isInfraSpan(operationName)) {
          continue;
        }
        if (!operationName) continue;
      }

      const functionName = normalizeFunctionName(operationName, tags);
      if (!functionName || functionName === 'unknown_function') continue;

      // ── Caller resolution ────────────────────────────────────────────────
      // Priority: fra.caller_service tag → fra.invocation_type → parent span
      let callerService: string = getTag(tags, FRA_CALLER_SERVICE_TAG) || '';

      if (!callerService || callerService === 'unknown') {
        const fraType = getTag(tags, FRA_INVOCATION_TYPE_TAG);
        if (fraType === 'internal') {
          callerService = calleeService;
        } else if (fraType === 'external') {
          callerService = 'external (client)';
        } else {
          // Walk parent span references
          callerService = 'external';
          for (const ref of span.references || []) {
            if (ref.refType === 'CHILD_OF' || ref.refType === 'FOLLOWS_FROM') {
              const parentSpan = spanMap.get(ref.spanID);
              if (parentSpan) {
                const parentService =
                  trace.processes?.[parentSpan.processID]?.serviceName;
                if (parentService) {
                  callerService = parentService;
                  break;
                }
              }
            }
          }
        }
      }

      cleanedCalls.push({
        functionName,
        callerService,
        calleeService,
        latency: duration / 1000,
      });
    }
  }

  return cleanedCalls;
}
