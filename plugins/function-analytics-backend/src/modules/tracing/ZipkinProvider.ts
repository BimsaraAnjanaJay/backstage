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

/**
 * TraceSourceProvider for Zipkin.
 *
 * Connects to the Zipkin V2 API, fetches traces, and normalizes them
 * into the FRA NormalizedTrace/NormalizedSpan format.
 */
export class ZipkinProvider implements TraceSourceProvider {
  readonly type = 'zipkin';

  constructor(
    /** Zipkin API base URL, e.g. "http://localhost:9411" */
    private readonly endpoint: string,
    private readonly timeoutMs: number = 5000,
  ) {}

  async listServices(): Promise<string[]> {
    const res = await this.fetchWithTimeout(
      `${this.endpoint}/api/v2/services`,
    );
    if (!res.ok) return [];
    return (await res.json()) as string[];
  }

  async fetchTraces(query: TraceQuery): Promise<NormalizedTrace[]> {
    const endTs = Date.now();
    const lookbackMs = query.lookbackHours * 60 * 60 * 1000;

    if (query.service && query.service !== 'all') {
      return this.fetchTracesForService(
        query.service,
        endTs,
        lookbackMs,
        query.maxTraces,
      );
    }

    const services = await this.listServices();
    const allTraces: NormalizedTrace[] = [];
    const seenTraceIds = new Set<string>();

    const results = await Promise.allSettled(
      services.map(svc =>
        this.fetchTracesForService(svc, endTs, lookbackMs, query.maxTraces),
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
    endTs: number,
    lookbackMs: number,
    limit: number,
  ): Promise<NormalizedTrace[]> {
    const url =
      `${this.endpoint}/api/v2/traces?` +
      `serviceName=${encodeURIComponent(service)}` +
      `&endTs=${endTs}` +
      `&lookback=${lookbackMs}` +
      `&limit=${limit}`;

    const res = await this.fetchWithTimeout(url);
    if (!res.ok) return [];

    // Zipkin returns an array of traces, each trace is an array of spans
    const rawTraces = (await res.json()) as any[][];
    return rawTraces.map(spans => this.normalizeTrace(spans));
  }

  /**
   * Convert a Zipkin trace (flat array of spans) into a NormalizedTrace.
   * Zipkin spans use localEndpoint.serviceName and tags are already Record<string,string>.
   */
  private normalizeTrace(rawSpans: any[]): NormalizedTrace {
    if (rawSpans.length === 0) {
      return { traceId: '', spans: [] };
    }

    const spans: NormalizedSpan[] = rawSpans.map(s => {
      const tags: Record<string, string> = { ...(s.tags || {}) };

      // Map Zipkin kind to our normalized kind
      const kindMap: Record<string, NormalizedSpan['spanKind']> = {
        CLIENT: 'client',
        SERVER: 'server',
        PRODUCER: 'producer',
        CONSUMER: 'consumer',
      };
      const spanKind = kindMap[s.kind] || undefined;

      // Zipkin uses microseconds for timestamp and duration
      return {
        traceId: s.traceId,
        spanId: s.id,
        parentSpanId: s.parentId || undefined,
        operationName: s.name || '',
        serviceName: s.localEndpoint?.serviceName || 'unknown',
        startTime: s.timestamp || 0,
        duration: s.duration || 0,
        tags,
        spanKind,
      };
    });

    return {
      traceId: spans[0].traceId,
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
