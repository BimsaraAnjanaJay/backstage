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
import { RelocationResult } from '../../lib/types';

export interface CoLocationGroup {
  functions: string[];
  services: string[];
  coOccurrenceRate: number;
  suggestedAction: 'move-together' | 'extract-shared';
}

/**
 * Detects groups of functions that always co-appear in the same traces.
 * If two co-located functions are both recommended for relocation but to
 * different services, they should be moved together or extracted to a shared service.
 */
export function detectCoLocatedGroups(
  results: RelocationResult[],
  traces: NormalizedTrace[],
  coOccurrenceThreshold: number = 0.8,
): CoLocationGroup[] {
  // Build per-trace function sets
  const traceFunctionSets: Set<string>[] = [];
  for (const trace of traces) {
    const fns = new Set<string>();
    for (const span of trace.spans) {
      const fn = span.tags['fra.resolved_function'];
      if (fn && fn !== 'unknown_function') {
        fns.add(fn);
      }
    }
    if (fns.size > 0) {
      traceFunctionSets.push(fns);
    }
  }

  if (traceFunctionSets.length === 0) return [];

  // Only consider functions that have recommendation='relocate'
  const relocateFns = results
    .filter(r => r.recommendation === 'relocate')
    .map(r => r.functionName);

  if (relocateFns.length < 2) return [];

  // Count per-function appearances and pairwise co-occurrences
  const fnCount = new Map<string, number>();
  const pairCount = new Map<string, number>();

  for (const fns of traceFunctionSets) {
    const present = relocateFns.filter(f => fns.has(f));
    for (const fn of present) {
      fnCount.set(fn, (fnCount.get(fn) || 0) + 1);
    }
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const key = [present[i], present[j]].sort().join('||');
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  // Find pairs that exceed the co-occurrence threshold
  const coLocatedPairs: Array<[string, string, number]> = [];
  for (const [key, count] of pairCount.entries()) {
    const [fnA, fnB] = key.split('||');
    const minAppearances = Math.min(
      fnCount.get(fnA) || 0,
      fnCount.get(fnB) || 0,
    );
    if (minAppearances === 0) continue;
    const rate = count / minAppearances;
    if (rate >= coOccurrenceThreshold) {
      coLocatedPairs.push([fnA, fnB, rate]);
    }
  }

  if (coLocatedPairs.length === 0) return [];

  // Union-find to merge overlapping pairs into groups
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const [fnA, fnB] of coLocatedPairs) {
    union(fnA, fnB);
  }

  // Collect groups
  const groupMap = new Map<string, Set<string>>();
  for (const [fnA, fnB] of coLocatedPairs) {
    const root = find(fnA);
    if (!groupMap.has(root)) groupMap.set(root, new Set());
    groupMap.get(root)!.add(fnA);
    groupMap.get(root)!.add(fnB);
  }

  // Build result lookup
  const resultByFn = new Map<string, RelocationResult>();
  for (const r of results) {
    resultByFn.set(r.functionName, r);
  }

  // Build CoLocationGroups
  const groups: CoLocationGroup[] = [];
  for (const members of groupMap.values()) {
    const functions = Array.from(members);
    const services = [
      ...new Set(
        functions
          .map(fn => resultByFn.get(fn)?.currentService)
          .filter(Boolean) as string[],
      ),
    ];

    // Compute group-level co-occurrence rate (min pairwise rate)
    let minRate = 1.0;
    for (const [fnA, fnB, rate] of coLocatedPairs) {
      if (members.has(fnA) && members.has(fnB)) {
        minRate = Math.min(minRate, rate);
      }
    }

    // Determine action: if all suggest the same target, move together
    const suggestedServices = new Set(
      functions
        .map(fn => resultByFn.get(fn)?.suggestedService)
        .filter(Boolean) as string[],
    );

    const suggestedAction: CoLocationGroup['suggestedAction'] =
      suggestedServices.size <= 1 ? 'move-together' : 'extract-shared';

    groups.push({
      functions,
      services,
      coOccurrenceRate: Math.round(minRate * 1000) / 1000,
      suggestedAction,
    });
  }

  return groups;
}
