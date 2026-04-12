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

import {
  ServiceMetrics,
  FunctionCall,
  FunctionPlacementAnalysis,
  RiskLevel,
} from './types';

// ─── Thresholds ─────────────────────────────────────────────────────────────
const EXTERNAL_CALL_THRESHOLD = 0.65;
const CONFIDENCE_MIN_SAMPLES = 50;
const SHARED_UTILITY_CALLER_THRESHOLD = 0.15;

// ─── Risk level ──────────────────────────────────────────────────────────────
function computeRiskLevel(externalPct: number): RiskLevel {
  if (externalPct >= 0.85) return 'HIGH';
  if (externalPct >= 0.75) return 'MEDIUM';
  if (externalPct >= 0.65) return 'LOW';
  return 'NONE';
}

// ─── Backend RelocationResult shape (what /analyze returns) ─────────────────
interface BackendRelocationResult {
  functionName: string;
  currentService: string;
  suggestedService: string | null;
  internalCalls: number;
  externalCalls: number;
  dominantCaller: string;
  dominantPercent: number;
  predictedLatencyImprovement: number;
  recommendation: 'relocate' | 'keep' | 'review' | 'extract';
  confidence?: number;
  cohesionDelta?: number;
  riskLevel?: RiskLevel;
  isSharedUtility?: boolean;
  circularRisk?: boolean;
}

/**
 * Maps a backend RelocationResult to the frontend FunctionPlacementAnalysis shape.
 * Use this when displaying results from GET /api/function-analytics/analyze.
 */
export function mapBackendResult(
  r: BackendRelocationResult,
): FunctionPlacementAnalysis {
  const totalCalls = r.internalCalls + r.externalCalls;
  const externalPct = totalCalls > 0 ? r.externalCalls / totalCalls : 0;
  const internalPct = 1 - externalPct;
  const riskLevel = r.riskLevel ?? computeRiskLevel(externalPct);

  const shouldRelocate =
    r.recommendation === 'relocate' || r.recommendation === 'extract';

  let relocateReason = '';
  if (r.recommendation === 'relocate') {
    relocateReason = `${Math.round(
      externalPct * 100,
    )}% external calls. Dominant caller: ${r.dominantCaller} (${Math.round(
      r.dominantPercent * 100,
    )}%). Suggested: ${r.suggestedService}.`;
  } else if (r.recommendation === 'extract') {
    relocateReason = `Shared utility — called by multiple services. Consider extracting to a shared library.`;
  } else if (r.recommendation === 'review') {
    relocateReason = r.circularRisk
      ? `${Math.round(
          externalPct * 100,
        )}% external calls but relocation would create a circular dependency. Manual review required.`
      : `${Math.round(
          externalPct * 100,
        )}% external calls. No clear target service identified.`;
  } else {
    relocateReason = `Well-placed. ${Math.round(
      internalPct * 100,
    )}% internal calls.`;
  }

  // Map HIGH/MEDIUM/LOW for securityRisk (legacy field)
  let legacyRisk: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  if (riskLevel === 'HIGH') legacyRisk = 'HIGH';
  else if (riskLevel === 'MEDIUM') legacyRisk = 'MEDIUM';

  return {
    functionName: r.functionName,
    serviceName: r.currentService,
    currentService: r.currentService,
    suggestedService: r.suggestedService,
    totalCalls,
    internalCalls: r.internalCalls,
    externalCalls: r.externalCalls,
    internalCallPercentage: Math.round(internalPct * 100),
    externalCallPercentage: Math.round(externalPct * 100),
    dominantCaller: r.dominantCaller,
    dominantPercent: r.dominantPercent,
    shouldRelocate,
    relocateReason,
    suggestedTargetService: r.suggestedService || '',
    recommendation: r.recommendation,
    riskLevel,
    securityRisk: legacyRisk,
    latencyImpact: r.predictedLatencyImprovement,
    predictedLatencyImprovement: r.predictedLatencyImprovement,
    crossServiceCallCount: r.externalCalls,
    confidence: r.confidence ?? 1,
    cohesionDelta: r.cohesionDelta ?? 0,
    isSharedUtility: r.isSharedUtility ?? false,
    circularRisk: r.circularRisk ?? false,
  };
}

/**
 * Analyzes microservice architecture to identify dependencies,
 * critical paths, and performance bottlenecks.
 */
export const analyzeMicroserviceArchitecture = (
  services: ServiceMetrics[],
): {
  serviceMap: Map<string, string[]>;
  dependencyGraph: Map<string, string[]>;
  criticalPaths: string[][];
  bottlenecks: string[];
} => {
  const serviceMap = new Map<string, string[]>();
  const dependencyGraph = new Map<string, string[]>();
  const criticalPaths: string[][] = [];
  const bottlenecks: string[] = [];

  services.forEach(service => {
    const dependencies = new Set<string>();
    service.functions.forEach(func => {
      func.dependencies.forEach(dep => dependencies.add(dep));
    });
    serviceMap.set(service.serviceName, Array.from(dependencies));
    dependencyGraph.set(service.serviceName, Array.from(dependencies));
  });

  services.forEach(service => {
    const highExternalServices = service.functions
      .filter(func => func.externalCalls > func.internalCalls)
      .map(func => func.serviceName);

    if (highExternalServices.length > 0) {
      criticalPaths.push([service.serviceName, ...highExternalServices]);
    }
  });

  services.forEach(service => {
    if (service.avgLatency > 1000 || service.errorRate > 5) {
      bottlenecks.push(service.serviceName);
    }
  });

  return { serviceMap, dependencyGraph, criticalPaths, bottlenecks };
};

/**
 * Analyzes function placement from frontend-collected FunctionCall data.
 *
 * Enhanced over the original:
 * - Computes confidence score based on sample count.
 * - Detects shared utilities (called by ≥2 distinct external services).
 * - Assigns riskLevel (HIGH / MEDIUM / LOW / NONE).
 * - Fills all new FunctionPlacementAnalysis fields.
 *
 * This runs client-side when the backend /analyze endpoint is unavailable
 * or for real-time analysis of hybrid-mode service data.
 */
export const analyzeFunctionPlacement = (
  functions: FunctionCall[],
): FunctionPlacementAnalysis[] => {
  return functions.map(func => {
    const totalCalls = func.internalCalls + func.externalCalls;
    const externalPct = totalCalls > 0 ? func.externalCalls / totalCalls : 0;
    const internalPct = 1 - externalPct;

    const confidence = Math.min(totalCalls / CONFIDENCE_MIN_SAMPLES, 1.0);
    const riskLevel = computeRiskLevel(externalPct);

    // Dominant external caller
    let dominantCaller = '';
    let maxCount = 0;
    for (const [svc, count] of Object.entries(func.externalCallFrequency)) {
      if (count > maxCount) {
        maxCount = count;
        dominantCaller = svc;
      }
    }
    const dominantPercent = totalCalls > 0 ? maxCount / totalCalls : 0;

    // Shared utility detection
    const significantCallers = Object.values(func.externalCallFrequency).filter(
      c => c / totalCalls >= SHARED_UTILITY_CALLER_THRESHOLD,
    );
    const isSharedUtility = significantCallers.length >= 2;

    const shouldRelocate = externalPct > EXTERNAL_CALL_THRESHOLD;

    let recommendation: FunctionPlacementAnalysis['recommendation'] = 'keep';
    let suggestedTargetService = '';
    let relocateReason = '';

    if (shouldRelocate) {
      if (isSharedUtility) {
        recommendation = 'extract';
        relocateReason = `Shared utility — called by ${
          Object.keys(func.externalCallFrequency).length
        } distinct services. Extract to a shared library.`;
      } else if (dominantCaller) {
        recommendation = 'relocate';
        suggestedTargetService = dominantCaller;
        relocateReason = `${Math.round(
          externalPct * 100,
        )}% external calls. Dominant caller: ${dominantCaller} (${Math.round(
          dominantPercent * 100,
        )}%).`;
      } else {
        recommendation = 'review';
        relocateReason = `${Math.round(
          externalPct * 100,
        )}% external calls but no clear target service.`;
      }
    } else {
      relocateReason = `Well-placed. ${Math.round(
        internalPct * 100,
      )}% internal calls.`;
    }

    let legacyRisk: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    if (riskLevel === 'HIGH') legacyRisk = 'HIGH';
    else if (riskLevel === 'MEDIUM') legacyRisk = 'MEDIUM';

    return {
      functionName: func.functionName,
      serviceName: func.serviceName,
      currentService: func.serviceName,
      suggestedService: suggestedTargetService || null,
      totalCalls,
      internalCalls: func.internalCalls,
      externalCalls: func.externalCalls,
      internalCallPercentage: Math.round(internalPct * 100),
      externalCallPercentage: Math.round(externalPct * 100),
      dominantCaller,
      dominantPercent,
      shouldRelocate,
      relocateReason,
      suggestedTargetService,
      recommendation,
      riskLevel,
      securityRisk: legacyRisk,
      latencyImpact: func.crossServiceCallLatency,
      predictedLatencyImprovement: 0,
      crossServiceCallCount: func.externalCalls,
      confidence,
      cohesionDelta: 0,
      isSharedUtility,
      circularRisk: false,
    };
  });
};
