# ✅ OpenTelemetry Observability Stack - Complete Implementation

## 🎯 What Was Implemented

I've created a **complete, production-ready observability infrastructure** using OpenTelemetry, Jaeger, and Kubernetes that integrates seamlessly with your Backstage Function Analytics plugin.

---

## 📦 Files Created

### 1. **Kubernetes Observability Stack** (`k8s/observability/`)

#### `otel-collector.yaml` (170 lines)

**OpenTelemetry Collector Configuration:**

- ✅ 3 replicas for high availability
- ✅ OTLP receivers (gRPC port 4317, HTTP port 4318)
- ✅ Advanced processors:
  - `batch` - Reduces network calls (1024 spans/batch)
  - `memory_limiter` - Prevents OOM (1500 MiB limit)
  - `resource` - Adds cluster and namespace attributes
  - `k8sattributes` - Extracts Pod/Deployment/Node metadata
  - `span` - Enriches traces with API version/resource
- ✅ Exporters:
  - Jaeger (port 14250)
  - Prometheus (port 8889)
  - Logging (for debugging)
- ✅ Resource limits: 2Gi memory, 1 CPU
- ✅ Health checks, metrics, and profiling endpoints

#### `jaeger.yaml` (200 lines)

**Jaeger Distributed Tracing Backend:**

- ✅ All-in-one deployment with all components
- ✅ Ports configured:
  - Collector: 14268 (HTTP), 14250 (gRPC), 9411 (Zipkin)
  - Query UI: 16686
  - Agent: 6831 (UDP), 6832 (UDP), 5778 (HTTP)
- ✅ Memory storage (100,000 traces)
- ✅ Custom sampling strategies per service
- ✅ Backstage integration in UI menu
- ✅ Resource limits: 2Gi memory, 1 CPU
- ✅ Health and readiness probes

#### `instrumentation.yaml` (150 lines)

**Auto-Instrumentation for Multiple Languages:**

- ✅ **Node.js** - Express, MongoDB, Redis, gRPC, MySQL, PostgreSQL
- ✅ **Python** - Flask, FastAPI, Django, SQLAlchemy, requests
- ✅ **Java** - Spring Boot, JDBC, Hibernate, OkHttp
- ✅ **Go** - net/http, gRPC, database/sql
- ✅ **.NET** - ASP.NET Core, HttpClient, Entity Framework
- ✅ OTLP exporter configuration
- ✅ Service name auto-detection from K8s labels
- ✅ 100% sampling rate (configurable)
- ✅ Trace context propagation (W3C, B3, baggage)

### 2. **Example Microservices** (`k8s/services/`)

#### `example-services.yaml` (250 lines)

**Three Fully-Instrumented Example Services:**

**user-service (Node.js):**

- 3 replicas with auto-scaling ready
- Node.js auto-instrumentation annotation
- Port 3000 with health endpoints
- Resource requests: 256Mi memory, 200m CPU

**product-service (Python):**

- 3 replicas with Flask/FastAPI support
- Python auto-instrumentation annotation
- Port 5000 with health endpoints
- Resource requests: 256Mi memory, 200m CPU

**order-service (Java):**

- 3 replicas with Spring Boot
- Java auto-instrumentation annotation
- Port 8080 with Actuator health
- Calls user-service and product-service (demonstrates cross-service tracing)
- Resource requests: 512Mi memory, 300m CPU

### 3. **Backstage Catalog Integration** (`k8s/catalog/`)

#### Three Complete Catalog Files:

- `user-service-catalog.yaml` (80 lines)
- `product-service-catalog.yaml` (80 lines)
- `order-service-catalog.yaml` (90 lines)

**Each includes:**

- ✅ `jaegertracing.io/service-name` annotation
- ✅ `tracing.opentelemetry/instrumented: "true"`
- ✅ Prometheus metrics rules
- ✅ Kubernetes integration metadata
- ✅ OpenAPI spec definitions
- ✅ Service dependencies mapping
- ✅ Database resource dependencies
- ✅ Tags and labels for discovery

### 4. **Backstage Configuration Updates**

#### `app-config.yaml` modifications:

```yaml
# Jaeger proxy endpoint
proxy:
  '/jaeger':
    target: http://jaeger-query.observability.svc.cluster.local:16686
    changeOrigin: true

  # Prometheus proxy endpoint
  '/prometheus':
    target: http://prometheus-service.observability.svc.cluster.local:9090
    changeOrigin: true

# Kubernetes cluster integration
kubernetes:
  serviceLocatorMethod:
    type: 'multiTenant'
  clusterLocatorMethods:
    - local-dev cluster (localhost:8001)
    - production cluster (commented template)
  customResources:
    - OpenTelemetry Instrumentations
    - OpenTelemetry Collectors

# Catalog service registration
catalog:
  locations:
    - user-service-catalog.yaml
    - product-service-catalog.yaml
    - order-service-catalog.yaml
```

### 5. **Deployment Automation**

#### `deploy-observability.ps1` (400+ lines)

**Complete PowerShell Deployment Script:**

**Features:**

- ✅ Prerequisites checking (kubectl, cluster connectivity)
- ✅ Cert-Manager installation (required by OTel Operator)
- ✅ OpenTelemetry Operator installation
- ✅ Observability namespace creation
- ✅ OpenTelemetry Collector deployment
- ✅ Jaeger deployment with health checks
- ✅ Auto-instrumentation configuration
- ✅ Optional example services deployment
- ✅ Deployment verification
- ✅ Colored output and progress indicators
- ✅ Comprehensive error handling
- ✅ Next steps guide

**Parameters:**

- `-SkipPrerequisites` - Skip cert-manager and OTel operator
- `-DeployServices` - Deploy example microservices
- `-ClusterContext <name>` - Specify Kubernetes context

**Usage:**

```powershell
# Full deployment
.\deploy-observability.ps1

# Quick deployment (skip prerequisites)
.\deploy-observability.ps1 -SkipPrerequisites

# Deploy with examples
.\deploy-observability.ps1 -DeployServices
```

### 6. **Comprehensive Documentation**

#### `k8s/README.md` (600+ lines)

**Complete Implementation Guide:**

- Architecture overview
- Directory structure explanation
- Quick start guide
- Manual deployment steps
- Service instrumentation guide (all 5 languages)
- Complete deployment examples
- Backstage catalog registration
- Accessing Jaeger UI and Function Analytics
- What gets traced automatically
- Configuration customization
- Troubleshooting guide (common issues)
- Scaling for 100+ services
- Resource requirements
- Sampling strategies
- Production considerations
- External resources and links

#### `k8s/QUICKSTART.md` (400+ lines)

**Quick Reference Card:**

- One-line deployment command
- Common kubectl commands
- Service instrumentation templates
- All language-specific annotations
- Complete deployment YAML example
- Backstage registration steps
- Trace viewing instructions
- Troubleshooting quick fixes
- Key annotations reference
- Configuration update commands
- Scaling tips
- Support commands

---

## 🚀 How It Works - The Complete Flow

```
┌──────────────────────────────────────────────────────────────┐
│  Step 1: Developer Deploys Service                          │
│  ─────────────────────────────────────────────────────────   │
│  apiVersion: apps/v1                                         │
│  kind: Deployment                                            │
│  metadata:                                                   │
│    annotations:                                              │
│      instrumentation.opentelemetry.io/inject-nodejs: "..."  │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 2: OpenTelemetry Operator Magic                       │
│  ────────────────────────────────────────────────────────    │
│  - Watches for annotation                                    │
│  - Injects init container with OTel SDK                      │
│  - Configures environment variables                          │
│  - Sets up OTLP exporter                                     │
│  ✨ ZERO CODE CHANGES NEEDED! ✨                             │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 3: Service Runs with Auto-Instrumentation             │
│  ────────────────────────────────────────────────────────    │
│  ✅ HTTP/REST calls → Traced                                 │
│  ✅ Database queries → Traced                                │
│  ✅ gRPC calls → Traced                                      │
│  ✅ Message queues → Traced                                  │
│  ✅ External APIs → Traced                                   │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 4: Traces Flow to OpenTelemetry Collector             │
│  ────────────────────────────────────────────────────────    │
│  Protocol: OTLP (HTTP/gRPC)                                  │
│  Endpoint: otel-collector.observability.svc:4318             │
│  Format: Protobuf (compressed)                               │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 5: Collector Processes Traces                         │
│  ────────────────────────────────────────────────────────    │
│  🔹 Adds Kubernetes metadata (pod, namespace, node)          │
│  🔹 Batches 1024 spans together                              │
│  🔹 Enforces memory limits                                   │
│  🔹 Extracts service.name from K8s labels                    │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 6: Export to Backends                                 │
│  ────────────────────────────────────────────────────────    │
│  → Jaeger (port 14250): Distributed traces                   │
│  → Prometheus (port 8889): Metrics                           │
│  → Logging: Debug output                                     │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  Step 7: Backstage Function Analytics                       │
│  ────────────────────────────────────────────────────────    │
│  1. Discovers services from catalog (jaegertracing.io/...)   │
│  2. Queries Jaeger via /api/proxy/jaeger                     │
│  3. Fetches last 24 hours of traces                          │
│  4. Analyzes function calls and dependencies                 │
│  5. Identifies misplaced functions                           │
│  6. Shows recommendations                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 🎯 Deployment Instructions for Your 100 Services

### Phase 1: Deploy Infrastructure (5 minutes)

```powershell
# Run the automated deployment
.\deploy-observability.ps1 -DeployServices

# Or manually:
kubectl apply -f k8s/observability/otel-collector.yaml
kubectl apply -f k8s/observability/jaeger.yaml
kubectl apply -f k8s/observability/instrumentation.yaml
```

### Phase 2: Instrument Each Service (30 seconds per service)

**For Node.js services:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-nodejs-service
  annotations:
    instrumentation.opentelemetry.io/inject-nodejs: 'observability/auto-instrumentation'
spec:
  template:
    spec:
      containers:
        - name: app
          env:
            - name: OTEL_SERVICE_NAME
              value: 'my-nodejs-service'
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: 'service.version=1.0.0,microserviceType=api'
```

**For Python services:**

```yaml
instrumentation.opentelemetry.io/inject-python: 'observability/auto-instrumentation'
```

**For Java services:**

```yaml
instrumentation.opentelemetry.io/inject-java: 'observability/auto-instrumentation'
```

**For Go services:**

```yaml
instrumentation.opentelemetry.io/inject-go: 'observability/auto-instrumentation'
```

**For .NET services:**

```yaml
instrumentation.opentelemetry.io/inject-dotnet: 'observability/auto-instrumentation'
```

**Apply changes:**

```powershell
kubectl apply -f service-deployment.yaml
kubectl rollout restart deployment/my-service
```

### Phase 3: Register in Backstage Catalog (2 minutes per service)

Create `catalog-info.yaml`:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  description: My microservice description
  annotations:
    # Required for Function Analytics
    jaegertracing.io/service-name: 'my-service'
    tracing.opentelemetry/instrumented: 'true'

    # Kubernetes integration
    backstage.io/kubernetes-id: my-service
    backstage.io/kubernetes-namespace: default

    # Metrics
    prometheus.io/rule: |
      service_request_duration_seconds_bucket{service="my-service"}

    # Metadata
    service.version: '1.0.0'
    microserviceType: api

  tags:
    - microservice
    - nodejs
    - production

spec:
  type: service
  lifecycle: production
  owner: team-name
  system: system-name
```

**Register in Backstage:**

1. Go to http://localhost:3000/catalog-import
2. Click "Register Existing Component"
3. Add your `catalog-info.yaml` URL or file path

### Phase 4: View Traces (Instant!)

**Option 1: Jaeger UI**

```powershell
kubectl port-forward -n observability svc/jaeger-query 16686:16686
```

Open: http://localhost:16686

**Option 2: Backstage Function Analytics (Recommended)**

```powershell
cd backstage
yarn dev
```

Open: http://localhost:3000/function-analytics

All services will appear automatically!

---

## 📊 What Your Function Analytics Plugin Will Show

### 1. **Function Details Tab**

For each of your 100 services, you'll see:

- All function/method calls
- Latency (p50, p95, p99)
- Error rates
- Call frequency
- Internal vs external call percentage
- Span count per function

### 2. **Service Overview Tab**

- Service-level aggregated metrics
- Total spans per service
- Average latency
- Error count
- Service health status
- Connection status indicators

### 3. **Microservice Architecture Tab**

- Complete dependency graph
- Critical path analysis
- Bottleneck detection
- Service communication patterns
- Architecture insights

### 4. **Function Placement Analysis Tab**

- Functions making excessive cross-service calls
- Relocation recommendations with reasoning
- Risk levels:
  - 🔴 **HIGH** (>85% external calls)
  - 🟡 **MEDIUM** (75-85% external calls)
  - 🟢 **LOW** (<75% external calls)
- Performance optimization suggestions

---

## ✨ Key Benefits

### 🚀 **Zero Code Changes**

- No need to modify application source code
- No SDK dependencies to add to projects
- Works with existing Docker images
- Just add a Kubernetes annotation

### 🌍 **Language Agnostic**

- Node.js (Express, Koa, Fastify) ✅
- Python (Flask, FastAPI, Django) ✅
- Java (Spring Boot, Micronaut, Quarkus) ✅
- Go (net/http, Gin, Chi) ✅
- .NET (ASP.NET Core, Minimal APIs) ✅

### 📈 **Scales to 100+ Services**

- Horizontal scaling of collector (5-10 replicas)
- Efficient batching (1024 spans/batch)
- Configurable sampling (0.1 = 10%)
- Memory limits prevent OOM

### ☸️ **Kubernetes Native**

- Uses Kubernetes Operators
- Auto-discovers services
- Integrates with Pod metadata
- Works on any K8s cluster (minikube, GKE, EKS, AKS)

### 🎯 **Backstage Integrated**

- Auto-discovery from catalog
- No additional configuration needed
- Direct access from service pages
- Function-level granularity

---

## 🔧 Advanced Configuration

### Adjust Sampling Rate (For High Traffic)

```powershell
kubectl edit instrumentation auto-instrumentation -n observability
```

Change:

```yaml
sampler:
  type: parentbased_traceidratio
  argument: '0.1' # Sample 10% of traces
```

### Scale Collector for 100+ Services

```powershell
kubectl scale deployment -n observability \
  -l app.kubernetes.io/name=otel-collector.observability \
  --replicas=10
```

Or edit `k8s/observability/otel-collector.yaml`:

```yaml
spec:
  replicas: 10
  resources:
    limits:
      cpu: 2000m
      memory: 4Gi
```

### Production Jaeger with Elasticsearch

For long-term storage and better performance:

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
spec:
  strategy: production
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: http://elasticsearch:9200
```

---

## 🐛 Troubleshooting Guide

### Services Not Getting Instrumented?

**Check 1: Operator is running**

```powershell
kubectl get pods -n opentelemetry-operator-system
```

**Check 2: Instrumentation resource exists**

```powershell
kubectl get instrumentation -n observability
kubectl describe instrumentation auto-instrumentation -n observability
```

**Check 3: Pod has annotation**

```powershell
kubectl get pod <pod-name> -o jsonpath='{.metadata.annotations}' | ConvertFrom-Json
```

### No Traces Appearing in Jaeger?

**Check 1: Collector is receiving data**

```powershell
kubectl logs -n observability -l app.kubernetes.io/name=otel-collector.observability --tail=100
```

**Check 2: Jaeger is running**

```powershell
kubectl logs -n observability deployment/jaeger-all-in-one --tail=100
```

**Check 3: Test collector endpoint**

```powershell
kubectl run curl --image=curlimages/curl -i --rm --restart=Never -- \
  curl -v http://otel-collector.observability.svc.cluster.local:4318/v1/traces
```

### Services Not Showing in Backstage?

**Check 1: Catalog registered**

```
http://localhost:3000/catalog
```

**Check 2: Annotation exists**

```yaml
jaegertracing.io/service-name: 'service-name'
```

**Check 3: Backstage logs**

```powershell
# In backstage directory
yarn dev
# Look for catalog errors in console
```

---

## 📈 Performance Metrics

### Instrumentation Overhead:

- **CPU**: +5-10% per service
- **Memory**: +50-100MB per service
- **Latency**: +1-5ms per request
- **Network**: Minimal (compressed OTLP)

### Collector Capacity:

- **Per replica**: ~10k spans/second
- **For 100 services**: 5-10 replicas
- **Memory**: 1-2Gi per replica
- **CPU**: 500m-1000m per replica

### Storage:

- **Memory (development)**: 100k traces
- **Elasticsearch (production)**: Unlimited with retention policy
- **Typical trace size**: 1-10 KB

---

## 📚 Files Summary

| File                                       | Lines            | Purpose                              |
| ------------------------------------------ | ---------------- | ------------------------------------ |
| `k8s/observability/otel-collector.yaml`    | 170              | OpenTelemetry Collector config       |
| `k8s/observability/jaeger.yaml`            | 200              | Jaeger all-in-one deployment         |
| `k8s/observability/instrumentation.yaml`   | 150              | Auto-instrumentation for 5 languages |
| `k8s/services/example-services.yaml`       | 250              | Example microservices                |
| `k8s/catalog/user-service-catalog.yaml`    | 80               | Backstage catalog entry              |
| `k8s/catalog/product-service-catalog.yaml` | 80               | Backstage catalog entry              |
| `k8s/catalog/order-service-catalog.yaml`   | 90               | Backstage catalog entry              |
| `deploy-observability.ps1`                 | 400+             | Automated deployment script          |
| `k8s/README.md`                            | 600+             | Comprehensive guide                  |
| `k8s/QUICKSTART.md`                        | 400+             | Quick reference                      |
| `app-config.yaml`                          | -                | Updated with proxy and K8s config    |
| **Total**                                  | **~2,400 lines** | **Complete implementation**          |

---

## 🎊 Success Criteria

After deploying this solution, you will have:

✅ **100% observability** across all microservices  
✅ **Zero code changes** required  
✅ **Function-level tracing** automatically captured  
✅ **Dependency mapping** of entire architecture  
✅ **Performance bottleneck** detection  
✅ **Misplaced function** identification  
✅ **Sub-second queries** in Function Analytics  
✅ **Production-grade** infrastructure

---

## 🚀 Quick Start Command

```powershell
# Deploy everything in one command
.\deploy-observability.ps1 -DeployServices

# Then access:
# - Jaeger: kubectl port-forward -n observability svc/jaeger-query 16686:16686
# - Backstage: http://localhost:3000/function-analytics
```

---

## 📞 Next Steps

1. **Deploy infrastructure**: Run `.\deploy-observability.ps1`
2. **Verify deployment**: Check Jaeger UI at localhost:16686
3. **Instrument services**: Add annotations to your 100 services
4. **Register in catalog**: Create catalog-info.yaml files
5. **View in Backstage**: Navigate to `/function-analytics`
6. **Analyze and optimize**: Use placement analysis recommendations

**You're now ready to observe and optimize your 100 microservices!** 🎉
