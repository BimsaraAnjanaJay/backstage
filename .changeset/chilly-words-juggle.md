---
'@internal/plugin-function-analytics': major
'@internal/plugin-function-analytics-backend': minor
---

(function-analytics): add microservice tracing and placement analysis

Add Function Analytics plugin with OpenTelemetry integration for microservice tracing and placement analysis.

**New Features:**

- **Function Analytics Frontend Plugin**: Provides a comprehensive UI for analyzing function calls across microservices
  - Service discovery from Backstage catalog with `jaegertracing.io/service-name` annotations
  - Real-time trace fetching from Jaeger via OpenTelemetry
  - Function-level latency and error rate analysis
  - Cross-service dependency visualization
  - Misplaced function detection and placement recommendations

- **Function Analytics Backend Plugin**: Provides REST API endpoints for trace analysis
  - `/analyze` endpoint for function placement recommendations
  - Integration with Jaeger Query API
  - Trace preprocessing and analysis algorithms

- **Zero-Code Instrumentation Support**: Works with OpenTelemetry auto-instrumentation for Node.js, Python, Java, Go, and .NET services

**Configuration Changes:**

Add to your `app-config.yaml`:

```yaml
proxy:
  '/jaeger':
    target: 'http://localhost:16686'
    changeOrigin: true
    pathRewrite:
      '^/api/proxy/jaeger': ''
```

**Catalog Integration:**

Add annotations to your service entities:

```yaml
metadata:
  annotations:
    jaegertracing.io/service-name: 'your-service-name'
    tracing.opentelemetry/instrumented: 'true'
```

**Usage:**

Navigate to `/function-analytics` in your Backstage instance to access the plugin.