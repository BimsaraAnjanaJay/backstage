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

/**
 * Infrastructure/framework operation names to skip during preprocessing.
 * Moved from lib/preprocess.ts.
 * Phase 3 will make this list configurable via FraConfig.noiseFilter.
 */
const NOISE_OPERATIONS = [
  '/health',
  '/status',
  '/metrics',
  '/ready',
  '/live',
  'health-check',
  'prometheus',
  'otlp',
  'zipkin',
];

/**
 * Span-name prefixes/patterns that identify framework/infrastructure spans.
 * These are filtered before normalization so they never reach the functions table.
 */
const INFRA_SPAN_PATTERNS = [
  'middleware -',
  'router -',
  'express.',
  'expressInit',
  'jsonParser',
  'corsmiddleware',
  'dns.',
  'dns.lookup',
  'tcp.',
  'tcp.connect',
  'net.',
  'fs.',
  'pg.',
  'mongodb.',
  'mongoose.',
  'sequelize.',
  'knex.',
];

/** Exact span names that are pure infrastructure noise. */
const INFRA_EXACT = new Set([
  'connect', 'lookup', 'query', 'close', 'open', 'read', 'write', 'stat',
  'access', 'tcp', 'dns', 'http', 'unknown_function', 'anonymous',
  'request handler', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
]);

function isInfraSpan(operationName: string): boolean {
  if (!operationName) return true;
  const lower = operationName.toLowerCase();
  if (INFRA_EXACT.has(operationName) || INFRA_EXACT.has(lower)) return true;
  return INFRA_SPAN_PATTERNS.some(
    p => lower === p.toLowerCase() ||
         lower.startsWith(p.toLowerCase()) ||
         lower.includes(p.toLowerCase()),
  );
}

/**
 * Normalizes raw span operation names to clean function names.
 * Extracted verbatim from lib/preprocess.ts `normalizeFunctionName()`.
 */
function normalizeFunctionName(operationName: string, tags: any[]): string {
  if (!operationName) return 'unknown_function';

  let cleanName = operationName;

  const patterns = [
    /^(GET|POST|PUT|DELETE|PATCH) \/api\/([^\/]+)\/([^\/\?]+)/i,
    /^(GET|POST|PUT|DELETE|PATCH) \/([^\/]+)\/([^\/\?]+)/i,
    /^([A-Za-z0-9]+Controller)\.([A-Za-z0-9]+)/,
    /^([A-Za-z0-9]+Service)\.([A-Za-z0-9]+)/,
    /^([a-z_]+)\.([a-z_]+)/,
    /^\/([A-Za-z0-9.]+)\/([A-Za-z0-9]+)/,
  ];

  for (const pattern of patterns) {
    const match = cleanName.match(pattern);
    if (match) {
      cleanName = match[match.length - 1] || match[0];
      break;
    }
  }

  const functionTag = tags?.find(
    tag =>
      tag.key === 'function.name' ||
      tag.key === 'code.function' ||
      tag.key === 'method.name',
  );

  if (functionTag) return String(functionTag.value);

  return cleanName
    .replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Preprocesses raw Jaeger trace data into cleaned function calls.
 * Moved verbatim from lib/preprocess.ts `preprocessTraces()`.
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
      const operationName = span.operationName;
      const calleeService =
        trace.processes?.[span.processID]?.serviceName || 'unknown';
      const duration = span.duration || 0;

      if (NOISE_OPERATIONS.some(noise => operationName?.includes(noise))) {
        continue;
      }
      if (isInfraSpan(operationName)) {
        continue;
      }
      if (!operationName) continue;

      let callerService = 'external';
      if (span.references && Array.isArray(span.references)) {
        for (const ref of span.references) {
          if (ref.refType === 'CHILD_OF' || ref.refType === 'FOLLOWS_FROM') {
            const parentSpan = spanMap.get(ref.spanID);
            if (
              parentSpan &&
              trace.processes?.[parentSpan.processID]?.serviceName
            ) {
              callerService = trace.processes[parentSpan.processID].serviceName;
              break;
            }
          }
        }
      }

      cleanedCalls.push({
        functionName: normalizeFunctionName(operationName, span.tags),
        callerService,
        calleeService,
        latency: duration / 1000,
      });
    }
  }

  return cleanedCalls;
}
