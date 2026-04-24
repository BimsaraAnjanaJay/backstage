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
import {
  FunctionAnalysis,
  RelocationResult,
  ServiceFunctionRegistry,
} from './types';
import { ProviderRegistry } from './ProviderRegistry';
import { FraConfig } from '../modules/config/FraConfig';
import { applyDecisionLogic } from '../modules/analysis/RelocationDecisionEngine';
import { analyzeVolatility } from '../modules/analysis/VolatilityAnalyzer';
import { detectCoLocatedGroups } from '../modules/analysis/CoLocationAnalyzer';
import { augmentWithStaticCoverage } from '../modules/analysis/StaticCoverageAugmenter';
import { enrichWithCodeLocations } from '../modules/analysis/TraceToCodeMapper';

// ─── Minimum observations required to emit a result ────────────────────────
// Lowered from 5 to 3: auto-instrumented Java services produce fewer spans per
// function than hand-instrumented services, so a lower threshold is needed to
// surface function-level data when only a handful of probe requests are made.
const MIN_SAMPLE_THRESHOLD = 3;

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
        // Skip wildcard route patterns (e.g. ** resolved from GET /**)
        if (/^\*+$/.test(functionName)) continue;

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
        patternStability: 1.0,
        staticCoverage: 'unknown',
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
   * @param query - Trace query parameters.
   * @param registries - Optional static function registries for coverage analysis.
   * @returns Final relocation recommendations, sorted by priority.
   */
  async analyze(
    query: TraceQuery,
    registries?: ServiceFunctionRegistry[],
  ): Promise<RelocationResult[]> {
    // Step 1: Fetch traces
    this.logger.info(
      `[FraPipeline] Fetching traces (service=${
        query.service || 'all'
      }, lookback=${query.lookbackHours}h)`,
    );
    const rawTraces = await this.registry.traceSource.fetchTraces(query);
    this.logger.info(`[FraPipeline] Fetched ${rawTraces.length} traces`);

    // Step 2: Process spans through processor chain + resolve function names
    let processedTraces = this.processTraces(rawTraces);

    // Step 2b: When static registries are available, map URL-segment-derived
    // function names (e.g. 'train', 'order') to matching registry function names
    // (e.g. 'queryAllTrainType', 'createOrder'). This bridges the gap when
    // method-level spans aren't available and only HTTP server spans exist.
    if (registries && registries.length > 0) {
      processedTraces = this.mapUrlSegmentsToRegistryFunctions(
        processedTraces,
        registries,
      );
    }

    // Step 2c: Normalize OTel service names to catalog names and strip
    // service-name prefixes from resolved function names so that trace data and
    // static registries always share the same keys. This eliminates two common
    // duplicates:
    //   • "auth-service" (OTel) vs "auth" (docker-compose) — service name drift
    //   • "auth-extractTokenHash" (span) vs "extractTokenHash" (registry) — prefix leak
    if (registries && registries.length > 0) {
      processedTraces = this.normalizeSpanNames(
        processedTraces,
        registries.map(r => r.service),
      );
    }

    // Step 3: Compute volatility before analysis (needs resolved function names)
    const volatilityMap = analyzeVolatility(processedTraces);

    // Step 4: Analyze
    let analyzed = await this.registry.analysisStrategy.analyze(
      processedTraces,
      this.config,
    );

    // Step 5: Attach pattern stability from volatility analysis
    analyzed = analyzed.map(fa => {
      const key = `${fa.currentService}::${fa.functionName}`;
      const vol = volatilityMap.get(key);
      if (vol) {
        const stability = 1 - Math.min(vol.coefficientOfVariation, 1);
        return { ...fa, patternStability: Math.round(stability * 1000) / 1000 };
      }
      return fa;
    });

    // Step 6: Augment with static coverage if registries provided
    if (registries && registries.length > 0) {
      analyzed = augmentWithStaticCoverage(analyzed, registries);
    }

    this.logger.info(
      `[FraPipeline] Analysis found ${analyzed.length} unique functions`,
    );

    // Step 7: Apply decision logic
    const decisions = applyDecisionLogic(analyzed, this.config);

    // Step 8: Detect co-located groups and annotate results
    const coLocationGroups = detectCoLocatedGroups(decisions, processedTraces);
    for (const group of coLocationGroups) {
      for (const fnName of group.functions) {
        const result = decisions.find(d => d.functionName === fnName);
        if (result) {
          result.coLocationGroup = group.functions.filter(f => f !== fnName);
          result.coLocationAction = group.suggestedAction;
        }
      }
    }

    this.logger.info(
      `[FraPipeline] Generated ${decisions.length} relocation decisions, ${coLocationGroups.length} co-location groups`,
    );

    // Step 9: Enrich with code locations from static registries
    if (registries && registries.length > 0) {
      const enrichedDecisions = enrichWithCodeLocations(decisions, registries);
      const enrichedCount = enrichedDecisions.filter(
        d => d.codeLocation,
      ).length;
      this.logger.info(
        `[FraPipeline] Enriched ${enrichedCount}/${enrichedDecisions.length} results with code locations`,
      );
      return enrichedDecisions;
    }

    return decisions;
  }

  /**
   * Maps URL-segment-derived function names to registry function names.
   *
   * When the OTel Java agent emits only HTTP server spans (e.g. `GET /api/v1/train`)
   * and `UrlPathResolver` produces short URL segments like `train`, those names
   * won't match the static registry (which has `queryAllTrainType`, `getAllTrains`).
   *
   * This step finds registry functions whose name contains the URL segment
   * and re-labels the span so `CohesionAnalyzer` can attribute calls to them.
   * Only applies to URL-segment-style names (all lowercase/kebab, no dots or `::`,
   * ≤30 chars) — method-level names (`queryTrainType`) and FRA-tagged spans are left
   * unchanged.
   *
   * When multiple registry functions match the same segment, the span's resolved
   * name is set to the shortest match (most specific) so that call counts land on
   * one function rather than being lost.
   */
  private mapUrlSegmentsToRegistryFunctions(
    traces: NormalizedTrace[],
    registries: ServiceFunctionRegistry[],
  ): NormalizedTrace[] {
    // Build per-service index: normalised function name → original name
    const serviceIndex = new Map<string, Map<string, string>>();
    for (const reg of registries) {
      const fnMap = new Map<string, string>();
      for (const fn of reg.functions) {
        fnMap.set(fn.name.toLowerCase(), fn.name);
      }
      serviceIndex.set(reg.service.toLowerCase(), fnMap);
    }

    /** Finds the registry fnMap for a service, tolerating name differences. */
    const getFnMap = (serviceName: string): Map<string, string> | undefined => {
      const lower = serviceName.toLowerCase().replace(/-/g, '');
      for (const [key, map] of serviceIndex.entries()) {
        const k = key.replace(/-/g, '');
        if (k === lower || lower.includes(k) || k.includes(lower)) return map;
      }
      return undefined;
    };

    return traces.map(trace => ({
      ...trace,
      spans: trace.spans.map(span => {
        const resolved = span.tags['fra.resolved_function'];
        if (!resolved) return span;

        // Skip spans that already carry an explicit FRA function-name tag
        // (manual instrumentation — already the right name)
        if (span.tags['fra.function_name']) return span;

        // Skip names that already look like class-qualified methods or gRPC paths
        if (
          resolved.includes('.') ||
          resolved.includes('::') ||
          resolved.includes('/')
        )
          return span;

        // URL segments are all lowercase (possibly with hyphens), ≤30 chars.
        // CamelCase names (e.g. `queryTrainType`) already match the registry.
        const isUrlSegment =
          /^[a-z][a-z0-9-]*$/.test(resolved) && resolved.length <= 30;
        if (!isUrlSegment) return span;

        const fnMap = getFnMap(span.serviceName);
        if (!fnMap) return span;

        // Find registry functions whose name contains the segment
        const seg = resolved.replace(/-/g, '').toLowerCase();
        let bestMatch: string | undefined;
        let bestLen = Infinity;

        for (const [fnLower, fnName] of fnMap.entries()) {
          if (fnLower.includes(seg)) {
            // Prefer the shortest matching name (most specific)
            if (fnName.length < bestLen) {
              bestLen = fnName.length;
              bestMatch = fnName;
            }
          }
        }

        if (!bestMatch) return span;

        return {
          ...span,
          tags: { ...span.tags, 'fra.resolved_function': bestMatch },
        };
      }),
    }));
  }

  /**
   * Normalizes span service names to catalog names and strips service-name
   * prefixes from resolved function names.
   *
   * Handles two mismatches that produce ghost duplicate entries:
   *   1. Service name drift — docker-compose service "auth" vs OTel service.name
   *      "auth-service". Resolved by trying common suffix/prefix variants.
   *   2. Function name prefix — some instrumentation patterns emit span names
   *      as "{service}-{function}" (e.g. "auth-extractTokenHash"). Stripping the
   *      prefix recovers the canonical function name from the static registry.
   *
   * Runs after URL-segment mapping (step 2b) so fra.resolved_function is set.
   * Because this step normalizes spans in-place before CohesionAnalyzer and
   * VolatilityAnalyzer run, all downstream keys are consistent and
   * StaticCoverageAugmenter deduplicates correctly without extra logic.
   */
  private normalizeSpanNames(
    traces: NormalizedTrace[],
    catalogNames: string[],
  ): NormalizedTrace[] {
    const catalogSet = new Set(catalogNames);
    const serviceCache = new Map<string, string>();

    const resolveService = (raw: string): string => {
      if (catalogSet.has(raw)) return raw;
      if (serviceCache.has(raw)) return serviceCache.get(raw)!;
      const resolved =
        FraPipeline.resolveToCatalogName(raw, catalogNames) ?? raw;
      serviceCache.set(raw, resolved);
      return resolved;
    };

    const SERVICE_TAGS = [
      'fra.caller_service',
      'fra.host_service',
      'fra.parent_service',
    ];

    return traces.map(trace => ({
      ...trace,
      spans: trace.spans.map(span => {
        const normalizedService = resolveService(span.serviceName);

        // Strip "{normalizedService}-" prefix from the resolved function name.
        let resolvedFn: string | undefined = span.tags['fra.resolved_function'];
        if (resolvedFn) {
          const prefix = `${normalizedService}-`;
          if (
            resolvedFn.startsWith(prefix) &&
            resolvedFn.length > prefix.length
          ) {
            resolvedFn = resolvedFn.slice(prefix.length);
          }
        }

        // Normalize service-name tags so caller attribution stays consistent.
        const updatedTags = { ...span.tags };
        for (const tagKey of SERVICE_TAGS) {
          if (updatedTags[tagKey]) {
            updatedTags[tagKey] = resolveService(updatedTags[tagKey]);
          }
        }
        if (resolvedFn !== undefined) {
          updatedTags['fra.resolved_function'] = resolvedFn;
        }

        if (
          normalizedService === span.serviceName &&
          JSON.stringify(updatedTags) === JSON.stringify(span.tags)
        ) {
          return span;
        }

        return { ...span, serviceName: normalizedService, tags: updatedTags };
      }),
    }));
  }

  /**
   * Resolves a raw OTel service name to the closest matching catalog service name.
   *
   * Resolution order (first match wins):
   *   1. Remove common suffixes  (-service, -svc, -app, -api, -server, -backend)
   *   2. Add common suffixes
   *   3. Progressive prefix strip (e.g. "spring-petclinic-orders" → "orders")
   *   4. Case-insensitive exact match
   */
  static resolveToCatalogName(
    raw: string,
    catalogNames: string[],
  ): string | undefined {
    const SUFFIXES = [
      '-service',
      '-svc',
      '-app',
      '-api',
      '-server',
      '-backend',
    ];

    for (const s of SUFFIXES) {
      if (raw.endsWith(s)) {
        const stripped = raw.slice(0, -s.length);
        if (catalogNames.includes(stripped)) return stripped;
      }
    }

    for (const s of SUFFIXES) {
      const candidate = raw + s;
      if (catalogNames.includes(candidate)) return candidate;
    }

    const parts = raw.split('-');
    for (let i = 1; i < parts.length; i++) {
      const stripped = parts.slice(i).join('-');
      if (catalogNames.includes(stripped)) return stripped;
      for (const s of SUFFIXES) {
        if (catalogNames.includes(stripped + s)) return stripped + s;
        if (stripped.endsWith(s)) {
          const inner = stripped.slice(0, -s.length);
          if (catalogNames.includes(inner)) return inner;
        }
      }
    }

    const lower = raw.toLowerCase();
    return catalogNames.find(n => n.toLowerCase() === lower);
  }

  /**
   * Run each span through the processor chain and resolve function names.
   * Spans that are dropped by any processor are removed from the trace.
   *
   * Double-counting guard: when a service uses both OTel auto-instrumentation
   * AND manual child spans (e.g. host-python's `tracer.start_as_current_span`),
   * the same function invocation produces TWO spans:
   *   - Parent: auto-instrumented HTTP server span  (no fra.invocation_type)
   *   - Child:  manual span with explicit fra.* tags (has fra.invocation_type)
   *
   * Both resolve to the same function name, but the auto-span misclassifies
   * internal calls as external (no fra.invocation_type → falls back to caller
   * service heuristic which fails for cross-service internal calls).
   *
   * Solution: after name resolution, for each manual span that has an explicit
   * `fra.function_name` tag, drop its immediate parent if the parent resolved
   * to the same function name. This removes the double-counted auto-span while
   * preserving auto-span analysis for services that have NO manual instrumentation.
   */
  private processTraces(traces: NormalizedTrace[]): NormalizedTrace[] {
    const processors = this.registry.spanProcessors;
    const resolvers = this.registry.functionNameResolvers;

    return traces
      .map(trace => {
        // Step 1: filter + resolve all spans
        const processed = trace.spans
          .map(span => this.runProcessors(span, trace, processors))
          .filter((s): s is NormalizedSpan => s !== undefined)
          .map(span => this.resolveFunctionName(span, resolvers));

        // Step 2: find span IDs that are parents of explicit manual spans
        // (spans that have the original fra.function_name tag, not resolved via path).
        // Those parent spans are auto-instrumented duplicates and must be dropped.
        const autoSpansToDrop = new Set<string>();
        for (const span of processed) {
          if (span.tags['fra.function_name'] && span.parentSpanId) {
            // Find the parent in this trace
            const parent = processed.find(s => s.spanId === span.parentSpanId);
            if (
              parent &&
              parent.tags['fra.resolved_function'] ===
                span.tags['fra.resolved_function'] &&
              // Only drop if the parent has NO explicit fra.function_name
              // (i.e. it was resolved via UrlPathResolver / OtelSemconvResolver)
              !parent.tags['fra.function_name']
            ) {
              autoSpansToDrop.add(parent.spanId);
            }
          }
        }

        return {
          traceId: trace.traceId,
          spans: processed.filter(s => !autoSpansToDrop.has(s.spanId)),
        };
      })
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
    const fallback =
      span.operationName
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '') || 'unknown_function';

    return {
      ...span,
      tags: { ...span.tags, 'fra.resolved_function': fallback },
    };
  }
}
