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

import { ServiceMetrics, TracingBackendConfig } from './types';
import { AdapterRegistry } from './tracing/AdapterRegistry';

/**
 * Backend-agnostic facade for fetching service metrics from any tracing backend.
 *
 * Looks up the appropriate adapter from the AdapterRegistry based on
 * `backend.type` and delegates to it. This replaces direct imports of
 * jaegerService.ts in components that need to support multiple backends.
 */

/**
 * Clear caches on all registered tracing adapters.
 * Call before each fetch cycle to avoid stale service lists.
 */
export function clearServicesCache(): void {
  AdapterRegistry.clearAllCaches();
}

/**
 * Resolve a catalog service name to the name used in the tracing backend.
 * Delegates to the appropriate adapter based on backend type.
 */
export async function resolveServiceName(
  serviceName: string,
  baseUrl: string,
  backendType: string = 'jaeger',
  fetchApi?: { fetch: typeof fetch },
  headers?: Record<string, string>,
): Promise<string | null> {
  const adapter = AdapterRegistry.get(backendType);
  return adapter.resolveServiceName(serviceName, baseUrl, fetchApi, headers);
}

/**
 * Fetch service metrics from any supported tracing backend.
 * Routes to the correct adapter based on `backend.type`.
 */
export async function fetchServiceMetrics(
  serviceName: string,
  backend: TracingBackendConfig,
  timeRange: string,
  fetchApi?: { fetch: typeof fetch },
  proxyBaseUrl?: string,
): Promise<ServiceMetrics> {
  const adapter = AdapterRegistry.get(backend.type);
  return adapter.fetchServiceMetrics(
    serviceName,
    backend,
    timeRange,
    fetchApi,
    proxyBaseUrl,
  );
}
