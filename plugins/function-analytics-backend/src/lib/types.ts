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

/**
 * Represents a cleaned function call from trace data
 */
export interface CleanedCall {
  functionName: string;
  callerService: string;
  calleeService: string;
  latency: number;
}

/**
 * Analysis results for a single function.
 * Extended with per-caller breakdown and sample count for confidence scoring.
 */
export interface FunctionAnalysis {
  functionName: string;
  currentService: string;
  internalCalls: number;
  externalCalls: number;
  dominantCaller: string;
  dominantPercent: number;
  avgInternalLatency: number;
  avgExternalLatency: number;
  /** Total calls observed — used to compute confidence (low sample = low confidence). */
  sampleCount: number;
  /** All external callers and their call counts. Used for bidirectional detection. */
  callerServices: Record<string, number>;
}

/** Risk level assigned based on how strongly a function is misplaced. */
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/**
 * Final relocation recommendation result.
 * Extended with quality metrics for better decision support.
 */
export interface RelocationResult {
  functionName: string;
  currentService: string;
  suggestedService: string | null;
  internalCalls: number;
  externalCalls: number;
  dominantCaller: string;
  dominantPercent: number;
  predictedLatencyImprovement: number;
  recommendation: 'relocate' | 'keep' | 'review' | 'extract';

  /**
   * Statistical confidence 0–1.
   * < 0.5  = fewer than MIN_SAMPLES observations (treat with caution)
   * >= 1.0 = fully reliable (>= MIN_SAMPLES observations)
   */
  confidence: number;

  /**
   * Projected improvement in system-wide cohesion if the relocation is applied.
   * Positive = cohesion improves; 0 = neutral.
   */
  cohesionDelta: number;

  /** Risk level derived from the external-call percentage. */
  riskLevel: RiskLevel;

  /**
   * True when the function is called substantially by TWO OR MORE different
   * external services — relocation to one side hurts the other.
   * Recommendation becomes 'extract' (move to a shared library/service).
   */
  isSharedUtility: boolean;

  /**
   * True when relocating this function to suggestedService would create a
   * circular dependency between the two services.
   */
  circularRisk: boolean;
}

/**
 * A single entry in a per-service function registry built by static analysis.
 */
export interface RegistryFunction {
  name: string;
  /** Class or module name, if applicable. */
  className?: string;
  /** Source file relative to service root. */
  file: string;
  /** Language of the owning service. */
  language: string;
}

/**
 * Complete function registry for one service, produced by FunctionRegistryBuilder.
 */
export interface ServiceFunctionRegistry {
  service: string;
  language: string;
  functions: RegistryFunction[];
  /** ISO timestamp when the registry was built. */
  builtAt: string;
}
