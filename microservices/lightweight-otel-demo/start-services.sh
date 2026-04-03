#!/bin/bash
echo "🚀 Starting lightweight-otel-demo microservices with OpenTelemetry tracing"

# Start Docker Compose
echo "📦 Starting services..."
docker-compose -f docker-compose.otel.yml up -d

# Wait for services
echo "⏳ Waiting for services to start..."
sleep 15

echo "✅ All services started!"
echo ""
echo "📊 Access Points:"
echo "  Jaeger UI: http://localhost:16686"
echo "  auth: http://localhost:8080"
echo "  gateway: http://localhost:8081"
echo "  product: http://localhost:8082"
echo "  Function Analytics: http://localhost:3000/function-analytics"
