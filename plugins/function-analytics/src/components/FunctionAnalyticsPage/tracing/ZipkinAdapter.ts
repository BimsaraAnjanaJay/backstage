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

import { FunctionCall, ServiceMetrics, TracingBackendConfig } from '../types';
import { extractGeneralFunctionName } from '../utils';
import { TraceSourceAdapter } from './TraceSourceAdapter';

// In-memory cache: baseUrl → known service names
const zipkinServicesCache = new Map<string, string[]>();

/**
 * TraceSourceAdapter for Zipkin.
 *
 * Fetches traces from Zipkin V2 API and processes them into ServiceMetrics.
 */
export class ZipkinAdapter implements TraceSourceAdapter {
  readonly type = 'zipkin';

  clearCache(): void {
    zipkinServicesCache.clear();
  }

  async resolveServiceName(
    serviceName: string,
    baseUrl: string,
    fetchApi?: { fetch: typeof fetch },
    headers?: Record<string, string>,
  ): Promise<string | null> {
    try {
      let known = zipkinServicesCache.get(baseUrl);
      if (!known) {
        const resp = fetchApi
          ? await fetchApi.fetch(`${baseUrl}/api/v2/services`, { headers })
          : await fetch(`${baseUrl}/api/v2/services`, { headers });
        if (!resp.ok) return null;
        known = (await resp.json()) as string[];
        zipkinServicesCache.set(baseUrl, known);
      }
      if (!known || known.length === 0) return null;

      // Try exact match, then suffix variants
      const candidates = [serviceName];
      if (!serviceName.endsWith('-service'))
        candidates.push(`${serviceName}-service`);
      if (serviceName.endsWith('-service'))
        candidates.push(serviceName.replace(/-service$/, ''));

      for (const c of candidates) {
        if (known.includes(c)) return c;
      }
      return null;
    } catch {
      return null;
    }
  }

  async fetchServiceMetrics(
    serviceName: string,
    backend: TracingBackendConfig,
    timeRange: string,
    fetchApi?: { fetch: typeof fetch },
    proxyBaseUrl?: string,
  ): Promise<ServiceMetrics> {
    try {
      let baseUrl: string;
      if (backend.endpoint && backend.endpoint !== 'http://localhost:9411') {
        baseUrl = backend.endpoint.replace(/\/$/, '');
      } else {
        baseUrl = proxyBaseUrl ? `${proxyBaseUrl}/zipkin` : '/api/proxy/zipkin';
      }

      const endTs = Date.now();
      const lookbackMs: Record<string, number> = {
        '5m': 5 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
      };
      const lookback = lookbackMs[timeRange] ?? lookbackMs['1h'];

      const resolved = await this.resolveServiceName(
        serviceName,
        baseUrl,
        fetchApi,
      );
      const queryName = resolved || serviceName;

      const url =
        `${baseUrl}/api/v2/traces?` +
        `serviceName=${encodeURIComponent(queryName)}` +
        `&endTs=${endTs}` +
        `&lookback=${lookback}` +
        `&limit=200`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      const resp = fetchApi
        ? await fetchApi.fetch(url, { headers })
        : await fetch(url, { headers });

      if (!resp.ok) return this.emptyMetrics(serviceName);

      const rawTraces = (await resp.json()) as any[][];
      return this.processTraces(rawTraces, queryName, serviceName);
    } catch {
      return this.emptyMetrics(serviceName);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private emptyMetrics(serviceName: string): ServiceMetrics {
    return {
      serviceName,
      totalCalls: 0,
      avgLatency: 0,
      errorRate: 0,
      functions: [],
      source: 'auto',
    };
  }

  private processTraces(
    rawTraces: any[][],
    zipkinName: string,
    displayName: string,
  ): ServiceMetrics {
    const functionMetrics = new Map<string, FunctionCall>();

    for (const spans of rawTraces) {
      const spanMap = new Map<string, any>();
      for (const s of spans) {
        spanMap.set(s.id, s);
      }

      for (const span of spans) {
        const spanServiceName = span.localEndpoint?.serviceName;
        if (spanServiceName !== zipkinName) continue;

        const opName: string = span.name || '';
        const tags: Record<string, string> = span.tags || {};
        const tagsArray = Object.entries(tags).map(([key, value]) => ({
          key,
          value,
        }));

        // Noise filtering
        if (tags['db.system'] || tags['db.operation'] || tags['db.statement'])
          continue;
        if (
          /^(SELECT|INSERT|UPDATE|DELETE)[\s_]/i.test(opName)
        )
          continue;
        if (/^(GET|POST|PUT|DELETE|PATCH)$/i.test(opName.trim())) continue;

        const functionName = extractGeneralFunctionName(opName, tagsArray);
        if (!functionName) continue;

        const key = `${displayName}-${functionName}`;

        if (!functionMetrics.has(key)) {
          functionMetrics.set(key, {
            functionName,
            serviceName: displayName,
            type: 'internal',
            latency: 0,
            errorRate: 0,
            callCount: 0,
            internalCalls: 0,
            externalCalls: 0,
            externalCallTargets: [],
            externalCallFrequency: {},
            crossServiceCallLatency: 0,
            dependencies: [],
            timestamp: new Date().toISOString(),
            httpMethod: tags['http.method'],
            httpPath: tags['http.url'],
            grpcMethod: tags['rpc.method'],
            messageQueue: tags['messaging.system'],
            microserviceType: tags['http.method'] ? 'api' : 'service',
          });
        }

        const metric = functionMetrics.get(key)!;
        metric.callCount++;
        metric.latency += span.duration || 0;

        if (
          tags['error'] === 'true' ||
          parseInt(tags['http.status_code'] || '0', 10) >= 400
        ) {
          metric.errorRate++;
        }

        // Caller detection via parent span
        const parentSpan = span.parentId ? spanMap.get(span.parentId) : null;
        const callerService = parentSpan?.localEndpoint?.serviceName;

        if (!callerService) {
          metric.externalCalls++;
          metric.type = 'external';
        } else if (callerService === zipkinName) {
          metric.internalCalls++;
        } else {
          metric.externalCalls++;
          metric.type = 'external';
          if (!metric.dependencies.includes(callerService)) {
            metric.dependencies.push(callerService);
          }
        }
      }
    }

    const functions = Array.from(functionMetrics.values()).map(metric => ({
      ...metric,
      latency:
        metric.callCount > 0 ? metric.latency / metric.callCount / 1000 : 0,
      errorRate:
        metric.callCount > 0 ? (metric.errorRate / metric.callCount) * 100 : 0,
      crossServiceCallLatency: 0,
    }));

    const totalCalls = functions.reduce((sum, f) => sum + f.callCount, 0);
    const avgLatency =
      functions.length > 0
        ? functions.reduce((sum, f) => sum + f.latency * f.callCount, 0) /
          totalCalls
        : 0;
    const totalErrors = functions.reduce(
      (sum, f) => sum + (f.errorRate * f.callCount) / 100,
      0,
    );
    const overallErrorRate =
      totalCalls > 0 ? (totalErrors / totalCalls) * 100 : 0;

    return {
      serviceName: displayName,
      totalCalls,
      avgLatency,
      errorRate: overallErrorRate,
      functions,
      source: 'auto',
    };
  }
}
