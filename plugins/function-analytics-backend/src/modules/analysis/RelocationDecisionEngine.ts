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

import { FunctionAnalysis, RelocationResult } from '../../lib/types';
import { FraConfig } from '../config/FraConfig';

/**
 * Applies decision logic to determine which functions should be relocated.
 *
 * Decision Rules (Methodology Phase 4):
 *   - Step 1: externalCalls >= externalCallThreshold (default 65%) of total
 *   - Step 2: dominantPercent > internalPercent + confidenceMargin (default 5%)
 *
 * Thresholds are now read from FraConfig instead of being hardcoded constants,
 * which is the only behaviour change vs the original lib/decision.ts.
 * Defaults match the original values.
 *
 * Phase 4 will add sampleConfidence and circularDependencyRisk fields.
 */
export function applyDecisionLogic(
  list: FunctionAnalysis[],
  config: FraConfig = new FraConfig(),
): RelocationResult[] {
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

    const totalCalls = internalCalls + externalCalls;
    const internalPercent = totalCalls > 0 ? internalCalls / totalCalls : 0;
    const externalPercent = totalCalls > 0 ? externalCalls / totalCalls : 0;

    const meetsThreshold = externalPercent >= config.externalCallThreshold;
    const meetsMargin =
      dominantPercent > internalPercent + config.confidenceMargin;
    const isMisplaced = meetsThreshold && meetsMargin;

    let suggestedService: string | null = null;
    let recommendation: 'relocate' | 'keep' | 'review' = 'keep';

    if (isMisplaced) {
      if (dominantCaller === currentService || dominantCaller.startsWith('external')) {
        recommendation = 'review';
        suggestedService = null;
      } else {
        recommendation = 'relocate';
        suggestedService = dominantCaller;
      }
    }

    const predictedLatencyImprovement =
      (avgExternalLatency - avgInternalLatency) * externalCalls;

    results.push({
      functionName,
      currentService,
      suggestedService,
      internalCalls,
      externalCalls,
      dominantCaller,
      dominantPercent: Math.round(dominantPercent * 100) / 100,
      predictedLatencyImprovement:
        Math.round(predictedLatencyImprovement * 100) / 100,
      recommendation,
    });
  }

  return results.sort(
    (a, b) => b.predictedLatencyImprovement - a.predictedLatencyImprovement,
  );
}
