/**
 * FRA Plugin Evaluation Script
 *
 * Runs two research questions against live Jaeger trace data:
 *
 *   RQ1 — Precision & Recall
 *         Can the analyzer correctly identify misplaced functions?
 *         Compares plugin output against hand-labelled ground truth for
 *         both controlled scenarios and computes TP / FP / FN / TN,
 *         Precision, Recall, F1.
 *
 *   RQ2 — Trace Volume Sensitivity
 *         How many traces are needed for reliable results?
 *         Subsamples collected traces at increasing sizes (N = 5, 10, 25,
 *         50, 100, 200) and records whether the recommendation for each
 *         known-misplaced function is stable.
 *
 * Usage:
 *   node experiments/evaluate.js                   # run both (requires both Jaegers live on :16686)
 *   node experiments/evaluate.js --scenario=exp1   # only Experiment 1
 *   node experiments/evaluate.js --scenario=exp2   # only Experiment 2
 *   node experiments/evaluate.js --save            # save results to experiments/results.json
 *   node experiments/evaluate.js --combine         # print combined report from saved results.json
 *
 * Typical two-session workflow (only one Jaeger port conflict):
 *   Session A — library-demo running:
 *     node experiments/evaluate.js --scenario=exp2 --save
 *   Session B — lightweight-otel-demo running:
 *     node experiments/evaluate.js --scenario=exp1 --save
 *   Final:
 *     node experiments/evaluate.js --combine
 *
 * Prerequisites:
 *   - Jaeger running on localhost:16686
 *   - No extra npm install needed — uses only Node built-ins (http + fs modules)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const JAEGER_HOST = 'localhost';
const JAEGER_PORT = 16686;
const TRACE_LIMIT  = 500;          // max traces fetched per service from Jaeger
const THRESHOLD    = 0.65;         // externalCallThreshold (matches FraConfig default)
const CONF_MARGIN  = 0.05;         // confidenceMargin (matches FraConfig default)

// Trace volume steps for RQ2
const VOLUME_STEPS = [5, 10, 25, 50, 100, 200];

// ─── Ground Truth ─────────────────────────────────────────────────────────────
//
// label: 'misplaced' — the plugin SHOULD recommend relocate
// label: 'well-placed' — the plugin SHOULD NOT flag (keep)
//
// Functions are identified by { functionName, currentService } because the same
// span name could appear in multiple services.

const GROUND_TRUTH = [
  // ── Experiment 1: lightweight-otel-demo ─────────────────────────────────────
  // gateway calls auth-service/validate 5× per checkout and product-service/products once.
  //
  // NOTE on span structure: manually created spans (auth-validate-endpoint, product-list-endpoints)
  // are nested as children of the auto-instrumented HTTP server span within their own service.
  // The analyzer resolves caller from the immediate parent span — which is the HTTP server span
  // still in the same service — so those manual spans appear internal.
  // The cross-service boundary IS visible at the HTTP endpoint level:
  //   gateway-service → [GET] → auth-service [GET /validate]   (100% external)
  //   gateway-service → [GET] → product-service [GET /products] (100% external)
  // These HTTP-level spans are the correct detection targets for this instrumentation style.
  { scenario: 'exp1', functionName: 'GET /validate',              currentService: 'auth-service',     label: 'misplaced'   },
  { scenario: 'exp1', functionName: 'GET /products',              currentService: 'product-service',  label: 'misplaced'   },
  // Manual spans inside auth — parent is the HTTP server span within auth-service → appear internal
  { scenario: 'exp1', functionName: 'auth-validate-endpoint',     currentService: 'auth-service',     label: 'well-placed' },
  { scenario: 'exp1', functionName: 'auth-extractTokenHash',      currentService: 'auth-service',     label: 'well-placed' },
  { scenario: 'exp1', functionName: 'auth-internalValidationStep',currentService: 'auth-service',     label: 'well-placed' },
  // Manual spans inside product — same pattern
  { scenario: 'exp1', functionName: 'product-list-endpoints',     currentService: 'product-service',  label: 'well-placed' },
  { scenario: 'exp1', functionName: 'product-fetchFromDB',        currentService: 'product-service',  label: 'well-placed' },
  // gateway's own entry point — called by external client
  { scenario: 'exp1', functionName: 'GET /api/checkout',          currentService: 'gateway-service',  label: 'well-placed' },
  { scenario: 'exp1', functionName: 'gateway-checkout-flow',      currentService: 'gateway-service',  label: 'well-placed' },

  // ── Experiment 2: library-demo ───────────────────────────────────────────────
  // loan-service calls these on every loan create / return — 100% external callers
  { scenario: 'exp2', functionName: 'POST /calculate-late-fee',    currentService: 'book-service',     label: 'misplaced'   },
  { scenario: 'exp2', functionName: 'POST /members/:id/validate',  currentService: 'member-service',   label: 'misplaced'   },
  // loan-service owns these — correct home, driven by traffic-generator (external client)
  { scenario: 'exp2', functionName: 'POST /loans',                 currentService: 'loan-service',     label: 'well-placed' },
  { scenario: 'exp2', functionName: 'POST /loans/:id/return',      currentService: 'loan-service',     label: 'well-placed' },
  // book-service owns book retrieval — correct even if only loan-service calls it
  { scenario: 'exp2', functionName: 'GET /books/:id',              currentService: 'book-service',     label: 'well-placed' },
  { scenario: 'exp2', functionName: 'GET /books',                  currentService: 'book-service',     label: 'well-placed' },
  // member-service owns member lookup
  { scenario: 'exp2', functionName: 'GET /members/:id',            currentService: 'member-service',   label: 'well-placed' },
];

// Which Jaeger services belong to each experiment
const SCENARIO_SERVICES = {
  exp1: ['gateway-service', 'auth-service', 'product-service'],
  exp2: ['book-service',    'loan-service', 'member-service'],
};

// ─── Noise filter (mirrors FunctionCallAnalyzer NOISE_PATTERNS) ───────────────

const NOISE_PATTERNS = [
  'health','metrics','express.middleware','middleware -','router -',
  'corsmiddleware','fs.','net.','dns.','dns.lookup','tcp.connect','connect',
  'readfilesync','readfile','realpathsync','statsync','lstatsync','access',
  'expressinit','jsonparser','query','tcp','dns','fs ','net ','vfs',
  'close','open','read','write','stat','request handler','anonymous',
  'pg.','mongodb.','mongoose.','sequelize.','knex.',
];

function isNoise(name) {
  const lower = name.toLowerCase();
  const noise = NOISE_PATTERNS.some(p => lower === p || lower.includes(p));
  const generic = lower === 'http' || /^HTTP [A-Z]+$/.test(name);
  const app =
    name.startsWith('GET ')   ||
    name.startsWith('POST ')  ||
    name.startsWith('PUT ')   ||
    name.startsWith('DELETE ')||
    name.includes('-')        ||
    name.includes('Step')     ||
    name.includes('Hash')     ||
    name.includes('Token');
  if ((noise || generic) && !app) return true;
  if (!app && !name.includes(' ') && name === name.toLowerCase() && name.length < 15) return true;
  return false;
}

// ─── Analysis logic (mirrors FunctionCallAnalyzer + RelocationDecisionEngine) ─

function analyzeFunctionCalls(traces) {
  const stats = new Map();

  for (const trace of traces) {
    const spanService = new Map();
    if (!Array.isArray(trace.spans)) continue;

    for (const span of trace.spans) {
      const proc = trace.processes?.[span.processID];
      if (proc) spanService.set(span.spanID, proc.serviceName);
    }

    for (const span of trace.spans) {
      const proc = trace.processes?.[span.processID];
      if (!proc) continue;

      const svc  = proc.serviceName;
      const name = span.operationName;
      if (isNoise(name)) continue;

      if (!stats.has(name)) {
        stats.set(name, { service: svc, internal: 0, external: 0,
                          internalLat: [], externalLat: [], callers: new Map() });
      }

      const s   = stats.get(name);
      const lat = (span.duration || 0) / 1000;

      let caller = 'external (client)';
      const parentRef = span.references?.find(r => r.refType === 'CHILD_OF');
      if (parentRef) caller = spanService.get(parentRef.spanID) || 'unknown';

      if (caller.includes('backstage-backend')) continue;
      if (caller.includes('traffic-generator') || caller === 'unknown') {
        caller = 'external (client)';
      }

      if (caller === svc) {
        s.internal++;
        s.internalLat.push(lat);
      } else {
        s.external++;
        s.externalLat.push(lat);
        s.callers.set(caller, (s.callers.get(caller) || 0) + 1);
      }
    }
  }

  const results = [];
  stats.forEach((s, name) => {
    const total = s.internal + s.external;
    if (total === 0) return;

    let domCaller = 'none', domCount = 0;
    s.callers.forEach((c, k) => { if (c > domCount) { domCount = c; domCaller = k; } });

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    results.push({
      functionName:        name,
      currentService:      s.service,
      internalCalls:       s.internal,
      externalCalls:       s.external,
      dominantCaller:      domCaller,
      dominantPercent:     total > 0 ? domCount / total : 0,
      avgInternalLatency:  avg(s.internalLat),
      avgExternalLatency:  avg(s.externalLat),
    });
  });
  return results;
}

function applyDecisionLogic(analyzed, threshold = THRESHOLD, confMargin = CONF_MARGIN) {
  return analyzed.map(a => {
    const total   = a.internalCalls + a.externalCalls;
    const extPct  = total > 0 ? a.externalCalls / total : 0;
    const intPct  = total > 0 ? a.internalCalls / total : 0;
    const meetsT  = extPct >= threshold;
    const meetsM  = a.dominantPercent > intPct + confMargin;
    const mis     = meetsT && meetsM;

    let rec = 'keep', suggested = null;
    if (mis) {
      if (a.dominantCaller === a.currentService || a.dominantCaller.startsWith('external')) {
        rec = 'review';
      } else {
        rec = 'relocate';
        suggested = a.dominantCaller;
      }
    }
    return { ...a, recommendation: rec, suggestedService: suggested,
             externalPct: Math.round(extPct * 100) };
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: JAEGER_HOST, port: JAEGER_PORT, path, method: 'GET' };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${path}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchTracesForService(svcName) {
  try {
    const url = `/api/traces?service=${encodeURIComponent(svcName)}&limit=${TRACE_LIMIT}&lookback=24h`;
    const data = await httpGet(url);
    return Array.isArray(data.data) ? data.data : [];
  } catch (e) {
    console.warn(`  ⚠ Could not fetch traces for ${svcName}: ${e.message}`);
    return [];
  }
}

async function fetchAllTracesForScenario(services) {
  const seen  = new Set();
  const traces = [];
  for (const svc of services) {
    const raw = await fetchTracesForService(svc);
    for (const t of raw) {
      if (!seen.has(t.traceID)) { seen.add(t.traceID); traces.push(t); }
    }
  }
  return traces;
}

// ─── RQ1 helpers ──────────────────────────────────────────────────────────────

function matchResult(result, gt) {
  return result.functionName === gt.functionName &&
         result.currentService === gt.currentService;
}

function computeMetrics(decisions, groundTruth) {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  const detail = [];

  for (const gt of groundTruth) {
    const result = decisions.find(d => matchResult(d, gt));
    const pluginFlagged = result && result.recommendation === 'relocate';
    const shouldBeFlag  = gt.label === 'misplaced';

    if      ( shouldBeFlag &&  pluginFlagged) { TP++; detail.push({ ...gt, outcome: 'TP', result }); }
    else if (!shouldBeFlag &&  pluginFlagged) { FP++; detail.push({ ...gt, outcome: 'FP', result }); }
    else if ( shouldBeFlag && !pluginFlagged) { FN++; detail.push({ ...gt, outcome: 'FN', result }); }
    else                                      { TN++; detail.push({ ...gt, outcome: 'TN', result }); }
  }

  const precision = (TP + FP) > 0 ? TP / (TP + FP) : 0;
  const recall    = (TP + FN) > 0 ? TP / (TP + FN) : 0;
  const f1        = (precision + recall) > 0
    ? 2 * precision * recall / (precision + recall) : 0;

  return { TP, FP, FN, TN, precision, recall, f1, detail };
}

// ─── RQ3 helpers — Threshold Sensitivity Analysis ─────────────────────────────

// Thresholds to sweep (as fractions)
const RQ3_THRESHOLDS = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.90, 0.95];

/**
 * Re-evaluates saved results at multiple external-call thresholds.
 * Reads raw {internalCalls, externalCalls, dominantCaller, dominantPercent}
 * from the detail[].result fields stored in results.json — no Jaeger needed.
 */
function computeRQ3(saved) {
  // Build per-scenario lists: raw function data + ground truth
  const scenarios = Object.entries(saved)
    .filter(([, data]) => data.rq1)
    .map(([key, data]) => {
      const functions = data.rq1.detail
        .filter(d => d.result)
        .map(d => d.result);
      const gt = GROUND_TRUTH.filter(g => g.scenario === key);
      return { key, label: data.label, functions, gt };
    });

  const thresholdResults = RQ3_THRESHOLDS.map(threshold => {
    let combinedTP = 0, combinedFP = 0, combinedFN = 0, combinedTN = 0;
    const perScenario = {};

    for (const { key, functions, gt } of scenarios) {
      const decisions = applyDecisionLogic(functions, threshold);
      const metrics   = computeMetrics(decisions, gt);
      perScenario[key] = {
        TP: metrics.TP, FP: metrics.FP, FN: metrics.FN, TN: metrics.TN,
        precision: metrics.precision, recall: metrics.recall, f1: metrics.f1,
      };
      combinedTP += metrics.TP; combinedFP += metrics.FP;
      combinedFN += metrics.FN; combinedTN += metrics.TN;
    }

    const precision = (combinedTP + combinedFP) > 0 ? combinedTP / (combinedTP + combinedFP) : 0;
    const recall    = (combinedTP + combinedFN) > 0 ? combinedTP / (combinedTP + combinedFN) : 0;
    const f1        = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

    return {
      threshold: Math.round(threshold * 100),
      precision, recall, f1,
      TP: combinedTP, FP: combinedFP, FN: combinedFN, TN: combinedTN,
      perScenario,
    };
  });

  return thresholdResults;
}

function printRQ3Section(thresholdResults) {
  console.log(`\n${S.bold}RQ3 — Threshold Sensitivity Analysis${S.reset}`);
  console.log('Threshold sweep: how Precision / Recall / F1 change as the external-call');
  console.log('threshold is varied from 40% to 95% (confidence margin fixed at 5%).\n');
  console.log(pad('Threshold', 12) + pad('TP', 5) + pad('FP', 5) + pad('FN', 5) + pad('TN', 5) +
              pad('Precision', 12) + pad('Recall', 10) + 'F1');
  console.log('─'.repeat(66));

  for (const r of thresholdResults) {
    const marker = r.threshold === Math.round(THRESHOLD * 100) ? ` ${S.cyan}← default${S.reset}` : '';
    console.log(
      pad(r.threshold + '%', 12) +
      S.green + pad(r.TP, 5) + S.reset +
      S.red   + pad(r.FP, 5) + S.reset +
      S.yellow + pad(r.FN, 5) + S.reset +
      S.green + pad(r.TN, 5) + S.reset +
      pad(pct(r.precision), 12) +
      pad(pct(r.recall), 10) +
      pct(r.f1) + marker
    );
  }
  console.log('─'.repeat(66));
}

// ─── RQ2 helpers ──────────────────────────────────────────────────────────────

// Deterministic shuffle via seed so results are reproducible
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildVolumeRows(traces, knownMisplaced) {
  const rows = VOLUME_STEPS
    .filter(n => n <= traces.length)
    .map(n => runAtVolume(traces, n, knownMisplaced));
  if (traces.length > VOLUME_STEPS[VOLUME_STEPS.length - 1]) {
    const last = runAtVolume(traces, traces.length, knownMisplaced);
    last.n = `${traces.length} (all)`;
    rows.push(last);
  }
  return rows;
}

function runAtVolume(traces, n, knownMisplaced) {
  const sample   = seededShuffle(traces, 42).slice(0, n);
  const analyzed = analyzeFunctionCalls(sample);
  const decided  = applyDecisionLogic(analyzed);

  const results = knownMisplaced.map(gt => {
    const r = decided.find(d => matchResult(d, gt));
    return {
      fn:          gt.functionName,
      service:     gt.currentService,
      detected:    r?.recommendation === 'relocate' ? 'YES' : (r ? `no (${r.recommendation})` : 'not seen'),
      extPct:      r?.externalPct ?? '-',
      totalCalls:  r ? r.internalCalls + r.externalCalls : 0,
    };
  });

  const detected = results.filter(r => r.detected === 'YES').length;
  return { n, results, detectedCount: detected, total: knownMisplaced.length };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const S = { reset:'\x1b[0m', bold:'\x1b[1m', red:'\x1b[31m', green:'\x1b[32m',
            yellow:'\x1b[33m', cyan:'\x1b[36m', grey:'\x1b[90m' };

function pct(v) { return (v * 100).toFixed(1) + '%'; }
function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

function printHr(char, n) { console.log(char.repeat(n)); }

function printRQ1Section(scenarioLabel, metrics) {
  console.log(`\n${S.bold}${S.cyan}${scenarioLabel}${S.reset}`);
  printHr('─', 70);

  // Detail table
  console.log(pad('Function', 36) + pad('Service', 18) + pad('Label', 12) + pad('Outcome', 10) + 'Ext%');
  printHr('─', 70);
  for (const d of metrics.detail) {
    const colour = d.outcome === 'TP' ? S.green
                 : d.outcome === 'TN' ? S.green
                 : d.outcome === 'FP' ? S.red
                 : S.yellow; // FN
    const ext = d.result ? `${d.result.externalPct}%` : 'n/a';
    console.log(
      colour +
      pad(d.functionName.substring(0, 35), 36) +
      pad(d.currentService.substring(0, 17), 18) +
      pad(d.label, 12) +
      pad(d.outcome, 10) +
      ext +
      S.reset
    );
  }

  printHr('─', 70);
  console.log(
    `TP=${S.green}${metrics.TP}${S.reset}  ` +
    `FP=${S.red}${metrics.FP}${S.reset}  ` +
    `FN=${S.yellow}${metrics.FN}${S.reset}  ` +
    `TN=${S.green}${metrics.TN}${S.reset}`
  );
  console.log(
    `Precision : ${S.bold}${pct(metrics.precision)}${S.reset}   ` +
    `Recall : ${S.bold}${pct(metrics.recall)}${S.reset}   ` +
    `F1 : ${S.bold}${pct(metrics.f1)}${S.reset}`
  );
}

function printRQ2Section(scenarioLabel, volumeRows, knownMisplaced) {
  console.log(`\n${S.bold}${S.cyan}${scenarioLabel}${S.reset}`);
  printHr('─', 80);

  // Header
  const fnCols = knownMisplaced.map(g => g.functionName.substring(0, 28));
  console.log(pad('Traces (N)', 12) + fnCols.map(f => pad(f, 30)).join('') + pad('Detected', 10));
  printHr('─', 80);

  for (const row of volumeRows) {
    const cols = row.results.map(r => {
      const colour = r.detected === 'YES' ? S.green : (r.detected.startsWith('not') ? S.grey : S.yellow);
      return colour + pad(r.detected + (r.detected === 'YES' ? ` (${r.extPct}%)` : ''), 30) + S.reset;
    });
    const ratio = `${row.detectedCount}/${row.total}`;
    console.log(pad(row.n, 12) + cols.join('') + pad(ratio, 10));
  }
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

const RESULTS_FILE = path.join(__dirname, 'results.json');

function saveResults(data) {
  let existing = {};
  if (fs.existsSync(RESULTS_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')); } catch {}
  }
  const merged = { ...existing, ...data };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(merged, null, 2));
  console.log(`\n${S.green}Results saved to ${RESULTS_FILE}${S.reset}`);
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) {
    console.error(`${S.red}No saved results found at ${RESULTS_FILE}. Run with --save first.${S.reset}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
}

function printCombinedFromSaved(saved) {
  console.log(`\n${S.bold}╔══════════════════════════════════════════════════════════╗`);
  console.log(`║   FRA Plugin Evaluation — Combined Results                ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝${S.reset}`);

  let combinedTP = 0, combinedFP = 0, combinedFN = 0, combinedTN = 0;

  for (const [key, data] of Object.entries(saved)) {
    if (!data.rq1) continue;
    const m = data.rq1;
    printRQ1Section(data.label, m);
    combinedTP += m.TP; combinedFP += m.FP; combinedFN += m.FN; combinedTN += m.TN;
  }

  const combPrec = (combinedTP + combinedFP) > 0 ? combinedTP / (combinedTP + combinedFP) : 0;
  const combRec  = (combinedTP + combinedFN) > 0 ? combinedTP / (combinedTP + combinedFN) : 0;
  const combF1   = (combPrec + combRec) > 0 ? 2 * combPrec * combRec / (combPrec + combRec) : 0;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${S.bold}── Combined (both experiments) ──${S.reset}`);
  console.log(`TP=${S.green}${combinedTP}${S.reset}  FP=${S.red}${combinedFP}${S.reset}  FN=${S.yellow}${combinedFN}${S.reset}  TN=${S.green}${combinedTN}${S.reset}`);
  console.log(`${S.bold}Precision: ${pct(combPrec)}   Recall: ${pct(combRec)}   F1: ${pct(combF1)}${S.reset}`);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${S.bold}RQ2 — Trace Volume Sensitivity${S.reset}`);
  console.log('═'.repeat(70));

  for (const [key, data] of Object.entries(saved)) {
    if (!data.rq2) continue;
    const knownMisplaced = GROUND_TRUTH.filter(g => g.scenario === key && g.label === 'misplaced');
    printRQ2Section(data.label, data.rq2, knownMisplaced);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── CLI flags ─────────────────────────────────────────────────────────────────
  const args    = process.argv.slice(2);
  const doSave  = args.includes('--save');
  const doCombine = args.includes('--combine');
  const scenarioFilter = (args.find(a => a.startsWith('--scenario=')) || '').replace('--scenario=', '') || 'both';

  if (doCombine) {
    printCombinedFromSaved(loadResults());
    return;
  }

  if (args.includes('--rq3')) {
    const saved = loadResults();
    const rq3   = computeRQ3(saved);
    printRQ3Section(rq3);
    if (doSave) {
      // Merge rq3 into existing results.json without touching exp1/exp2
      const updated = { ...saved, rq3 };
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(updated, null, 2));
      console.log(`\n${S.green}RQ3 results saved to ${RESULTS_FILE}${S.reset}`);
    }
    return;
  }

  console.log(`\n${S.bold}╔══════════════════════════════════════════════════════════╗`);
  console.log(`║   FRA Plugin Evaluation — RQ1 (Precision/Recall) & RQ2   ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝${S.reset}`);
  console.log(`Jaeger: ${JAEGER_HOST}:${JAEGER_PORT}  |  Threshold: ${THRESHOLD*100}%  |  Margin: ${CONF_MARGIN*100}%`);
  if (scenarioFilter !== 'both') console.log(`Scenario filter: ${scenarioFilter}`);

  // ── Fetch traces ─────────────────────────────────────────────────────────────
  console.log(`\n${S.bold}Fetching traces from Jaeger...${S.reset}`);

  const runExp1 = scenarioFilter === 'both' || scenarioFilter === 'exp1';
  const runExp2 = scenarioFilter === 'both' || scenarioFilter === 'exp2';

  let exp1Traces = [], exp2Traces = [];

  if (runExp1) {
    process.stdout.write('  Experiment 1 (lightweight-otel-demo)... ');
    exp1Traces = await fetchAllTracesForScenario(SCENARIO_SERVICES.exp1);
    console.log(`${exp1Traces.length} unique traces`);
  }
  if (runExp2) {
    process.stdout.write('  Experiment 2 (library-demo)... ');
    exp2Traces = await fetchAllTracesForScenario(SCENARIO_SERVICES.exp2);
    console.log(`${exp2Traces.length} unique traces`);
  }

  if (exp1Traces.length === 0 && exp2Traces.length === 0) {
    console.error(`\n${S.red}No traces found. Make sure the scenario containers are running and have generated traffic.${S.reset}`);
    process.exit(1);
  }

  // ── RQ1 ──────────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${S.bold}RQ1 — Can the analyzer correctly identify misplaced functions?${S.reset}`);
  console.log('═'.repeat(70));

  const exp1GT = GROUND_TRUTH.filter(g => g.scenario === 'exp1');
  const exp2GT = GROUND_TRUTH.filter(g => g.scenario === 'exp2');

  let combinedTP = 0, combinedFP = 0, combinedFN = 0, combinedTN = 0;
  const toSave = {};

  if (exp1Traces.length > 0) {
    const exp1Decisions = applyDecisionLogic(analyzeFunctionCalls(exp1Traces));
    const exp1Metrics   = computeMetrics(exp1Decisions, exp1GT);
    const label = 'Experiment 1 — E-Commerce Checkout (lightweight-otel-demo)';
    printRQ1Section(label, exp1Metrics);
    combinedTP += exp1Metrics.TP; combinedFP += exp1Metrics.FP;
    combinedFN += exp1Metrics.FN; combinedTN += exp1Metrics.TN;

    const exp1Known = exp1GT.filter(g => g.label === 'misplaced');
    const exp1Rows  = buildVolumeRows(exp1Traces, exp1Known);
    toSave.exp1 = { label, rq1: exp1Metrics, rq2: exp1Rows, traceCount: exp1Traces.length };
  } else if (runExp1) {
    console.log(`\n${S.yellow}Experiment 1: No traces available — skipped.${S.reset}`);
  }

  if (exp2Traces.length > 0) {
    const exp2Decisions = applyDecisionLogic(analyzeFunctionCalls(exp2Traces));
    const exp2Metrics   = computeMetrics(exp2Decisions, exp2GT);
    const label = 'Experiment 2 — Library Management (library-demo)';
    printRQ1Section(label, exp2Metrics);
    combinedTP += exp2Metrics.TP; combinedFP += exp2Metrics.FP;
    combinedFN += exp2Metrics.FN; combinedTN += exp2Metrics.TN;

    const exp2Known = exp2GT.filter(g => g.label === 'misplaced');
    const exp2Rows  = buildVolumeRows(exp2Traces, exp2Known);
    toSave.exp2 = { label, rq1: exp2Metrics, rq2: exp2Rows, traceCount: exp2Traces.length };
  } else if (runExp2) {
    console.log(`\n${S.yellow}Experiment 2: No traces available — skipped.${S.reset}`);
  }

  // Combined summary (only shown when both ran)
  if (exp1Traces.length > 0 && exp2Traces.length > 0) {
    const combPrec = (combinedTP + combinedFP) > 0 ? combinedTP / (combinedTP + combinedFP) : 0;
    const combRec  = (combinedTP + combinedFN) > 0 ? combinedTP / (combinedTP + combinedFN) : 0;
    const combF1   = (combPrec + combRec) > 0 ? 2 * combPrec * combRec / (combPrec + combRec) : 0;
    console.log(`\n${S.bold}── Combined (both experiments) ──${S.reset}`);
    console.log(`TP=${S.green}${combinedTP}${S.reset}  FP=${S.red}${combinedFP}${S.reset}  FN=${S.yellow}${combinedFN}${S.reset}  TN=${S.green}${combinedTN}${S.reset}`);
    console.log(`${S.bold}Precision: ${pct(combPrec)}   Recall: ${pct(combRec)}   F1: ${pct(combF1)}${S.reset}`);
  }

  // ── RQ2 ──────────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${S.bold}RQ2 — How many traces are needed for reliable results?${S.reset}`);
  console.log('═'.repeat(70));

  if (exp1Traces.length > 0) {
    const exp1Known = exp1GT.filter(g => g.label === 'misplaced');
    printRQ2Section('Experiment 1 — E-Commerce Checkout', toSave.exp1?.rq2 || [], exp1Known);
  }
  if (exp2Traces.length > 0) {
    const exp2Known = exp2GT.filter(g => g.label === 'misplaced');
    printRQ2Section('Experiment 2 — Library Management', toSave.exp2?.rq2 || [], exp2Known);
  }

  console.log(`\n${S.bold}RQ2 Interpretation:${S.reset}`);
  console.log('  The smallest N where all misplaced functions show YES is the minimum');
  console.log('  trace volume needed for reliable detection.');
  console.log(`\n${'═'.repeat(70)}\n`);

  if (doSave) saveResults(toSave);
}

main().catch(err => {
  console.error(`\n${S.red}Fatal error: ${err.message}${S.reset}`);
  console.error(err.stack);
  process.exit(1);
});
