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

import { FunctionAnalysis, RelocationResult, RiskLevel } from '../../lib/types';
import { FraConfig } from '../config/FraConfig';

// ─── Confidence tuning ───────────────────────────────────────────────────────
// A function needs this many total observations to receive full confidence.
const FULL_CONFIDENCE_SAMPLES = 50;

// A function is a "shared utility" when ≥2 distinct external callers each
// contribute at least this fraction of total calls.
const SHARED_UTILITY_CALLER_THRESHOLD = 0.15;

// ─── Cohesion helpers ────────────────────────────────────────────────────────
/**
 * Computes a simple cohesion score for a service:
 *   cohesion = internalCalls / (internalCalls + externalCalls)
 * Returns 1.0 when a service has no external calls.
 */
function cohesionScore(internal: number, external: number): number {
  const total = internal + external;
  return total > 0 ? internal / total : 1.0;
}

/**
 * Computes how much system-wide cohesion improves (delta > 0 = improvement)
 * if `fn` is moved from `currentService` to `targetService`.
 *
 * We approximate each service's call pool by summing the contributions of all
 * functions we have data for that belong to that service.
 */
function computeCohesionDelta(
  fn: FunctionAnalysis,
  allFunctions: FunctionAnalysis[],
): number {
  const current = fn.currentService;
  const target = fn.dominantCaller;

  // Aggregate existing totals for each affected service
  let curInternal = 0;
  let curExternal = 0;
  let tgtInternal = 0;
  let tgtExternal = 0;

  for (const f of allFunctions) {
    if (f.currentService === current) {
      curInternal += f.internalCalls;
      curExternal += f.externalCalls;
    } else if (f.currentService === target) {
      tgtInternal += f.internalCalls;
      tgtExternal += f.externalCalls;
    }
  }

  const curCohesionBefore = cohesionScore(curInternal, curExternal);
  const tgtCohesionBefore = cohesionScore(tgtInternal, tgtExternal);

  // After relocation: fn leaves current service, joins target service.
  // External calls that crossed the boundary become internal in target,
  // and internal calls in current service that touched this fn become external.
  const curCohesionAfter = cohesionScore(
    curInternal - fn.internalCalls,
    curExternal - fn.externalCalls + fn.internalCalls, // previously internal, now cross-boundary
  );
  const tgtCohesionAfter = cohesionScore(
    tgtInternal + fn.externalCalls, // calls that were external to target become internal
    tgtExternal - fn.externalCalls, // those same calls are no longer external
  );

  const delta =
    curCohesionAfter -
    curCohesionBefore +
    (tgtCohesionAfter - tgtCohesionBefore);

  return Math.round(delta * 1000) / 1000;
}

/**
 * Detects whether relocating `fn` to `targetService` would create a circular
 * dependency given the current inter-service call graph.
 *
 * We model edges as: for every function f in service A that has externalCalls
 * to service B, there is a directed edge A → B.
 * A circular risk exists when targetService already has a call path back to
 * currentService (i.e. targetService → ... → currentService).
 */
function hasCircularRisk(
  fn: FunctionAnalysis,
  allFunctions: FunctionAnalysis[],
): boolean {
  const current = fn.currentService;
  const target = fn.dominantCaller;
  if (!target || target === current || target.startsWith('external'))
    return false;

  // Build directed call graph: service → set of services it calls
  const callGraph = new Map<string, Set<string>>();
  for (const f of allFunctions) {
    if (!callGraph.has(f.currentService))
      callGraph.set(f.currentService, new Set());
    for (const caller of Object.keys(f.callerServices)) {
      // caller → f.currentService (reverse: currentService is callee)
      if (!callGraph.has(caller)) callGraph.set(caller, new Set());
      callGraph.get(caller)!.add(f.currentService);
    }
  }

  // BFS from current — can current reach target?
  // If yes, moving fn to target would create a cycle: current → target → ... → current.
  // (Do NOT start from target: target always has a direct edge to current because
  //  target is the dominant caller — that edge is exactly why we're considering relocation.
  //  Starting from target trivially returns true for every misplaced function.)
  const visited = new Set<string>();
  const queue: string[] = [current];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === target) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of callGraph.get(node) || []) {
      queue.push(next);
    }
  }
  return false;
}

/**
 * Computes a composite priority score (0–1) for ranking recommendations.
 * Higher = more urgent to act on.
 */
function computePriorityScore(
  externalPercent: number,
  p95ExternalLatency: number,
  p95InternalLatency: number,
  confidence: number,
  cohesionDelta: number,
): number {
  // Component 1: external-call ratio (0–1, already normalized)
  const externalRatioScore = externalPercent;

  // Component 2: normalized latency penalty
  // P95 cross-service penalty relative to a 500ms ceiling
  const MAX_LATENCY_MS = 500;
  const latencyPenalty = Math.min(
    Math.max(p95ExternalLatency - p95InternalLatency, 0) / MAX_LATENCY_MS,
    1,
  );

  // Component 3: confidence (0–1, already computed)
  const confidenceScore = confidence;

  // Component 4: cohesion improvement (delta is typically -0.5 to +0.5, normalize to 0–1)
  const cohesionImprovement = Math.min(
    Math.max((cohesionDelta + 0.5) / 1.0, 0),
    1,
  );

  return (
    externalRatioScore * 0.4 +
    latencyPenalty * 0.3 +
    confidenceScore * 0.2 +
    cohesionImprovement * 0.1
  );
}

/**
 * Assigns a risk level based on the external-call percentage.
 */
function computeRiskLevel(externalPercent: number): RiskLevel {
  if (externalPercent >= 0.85) return 'HIGH';
  if (externalPercent >= 0.75) return 'MEDIUM';
  if (externalPercent >= 0.65) return 'LOW';
  return 'NONE';
}

/**
 * Determines whether a function is a shared utility — called substantially
 * by two or more distinct external services.
 */
function detectSharedUtility(fn: FunctionAnalysis): boolean {
  const totalCalls = fn.internalCalls + fn.externalCalls;
  if (totalCalls === 0) return false;
  const significantCallers = Object.values(fn.callerServices).filter(
    count => count / totalCalls >= SHARED_UTILITY_CALLER_THRESHOLD,
  );
  return significantCallers.length >= 2;
}

/**
 * Applies decision logic to determine which functions should be relocated,
 * kept, reviewed, or extracted to a shared service.
 *
 * Decision flow:
 *  1. Compute external-call percentage and risk level.
 *  2. If external% >= threshold AND dominantCaller has margin over internal%:
 *       a. Shared utility (≥2 significant callers) → 'extract'
 *       b. Circular dependency risk → 'review'
 *       c. Concrete dominant caller              → 'relocate'
 *       d. No concrete caller                   → 'review'
 *  3. Otherwise → 'keep'
 *  4. Annotate with confidence, cohesionDelta, riskLevel.
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
      sampleCount,
    } = analysis;

    const totalCalls = internalCalls + externalCalls;
    const internalPercent = totalCalls > 0 ? internalCalls / totalCalls : 0;
    const externalPercent = totalCalls > 0 ? externalCalls / totalCalls : 0;

    // ── Confidence (penalized by volatility) ────────────────────────────
    const rawConfidence = Math.min(sampleCount / FULL_CONFIDENCE_SAMPLES, 1.0);
    const patternStability = analysis.patternStability ?? 1.0;
    const confidence = rawConfidence * patternStability;

    // ── Risk level ────────────────────────────────────────────────────────
    const riskLevel = computeRiskLevel(externalPercent);

    // ── Shared utility detection ──────────────────────────────────────────
    const isSharedUtility = detectSharedUtility(analysis);

    // ── Primary placement decision ────────────────────────────────────────
    const meetsThreshold = externalPercent >= config.externalCallThreshold;
    const meetsMargin =
      dominantPercent > internalPercent + config.confidenceMargin;
    const isMisplaced = meetsThreshold && meetsMargin;

    let suggestedService: string | null = null;
    let recommendation: RelocationResult['recommendation'] = 'keep';
    let circularRisk = false;

    if (isMisplaced) {
      if (isSharedUtility) {
        recommendation = 'extract';
        suggestedService = null; // caller should create a shared service
      } else if (
        dominantCaller &&
        dominantCaller !== currentService &&
        !dominantCaller.startsWith('external')
      ) {
        circularRisk = hasCircularRisk(analysis, list);
        if (circularRisk) {
          recommendation = 'review';
          suggestedService = dominantCaller; // show the candidate but flag the risk
        } else {
          recommendation = 'relocate';
          suggestedService = dominantCaller;
        }
      } else {
        recommendation = 'review';
        suggestedService = null;
      }
    }

    // ── Cohesion delta ────────────────────────────────────────────────────
    const cohesionDelta =
      recommendation === 'relocate' || recommendation === 'review'
        ? computeCohesionDelta(analysis, list)
        : 0;

    // ── Predicted latency improvement ─────────────────────────────────────
    const predictedLatencyImprovement =
      (avgExternalLatency - avgInternalLatency) * externalCalls;

    // ── Composite priority score ─────────────────────────────────────────
    const priorityScore = computePriorityScore(
      externalPercent,
      analysis.p95ExternalLatency,
      analysis.p95InternalLatency,
      confidence,
      cohesionDelta,
    );

    // ── Static coverage: uncovered functions with no samples always keep ──
    const staticCoverage = analysis.staticCoverage ?? 'unknown';
    if (staticCoverage === 'uncovered' && sampleCount === 0) {
      recommendation = 'keep';
      suggestedService = null;
    }

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
      confidence: Math.round(confidence * 100) / 100,
      cohesionDelta,
      riskLevel,
      isSharedUtility,
      circularRisk,
      priorityScore: Math.round(priorityScore * 1000) / 1000,
      patternStability: Math.round(patternStability * 1000) / 1000,
      staticCoverage,
    });
  }

  // Sort: misplaced functions first (by predicted latency improvement), then keep/review
  return results.sort((a, b) => {
    const rankOrder = { relocate: 0, extract: 1, review: 2, keep: 3 };
    const rankDiff = rankOrder[a.recommendation] - rankOrder[b.recommendation];
    if (rankDiff !== 0) return rankDiff;
    return b.priorityScore - a.priorityScore;
  });
}
