# function-analytics

This is the frontend plugin for Function Relocation Analyzer.

## Features

- Displays function relocation recommendations
- Shows internal vs external call patterns
- Displays predicted latency improvements
- Provides actionable insights for microservice optimization

## Installation

Add this plugin to your frontend app in `packages/app/src/App.tsx`:

```typescript
import { FunctionAnalyticsPage } from '@internal/plugin-function-analytics';

// ...

<Route path="/function-analytics" element={<FunctionAnalyticsPage />} />
```
