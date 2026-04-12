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

import { FunctionAnalysis } from './types';
import { DiscoveredService } from '../modules/discovery/ServiceDiscoveryEngine';
import { FraConfig } from '../modules/config/FraConfig';

// ─── Normalized Data Types ─────────────────────────────────────────────────
// These decouple all providers from any specific tracing backend format.

/** Backend-agnostic representation of a single span. */
export interface NormalizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  /** Start time in microseconds since epoch */
  startTime: number;
  /** Duration in microseconds */
  duration: number;
  /** Flattened tag map (Jaeger's {key,value}[] is converted here) */
  tags: Record<string, string>;
  spanKind?: 'client' | 'server' | 'producer' | 'consumer' | 'internal';
}

/** Backend-agnostic representation of a distributed trace. */
export interface NormalizedTrace {
  traceId: string;
  spans: NormalizedSpan[];
}

/** Parameters for fetching traces from a TraceSourceProvider. */
export interface TraceQuery {
  /** Specific service name, or 'all' to fetch for every known service */
  service?: string;
  /** How far back to look for traces, in hours */
  lookbackHours: number;
  /** Maximum number of traces to fetch per service */
  maxTraces: number;
}

/** Result from a deployment operation. */
export interface DeployResult {
  servicesStarted: string[];
  errors: Array<{ service: string; error: string }>;
}

// Re-export for convenience so consumers only import from providers.ts
export type { DiscoveredService };

// ─── Provider Interfaces ───────────────────────────────────────────────────

/**
 * Abstracts where traces come from (Jaeger, Zipkin, OTLP/Tempo, etc.).
 * Implementations normalize raw backend data into NormalizedTrace/Span.
 */
export interface TraceSourceProvider {
  /** Identifier for this provider type (e.g. 'jaeger', 'zipkin', 'otlp') */
  readonly type: string;

  /** Returns all service names known to the tracing backend. */
  listServices(): Promise<string[]>;

  /** Fetches and normalizes traces according to the query parameters. */
  fetchTraces(query: TraceQuery): Promise<NormalizedTrace[]>;
}

/**
 * Abstracts how deployable services are discovered in a repository.
 * Each provider covers a different repo layout or infrastructure model.
 */
export interface ServiceInventoryProvider {
  /** Identifier for this provider type (e.g. 'docker-compose', 'monorepo', 'k8s') */
  readonly type: string;

  /** Discovers runnable services at the given path. */
  discoverServices(repoPath: string): Promise<DiscoveredService[]>;
}

/**
 * A single step in the span processing pipeline.
 * Return the (possibly modified) span to keep it, or undefined to drop it.
 * Processors are applied in order — the chain short-circuits on drop.
 */
export interface SpanProcessor {
  /** Human-readable name for logging/debugging */
  readonly name: string;

  /**
   * Process a single span in the context of its parent trace.
   * @returns The span (possibly enriched) to keep, or undefined to drop.
   */
  process(span: NormalizedSpan, trace: NormalizedTrace): NormalizedSpan | undefined;
}

/**
 * Extracts a clean function name from a normalized span.
 * Resolvers are tried in priority order — first non-undefined result wins.
 */
export interface FunctionNameResolver {
  /** Human-readable name for logging/debugging */
  readonly name: string;

  /**
   * Attempt to resolve a function name from the span.
   * @returns A clean function name, or undefined if this resolver cannot handle the span.
   */
  resolve(span: NormalizedSpan): string | undefined;
}

/**
 * Maps a Backstage catalog entity name to the name used in telemetry.
 * Resolvers are tried in priority order — first non-undefined result wins.
 */
export interface ServiceNameResolver {
  /** Human-readable name for logging/debugging */
  readonly name: string;

  /**
   * Attempt to map a catalog name to a telemetry name.
   * @param catalogName - The service name as known in the Backstage catalog.
   * @param knownTelemetryNames - All service names known to the tracing backend.
   * @returns The matched telemetry name, or undefined if no match found.
   */
  resolve(catalogName: string, knownTelemetryNames: string[]): string | undefined;
}

/**
 * Strategy for analyzing processed traces and producing function placement statistics.
 * The default implementation (CohesionAnalyzer) uses external-call-percentage thresholds.
 */
export interface AnalysisStrategy {
  /** Human-readable name for logging/debugging */
  readonly name: string;

  /**
   * Analyze processed traces and return per-function statistics.
   * Spans have already been filtered (processors) and enriched with function names (resolvers).
   * @param traces - Processed and filtered traces.
   * @param config - FRA configuration for thresholds.
   * @returns Function-level analysis results.
   */
  analyze(
    traces: NormalizedTrace[],
    config: FraConfig,
  ): Promise<FunctionAnalysis[]>;
}

/**
 * Abstracts how services are deployed, instrumented, and traffic-tested.
 */
export interface DeploymentProvider {
  /** Identifier for this provider type (e.g. 'docker-compose', 'k8s', 'noop') */
  readonly type: string;

  /** Deploy and instrument services from the given repo path. */
  deploy(services: DiscoveredService[], repoPath: string): Promise<DeployResult>;

  /** Generate synthetic traffic for a service. Returns the number of requests sent. */
  generateTraffic(service: string, requestCount: number): Promise<number>;

  /** Tear down previously deployed services. */
  teardown(services: DiscoveredService[]): Promise<void>;
}
