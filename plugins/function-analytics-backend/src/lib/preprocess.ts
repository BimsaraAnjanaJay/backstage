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

import { CleanedCall } from './types';

/**
 * List of operation names to skip during preprocessing
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
 * Normalizes operation names to clean function names
 */
function normalizeFunctionName(operationName: string, tags: any[]): string {
  if (!operationName) return 'unknown_function';

  // centralize the cleaning logic
  let cleanName = operationName;

  // Pattern matching for various frameworks
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

  // Fallback to tags if provided
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
 * Preprocesses raw Jaeger trace data into cleaned function calls
 *
 * @param rawTraces - Array of raw Jaeger trace objects
 * @returns Array of cleaned function calls with caller/callee information
 */
export function preprocessTraces(rawTraces: any[]): CleanedCall[] {
  const cleanedCalls: CleanedCall[] = [];

  if (!rawTraces || !Array.isArray(rawTraces)) {
    return cleanedCalls;
  }

  for (const trace of rawTraces) {
    if (!trace.spans || !Array.isArray(trace.spans)) {
      continue;
    }

    // Build a map of spanID -> span for easy lookup
    const spanMap = new Map();
    for (const span of trace.spans) {
      spanMap.set(span.spanID, span);
    }

    // Process each span
    for (const span of trace.spans) {
      const operationName = span.operationName;
      const calleeService =
        trace.processes?.[span.processID]?.serviceName || 'unknown';
      const duration = span.duration || 0;

      // Skip noise operations
      if (NOISE_OPERATIONS.some(noise => operationName?.includes(noise))) {
        continue;
      }

      // Skip spans without operation names
      if (!operationName) {
        continue;
      }

      // Determine caller service from parent span
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
        latency: duration / 1000, // Convert microseconds to milliseconds
      });
    }
  }

  return cleanedCalls;
}
