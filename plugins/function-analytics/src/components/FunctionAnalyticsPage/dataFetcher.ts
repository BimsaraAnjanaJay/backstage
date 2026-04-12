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
  CatalogServiceConfig,
  ManualServiceConfig,
  TracingBackendConfig,
  ServiceMetrics,
  HybridServiceConfig,
} from './types';
import {
  fetchServiceMetrics,
  clearServicesCache,
} from './traceService';

/**
 * Fetches metrics from any supported tracing backend.
 * Routes to the correct adapter based on backend.type.
 */
const fetchServiceMetricsFromBackend = async (
  serviceName: string,
  backend: TracingBackendConfig,
  timeRange: string,
  fetchApi: { fetch: typeof fetch },
  proxyBaseUrl?: string,
): Promise<ServiceMetrics> => {
  return fetchServiceMetrics(
    serviceName,
    backend,
    timeRange,
    fetchApi,
    proxyBaseUrl,
  );
};

/**
 * Fetches metrics for all configured services (catalog + manual)
 * Returns hybrid configurations with connection status
 */
export const fetchHybridServiceMetrics = async (
  catalogServices: CatalogServiceConfig[],
  manualServices: ManualServiceConfig[],
  defaultBackend: TracingBackendConfig,
  timeRange: string,
  fetchApi: { fetch: typeof fetch },
  proxyBaseUrl?: string,
): Promise<HybridServiceConfig[]> => {
  const hybridConfigs: HybridServiceConfig[] = [];

  // Clear cached service lists so each fetch cycle gets fresh data
  clearServicesCache();

  // Process catalog services
  for (const catalogService of catalogServices) {
    try {
      const backend = catalogService.tracingEndpoint
        ? { ...defaultBackend, endpoint: catalogService.tracingEndpoint }
        : defaultBackend;

      const serviceMetrics = await fetchServiceMetricsFromBackend(
        catalogService.jaegerServiceName || catalogService.serviceName,
        backend,
        timeRange,
        fetchApi,
        proxyBaseUrl,
      );

      hybridConfigs.push({
        ...serviceMetrics,
        source: 'catalog',
        owner: catalogService.owner,
        environment: catalogService.environment,
        config: catalogService,
        connectionStatus:
          serviceMetrics.functions.length > 0 ? 'connected' : 'disconnected',
        lastChecked: new Date(),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `Error fetching catalog service ${catalogService.serviceName}:`,
        error,
      );
      hybridConfigs.push({
        serviceName: catalogService.serviceName,
        totalCalls: 0,
        avgLatency: 0,
        errorRate: 0,
        functions: [],
        source: 'catalog',
        owner: catalogService.owner,
        environment: catalogService.environment,
        config: catalogService,
        connectionStatus: 'disconnected',
        lastChecked: new Date(),
      });
    }
  }

  // Process manual services
  for (const manualService of manualServices) {
    try {
      const serviceMetrics = await fetchServiceMetricsFromBackend(
        manualService.jaegerServiceName || manualService.serviceName,
        manualService.tracingBackend,
        timeRange,
        fetchApi,
      );

      hybridConfigs.push({
        ...serviceMetrics,
        source: 'manual',
        environment: manualService.environment,
        config: manualService,
        connectionStatus:
          serviceMetrics.functions.length > 0 ? 'connected' : 'disconnected',
        lastChecked: new Date(),
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `Error fetching manual service ${manualService.serviceName}:`,
        error,
      );
      hybridConfigs.push({
        serviceName: manualService.serviceName,
        totalCalls: 0,
        avgLatency: 0,
        errorRate: 0,
        functions: [],
        source: 'manual',
        environment: manualService.environment,
        config: manualService,
        connectionStatus: 'disconnected',
        lastChecked: new Date(),
      });
    }
  }

  return hybridConfigs;
};
