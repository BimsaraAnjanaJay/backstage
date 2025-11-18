# Function Relocation Analyzer Plugin - Setup Guide

## Overview

The Function Relocation Analyzer is a Backstage plugin that analyzes Jaeger traces to identify misplaced functions in microservices architectures. It provides actionable recommendations for relocating functions to optimize performance and reduce cross-service communication latency.

## Features

- ✅ Analyzes Jaeger trace data automatically
- ✅ Identifies internal vs external function calls
- ✅ Detects dominant caller patterns
- ✅ Calculates predicted latency improvements
- ✅ Provides relocation recommendations with visual indicators
- ✅ Interactive table with search, sort, and pagination

## Architecture

### Backend Plugin (`function-analytics-backend`)
- **Endpoint**: `/api/function-analytics/analyze?service={serviceName}`
- **Components**:
  - `preprocess.ts` - Cleans and flattens Jaeger trace data
  - `analysis.ts` - Analyzes call patterns and identifies dominant callers
  - `decision.ts` - Applies decision logic and generates recommendations

### Frontend Plugin (`function-analytics`)
- **Route**: `/function-analytics`
- **Components**:
  - `FunctionAnalyticsPage` - Main UI with data table and visualizations

## Installation

### Step 1: Install Dependencies

```bash
cd e:\UCSC\4th year\Research\backstage
yarn install
```

### Step 2: Register Backend Plugin

Edit `packages/backend/src/index.ts` and add:

```typescript
// Add this import at the top
import functionAnalytics from '@internal/plugin-function-analytics-backend';

// Add this line with other backend.add() calls
backend.add(functionAnalytics);
```

### Step 3: Register Frontend Plugin

Edit `packages/app/src/App.tsx` and add:

```typescript
// Add this import at the top
import { FunctionAnalyticsPage } from '@internal/plugin-function-analytics';

// Add this route inside the <FlatRoutes> component
<Route path="/function-analytics" element={<FunctionAnalyticsPage />} />
```

### Step 4: Add Navigation Menu Item (Optional)

Edit `packages/app/src/components/Root/Root.tsx` to add a menu item:

```typescript
import TimelineIcon from '@material-ui/icons/Timeline';

// Inside the <SidebarGroup> component, add:
<SidebarItem icon={TimelineIcon} to="function-analytics" text="Function Analytics" />
```

### Step 5: Start Jaeger

Ensure Jaeger is running on `http://localhost:16686`. If not, start it using Docker:

```bash
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

### Step 6: Run Backstage

```bash
yarn dev
```

Navigate to `http://localhost:3000/function-analytics` to see the plugin in action.

## Configuration

The proxy configuration has already been added to `app-config.yaml`:

```yaml
proxy:
  endpoints:
    '/function-analytics':
      target: http://localhost:7007/api/function-analytics
    '/jaeger':
      target: http://localhost:16686
```

## Decision Logic

A function is flagged for relocation if:

1. **External calls > Internal calls**
2. **Dominant caller percentage >= 60%**

### Recommendations

- **Relocate** (🔵): Function should be moved to the dominant caller service
- **Review** (🟠): Potential circular dependency detected - needs manual review
- **Keep** (🟢): Function is well-placed in its current service

## API Response Format

```json
[
  {
    "functionName": "getUserProfile",
    "currentService": "user-service",
    "suggestedService": "api-gateway",
    "internalCalls": 10,
    "externalCalls": 150,
    "dominantCaller": "api-gateway",
    "dominantPercent": 0.75,
    "predictedLatencyImprovement": 45.2,
    "recommendation": "relocate"
  }
]
```

## Troubleshooting

### Plugin not showing up
- Run `yarn install` in the project root
- Check that both plugins are registered in backend and frontend
- Clear browser cache and restart dev server

### No data showing
- Verify Jaeger is running on port 16686
- Check that you have trace data in Jaeger
- Inspect browser console for API errors
- Check backend logs for connection issues

### Build errors
- Run `yarn tsc` to check for TypeScript errors
- Run `yarn build:api-reports` to update API reports
- Ensure all dependencies are installed

## Development

### Running Tests

```bash
# Backend tests
cd plugins/function-analytics-backend
yarn test

# Frontend tests
cd plugins/function-analytics
yarn test
```

### Linting

```bash
yarn lint --fix
```

### Type Checking

```bash
yarn tsc
```

## Next Steps

1. ✅ All 8 prompts completed successfully
2. Install dependencies: `yarn install`
3. Register plugins in backend and frontend
4. Start Jaeger if not running
5. Run `yarn dev` and navigate to `/function-analytics`

## File Structure

```
plugins/
├── function-analytics-backend/
│   ├── src/
│   │   ├── lib/
│   │   │   ├── types.ts
│   │   │   ├── preprocess.ts
│   │   │   ├── analysis.ts
│   │   │   └── decision.ts
│   │   ├── service/
│   │   │   └── router.ts
│   │   ├── index.ts
│   │   └── plugin.ts
│   ├── package.json
│   └── README.md
└── function-analytics/
    ├── src/
    │   ├── components/
    │   │   └── FunctionAnalyticsPage/
    │   │       ├── FunctionAnalyticsPage.tsx
    │   │       └── index.ts
    │   ├── index.ts
    │   ├── plugin.ts
    │   ├── routes.ts
    │   └── types.ts
    ├── package.json
    └── README.md
```

## Credits

Built for microservice optimization using Backstage and Jaeger tracing data.
