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

import fetch from 'node-fetch';
import {
  TraceSourceProvider,
  TraceQuery,
  NormalizedTrace,
  NormalizedSpan,
} from '../../lib/providers';

// Service names to ignore (infrastructure / telemetry services)
const INFRA_SERVICE_PREFIXES = ['jaeger', 'unknown_service:'];
const INFRA_SERVICE_EXACT = new Set(['jaeger-query', 'jaeger-all-in-one']);

/**
 * TraceSourceProvider for Jaeger.
 *
 * Connects to a Jaeger Query API endpoint, fetches traces, and normalizes
 * the Jaeger-specific JSON format into NormalizedTrace/NormalizedSpan.
 *
 * Extracted from router.ts lines 560-643.
 */
export class JaegerProvider implements TraceSourceProvider {
  readonly type = 'jaeger';

  constructor(
    /** Jaeger Query API base URL, e.g. "http://localhost:16686/api" */
    private readonly endpoint: string,
    private readonly timeoutMs: number = 5000,
  ) {}

  async listServices(): Promise<string[]> {
    const res = await this.fetchWithTimeout(`${this.endpoint}/services`);
    if (!res.ok) return [];
    const data = await res.json();
    const services = (data.data || []) as string[];
    return services.filter(
      svc =>
        !INFRA_SERVICE_EXACT.has(svc) &&
        !INFRA_SERVICE_PREFIXES.some(p => svc.startsWith(p)),
    );
  }

  async fetchTraces(query: TraceQuery): Promise<NormalizedTrace[]> {
    const lookback = `${query.lookbackHours}h`;

    if (query.service && query.service !== 'all') {
      return this.fetchTracesForService(query.service, lookback, query.maxTraces);
    }

    // Fetch for all services
    const services = await this.listServices();
    const allTraces: NormalizedTrace[] = [];
    const seenTraceIds = new Set<string>();

    const results = await Promise.allSettled(
      services.map(svc =>
        this.fetchTracesForService(svc, lookback, query.maxTraces),
      ),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const trace of result.value) {
          if (!seenTraceIds.has(trace.traceId)) {
            seenTraceIds.add(trace.traceId);
            allTraces.push(trace);
          }
        }
      }
    }

    return allTraces;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async fetchTracesForService(
    service: string,
    lookback: string,
    limit: number,
  ): Promise<NormalizedTrace[]> {
    const url = `${this.endpoint}/traces?service=${encodeURIComponent(
      service,
    )}&limit=${limit}&lookback=${lookback}`;

    const res = await this.fetchWithTimeout(url);
    if (!res.ok) return [];

    const data = await res.json();
    const rawTraces = Array.isArray(data) ? data : data.data || [];
    return rawTraces.map((t: any) => this.normalizeTrace(t));
  }

  /**
   * Convert a raw Jaeger trace object into a NormalizedTrace.
   * - Flattens {key, value}[] tag arrays into Record<string, string>
   * - Resolves processID → serviceName
   * - Maps CHILD_OF references → parentSpanId
   */
  private normalizeTrace(raw: any): NormalizedTrace {
    const processes: Record<string, string> = {};
    if (raw.processes) {
      for (const [pid, proc] of Object.entries(raw.processes)) {
        processes[pid] = (proc as any).serviceName || 'unknown';
      }
    }

    const spans: NormalizedSpan[] = (raw.spans || []).map((s: any) => {
      // Flatten tags
      const tags: Record<string, string> = {};
      if (Array.isArray(s.tags)) {
        for (const t of s.tags) {
          tags[t.key] = String(t.value);
        }
      }

      // Resolve parent span ID from references
      let parentSpanId: string | undefined;
      if (Array.isArray(s.references)) {
        const childOf = s.references.find(
          (r: any) => r.refType === 'CHILD_OF',
        );
        if (childOf) {
          parentSpanId = childOf.spanID;
        }
      }

      // Determine span kind from tags
      const rawKind = tags['span.kind'] || '';
      const spanKind = (['client', 'server', 'producer', 'consumer', 'internal'] as const)
        .find(k => k === rawKind);

      return {
        traceId: s.traceID || raw.traceID,
        spanId: s.spanID,
        parentSpanId,
        operationName: s.operationName || '',
        serviceName: processes[s.processID] || 'unknown',
        startTime: s.startTime || 0,
        duration: s.duration || 0,
        tags,
        spanKind,
      };
    });

    return {
      traceId: raw.traceID,
      spans,
    };
  }

  private async fetchWithTimeout(url: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal as any });
    } finally {
      clearTimeout(timer);
    }
  }
}
