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

import { CleanedCall, FunctionAnalysis } from './types';

/**
 * Analyzes function calls to determine internal vs external call patterns
 * and identify dominant callers
 * 
 * @param calls - Array of cleaned function calls
 * @returns Array of function analysis results
 */
export function analyzeFunctionCalls(calls: CleanedCall[]): FunctionAnalysis[] {
  // Group calls by function name and current service
  const functionGroups = new Map<string, CleanedCall[]>();

  for (const call of calls) {
    const key = `${call.functionName}@${call.calleeService}`;
    if (!functionGroups.has(key)) {
      functionGroups.set(key, []);
    }
    functionGroups.get(key)!.push(call);
  }

  const results: FunctionAnalysis[] = [];

  for (const [key, functionCalls] of Array.from(functionGroups.entries())) {
    const [functionName, currentService] = key.split('@');

    let internalCalls = 0;
    let externalCalls = 0;
    const callerCounts = new Map<string, number>();
    const internalLatencies: number[] = [];
    const externalLatencies: number[] = [];

    for (const call of functionCalls) {
      const isInternal = call.callerService === call.calleeService;

      if (isInternal) {
        internalCalls++;
        internalLatencies.push(call.latency);
      } else {
        externalCalls++;
        externalLatencies.push(call.latency);
      }

      // Track caller frequencies
      const caller = call.callerService;
      callerCounts.set(caller, (callerCounts.get(caller) || 0) + 1);
    }

    // Find dominant external caller
    let dominantCaller = 'none';
    let dominantCount = 0;

    for (const [caller, count] of Array.from(callerCounts.entries())) {
      if (caller !== currentService && count > dominantCount) {
        dominantCaller = caller;
        dominantCount = count;
      }
    }

    const totalCalls = internalCalls + externalCalls;
    const dominantPercent = totalCalls > 0 ? dominantCount / totalCalls : 0;

    // Calculate average latencies
    const avgInternalLatency = internalLatencies.length > 0
      ? internalLatencies.reduce((a, b) => a + b, 0) / internalLatencies.length
      : 0;

    const avgExternalLatency = externalLatencies.length > 0
      ? externalLatencies.reduce((a, b) => a + b, 0) / externalLatencies.length
      : 0;

    results.push({
      functionName,
      currentService,
      internalCalls,
      externalCalls,
      dominantCaller,
      dominantPercent,
      avgInternalLatency,
      avgExternalLatency,
    });
  }

  return results;
}
