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
 * TraceSourceProvider for OTLP-compatible backends (e.g. Grafana Tempo).
 *
 * Uses the Tempo HTTP API for search and trace retrieval, normalizing
 * OTLP ResourceSpans into FRA's NormalizedTrace/NormalizedSpan format.
 *
 * Tempo API docs:
 *   - GET /api/search  → search for traces
 *   - GET /api/traces/{traceID} → retrieve a full trace
 *   - GET /api/v2/search/tags → list known tag values (for service discovery)
 */
export class OtlpHttpProvider implements TraceSourceProvider {
  readonly type = 'otlp';

  constructor(
    /** OTLP / Tempo HTTP endpoint, e.g. "http://localhost:3200" */
    private readonly endpoint: string,
    private readonly timeoutMs: number = 10000,
  ) {}

  async listServices(): Promise<string[]> {
    // Tempo exposes service names via the tag values API
    const url = `${this.endpoint}/api/v2/search/tag/service.name/values`;
    try {
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) return [];
      const data = await res.json();
      // Tempo returns { tagValues: [{ type: "string", value: "svc-name" }] }
      const values = (data as any).tagValues || [];
      return values.map((v: any) => v.value || v).filter(Boolean) as string[];
    } catch {
      return [];
    }
  }

  async fetchTraces(query: TraceQuery): Promise<NormalizedTrace[]> {
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - query.lookbackHours * 3600;

    // Build Tempo search query
    let traceQL = '{}';
    if (query.service && query.service !== 'all') {
      traceQL = `{resource.service.name="${query.service}"}`;
    }

    const url =
      `${this.endpoint}/api/search?` +
      `q=${encodeURIComponent(traceQL)}` +
      `&start=${startSec}` +
      `&end=${endSec}` +
      `&limit=${query.maxTraces}`;

    const searchRes = await this.fetchWithTimeout(url);
    if (!searchRes.ok) return [];

    const searchData = (await searchRes.json()) as any;
    const traceIds: string[] = (searchData.traces || []).map(
      (t: any) => t.traceID,
    );

    // Fetch full traces in parallel
    const results = await Promise.allSettled(
      traceIds.map(id => this.fetchFullTrace(id)),
    );

    const traces: NormalizedTrace[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        traces.push(result.value);
      }
    }

    return traces;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async fetchFullTrace(traceId: string): Promise<NormalizedTrace | undefined> {
    const url = `${this.endpoint}/api/traces/${traceId}`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) return undefined;

    const data = (await res.json()) as any;
    // Tempo returns OTLP JSON format: { batches: ResourceSpans[] }
    // or the Tempo-native format: { resourceSpans: [...] }
    const resourceSpans =
      data.batches || data.resourceSpans || [];

    const spans: NormalizedSpan[] = [];

    for (const rs of resourceSpans) {
      // Extract service name from resource attributes
      const resourceAttrs = rs.resource?.attributes || [];
      const serviceNameAttr = resourceAttrs.find(
        (a: any) => a.key === 'service.name',
      );
      const serviceName =
        serviceNameAttr?.value?.stringValue ||
        serviceNameAttr?.value?.Value?.string_value ||
        'unknown';

      // Walk scope spans
      const scopeSpans = rs.scopeSpans || rs.instrumentationLibrarySpans || [];
      for (const ss of scopeSpans) {
        for (const s of ss.spans || []) {
          spans.push(this.normalizeOtlpSpan(s, serviceName));
        }
      }
    }

    return { traceId, spans };
  }

  private normalizeOtlpSpan(raw: any, serviceName: string): NormalizedSpan {
    // OTLP attributes are [{key, value: {stringValue|intValue|...}}]
    const tags: Record<string, string> = {};
    for (const attr of raw.attributes || []) {
      const val =
        attr.value?.stringValue ??
        attr.value?.intValue ??
        attr.value?.doubleValue ??
        attr.value?.boolValue;
      if (val !== undefined) {
        tags[attr.key] = String(val);
      }
    }

    // OTLP span kind enum: 0=unspecified, 1=internal, 2=server, 3=client, 4=producer, 5=consumer
    const kindMap: Record<number, NormalizedSpan['spanKind']> = {
      1: 'internal',
      2: 'server',
      3: 'client',
      4: 'producer',
      5: 'consumer',
    };
    const spanKind = kindMap[raw.kind] || undefined;

    // OTLP uses nanoseconds; convert to microseconds
    const startTimeNano = Number(raw.startTimeUnixNano || 0);
    const endTimeNano = Number(raw.endTimeUnixNano || 0);
    const startTime = Math.floor(startTimeNano / 1000);
    const duration = Math.floor((endTimeNano - startTimeNano) / 1000);

    return {
      traceId: raw.traceId || '',
      spanId: raw.spanId || '',
      parentSpanId: raw.parentSpanId || undefined,
      operationName: raw.name || '',
      serviceName,
      startTime,
      duration,
      tags,
      spanKind,
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
