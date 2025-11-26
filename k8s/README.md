# OpenTelemetry Observability Stack for Backstage

This directory contains a complete, production-ready observability infrastructure using OpenTelemetry, Jaeger, and Prometheus, integrated with your Backstage Function Analytics plugin.

## 🎯 Overview

This setup enables **zero-code distributed tracing** for 100+ microservices using:

- **OpenTelemetry Operator** - Auto-instrumentation without code changes
- **Jaeger** - Distributed tracing backend
- **Prometheus** - Metrics collection
- **Backstage Integration** - View traces in Function Analytics plugin

## 📁 Directory Structure

```
k8s/
├── observability/
│   ├── otel-collector.yaml        # OpenTelemetry Collector configuration
│   ├── jaeger.yaml                # Jaeger all-in-one deployment
│   └── instrumentation.yaml       # Auto-instrumentation for Node.js, Python, Java, Go, .NET
├── services/
│   └── example-services.yaml      # Example microservices with annotations
└── catalog/
    ├── user-service-catalog.yaml
    ├── product-service-catalog.yaml
    └── order-service-catalog.yaml
```

## 🚀 Quick Start

### Prerequisites

1. **Kubernetes cluster** (local or cloud)

   ```powershell
   # For local development with Minikube
   minikube start --memory=8192 --cpus=4

   # Or with kind
   kind create cluster
   ```

2. **kubectl** installed and configured
   ```powershell
   kubectl version --client
   ```

### Deploy Everything

```powershell
# Deploy the entire observability stack
.\deploy-observability.ps1

# Or deploy with example services
.\deploy-observability.ps1 -DeployServices
```

### Manual Deployment

If you prefer manual deployment:

```powershell
# 1. Install Cert-Manager (required by OTel Operator)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=300s deployment/cert-manager -n cert-manager

# 2. Install OpenTelemetry Operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml
kubectl wait --for=condition=Available --timeout=300s deployment/opentelemetry-operator-controller-manager -n opentelemetry-operator-system

# 3. Deploy Observability Stack
kubectl apply -f k8s/observability/otel-collector.yaml
kubectl apply -f k8s/observability/jaeger.yaml
kubectl apply -f k8s/observability/instrumentation.yaml

# 4. (Optional) Deploy Example Services
kubectl apply -f k8s/services/example-services.yaml
```

## 🔧 Instrumenting Your Microservices

### Step 1: Add Annotation to Deployment

Add the appropriate auto-instrumentation annotation based on your language:

**Node.js:**

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-nodejs: 'observability/auto-instrumentation'
```

**Python:**

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-python: 'observability/auto-instrumentation'
```

**Java:**

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-java: 'observability/auto-instrumentation'
```

**Go:**

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-go: 'observability/auto-instrumentation'
```

**.NET:**

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-dotnet: 'observability/auto-instrumentation'
```

### Step 2: Set Service Name

Add environment variable to identify your service:

```yaml
env:
  - name: OTEL_SERVICE_NAME
    value: 'your-service-name'
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: 'service.version=1.0.0,microserviceType=api'
```

### Step 3: Restart Deployment

```powershell
kubectl rollout restart deployment/your-service-name
```

### Complete Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  annotations:
    # Enable Node.js auto-instrumentation
    instrumentation.opentelemetry.io/inject-nodejs: 'observability/auto-instrumentation'
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
        version: v1.0.0
    spec:
      containers:
        - name: payment-service
          image: your-registry/payment-service:latest
          ports:
            - containerPort: 3000
          env:
            - name: OTEL_SERVICE_NAME
              value: 'payment-service'
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: 'service.name=payment-service,service.version=1.0.0,microserviceType=api'
```

## 📝 Register Services in Backstage Catalog

Create `catalog-info.yaml` for each service:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-service
  description: Payment processing service
  annotations:
    # Link to Jaeger traces
    jaegertracing.io/service-name: 'payment-service'
    tracing.jaeger/endpoint: 'http://jaeger-query.observability.svc.cluster.local:16686'
    tracing.opentelemetry/instrumented: 'true'

    # Link to Prometheus metrics
    prometheus.io/rule: |
      service_request_duration_seconds_bucket{service="payment-service"}

    # Kubernetes metadata
    backstage.io/kubernetes-id: payment-service
    backstage.io/kubernetes-namespace: default

    service.version: '1.0.0'
    microserviceType: api

  tags:
    - microservice
    - nodejs
    - payments

spec:
  type: service
  lifecycle: production
  owner: team-payments
  system: payment-processing
```

Register in Backstage:

1. Go to http://localhost:3000/catalog-import
2. Click "Register Existing Component"
3. Add your `catalog-info.yaml` URL or file path

## 🔍 Accessing Observability Tools

### Jaeger UI

```powershell
# Port-forward Jaeger UI
kubectl port-forward -n observability svc/jaeger-query 16686:16686
```

Open: http://localhost:16686

### Backstage Function Analytics

```powershell
# Start Backstage
cd backstage
yarn dev
```

Open: http://localhost:3000/function-analytics

### Prometheus (if deployed)

```powershell
# Port-forward Prometheus
kubectl port-forward -n observability svc/prometheus 9090:9090
```

Open: http://localhost:9090

## 📊 What Gets Traced Automatically

The auto-instrumentation captures:

### HTTP/REST APIs

- ✅ Express.js (Node.js)
- ✅ Flask/FastAPI (Python)
- ✅ Spring Boot (Java)
- ✅ Gin/Chi (Go)
- ✅ ASP.NET Core (.NET)

### Databases

- ✅ PostgreSQL
- ✅ MySQL
- ✅ MongoDB
- ✅ Redis
- ✅ Elasticsearch

### Message Queues

- ✅ RabbitMQ
- ✅ Kafka
- ✅ AWS SQS

### gRPC

- ✅ Client & Server calls

### External HTTP Calls

- ✅ axios, fetch, http modules

## 🎯 Using Function Analytics Plugin

Once deployed and instrumented:

1. **Auto-Discovery**: Plugin discovers all services from Backstage catalog with `jaegertracing.io/service-name` annotation

2. **View Traces**: Navigate to `/function-analytics`

3. **Analyze Functions**:

   - **Function Details Tab**: See all function calls with latency, error rates
   - **Service Overview**: Service-level metrics and health
   - **Microservice Architecture**: Dependencies and bottlenecks
   - **Function Placement Analysis**: Optimization recommendations

4. **Identify Misplaced Functions**: Plugin automatically flags functions that:
   - Make excessive cross-service calls
   - Should be relocated to reduce latency
   - Create performance bottlenecks

## 🔧 Configuration

### app-config.yaml Updates

The deployment script has already updated your `app-config.yaml` with:

```yaml
# Jaeger proxy
proxy:
  '/jaeger':
    target: http://jaeger-query.observability.svc.cluster.local:16686

# Kubernetes integration
kubernetes:
  serviceLocatorMethod:
    type: 'multiTenant'
  clusterLocatorMethods:
    - type: 'config'
      clusters:
        - url: http://localhost:8001
          name: local-dev
          authProvider: 'serviceAccount'

# Catalog locations
catalog:
  locations:
    - type: file
      target: ../../k8s/catalog/user-service-catalog.yaml
    - type: file
      target: ../../k8s/catalog/product-service-catalog.yaml
    - type: file
      target: ../../k8s/catalog/order-service-catalog.yaml
```

### Custom Instrumentation Config

Edit `k8s/observability/instrumentation.yaml` to customize:

- Sampling rates
- Resource attributes
- Exporter endpoints
- Instrumentation libraries

## 🐛 Troubleshooting

### Services not instrumented?

```powershell
# Check if operator is running
kubectl get pods -n opentelemetry-operator-system

# Check instrumentation resource
kubectl get instrumentation -n observability

# Check pod annotations
kubectl get pod <pod-name> -o yaml | grep instrumentation
```

### No traces in Jaeger?

```powershell
# Check collector logs
kubectl logs -n observability deployment/otel-collector

# Check Jaeger logs
kubectl logs -n observability deployment/jaeger-all-in-one

# Verify collector service
kubectl get svc -n observability otel-collector
```

### Pods failing to start?

```powershell
# Check events
kubectl get events -n observability --sort-by='.lastTimestamp'

# Check pod logs
kubectl logs -n observability <pod-name>

# Describe pod
kubectl describe pod -n observability <pod-name>
```

### Services not showing in Backstage?

1. Check catalog registration:

   ```powershell
   # Go to Backstage UI
   http://localhost:3000/catalog
   ```

2. Verify annotation in `catalog-info.yaml`:

   ```yaml
   jaegertracing.io/service-name: 'your-service'
   ```

3. Check Backstage logs:
   ```powershell
   # In backstage directory
   yarn dev
   # Look for catalog errors
   ```

## 📈 Scaling for 100+ Services

### Resource Requirements

For 100 services, recommended resources:

**OpenTelemetry Collector:**

```yaml
replicas: 5-10
resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 2000m
    memory: 4Gi
```

**Jaeger:**

- Consider Jaeger Operator with Elasticsearch backend
- Use dedicated storage (not memory-based)
- Scale query replicas: 3-5

**Edit configurations:**

```powershell
# Edit collector
kubectl edit opentelemetrycollector otel-collector -n observability

# Edit Jaeger
kubectl edit deployment jaeger-all-in-one -n observability
```

### Sampling Strategy

For high-volume environments, adjust sampling:

```yaml
# In instrumentation.yaml
sampler:
  type: parentbased_traceidratio
  argument: '0.1' # Sample 10% of traces
```

## 🎓 Next Steps

1. **Deploy to Production**:

   - Use Jaeger with Elasticsearch/Cassandra backend
   - Configure persistent storage
   - Set up high availability

2. **Add More Services**:

   - Apply annotations to all 100 services
   - Create catalog entries
   - Rollout restart deployments

3. **Custom Metrics**:

   - Add custom spans in code
   - Define SLIs/SLOs
   - Set up alerts

4. **Advanced Analysis**:
   - Use Function Analytics to identify bottlenecks
   - Optimize cross-service calls
   - Implement placement recommendations

## 📚 Resources

- [OpenTelemetry Docs](https://opentelemetry.io/docs/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [OTel Operator](https://github.com/open-telemetry/opentelemetry-operator)
- [Backstage Kubernetes Plugin](https://backstage.io/docs/features/kubernetes/)

## 🤝 Support

For issues or questions:

1. Check logs: `kubectl logs -n observability <pod-name>`
2. Review events: `kubectl get events -n observability`
3. Verify configuration: `kubectl describe <resource> -n observability`

---

**Happy Tracing! 🚀**
