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

import { Entity } from '@backstage/catalog-model';
import { CatalogServiceConfig, TracingBackendConfig } from './types';

/**
 * Discovers instrumented services from the Backstage catalog
 * Looks for services with tracing annotations
 */
export const getCatalogInstrumentedServices = async (
  catalogApi: any
): Promise<CatalogServiceConfig[]> => {
  try {
    const entities = await catalogApi.getEntities({
      filter: {
        kind: 'Component',
      },
    });

    return entities.items
      .filter((entity: Entity) => {
        const annotations = entity.metadata.annotations || {};
        return (
          annotations['jaegertracing.io/service-name'] ||
          annotations['tracing.jaeger/service-name'] ||
          annotations['tracing.opentelemetry/instrumented'] === 'true' ||
          entity.spec?.type === 'service'
        );
      })
      .map((entity: Entity): CatalogServiceConfig => ({
        entity,
        serviceName: entity.metadata.name,
        tracingEndpoint: 
          entity.metadata.annotations?.['tracing.jaeger/endpoint'] || 
          entity.metadata.annotations?.['tracing.endpoint'] ||
          entity.metadata.annotations?.['jaegertracing.io/endpoint'],
        jaegerServiceName: 
          entity.metadata.annotations?.['jaegertracing.io/service-name'] ||
          entity.metadata.annotations?.['tracing.jaeger/service-name'] || 
          entity.metadata.annotations?.['tracing.service-name'] ||
          entity.metadata.name,
        isInstrumented: 
          entity.metadata.annotations?.['tracing.opentelemetry/instrumented'] === 'true' ||
          !!entity.metadata.annotations?.['jaegertracing.io/service-name'],
        owner: entity.spec?.owner as string,
        environment: entity.metadata.annotations?.environment || 'production',
      }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error fetching catalog services:', error);
    return [];
  }
};

/**
 * Returns default tracing backend configurations
 */
export const getDefaultTracingBackends = (): TracingBackendConfig[] => [
  {
    type: 'jaeger',
    name: 'Local Jaeger',
    endpoint: 'http://localhost:16686',
    authType: 'none',
    enabled: true,
  },
  {
    type: 'jaeger',
    name: 'Production Jaeger',
    endpoint: 'https://jaeger.company.com',
    authType: 'bearer',
    enabled: false,
  },
  {
    type: 'zipkin',
    name: 'Local Zipkin',
    endpoint: 'http://localhost:9411',
    authType: 'none',
    enabled: false,
  },
];
