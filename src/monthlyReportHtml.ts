/**
 * Self-contained HTML dashboard (dark theme) inspired by "monthly Jira report" style.
 * Uses Chart.js from CDN — open the file in a browser.
 */

export type MonthlyIssueRow = {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  storyPoints: number;
  issueType: string;
  labels: string[];
  updated: string;
  resolutionDate: string;
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sumByLabel(issues: MonthlyIssueRow[]): Array<{ label: string; points: number; count: number }> {
  const m = new Map<string, { points: number; count: number }>();
  for (const i of issues) {
    const labs = i.labels?.length ? i.labels : ['(no label)'];
    for (const lab of labs) {
      const cur = m.get(lab) ?? { points: 0, count: 0 };
      cur.points += Number(i.storyPoints) || 0;
      cur.count += 1;
      m.set(lab, cur);
    }
  }
  return [...m.entries()]
    .map(([label, v]) => ({ label, points: Math.round(v.points * 10) / 10, count: v.count }))
    .sort((a, b) => b.points - a.points);
}

function sumByAssignee(issues: MonthlyIssueRow[]): Array<{ name: string; points: number; count: number }> {
  const m = new Map<string, { points: number; count: number }>();
  for (const i of issues) {
    const name = i.assignee || 'Unassigned';
    const cur = m.get(name) ?? { points: 0, count: 0 };
    cur.points += Number(i.storyPoints) || 0;
    cur.count += 1;
    m.set(name, cur);
  }
  return [...m.entries()]
    .map(([name, v]) => ({ name, points: Math.round(v.points * 10) / 10, count: v.count }))
    .sort((a, b) => b.points - a.points);
}

function rtbCtbSplit(issues: MonthlyIssueRow[]): { rtb: number; ctb: number; other: number } {
  let rtb = 0;
  let ctb = 0;
  let other = 0;
  for (const i of issues) {
    const pts = Number(i.storyPoints) || 0;
    const labs = i.labels ?? [];
    const hasR = labs.some(l => /^RTB/i.test(l));
    const hasC = labs.some(l => /^CTB/i.test(l));
    if (hasR && !hasC) rtb += pts;
    else if (hasC && !hasR) ctb += pts;
    else if (hasR && hasC) {
      rtb += pts / 2;
      ctb += pts / 2;
    } else other += pts;
  }
  return {
    rtb: Math.round(rtb * 10) / 10,
    ctb: Math.round(ctb * 10) / 10,
    other: Math.round(other * 10) / 10
  };
}

export function buildMonthlyJiraHtmlReport(opts: {
  title: string;
  jql: string;
  issues: MonthlyIssueRow[];
  generatedAtIso: string;
}): string {
  const { title, jql, issues, generatedAtIso } = opts;
  const totalPts = issues.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0);
  const doneLike = issues.filter(i => /done|closed|resolved|termin/i.test(i.status));
  const byLabel = sumByLabel(issues);
  const byAssignee = sumByAssignee(issues);
  const split = rtbCtbSplit(issues);
  const topLabel = byLabel[0]?.label ?? '—';
  const topAssignee = byAssignee[0]?.name ?? '—';
  const visibleLabels = new Set(issues.flatMap(i => i.labels ?? [])).size;

  const labelJson = JSON.stringify(byLabel.slice(0, 12));
  const assigneeJson = JSON.stringify(byAssignee.slice(0, 12));
  const donutData = JSON.stringify({
    labels: ['RTB (est.)', 'CTB (est.)', 'Other'],
    data: [split.rtb, split.ctb, split.other]
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0f1419;
      --card: #1a2332;
      --text: #e6edf3;
      --muted: #8b9cb3;
      --accent: #3b82f6;
      --rtb: #22c55e;
      --ctb: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif;
      background: linear-gradient(180deg, #0b0f14 0%, var(--bg) 40%);
      color: var(--text); min-height: 100vh; padding: 24px;
    }
    h1 { font-size: 1.5rem; margin: 0 0 8px; }
    .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 24px; word-break: break-all; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card {
      background: var(--card); border-radius: 12px; padding: 16px;
      border: 1px solid rgba(255,255,255,.06);
    }
    .card .v { font-size: 1.75rem; font-weight: 700; }
    .card .k { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
    @media (max-width: 900px) { .row2 { grid-template-columns: 1fr; } }
    canvas { max-height: 280px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,.06); }
    th { color: var(--muted); font-weight: 600; }
    .badge { background: var(--accent); color: #fff; border-radius: 999px; padding: 2px 8px; font-size: 0.75rem; }
    .footer { margin-top: 24px; color: var(--muted); font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="sub">Generated: ${esc(generatedAtIso)} · JQL: <code>${esc(jql)}</code></div>

  <div class="grid">
    <div class="card"><div class="k">Issues in scope</div><div class="v">${issues.length}</div></div>
    <div class="card"><div class="k">Total story points</div><div class="v">${Math.round(totalPts * 10) / 10}</div></div>
    <div class="card"><div class="k">Done-like (heuristic)</div><div class="v">${doneLike.length}</div></div>
    <div class="card"><div class="k">Top label (by pts)</div><div class="v" style="font-size:1rem">${esc(topLabel)}</div></div>
    <div class="card"><div class="k">Top assignee (by pts)</div><div class="v" style="font-size:1rem">${esc(topAssignee)}</div></div>
    <div class="card"><div class="k">Distinct labels</div><div class="v">${visibleLabels}</div></div>
  </div>

  <div class="row2">
    <div class="card">
      <div class="k" style="margin-bottom:12px">RTB vs CTB (label prefix heuristic)</div>
      <canvas id="donut"></canvas>
    </div>
    <div class="card">
      <div class="k" style="margin-bottom:12px">Summary</div>
      <p style="margin:0;color:var(--muted);font-size:0.9rem">
        Story points are summed from Jira fields exposed by the extension. If points show 0, configure the correct custom field in Jira or extend <code>extractStoryPoints</code>.
      </p>
    </div>
  </div>

  <div class="row2" style="margin-top:16px">
    <div class="card">
      <div class="k" style="margin-bottom:12px">By label</div>
      <table><thead><tr><th>Label</th><th>Points</th><th>Issues</th></tr></thead><tbody>
        ${byLabel.slice(0, 20).map(r => `<tr><td>${esc(r.label)}</td><td>${r.points}</td><td><span class="badge">${r.count}</span></td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="card">
      <div class="k" style="margin-bottom:12px">By assignee</div>
      <table><thead><tr><th>Assignee</th><th>Points</th><th>Issues</th></tr></thead><tbody>
        ${byAssignee.slice(0, 20).map(r => `<tr><td>${esc(r.name)}</td><td>${r.points}</td><td><span class="badge">${r.count}</span></td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>

  <div class="footer">Single-file HTML · Chart.js CDN · SGA extension</div>

  <script>
    const donut = ${donutData};
    const ctx = document.getElementById('donut').getContext('2d');
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: donut.labels,
        datasets: [{ data: donut.data, backgroundColor: ['#22c55e', '#3b82f6', '#64748b'] }]
      },
      options: { plugins: { legend: { labels: { color: '#e6edf3' } } } }
    });
    console.log('byLabel', ${labelJson});
    console.log('byAssignee', ${assigneeJson});
  </script>
</body>
</html>`;
}
