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

import { ServiceMetrics, TracingBackendConfig } from '../types';

/**
 * Frontend adapter interface for tracing backends.
 *
 * Each tracing backend (Jaeger, Zipkin, etc.) implements this interface
 * to provide a unified way to fetch service metrics from the frontend.
 */
export interface TraceSourceAdapter {
  /** The backend type this adapter handles (e.g. 'jaeger', 'zipkin') */
  readonly type: string;

  /**
   * Resolve a catalog service name to the name used in the tracing backend.
   * Returns null if the service is not found.
   */
  resolveServiceName(
    serviceName: string,
    baseUrl: string,
    fetchApi?: { fetch: typeof fetch },
    headers?: Record<string, string>,
  ): Promise<string | null>;

  /**
   * Fetch service metrics (function calls, latencies, dependencies).
   */
  fetchServiceMetrics(
    serviceName: string,
    backend: TracingBackendConfig,
    timeRange: string,
    fetchApi?: { fetch: typeof fetch },
    proxyBaseUrl?: string,
  ): Promise<ServiceMetrics>;

  /** Clear any cached data (e.g. service list cache). */
  clearCache(): void;
}
