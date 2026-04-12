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
const jaegerServicesCache = new Map<string, string[]>();

/**
 * TraceSourceAdapter for Jaeger.
 *
 * Contains all Jaeger-specific logic previously in jaegerService.ts:
 * - Service name resolution with fuzzy matching
 * - Trace fetching via Backstage proxy
 * - Trace processing (noise filtering, function extraction, metrics)
 */
export class JaegerAdapter implements TraceSourceAdapter {
  readonly type = 'jaeger';

  clearCache(): void {
    jaegerServicesCache.clear();
  }

  async resolveServiceName(
    serviceName: string,
    baseUrl: string,
    fetchApi?: { fetch: typeof fetch },
    headers?: Record<string, string>,
  ): Promise<string | null> {
    try {
      let known = jaegerServicesCache.get(baseUrl);
      if (!known) {
        const resp = fetchApi
          ? await fetchApi.fetch(`${baseUrl}/api/services`, { headers })
          : await fetch(`${baseUrl}/api/services`, { headers });
        if (!resp.ok) return null;
        const data = await resp.json();
        known = (data.data || []) as string[];
        jaegerServicesCache.set(baseUrl, known);
      }
      if (!known || known.length === 0) return null;

      const candidates: string[] = [serviceName];
      if (!serviceName.endsWith('-service'))
        candidates.push(`${serviceName}-service`);
      if (!serviceName.endsWith('-svc'))
        candidates.push(`${serviceName}-svc`);
      if (serviceName.endsWith('-service'))
        candidates.push(serviceName.replace(/-service$/, ''));
      if (serviceName.endsWith('-svc'))
        candidates.push(serviceName.replace(/-svc$/, ''));

      const parts = serviceName.split('-');
      for (let i = 1; i < parts.length - 1; i++) {
        const stripped = parts.slice(i).join('-');
        if (!candidates.includes(stripped)) candidates.push(stripped);
        const strippedNoSuffix = stripped
          .replace(/-service$/, '')
          .replace(/-svc$/, '');
        if (
          strippedNoSuffix !== stripped &&
          !candidates.includes(strippedNoSuffix)
        ) {
          candidates.push(strippedNoSuffix);
        }
      }

      for (const c of candidates) {
        if (known!.includes(c)) return c;
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    try {
      let baseUrl: string;
      if (backend.endpoint && backend.endpoint !== 'http://localhost:16686') {
        baseUrl = backend.endpoint.replace(/\/$/, '');
      } else {
        baseUrl = proxyBaseUrl ? `${proxyBaseUrl}/jaeger` : '/api/proxy/jaeger';
      }

      let lookback = timeRange.toLowerCase();
      if (lookback === '7d') lookback = '168h';

      const tracesUrl = `${baseUrl}/api/traces?service=${encodeURIComponent(
        serviceName,
      )}&lookback=${lookback}&limit=200`;

      const tracesResponse = fetchApi
        ? await fetchApi.fetch(tracesUrl, { headers })
        : await fetch(tracesUrl, { headers });

      if (!tracesResponse.ok) {
        return this.emptyMetrics(serviceName);
      }

      const contentType = tracesResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return this.emptyMetrics(serviceName);
      }

      let tracesData;
      try {
        tracesData = await tracesResponse.json();
      } catch {
        return this.emptyMetrics(serviceName);
      }

      const traces = tracesData.data || [];

      if (traces.length === 0) {
        const resolved = await this.resolveServiceName(
          serviceName,
          baseUrl,
          fetchApi,
          headers,
        );
        if (!resolved || resolved === serviceName) {
          return this.emptyMetrics(serviceName);
        }

        const variantUrl = `${baseUrl}/api/traces?service=${encodeURIComponent(
          resolved,
        )}&lookback=${lookback}&limit=200`;
        try {
          const variantResp = fetchApi
            ? await fetchApi.fetch(variantUrl, { headers })
            : await fetch(variantUrl, { headers });
          if (variantResp.ok) {
            const variantData = await variantResp.json();
            const variantTraces = variantData.data || [];
            if (variantTraces.length > 0) {
              return this.processTraces(variantTraces, resolved, serviceName);
            }
          }
        } catch {
          // fall through
        }
        return this.emptyMetrics(serviceName);
      }

      return this.processTraces(traces, serviceName, serviceName);
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
    traces: any[],
    jaegerName: string,
    displayName: string,
  ): ServiceMetrics {
    const functionMetrics = new Map<string, FunctionCall>();

    traces.forEach((trace: any) => {
      if (!trace.spans) return;

      const spanMap = new Map<string, any>();
      trace.spans.forEach((s: any) => spanMap.set(s.spanID, s));

      trace.spans.forEach((span: any) => {
        const process = trace.processes?.[span.processID];
        const spanServiceName = process?.serviceName;
        if (spanServiceName !== jaegerName) return;

        const opName: string = span.operationName || '';
        const tags: any[] = span.tags || [];
        const spanKind =
          tags.find((t: any) => t.key === 'span.kind')?.value ?? '';

        // ── Noise filtering ─────────────────────────────────────────────
        const hasDbTag = tags.some(
          (t: any) =>
            t.key === 'db.system' ||
            t.key === 'db.operation' ||
            t.key === 'db.statement',
        );
        const looksLikeSql =
          /^(SELECT|INSERT|UPDATE|DELETE|MERGE|REPLACE|TRUNCATE|CREATE|DROP|ALTER)[\s_]/i.test(
            opName,
          );
        if (hasDbTag || looksLikeSql) return;
        if (/^Transaction\./i.test(opName)) return;
        if (/^(GET|POST|PUT|DELETE|PATCH)\s+\/actuator\//i.test(opName)) return;
        if (/^(GET|POST|PUT|DELETE|PATCH)$/i.test(opName.trim())) return;
        if (/^[/*]+$/.test(opName.trim())) return;

        const httpUrl =
          tags.find((t: any) => t.key === 'http.url' || t.key === 'url.full')
            ?.value ?? '';
        if (
          spanKind === 'client' &&
          (httpUrl.includes('eureka') ||
            httpUrl.includes('zipkin') ||
            httpUrl.includes(':8761') ||
            httpUrl.includes(':9411'))
        )
          return;

        const functionName = extractGeneralFunctionName(opName, tags);
        if (!functionName) return;

        const key = `${displayName}-${functionName}`;

        if (!functionMetrics.has(key)) {
          const httpMethod = tags.find(
            (tag: any) => tag.key === 'http.method',
          )?.value;
          const httpPath = tags.find(
            (tag: any) => tag.key === 'http.url',
          )?.value;
          const grpcMethod = tags.find(
            (tag: any) => tag.key === 'rpc.method',
          )?.value;
          const messageQueue = tags.find(
            (tag: any) => tag.key === 'messaging.system',
          )?.value;
          const eventType = tags.find(
            (tag: any) => tag.key === 'event.type',
          )?.value;
          const databaseOp = tags.find(
            (tag: any) => tag.key === 'db.operation',
          )?.value;
          const version = tags.find(
            (tag: any) => tag.key === 'service.version',
          )?.value;
          const namespace = tags.find(
            (tag: any) => tag.key === 'k8s.namespace',
          )?.value;

          let microserviceType:
            | 'api'
            | 'service'
            | 'worker'
            | 'scheduler'
            | 'gateway' = 'service';
          if (httpMethod && httpPath) {
            microserviceType = 'api';
          } else if (messageQueue) {
            microserviceType = 'worker';
          } else if (opName.includes('schedule') || opName.includes('cron')) {
            microserviceType = 'scheduler';
          } else if (opName.includes('gateway') || opName.includes('proxy')) {
            microserviceType = 'gateway';
          }

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
            httpMethod,
            httpPath,
            grpcMethod,
            messageQueue,
            eventType,
            databaseOperation: databaseOp,
            microserviceType,
            version,
            namespace,
          });
        }

        const metric = functionMetrics.get(key)!;
        metric.callCount++;
        metric.latency += span.duration || 0;

        const hasError = tags.some(
          (tag: any) =>
            (tag.key === 'error' && tag.value === true) ||
            (tag.key === 'http.status_code' && parseInt(tag.value, 10) >= 400),
        );
        if (hasError) metric.errorRate++;

        let callerService: string | null = null;
        const parentRef = span.references?.find(
          (ref: any) =>
            ref.refType === 'CHILD_OF' || ref.refType === 'FOLLOWS_FROM',
        );
        if (parentRef) {
          const parentSpan = spanMap.get(parentRef.spanID);
          if (parentSpan) {
            const parentProcess = trace.processes?.[parentSpan.processID];
            callerService = parentProcess?.serviceName ?? null;
          }
        }

        if (!callerService) {
          metric.externalCalls++;
          metric.type = 'external';
        } else if (callerService === jaegerName) {
          metric.internalCalls++;
        } else {
          metric.externalCalls++;
          metric.type = 'external';
          if (!metric.dependencies.includes(callerService)) {
            metric.dependencies.push(callerService);
          }
        }

        const childSpans = trace.spans.filter((childSpan: any) =>
          childSpan.references?.some(
            (ref: any) =>
              ref.refType === 'CHILD_OF' && ref.spanID === span.spanID,
          ),
        );
        childSpans.forEach((childSpan: any) => {
          const childProcess = trace.processes?.[childSpan.processID];
          const childServiceName = childProcess?.serviceName;
          if (childServiceName && childServiceName !== jaegerName) {
            if (!metric.externalCallTargets.includes(childServiceName)) {
              metric.externalCallTargets.push(childServiceName);
            }
            metric.externalCallFrequency[childServiceName] =
              (metric.externalCallFrequency[childServiceName] || 0) + 1;
            metric.crossServiceCallLatency += childSpan.duration || 0;
          }
        });
      });
    });

    const functions = Array.from(functionMetrics.values()).map(metric => ({
      ...metric,
      latency:
        metric.callCount > 0 ? metric.latency / metric.callCount / 1000 : 0,
      errorRate:
        metric.callCount > 0 ? (metric.errorRate / metric.callCount) * 100 : 0,
      crossServiceCallLatency:
        metric.externalCalls > 0
          ? metric.crossServiceCallLatency / metric.externalCalls / 1000
          : 0,
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

// ── Named exports for backward compatibility ──────────────────────────────

const defaultAdapter = new JaegerAdapter();

export function clearJaegerServicesCache(): void {
  defaultAdapter.clearCache();
}

export async function resolveJaegerServiceName(
  serviceName: string,
  baseUrl: string,
  fetchApi?: { fetch: typeof fetch },
  headers?: Record<string, string>,
): Promise<string | null> {
  return defaultAdapter.resolveServiceName(serviceName, baseUrl, fetchApi, headers);
}

export const fetchJaegerServiceMetrics = async (
  serviceName: string,
  backend: TracingBackendConfig,
  timeRange: string,
  fetchApi?: { fetch: typeof fetch },
  proxyBaseUrl?: string,
): Promise<ServiceMetrics> => {
  return defaultAdapter.fetchServiceMetrics(
    serviceName,
    backend,
    timeRange,
    fetchApi,
    proxyBaseUrl,
  );
};
