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
  TraceSourceProvider,
  ServiceInventoryProvider,
  SpanProcessor,
  FunctionNameResolver,
  ServiceNameResolver,
  AnalysisStrategy,
  DeploymentProvider,
} from './providers';
import { CohesionAnalyzer } from './FraPipeline';
import { FraConfig } from '../modules/config/FraConfig';
import { JaegerProvider } from '../modules/tracing/JaegerProvider';
import { ZipkinProvider } from '../modules/tracing/ZipkinProvider';
import { OtlpHttpProvider } from '../modules/tracing/OtlpHttpProvider';
import { NoiseFilterProcessor } from '../modules/tracing/processors/NoiseFilterProcessor';
import { DbSpanProcessor } from '../modules/tracing/processors/DbSpanProcessor';
import { InfraClientSpanProcessor } from '../modules/tracing/processors/InfraClientSpanProcessor';
import { SpanEnricherProcessor } from '../modules/tracing/processors/SpanEnricherProcessor';
import { FraTagResolver } from '../modules/tracing/resolvers/FraTagResolver';
import { OtelSemconvResolver } from '../modules/tracing/resolvers/OtelSemconvResolver';
import { HttpRouteResolver } from '../modules/tracing/resolvers/HttpRouteResolver';
import { ClassMethodResolver } from '../modules/tracing/resolvers/ClassMethodResolver';
import { UrlPathResolver } from '../modules/tracing/resolvers/UrlPathResolver';
import { GrpcResolver } from '../modules/tracing/resolvers/GrpcResolver';
import {
  StaticMappingResolver,
  ExactMatchResolver,
  SuffixVariantResolver,
  PrefixStripResolver,
} from '../modules/tracing/resolvers/ServiceNameResolvers';
import { DockerComposeInventoryProvider } from '../modules/discovery/DockerComposeInventoryProvider';
import { MonorepoInventoryProvider } from '../modules/discovery/MonorepoInventoryProvider';
import { K8sInventoryProvider } from '../modules/discovery/K8sInventoryProvider';
import { StaticInventoryProvider } from '../modules/discovery/StaticInventoryProvider';

/**
 * Central wiring point for all FRA provider/adapter implementations.
 *
 * Built once during plugin startup (typically in router.ts or plugin.ts).
 * The ProviderRegistry.fromConfig() factory creates a default registry
 * based on FraConfig; custom providers can be added via the fluent API.
 */
export class ProviderRegistry {
  private _traceSource: TraceSourceProvider | undefined;
  private _inventoryProviders: ServiceInventoryProvider[] = [];
  private _spanProcessors: SpanProcessor[] = [];
  private _functionNameResolvers: FunctionNameResolver[] = [];
  private _serviceNameResolvers: ServiceNameResolver[] = [];
  private _analysisStrategy: AnalysisStrategy | undefined;
  private _deploymentProvider: DeploymentProvider | undefined;

  // ── Fluent Registration API ────────────────────────────────────────────

  registerTraceSource(provider: TraceSourceProvider): this {
    this._traceSource = provider;
    return this;
  }

  registerInventory(provider: ServiceInventoryProvider): this {
    this._inventoryProviders.push(provider);
    return this;
  }

  addSpanProcessor(processor: SpanProcessor): this {
    this._spanProcessors.push(processor);
    return this;
  }

  addFunctionNameResolver(resolver: FunctionNameResolver): this {
    this._functionNameResolvers.push(resolver);
    return this;
  }

  addServiceNameResolver(resolver: ServiceNameResolver): this {
    this._serviceNameResolvers.push(resolver);
    return this;
  }

  registerAnalysisStrategy(strategy: AnalysisStrategy): this {
    this._analysisStrategy = strategy;
    return this;
  }

  registerDeployment(provider: DeploymentProvider): this {
    this._deploymentProvider = provider;
    return this;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get traceSource(): TraceSourceProvider {
    if (!this._traceSource) {
      throw new Error(
        'ProviderRegistry: no TraceSourceProvider registered. ' +
          'Call registerTraceSource() before using the registry.',
      );
    }
    return this._traceSource;
  }

  get inventoryProviders(): ServiceInventoryProvider[] {
    return this._inventoryProviders;
  }

  get spanProcessors(): SpanProcessor[] {
    return this._spanProcessors;
  }

  get functionNameResolvers(): FunctionNameResolver[] {
    return this._functionNameResolvers;
  }

  get serviceNameResolvers(): ServiceNameResolver[] {
    return this._serviceNameResolvers;
  }

  get analysisStrategy(): AnalysisStrategy {
    if (!this._analysisStrategy) {
      throw new Error(
        'ProviderRegistry: no AnalysisStrategy registered. ' +
          'Call registerAnalysisStrategy() before using the registry.',
      );
    }
    return this._analysisStrategy;
  }

  get deploymentProvider(): DeploymentProvider | undefined {
    return this._deploymentProvider;
  }

  // ── Introspection ──────────────────────────────────────────────────────

  /** Returns a summary of all registered provider type names (for /fra/providers endpoint). */
  listProviders(): Record<string, string[]> {
    return {
      traceSource: this._traceSource ? [this._traceSource.type] : [],
      inventory: this._inventoryProviders.map(p => p.type),
      spanProcessors: this._spanProcessors.map(p => p.name),
      functionNameResolvers: this._functionNameResolvers.map(r => r.name),
      serviceNameResolvers: this._serviceNameResolvers.map(r => r.name),
      analysisStrategy: this._analysisStrategy
        ? [this._analysisStrategy.name]
        : [],
      deployment: this._deploymentProvider
        ? [this._deploymentProvider.type]
        : [],
    };
  }

  // ── Factory ────────────────────────────────────────────────────────────

  /**
   * Creates a fully-wired ProviderRegistry from FraConfig.
   *
   * Registers the appropriate TraceSourceProvider based on config backend type,
   * the default span processor chain, function/service name resolver chains,
   * the default CohesionAnalyzer analysis strategy, and inventory providers.
   */
  static fromConfig(config: FraConfig): ProviderRegistry {
    const registry = new ProviderRegistry();

    // ── Trace source — first enabled backend wins ──────────────────────
    const enabledBackend = config.tracingBackends.find(b => b.enabled);
    if (enabledBackend) {
      switch (enabledBackend.type) {
        case 'jaeger':
          registry.registerTraceSource(
            new JaegerProvider(`${enabledBackend.endpoint}/api`),
          );
          break;
        case 'zipkin':
          registry.registerTraceSource(
            new ZipkinProvider(enabledBackend.endpoint),
          );
          break;
        case 'tempo':
        case 'otlp':
          registry.registerTraceSource(
            new OtlpHttpProvider(enabledBackend.endpoint),
          );
          break;
      }
    } else {
      // Fallback to default Jaeger
      registry.registerTraceSource(
        new JaegerProvider('http://localhost:16686/api'),
      );
    }

    // ── Span processors (order matters) ────────────────────────────────
    registry
      .addSpanProcessor(
        new NoiseFilterProcessor({
          customAllowlist: config.noiseFilterAllowlist,
          customBlocklist: config.noiseFilterBlocklist,
        }),
      )
      .addSpanProcessor(new DbSpanProcessor())
      .addSpanProcessor(new InfraClientSpanProcessor())
      .addSpanProcessor(new SpanEnricherProcessor());

    // ── Function name resolvers (priority order) ───────────────────────
    registry
      .addFunctionNameResolver(new FraTagResolver())
      .addFunctionNameResolver(new OtelSemconvResolver())
      .addFunctionNameResolver(new HttpRouteResolver())
      .addFunctionNameResolver(new ClassMethodResolver())
      .addFunctionNameResolver(new UrlPathResolver())
      .addFunctionNameResolver(new GrpcResolver());

    // ── Service name resolvers (priority order) ────────────────────────
    const mappings = config.serviceNameMappings;
    if (Object.keys(mappings).length > 0) {
      registry.addServiceNameResolver(new StaticMappingResolver(mappings));
    }
    registry
      .addServiceNameResolver(new ExactMatchResolver())
      .addServiceNameResolver(new SuffixVariantResolver())
      .addServiceNameResolver(new PrefixStripResolver());

    // ── Inventory providers ────────────────────────────────────────────
    const infraPatterns = config.infraServicePatterns;
    for (const providerType of config.discoveryProviders) {
      switch (providerType) {
        case 'monorepo':
          registry.registerInventory(
            new MonorepoInventoryProvider(infraPatterns),
          );
          break;
        case 'docker-compose':
          registry.registerInventory(
            new DockerComposeInventoryProvider(infraPatterns),
          );
          break;
        case 'k8s':
          if (config.kubernetesConfig.enabled) {
            registry.registerInventory(
              new K8sInventoryProvider(
                config.kubernetesConfig.namespace,
                config.kubernetesConfig.apiServer,
                config.kubernetesConfig.token,
              ),
            );
          }
          break;
        case 'static':
          if (config.staticServices.length > 0) {
            registry.registerInventory(
              new StaticInventoryProvider(config.staticServices),
            );
          }
          break;
      }
    }

    // ── Analysis strategy ──────────────────────────────────────────────
    registry.registerAnalysisStrategy(new CohesionAnalyzer());

    return registry;
  }
}
