# Function Analytics Plugin — Generalization Plan

## Overview

The Function Analytics (FRA) plugin analyzes distributed traces to identify misplaced
functions across microservices. This document describes the plan to evolve it from a
tightly-coupled, single-setup tool into a fully generalizable, extensible plugin that
works with any tracing backend, any deployment environment, and any repository layout.

---

## Current State (Phase 1 — Done)

The original plugin was a 1,821-line monolith. Phase 1 split it into backend modules:

```
plugins/function-analytics-backend/src/modules/
├── config/FraConfig.ts
├── language/LanguageDetector.ts
├── discovery/ServiceDiscoveryEngine.ts
├── orchestration/
│   ├── DockerComposeAdapter.ts
│   ├── DockerfileFixerAdapter.ts
│   ├── ServerWrapperGenerator.ts
│   ├── CodeGenerationAdapter.ts
│   └── ScriptGenerationAdapter.ts
├── catalog/CatalogEntityBuilder.ts
├── ingestion/RepositoryIngestor.ts
├── analysis/
│   ├── FunctionCallAnalyzer.ts
│   └── RelocationDecisionEngine.ts
├── preprocessing/TracePreprocessor.ts
└── static-analysis/FunctionRegistryBuilder.ts
```

**What still needs fixing:**

| Problem                         | Impact                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| Only works with Jaeger          | Cannot use Zipkin, Datadog, Grafana Tempo                       |
| Only works with Docker Compose  | Cannot analyze K8s or cloud deployments                         |
| Single hardcoded repo path      | Cannot scan monorepos or multiple repos                         |
| Noise filters are hardcoded     | Users cannot customize what gets filtered                       |
| Service name mapping is a guess | Catalog name ↔ Jaeger name resolution breaks for unusual naming |
| No extension points             | Cannot add custom analyzers without forking the plugin          |

---

## Target Architecture — Provider / Adapter Pattern

Every major concern becomes a **swappable provider interface**.
Built-in implementations cover the common cases.
External teams can ship their own providers as npm packages.

```
┌─────────────────────────────────────────────────────────┐
│                   FRA Plugin Core                       │
│                                                         │
│  TraceSourceProvider     →  where traces come from      │
│  ServiceInventoryProvider →  which services exist       │
│  SpanProcessorChain      →  what to keep / filter       │
│  FunctionNameResolver    →  span → clean function name  │
│  ServiceNameResolver     →  catalog name ↔ trace name   │
│  AnalysisStrategy        →  how to score misplacement   │
│  DeploymentProvider      →  how to start services       │
└─────────────────────────────────────────────────────────┘
```

---

## Provider Interfaces

### TraceSourceProvider

Abstracts where traces come from.

```
interface TraceSourceProvider {
  type: string
  listServices(): Promise<string[]>
  fetchTraces(service, lookbackMs, limit): Promise<NormalizedTrace[]>
}
```

Built-in: `JaegerProvider`, `ZipkinProvider`, `OtlpHttpProvider`

---

### ServiceInventoryProvider

Abstracts how services are discovered.

```
interface ServiceInventoryProvider {
  type: string
  listServices(): Promise<DiscoveredService[]>
}
```

Built-in: `DockerComposeInventoryProvider`, `MonorepoInventoryProvider`,
`K8sInventoryProvider`, `StaticInventoryProvider`

---

### SpanProcessor

A single step in the span filtering chain.
Return `undefined` to drop a span, return the (modified) span to keep it.

```
interface SpanProcessor {
  name: string
  process(span, trace): NormalizedSpan | undefined
}
```

Built-in processors (applied in order):

| Processor                  | What it removes                                                 |
| -------------------------- | --------------------------------------------------------------- |
| `NoiseFilterProcessor`     | Health checks, metrics endpoints, bare HTTP verbs               |
| `DbSpanProcessor`          | SQL/Hibernate/JPA spans, `Transaction.*`                        |
| `InfraClientSpanProcessor` | Eureka/Zipkin heartbeat client calls                            |
| `SpanEnricherProcessor`    | Does not drop — adds computed tags like `fra.resolved_function` |

---

### FunctionNameResolver

Extracts a clean function name from a span.
Resolvers are tried in order; first non-null result wins.

```
interface FunctionNameResolver {
  name: string
  resolve(span): string | undefined
}
```

Built-in resolvers (priority order):

| Resolver              | Source                                                             |
| --------------------- | ------------------------------------------------------------------ |
| `FraTagResolver`      | `fra.function_name` span tag (authoritative)                       |
| `OtelSemconvResolver` | `code.function`, `function.name`, `rpc.method` tags                |
| `UrlPathResolver`     | `GET /owners/{id}/pets` → `pets` (skips IDs, UUIDs, `{vars}`, `*`) |
| `ClassMethodResolver` | `OwnerRepository.findAll` → `findAll`                              |
| `GrpcResolver`        | `/helloworld.Greeter/SayHello` → `SayHello`                        |

---

### ServiceNameResolver

Maps a Backstage catalog entity name to the name used in telemetry.
Resolvers are tried in order; first non-null result wins.

```
interface ServiceNameResolver {
  name: string
  resolve(catalogName, knownTelemetryNames): string | undefined
}
```

Built-in resolvers (priority order):

| Resolver                | Example                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `StaticMappingResolver` | Config: `spring-petclinic-customers-service: customers-service` |
| `ExactMatchResolver`    | `customers-service` is already in Jaeger → use as-is            |
| `SuffixVariantResolver` | Try adding/removing `-service`, `-svc` suffix                   |
| `PrefixStripResolver`   | `spring-petclinic-customers-service` → `customers-service`      |

---

### AnalysisStrategy

How to score whether a function belongs in its current service.

```
interface AnalysisStrategy {
  name: string
  analyze(traces, services): Promise<FunctionAnalysis[]>
}
```

Built-in: `CohesionAnalyzer` (existing logic — external call % threshold)

---

### DeploymentProvider

How to start, instrument, and generate traffic for services.

```
interface DeploymentProvider {
  type: string
  deploy(services, repoPath): Promise<void>
  generateTraffic(service, requestCount): Promise<number>
  teardown(services): Promise<void>
}
```

Built-in: `DockerComposeDeployment`, `K8sDeployment`, `NoopDeployment`

---

## Provider Registry

A single registry object wires everything together.
The router creates it at startup, registers built-in providers based on config,
then accepts extra providers from `RouterOptions` for custom extensions.

```typescript
const registry = new ProviderRegistry()
  .registerTraceSource(new JaegerProvider(config.tracing.jaeger.endpoint))
  .registerInventory(new DockerComposeInventoryProvider(config.repoPaths))
  .addSpanProcessor(new NoiseFilterProcessor(config.analysis.noiseFilter))
  .addSpanProcessor(new DbSpanProcessor())
  .addFunctionNameResolver(new FraTagResolver())
  .addFunctionNameResolver(new UrlPathResolver())
  .addServiceNameResolver(
    new StaticMappingResolver(config.tracing.serviceNameOverrides),
  )
  .addServiceNameResolver(new PrefixStripResolver())
  .registerAnalysisStrategy(new CohesionAnalyzer(config.analysis));
```

---

## FRA Pipeline

`FraPipeline` orchestrates the full analysis using the registry.
It replaces the ad-hoc logic currently scattered across `router.ts`.

```
runAnalysis()
  1. List services from all ServiceInventoryProviders
  2. For each catalog service → resolveServiceName() via ServiceNameResolvers
  3. fetchTraces() from TraceSourceProvider
  4. processSpan() — run each span through SpanProcessorChain
  5. resolveFunctionName() — extract name via FunctionNameResolvers
  6. analyze() — feed to AnalysisStrategy
  7. Return RelocationResult[]
```

---

## Updated Configuration (app-config.yaml)

```yaml
fra:
  # One or more repo roots to scan
  repoPath: /path/to/microservices # backward-compat single repo
  # repoPaths:                          # multi-repo alternative
  #   - /path/to/repo1
  #   - /path/to/repo2

  tracing:
    backend: jaeger # jaeger | zipkin | otlp
    jaeger:
      endpoint: http://localhost:16686
    zipkin:
      endpoint: http://localhost:9411
    otlp:
      endpoint: http://localhost:4318
    serviceNameOverrides: # static catalog→telemetry mappings
      spring-petclinic-customers-service: customers-service

  discovery:
    providers:
      - docker-compose # default
      # - monorepo                     # nx / lerna / pnpm workspaces
      # - k8s                          # Kubernetes
      # - static                       # manually listed services
    infraServicePatterns:
      - '*-db'
      - mongo
      - redis
    staticServices: # used when provider=static
      - name: payment-service
        port: 8080
        language: java

  analysis:
    externalCallThreshold: 0.65
    minSampleSizeForHighConfidence: 50
    noiseFilter:
      customBlocklist:
        - my-internal-heartbeat
      customAllowlist:
        - important-endpoint

  kubernetes:
    enabled: false
    namespace: production
```

---

## New File Layout

```
plugins/function-analytics-backend/src/
├── lib/
│   ├── types.ts               (unchanged — stable output contract)
│   ├── providers.ts           (NEW — all provider interfaces + NormalizedSpan/Trace)
│   ├── ProviderRegistry.ts    (NEW — wires providers together)
│   └── FraPipeline.ts         (NEW — orchestrates full analysis)
│
└── modules/
    ├── config/FraConfig.ts    (updated — multi-repo, multi-backend schema)
    ├── tracing/
    │   ├── JaegerProvider.ts         (NEW)
    │   ├── ZipkinProvider.ts         (NEW)
    │   ├── OtlpHttpProvider.ts       (NEW)
    │   ├── processors/
    │   │   ├── NoiseFilterProcessor.ts     (NEW)
    │   │   ├── DbSpanProcessor.ts          (NEW)
    │   │   ├── InfraClientSpanProcessor.ts (NEW)
    │   │   └── SpanEnricherProcessor.ts    (NEW)
    │   └── resolvers/
    │       ├── FraTagResolver.ts           (NEW)
    │       ├── OtelSemconvResolver.ts      (NEW)
    │       ├── UrlPathResolver.ts          (NEW)
    │       ├── ClassMethodResolver.ts      (NEW)
    │       ├── GrpcResolver.ts             (NEW)
    │       └── ServiceNameResolvers.ts     (NEW — all 4 service name resolvers)
    │
    └── discovery/
        ├── ServiceDiscoveryEngine.ts      (updated — delegates to providers)
        ├── DockerComposeInventoryProvider.ts (NEW)
        ├── MonorepoInventoryProvider.ts      (NEW)
        ├── K8sInventoryProvider.ts           (NEW)
        └── StaticInventoryProvider.ts        (NEW)

plugins/function-analytics/src/components/FunctionAnalyticsPage/
├── tracing/
│   ├── TraceSourceAdapter.ts    (NEW — frontend adapter interface)
│   ├── JaegerAdapter.ts         (NEW — moves logic from jaegerService.ts)
│   ├── ZipkinAdapter.ts         (NEW)
│   └── AdapterRegistry.ts       (NEW — singleton, reads /fra/providers)
├── traceService.ts              (NEW — replaces jaegerService.ts internals)
└── jaegerService.ts             (kept as thin re-export for backward compat)
```

---

## New API Endpoints

| Method | Path                                    | Description                              |
| ------ | --------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/function-analytics/fra/config`    | Returns active FraConfig as JSON         |
| `GET`  | `/api/function-analytics/fra/providers` | Lists all registered provider type names |

---

## Extensibility for External Teams

Any team can ship a custom provider as an npm package and register it:

```typescript
// packages/backend/src/index.ts
import { MyDatadogProvider } from '@my-org/fra-datadog-provider';

const backend = createBackend();
backend.add(import('@internal/plugin-function-analytics-backend'), {
  extraProviders: {
    traceSources: [new MyDatadogProvider({ apiKey: process.env.DD_API_KEY })],
  },
});
```

No plugin fork needed. The provider appears in `/fra/providers` and the frontend
automatically selects the right adapter.

---

## Backward Compatibility

All existing behavior is preserved:

- `app-config.yaml` with only `fra.repoPath` and `fra.jaegerBaseUrl` continues to work
- `jaegerService.ts` exports are unchanged (thin re-exports from `traceService.ts`)
- `FunctionAnalysis` and `RelocationResult` types in `lib/types.ts` are not modified
- The `GET /analyze` endpoint response format is unchanged

---

## Implementation Order

```
Step 1  →  lib/providers.ts          (core interfaces)
Step 2  →  lib/ProviderRegistry.ts   (wiring)
Step 3  →  tracing/JaegerProvider.ts + ZipkinProvider.ts + OtlpHttpProvider.ts
Step 4  →  tracing/processors/*      (4 span processors)
Step 5  →  tracing/resolvers/*       (5 function name resolvers)
Step 6  →  tracing/resolvers/ServiceNameResolvers.ts (4 service name resolvers)
Step 7  →  discovery/*InventoryProvider.ts (4 inventory providers)
Step 8  →  lib/FraPipeline.ts        (orchestration)
Step 9  →  config/FraConfig.ts       (updated schema + fromBackstageConfig())
Step 10 →  service/router.ts         (refactored to use FraPipeline)
Step 11 →  frontend tracing/         (adapter interface + JaegerAdapter + ZipkinAdapter)
Step 12 →  frontend traceService.ts  (replaces jaegerService.ts internals)
Step 13 →  app-config.yaml           (document the full new fra: block)
```
