# Microservice Instrumentation Guide
## Connecting simple-microservice-example with Backstage Function Analytics

This guide will help you instrument the microservices from https://github.com/kasvith/simple-microservice-example and connect them to your Function Analytics plugin.

---

## 📋 Overview

The simple-microservice-example includes:
- **User Service** (Go) - Port 8080
- **Product Service** (Node.js) - Port 3000  
- **Order Service** (Python) - Port 5000

---

## 🎯 Step 1: Start Jaeger

Run Jaeger all-in-one for local development:

```powershell
# Using Docker
docker run -d --name jaeger `
  -e COLLECTOR_ZIPKIN_HOST_PORT=:9411 `
  -p 5775:5775/udp `
  -p 6831:6831/udp `
  -p 6832:6832/udp `
  -p 5778:5778 `
  -p 16686:16686 `
  -p 14268:14268 `
  -p 14250:14250 `
  -p 9411:9411 `
  jaegertracing/all-in-one:latest
```

Verify Jaeger UI: http://localhost:16686

---

## 🔧 Step 2: Instrument Each Service

### A. User Service (Go - Port 8080)

**1. Add dependencies:**
```bash
cd user-service
go get github.com/opentracing/opentracing-go
go get github.com/uber/jaeger-client-go
```

**2. Update `main.go`:**
```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "io"
    
    "github.com/opentracing/opentracing-go"
    "github.com/opentracing/opentracing-go/ext"
    "github.com/uber/jaeger-client-go"
    "github.com/uber/jaeger-client-go/config"
)

func initJaeger(serviceName string) (opentracing.Tracer, io.Closer) {
    cfg := &config.Configuration{
        ServiceName: serviceName,
        Sampler: &config.SamplerConfig{
            Type:  "const",
            Param: 1,
        },
        Reporter: &config.ReporterConfig{
            LogSpans:           true,
            LocalAgentHostPort: "localhost:6831",
        },
    }
    
    tracer, closer, err := cfg.NewTracer(config.Logger(jaeger.StdLogger))
    if err != nil {
        log.Fatal(err)
    }
    
    return tracer, closer
}

type User struct {
    ID    string `json:"id"`
    Name  string `json:"name"`
    Email string `json:"email"`
}

func getUserHandler(w http.ResponseWriter, r *http.Request) {
    span := opentracing.StartSpan("getUserHandler")
    defer span.Finish()
    
    span.SetTag("http.method", r.Method)
    span.SetTag("http.url", r.URL.Path)
    span.SetTag("microserviceType", "api")
    
    user := User{
        ID:    "1",
        Name:  "John Doe",
        Email: "john@example.com",
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
    
    span.SetTag("http.status_code", 200)
}

func main() {
    tracer, closer := initJaeger("user-service")
    defer closer.Close()
    opentracing.SetGlobalTracer(tracer)
    
    http.HandleFunc("/api/users", getUserHandler)
    
    log.Println("User service starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

---

### B. Product Service (Node.js - Port 3000)

**1. Add dependencies:**
```bash
cd product-service
npm install jaeger-client
npm install express
```

**2. Update `index.js`:**
```javascript
const express = require('express');
const initJaeger = require('jaeger-client').initTracer;

const serviceName = 'product-service';

// Initialize Jaeger tracer
const config = {
  serviceName: serviceName,
  sampler: {
    type: 'const',
    param: 1,
  },
  reporter: {
    logSpans: true,
    agentHost: 'localhost',
    agentPort: 6831,
  },
};

const options = {
  logger: {
    info: (msg) => console.log('INFO', msg),
    error: (msg) => console.log('ERROR', msg),
  },
};

const tracer = initJaeger(config, options);

const app = express();

// Middleware to create spans
app.use((req, res, next) => {
  const span = tracer.startSpan(`${req.method} ${req.path}`);
  span.setTag('http.method', req.method);
  span.setTag('http.url', req.originalUrl);
  span.setTag('microserviceType', 'api');
  
  res.on('finish', () => {
    span.setTag('http.status_code', res.statusCode);
    span.finish();
  });
  
  req.span = span;
  next();
});

// Routes
app.get('/api/products', (req, res) => {
  const childSpan = tracer.startSpan('getProducts', { childOf: req.span });
  
  const products = [
    { id: '1', name: 'Product A', price: 100 },
    { id: '2', name: 'Product B', price: 200 },
  ];
  
  childSpan.finish();
  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const childSpan = tracer.startSpan('getProductById', { childOf: req.span });
  childSpan.setTag('product.id', req.params.id);
  
  const product = { id: req.params.id, name: 'Product A', price: 100 };
  
  childSpan.finish();
  res.json(product);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Product service listening on port ${PORT}`);
});
```

---

### C. Order Service (Python - Port 5000)

**1. Add dependencies:**
```bash
cd order-service
pip install flask
pip install jaeger-client
pip install requests
```

**2. Update `app.py`:**
```python
from flask import Flask, jsonify, request
from jaeger_client import Config
import requests
import logging

app = Flask(__name__)

# Configure Jaeger
def init_jaeger(service_name):
    config = Config(
        config={
            'sampler': {'type': 'const', 'param': 1},
            'local_agent': {'reporting_host': 'localhost', 'reporting_port': 6831},
            'logging': True,
        },
        service_name=service_name,
    )
    return config.initialize_tracer()

tracer = init_jaeger('order-service')

@app.route('/api/orders', methods=['GET'])
def get_orders():
    with tracer.start_span('GET /api/orders') as span:
        span.set_tag('http.method', 'GET')
        span.set_tag('http.url', '/api/orders')
        span.set_tag('microserviceType', 'api')
        
        orders = [
            {'id': '1', 'userId': '1', 'productId': '1', 'quantity': 2},
            {'id': '2', 'userId': '2', 'productId': '2', 'quantity': 1}
        ]
        
        span.set_tag('http.status_code', 200)
        return jsonify(orders)

@app.route('/api/orders', methods=['POST'])
def create_order():
    with tracer.start_span('POST /api/orders') as span:
        span.set_tag('http.method', 'POST')
        span.set_tag('http.url', '/api/orders')
        span.set_tag('microserviceType', 'api')
        
        # Call user-service (external call)
        with tracer.start_span('call-user-service', child_of=span) as user_span:
            user_span.set_tag('service.name', 'user-service')
            try:
                user_response = requests.get('http://localhost:8080/api/users')
                user_span.set_tag('http.status_code', user_response.status_code)
            except Exception as e:
                user_span.set_tag('error', True)
                user_span.log_kv({'event': 'error', 'message': str(e)})
        
        # Call product-service (external call)
        with tracer.start_span('call-product-service', child_of=span) as product_span:
            product_span.set_tag('service.name', 'product-service')
            try:
                product_response = requests.get('http://localhost:3000/api/products/1')
                product_span.set_tag('http.status_code', product_response.status_code)
            except Exception as e:
                product_span.set_tag('error', True)
                product_span.log_kv({'event': 'error', 'message': str(e)})
        
        order = {
            'id': '3',
            'userId': '1',
            'productId': '1',
            'quantity': 1,
            'status': 'created'
        }
        
        span.set_tag('http.status_code', 201)
        return jsonify(order), 201

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
```

---

## 📝 Step 3: Register Services in Backstage Catalog

Create catalog files for each service:

**`catalog-info-user-service.yaml`:**
```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: user-service
  description: User management microservice
  annotations:
    jaegertracing.io/service-name: user-service
    tracing.jaeger/endpoint: http://localhost:16686
    tracing.opentelemetry/instrumented: 'true'
    environment: development
  tags:
    - microservice
    - go
spec:
  type: service
  lifecycle: production
  owner: team-backend
  system: microservices-example
```

**`catalog-info-product-service.yaml`:**
```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: product-service
  description: Product catalog microservice
  annotations:
    jaegertracing.io/service-name: product-service
    tracing.jaeger/endpoint: http://localhost:16686
    tracing.opentelemetry/instrumented: 'true'
    environment: development
  tags:
    - microservice
    - nodejs
spec:
  type: service
  lifecycle: production
  owner: team-backend
  system: microservices-example
```

**`catalog-info-order-service.yaml`:**
```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: order-service
  description: Order processing microservice
  annotations:
    jaegertracing.io/service-name: order-service
    tracing.jaeger/endpoint: http://localhost:16686
    tracing.opentelemetry/instrumented: 'true'
    environment: development
  tags:
    - microservice
    - python
spec:
  type: service
  lifecycle: production
  owner: team-backend
  system: microservices-example
```

**Register in Backstage:**
1. Go to http://localhost:3000/catalog-import
2. Click "Register Existing Component"
3. Add the URLs or file paths for each catalog-info.yaml

---

## 🚀 Step 4: Start Services & Generate Traces

**Terminal 1 - User Service:**
```powershell
cd user-service
go run main.go
```

**Terminal 2 - Product Service:**
```powershell
cd product-service
node index.js
```

**Terminal 3 - Order Service:**
```powershell
cd order-service
python app.py
```

**Terminal 4 - Generate Traffic:**
```powershell
# Generate some test traffic
for ($i=1; $i -le 10; $i++) {
    Invoke-WebRequest -Uri http://localhost:8080/api/users
    Invoke-WebRequest -Uri http://localhost:3000/api/products
    Invoke-RestMethod -Uri http://localhost:5000/api/orders -Method POST
    Start-Sleep -Seconds 1
}
```

---

## 🔍 Step 5: View in Function Analytics

1. Navigate to **http://localhost:3000/function-analytics**
2. You should see:
   - 3 catalog services discovered
   - Connection status for each service
3. Click **Refresh** to fetch trace data
4. Switch to different tabs:
   - **Function Details**: See all functions with latency, error rates
   - **Service Overview**: Service-level metrics
   - **Microservice Architecture**: Dependencies and bottlenecks
   - **Function Placement Analysis**: Optimization recommendations

---

## 🎯 Expected Results

After generating traffic, you'll see:

**Function Details Tab:**
- `getUserHandler` (user-service) - Internal calls
- `getProducts` (product-service) - Internal calls
- `getProductById` (product-service) - Internal calls
- `POST /api/orders` (order-service) - **HIGH EXTERNAL CALLS**
- `call-user-service` (order-service) - External dependency
- `call-product-service` (order-service) - External dependency

**Placement Analysis:**
- Should flag `call-user-service` and `call-product-service` as having high external call percentages
- Recommend optimization strategies

---

## 🐛 Troubleshooting

**Services not showing up?**
- Check Jaeger UI (http://localhost:16686) - traces should appear there
- Verify services are sending to `localhost:6831`
- Check Backstage logs for proxy errors

**No trace data?**
- Ensure you've generated traffic to the services
- Wait 10-15 seconds for traces to propagate
- Click "Test Jaeger" button in Function Analytics

**Connection errors?**
- Verify all services are running on correct ports
- Check firewall/antivirus settings
- Ensure Jaeger container is running

---

## 📊 What You'll Discover

The Function Analytics plugin will show you:

1. **Cross-service dependencies**: How order-service calls user-service and product-service
2. **Function placement issues**: If functions should be relocated
3. **Performance bottlenecks**: High latency functions
4. **Architecture insights**: Service interaction patterns
5. **Optimization opportunities**: Where to reduce cross-service calls

---

## 🎓 Next Steps

1. **Add more complex operations** - Implement database calls, caching
2. **Introduce errors** - Test error rate tracking
3. **Scale services** - Run multiple instances and see load distribution
4. **Add authentication** - Track security-related spans
5. **Implement circuit breakers** - Monitor resilience patterns

Happy tracing! 🚀
