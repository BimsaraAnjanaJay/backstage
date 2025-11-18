# Quick Start Commands

## ✅ All 8 Prompts Completed!

Your Function Relocation Analyzer plugin has been created with:
- ✅ Backend API with `/analyze` endpoint
- ✅ Preprocessing logic for Jaeger traces
- ✅ Function call analysis
- ✅ Decision logic with relocation rules
- ✅ React frontend with Material-UI table
- ✅ Proxy configuration

## Next Steps

### 1. Install Dependencies
```powershell
cd "e:\UCSC\4th year\Research\backstage"
yarn install
```

### 2. Register Backend Plugin
Edit `packages/backend/src/index.ts`:
```typescript
import functionAnalytics from '@internal/plugin-function-analytics-backend';
backend.add(functionAnalytics);
```

### 3. Register Frontend Plugin
Edit `packages/app/src/App.tsx`:
```typescript
import { FunctionAnalyticsPage } from '@internal/plugin-function-analytics';
// Add route:
<Route path="/function-analytics" element={<FunctionAnalyticsPage />} />
```

### 4. Start Jaeger (if not running)
```powershell
docker run -d --name jaeger `
  -p 16686:16686 `
  -p 14268:14268 `
  jaegertracing/all-in-one:latest
```

### 5. Run Backstage
```powershell
yarn dev
```

### 6. Access the Plugin
Open: http://localhost:3000/function-analytics

## Testing the API Directly
```powershell
# After backstage is running:
curl http://localhost:7007/api/function-analytics/analyze?service=all
```

## Files Created

### Backend Plugin
- `plugins/function-analytics-backend/package.json`
- `plugins/function-analytics-backend/src/index.ts`
- `plugins/function-analytics-backend/src/plugin.ts`
- `plugins/function-analytics-backend/src/lib/types.ts`
- `plugins/function-analytics-backend/src/lib/preprocess.ts`
- `plugins/function-analytics-backend/src/lib/analysis.ts`
- `plugins/function-analytics-backend/src/lib/decision.ts`
- `plugins/function-analytics-backend/src/service/router.ts`

### Frontend Plugin
- `plugins/function-analytics/package.json`
- `plugins/function-analytics/src/index.ts`
- `plugins/function-analytics/src/plugin.ts`
- `plugins/function-analytics/src/routes.ts`
- `plugins/function-analytics/src/types.ts`
- `plugins/function-analytics/src/components/FunctionAnalyticsPage/FunctionAnalyticsPage.tsx`
- `plugins/function-analytics/src/components/FunctionAnalyticsPage/index.ts`

### Configuration
- `app-config.yaml` (updated with proxy settings)

## Decision Logic Summary

**A function is recommended for relocation when:**
- External calls > Internal calls
- Dominant caller percentage >= 60%

**Recommendation Types:**
- 🔵 **Relocate**: Move to dominant caller service
- 🟠 **Review**: Circular dependency detected
- 🟢 **Keep**: Well-placed in current service

## Troubleshooting

If you see TypeScript errors:
```powershell
yarn tsc
```

If you need to update API reports:
```powershell
yarn build:api-reports
```

For linting issues:
```powershell
yarn lint --fix
```

## Documentation
See `FUNCTION_ANALYTICS_SETUP.md` for detailed setup instructions.
