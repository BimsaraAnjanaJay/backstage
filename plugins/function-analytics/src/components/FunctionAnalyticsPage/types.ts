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

import { Entity } from '@backstage/catalog-model';

/**
 * Represents a function call with detailed metrics and metadata
 */
export interface FunctionCall {
  functionName: string;
  serviceName: string;
  type: 'internal' | 'external';
  latency: number;
  errorRate: number;
  callCount: number;
  internalCalls: number;
  externalCalls: number;
  externalCallTargets: string[];
  externalCallFrequency: Record<string, number>;
  crossServiceCallLatency: number;
  dependencies: string[];
  timestamp: string;
  httpMethod?: string;
  httpPath?: string;
  grpcMethod?: string;
  messageQueue?: string;
  eventType?: string;
  databaseOperation?: string;
  microserviceType?: 'api' | 'service' | 'worker' | 'scheduler' | 'gateway';
  version?: string;
  namespace?: string;
}

/**
 * Aggregated metrics for a service
 */
export interface ServiceMetrics {
  serviceName: string;
  totalCalls: number;
  avgLatency: number;
  errorRate: number;
  functions: FunctionCall[];
  source: 'catalog' | 'manual' | 'auto';
  owner?: string;
  environment?: string;
}

/** Risk level from backend analysis. */
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/**
 * Analysis result for function placement optimization.
 * Matches RelocationResult from function-analytics-backend.
 */
export interface FunctionPlacementAnalysis {
  functionName: string;
  serviceName: string; // currentService
  currentService: string;
  suggestedService: string | null;
  totalCalls: number;
  internalCalls: number;
  externalCalls: number;
  internalCallPercentage: number;
  externalCallPercentage: number;
  dominantCaller: string;
  dominantPercent: number;
  shouldRelocate: boolean;
  relocateReason: string;
  suggestedTargetService: string;
  /** Unified recommendation from backend: 'relocate' | 'keep' | 'review' | 'extract' */
  recommendation: 'relocate' | 'keep' | 'review' | 'extract';
  /** Risk level based on external call percentage */
  riskLevel: RiskLevel;
  /** @deprecated use riskLevel */
  securityRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  latencyImpact: number;
  predictedLatencyImprovement: number;
  crossServiceCallCount: number;
  /**
   * Statistical confidence 0–1 based on sample count.
   * Values < 0.5 should be treated with caution.
   */
  confidence: number;
  /**
   * Projected change in system cohesion if relocation is applied.
   * Positive = improvement.
   */
  cohesionDelta: number;
  /**
   * True when ≥2 distinct services call this function substantially —
   * suggest extracting to a shared service/library rather than relocating.
   */
  isSharedUtility: boolean;
  /**
   * True when relocating to suggestedService would create a circular dependency.
   */
  circularRisk: boolean;
}

/**
 * Configuration for tracing backend systems (Jaeger, Zipkin, etc.)
 */
export interface TracingBackendConfig {
  type: 'jaeger' | 'zipkin' | 'tempo' | 'custom';
  name: string;
  endpoint: string;
  apiPath?: string;
  authType: 'none' | 'bearer' | 'apikey' | 'basic';
  authToken?: string;
  username?: string;
  password?: string;
  enabled: boolean;
}

/**
 * Configuration for services discovered from Backstage catalog
 */
export interface CatalogServiceConfig {
  entity: Entity;
  serviceName: string;
  tracingEndpoint?: string;
  jaegerServiceName?: string;
  isInstrumented: boolean;
  owner?: string;
  environment?: string;
}

/**
 * Configuration for manually added services
 */
export interface ManualServiceConfig {
  id: string;
  serviceName: string;
  displayName: string;
  jaegerServiceName?: string;
  tracingBackend: TracingBackendConfig;
  environment?: string;
  notes?: string;
}

/**
 * Combined configuration with connection status
 */
export interface HybridServiceConfig extends ServiceMetrics {
  config: CatalogServiceConfig | ManualServiceConfig;
  connectionStatus: 'connected' | 'disconnected' | 'checking' | 'unknown';
  lastChecked?: Date;
}

/**
 * Plugin operation mode
 */
export interface PluginMode {
  mode: 'hybrid' | 'catalog-only' | 'manual-only';
  description: string;
}
