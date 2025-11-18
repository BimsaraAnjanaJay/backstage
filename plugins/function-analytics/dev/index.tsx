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

import { createDevApp } from '@backstage/dev-utils';
import { functionAnalyticsPlugin, FunctionAnalyticsPage } from '../src/plugin';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Entity } from '@backstage/catalog-model';

// Mock catalog API for development
class MockCatalogApi {
  async getEntities() {
    // Return mock instrumented services
    const mockEntities: Entity[] = [
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'user-service',
          annotations: {
            'jaegertracing.io/service-name': 'user-service',
            'tracing.jaeger/endpoint': 'http://localhost:16686',
            'environment': 'development',
          },
        },
        spec: {
          type: 'service',
          owner: 'team-a',
          lifecycle: 'production',
        },
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'order-service',
          annotations: {
            'jaegertracing.io/service-name': 'order-service',
            'tracing.jaeger/endpoint': 'http://localhost:16686',
            'environment': 'development',
          },
        },
        spec: {
          type: 'service',
          owner: 'team-b',
          lifecycle: 'production',
        },
      },
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'payment-service',
          annotations: {
            'jaegertracing.io/service-name': 'payment-service',
            'tracing.opentelemetry/instrumented': 'true',
            'environment': 'production',
          },
        },
        spec: {
          type: 'service',
          owner: 'team-c',
          lifecycle: 'production',
        },
      },
    ];

    return { items: mockEntities };
  }

  async getEntityByRef() {
    return undefined;
  }

  async getEntitiesByRefs() {
    return { items: [] };
  }

  async queryEntities() {
    return { items: [], totalItems: 0, pageInfo: {} };
  }

  async getEntityAncestors() {
    return { items: [] };
  }

  async getEntityFacets() {
    return { facets: {} };
  }

  async addLocation() {
    return { location: { id: 'mock', type: 'url', target: 'mock' }, entities: [] };
  }

  async getLocationById() {
    return { id: 'mock', type: 'url', target: 'mock' };
  }

  async getLocationByRef() {
    return { id: 'mock', type: 'url', target: 'mock' };
  }

  async removeLocationById() {
    return undefined;
  }

  async removeEntityByUid() {
    return undefined;
  }

  async refreshEntity() {
    return undefined;
  }

  async getEntityByName() {
    return undefined;
  }

  async validateEntity() {
    return true;
  }
}

createDevApp()
  .registerPlugin(functionAnalyticsPlugin)
  .registerApi({
    api: catalogApiRef,
    deps: {},
    factory: () => new MockCatalogApi(),
  })
  .addPage({
    element: <FunctionAnalyticsPage />,
    title: 'Function Analytics',
    path: '/function-analytics',
  })
  .render();
