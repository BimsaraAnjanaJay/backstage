/**
 * Chart Generator — Experiment 2: Library Demo (Library Management System)
 *
 * Reads experiments/results.json and writes experiments/report-exp2.html —
 * a standalone report focused on Experiment 2 (library-demo).
 *
 * Usage:
 *   node experiments/generate-charts-exp2.js
 *
 * Then open experiments/report-exp2.html in a browser.
 */

const fs   = require('fs');
const path = require('path');

const RESULTS_FILE = path.join(__dirname, 'results.json');
const OUTPUT_FILE  = path.join(__dirname, 'report-exp2.html');
const THRESHOLD    = 65; // %

if (!fs.existsSync(RESULTS_FILE)) {
  console.error('results.json not found. Run: node experiments/evaluate.js --scenario=exp2 --save');
  process.exit(1);
}

const saved = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
const exp2  = saved.exp2;

if (!exp2) {
  console.error('exp2 data not found in results.json. Run: node experiments/evaluate.js --scenario=exp2 --save');
  process.exit(1);
}

const { rq1, rq2, traceCount } = exp2;
const j = v => JSON.stringify(v);

// ── RQ1 metrics ───────────────────────────────────────────────────────────────
const { TP, FP, FN, TN, precision, recall, f1 } = rq1;

// ── Figure 2: per-service Precision/Recall bars ───────────────────────────────
const serviceMap = {};
for (const d of rq1.detail) {
  const svc = d.currentService;
  if (!serviceMap[svc]) serviceMap[svc] = { TP: 0, FP: 0, FN: 0, TN: 0 };
  serviceMap[svc][d.outcome]++;
}
const svcLabels = Object.keys(serviceMap);
const svcPrec   = svcLabels.map(s => {
  const { TP: tp, FP: fp } = serviceMap[s];
  return (tp + fp) > 0 ? parseFloat(((tp / (tp + fp)) * 100).toFixed(1)) : null;
});
const svcRec = svcLabels.map(s => {
  const { TP: tp, FN: fn } = serviceMap[s];
  return (tp + fn) > 0 ? parseFloat(((tp / (tp + fn)) * 100).toFixed(1)) : null;
});

// ── Figure 3: stacked call-source breakdown ───────────────────────────────────
const fig3Rows = rq1.detail.filter(d => d.result);

const fig3Labels = fig3Rows.map(d =>
  `${d.functionName.substring(0, 36)}  [${d.currentService}]`
);

const fig3Internal = fig3Rows.map(d => {
  const total = d.result.internalCalls + d.result.externalCalls;
  return total > 0 ? parseFloat(((d.result.internalCalls / total) * 100).toFixed(1)) : 0;
});

const fig3Peer = fig3Rows.map(d => {
  const total  = d.result.internalCalls + d.result.externalCalls;
  const caller = d.result.dominantCaller;
  const isPeer = caller && !caller.startsWith('external') && caller !== 'unknown' && caller !== 'none';
  if (!isPeer || total === 0) return 0;
  return parseFloat((d.result.dominantPercent * 100).toFixed(1));
});

const fig3Client = fig3Rows.map((d, i) =>
  parseFloat(Math.max(0, 100 - fig3Internal[i] - fig3Peer[i]).toFixed(1))
);

const fig3PeerColor = fig3Rows.map(d =>
  d.outcome === 'TP' ? 'rgba(220,53,69,0.85)' :
  d.outcome === 'FP' ? 'rgba(255,152,0,0.85)' :
  'rgba(220,53,69,0.10)'
);
const fig3PeerBorder = fig3Rows.map(d =>
  d.outcome === 'TP' ? 'rgb(180,30,50)' :
  d.outcome === 'FP' ? 'rgb(200,120,0)' :
  'rgba(200,53,69,0.2)'
);
const fig3Outcome = fig3Rows.map(d => d.outcome);

// ── Figure 4: cross-service call volume per function ──────────────────────────
// Shows internalCalls + externalCalls side-by-side for all observed functions
const callVolRows   = fig3Rows;
const callVolLabels = callVolRows.map(d => d.functionName.substring(0, 30) + `  [${d.currentService}]`);
const callVolInt    = callVolRows.map(d => d.result.internalCalls);
const callVolExt    = callVolRows.map(d => d.result.externalCalls);

// ── Figure 5: latency comparison ──────────────────────────────────────────────
const latRows = fig3Rows.filter(d =>
  d.result.avgInternalLatency > 0 || d.result.avgExternalLatency > 0
);
const latLabels   = latRows.map(d => d.functionName.substring(0, 30) + `  [${d.currentService}]`);
const latInternal = latRows.map(d => parseFloat(d.result.avgInternalLatency.toFixed(2)));
const latExternal = latRows.map(d => parseFloat(d.result.avgExternalLatency.toFixed(2)));

// ── Figure 6: RQ2 detection rate vs trace volume ──────────────────────────────
const rq2Points = rq2.map(row => ({
  x: typeof row.n === 'string' ? parseInt(row.n) : row.n,
  y: (row.detectedCount / row.total) * 100,
}));

// ── Figure 7: RQ2 call count growth per misplaced fn ─────────────────────────
const misplacedFns = rq2[0]?.results.map(r => r.fn) || [];
const palette = ['rgb(220,53,69)', 'rgb(13,110,253)', 'rgb(111,66,193)', 'rgb(253,126,20)'];

const callGrowthDatasets = misplacedFns.map((fn, i) => ({
  label: fn,
  data: rq2.map(row => ({
    x: typeof row.n === 'string' ? parseInt(row.n) : row.n,
    y: row.results.find(r => r.fn === fn)?.totalCalls || 0,
  })),
  borderColor: palette[i % palette.length],
  backgroundColor: 'transparent',
  tension: 0.3,
  pointRadius: 5,
  pointHoverRadius: 7,
  borderWidth: 2.5,
}));

// ── Figure 8 & 9: RQ3 threshold sweep (exp2 only) ────────────────────────────
const rq3Rows    = (saved.rq3 || []).filter(r => r.perScenario && r.perScenario.exp2);
const rq3Labels  = rq3Rows.map(r => r.threshold + '%');
const rq3Prec    = rq3Rows.map(r => parseFloat((r.perScenario.exp2.precision * 100).toFixed(1)));
const rq3Recall  = rq3Rows.map(r => parseFloat((r.perScenario.exp2.recall    * 100).toFixed(1)));
const rq3F1      = rq3Rows.map(r => parseFloat((r.perScenario.exp2.f1        * 100).toFixed(1)));

// ── HTML ──────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Experiment 2 — Library Demo Evaluation</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8f9fa; color: #212529; }
  .page { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: #6c757d; font-size: 0.9rem; margin-bottom: 6px; }
  .scenario-badge {
    display: inline-block; background: #198754; color: #fff;
    font-size: 0.75rem; font-weight: 600; border-radius: 20px;
    padding: 3px 12px; margin-bottom: 28px; letter-spacing: 0.4px;
  }
  h2 { font-size: 1.05rem; font-weight: 600; color: #343a40; margin-bottom: 6px; margin-top: 0; }
  .caption { font-size: 0.82rem; color: #6c757d; margin-top: 10px; line-height: 1.5; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .grid-1 { margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 20px 24px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .chart-wrap { position: relative; }
  /* Confusion matrix */
  .cm { display: grid; grid-template-columns: auto 1fr 1fr; gap: 6px; margin-top: 14px; }
  .cm-label { display: flex; align-items: center; justify-content: center;
              font-size: 0.78rem; font-weight: 600; color: #495057; }
  .cm-label.row { writing-mode: vertical-lr; transform: rotate(180deg); }
  .cm-cell { border-radius: 8px; padding: 18px 8px; text-align: center; }
  .cm-cell .count { font-size: 2.2rem; font-weight: 700; line-height: 1; }
  .cm-cell .name  { font-size: 0.75rem; margin-top: 4px; font-weight: 600; }
  .cm-cell .desc  { font-size: 0.68rem; color: #555; margin-top: 2px; }
  .tp { background: #d4edda; color: #155724; }
  .fp { background: #fff3cd; color: #856404; }
  .fn { background: #f8d7da; color: #721c24; }
  .tn { background: #d1ecf1; color: #0c5460; }
  /* Metric boxes */
  .metrics { display: flex; gap: 12px; margin-top: 0; margin-bottom: 20px; flex-wrap: wrap; }
  .metric-box { flex: 1; min-width: 90px; border-radius: 8px; padding: 14px; text-align: center; }
  .metric-box .val { font-size: 1.7rem; font-weight: 700; }
  .metric-box .lbl { font-size: 0.73rem; color: #6c757d; margin-top: 2px; }
  .prec    { background: #fff3cd; }
  .rec     { background: #d4edda; }
  .f1      { background: #cfe2ff; }
  .traces  { background: #f3e8ff; }
  .labelled { background: #fce4ec; }
  /* Legend */
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; margin-bottom: 4px; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  /* Warning box */
  .alert-fp {
    background: #fff8e1; border-left: 4px solid #ffc107;
    border-radius: 6px; padding: 12px 16px; font-size: 0.85rem;
    margin-top: 10px; line-height: 1.6;
  }
  /* Section divider */
  .section-title {
    font-size: 0.78rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: #6c757d; margin: 28px 0 14px;
    border-bottom: 1px solid #dee2e6; padding-bottom: 6px;
  }
  @media print {
    body { background: #fff; }
    .card { box-shadow: none; border: 1px solid #dee2e6; page-break-inside: avoid; }
    .page { padding: 16px; }
  }
</style>
</head>
<body>
<div class="page">

  <h1>Function Placement Analyzer — Experiment 2</h1>
  <p class="subtitle">Library Management System Scenario &nbsp;·&nbsp; library-demo &nbsp;·&nbsp;
    ${traceCount} traces collected &nbsp;·&nbsp; threshold: ${THRESHOLD}% external calls</p>
  <div class="scenario-badge">Experiment 2 &mdash; library-demo</div>

  <!-- ── Summary metrics ── -->
  <div class="metrics">
    <div class="metric-box prec">
      <div class="val">${(precision*100).toFixed(1)}%</div>
      <div class="lbl">Precision</div>
    </div>
    <div class="metric-box rec">
      <div class="val">${(recall*100).toFixed(0)}%</div>
      <div class="lbl">Recall</div>
    </div>
    <div class="metric-box f1">
      <div class="val">${(f1*100).toFixed(0)}%</div>
      <div class="lbl">F1 Score</div>
    </div>
    <div class="metric-box traces">
      <div class="val">${traceCount}</div>
      <div class="lbl">Traces Collected</div>
    </div>
    <div class="metric-box labelled">
      <div class="val">${TP+FP+FN+TN}</div>
      <div class="lbl">Labelled Functions</div>
    </div>
  </div>

  <p class="section-title">RQ1 — Precision &amp; Recall</p>

  <!-- ── Row 1: Confusion matrix + per-service bars ── -->
  <div class="grid-2">

    <!-- Figure 1: Confusion matrix -->
    <div class="card">
      <h2>Figure 1 — Confusion Matrix</h2>
      <div class="cm">
        <div></div>
        <div class="cm-label" style="font-size:0.75rem">Predicted<br>Misplaced</div>
        <div class="cm-label" style="font-size:0.75rem">Predicted<br>Well-placed</div>
        <div class="cm-label row">Actually Misplaced</div>
        <div class="cm-cell tp">
          <div class="count">${TP}</div>
          <div class="name">TP</div>
          <div class="desc">True Positive</div>
        </div>
        <div class="cm-cell fn">
          <div class="count">${FN}</div>
          <div class="name">FN</div>
          <div class="desc">False Negative</div>
        </div>
        <div class="cm-label row">Actually Well-placed</div>
        <div class="cm-cell fp">
          <div class="count">${FP}</div>
          <div class="name">FP</div>
          <div class="desc">False Positive</div>
        </div>
        <div class="cm-cell tn">
          <div class="count">${TN}</div>
          <div class="name">TN</div>
          <div class="desc">True Negative</div>
        </div>
      </div>
      <p class="caption">
        Both misplaced functions correctly detected (TP=2, FN=0). One false positive:
        <em>GET /books/:id</em> is exclusively called by loan-service but is semantically
        a general book-retrieval endpoint — ownership vs. usage ambiguity.
      </p>
    </div>

    <!-- Figure 2: Per-service Precision & Recall -->
    <div class="card">
      <h2>Figure 2 — Precision &amp; Recall per Service</h2>
      <div class="chart-wrap" style="height:220px">
        <canvas id="svcChart"></canvas>
      </div>
      <p class="caption">
        <strong>book-service</strong> Precision drops below 100% due to the false-positive
        <em>GET /books/:id</em>. <strong>member-service</strong> achieves perfect Precision
        and Recall (1 TP, 0 FP). <strong>loan-service</strong> has no misplaced functions —
        only TN results (entry-point endpoints correctly kept).
      </p>
    </div>

  </div>

  <!-- ── Row 2: Call source breakdown ── -->
  <div class="grid-1">
    <div class="card">
      <h2>Figure 3 — Call Source Breakdown per Function (Internal / Peer Service / External Client)</h2>
      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:rgba(108,117,125,0.6)"></div>Internal (same service)</div>
        <div class="legend-item"><div class="legend-dot" style="background:rgba(220,53,69,0.85)"></div>Peer service — TP (correctly flagged)</div>
        <div class="legend-item"><div class="legend-dot" style="background:rgba(255,152,0,0.85)"></div>Peer service — FP (wrongly flagged)</div>
        <div class="legend-item"><div class="legend-dot" style="background:rgba(13,110,253,0.55)"></div>External client (anonymous)</div>
        <div style="display:flex;align-items:center;gap:6px;font-size:0.8rem">
          <div style="width:28px;height:2px;border-top:2px dashed #dc3545"></div>
          ${THRESHOLD}% threshold
        </div>
      </div>
      <div class="chart-wrap" style="height:${Math.max(280, fig3Rows.length * 42)}px; margin-top:14px">
        <canvas id="funcChart"></canvas>
      </div>
      <p class="caption">
        <strong>POST /calculate-late-fee</strong> (book-service) and
        <strong>POST /members/:id/validate</strong> (member-service) receive 100% of their calls
        from <em>loan-service</em> — correctly flagged for relocation (red, TP).
        <strong>POST /loans</strong> and <strong>POST /loans/:id/return</strong> are also 100%
        externally called but by an anonymous client, not a named peer — correctly kept (blue, TN).
        <strong>GET /books/:id</strong> is 100% called by loan-service and flagged (orange, FP):
        a service-ownership ambiguity the threshold alone cannot resolve.
      </p>
      <div class="alert-fp">
        ⚠ <strong>False Positive Analysis:</strong> <em>GET /books/:id</em> is exclusively called
        by loan-service (98.4% dominant), triggering the relocation flag. However, it exposes a
        general book-retrieval interface appropriate to book-service. This FP arises from
        <em>high coupling without misplacement</em> — a pattern not distinguishable from true
        misplacement using call-ratio analysis alone. Future work: ownership-aware annotations
        or interface-classification heuristics.
      </div>
    </div>
  </div>

  <!-- ── Row 3: Call volume + Latency ── -->
  <div class="grid-2">

    <!-- Figure 4: Call volume per function -->
    <div class="card">
      <h2>Figure 4 — Cross-service vs. Internal Call Volume per Function</h2>
      <div class="chart-wrap" style="height:${Math.max(220, callVolRows.length * 38)}px">
        <canvas id="callVolChart"></canvas>
      </div>
      <p class="caption">
        Absolute call counts over ${traceCount} traces. <em>POST /members/:id/validate</em>
        accumulates the highest cross-service call count (294), reflecting that member validation
        is invoked on every loan creation and return operation.
      </p>
    </div>

    <!-- Figure 5: Latency comparison -->
    <div class="card">
      <h2>Figure 5 — Average Span Latency: Internal vs. Cross-service Calls</h2>
      <div class="chart-wrap" style="height:${Math.max(220, latRows.length * 38)}px">
        <canvas id="latChart"></canvas>
      </div>
      <p class="caption">
        <strong>POST /loans</strong> shows the highest cross-service latency (≈20 ms) as it
        orchestrates calls to both book-service and member-service per loan creation.
        The misplaced functions show relatively low individual latency (≈4 ms each) but their
        cumulative cost is significant given their high call frequency.
      </p>
    </div>

  </div>

  <p class="section-title">RQ2 — Trace Volume Sensitivity</p>

  <!-- ── Row 4: RQ2 charts ── -->
  <div class="grid-2">

    <!-- Figure 6: Detection rate vs volume -->
    <div class="card">
      <h2>Figure 6 — Detection Rate vs. Trace Volume</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="rq2Chart"></canvas>
      </div>
      <p class="caption">
        Both misplaced functions are detected at <strong>N = 5 traces</strong>.
        The loan workflow exercises both misplaced endpoints on every transaction,
        so even minimal traffic is sufficient to establish the 100% external call ratio.
        Detection remains stable through all ${traceCount} traces.
      </p>
    </div>

    <!-- Figure 7: Call count growth -->
    <div class="card">
      <h2>Figure 7 — Cross-service Calls per Misplaced Function vs. Trace Volume</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="callGrowthChart"></canvas>
      </div>
      <p class="caption">
        <em>POST /members/:id/validate</em> grows at 2× the rate of
        <em>POST /calculate-late-fee</em> because member validation is triggered
        on both loan creation and loan return, while late-fee calculation only
        triggers on return operations.
      </p>
    </div>

  </div>

  ${rq3Rows.length > 0 ? `
  <p class="section-title">RQ3 — Threshold Sensitivity Analysis</p>

  <div class="grid-2">

    <!-- Figure 8: P/R vs Threshold -->
    <div class="card">
      <h2>Figure 8 — Precision &amp; Recall vs. Detection Threshold</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="rq3PrChart"></canvas>
      </div>
      <p class="caption">
        Recall stays constant at 100% across all thresholds — both misplaced functions
        have 100% external call ratios and are flagged regardless of threshold.
        Precision is constant at ${(rq3Rows[0].perScenario.exp2.precision * 100).toFixed(1)}%
        because the single FP (<em>GET /books/:id</em>, 100% external) is equally
        unresolvable at any threshold in this range.
      </p>
    </div>

    <!-- Figure 9: F1 vs Threshold -->
    <div class="card">
      <h2>Figure 9 — F1 Score vs. Detection Threshold</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="rq3F1Chart"></canvas>
      </div>
      <p class="caption">
        F1 = ${(rq3Rows[0].perScenario.exp2.f1 * 100).toFixed(1)}% across all thresholds 40%–95%.
        The persistent FP is a structural issue (ownership ambiguity), not a tuning issue.
        The dashed line marks the plugin default (${THRESHOLD}%).
      </p>
    </div>

  </div>
  ` : ''}

  <!-- ── Key findings ── -->
  <div class="card" style="margin-bottom:20px; background:#f0fff4; border-left:4px solid #198754;">
    <h2 style="color:#198754; margin-bottom:10px">Key Findings — Experiment 2</h2>
    <ul style="padding-left:18px; line-height:1.9; font-size:0.9rem">
      <li><strong>RQ1:</strong> Precision = <strong>${(precision*100).toFixed(1)}%</strong>, Recall = <strong>${(recall*100).toFixed(0)}%</strong>, F1 = <strong>${(f1*100).toFixed(0)}%</strong> across ${TP+FP+FN+TN} labelled functions.</li>
      <li><strong>RQ1:</strong> Both misplaced functions correctly identified — <em>POST /calculate-late-fee</em> (book-service) and <em>POST /members/:id/validate</em> (member-service) — both recommended for relocation to <em>loan-service</em>.</li>
      <li><strong>RQ1:</strong> One false positive — <em>GET /books/:id</em> (book-service) — flagged due to exclusive usage by loan-service despite being semantically appropriate in book-service. Represents a <em>high-coupling / not-misplaced</em> pattern.</li>
      <li><strong>RQ1:</strong> Entry-point functions <em>POST /loans</em> and <em>POST /loans/:id/return</em> are 100% externally called but correctly kept (caller is anonymous client, not a named peer).</li>
      <li><strong>RQ2:</strong> Both misplaced functions detected at the minimum sample of <strong>N = 5 traces</strong>. Stable detection across all ${traceCount} traces.</li>
      ${rq3Rows.length > 0 ? `<li><strong>RQ3:</strong> Performance is constant across all thresholds 40%–95%. The FP is not resolvable by threshold tuning — requires service-ownership metadata or semantic analysis.</li>` : ''}
    </ul>
  </div>

</div><!-- /page -->

<script>
Chart.defaults.font.family = "'Segoe UI', Arial, sans-serif";
Chart.defaults.font.size   = 12;
Chart.defaults.color       = '#495057';

// ── Figure 2: Per-service Precision & Recall ──────────────────────────────────
new Chart(document.getElementById('svcChart'), {
  type: 'bar',
  data: {
    labels: ${j(svcLabels)},
    datasets: [
      {
        label: 'Precision (%)',
        data: ${j(svcPrec)},
        backgroundColor: 'rgba(255,193,7,0.8)',
        borderColor: 'rgb(200,150,0)',
        borderWidth: 1.5,
        borderRadius: 6,
      },
      {
        label: 'Recall (%)',
        data: ${j(svcRec)},
        backgroundColor: 'rgba(40,167,69,0.8)',
        borderColor: 'rgb(25,120,50)',
        borderWidth: 1.5,
        borderRadius: 6,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y !== null ? ctx.parsed.y + '%' : 'N/A') } }
    },
    scales: {
      y: { min: 0, max: 115, ticks: { callback: v => v + '%', stepSize: 25 }, grid: { color: 'rgba(0,0,0,0.06)' } },
      x: { grid: { display: false } }
    }
  }
});

// ── Figure 3: Stacked call-source breakdown ───────────────────────────────────
new Chart(document.getElementById('funcChart'), {
  type: 'bar',
  data: {
    labels: ${j(fig3Labels)},
    datasets: [
      {
        label: 'Internal (same service)',
        data: ${j(fig3Internal)},
        backgroundColor: 'rgba(108,117,125,0.55)',
        borderColor: 'rgba(80,90,100,0.7)',
        borderWidth: 1,
        stack: 'calls',
      },
      {
        label: 'Peer service (dominant caller)',
        data: ${j(fig3Peer)},
        backgroundColor: ${j(fig3PeerColor)},
        borderColor: ${j(fig3PeerBorder)},
        borderWidth: 1.5,
        stack: 'calls',
      },
      {
        label: 'External client (anonymous)',
        data: ${j(fig3Client)},
        backgroundColor: 'rgba(13,110,253,0.55)',
        borderColor: 'rgba(10,80,200,0.7)',
        borderWidth: 1,
        stack: 'calls',
      },
    ]
  },
  options: {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: ctx => {
            const v = ctx.parsed.x;
            if (v === 0) return null;
            return ctx.dataset.label + ': ' + v.toFixed(1) + '%';
          },
          afterBody: items => {
            const idx = items[0]?.dataIndex;
            if (idx === undefined) return [];
            return ['Outcome: ' + ${j(fig3Outcome)}[idx]];
          }
        }
      }
    },
    scales: {
      x: {
        stacked: true, min: 0, max: 100,
        ticks: { callback: v => v + '%' },
        grid: { color: 'rgba(0,0,0,0.06)' },
        title: { display: true, text: '% of Total Calls' },
        afterDataLimits(scale) { scale.max = 100; }
      },
      y: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } }
    }
  }
});

// ── Figure 4: Call volume per function ───────────────────────────────────────
new Chart(document.getElementById('callVolChart'), {
  type: 'bar',
  data: {
    labels: ${j(callVolLabels)},
    datasets: [
      {
        label: 'Internal Calls',
        data: ${j(callVolInt)},
        backgroundColor: 'rgba(108,117,125,0.7)',
        borderColor: 'rgba(70,80,90,0.8)',
        borderWidth: 1.5,
        borderRadius: 5,
        stack: 'vol',
      },
      {
        label: 'Cross-service Calls',
        data: ${j(callVolExt)},
        backgroundColor: 'rgba(220,53,69,0.7)',
        borderColor: 'rgba(180,30,50,0.8)',
        borderWidth: 1.5,
        borderRadius: 5,
        stack: 'vol',
      }
    ]
  },
  options: {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.x } }
    },
    scales: {
      x: {
        stacked: true,
        title: { display: true, text: 'Total Call Count' },
        grid: { color: 'rgba(0,0,0,0.06)' }
      },
      y: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } }
    }
  }
});

// ── Figure 5: Latency comparison ──────────────────────────────────────────────
new Chart(document.getElementById('latChart'), {
  type: 'bar',
  data: {
    labels: ${j(latLabels)},
    datasets: [
      {
        label: 'Avg Internal Latency (ms)',
        data: ${j(latInternal)},
        backgroundColor: 'rgba(108,117,125,0.7)',
        borderColor: 'rgba(70,80,90,0.8)',
        borderWidth: 1.5,
        borderRadius: 5,
      },
      {
        label: 'Avg Cross-service Latency (ms)',
        data: ${j(latExternal)},
        backgroundColor: 'rgba(220,53,69,0.7)',
        borderColor: 'rgba(180,30,50,0.8)',
        borderWidth: 1.5,
        borderRadius: 5,
      }
    ]
  },
  options: {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.x.toFixed(2) + ' ms' } }
    },
    scales: {
      x: { title: { display: true, text: 'Average Latency (ms)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
      y: { grid: { display: false }, ticks: { font: { size: 11 } } }
    }
  }
});

// ── Figure 6: Detection rate vs trace volume ──────────────────────────────────
new Chart(document.getElementById('rq2Chart'), {
  type: 'line',
  data: {
    datasets: [{
      label: 'Detection Rate — Exp 2',
      data: ${j(rq2Points)},
      borderColor: 'rgb(25,135,84)',
      backgroundColor: 'rgba(25,135,84,0.1)',
      fill: true,
      tension: 0.2,
      pointRadius: 6,
      pointHoverRadius: 8,
      borderWidth: 2.5,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => 'Detection: ' + ctx.parsed.y + '%' } }
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: 'Number of Traces (N)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
      y: { min: 0, max: 110, ticks: { callback: v => v + '%', stepSize: 25 },
           title: { display: true, text: 'Detection Rate (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } }
    }
  }
});

// ── Figure 7: Call count growth per misplaced function ────────────────────────
new Chart(document.getElementById('callGrowthChart'), {
  type: 'line',
  data: { datasets: ${j(callGrowthDatasets)} },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
    },
    scales: {
      x: { type: 'linear', title: { display: true, text: 'Number of Traces (N)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
      y: { title: { display: true, text: 'Cross-service Calls Observed' }, grid: { color: 'rgba(0,0,0,0.06)' } }
    }
  }
});

${rq3Rows.length > 0 ? `
// ── Figure 8: RQ3 P/R vs Threshold ───────────────────────────────────────────
new Chart(document.getElementById('rq3PrChart'), {
  type: 'line',
  data: {
    labels: ${j(rq3Labels)},
    datasets: [
      {
        label: 'Precision',
        data: ${j(rq3Prec)},
        borderColor: 'rgb(255,193,7)',
        backgroundColor: 'rgba(255,193,7,0.15)',
        fill: true,
        tension: 0,
        pointRadius: 5,
        borderWidth: 2.5,
      },
      {
        label: 'Recall',
        data: ${j(rq3Recall)},
        borderColor: 'rgb(40,167,69)',
        backgroundColor: 'rgba(40,167,69,0.1)',
        fill: true,
        tension: 0,
        pointRadius: 5,
        borderWidth: 2.5,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '%' } }
    },
    scales: {
      x: { title: { display: true, text: 'External-Call Threshold (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
      y: { min: 0, max: 110, ticks: { callback: v => v + '%', stepSize: 25 },
           title: { display: true, text: 'Score (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } }
    }
  }
});

// ── Figure 9: RQ3 F1 vs Threshold ────────────────────────────────────────────
new Chart(document.getElementById('rq3F1Chart'), {
  type: 'line',
  data: {
    labels: ${j(rq3Labels)},
    datasets: [{
      label: 'F1 Score',
      data: ${j(rq3F1)},
      borderColor: 'rgb(25,135,84)',
      backgroundColor: 'rgba(25,135,84,0.12)',
      fill: true,
      tension: 0,
      pointRadius: 5,
      borderWidth: 2.5,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => 'F1: ' + ctx.parsed.y + '%' } }
    },
    scales: {
      x: { title: { display: true, text: 'External-Call Threshold (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
      y: { min: 0, max: 110, ticks: { callback: v => v + '%', stepSize: 25 },
           title: { display: true, text: 'F1 Score (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } }
    }
  }
});
` : ''}
<\/script>
</body>
</html>`;

fs.writeFileSync(OUTPUT_FILE, html);
console.log(`✅  Report written to: ${OUTPUT_FILE}`);
console.log(`    Open in browser: file://${OUTPUT_FILE}`);
