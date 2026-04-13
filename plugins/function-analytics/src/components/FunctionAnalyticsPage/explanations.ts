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

import { RelocationResult } from '../../api/FunctionAnalyticsClient';

export function generateExplanation(result: RelocationResult): string {
  const totalCalls = result.internalCalls + result.externalCalls;
  const externalPct = totalCalls > 0 ? Math.round((result.externalCalls / totalCalls) * 100) : 0;

  if (result.recommendation === 'relocate') {
    return `This function is called ${result.externalCalls}x (${Math.round(result.dominantPercent * 100)}%) by ${result.dominantCaller}. It currently lives in ${result.currentService} but most of its work benefits ${result.suggestedService}. Moving it would improve service cohesion by ${result.cohesionDelta} and reduce cross-service latency by approximately ${result.predictedLatencyImprovement.toFixed(1)}ms.`;
  }

  if (result.recommendation === 'review' && result.circularRisk) {
    return `This function is likely misplaced (${result.externalCalls}x external calls, ${externalPct}% external) but relocating to ${result.dominantCaller} would create a circular dependency. Consider introducing a shared interface or event-driven decoupling.`;
  }

  if (result.recommendation === 'review') {
    return `This function has ${externalPct}% external calls (${result.externalCalls}x) from ${result.dominantCaller}. It may be misplaced but requires manual architectural review before relocating.`;
  }

  if (result.recommendation === 'extract' && result.isSharedUtility) {
    const callerCount = result.callerServices ? Object.keys(result.callerServices).length : 2;
    return `This function is called substantially by ${callerCount} different services. Moving it to one would disadvantage the others. Consider extracting it to a shared library or dedicated utility service.`;
  }

  if (result.recommendation === 'extract') {
    return `This function is used by multiple services. Consider extracting it to a shared library or utility service to reduce cross-service coupling.`;
  }

  // keep
  return `This function is well-placed. ${result.internalCalls}x internal calls vs ${result.externalCalls}x external calls — it belongs in ${result.currentService}.`;
}
