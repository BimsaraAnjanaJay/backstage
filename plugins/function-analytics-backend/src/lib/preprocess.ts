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
const NOISE_OPERATIONS = ['/health', '/status', '/metrics', '/ready', '/live'];

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
      const calleeService = span.process?.serviceName || 'unknown';
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
            if (parentSpan && parentSpan.process?.serviceName) {
              callerService = parentSpan.process.serviceName;
              break;
            }
          }
        }
      }

      cleanedCalls.push({
        functionName: operationName,
        callerService,
        calleeService,
        latency: duration / 1000, // Convert microseconds to milliseconds
      });
    }
  }

  return cleanedCalls;
}
