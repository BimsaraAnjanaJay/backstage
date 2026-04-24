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

import { NormalizedTrace } from '../../lib/providers';

export interface VolatilityResult {
  functionKey: string;
  coefficientOfVariation: number;
  isVolatile: boolean;
  windowCount: number;
}

/**
 * Analyzes the temporal volatility of function call patterns.
 *
 * A function called in a single burst (all calls in one minute) has high CV,
 * while steady traffic produces low CV. High-CV functions should receive
 * lower confidence because the sample is not representative.
 */
export function analyzeVolatility(
  traces: NormalizedTrace[],
  windowMinutes: number = 5,
  volatilityThreshold: number = 1.0,
): Map<string, VolatilityResult> {
  const windowMicros = windowMinutes * 60 * 1_000_000;

  // Bucket spans by function key and time window
  // functionKey → windowIndex → count
  const buckets = new Map<string, Map<number, number>>();

  for (const trace of traces) {
    for (const span of trace.spans) {
      const fn = span.tags['fra.resolved_function'];
      if (!fn || fn === 'unknown_function') continue;

      const key = `${span.serviceName}::${fn}`;
      const windowIdx = Math.floor(span.startTime / windowMicros);

      if (!buckets.has(key)) {
        buckets.set(key, new Map());
      }
      const windowMap = buckets.get(key)!;
      windowMap.set(windowIdx, (windowMap.get(windowIdx) || 0) + 1);
    }
  }

  const results = new Map<string, VolatilityResult>();

  for (const [key, windowMap] of buckets.entries()) {
    const counts = Array.from(windowMap.values());
    const windowCount = counts.length;

    if (windowCount <= 1) {
      // Only one time-window observed — cannot compute a meaningful CV.
      // This is common when a short benchmark run (e.g. 5 rounds in < 5 min)
      // places ALL spans in the same window bucket.
      // Treat as neutral stability (CV = 0, not volatile) rather than
      // Infinity, which would zero out confidence for every function.
      results.set(key, {
        functionKey: key,
        coefficientOfVariation: 0,
        isVolatile: false,
        windowCount,
      });
      continue;
    }

    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (mean === 0) {
      results.set(key, {
        functionKey: key,
        coefficientOfVariation: 0,
        isVolatile: false,
        windowCount,
      });
      continue;
    }

    const variance =
      counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean;

    results.set(key, {
      functionKey: key,
      coefficientOfVariation: Math.round(cv * 1000) / 1000,
      isVolatile: cv > volatilityThreshold,
      windowCount,
    });
  }

  return results;
}
