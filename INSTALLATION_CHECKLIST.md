# Installation Checklist

## ✅ Implementation Status

- [x] **PROMPT 1** - Backend API endpoint with `/analyze` route
- [x] **PROMPT 2** - Preprocessing logic (`preprocess.ts`)
- [x] **PROMPT 3** - Function call analysis (`analysis.ts`)
- [x] **PROMPT 4** - Decision logic (`decision.ts`)
- [x] **PROMPT 5** - Connect all logic in router
- [x] **PROMPT 6** - React frontend page
- [x] **PROMPT 7** - UI table component
- [x] **PROMPT 8** - App config proxy settings

---

## 🔧 Installation Steps

Copy this checklist and mark items as you complete them:

### 1. Install Dependencies
```powershell
cd "e:\UCSC\4th year\Research\backstage"
yarn install
```
- [ ] Dependencies installed successfully
- [ ] No error messages

### 2. Register Backend Plugin
**File**: `packages/backend/src/index.ts`

Add:
```typescript
import functionAnalytics from '@internal/plugin-function-analytics-backend';
backend.add(functionAnalytics);
```
- [ ] Import added
- [ ] Plugin registered with backend.add()
- [ ] File saved

### 3. Register Frontend Plugin
**File**: `packages/app/src/App.tsx`

Add:
```typescript
import { FunctionAnalyticsPage } from '@internal/plugin-function-analytics';
// Inside <FlatRoutes>:
<Route path="/function-analytics" element={<FunctionAnalyticsPage />} />
```
- [ ] Import added
- [ ] Route added inside FlatRoutes
- [ ] File saved

### 4. Optional: Add Navigation Menu
**File**: `packages/app/src/components/Root/Root.tsx`

Add:
```typescript
import TimelineIcon from '@material-ui/icons/Timeline';
// Inside <SidebarGroup>:
<SidebarItem icon={TimelineIcon} to="function-analytics" text="Function Analytics" />
```
- [ ] Icon imported
- [ ] Menu item added
- [ ] File saved

### 5. Verify Jaeger is Running
```powershell
# Test if Jaeger is accessible
curl http://localhost:16686
```

If not running, start it:
```powershell
docker run -d --name jaeger `
  -p 16686:16686 `
  -p 14268:14268 `
  jaegertracing/all-in-one:latest
```
- [ ] Jaeger is running
- [ ] Accessible at http://localhost:16686
- [ ] Has trace data available

### 6. Build and Start
```powershell
yarn dev
```
- [ ] Build completes without errors
- [ ] Backend starts on port 7007
- [ ] Frontend starts on port 3000
- [ ] No TypeScript errors

### 7. Access the Plugin
Open: http://localhost:3000/function-analytics

- [ ] Page loads successfully
- [ ] No console errors
- [ ] Data displays in table
- [ ] Can search/sort/paginate

### 8. Test the API
```powershell
curl http://localhost:7007/api/function-analytics/analyze?service=all
```
- [ ] Returns JSON array
- [ ] No errors in response
- [ ] Data looks correct

---

## ✅ Verification Checklist

### Backend Plugin
- [ ] Plugin appears in backend logs on startup
- [ ] Health endpoint works: `/api/function-analytics/health`
- [ ] Analyze endpoint works: `/api/function-analytics/analyze`
- [ ] Jaeger proxy connection works
- [ ] Data processing completes successfully

### Frontend Plugin
- [ ] Route `/function-analytics` is accessible
- [ ] Page renders without errors
- [ ] Table displays data
- [ ] Search functionality works
- [ ] Sorting functionality works
- [ ] Pagination works
- [ ] Recommendation chips show correct colors
- [ ] Latency improvements are calculated

### Integration
- [ ] Frontend successfully calls backend API
- [ ] Backend successfully calls Jaeger API
- [ ] Data flows through entire pipeline
- [ ] Error handling works correctly
- [ ] Loading states display properly

---

## 🚨 Common Issues & Solutions

### Issue: "Cannot find module '@backstage/...'"
**Solution**: Run `yarn install` in project root

### Issue: Plugin not registered
**Solution**: Check backend/frontend registration code is correct

### Issue: No data showing
**Solution**: 
1. Verify Jaeger is running
2. Check Jaeger has trace data
3. Check browser console for errors
4. Check backend logs

### Issue: TypeScript errors
**Solution**:
1. Run `yarn tsc` to see all errors
2. Run `yarn install` again
3. Check import paths are correct

### Issue: Build fails
**Solution**:
1. Run `yarn lint --fix`
2. Run `yarn build:api-reports`
3. Check for syntax errors

---

## 📊 Success Metrics

When everything is working, you should see:

✅ **Backend Logs**:
```
[function-analytics] Plugin registered
[function-analytics] Health check OK
[function-analytics] Analyzing function calls for service: all
[function-analytics] Fetched 500 traces from Jaeger
[function-analytics] Preprocessed 1234 function calls
[function-analytics] Analyzed 56 unique functions
[function-analytics] Generated 12 relocation recommendations
```

✅ **Frontend**:
- Table with function analysis data
- Color-coded recommendation chips
- Search, sort, and pagination working
- Summary statistics showing at top
- No console errors

✅ **API Response** (sample):
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

---

## 📚 Reference Files

- `IMPLEMENTATION_SUMMARY.md` - Complete implementation details
- `FUNCTION_ANALYTICS_SETUP.md` - Detailed setup guide
- `QUICK_START.md` - Quick reference commands
- `plugins/function-analytics-backend/README.md` - Backend docs
- `plugins/function-analytics/README.md` - Frontend docs

---

## 🎯 Final Steps

After everything is working:

1. [ ] Run tests: `yarn test`
2. [ ] Check linting: `yarn lint --fix`
3. [ ] Type check: `yarn tsc`
4. [ ] Build API reports: `yarn build:api-reports`
5. [ ] Test with real microservices
6. [ ] Document any custom configurations
7. [ ] Share with team

---

**Status**: Ready for installation! 🚀

All code has been generated. Follow this checklist to complete the installation.
