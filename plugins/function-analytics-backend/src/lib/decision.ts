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

import { FunctionAnalysis, RelocationResult } from './types';

/**
 * Decision threshold: function is misplaced if dominant external caller
 * represents at least 60% of calls
 */
const DOMINANT_THRESHOLD = 0.60;

/**
 * Applies decision logic to determine which functions should be relocated
 * 
 * Decision Rules:
 * - A function is "misplaced" if:
 *   1. externalCalls > internalCalls
 *   2. dominantPercent >= 0.60
 * 
 * @param list - Array of function analysis results
 * @returns Array of relocation recommendations
 */
export function applyDecisionLogic(list: FunctionAnalysis[]): RelocationResult[] {
  const results: RelocationResult[] = [];

  for (const analysis of list) {
    const {
      functionName,
      currentService,
      internalCalls,
      externalCalls,
      dominantCaller,
      dominantPercent,
      avgInternalLatency,
      avgExternalLatency,
    } = analysis;

    // Determine if function should be relocated
    const isMisplaced = 
      externalCalls > internalCalls && 
      dominantPercent >= DOMINANT_THRESHOLD;

    // Determine suggested service
    let suggestedService: string | null = null;
    let recommendation: 'relocate' | 'keep' | 'review' = 'keep';

    if (isMisplaced) {
      // Check for circular dependency risk
      if (dominantCaller === currentService) {
        recommendation = 'review';
        suggestedService = null;
      } else {
        recommendation = 'relocate';
        suggestedService = dominantCaller;
      }
    }

    // Calculate predicted latency improvement
    // Simple model: external calls become internal if relocated
    // Improvement = (avgExternalLatency - avgInternalLatency) * externalCalls
    const predictedLatencyImprovement = 
      (avgExternalLatency - avgInternalLatency) * externalCalls;

    results.push({
      functionName,
      currentService,
      suggestedService,
      internalCalls,
      externalCalls,
      dominantCaller,
      dominantPercent: Math.round(dominantPercent * 100) / 100, // Round to 2 decimals
      predictedLatencyImprovement: Math.round(predictedLatencyImprovement * 100) / 100,
      recommendation,
    });
  }

  // Sort by predicted improvement (highest first)
  return results.sort((a, b) => 
    b.predictedLatencyImprovement - a.predictedLatencyImprovement
  );
}
