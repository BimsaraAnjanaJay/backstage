# Quick Reference: OpenTelemetry Observability Stack

## 🚀 One-Line Deployment

```powershell
.\deploy-observability.ps1 -DeployServices
```

## 📋 Common Commands

### Deploy Stack

```powershell
# Full deployment
.\deploy-observability.ps1

# Skip prerequisites (cert-manager, OTel operator)
.\deploy-observability.ps1 -SkipPrerequisites

# Deploy with example services
.\deploy-observability.ps1 -DeployServices
```

### Access UIs

```powershell
# Jaeger UI
kubectl port-forward -n observability svc/jaeger-query 16686:16686
# Open: http://localhost:16686

# Backstage Function Analytics
cd backstage; yarn dev
# Open: http://localhost:3000/function-analytics
```

### Check Status

```powershell
# All observability components
kubectl get all -n observability

# OpenTelemetry Collector
kubectl get opentelemetrycollector -n observability

# Auto-instrumentation config
kubectl get instrumentation -n observability

# View logs
kubectl logs -n observability deployment/otel-collector
kubectl logs -n observability deployment/jaeger-all-in-one
```

## 🔧 Instrument a Service

### 1. Add Annotation to Deployment

**Choose your language:**

```yaml
# Node.js
instrumentation.opentelemetry.io/inject-nodejs: 'observability/auto-instrumentation'

# Python
instrumentation.opentelemetry.io/inject-python: 'observability/auto-instrumentation'

# Java
instrumentation.opentelemetry.io/inject-java: 'observability/auto-instrumentation'

# Go
instrumentation.opentelemetry.io/inject-go: 'observability/auto-instrumentation'

# .NET
instrumentation.opentelemetry.io/inject-dotnet: 'observability/auto-instrumentation'
```

### 2. Complete Deployment Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
  annotations:
    instrumentation.opentelemetry.io/inject-nodejs: 'observability/auto-instrumentation'
spec:
  template:
    metadata:
      labels:
        app: my-service
    spec:
      containers:
        - name: my-service
          image: my-registry/my-service:latest
          env:
            - name: OTEL_SERVICE_NAME
              value: 'my-service'
```

### 3. Restart Service

```powershell
kubectl rollout restart deployment/my-service
```

## 📝 Register in Backstage

### Create catalog-info.yaml

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: my-service
  annotations:
    jaegertracing.io/service-name: 'my-service'
    tracing.opentelemetry/instrumented: 'true'
    backstage.io/kubernetes-id: my-service
spec:
  type: service
  lifecycle: production
  owner: team-name
```

### Register in Backstage

1. Go to: http://localhost:3000/catalog-import
2. Register the `catalog-info.yaml` file

## 🔍 View Traces

### In Jaeger

1. Port-forward: `kubectl port-forward -n observability svc/jaeger-query 16686:16686`
2. Open: http://localhost:16686
3. Select service and search

### In Backstage Function Analytics

1. Open: http://localhost:3000/function-analytics
2. Services auto-discovered from catalog
3. Click "Refresh" to fetch traces
4. View tabs:
   - Function Details
   - Service Overview
   - Microservice Architecture
   - Function Placement Analysis

## 🐛 Troubleshooting

### Services Not Instrumented?

```powershell
# Check operator
kubectl get pods -n opentelemetry-operator-system

# Check instrumentation
kubectl describe instrumentation auto-instrumentation -n observability

# Check pod annotations
kubectl get pod <pod-name> -o jsonpath='{.metadata.annotations}' | jq
```

### No Traces Appearing?

```powershell
# Check collector
kubectl logs -n observability -l app.kubernetes.io/name=otel-collector.observability --tail=100

# Check Jaeger
kubectl logs -n observability deployment/jaeger-all-in-one --tail=100

# Test collector connectivity
kubectl run curl --image=curlimages/curl -i --rm --restart=Never -- \
  curl -v http://otel-collector.observability.svc.cluster.local:4318/v1/traces
```

### Pods Crashing?

```powershell
# Check events
kubectl get events -n observability --sort-by='.lastTimestamp'

# Describe failing pod
kubectl describe pod <pod-name> -n observability

# Check resource usage
kubectl top pods -n observability
```

## 📊 What Gets Traced

✅ **HTTP/REST** (Express, Flask, Spring Boot, Gin, ASP.NET)  
✅ **Databases** (PostgreSQL, MySQL, MongoDB, Redis)  
✅ **Message Queues** (RabbitMQ, Kafka, SQS)  
✅ **gRPC** (Client & Server)  
✅ **External HTTP Calls** (axios, fetch, requests)

## 🎯 Key Annotations

### For Deployments

```yaml
# Enable instrumentation
instrumentation.opentelemetry.io/inject-<language>: 'observability/auto-instrumentation'

# Inject collector sidecar
sidecar.opentelemetry.io/inject: 'true'
```

### For Backstage Catalog

```yaml
# Link to Jaeger
jaegertracing.io/service-name: 'service-name'

# Mark as instrumented
tracing.opentelemetry/instrumented: 'true'

# Kubernetes integration
backstage.io/kubernetes-id: service-name
backstage.io/kubernetes-namespace: default
```

## 🔄 Update Configuration

### Scale Collector

```powershell
kubectl scale deployment -n observability \
  -l app.kubernetes.io/name=otel-collector.observability \
  --replicas=5
```

### Change Sampling Rate

```powershell
kubectl edit instrumentation auto-instrumentation -n observability

# Update:
# sampler:
#   type: parentbased_traceidratio
#   argument: "0.1"  # 10% sampling
```

### Restart Components

```powershell
# Restart collector
kubectl rollout restart deployment -n observability \
  -l app.kubernetes.io/name=otel-collector.observability

# Restart Jaeger
kubectl rollout restart deployment/jaeger-all-in-one -n observability

# Restart instrumented services
kubectl rollout restart deployment -n default
```

## 📈 Scaling for Production

### For 100+ Services

**1. Scale Collector:**

```yaml
replicas: 5-10
resources:
  limits:
    cpu: 2000m
    memory: 4Gi
```

**2. Use Jaeger Operator:**

```powershell
# Install Jaeger Operator
kubectl create namespace observability
kubectl create -f https://github.com/jaegertracing/jaeger-operator/releases/download/v1.50.0/jaeger-operator.yaml -n observability

# Deploy production Jaeger with Elasticsearch
kubectl apply -f k8s/observability/jaeger-production.yaml
```

**3. Adjust Sampling:**

```yaml
# Sample 10% for high traffic
sampler:
  argument: '0.1'
```

## 📞 Quick Support

**Check logs:** `kubectl logs -n observability <pod-name>`  
**View events:** `kubectl get events -n observability`  
**Describe resource:** `kubectl describe <resource> -n observability`

---

**Need help? Check the full README: `k8s/README.md`**
