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

import * as path from 'path';

export interface TracingBackendConfig {
  id: string;
  type: 'jaeger' | 'zipkin' | 'tempo' | 'otlp';
  endpoint: string;
  enabled: boolean;
}

/** Discovery provider types that can be activated via config. */
export type DiscoveryProviderType =
  | 'monorepo'
  | 'docker-compose'
  | 'k8s'
  | 'static';

/** Statically-defined service entry for the 'static' discovery provider. */
export interface StaticServiceConfig {
  name: string;
  port: number;
  language: string;
  path?: string;
}

/** Kubernetes-specific configuration. */
export interface KubernetesConfig {
  enabled: boolean;
  namespace: string;
  apiServer?: string;
  token?: string;
}

export interface FraConfigSchema {
  /** Absolute path where cloned repos are stored */
  workspaceRoot: string;
  tracing: {
    backends: TracingBackendConfig[];
    defaultLookbackHours: number;
    maxTracesPerService: number;
    /** Explicit catalog-name → telemetry-name overrides */
    serviceNameMappings: Record<string, string>;
  };
  discovery: {
    minConfidenceThreshold: number;
    maxScanDepth: number;
    infraServicePatterns: string[];
    /** Which discovery providers to activate */
    providers: DiscoveryProviderType[];
    /** Statically-defined services (used when 'static' provider is active) */
    staticServices: StaticServiceConfig[];
  };
  analysis: {
    externalCallThreshold: number;
    confidenceMargin: number;
    minSampleSizeForHighConfidence: number;
    noiseFilter: {
      customAllowlist: string[];
      customBlocklist: string[];
    };
  };
  catalog: {
    defaultOwner: string;
    defaultLifecycle: string;
    dryRun: boolean;
  };
  /** Kubernetes-specific configuration */
  kubernetes: KubernetesConfig;
}

/**
 * Central configuration for the FRA plugin.
 *
 * Defaults replicate the existing hardcoded behaviour so Phase 1 is a
 * no-behaviour-change refactor. In Phase 2 this class will be wired to
 * Backstage's ConfigService so values can be set via app-config.yaml under
 * the `fra:` key.
 */
export class FraConfig {
  private readonly schema: FraConfigSchema;

  constructor(overrides: Partial<FraConfigSchema> = {}) {
    const defaults = FraConfig.defaults();
    this.schema = {
      ...defaults,
      ...overrides,
      tracing: {
        ...defaults.tracing,
        ...(overrides.tracing ?? {}),
        serviceNameMappings: {
          ...defaults.tracing.serviceNameMappings,
          ...(overrides.tracing?.serviceNameMappings ?? {}),
        },
      },
      discovery: {
        ...defaults.discovery,
        ...(overrides.discovery ?? {}),
      },
      analysis: {
        ...defaults.analysis,
        ...(overrides.analysis ?? {}),
        noiseFilter: {
          ...defaults.analysis.noiseFilter,
          ...(overrides.analysis?.noiseFilter ?? {}),
        },
      },
      catalog: { ...defaults.catalog, ...(overrides.catalog ?? {}) },
      kubernetes: {
        ...defaults.kubernetes,
        ...(overrides.kubernetes ?? {}),
      },
    };
  }

  /** Factory that matches the original hardcoded behaviour exactly. */
  static defaults(): FraConfigSchema {
    return {
      // Mirrors: path.join(process.cwd(), '..', '..', 'microservices')
      workspaceRoot: path.join(process.cwd(), '..', '..', 'microservices'),
      tracing: {
        backends: [
          {
            id: 'local-jaeger',
            type: 'jaeger',
            endpoint: 'http://localhost:16686',
            enabled: true,
          },
        ],
        defaultLookbackHours: 1,
        maxTracesPerService: 20000,
        serviceNameMappings: {},
      },
      discovery: {
        minConfidenceThreshold: 0.4,
        maxScanDepth: 3,
        infraServicePatterns: [
          'mongo',
          'redis',
          'rabbitmq',
          'postgres',
          'jaeger',
          'zipkin',
          'prometheus',
          'grafana',
        ],
        providers: ['monorepo', 'docker-compose'],
        staticServices: [],
      },
      analysis: {
        externalCallThreshold: 0.65,
        confidenceMargin: 0.05,
        minSampleSizeForHighConfidence: 100,
        noiseFilter: {
          customAllowlist: [],
          customBlocklist: [],
        },
      },
      catalog: {
        defaultOwner: 'team-platform',
        defaultLifecycle: 'production',
        dryRun: false,
      },
      kubernetes: {
        enabled: false,
        namespace: 'default',
      },
    };
  }

  get workspaceRoot(): string {
    return this.schema.workspaceRoot;
  }

  /** Path to a specific repo inside workspaceRoot. */
  repoPath(repoName: string): string {
    return path.join(this.schema.workspaceRoot, repoName);
  }

  /** Base URL of the primary (first enabled) Jaeger backend. */
  get jaegerBaseUrl(): string {
    const backend = this.schema.tracing.backends.find(
      b => b.enabled && b.type === 'jaeger',
    );
    return backend ? `${backend.endpoint}/api` : 'http://localhost:16686/api';
  }

  get tracingBackends(): TracingBackendConfig[] {
    return this.schema.tracing.backends;
  }

  get defaultLookbackHours(): number {
    return this.schema.tracing.defaultLookbackHours;
  }

  get maxTracesPerService(): number {
    return this.schema.tracing.maxTracesPerService;
  }

  get minConfidenceThreshold(): number {
    return this.schema.discovery.minConfidenceThreshold;
  }

  get maxScanDepth(): number {
    return this.schema.discovery.maxScanDepth;
  }

  get infraServicePatterns(): string[] {
    return this.schema.discovery.infraServicePatterns;
  }

  get externalCallThreshold(): number {
    return this.schema.analysis.externalCallThreshold;
  }

  get confidenceMargin(): number {
    return this.schema.analysis.confidenceMargin;
  }

  get minSampleSizeForHighConfidence(): number {
    return this.schema.analysis.minSampleSizeForHighConfidence;
  }

  get noiseFilterAllowlist(): string[] {
    return this.schema.analysis.noiseFilter.customAllowlist;
  }

  get noiseFilterBlocklist(): string[] {
    return this.schema.analysis.noiseFilter.customBlocklist;
  }

  get catalogDefaultOwner(): string {
    return this.schema.catalog.defaultOwner;
  }

  get catalogDefaultLifecycle(): string {
    return this.schema.catalog.defaultLifecycle;
  }

  get catalogDryRun(): boolean {
    return this.schema.catalog.dryRun;
  }

  get serviceNameMappings(): Record<string, string> {
    return this.schema.tracing.serviceNameMappings;
  }

  get discoveryProviders(): DiscoveryProviderType[] {
    return this.schema.discovery.providers;
  }

  get staticServices(): StaticServiceConfig[] {
    return this.schema.discovery.staticServices;
  }

  get kubernetesConfig(): KubernetesConfig {
    return this.schema.kubernetes;
  }

  /** Returns the raw schema for serialization (e.g. /fra/config endpoint). */
  toJSON(): FraConfigSchema {
    return { ...this.schema };
  }
}
