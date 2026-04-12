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

import { FunctionCall, ServiceMetrics, TracingBackendConfig } from './types';
import { extractGeneralFunctionName } from './utils';

/**
 * Processes raw Jaeger trace objects for a given service name and returns
 * a ServiceMetrics object with per-function call counts, latencies, and dependencies.
 *
 * @param traces        - raw Jaeger trace array (data field from API response)
 * @param jaegerName    - the serviceName as stored in Jaeger spans (process.serviceName)
 * @param displayName   - the catalog/UI-facing service name (may differ from jaegerName)
 */
function processTraces(
  traces: any[],
  jaegerName: string,
  displayName: string,
): ServiceMetrics {
  const functionMetrics = new Map<string, FunctionCall>();

  traces.forEach((trace: any) => {
    if (!trace.spans) return;

    // Map spanID → span for fast parent lookup
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

      // ── Noise filtering (mirrors backend FunctionCallAnalyzer) ────────────
      // Skip DB / SQL spans (Hibernate UUIDs, JPA query spans, transactions)
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

      // Skip Spring Boot actuator infrastructure endpoints
      if (/^(GET|POST|PUT|DELETE|PATCH)\s+\/actuator\//i.test(opName)) return;

      // Skip bare HTTP method names (Eureka/Zipkin heartbeats with no path)
      if (/^(GET|POST|PUT|DELETE|PATCH)$/i.test(opName.trim())) return;

      // Skip glob wildcard-only operation names (Spring Cloud Gateway catch-all routes)
      if (/^[/*]+$/.test(opName.trim())) return;

      // Skip Eureka/Zipkin/discovery client spans by URL
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
      // ─────────────────────────────────────────────────────────────────────

      const functionName = extractGeneralFunctionName(opName, tags);
      if (!functionName) return; // skip spans that produce no useful name

      const key = `${displayName}-${functionName}`;

      if (!functionMetrics.has(key)) {
        const httpMethod = tags.find(
          (tag: any) => tag.key === 'http.method',
        )?.value;
        const httpPath = tags.find((tag: any) => tag.key === 'http.url')?.value;
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
      if (hasError) {
        metric.errorRate++;
      }

      // Determine caller (parent span's service)
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
        // Root span — externally initiated
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

      // Outbound cross-service dependency tracking
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

// In-memory cache: baseUrl → known service names. Cleared on each fetch cycle.
const jaegerServicesCache = new Map<string, string[]>();

/** Call before each fetch cycle so stale service lists are not used. */
export function clearJaegerServicesCache(): void {
  jaegerServicesCache.clear();
}

/**
 * Fetches the list of services known to Jaeger and returns a resolved name
 * for `serviceName` (exact match first, then suffix-stripped variants).
 * Returns null when the service is not found in Jaeger at all — caller should
 * skip the fetch entirely rather than firing variant probes.
 *
 * Result is cached per baseUrl to avoid repeated /api/services calls when
 * processing many catalog services in the same fetch cycle.
 */
export async function resolveJaegerServiceName(
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

    // Build candidate names in priority order:
    // 1. Exact match
    // 2. Common suffix variants (-service / -svc stripped or added)
    // 3. Prefix-stripped variants (e.g. "spring-petclinic-customers-service" → "customers-service")
    const candidates: string[] = [serviceName];
    if (!serviceName.endsWith('-service'))
      candidates.push(`${serviceName}-service`);
    if (!serviceName.endsWith('-svc')) candidates.push(`${serviceName}-svc`);
    if (serviceName.endsWith('-service'))
      candidates.push(serviceName.replace(/-service$/, ''));
    if (serviceName.endsWith('-svc'))
      candidates.push(serviceName.replace(/-svc$/, ''));

    // Prefix stripping: try removing leading segments one at a time
    // e.g. "spring-petclinic-customers-service" → "petclinic-customers-service" → "customers-service"
    const parts = serviceName.split('-');
    for (let i = 1; i < parts.length - 1; i++) {
      const stripped = parts.slice(i).join('-');
      if (!candidates.includes(stripped)) candidates.push(stripped);
      // Also try with -service stripped
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
    return null; // not in Jaeger — skip entirely
  } catch {
    return null;
  }
}

/**
 * Fetches service metrics from Jaeger tracing backend using Backstage proxy.
 * Processes traces and extracts function-level metrics.
 *
 * Resolves the service name against Jaeger's /api/services list first to avoid
 * firing multiple blind variant-probe requests for services that don't exist.
 */
export const fetchJaegerServiceMetrics = async (
  serviceName: string,
  backend: TracingBackendConfig,
  timeRange: string,
  fetchApi?: { fetch: typeof fetch },
  proxyBaseUrl?: string,
): Promise<ServiceMetrics> => {
  // eslint-disable-next-line no-console
  console.log(`🔍 Fetching metrics for service: ${serviceName}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const endTime = Date.now() * 1000; // microseconds
  const timeRangeToMicros: Record<string, number> = {
    '5m': 5 * 60 * 1000 * 1000,
    '1h': 60 * 60 * 1000 * 1000,
    '24h': 24 * 60 * 60 * 1000 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000 * 1000,
  };
  const rangeMicros = timeRangeToMicros[timeRange] ?? timeRangeToMicros['1h'];
  const startTime = endTime - rangeMicros;

  // eslint-disable-next-line no-console
  console.log(
    `🕐 Time range: ${new Date(startTime / 1000).toISOString()} to ${new Date(
      endTime / 1000,
    ).toISOString()}`,
  );

  try {
    let baseUrl: string;
    if (backend.endpoint && backend.endpoint !== 'http://localhost:16686') {
      baseUrl = backend.endpoint.replace(/\/$/, '');
    } else {
      baseUrl = proxyBaseUrl ? `${proxyBaseUrl}/jaeger` : '/api/proxy/jaeger';
    }

    let lookback = timeRange.toLowerCase();
    if (lookback === '7d') lookback = '168h'; // Jaeger supports hours better

    const tracesUrl = `${baseUrl}/api/traces?service=${encodeURIComponent(
      serviceName,
    )}&lookback=${lookback}&limit=200`;
    // eslint-disable-next-line no-console
    console.log(`📡 Fetching from: ${tracesUrl}`);

    const tracesResponse = fetchApi
      ? await fetchApi.fetch(tracesUrl, { headers })
      : await fetch(tracesUrl, { headers });

    // eslint-disable-next-line no-console
    console.log(
      `📊 Response status: ${tracesResponse.status} ${tracesResponse.statusText}`,
    );

    if (!tracesResponse.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `❌ Failed to fetch traces for ${serviceName}: ${tracesResponse.status} ${tracesResponse.statusText}`,
      );
      return {
        serviceName,
        totalCalls: 0,
        avgLatency: 0,
        errorRate: 0,
        functions: [],
        source: 'auto',
      };
    }

    // Check if response is actually JSON
    const contentType = tracesResponse.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      // eslint-disable-next-line no-console
      console.warn(
        `❌ Service ${serviceName} returned non-JSON response (${contentType}). Service may not exist in Jaeger.`,
      );
      return {
        serviceName,
        totalCalls: 0,
        avgLatency: 0,
        errorRate: 0,
        functions: [],
        source: 'auto',
      };
    }

    let tracesData;
    try {
      tracesData = await tracesResponse.json();
    } catch (jsonError) {
      // eslint-disable-next-line no-console
      console.error(
        `❌ Failed to parse JSON for service ${serviceName}:`,
        jsonError,
      );
      return {
        serviceName,
        totalCalls: 0,
        avgLatency: 0,
        errorRate: 0,
        functions: [],
        source: 'auto',
      };
    }

    const traces = tracesData.data || [];
    // eslint-disable-next-line no-console
    console.log(`🔢 Found ${traces.length} traces for service: ${serviceName}`);

    // ── Service-name auto-resolution ────────────────────────────────────────
    // Resolve against the known Jaeger service list first (one request) rather
    // than firing sequential variant probes.  This avoids O(n*3) requests when
    // many catalog entities are not instrumented services.
    if (traces.length === 0) {
      const resolved = await resolveJaegerServiceName(
        serviceName,
        baseUrl,
        fetchApi,
        headers,
      );
      if (!resolved || resolved === serviceName) {
        // Not in Jaeger or same name — no data
        return {
          serviceName,
          totalCalls: 0,
          avgLatency: 0,
          errorRate: 0,
          functions: [],
          source: 'auto',
        };
      }
      // eslint-disable-next-line no-console
      console.log(
        `🔄 Resolved "${serviceName}" → "${resolved}" via Jaeger service list`,
      );
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
            // eslint-disable-next-line no-console
            console.log(
              `✅ Found ${variantTraces.length} traces under resolved name: ${resolved}`,
            );
            return processTraces(variantTraces, resolved, serviceName);
          }
        }
      } catch {
        // fall through to empty result
      }
      return {
        serviceName,
        totalCalls: 0,
        avgLatency: 0,
        errorRate: 0,
        functions: [],
        source: 'auto',
      };
    }

    return processTraces(traces, serviceName, serviceName);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error fetching metrics for service ${serviceName}:`, error);
    return {
      serviceName,
      totalCalls: 0,
      avgLatency: 0,
      errorRate: 0,
      functions: [],
      source: 'auto',
    };
  }
};
