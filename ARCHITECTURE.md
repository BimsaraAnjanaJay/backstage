# Function Relocation Analyzer - Architecture

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Backstage Frontend                           │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  FunctionAnalyticsPage Component                             │   │
│  │  ┌────────────────────────────────────────────────────────┐ │   │
│  │  │  Material-UI Table                                      │ │   │
│  │  │  • Search                                               │ │   │
│  │  │  • Sort                                                 │ │   │
│  │  │  • Pagination                                           │ │   │
│  │  │  • Color-coded recommendations                          │ │   │
│  │  └────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↓ HTTP GET                             │
│                              /api/function-analytics/analyze         │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      Backstage Proxy Layer                          │
│                                                                       │
│  /api/proxy/function-analytics → Backend Plugin                     │
│  /api/proxy/jaeger → Jaeger API                                     │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────────┐
│                   Function Analytics Backend                        │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Router (router.ts)                                          │   │
│  │  ┌────────────────────────────────────────────────────────┐ │   │
│  │  │  GET /analyze?service=all                              │ │   │
│  │  │    1. Fetch traces from Jaeger                         │ │   │
│  │  │    2. Call preprocessTraces()                          │ │   │
│  │  │    3. Call analyzeFunctionCalls()                      │ │   │
│  │  │    4. Call applyDecisionLogic()                        │ │   │
│  │  │    5. Return JSON results                              │ │   │
│  │  └────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Processing Pipeline (lib/)                                  │   │
│  │                                                               │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ 1. preprocess.ts                                     │    │   │
│  │  │    • Clean spans                                     │    │   │
│  │  │    • Extract function calls                          │    │   │
│  │  │    • Identify caller/callee                          │    │   │
│  │  │    • Calculate latencies                             │    │   │
│  │  │    • Filter noise (health checks, etc.)              │    │   │
│  │  │    Input: Raw Jaeger traces                          │    │   │
│  │  │    Output: CleanedCall[]                             │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                           ↓                                   │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ 2. analysis.ts                                       │    │   │
│  │  │    • Group by function name                          │    │   │
│  │  │    • Count internal vs external calls                │    │   │
│  │  │    • Find dominant caller                            │    │   │
│  │  │    • Calculate percentages                           │    │   │
│  │  │    • Compute avg latencies                           │    │   │
│  │  │    Input: CleanedCall[]                              │    │   │
│  │  │    Output: FunctionAnalysis[]                        │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                           ↓                                   │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │ 3. decision.ts                                       │    │   │
│  │  │    • Apply 60% threshold rule                        │    │   │
│  │  │    • Check circular dependencies                     │    │   │
│  │  │    • Calculate latency improvements                  │    │   │
│  │  │    • Generate recommendations                        │    │   │
│  │  │    • Sort by improvement (desc)                      │    │   │
│  │  │    Input: FunctionAnalysis[]                         │    │   │
│  │  │    Output: RelocationResult[]                        │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                               ↓ HTTP GET
┌─────────────────────────────────────────────────────────────────────┐
│                          Jaeger API                                  │
│                                                                       │
│  GET /api/traces?service={service}&limit=500                        │
│                                                                       │
│  Returns: Raw trace data with spans                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
┌──────────────┐
│  Raw Trace   │
│   from       │
│   Jaeger     │
└──────┬───────┘
       │
       │ {traceID, spans[{spanID, operationName, duration, ...}]}
       ↓
┌──────────────────────┐
│  preprocessTraces()  │
│  ─────────────────── │
│  • Flatten spans     │
│  • Extract calls     │
│  • Filter noise      │
│  • Calculate latency │
└──────┬───────────────┘
       │
       │ [{functionName, callerService, calleeService, latency}]
       ↓
┌────────────────────────┐
│ analyzeFunctionCalls() │
│ ────────────────────── │
│ • Group by function    │
│ • Count internal/ext   │
│ • Find dominant caller │
│ • Calc avg latencies   │
└──────┬─────────────────┘
       │
       │ [{functionName, currentService, internalCalls, 
       │   externalCalls, dominantCaller, dominantPercent, ...}]
       ↓
┌───────────────────────┐
│ applyDecisionLogic()  │
│ ───────────────────── │
│ • Apply 60% rule      │
│ • Check circular deps │
│ • Calc improvements   │
│ • Generate recs       │
└──────┬────────────────┘
       │
       │ [{...analysis, suggestedService, 
       │   predictedLatencyImprovement, recommendation}]
       ↓
┌──────────────────┐
│  Frontend Table  │
│  Display Results │
└──────────────────┘
```

## Decision Logic Flow

```
For each function:

┌─────────────────────────────┐
│ externalCalls > internal?   │
└────────┬────────────────────┘
         │
    Yes  │  No
         │  ↓
         │  ┌─────────────────┐
         │  │ recommendation: │
         │  │     "keep"      │
         │  └─────────────────┘
         ↓
┌─────────────────────────────┐
│ dominantPercent >= 0.60?    │
└────────┬────────────────────┘
         │
    Yes  │  No
         │  ↓
         │  ┌─────────────────┐
         │  │ recommendation: │
         │  │     "keep"      │
         │  └─────────────────┘
         ↓
┌─────────────────────────────┐
│ dominantCaller == current?  │ (Circular dependency check)
└────────┬────────────────────┘
         │
    Yes  │  No
         │  ↓
         │  ┌─────────────────────────────┐
         │  │ recommendation: "relocate"  │
         │  │ suggestedService = dominant │
         │  └─────────────────────────────┘
         ↓
┌─────────────────────────────┐
│ recommendation: "review"    │
│ suggestedService = null     │
└─────────────────────────────┘
```

## Component Hierarchy

```
FunctionAnalyticsPage
├── Header
│   ├── title: "Function Relocation Analyzer"
│   └── subtitle: "Identify misplaced functions..."
│
├── Content
│   ├── ContentHeader
│   │   ├── title: "Function Analysis Results"
│   │   └── SupportButton (help text)
│   │
│   ├── Summary Stats Box
│   │   ├── Total functions analyzed
│   │   └── Functions recommended for relocation
│   │
│   └── TableContainer
│       └── Table
│           ├── columns (9 columns)
│           ├── data (RelocationResult[])
│           └── options
│               ├── search: true
│               ├── paging: true
│               ├── sorting: true
│               └── pageSize: 10
│
└── Loading/Error States
    ├── Progress (during fetch)
    └── ResponseErrorPanel (on error)
```

## API Endpoints

### Backend Plugin

```
Base: /api/function-analytics

GET /health
  Response: { status: "ok" }
  Auth: Unauthenticated

GET /analyze?service={serviceName}
  Parameters:
    - service: string (optional, default: "all")
  Response: RelocationResult[]
  Auth: Authenticated
  
  Example:
    GET /api/function-analytics/analyze?service=user-service
    
    Returns:
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

### Jaeger Proxy

```
Base: /api/proxy/jaeger

GET /api/traces?service={service}&limit={limit}
  Parameters:
    - service: string (required)
    - limit: number (default: 500)
  Response: { data: Trace[] }
  Proxied to: http://localhost:16686/api/traces
```

## Technology Stack

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
├─────────────────────────────────────────────────┤
│ • React 18                                       │
│ • TypeScript                                     │
│ • Material-UI v4                                 │
│ • @backstage/core-components                    │
│ • @backstage/core-plugin-api                    │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                   Backend                        │
├─────────────────────────────────────────────────┤
│ • Node.js                                        │
│ • Express.js                                     │
│ • TypeScript                                     │
│ • @backstage/backend-plugin-api                 │
│ • node-fetch                                     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│                 External Services                │
├─────────────────────────────────────────────────┤
│ • Jaeger (Tracing)                              │
│ • Backstage (Platform)                          │
└─────────────────────────────────────────────────┘
```

## Security

```
Authentication Flow:

User → Backstage Frontend → Backstage Backend → Function Analytics Backend
         ↓                      ↓                         ↓
    Auth Session        Service Token          httpAuth.credentials()
                                                         ↓
                                              Validates user session
                                                         ↓
                                              Proxies to Jaeger
                                              (Jaeger = unauthenticated)
```

## Performance Considerations

| Aspect | Configuration | Notes |
|--------|---------------|-------|
| Trace Limit | 500 traces/request | Configurable in router.ts |
| Caching | None | Each request fetches fresh data |
| Filtering | Pre-process | Removes health/status endpoints |
| Sorting | Post-process | By predicted improvement DESC |
| Pagination | Client-side | 10/20/50 rows per page |
| Search | Client-side | Searches all columns |

## Future Architecture Enhancements

```
Potential improvements:

1. Redis Caching Layer
   ┌────────┐     ┌───────┐     ┌─────────┐
   │ Client │ ──→ │ Cache │ ──→ │ Backend │
   └────────┘     └───────┘     └─────────┘
                  TTL: 5 min

2. Background Processing
   ┌─────────┐     ┌───────────┐     ┌────────┐
   │ Cron    │ ──→ │ Analyzer  │ ──→ │   DB   │
   │ Job     │     │ Service   │     │        │
   └─────────┘     └───────────┘     └────────┘
   Schedule: Hourly

3. Webhook Notifications
   ┌──────────┐     ┌────────────┐
   │ Decision │ ──→ │  Webhook   │
   │ Engine   │     │  Service   │
   └──────────┘     └────────────┘
                           ↓
                    Slack/Teams/Email

4. Multi-Jaeger Support
   ┌─────────┐     ┌──────────┐
   │ Backend │ ──→ │ Jaeger 1 │
   │         │ ──→ │ Jaeger 2 │
   │         │ ──→ │ Jaeger 3 │
   └─────────┘     └──────────┘
```

---

**Visualization created**: Complete system architecture documented
