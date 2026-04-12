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
  SpanProcessor,
  NormalizedSpan,
  NormalizedTrace,
} from '../../../lib/providers';

/**
 * Enriches spans with computed tags derived from trace context.
 *
 * Does NOT drop spans — it adds derived metadata so downstream resolvers
 * and the analysis strategy can use them without re-walking references.
 *
 * Computed tags:
 *   - `fra.parent_service`: The service name of the parent span (if any)
 *
 * Extracted from the inline enrichment in FunctionCallAnalyzer.ts lines 234-305
 * (building spanServiceMap and walking parent references).
 */
export class SpanEnricherProcessor implements SpanProcessor {
  readonly name = 'SpanEnricherProcessor';

  process(
    span: NormalizedSpan,
    trace: NormalizedTrace,
  ): NormalizedSpan | undefined {
    // Build a spanId→serviceName index for the trace (lazy, per-trace)
    // Since process() is called per-span but the index is per-trace,
    // we cache it on the trace object via a WeakMap.
    const index = this.getOrBuildIndex(trace);

    // Resolve parent service
    if (span.parentSpanId && !span.tags['fra.parent_service']) {
      const parentService = index.get(span.parentSpanId);
      if (parentService) {
        return {
          ...span,
          tags: { ...span.tags, 'fra.parent_service': parentService },
        };
      }
    }

    return span;
  }

  // ── Index cache ────────────────────────────────────────────────────────

  private indexCache = new WeakMap<NormalizedTrace, Map<string, string>>();

  private getOrBuildIndex(trace: NormalizedTrace): Map<string, string> {
    let index = this.indexCache.get(trace);
    if (!index) {
      index = new Map<string, string>();
      for (const s of trace.spans) {
        index.set(s.spanId, s.serviceName);
      }
      this.indexCache.set(trace, index);
    }
    return index;
  }
}
