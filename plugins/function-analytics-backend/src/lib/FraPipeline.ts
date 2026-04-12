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

import { LoggerService } from '@backstage/backend-plugin-api';
import {
  TraceQuery,
  NormalizedTrace,
  NormalizedSpan,
  AnalysisStrategy,
  FunctionNameResolver,
  SpanProcessor,
} from './providers';
import { FunctionAnalysis, RelocationResult } from './types';
import { ProviderRegistry } from './ProviderRegistry';
import { FraConfig } from '../modules/config/FraConfig';
import { applyDecisionLogic } from '../modules/analysis/RelocationDecisionEngine';

// ─── Minimum observations required to emit a result ────────────────────────
const MIN_SAMPLE_THRESHOLD = 5;

// ─── FRA custom attribute keys ─────────────────────────────────────────────
const FRA_CALLER_SERVICE_TAG = 'fra.caller_service';
const FRA_INVOCATION_TYPE_TAG = 'fra.invocation_type';
const FRA_HOST_SERVICE_TAG = 'fra.host_service';

/**
 * Intermediate per-function statistics built during analysis.
 */
interface FunctionStats {
  fn: string;
  service: string;
  internalCalls: number;
  externalCalls: number;
  internalLatencies: number[];
  externalLatencies: number[];
  callers: Map<string, number>;
}

/**
 * Default AnalysisStrategy using cohesion-based external-call-percentage scoring.
 *
 * Extracted from FunctionCallAnalyzer.ts analyzeFunctionCalls() lines 228-409.
 * Receives pre-processed spans (already filtered by processors and enriched
 * with function names by resolvers).
 */
export class CohesionAnalyzer implements AnalysisStrategy {
  readonly name = 'CohesionAnalyzer';

  async analyze(
    traces: NormalizedTrace[],
    _config: FraConfig,
  ): Promise<FunctionAnalysis[]> {
    const functionStats = new Map<string, FunctionStats>();

    for (const trace of traces) {
      for (const span of trace.spans) {
        // Resolved function name must be set by the pipeline (via tag)
        const functionName = span.tags['fra.resolved_function'];
        if (!functionName || functionName === 'unknown_function') continue;

        const serviceName = span.serviceName;

        // ── Determine caller service ──────────────────────────────────────
        let callerService: string = span.tags[FRA_CALLER_SERVICE_TAG] || '';

        if (!callerService || callerService === 'unknown') {
          // Use enriched parent service tag
          callerService = span.tags['fra.parent_service'] || '';
        }

        // Normalise artificial / test callers
        if (
          !callerService ||
          callerService === 'unknown' ||
          callerService.includes('backstage') ||
          callerService.includes('traffic-generator')
        ) {
          const fraType = span.tags[FRA_INVOCATION_TYPE_TAG];
          if (fraType === 'internal') {
            callerService = serviceName;
          } else {
            callerService = 'external (client)';
          }
        }

        // Skip backstage-generated probes
        if (callerService.includes('backstage-backend')) continue;

        // ── Determine invocation type ─────────────────────────────────────
        const fraInvocationType = span.tags[FRA_INVOCATION_TYPE_TAG];
        const isInternal =
          fraInvocationType === 'internal' ||
          (!fraInvocationType && callerService === serviceName);

        // Verify host service matches
        const fraHostService = span.tags[FRA_HOST_SERVICE_TAG];
        if (fraHostService && fraHostService !== serviceName) continue;

        const latencyMs = (span.duration || 0) / 1000;
        const key = `${serviceName}::${functionName}`;

        if (!functionStats.has(key)) {
          functionStats.set(key, {
            fn: functionName,
            service: serviceName,
            internalCalls: 0,
            externalCalls: 0,
            internalLatencies: [],
            externalLatencies: [],
            callers: new Map(),
          });
        }

        const stats = functionStats.get(key)!;

        if (isInternal) {
          stats.internalCalls++;
          stats.internalLatencies.push(latencyMs);
        } else {
          stats.externalCalls++;
          stats.externalLatencies.push(latencyMs);
          stats.callers.set(
            callerService,
            (stats.callers.get(callerService) || 0) + 1,
          );
        }
      }
    }

    const avg = (arr: number[]): number =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const percentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    };

    const results: FunctionAnalysis[] = [];

    for (const stats of functionStats.values()) {
      const totalCalls = stats.internalCalls + stats.externalCalls;
      if (totalCalls < MIN_SAMPLE_THRESHOLD) continue;

      let dominantCaller = 'none';
      let dominantCount = 0;
      const callerServices: Record<string, number> = {};
      for (const [caller, count] of stats.callers.entries()) {
        callerServices[caller] = count;
        if (count > dominantCount) {
          dominantCount = count;
          dominantCaller = caller;
        }
      }

      const dominantPercent = totalCalls > 0 ? dominantCount / totalCalls : 0;

      results.push({
        functionName: stats.fn,
        currentService: stats.service,
        internalCalls: stats.internalCalls,
        externalCalls: stats.externalCalls,
        dominantCaller,
        dominantPercent,
        avgInternalLatency: avg(stats.internalLatencies),
        avgExternalLatency: avg(stats.externalLatencies),
        p95InternalLatency: percentile(stats.internalLatencies, 95),
        p95ExternalLatency: percentile(stats.externalLatencies, 95),
        p99InternalLatency: percentile(stats.internalLatencies, 99),
        p99ExternalLatency: percentile(stats.externalLatencies, 99),
        sampleCount: totalCalls,
        callerServices,
      });
    }

    return results;
  }
}

/**
 * FraPipeline orchestrates the full analysis using the ProviderRegistry.
 *
 * Replaces the ad-hoc pipeline logic previously scattered across router.ts:548-672
 * and FunctionCallAnalyzer.ts.
 *
 * Pipeline:
 *   1. List services from TraceSourceProvider
 *   2. Fetch traces
 *   3. Process spans through SpanProcessor chain (filter + enrich)
 *   4. Resolve function names via FunctionNameResolver chain
 *   5. Analyze via AnalysisStrategy
 *   6. Apply decision logic via RelocationDecisionEngine
 */
export class FraPipeline {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly config: FraConfig,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Run the full analysis pipeline.
   * @returns Final relocation recommendations, sorted by priority.
   */
  async analyze(query: TraceQuery): Promise<RelocationResult[]> {
    // Step 1: Fetch traces
    this.logger.info(
      `[FraPipeline] Fetching traces (service=${query.service || 'all'}, lookback=${query.lookbackHours}h)`,
    );
    const rawTraces = await this.registry.traceSource.fetchTraces(query);
    this.logger.info(
      `[FraPipeline] Fetched ${rawTraces.length} traces`,
    );

    // Step 2: Process spans through processor chain + resolve function names
    const processedTraces = this.processTraces(rawTraces);

    // Step 3: Analyze
    const analyzed = await this.registry.analysisStrategy.analyze(
      processedTraces,
      this.config,
    );
    this.logger.info(
      `[FraPipeline] Analysis found ${analyzed.length} unique functions`,
    );

    // Step 4: Apply decision logic
    const decisions = applyDecisionLogic(analyzed, this.config);
    this.logger.info(
      `[FraPipeline] Generated ${decisions.length} relocation decisions`,
    );

    return decisions;
  }

  /**
   * Run each span through the processor chain and resolve function names.
   * Spans that are dropped by any processor are removed from the trace.
   */
  private processTraces(traces: NormalizedTrace[]): NormalizedTrace[] {
    const processors = this.registry.spanProcessors;
    const resolvers = this.registry.functionNameResolvers;

    return traces
      .map(trace => ({
        traceId: trace.traceId,
        spans: trace.spans
          .map(span => this.runProcessors(span, trace, processors))
          .filter((s): s is NormalizedSpan => s !== undefined)
          .map(span => this.resolveFunctionName(span, resolvers)),
      }))
      .filter(trace => trace.spans.length > 0);
  }

  private runProcessors(
    span: NormalizedSpan,
    trace: NormalizedTrace,
    processors: SpanProcessor[],
  ): NormalizedSpan | undefined {
    let current: NormalizedSpan | undefined = span;
    for (const processor of processors) {
      if (!current) return undefined;
      current = processor.process(current, trace);
    }
    return current;
  }

  /**
   * Run the function name resolver chain. First non-undefined result wins.
   * The resolved name is stored in `fra.resolved_function` tag for the
   * analysis strategy to read.
   */
  private resolveFunctionName(
    span: NormalizedSpan,
    resolvers: FunctionNameResolver[],
  ): NormalizedSpan {
    for (const resolver of resolvers) {
      const name = resolver.resolve(span);
      if (name) {
        return {
          ...span,
          tags: { ...span.tags, 'fra.resolved_function': name },
        };
      }
    }

    // Fallback: sanitize the raw operation name
    const fallback = span.operationName
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'unknown_function';

    return {
      ...span,
      tags: { ...span.tags, 'fra.resolved_function': fallback },
    };
  }
}
