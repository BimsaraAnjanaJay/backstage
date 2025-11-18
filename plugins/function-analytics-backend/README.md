# function-analytics-backend

This is the backend plugin for Function Relocation Analyzer.

## Features

- Analyzes Jaeger traces to identify misplaced functions
- Provides recommendations for function relocation across microservices
- Calculates predicted latency improvements

## API Endpoints

- `GET /analyze?service={serviceName}` - Analyze function calls and get relocation recommendations
- `GET /health` - Health check endpoint

## Installation

Add this plugin to your backend in `packages/backend/src/index.ts`:

```typescript
backend.add(import('@internal/plugin-function-analytics-backend'));
```
