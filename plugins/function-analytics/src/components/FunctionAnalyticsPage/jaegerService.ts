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

      const functionName = extractGeneralFunctionName(
        span.operationName,
        span.tags || [],
      );
      const key = `${displayName}-${functionName}`;

      if (!functionMetrics.has(key)) {
        const httpMethod = span.tags?.find(
          (tag: any) => tag.key === 'http.method',
        )?.value;
        const httpPath = span.tags?.find(
          (tag: any) => tag.key === 'http.url',
        )?.value;
        const grpcMethod = span.tags?.find(
          (tag: any) => tag.key === 'rpc.method',
        )?.value;
        const messageQueue = span.tags?.find(
          (tag: any) => tag.key === 'messaging.system',
        )?.value;
        const eventType = span.tags?.find(
          (tag: any) => tag.key === 'event.type',
        )?.value;
        const databaseOp = span.tags?.find(
          (tag: any) => tag.key === 'db.operation',
        )?.value;
        const version = span.tags?.find(
          (tag: any) => tag.key === 'service.version',
        )?.value;
        const namespace = span.tags?.find(
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
        } else if (
          span.operationName.includes('schedule') ||
          span.operationName.includes('cron')
        ) {
          microserviceType = 'scheduler';
        } else if (
          span.operationName.includes('gateway') ||
          span.operationName.includes('proxy')
        ) {
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

      const hasError = span.tags?.some(
        (tag: any) =>
          (tag.key === 'error' && tag.value === true) ||
          (tag.key === 'http.status_code' &&
            parseInt(tag.value, 10) >= 400),
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

/**
 * Fetches service metrics from Jaeger tracing backend using Backstage proxy.
 * Processes traces and extracts function-level metrics.
 *
 * Includes automatic service-name resolution: when 0 traces are found for
 * `serviceName`, common variants such as `${name}-service` and `${name}-svc`
 * are tried before returning empty results. This handles the frequent mismatch
 * between catalog entity names (e.g. "product") and OTEL_SERVICE_NAME values
 * emitted by containers (e.g. "product-service").
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
    // It's common for the catalog entity name (e.g. "product") to differ from
    // the OTEL_SERVICE_NAME the container emits (e.g. "product-service").
    // When we get 0 traces, try a small set of name variants before giving up.
    if (traces.length === 0) {
      const variants: string[] = [];
      if (!serviceName.endsWith('-service')) variants.push(`${serviceName}-service`);
      if (!serviceName.endsWith('-svc')) variants.push(`${serviceName}-svc`);
      if (serviceName.endsWith('-service')) variants.push(serviceName.replace(/-service$/, ''));
      if (serviceName.endsWith('-svc')) variants.push(serviceName.replace(/-svc$/, ''));

      for (const variant of variants) {
        // eslint-disable-next-line no-console
        console.log(`🔄 Trying service name variant: ${variant}`);
        const variantUrl = `${baseUrl}/api/traces?service=${encodeURIComponent(variant)}&lookback=${lookback}&limit=200`;
        try {
          const variantResp = fetchApi
            ? await fetchApi.fetch(variantUrl, { headers })
            : await fetch(variantUrl, { headers });
          if (variantResp.ok) {
            const variantData = await variantResp.json();
            const variantTraces = variantData.data || [];
            if (variantTraces.length > 0) {
              // eslint-disable-next-line no-console
              console.log(`✅ Found ${variantTraces.length} traces under variant name: ${variant}`);
              return processTraces(variantTraces, variant, serviceName);
            }
          }
        } catch {
          // try next variant
        }
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
