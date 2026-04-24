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
 * SyntheticTraceGenerator
 *
 * Converts a ServiceFunctionRegistry[] (produced by FunctionRegistryBuilder's
 * static analysis) into synthetic NormalizedTrace data when no live tracing
 * backend is available.
 *
 * Each function gets a set of spans modelling realistic internal and
 * cross-service call patterns. The generated spans carry FRA custom tags
 * (`fra.function_name`, `fra.invocation_type`, `fra.caller_service`,
 * `fra.host_service`) so they:
 *   - bypass NoiseFilterProcessor (fra.function_name tag)
 *   - resolve via FraTagResolver (highest-priority resolver)
 *   - feed CohesionAnalyzer with enough samples (≥ MIN_SAMPLE_THRESHOLD)
 *
 * Output is deterministic: the same registry always produces the same traces.
 *
 * Works generically across every language and layout supported by
 * FunctionRegistryBuilder (Java, Node.js, TypeScript, Python, .NET).
 */

import {
  NormalizedTrace,
  NormalizedSpan,
  TraceSourceProvider,
  TraceQuery,
} from '../../lib/providers';
import { ServiceFunctionRegistry } from '../../lib/types';

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

/** DJB2 string hash → unsigned 32-bit seed */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(33, h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** LCG pseudo-random number generator, returns [0, 1) */
function makePrng(seed: number): () => number {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Generate a 16-char hex string as a trace/span ID */
function makeHexId(rng: () => number): string {
  return [0, 0]
    .map(() =>
      Math.floor(rng() * 0x100000000)
        .toString(16)
        .padStart(8, '0'),
    )
    .join('');
}

// ─── Keyword classification ───────────────────────────────────────────────────

/**
 * Keywords that indicate a function is a shared utility likely called by
 * many services (auth, payment, notification, etc.).  These get a high
 * external-caller affinity.
 */
const SHARED_UTILITY_KEYWORDS = new Set([
  'auth',
  'authenticate',
  'authorize',
  'token',
  'jwt',
  'session',
  'user',
  'account',
  'profile',
  'permission',
  'role',
  'access',
  'payment',
  'charge',
  'invoice',
  'billing',
  'refund',
  'transaction',
  'notify',
  'notification',
  'send',
  'email',
  'sms',
  'push',
  'alert',
  'validate',
  'verify',
  'check',
  'confirm',
  'log',
  'audit',
  'event',
  'publish',
  'emit',
]);

/**
 * Keywords that indicate a function is deep data-layer logic — called almost
 * exclusively from within the owning service.
 */
const DATA_LAYER_KEYWORDS = new Set([
  'save',
  'store',
  'persist',
  'upsert',
  'insert',
  'delete',
  'remove',
  'find',
  'fetch',
  'load',
  'read',
  'write',
  'query',
  'select',
  'cache',
  'flush',
  'commit',
  'rollback',
  'repository',
  'dao',
  'mapper',
  'entity',
]);

/**
 * Keywords that suggest the function is an API handler / orchestrator —
 * it calls other services but is mostly called from the outside (client).
 */
const ORCHESTRATOR_KEYWORDS = new Set([
  'handle',
  'process',
  'execute',
  'orchestrate',
  'coordinate',
  'create',
  'update',
  'submit',
  'register',
  'cancel',
  'complete',
  'get',
  'list',
  'show',
  'detail',
  'search',
  'filter',
]);

// ─── Service-name classification ─────────────────────────────────────────────

/**
 * Service-name patterns that suggest the service is a "shared" dependency
 * (called by many siblings) — its functions get higher external affinity.
 */
const SHARED_SERVICE_KEYWORDS = new Set([
  'auth',
  'user',
  'account',
  'identity',
  'iam',
  'payment',
  'billing',
  'invoice',
  'notification',
  'email',
  'sms',
  'push',
  'gateway',
  'api',
  'common',
  'shared',
  'lib',
  'util',
]);

// ─── External affinity calculation ───────────────────────────────────────────

/**
 * Returns a [0.0, 1.0] affinity score indicating how likely this function
 * is to receive calls from other services.
 *
 * 0.0 = only called internally
 * 1.0 = almost exclusively called from other services
 */
function externalAffinity(functionName: string, serviceName: string): number {
  const fn = functionName.toLowerCase();
  const svc = serviceName.toLowerCase();

  // Data-layer functions stay inside their service
  for (const kw of DATA_LAYER_KEYWORDS) {
    if (fn.includes(kw)) return 0.05;
  }

  // Shared utility functions are called from everywhere
  for (const kw of SHARED_UTILITY_KEYWORDS) {
    if (fn.includes(kw)) return 0.75;
  }

  // Services whose entire purpose is to serve other services
  for (const kw of SHARED_SERVICE_KEYWORDS) {
    if (svc.includes(kw)) return 0.65;
  }

  // Orchestrator / API handler functions get moderate external callers
  for (const kw of ORCHESTRATOR_KEYWORDS) {
    if (fn.includes(kw)) return 0.35;
  }

  return 0.2; // default: mostly internal
}

// ─── Latency helpers ─────────────────────────────────────────────────────────

/** Returns a latency in microseconds drawn from a log-normal-like distribution */
function sampleLatencyUs(
  rng: () => number,
  baseMsMin: number,
  baseMsMax: number,
): number {
  // Simple triangular distribution between min and max, in ms → convert to µs
  const ms = baseMsMin + rng() * (baseMsMax - baseMsMin);
  return Math.round(ms * 1000);
}

// ─── Span factory ────────────────────────────────────────────────────────────

interface SpanParams {
  functionName: string;
  serviceName: string;
  callerService: string;
  invocationType: 'internal' | 'external';
  rng: () => number;
  baseTimeUs: number;
}

function buildSpan(p: SpanParams): NormalizedSpan {
  const isExternal = p.invocationType === 'external';
  const duration = sampleLatencyUs(
    p.rng,
    isExternal ? 8 : 1,
    isExternal ? 150 : 40,
  );
  const traceId = makeHexId(p.rng);
  const spanId = makeHexId(p.rng);

  const tags: Record<string, string> = {
    // FRA tags — picked up by FraTagResolver (highest priority) and
    // NoiseFilterProcessor (fra.function_name bypasses the noise check)
    'fra.function_name': p.functionName,
    'fra.invocation_type': p.invocationType,
    'fra.host_service': p.serviceName,
  };

  if (isExternal) {
    tags['fra.caller_service'] = p.callerService;
  }

  return {
    traceId,
    spanId,
    operationName: p.functionName,
    serviceName: p.serviceName,
    startTime: p.baseTimeUs,
    duration,
    tags,
    spanKind: isExternal ? 'server' : 'internal',
  };
}

// ─── Core generator ──────────────────────────────────────────────────────────

/**
 * Generates synthetic NormalizedTrace[] for every function discovered by
 * static analysis.  Call patterns are modelled from function/service name
 * semantics; the PRNG is seeded deterministically.
 *
 * Each trace contains exactly one span so that CohesionAnalyzer can count
 * individual call events independently (it counts spans, not traces).
 */
export function generateSyntheticTraces(
  registries: ServiceFunctionRegistry[],
): NormalizedTrace[] {
  if (registries.length === 0) return [];

  const traces: NormalizedTrace[] = [];
  const allServices = registries.map(r => r.service);
  const baseTimeUs = Date.now() * 1000; // epoch in microseconds

  for (const registry of registries) {
    const { service, functions } = registry;
    const otherServices = allServices.filter(s => s !== service);

    for (const fn of functions) {
      const seed = hashStr(`${service}::${fn.name}`);
      const rng = makePrng(seed);

      // ── 1. Decide call volume ──────────────────────────────────────────
      // 5-20 total calls per function (deterministic)
      const totalCalls = 5 + Math.floor(rng() * 16);

      // ── 2. Decide external affinity ────────────────────────────────────
      const affinity =
        otherServices.length === 0 ? 0 : externalAffinity(fn.name, service);

      // Number of calls that are external (at least 0)
      const externalTotal = Math.round(totalCalls * affinity);
      const internalTotal = totalCalls - externalTotal;

      // ── 3. Pick external callers ───────────────────────────────────────
      //
      // Caller count drives the recommendation the decision engine will emit:
      //   1 dominant caller  → dominantPercent > internalPercent + margin → 'relocate'
      //   2 equal callers    → both contribute > 15% each → 'extract' (shared utility)
      //   0 callers          → all internal → 'keep'
      //
      // affinity >= 0.70: shared-utility functions (token, email, payment…)
      //   → 2 callers (60 / 40 split) so both cross the 15% significance threshold
      // 0.50 <= affinity < 0.70: moderately external functions
      //   → 1 dominant caller so dominantPercent clears the margin check
      // affinity < 0.50: mostly-internal functions → 0 external callers
      const callers: Array<{ service: string; count: number }> = [];
      if (externalTotal > 0 && otherServices.length > 0) {
        const shuffled = [...otherServices].sort(
          (a, b) => hashStr(String(seed) + a) - hashStr(String(seed) + b),
        );

        if (affinity >= 0.7 && shuffled.length >= 2) {
          // Two callers: dominant (60%) + secondary (40%)
          const dominant = Math.max(1, Math.round(externalTotal * 0.6));
          const secondary = externalTotal - dominant;
          callers.push({ service: shuffled[0], count: dominant });
          if (secondary > 0)
            callers.push({ service: shuffled[1], count: secondary });
        } else {
          // One dominant caller gets all external calls
          callers.push({ service: shuffled[0], count: externalTotal });
        }
      }

      // ── 4. Emit internal spans ─────────────────────────────────────────
      for (let i = 0; i < internalTotal; i++) {
        const span = buildSpan({
          functionName: fn.name,
          serviceName: service,
          callerService: service,
          invocationType: 'internal',
          rng,
          baseTimeUs: baseTimeUs + i * 1000,
        });
        traces.push({ traceId: span.traceId, spans: [span] });
      }

      // ── 5. Emit external spans ─────────────────────────────────────────
      for (const caller of callers) {
        for (let i = 0; i < caller.count; i++) {
          const span = buildSpan({
            functionName: fn.name,
            serviceName: service,
            callerService: caller.service,
            invocationType: 'external',
            rng,
            baseTimeUs: baseTimeUs + i * 2000,
          });
          traces.push({ traceId: span.traceId, spans: [span] });
        }
      }
    }
  }

  return traces;
}

// ─── TraceSourceProvider wrapper ─────────────────────────────────────────────

/**
 * Implements TraceSourceProvider using synthetic trace generation.
 *
 * Register this as the trace source in a ProviderRegistry when no live
 * tracing backend is reachable:
 *
 *   const registry = ProviderRegistry.fromConfig(config);
 *   registry.registerTraceSource(new SyntheticTraceProvider(registries));
 *   const pipeline = new FraPipeline(registry, config, logger);
 *   const results = await pipeline.analyze({ service: 'all', ... }, registries);
 */
export class SyntheticTraceProvider implements TraceSourceProvider {
  readonly type = 'synthetic';

  constructor(private readonly registries: ServiceFunctionRegistry[]) {}

  async listServices(): Promise<string[]> {
    return this.registries.map(r => r.service);
  }

  async fetchTraces(_query: TraceQuery): Promise<NormalizedTrace[]> {
    return generateSyntheticTraces(this.registries);
  }
}
