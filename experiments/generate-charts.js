/**
 * Chart Generator for FRA Plugin Evaluation
 *
 * Reads experiments/results.json and writes experiments/report.html —
 * a standalone, print-ready HTML page with 5 research figures.
 *
 * Usage:
 *   node experiments/generate-charts.js
 *
 * Then open experiments/report.html in a browser.
 * Use browser Print → Save as PDF to embed in your report.
 *
 * No npm install required.
 */

const fs   = require('fs');
const path = require('path');

const RESULTS_FILE = path.join(__dirname, 'results.json');
const OUTPUT_FILE  = path.join(__dirname, 'report.html');
const THRESHOLD    = 65; // %

// ── Load results ──────────────────────────────────────────────────────────────
if (!fs.existsSync(RESULTS_FILE)) {
  console.error('results.json not found. Run: node experiments/evaluate.js --save');
  process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));

// ── Aggregate across all saved experiments ────────────────────────────────────
let totalTP = 0, totalFP = 0, totalFN = 0, totalTN = 0;
const allDetails   = [];  // per-function detail rows across experiments
const rq2Datasets  = [];  // one dataset per experiment for RQ2

for (const [key, data] of Object.entries(saved)) {
  if (!data.rq1) continue;   // skip non-experiment entries (e.g. rq3 sweep)
  const { rq1, rq2, label, traceCount } = data;
  totalTP += rq1.TP; totalFP += rq1.FP;
  totalFN += rq1.FN; totalTN += rq1.TN;

  for (const d of rq1.detail) {
    allDetails.push({ ...d, experiment: label });
  }

  if (rq2 && rq2.length > 0) {
    const knownMisplaced = rq2[0].results.map(r => r.fn);
    rq2Datasets.push({ label, key, rq2, knownMisplaced, traceCount });
  }
}

const combPrec = (totalTP + totalFP) > 0 ? totalTP / (totalTP + totalFP) : 0;
const combRec  = (totalTP + totalFN) > 0 ? totalTP / (totalTP + totalFN) : 0;
const combF1   = (combPrec + combRec)  > 0 ? 2 * combPrec * combRec / (combPrec + combRec) : 0;

// ── Build chart data ──────────────────────────────────────────────────────────

// Figure 3 — stacked bar: internal / peer-service / anonymous-client breakdown
// Only include functions that have a recorded result (were seen in traces).
const fig3Rows = allDetails.filter(d => d.result);

// Short label: "functionName\n(service)" — used as Y-axis tick on horizontal chart
const fig3Labels = fig3Rows.map(d =>
  `${d.functionName.substring(0, 32)}  [${d.currentService}]`
);

// For each function compute the three-way split (all as % of total calls)
const fig3Internal = fig3Rows.map(d => {
  const total = d.result.internalCalls + d.result.externalCalls;
  return total > 0 ? parseFloat(((d.result.internalCalls / total) * 100).toFixed(1)) : 0;
});

const fig3Peer = fig3Rows.map(d => {
  const total = d.result.internalCalls + d.result.externalCalls;
  const caller = d.result.dominantCaller;
  // Only count as "peer service" when caller is a named microservice, not anonymous client
  const isPeer = caller && !caller.startsWith('external') && caller !== 'unknown' && caller !== 'none';
  if (!isPeer || total === 0) return 0;
  return parseFloat((d.result.dominantPercent * 100).toFixed(1));
});

const fig3Client = fig3Rows.map((d, i) =>
  parseFloat(Math.max(0, 100 - fig3Internal[i] - fig3Peer[i]).toFixed(1))
);

// Peer segment colour encodes outcome
const fig3PeerColor = fig3Rows.map(d => {
  if (d.outcome === 'TP') return 'rgba(220,53,69,0.85)';   // red  — correctly flagged
  if (d.outcome === 'FP') return 'rgba(255,152,0,0.85)';   // orange — false positive
  return 'rgba(220,53,69,0.15)';                            // faded — no dominant peer
});
const fig3PeerBorder = fig3Rows.map(d => {
  if (d.outcome === 'TP') return 'rgb(180,30,50)';
  if (d.outcome === 'FP') return 'rgb(200,120,0)';
  return 'rgba(200,53,69,0.3)';
});

// Figure 4 — RQ2 line chart: detected count vs trace volume
const rq2ChartDatasets = rq2Datasets.map((ds, i) => {
  const colors = ['rgb(220,53,69)', 'rgb(13,110,253)'];
  const fills  = ['rgba(220,53,69,0.1)', 'rgba(13,110,253,0.1)'];
  return {
    label: ds.label.replace('Experiment ', 'Exp '),
    data: ds.rq2.map(row => ({
      x: typeof row.n === 'string' ? parseInt(row.n) : row.n,
      y: (row.detectedCount / row.total) * 100,
    })),
    borderColor: colors[i % colors.length],
    backgroundColor: fills[i % fills.length],
    fill: true,
    tension: 0.3,
    pointRadius: 5,
    pointHoverRadius: 7,
  };
});

// ── RQ3 threshold sweep data ──────────────────────────────────────────────────
const rq3Rows = saved.rq3 || [];

// Combined P / R / F1 across thresholds
const rq3ThreshLabels = rq3Rows.map(r => r.threshold + '%');
const rq3Precision    = rq3Rows.map(r => parseFloat((r.precision * 100).toFixed(1)));
const rq3Recall       = rq3Rows.map(r => parseFloat((r.recall    * 100).toFixed(1)));
const rq3F1           = rq3Rows.map(r => parseFloat((r.f1        * 100).toFixed(1)));

// Per-scenario precision lines (for Figure 6 detail)
const rq3ScenarioKeys  = Object.keys((rq3Rows[0] || {}).perScenario || {});
const rq3ScenarioLines = rq3ScenarioKeys.map((key, i) => {
  const colors = ['rgba(220,53,69,0.8)', 'rgba(13,110,253,0.8)'];
  const label  = saved[key]?.label?.replace('Experiment ', 'Exp ') || key;
  return {
    label: label + ' — Precision',
    data:  rq3Rows.map(r => parseFloat((r.perScenario[key].precision * 100).toFixed(1))),
    borderColor: colors[i % colors.length],
    backgroundColor: 'transparent',
    borderDash: [],
    tension: 0,
    pointRadius: 4,
  };
});

// Figure 5 — call count growth per misplaced function
const callGrowthDatasets = [];
const palette = [
  'rgb(220,53,69)', 'rgb(13,110,253)', 'rgb(111,66,193)',
  'rgb(253,126,20)', 'rgb(32,201,151)',
];
let colorIdx = 0;
for (const ds of rq2Datasets) {
  for (const fnName of ds.knownMisplaced) {
    const points = ds.rq2.map(row => {
      const r = row.results.find(r => r.fn === fnName);
      return { x: typeof row.n === 'string' ? parseInt(row.n) : row.n, y: r ? r.totalCalls : 0 };
    });
    const shortFn = fnName.length > 30 ? fnName.substring(0, 28) + '…' : fnName;
    callGrowthDatasets.push({
      label: shortFn,
      data: points,
      borderColor: palette[colorIdx % palette.length],
      backgroundColor: 'transparent',
      tension: 0.3,
      pointRadius: 4,
    });
    colorIdx++;
  }
}

// ── JSON blobs for inline chart data ─────────────────────────────────────────
const j = v => JSON.stringify(v);

// ── HTML ──────────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>FRA Plugin — Evaluation Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8f9fa; color: #212529; }
  .page { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: #6c757d; font-size: 0.95rem; margin-bottom: 32px; }
  h2 { font-size: 1.1rem; font-weight: 600; color: #343a40; margin-bottom: 6px; margin-top: 0; }
  .caption { font-size: 0.82rem; color: #6c757d; margin-top: 8px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .grid-1 { margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 20px 24px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .chart-wrap { position: relative; }
  /* ── Confusion matrix ── */
  .cm { display: grid; grid-template-columns: auto 1fr 1fr; gap: 6px; margin-top: 12px; }
  .cm-label { display: flex; align-items: center; justify-content: center;
              font-size: 0.78rem; font-weight: 600; color: #495057; }
  .cm-label.row { writing-mode: vertical-lr; transform: rotate(180deg); }
  .cm-cell { border-radius: 8px; padding: 16px 8px; text-align: center; }
  .cm-cell .count { font-size: 2rem; font-weight: 700; line-height: 1; }
  .cm-cell .name  { font-size: 0.75rem; margin-top: 4px; font-weight: 600; }
  .cm-cell .desc  { font-size: 0.68rem; color: #555; margin-top: 2px; }
  .tp { background: #d4edda; color: #155724; }
  .fp { background: #fff3cd; color: #856404; }
  .fn { background: #f8d7da; color: #721c24; }
  .tn { background: #d1ecf1; color: #0c5460; }
  /* ── Metrics summary ── */
  .metrics { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
  .metric-box { flex: 1; min-width: 90px; border-radius: 8px; padding: 12px;
                text-align: center; background: #f1f3f5; }
  .metric-box .val { font-size: 1.6rem; font-weight: 700; }
  .metric-box .lbl { font-size: 0.75rem; color: #6c757d; margin-top: 2px; }
  .prec { background: #fff3cd; }
  .rec  { background: #d4edda; }
  .f1   { background: #cfe2ff; }
  /* ── Legend ── */
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  @media print {
    body { background: #fff; }
    .card { box-shadow: none; border: 1px solid #dee2e6; }
    .page { padding: 16px; }
  }
</style>
</head>
<body>
<div class="page">

  <h1>Function Placement Analyzer — Evaluation Results</h1>
  <p class="subtitle">
    RQ1: Precision &amp; Recall &nbsp;|&nbsp; RQ2: Trace Volume Sensitivity &nbsp;|&nbsp;
    RQ3: Threshold Sensitivity &nbsp;|&nbsp;
    Threshold: ${THRESHOLD}% external calls &nbsp;|&nbsp;
    Total labelled functions: ${allDetails.length}
  </p>

  <!-- ── Row 1: Confusion matrix + Metrics ── -->
  <div class="grid-2">

    <!-- Figure 1: Confusion matrix -->
    <div class="card">
      <h2>Figure 1 — Confusion Matrix (Combined)</h2>
      <div class="cm">
        <!-- header row -->
        <div></div>
        <div class="cm-label" style="font-size:0.75rem">Predicted<br>Misplaced</div>
        <div class="cm-label" style="font-size:0.75rem">Predicted<br>Well-placed</div>
        <!-- data row 1 -->
        <div class="cm-label row">Actually Misplaced</div>
        <div class="cm-cell tp">
          <div class="count">${totalTP}</div>
          <div class="name">TP</div>
          <div class="desc">True Positive</div>
        </div>
        <div class="cm-cell fn">
          <div class="count">${totalFN}</div>
          <div class="name">FN</div>
          <div class="desc">False Negative</div>
        </div>
        <!-- data row 2 -->
        <div class="cm-label row">Actually Well-placed</div>
        <div class="cm-cell fp">
          <div class="count">${totalFP}</div>
          <div class="name">FP</div>
          <div class="desc">False Positive</div>
        </div>
        <div class="cm-cell tn">
          <div class="count">${totalTN}</div>
          <div class="name">TN</div>
          <div class="desc">True Negative</div>
        </div>
      </div>
      <p class="caption">
        TP = correctly flagged misplaced &nbsp;|&nbsp; FP = well-placed function wrongly flagged &nbsp;|&nbsp;
        FN = missed misplacement &nbsp;|&nbsp; TN = well-placed and correctly kept
      </p>
    </div>

    <!-- Figure 2: Precision / Recall / F1 -->
    <div class="card">
      <h2>Figure 2 — Precision, Recall &amp; F1 Score</h2>
      <div class="chart-wrap" style="height:200px">
        <canvas id="metricsChart"></canvas>
      </div>
      <div class="metrics">
        <div class="metric-box prec">
          <div class="val">${(combPrec*100).toFixed(1)}%</div>
          <div class="lbl">Precision</div>
        </div>
        <div class="metric-box rec">
          <div class="val">${(combRec*100).toFixed(1)}%</div>
          <div class="lbl">Recall</div>
        </div>
        <div class="metric-box f1">
          <div class="val">${(combF1*100).toFixed(1)}%</div>
          <div class="lbl">F1 Score</div>
        </div>
      </div>
      <p class="caption">
        Combined across all experiments.
        Precision = TP/(TP+FP) &nbsp;|&nbsp; Recall = TP/(TP+FN) &nbsp;|&nbsp;
        F1 = harmonic mean of Precision &amp; Recall.
      </p>
    </div>

  </div><!-- /grid-2 -->

  <!-- ── Row 2: Stacked call-source breakdown ── -->
  <div class="grid-1">
    <div class="card">
      <h2>Figure 3 — Call Source Breakdown per Function (Internal / Peer Service / External Client)</h2>
      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:rgba(108,117,125,0.6)"></div>Internal calls (same service)</div>
        <div class="legend-item"><div class="legend-dot" style="background:rgba(220,53,69,0.85)"></div>Called by peer service — TP (correctly flagged)</div>
        <div class="legend-item"><div class="legend-dot" style="background:rgba(255,152,0,0.85)"></div>Called by peer service — FP (wrongly flagged)</div>
        <div class="legend-item"><div class="legend-dot" style="background:rgba(13,110,253,0.65)"></div>Called by external client (anonymous)</div>
        <div style="display:flex;align-items:center;gap:6px;font-size:0.8rem">
          <div style="width:28px;height:2px;border-top:2px dashed #dc3545"></div>
          ${THRESHOLD}% external threshold
        </div>
      </div>
      <div class="chart-wrap" style="height:${Math.max(280, fig3Rows.length * 34)}px; margin-top:14px">
        <canvas id="funcChart"></canvas>
      </div>
      <p class="caption">
        Each bar shows the proportion of calls that are internal (grey), from a specific named peer
        microservice (red/orange), or from an anonymous external client (blue). Functions whose
        red/orange segment alone exceeds the ${THRESHOLD}% threshold are flagged for relocation.
        Entry-point functions (e.g. <em>POST /loans</em>) are legitimately 100% external — but
        their caller is anonymous, not a named peer, so the analyzer correctly keeps them.
      </p>
    </div>
  </div>

  <!-- ── Row 3: RQ2 charts ── -->
  <div class="grid-2">

    <!-- Figure 4: Detection rate vs trace volume -->
    <div class="card">
      <h2>Figure 4 — Detection Rate vs. Trace Volume (RQ2)</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="rq2Chart"></canvas>
      </div>
      <p class="caption">
        Detection rate (%) of known-misplaced functions at increasing trace sample sizes.
        A value of 100% means all misplaced functions were correctly identified at that volume.
        The earliest N where rate = 100% is the <em>minimum reliable trace volume</em>.
      </p>
    </div>

    <!-- Figure 5: Call count growth -->
    <div class="card">
      <h2>Figure 5 — Observed Calls per Misplaced Function vs. Trace Volume (RQ2)</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="callGrowthChart"></canvas>
      </div>
      <p class="caption">
        Number of cross-service calls observed for each known-misplaced function
        as the trace sample size grows. Even at N=5 traces, at least one call per
        function is observed — sufficient to establish the 100% external call ratio.
      </p>
    </div>

  </div><!-- /grid-2 -->

  <!-- ── Row 4: RQ3 threshold sensitivity ── -->
  ${rq3Rows.length > 0 ? `
  <div class="grid-2">

    <!-- Figure 6: Precision & Recall vs Threshold -->
    <div class="card">
      <h2>Figure 6 — Precision &amp; Recall vs. Detection Threshold (RQ3)</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="rq3PrChart"></canvas>
      </div>
      <p class="caption">
        Precision and Recall at external-call thresholds from 40% to 95% (confidence margin fixed at 5%).
        Flat curves indicate the classifier is <em>threshold-robust</em> for the evaluated dataset:
        all misplaced functions exhibit ≥ 99% external call ratios, so any threshold ≤ 99% yields
        identical decisions. The single persistent FP (<em>GET /books/:id</em>) arises from service-ownership
        ambiguity — not addressable by threshold tuning.
      </p>
    </div>

    <!-- Figure 7: F1 vs Threshold -->
    <div class="card">
      <h2>Figure 7 — F1 Score vs. Detection Threshold (RQ3)</h2>
      <div class="chart-wrap" style="height:240px">
        <canvas id="rq3F1Chart"></canvas>
      </div>
      <p class="caption">
        Harmonic mean of Precision and Recall across the threshold range.
        The constant F1 = ${rq3Rows[0] ? (rq3Rows[0].f1 * 100).toFixed(1) : 'N/A'}% across all thresholds
        confirms that the chosen default (${THRESHOLD}%) is not a special optimum — it is simply a
        reasonable lower bound that avoids flagging functions with moderate (50–64%) external call ratios
        until sufficient evidence has accumulated.
        The vertical dashed line marks the plugin default (${THRESHOLD}%).
      </p>
    </div>

  </div><!-- /grid-2 rq3 -->
  ` : ''}

</div><!-- /page -->

<script>
// ── Chart defaults ────────────────────────────────────────────────────────────
Chart.defaults.font.family = "'Segoe UI', Arial, sans-serif";
Chart.defaults.font.size   = 12;
Chart.defaults.color       = '#495057';

// ── Figure 2: Precision / Recall / F1 bar ─────────────────────────────────────
new Chart(document.getElementById('metricsChart'), {
  type: 'bar',
  data: {
    labels: ['Precision', 'Recall', 'F1 Score'],
    datasets: [{
      data: [
        ${(combPrec*100).toFixed(1)},
        ${(combRec*100).toFixed(1)},
        ${(combF1*100).toFixed(1)}
      ],
      backgroundColor: [
        'rgba(255,193,7,0.8)',
        'rgba(40,167,69,0.8)',
        'rgba(13,110,253,0.8)'
      ],
      borderColor: [
        'rgb(200,150,0)',
        'rgb(25,120,50)',
        'rgb(10,80,200)'
      ],
      borderWidth: 1.5,
      borderRadius: 6,
    }]
  },
  options: {
    indexAxis: 'x',
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      y: {
        min: 0, max: 100,
        ticks: { callback: v => v + '%' },
        grid: { color: 'rgba(0,0,0,0.06)' }
      },
      x: { grid: { display: false } }
    }
  }
});

// ── Figure 3: Stacked horizontal bar — call source breakdown ──────────────────
new Chart(document.getElementById('funcChart'), {
  type: 'bar',
  data: {
    labels: ${j(fig3Labels)},
    datasets: [
      {
        label: 'Internal',
        data: ${j(fig3Internal)},
        backgroundColor: 'rgba(108,117,125,0.55)',
        borderColor: 'rgba(80,90,100,0.7)',
        borderWidth: 1,
        borderRadius: 0,
        stack: 'calls',
      },
      {
        label: 'Peer service (dominant caller)',
        data: ${j(fig3Peer)},
        backgroundColor: ${j(fig3PeerColor)},
        borderColor: ${j(fig3PeerBorder)},
        borderWidth: 1.5,
        borderRadius: 0,
        stack: 'calls',
      },
      {
        label: 'External client',
        data: ${j(fig3Client)},
        backgroundColor: 'rgba(13,110,253,0.55)',
        borderColor: 'rgba(10,80,200,0.7)',
        borderWidth: 1,
        borderRadius: 0,
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
          }
        }
      }
    },
    scales: {
      x: {
        stacked: true,
        min: 0, max: 100,
        ticks: { callback: v => v + '%' },
        grid: { color: 'rgba(0,0,0,0.06)' },
        title: { display: true, text: '% of Total Calls' },
        afterDataLimits(scale) {
          scale.max = 100;
        }
      },
      y: {
        stacked: true,
        grid: { display: false },
        ticks: { font: { size: 11 } }
      }
    }
  }
});

// ── Figure 4: RQ2 detection rate line chart ────────────────────────────────────
new Chart(document.getElementById('rq2Chart'), {
  type: 'line',
  data: { datasets: ${j(rq2ChartDatasets)} },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '%' } }
    },
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'Number of Traces (N)' },
        grid: { color: 'rgba(0,0,0,0.06)' }
      },
      y: {
        min: 0, max: 105,
        ticks: { callback: v => v + '%', stepSize: 25 },
        title: { display: true, text: 'Detection Rate (%)' },
        grid: { color: 'rgba(0,0,0,0.06)' }
      }
    }
  }
});

// ── Figure 6: RQ3 Precision & Recall vs Threshold ─────────────────────────────
${rq3Rows.length > 0 ? `
(function() {
  const ctx = document.getElementById('rq3PrChart');
  if (!ctx) return;
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ${j(rq3ThreshLabels)},
      datasets: [
        {
          label: 'Combined Precision',
          data: ${j(rq3Precision)},
          borderColor: 'rgb(255,193,7)',
          backgroundColor: 'rgba(255,193,7,0.15)',
          fill: true,
          tension: 0,
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 2.5,
        },
        {
          label: 'Combined Recall',
          data: ${j(rq3Recall)},
          borderColor: 'rgb(40,167,69)',
          backgroundColor: 'rgba(40,167,69,0.1)',
          fill: true,
          tension: 0,
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 2.5,
        },
        ...${j(rq3ScenarioLines)}.map(ds => ({ ...ds, borderWidth: 1.5, pointRadius: 3, borderDash: [4,3] })),
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%' } },
        annotation: {
          annotations: {
            defaultThresh: {
              type: 'line',
              scaleID: 'x',
              value: '${THRESHOLD}%',
              borderColor: 'rgba(13,110,253,0.7)',
              borderWidth: 2,
              borderDash: [6, 4],
              label: { content: 'Default ${THRESHOLD}%', display: true, position: 'start', font: { size: 10 } }
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'External-Call Threshold (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y: { min: 0, max: 105, ticks: { callback: v => v + '%', stepSize: 25 },
             title: { display: true, text: 'Score (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } }
      }
    }
  });
})();
` : '// rq3 data not yet computed'}

// ── Figure 7: RQ3 F1 vs Threshold ─────────────────────────────────────────────
${rq3Rows.length > 0 ? `
(function() {
  const ctx = document.getElementById('rq3F1Chart');
  if (!ctx) return;
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ${j(rq3ThreshLabels)},
      datasets: [{
        label: 'Combined F1 Score',
        data: ${j(rq3F1)},
        borderColor: 'rgb(13,110,253)',
        backgroundColor: 'rgba(13,110,253,0.12)',
        fill: true,
        tension: 0,
        pointRadius: 5,
        pointHoverRadius: 7,
        borderWidth: 2.5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => 'F1: ' + ctx.parsed.y.toFixed(1) + '%' } },
      },
      scales: {
        x: { title: { display: true, text: 'External-Call Threshold (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y: { min: 0, max: 105, ticks: { callback: v => v + '%', stepSize: 25 },
             title: { display: true, text: 'F1 Score (%)' }, grid: { color: 'rgba(0,0,0,0.06)' } }
      }
    }
  });
})();
` : '// rq3 data not yet computed'}

// ── Figure 5: Call count growth ────────────────────────────────────────────────
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
      x: {
        type: 'linear',
        title: { display: true, text: 'Number of Traces (N)' },
        grid: { color: 'rgba(0,0,0,0.06)' }
      },
      y: {
        title: { display: true, text: 'Cross-service Calls Observed' },
        grid: { color: 'rgba(0,0,0,0.06)' }
      }
    }
  }
});
<\/script>
</body>
</html>`;

fs.writeFileSync(OUTPUT_FILE, html);
console.log(`✅ Report written to: ${OUTPUT_FILE}`);
console.log(`   Open in browser: file://${OUTPUT_FILE}`);
