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

import { FunctionAnalysis, ServiceFunctionRegistry } from '../../lib/types';

/**
 * Augments trace-derived function analysis with static code analysis coverage.
 *
 * Functions that exist in source code but never appeared in traces are added
 * with staticCoverage='uncovered' and zero call counts, making them visible
 * in the output so the UI can show a "no trace coverage" badge.
 */
export function augmentWithStaticCoverage(
  analyzed: FunctionAnalysis[],
  registries: ServiceFunctionRegistry[],
): FunctionAnalysis[] {
  // Build lookup: serviceName → Set<functionName> from registries
  const registryLookup = new Map<string, Set<string>>();
  for (const registry of registries) {
    if (!registryLookup.has(registry.service)) {
      registryLookup.set(registry.service, new Set());
    }
    const fnSet = registryLookup.get(registry.service)!;
    for (const fn of registry.functions) {
      fnSet.add(fn.name);
    }
  }

  // Track which service::function keys already exist in analyzed
  const existingKeys = new Set<string>();
  const result: FunctionAnalysis[] = [];

  for (const fa of analyzed) {
    const key = `${fa.currentService}::${fa.functionName}`;
    existingKeys.add(key);

    // If service has a registry, mark as 'covered' (appeared in traces)
    if (registryLookup.has(fa.currentService)) {
      result.push({ ...fa, staticCoverage: 'covered' });
    } else {
      result.push(fa); // leave as 'unknown'
    }
  }

  // Add uncovered functions from registries
  for (const registry of registries) {
    const fnSet = registryLookup.get(registry.service);
    if (!fnSet) continue;

    for (const registryFn of registry.functions) {
      const key = `${registry.service}::${registryFn.name}`;
      if (existingKeys.has(key)) continue;

      existingKeys.add(key);
      result.push({
        functionName: registryFn.name,
        currentService: registry.service,
        internalCalls: 0,
        externalCalls: 0,
        dominantCaller: 'none',
        dominantPercent: 0,
        avgInternalLatency: 0,
        avgExternalLatency: 0,
        p95InternalLatency: 0,
        p95ExternalLatency: 0,
        p99InternalLatency: 0,
        p99ExternalLatency: 0,
        sampleCount: 0,
        callerServices: {},
        patternStability: 1.0,
        staticCoverage: 'uncovered',
      });
    }
  }

  return result;
}
