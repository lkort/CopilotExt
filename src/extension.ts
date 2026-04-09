import * as vscode from 'vscode';
import {
  applyFileEdits,
  computeProjectMetrics,
  FileEdit,
  GitHubClient,
  GitService,
  isIssueDone,
  JiraClient,
  ProjectMetrics
} from './services';
import { buildMonthlyJiraHtmlReport } from './monthlyReportHtml';

// ============================================================
// Constants
// ============================================================

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

// ============================================================
// VS Code configuration shortcut
// ============================================================

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sg');
}

// ============================================================
// Language Model helpers (vscode.lm)
// ============================================================

async function pickModel(): Promise<any> {
  const lm = (vscode as any).lm;
  if (!lm?.selectChatModels) {
    throw new Error('vscode.lm API unavailable. Update VS Code and enable GitHub Copilot.');
  }
  const models = await lm.selectChatModels({ vendor: 'copilot' });
  if (models?.length) return models[0];
  const fallback = await lm.selectChatModels({});
  if (!fallback?.length) throw new Error('No chat model available via vscode.lm.');
  return fallback[0];
}

/** Create a LanguageModelChatMessage — handles multiple API shapes. */
function userMessage(content: string): any {
  const Msg = (vscode as any).LanguageModelChatMessage;
  if (Msg) {
    // VS Code 1.93+: static User() method
    if (typeof Msg.User === 'function') return Msg.User(content);
    // Older API: .from(role, content)
    if (typeof Msg.from === 'function') return Msg.from('user', content);
    // Constructor: new LanguageModelChatMessage(role, content)
    const Role = (vscode as any).LanguageModelChatMessageRole;
    if (Role) return new Msg(Role.User, content);
  }
  return { role: 'user', content };
}

/**
 * Collect the full text from a LanguageModelChatResponse.
 * In the current API, resp.text is an AsyncIterable<string>, NOT a plain string.
 */
async function collectText(resp: any): Promise<string> {
  if (!resp) return '';

  // Current API (1.90+): resp.text is AsyncIterable<string>
  const t = resp.text;
  if (t && typeof t !== 'string' && typeof t[Symbol.asyncIterator] === 'function') {
    let out = '';
    for await (const chunk of t) {
      if (typeof chunk === 'string') {
        out += chunk;
      } else if (chunk && typeof chunk === 'object') {
        // Some shapes: { value }, { text }, { content }
        out += (chunk as any).value ?? (chunk as any).text ?? (chunk as any).content ?? '';
      } else {
        out += String(chunk ?? '');
      }
    }
    return out;
  }

  // Older API: resp.text is a plain string
  if (typeof t === 'string') return t;

  // Fallback: resp.stream (some early versions)
  if (resp.stream && typeof resp.stream[Symbol.asyncIterator] === 'function') {
    let out = '';
    for await (const part of resp.stream) {
      if (typeof part === 'string') out += part;
      else out += part?.value ?? part?.text ?? '';
    }
    return out;
  }

  return '';
}

/** Send system + user prompt to the LM and collect the full text response. */
async function askLm(system: string, user: string): Promise<string> {
  const model = await pickModel();
  const messages = [userMessage(user)];
  const cancellation = new (vscode as any).CancellationTokenSource();

  let resp: any;
  try {
    // Preferred: pass system prompt via options (1.93+)
    resp = await model.sendRequest(messages, { systemPrompt: system }, cancellation.token);
  } catch {
    // Fallback: embed system prompt into the user message
    const combined = system + '\n\n---\n\nUser message:\n' + user;
    resp = await model.sendRequest([userMessage(combined)], {}, cancellation.token);
  }

  return await collectText(resp);
}

/** Ask the LM and parse the first JSON object found in its response. */
async function askLmJson(system: string, user: string): Promise<any> {
  const raw = await askLm(system, user);
  if (!raw || !raw.trim()) {
    throw new Error('LM returned an empty response.');
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`LM did not return valid JSON. Raw response:\n${raw.slice(0, 500)}`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e: any) {
    throw new Error(`LM returned malformed JSON: ${e?.message}. Raw:\n${raw.slice(0, 500)}`);
  }
}

// ============================================================
// Intent Classification — Chain-of-Thought via LM
// ============================================================

type Intent =
  | 'READ_ISSUE'
  | 'CREATE_ISSUE'
  | 'IMPLEMENT'
  | 'ANALYZE_PROJECT'
  | 'ANALYZE_DYNAMIC'
  | 'EXTRACT_DATA'
  | 'PUSH';

interface ClassifiedIntent {
  intent: Intent;
  params: Record<string, any>;
}

const CLASSIFY_SYSTEM = `You are an intent classifier for a VS Code agent called @sg.
Given the user message, classify it into EXACTLY one intent and extract parameters.
Return ONLY valid JSON — no markdown, no explanation.

{
  "intent": "<one of READ_ISSUE | CREATE_ISSUE | IMPLEMENT | ANALYZE_PROJECT | ANALYZE_DYNAMIC | EXTRACT_DATA | PUSH>",
  "params": { ... }
}

READ_ISSUE — read/explain a Jira ticket
  params: { "issueKey": "PROJ-123" }

CREATE_ISSUE — create a new ticket
  params: { "project": "PROJ", "summary": "title", "description": "details", "issueType": "Story" }

IMPLEMENT — generate code from a ticket, commit; push/PR only if user explicitly asks
  params: { "issueKey": "PROJ-123", "push": false, "createPr": false }

ANALYZE_PROJECT — project metrics / analytics
  params: { "project": "PROJ", "days": 15 }

ANALYZE_DYNAMIC — dynamic analysis driven by a natural language filter
  params: {
    "project": "PROJ",
    "query": "natural language filter and report preferences",
    "days": 14,
    "refine": false
  }

EXTRACT_DATA — list/export tickets
  params: { "project": "PROJ", "jql": "", "format": "markdown" }
  Examples:
  - "list all issues from EQC where component = RustRunner"
    => intent=EXTRACT_DATA, params.project="EQC", params.jql="project = EQC AND component = \\"RustRunner\\" ORDER BY updated DESC"
  - "get all EQC tickets assigned to Alice updated in last 7 days"
    => intent=EXTRACT_DATA with an appropriate JQL filter

PUSH — push an already-committed branch and optionally create a PR
  params: { "issueKey": "PROJ-123" }

Rules:
- Default push and createPr to false unless the user explicitly says "push" or "PR".
- NEVER classify as PUSH for French "projet" (project) — that is not a pull request.
- If the user asks to analyze / report / dashboard / epic filter / metrics, prefer ANALYZE_DYNAMIC or ANALYZE_PROJECT over PUSH or READ_ISSUE.
- If the user says "don't push" or "commit only", set push=false.
- Extract project keys and issue keys accurately.
- days defaults to 14 if the user doesn't specify.`;

type DynamicGroupBy = 'assignee' | 'status' | 'component' | 'issuetype' | 'none';

type DynamicFilterSpec = {
  project: string;
  days?: number;
  updatedFromJql?: string; // e.g. startOfYear() or "2026-01-01"
  jql: string;
  groupBy: DynamicGroupBy;
  topN: number;
  title: string;
};

let lastDynamicSpec: DynamicFilterSpec | undefined;

type ReportAudience = 'delivery_manager' | 'business_analyst' | 'project_manager' | 'sprint_review';
type ReportTone = 'executive' | 'detailed';
type ReportSection = 'exec_summary' | 'delivery' | 'scope' | 'risks' | 'quality' | 'people' | 'charts' | 'raw';
type ReportChart =
  | 'status_pie'
  | 'assignee_bar'
  | 'component_bar'
  | 'issuetype_bar'
  | 'aging_bar'
  | 'done_vs_notdone';

type ReportSpec = {
  audience: ReportAudience;
  tone: ReportTone;
  sections: ReportSection[];
  charts: ReportChart[];
  groupBy: DynamicGroupBy;
  topN: number;
  thresholds: { staleDays: number; agingDays: number };
  title?: string;
};

let lastReportSpec: ReportSpec | undefined;

type ExtractCache = {
  jql: string;
  total: number;
  fetchedAt: number;
  issues: any[];
};

let lastExtractCache: ExtractCache | undefined;
let pendingLargeFetch: { spec: DynamicFilterSpec; reportSpec: ReportSpec; total: number } | undefined;

function escapeJqlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeGroupBy(v: any): DynamicGroupBy {
  const s = String(v ?? '').toLowerCase();
  if (s === 'assignee' || s === 'status' || s === 'component' || s === 'issuetype' || s === 'none') return s;
  return 'assignee';
}

function normalizeAudience(v: any): ReportAudience {
  const s = String(v ?? '').toLowerCase().replace(/\s+/g, '_');
  if (s === 'delivery_manager' || s === 'business_analyst' || s === 'project_manager' || s === 'sprint_review') return s;
  if (s.includes('delivery')) return 'delivery_manager';
  if (s.includes('business')) return 'business_analyst';
  if (s.includes('project') || s.includes('chef')) return 'project_manager';
  if (s.includes('sprint') || s.includes('review')) return 'sprint_review';
  return 'delivery_manager';
}

function normalizeTone(v: any): ReportTone {
  const s = String(v ?? '').toLowerCase();
  return s === 'detailed' ? 'detailed' : 'executive';
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function uniqSections(xs: ReportSection[]): ReportSection[] {
  return uniq(xs) as ReportSection[];
}

function clampInt(n: any, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function defaultReportSpec(audience: ReportAudience): ReportSpec {
  if (audience === 'sprint_review') {
    return {
      audience,
      tone: 'executive',
      sections: ['exec_summary', 'delivery', 'scope', 'risks', 'charts'],
      charts: ['done_vs_notdone', 'status_pie', 'component_bar', 'assignee_bar', 'aging_bar'],
      groupBy: 'component',
      topN: 10,
      thresholds: { staleDays: 5, agingDays: 7 }
    };
  }
  if (audience === 'business_analyst') {
    return {
      audience,
      tone: 'executive',
      sections: ['exec_summary', 'delivery', 'scope', 'charts', 'raw'],
      charts: ['done_vs_notdone', 'status_pie', 'component_bar', 'issuetype_bar'],
      groupBy: 'issuetype',
      topN: 10,
      thresholds: { staleDays: 7, agingDays: 10 }
    };
  }
  if (audience === 'project_manager') {
    return {
      audience,
      tone: 'executive',
      sections: ['exec_summary', 'delivery', 'risks', 'quality', 'charts'],
      charts: ['done_vs_notdone', 'status_pie', 'assignee_bar', 'component_bar', 'aging_bar'],
      groupBy: 'assignee',
      topN: 10,
      thresholds: { staleDays: 5, agingDays: 7 }
    };
  }
  return {
    audience: 'delivery_manager',
    tone: 'executive',
    sections: ['exec_summary', 'delivery', 'risks', 'quality', 'people', 'charts'],
    charts: ['done_vs_notdone', 'status_pie', 'assignee_bar', 'component_bar', 'aging_bar'],
    groupBy: 'assignee',
    topN: 10,
    thresholds: { staleDays: 5, agingDays: 7 }
  };
}

function normalizeSections(v: any, fallback: ReportSection[]): ReportSection[] {
  const allowed: ReportSection[] = ['exec_summary', 'delivery', 'scope', 'risks', 'quality', 'people', 'charts', 'raw'];
  const arr = Array.isArray(v) ? v : [];
  const out = arr
    .map(x => String(x ?? '').toLowerCase())
    .filter(x => allowed.includes(x as any)) as ReportSection[];
  return out.length ? uniq(out) : fallback;
}

function normalizeCharts(v: any, fallback: ReportChart[]): ReportChart[] {
  const allowed: ReportChart[] = ['status_pie', 'assignee_bar', 'component_bar', 'issuetype_bar', 'aging_bar', 'done_vs_notdone'];
  const arr = Array.isArray(v) ? v : [];
  const out = arr
    .map(x => String(x ?? '').toLowerCase())
    .filter(x => allowed.includes(x as any)) as ReportChart[];
  return out.length ? uniq(out) : fallback;
}

function buildDynamicJql(spec: {
  project: string;
  days?: number;
  updatedFromJql?: string;
  component?: string;
  assignee?: string;
  status?: string;
  issueType?: string;
  text?: string;
  epicKey?: string;
  jql?: string;
}): string {
  const parts: string[] = [];
  const proj = spec.project.toUpperCase();
  parts.push(`project = ${proj}`);

  if (spec.updatedFromJql && spec.updatedFromJql.trim()) {
    // Allow Jira functions like startOfYear() or an explicit date string.
    const v = spec.updatedFromJql.trim();
    const isFunc = /^[a-zA-Z_]+\(\)\s*$/.test(v);
    const isQuoted = /^".*"$/.test(v);
    const rhs = isFunc || isQuoted ? v : `"${escapeJqlString(v)}"`;
    parts.push(`updated >= ${rhs}`);
  } else {
    const d = Math.max(1, Math.min(365, Number(spec.days) || 14));
    parts.push(`updatedDate >= -${d}d`);
  }

  if (spec.component) parts.push(`component = "${escapeJqlString(spec.component)}"`);
  if (spec.assignee) parts.push(`assignee = "${escapeJqlString(spec.assignee)}"`);
  if (spec.status) parts.push(`status = "${escapeJqlString(spec.status)}"`);
  if (spec.issueType) parts.push(`issuetype = "${escapeJqlString(spec.issueType)}"`);
  if (spec.text) parts.push(`text ~ "${escapeJqlString(spec.text)}"`);
  if (spec.epicKey) {
    const k = spec.epicKey.toUpperCase();
    // Jira instances differ: some use "Epic Link", others use parentEpic.
    parts.push(`("Epic Link" = ${k} OR parentEpic = ${k})`);
  }

  const extra = (spec.jql ?? '').trim();
  const base = parts.join(' AND ');
  const combined = extra ? `(${base}) AND (${extra})` : base;
  return `${combined} ORDER BY updated DESC`;
}

async function buildDynamicFilterSpec(project: string, query: string, days: number): Promise<DynamicFilterSpec> {
  const system = [
    'You convert a natural-language analytics request into a Jira filter specification.',
    'Return ONLY valid JSON. No markdown.',
    '',
    'Schema:',
    '{',
    '  "days": 14,',
    '  "updatedFromJql": "",',
    '  "component": "",',
    '  "assignee": "",',
    '  "status": "",',
    '  "issueType": "",',
    '  "epicKey": "",',
    '  "text": "",',
    '  "extraJql": "",',
    '  "groupBy": "assignee",',
    '  "topN": 10,',
    '  "title": ""',
    '}',
    '',
    'Rules:',
    '- Prefer simple fields (component/assignee/status/issueType/text) over raw JQL.',
    '- Use epicKey when user asks for an Epic filter (e.g. "under epic EQC-123").',
    '- If user says "since start of year"/"depuis le début de l\'année", set updatedFromJql to startOfYear().',
    '- extraJql should avoid repeating project constraints; time constraints are OK if needed.',
    '- groupBy must be one of: assignee, status, component, issuetype, none.',
    '- If the user asks for "top performers", use groupBy=assignee.',
    '- If the user asks for "distribution by status", use groupBy=status.',
    '- Keep title short.'
  ].join('\n');

  const user = [
    `Project: ${project}`,
    `Default days: ${days}`,
    `User request: ${query}`
  ].join('\n');

  const parsed = await askLmJson(system, user);
  const d = Math.max(1, Math.min(365, Number(parsed?.days ?? days) || days || 14));
  const groupBy = normalizeGroupBy(parsed?.groupBy);
  const topN = Math.max(3, Math.min(25, Number(parsed?.topN ?? 10) || 10));
  const title = String(parsed?.title ?? '').trim() || `${project} — analyse dynamique`;

  const epicKeyRaw = String(parsed?.epicKey ?? '').trim();
  const epicKey = epicKeyRaw && /[A-Z][A-Z0-9]+-\d+/.test(epicKeyRaw) ? epicKeyRaw.toUpperCase() : undefined;
  const updatedFromJql = String(parsed?.updatedFromJql ?? '').trim() || undefined;

  const jql = buildDynamicJql({
    project,
    days: d,
    updatedFromJql,
    component: (parsed?.component ?? '').toString().trim() || undefined,
    assignee: (parsed?.assignee ?? '').toString().trim() || undefined,
    status: (parsed?.status ?? '').toString().trim() || undefined,
    issueType: (parsed?.issueType ?? '').toString().trim() || undefined,
    epicKey,
    text: (parsed?.text ?? '').toString().trim() || undefined,
    jql: (parsed?.extraJql ?? '').toString().trim() || undefined
  });

  return { project: project.toUpperCase(), days: d, updatedFromJql, jql, groupBy, topN, title };
}

async function buildReportSpec(
  query: string,
  defaults: { audience: ReportAudience; groupBy: DynamicGroupBy; topN: number }
): Promise<ReportSpec> {
  const system = [
    'You generate a report specification for a Jira analytics dashboard.',
    'Audience: delivery manager / project manager / business analyst / sprint review.',
    'Return ONLY valid JSON. No markdown.',
    '',
    'Schema:',
    '{',
    '  "audience": "delivery_manager",',
    '  "tone": "executive",',
    '  "sections": ["exec_summary","delivery","risks","quality","people","charts"],',
    '  "charts": ["done_vs_notdone","status_pie","assignee_bar","component_bar","aging_bar"],',
    '  "groupBy": "assignee",',
    '  "topN": 10,',
    '  "thresholds": { "staleDays": 5, "agingDays": 7 },',
    '  "title": ""',
    '}',
    '',
    'Rules:',
    '- If user does not specify an audience, keep audience=delivery_manager.',
    '- Always include sections exec_summary and charts for delivery_manager.',
    '- Prefer executive tone unless the user asks for details.',
    '- For sprint review, include scope + delivery sections.',
    '- Thresholds must be reasonable: staleDays 3-14, agingDays 5-21.'
  ].join('\n');

  const user = [
    `User request: ${query}`,
    `Default audience: ${defaults.audience}`,
    `Default groupBy: ${defaults.groupBy}`,
    `Default topN: ${defaults.topN}`
  ].join('\n');

  const parsed = await askLmJson(system, user);
  const audience = normalizeAudience(parsed?.audience ?? defaults.audience);
  const preset = defaultReportSpec(audience);

  const tone = normalizeTone(parsed?.tone ?? preset.tone);
  const groupBy = normalizeGroupBy(parsed?.groupBy ?? defaults.groupBy ?? preset.groupBy);
  const topN = clampInt(parsed?.topN ?? defaults.topN ?? preset.topN, 3, 25, preset.topN);
  const thresholds = {
    staleDays: clampInt(parsed?.thresholds?.staleDays ?? preset.thresholds.staleDays, 3, 14, preset.thresholds.staleDays),
    agingDays: clampInt(parsed?.thresholds?.agingDays ?? preset.thresholds.agingDays, 5, 21, preset.thresholds.agingDays)
  };
  const sections = normalizeSections(parsed?.sections, preset.sections);
  const charts = normalizeCharts(parsed?.charts, preset.charts);
  const title = String(parsed?.title ?? '').trim() || undefined;

  const ensuredSections =
    audience === 'delivery_manager'
      ? uniqSections(['exec_summary', ...sections, 'charts'])
      : sections;

  return { audience, tone, sections: ensuredSections, charts, groupBy, topN, thresholds, title };
}

function looksLikeAnalyzeIntent(text: string): boolean {
  return (
    /\b(analy(s|z)e|analyse|rapport|report|metrics|dashboard|velocity|v[ée]locit[ée]|performer|top|filtre|filter|p[ée]riode|insights|insight|kpi)\b/i.test(
      text
    ) ||
    /\b(epic|project)\s*=/i.test(text) ||
    /\bjiras?\s+(pour|dans|du|sous|avec)\b/i.test(text) ||
    /\b(epic|tickets?)\s+(sous|du|de)\b/i.test(text)
  );
}

/** True only for explicit git push / PR intent — NOT French "projet" (contains substring "pr"). */
function wantsPushIntent(text: string): boolean {
  const t = text.toLowerCase();
  if (looksLikeAnalyzeIntent(text)) return false;
  if (/\b(analy(s|z)e|analyse|implement)\b/i.test(t)) return false;
  if (/\bpush\b/.test(t) && /\b(git|origin|remote|branch)\b/.test(t)) return true;
  if (/\bpull request\b/.test(t) || /\bmerge request\b/.test(t)) return true;
  if (/\bpr\s*#/.test(t)) return true;
  if (/\bpousser\b/.test(t) && /\b(git|branche)\b/.test(t)) return true;
  return false;
}

function extractProjectKeyFromText(text: string): string | undefined {
  const pq = text.match(/\bproject\s*=\s*([A-Z][A-Z0-9]{1,9})\b/i);
  if (pq) return pq[1].toUpperCase();
  const m = text.match(/\b(?:projet|project)\s+([A-Z][A-Z0-9]{1,9})\b/i);
  if (m) return m[1].toUpperCase();
  const words = text.match(/\b([A-Z][A-Z0-9]{1,9})\b/g) ?? [];
  const skip = new Set([
    'JIRA',
    'FOR',
    'THE',
    'AND',
    'ALL',
    'DAYS',
    'DAY',
    'LAST',
    'TOP',
    'SG',
    'CSV',
    'HTML',
    'JSON',
    'API',
    'SQL'
  ]);
  for (const w of words) {
    if (!skip.has(w) && w.length >= 2 && w.length <= 10) return w;
  }
  return undefined;
}

function extractDaysFromText(text: string, fallback: number): number {
  const m = text.match(/\b(\d+)\s*(day|days|d|jour|jours)\b/i);
  return m ? Number(m[1]) : fallback;
}

function classifyIntentHeuristic(userText: string): ClassifiedIntent {
  const text = userText.trim();
  const issueKey = text.match(JIRA_KEY_RE)?.[0];

  // If user explicitly references a Jira key, prefer analysis when the message is clearly analytics.
  if (issueKey) {
    const t = text.toLowerCase();
    if (looksLikeAnalyzeIntent(text)) {
      const project = extractProjectKeyFromText(text) ?? issueKey.split('-')[0];
      const days = extractDaysFromText(text, 14);
      return { intent: 'ANALYZE_DYNAMIC', params: { project, days, query: text, refine: false } };
    }
    if (t.includes('implement')) return { intent: 'IMPLEMENT', params: { issueKey, push: false, createPr: false } };
    if (wantsPushIntent(text)) return { intent: 'PUSH', params: { issueKey } };
    return { intent: 'READ_ISSUE', params: { issueKey } };
  }

  const project = extractProjectKeyFromText(text) ?? (text.match(/\b([A-Z][A-Z0-9]{1,9})\b/) ?? [])[1]; // best-effort

  const looksLikeExport =
    /\b(export|extract|list|get all|all (the )?(jiras|jira|issues|tickets))\b/i.test(text) ||
    /\bproject\s*=\s*[A-Z][A-Z0-9]+\b/i.test(text) ||
    /\bjql\b/i.test(text) ||
    /\bcomponent\b/i.test(text);

  const looksLikeAnalyze =
    /\b(analy(s|z)e|analyse|metrics|report|throughput|velocity|v[ée]locit[ée]|backlog|stability)\b/i.test(text);

  const looksLikeDynamicAnalyze =
    looksLikeAnalyze && /\b(component|assignee|status|issuetype|type|filter|top|performer|distribution|breakdown|group|epic|pod|depuis|d[ée]but|ann[ée]e)\b/i.test(text);

  if (looksLikeExport && project) {
    // If component filter is present, build a minimal safe JQL from it.
    const compMatch = text.match(/\bcomponent\s*=\s*("?)([^"\n]+)\1/i);
    const component = compMatch?.[2]?.trim();
    const jql = component
      ? `project = ${project} AND component = "${component.replace(/"/g, '\\"')}" ORDER BY updated DESC`
      : `project = ${project} ORDER BY updated DESC`;
    return { intent: 'EXTRACT_DATA', params: { project, jql, format: 'markdown' } };
  }

  if (looksLikeAnalyze && project) {
    const days = extractDaysFromText(text, 14);
    if (looksLikeDynamicAnalyze) {
      return { intent: 'ANALYZE_DYNAMIC', params: { project, days, query: text, refine: false } };
    }
    return { intent: 'ANALYZE_PROJECT', params: { project, days } };
  }

  // Default fallback: EXTRACT_DATA if a project is present; otherwise READ_ISSUE (will prompt for key).
  if (project) return { intent: 'EXTRACT_DATA', params: { project, jql: `project = ${project} ORDER BY updated DESC`, format: 'markdown' } };
  return { intent: 'READ_ISSUE', params: {} };
}

async function classifyIntent(userMessage: string): Promise<ClassifiedIntent> {
  try {
    const json = await askLmJson(CLASSIFY_SYSTEM, userMessage);
    const intent = (json.intent ?? 'READ_ISSUE') as Intent;
    const params = json.params ?? {};
    if (intent === 'PUSH' && !wantsPushIntent(userMessage)) {
      return classifyIntentHeuristic(userMessage);
    }
    if ((intent === 'PUSH' || intent === 'READ_ISSUE') && looksLikeAnalyzeIntent(userMessage)) {
      return classifyIntentHeuristic(userMessage);
    }
    return { intent, params };
  } catch {
    return classifyIntentHeuristic(userMessage);
  }
}

// ============================================================
// Streaming helpers — write plan / progress to chat
// ============================================================

function streamPlan(stream: any, steps: string[]): void {
  stream.markdown('**Plan:**\n');
  steps.forEach((s, i) => stream.markdown(`${i + 1}. ${s}\n`));
  stream.markdown('\n---\n\n');
}

// ============================================================
// MODE: READ_ISSUE
// ============================================================

async function handleReadIssue(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  const key = params.issueKey;
  if (!key) { stream.markdown('Provide a Jira key (e.g., PROJ-123).'); return; }

  streamPlan(stream, [
    `Fetch ticket **${key}** from Jira`,
    'Summarize and explain the ticket with AI'
  ]);

  const jira = new JiraClient(cfg());
  stream.markdown(`Fetching **${key}**…\n\n`);
  const issue = await jira.getIssue(key);

  // Ask the LM to produce a clear explanation
  const explanation = await askLm(
    'You summarize Jira tickets clearly in Markdown.',
    `Ticket: ${issue.key}\nSummary: ${issue.summary}\nStatus: ${issue.status}\nAssignee: ${issue.assignee}\nDescription:\n${issue.descriptionText || '(empty)'}\n\nExplain what this ticket is about and what needs to be done.`
  );

  const jiraUrl = cfg().get<string>('jira.url')?.replace(/\/+$/, '');
  const link = jiraUrl ? `[${issue.key}](${jiraUrl}/browse/${issue.key})` : issue.key;

  stream.markdown(`### ${link}: ${issue.summary}\n\n`);
  stream.markdown(`**Status:** ${issue.status} · **Assignee:** ${issue.assignee}\n\n`);
  stream.markdown(explanation + '\n');
}

// ============================================================
// MODE: CREATE_ISSUE
// ============================================================

async function handleCreateIssue(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  const project = params.project;
  const summary = params.summary;
  if (!project || !summary) {
    stream.markdown('I need at least a **project key** and a **summary** to create a ticket.');
    return;
  }

  streamPlan(stream, [
    `Create a **${params.issueType || 'Story'}** on project **${project}**`,
    `Title: "${summary}"`
  ]);

  const jira = new JiraClient(cfg());
  const result = await jira.createIssue({
    project,
    summary,
    description: params.description || '',
    issueType: params.issueType || 'Story'
  });

  const jiraUrl = cfg().get<string>('jira.url')?.replace(/\/+$/, '');
  const link = jiraUrl ? `[${result.key}](${jiraUrl}/browse/${result.key})` : result.key;
  stream.markdown(`Ticket created: ${link}\n`);
}

// ============================================================
// MODE: IMPLEMENT — generate code, commit, optionally push+PR
// ============================================================

async function handleImplement(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  const key = params.issueKey;
  if (!key) { stream.markdown('Provide a Jira key (e.g., PROJ-123).'); return; }

  const wantPush = !!params.push;
  const wantPr = !!params.createPr;

  const steps = [
    `Fetch ticket **${key}** from Jira`,
    'Analyze and generate code changes via Copilot',
    'Apply edits to workspace files',
    `Create branch \`feature/${key}\` and commit`
  ];
  if (wantPush) steps.push('Push to remote');
  if (wantPr) steps.push('Create Pull Request on GitHub');
  if (!wantPush) steps.push('_Push skipped — type `@sg push ' + key + '` when ready_');

  streamPlan(stream, steps);

  // 1 — Fetch ticket
  const jira = new JiraClient(cfg());
  stream.markdown(`Fetching **${key}**…\n\n`);
  const issue = await jira.getIssue(key);

  // 2 — Generate edits via LM
  stream.markdown('Generating code changes…\n\n');
  const edits = await generateEdits(issue);
  stream.markdown(`Generated **${edits.length}** file edit(s).\n\n`);

  // 3 — Apply
  await applyFileEdits(edits);
  stream.markdown('Edits applied to workspace.\n\n');

  // 4 — Git: branch + commit
  const git = new GitService();
  const baseBranch = git.currentBranch();
  const branch = `feature/${issue.key}`;

  try {
    await git.createBranchAndCheckout(branch);
  } catch {
    // Branch may already exist — try checkout
    try {
      const repo = (git as any).repo;
      await repo.checkout(branch);
    } catch (e2: any) {
      throw new Error(`Git: cannot create or checkout branch ${branch}: ${e2?.message}`);
    }
  }

  await git.stageAll();
  await git.commit(`${issue.key}: ${issue.summary}`.slice(0, 72));
  stream.markdown(`Committed on \`${branch}\`.\n\n`);

  // 5 — Push + PR (only if requested)
  if (wantPush) {
    await doPushAndPr(git, issue, baseBranch, wantPr, stream);
  } else {
    stream.markdown(`Push skipped. When ready, type: \`@sg push ${issue.key}\`\n`);
  }
}

/** Reusable: push current branch + optionally create PR. */
async function doPushAndPr(
  git: GitService,
  issue: { key: string; summary: string },
  baseBranch: string,
  createPr: boolean,
  stream: any
): Promise<void> {
  const branch = `feature/${issue.key}`;
  stream.markdown('Pushing…\n\n');
  await git.push(branch);
  stream.markdown(`Pushed \`${branch}\` to origin.\n\n`);

  if (createPr) {
    const c = cfg();
    const gh = new GitHubClient(c);
    const remoteUrl = git.originRemoteUrl();
    const jiraUrl = c.get<string>('jira.url')?.replace(/\/+$/, '');
    const jiraLink = jiraUrl ? `${jiraUrl}/browse/${issue.key}` : issue.key;

    const pr = await gh.createPullRequest({
      remoteUrl,
      head: branch,
      base: baseBranch || 'main',
      title: `${issue.key}: ${issue.summary}`,
      body: `Jira: ${jiraLink}\n\nSummary:\n- ${issue.summary}\n`
    });

    stream.markdown(`PR created: [#${pr.number}](${pr.url})\n`);
  }
}

/** Ask the LM to produce file edits as JSON. */
async function generateEdits(issue: { key: string; summary: string; descriptionText: string }): Promise<FileEdit[]> {
  const system = [
    'You are a code-editing agent running inside VS Code.',
    'Goal: implement the Jira ticket in the current workspace.',
    'Constraints:',
    '- Output ONLY valid JSON (no markdown fences).',
    '- Schema: {"edits":[{"path":"relative/path","content":"full file content"}]}',
    '- path is relative to workspace root.',
    '- content is the FULL content of the file (rewrite).',
    '- Minimal changes necessary.',
    '- Never include secrets/tokens.'
  ].join('\n');

  const user = [
    `Ticket: ${issue.key}`,
    `Summary: ${issue.summary}`,
    `Description:\n${issue.descriptionText || '(empty)'}`,
    '',
    'Return the JSON now.'
  ].join('\n');

  const parsed = await askLmJson(system, user);
  if (!Array.isArray(parsed?.edits)) {
    throw new Error("LM response missing 'edits' array.");
  }
  return parsed.edits as FileEdit[];
}

// ============================================================
// MODE: PUSH — push a previously committed branch + PR
// ============================================================

async function handlePush(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  const key = params.issueKey;
  if (!key) { stream.markdown('Provide a Jira key (e.g., PROJ-123).'); return; }

  streamPlan(stream, [
    `Push branch \`feature/${key}\` to origin`,
    'Create a Pull Request on GitHub'
  ]);

  const git = new GitService();
  const baseBranch = git.currentBranch() === `feature/${key}` ? 'main' : git.currentBranch();
  await doPushAndPr(git, { key, summary: key }, baseBranch, true, stream);
}

// ============================================================
// MODE: ANALYZE_PROJECT
// ============================================================

async function handleAnalyzeProject(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  const project = params.project;
  const days = params.days ?? 14;
  if (!project) { stream.markdown('Provide a project key (e.g., EQC).'); return; }

  streamPlan(stream, [
    `Search all **${project}** issues updated in the last **${days}** days`,
    'Compute velocity, backlog health, stability index, team flow',
    'Generate AI insights'
  ]);

  stream.markdown('Fetching data from Jira…\n\n');
  const jira = new JiraClient(cfg());
  const m: ProjectMetrics = await computeProjectMetrics(jira, project, days);

  // Format results
  stream.markdown(`## ${project} — Last ${days} days\n\n`);

  stream.markdown(`### Velocity & Throughput\n`);
  stream.markdown(`- Tickets completed: **${m.velocity.completedCount}**\n`);
  stream.markdown(`- Story points delivered: **${m.velocity.totalStoryPoints}**\n\n`);

  stream.markdown(`### Backlog Health\n`);
  stream.markdown(`- Total issues touched: **${m.backlogHealth.total}**\n`);
  stream.markdown(`- Without description: **${m.backlogHealth.withoutDescription}**\n`);
  stream.markdown(`- Health score: **${m.backlogHealth.healthPercent}%**\n\n`);

  stream.markdown(`### Stability Index\n`);
  stream.markdown(`- Completed: **${m.stabilityIndex.completed}** · Reopened: **${m.stabilityIndex.reopened}**\n`);
  stream.markdown(`- Reopen rate: **${m.stabilityIndex.ratio}%**\n\n`);

  stream.markdown(`### Team Flow — Blocked (> 5 days without update)\n`);
  if (!m.teamFlow.blocked.length) {
    stream.markdown('No blocked tickets.\n\n');
  } else {
    for (const b of m.teamFlow.blocked) {
      stream.markdown(`- **${b.key}** (${b.status}, ${b.daysStuck}d): ${b.summary}\n`);
    }
    stream.markdown('\n');
  }

  // AI insights
  stream.markdown('### AI Insights\n\n');
  const insightsPrompt = JSON.stringify(m);
  const insights = await askLm(
    'You are a senior agile coach. Given project metrics in JSON, provide 2 actionable improvement suggestions for the next sprint. Be concise.',
    insightsPrompt
  );
  stream.markdown(insights + '\n');
}

// ============================================================
// MODE: ANALYZE_DYNAMIC
// ============================================================

function topCounts(items: string[], topN: number): Array<{ name: string; count: number }> {
  const m = new Map<string, number>();
  for (const raw of items) {
    const k = (raw ?? '').toString().trim() || 'Unknown';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, count]) => ({ name, count }));
}

function mermaidPie(title: string, rows: Array<{ name: string; count: number }>): string {
  const safeTitle = title.replace(/"/g, "'");
  const lines = rows.map(r => `  "${r.name.replace(/"/g, "'")}" : ${r.count}`);
  return ['```mermaid', `pie title ${safeTitle}`, ...lines, '```', ''].join('\n');
}

function mermaidBar(title: string, rows: Array<{ name: string; count: number }>): string {
  const labels = rows.map(r => r.name.replace(/\s+/g, ' ').trim());
  const values = rows.map(r => r.count);
  const safeTitle = title.replace(/"/g, "'");
  return [
    '```mermaid',
    'xychart-beta',
    `  title "${safeTitle}"`,
    '  x-axis [' + labels.map(l => `"${l.replace(/"/g, "'")}"`).join(', ') + ']',
    '  y-axis "Count" 0 --> ' + Math.max(1, ...values),
    '  bar [' + values.join(', ') + ']',
    '```',
    ''
  ].join('\n');
}

function daysBetween(fromIso: string, toMs: number): number {
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((toMs - t) / (24 * 60 * 60 * 1000)));
}

function mermaidDoneVsNotDone(project: string, done: number, notDone: number): string {
  return [
    '```mermaid',
    'xychart-beta',
    `  title "${project.replace(/"/g, "'")} — Done vs Not Done"`,
    '  x-axis ["Done","Not Done"]',
    '  y-axis "Count" 0 --> ' + Math.max(1, done, notDone),
    `  bar [${done}, ${notDone}]`,
    '```',
    ''
  ].join('\n');
}

function mermaidAgingHistogram(project: string, buckets: Array<{ label: string; count: number }>): string {
  const labels = buckets.map(b => b.label);
  const values = buckets.map(b => b.count);
  return [
    '```mermaid',
    'xychart-beta',
    `  title "${project.replace(/"/g, "'")} — WIP aging (days since update)"`,
    '  x-axis [' + labels.map(l => `"${l.replace(/"/g, "'")}"`).join(', ') + ']',
    '  y-axis "Count" 0 --> ' + Math.max(1, ...values),
    '  bar [' + values.join(', ') + ']',
    '```',
    ''
  ].join('\n');
}

function computeVelocityFromIssues(issues: any[]): { completedCount: number; totalStoryPoints: number } {
  const completed = issues.filter((i: any) => isIssueDone(i));
  const totalSP = completed.reduce((sum: number, i: any) => sum + (Number(i?.storyPoints ?? 0) || 0), 0);
  return { completedCount: completed.length, totalStoryPoints: totalSP };
}

async function handleAnalyzeDynamic(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  let project = String(params.project ?? '').trim();
  const days = Number(params.days ?? 14) || 14;
  const query = String(params.query ?? '').trim();
  const refine = !!params.refine;
  const confirm = !!params.confirm;

  if (!project && confirm && pendingLargeFetch) {
    project = pendingLargeFetch.spec.project;
  }
  if (!project) {
    stream.markdown('Provide a project key (e.g., EQC).');
    return;
  }

  const baseQuery = query || `Analyze ${project} dynamically over last ${days} days`;
  let reportSpec: ReportSpec;
  try {
    reportSpec = await buildReportSpec(baseQuery, { audience: 'delivery_manager', groupBy: 'assignee', topN: 10 });
  } catch {
    reportSpec = defaultReportSpec('delivery_manager');
  }

  streamPlan(stream, [
    `Build a dynamic filter for **${project.toUpperCase()}** (audience: **${reportSpec.audience}**)`,
    'Fetch matching issues from Jira',
    'Generate an executive-friendly report + dashboards'
  ]);

  let spec: DynamicFilterSpec;
  try {
    const base = await buildDynamicFilterSpec(project, baseQuery, days);
    if (refine && lastDynamicSpec && lastDynamicSpec.project === project.toUpperCase()) {
      // Simple refine strategy: keep previous JQL and add the new constraints
      spec = { ...base, jql: `(${lastDynamicSpec.jql.replace(/\s+ORDER BY updated DESC\s*$/i, '')}) AND (${base.jql.replace(/\s+ORDER BY updated DESC\s*$/i, '')}) ORDER BY updated DESC` };
    } else {
      spec = base;
    }
  } catch (e: any) {
    stream.markdown(`Filter generation failed, falling back to a basic query.\n\n`);
    spec = {
      project: project.toUpperCase(),
      days,
      jql: buildDynamicJql({ project, days }),
      groupBy: reportSpec.groupBy,
      topN: reportSpec.topN,
      title: `${project.toUpperCase()} — analyse dynamique`
    };
  }

  // Restore last large query when user only sends "confirm" (same JQL as pending).
  if (confirm && pendingLargeFetch && !query) {
    spec = pendingLargeFetch.spec;
    reportSpec = pendingLargeFetch.reportSpec;
  }

  lastDynamicSpec = spec;
  lastReportSpec = reportSpec;

  const title = reportSpec.title || spec.title;
  stream.markdown(`## ${title}\n\n`);
  stream.markdown(`**JQL:** \`${spec.jql}\`\n\n`);

  const jira = new JiraClient(cfg());
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const fetchNow = Date.now();

  // Cache first (market practice): avoid duplicate count/fetch for same JQL within TTL.
  let issues: any[];
  if (lastExtractCache && lastExtractCache.jql === spec.jql && fetchNow - lastExtractCache.fetchedAt < CACHE_TTL_MS) {
    issues = lastExtractCache.issues;
    stream.markdown(
      `**${lastExtractCache.total}** issue(s) in scope (reusing cache: **${issues.length}** fetched).\n\n`
    );
  } else {
    let total = 0;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SGA · Jira',
        cancellable: false
      },
      async progress => {
        progress.report({ message: 'Counting issues…' });
        total = await jira.countIssues(spec.jql);
      }
    );
    stream.markdown(`**${total}** issue(s) matched.\n\n`);
    if (!total) return;

    const LARGE_THRESHOLD = Math.max(0, Number(cfg().get<number>('analyze.largeThreshold', 2000)) || 2000);
    if (total > LARGE_THRESHOLD && !confirm) {
      pendingLargeFetch = { spec, reportSpec, total };
      stream.markdown(
        `This query matches **${total}** issues. Fetching them all may take time.\n\n` +
          `To continue, rerun with confirmation:\n` +
          `- \`@sg analyze-dynamic confirm\`\n\n` +
          `Or refine the scope:\n` +
          `- \`@sg analyze-dynamic refine only last 14 days\`\n` +
          `- \`@sg analyze-dynamic refine component = RustRunner\`\n`
      );
      return;
    }

    const paged = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'SGA · Jira',
        cancellable: false
      },
      async progress => {
        progress.report({ message: `Fetching up to ${total} issues (paginated)…` });
        return jira.searchIssuesPaged(spec.jql, null);
      }
    );
    issues = paged.issues;
    lastExtractCache = { jql: spec.jql, total: paged.total, fetchedAt: fetchNow, issues };
    stream.markdown(`Fetched **${issues.length}** issue(s).\n\n`);
  }

  const velocity = computeVelocityFromIssues(issues);

  // Core distributions (always useful)
  const topN = reportSpec.topN;
  const byStatus = topCounts(issues.map(i => i.status), Math.min(topN, 12));
  const byAssignee = topCounts(issues.map(i => i.assignee), topN);
  const byIssueType = topCounts(issues.map(i => i.issueType), Math.min(topN, 12));
  const byComponent = topCounts(
    issues.flatMap(i => (Array.isArray(i.components) && i.components.length ? i.components : ['(none)'])),
    Math.min(topN, 12)
  );

  // Derivations for DM: WIP aging, stale, blocked-ish
  const now = Date.now();
  const notDone = issues.filter(i => !isIssueDone(i));
  const done = issues.length - notDone.length;
  const notDoneCount = notDone.length;

  const stale = notDone
    .map(i => ({ i, days: daysBetween(i.updated, now) }))
    .filter(x => x.days >= reportSpec.thresholds.staleDays)
    .sort((a, b) => b.days - a.days)
    .slice(0, 15);

  const blockedLike = notDone
    .filter(i => /blocked|on hold|imped/i.test(String(i.status ?? '').toLowerCase()))
    .slice(0, 15);

  const agingBuckets = [
    { label: '0-2', min: 0, max: 2 },
    { label: '3-5', min: 3, max: 5 },
    { label: '6-10', min: 6, max: 10 },
    { label: '11+', min: 11, max: 10_000 }
  ].map(b => ({
    label: b.label,
    count: notDone.filter(i => {
      const d = daysBetween(i.updated, now);
      return d >= b.min && d <= b.max;
    }).length
  }));

  // Sections (user-friendly)
  if (reportSpec.sections.includes('exec_summary')) {
    stream.markdown('### Executive summary\n\n');
    stream.markdown(`- Audience: **${reportSpec.audience}** · Tone: **${reportSpec.tone}**\n`);
    stream.markdown(`- Scope: **${issues.length}** issues · Done: **${done}** · WIP: **${notDoneCount}**\n`);
    stream.markdown(`- Velocity (scope filtré): **${velocity.completedCount}** done · **${velocity.totalStoryPoints}** SP\n`);
    stream.markdown(`- Risque “stale” (≥ ${reportSpec.thresholds.staleDays}j sans update): **${stale.length}**\n\n`);
  }

  if (reportSpec.sections.includes('delivery')) {
    stream.markdown('### Delivery\n\n');
    const topDone = issues.filter(i => isIssueDone(i)).slice(0, 10);
    if (!topDone.length) {
      stream.markdown('_No Done/Closed issues in this filtered scope._\n\n');
    } else {
      stream.markdown('Top delivered (sample):\n');
      for (const i of topDone) stream.markdown(`- **${i.key}** (${i.issueType}, ${i.storyPoints} SP): ${i.summary}\n`);
      stream.markdown('\n');
    }
  }

  if (reportSpec.sections.includes('risks')) {
    stream.markdown('### Risks & blockers\n\n');
    if (!stale.length && !blockedLike.length) {
      stream.markdown('_No major risks detected with current thresholds._\n\n');
    } else {
      if (stale.length) {
        stream.markdown(`**Stale (no update ≥ ${reportSpec.thresholds.staleDays} days):**\n`);
        for (const s of stale) stream.markdown(`- **${s.i.key}** (${s.i.status}, ${s.days}d): ${s.i.summary}\n`);
        stream.markdown('\n');
      }
      if (blockedLike.length) {
        stream.markdown('**Blocked / On-hold (status heuristic):**\n');
        for (const b of blockedLike) stream.markdown(`- **${b.key}** (${b.status}): ${b.summary}\n`);
        stream.markdown('\n');
      }
    }
  }

  if (reportSpec.sections.includes('quality')) {
    stream.markdown('### Quality\n\n');
    const reopenedLike = issues.filter(i => String(i.status ?? '').toLowerCase().includes('reopen'));
    const reopenRate = done + reopenedLike.length > 0 ? Math.round((reopenedLike.length / (done + reopenedLike.length)) * 100) : 0;
    stream.markdown(`- Reopen-like count: **${reopenedLike.length}** (rate: **${reopenRate}%**)\n`);
    stream.markdown(`- Issue types top: **${byIssueType.slice(0, 3).map(x => `${x.name} (${x.count})`).join(', ') || 'n/a'}**\n\n`);
  }

  if (reportSpec.sections.includes('people')) {
    stream.markdown('### People / load\n\n');
    stream.markdown(`Top assignees: ${byAssignee.slice(0, 5).map(x => `**${x.name}** (${x.count})`).join(' · ') || '_n/a_'}\n\n`);
  }

  if (reportSpec.sections.includes('charts')) {
    stream.markdown('### Dashboards\n\n');
    const proj = spec.project;
    for (const c of reportSpec.charts) {
      if (c === 'done_vs_notdone') stream.markdown(mermaidDoneVsNotDone(proj, done, notDoneCount));
      if (c === 'status_pie') stream.markdown(mermaidPie(`${proj} — Status distribution`, byStatus));
      if (c === 'assignee_bar') stream.markdown(mermaidBar(`${proj} — Top assignees`, byAssignee.slice(0, 10)));
      if (c === 'component_bar') stream.markdown(mermaidBar(`${proj} — Top components`, byComponent.slice(0, 10)));
      if (c === 'issuetype_bar') stream.markdown(mermaidBar(`${proj} — Issue types`, byIssueType.slice(0, 10)));
      if (c === 'aging_bar') stream.markdown(mermaidAgingHistogram(proj, agingBuckets));
    }
  }

  if (reportSpec.sections.includes('raw')) {
    stream.markdown('### Détails (sample)\n\n');
    stream.markdown(`| Key | Summary | Type | Status | Assignee | Components | SP | Updated |\n`);
    stream.markdown(`|-----|---------|------|--------|----------|------------|----|---------|\n`);
    for (const i of issues.slice(0, 25)) {
      const comps = (Array.isArray(i.components) ? i.components.join(', ') : '');
      stream.markdown(`| ${i.key} | ${i.summary} | ${i.issueType} | ${i.status} | ${i.assignee} | ${comps} | ${i.storyPoints} | ${i.updated.slice(0, 10)} |\n`);
    }
    stream.markdown('\n');
  }

  // Monthly-style HTML dashboard (single file, open in browser)
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length) {
    try {
      const html = buildMonthlyJiraHtmlReport({
        title: `${spec.project} — Monthly Jira report`,
        jql: spec.jql,
        issues: issues.map(i => ({
          key: i.key,
          summary: i.summary,
          status: i.status,
          statusCategoryKey: i.statusCategoryKey,
          assignee: i.assignee,
          storyPoints: i.storyPoints,
          issueType: i.issueType,
          labels: Array.isArray(i.labels) ? i.labels : [],
          updated: i.updated,
          resolutionDate: i.resolutionDate
        })),
        generatedAtIso: new Date().toISOString()
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = vscode.Uri.joinPath(folders[0].uri, 'reports');
      await vscode.workspace.fs.createDirectory(dir);
      const fileUri = vscode.Uri.joinPath(dir, `jira-monthly-report-${stamp}.html`);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(html, 'utf8'));
      stream.markdown(`\n### Monthly HTML report\n\n`);
      stream.markdown(
        `Open the generated file in your browser: \`${fileUri.fsPath}\`\n\n` +
        `_(Chart.js, dark theme — similar to a “monthly Jira report” dashboard.)_\n`
      );
      await vscode.env.openExternal(fileUri);
    } catch {
      stream.markdown('\n_(Could not write HTML report to workspace; chat report above is still valid.)_\n');
    }
  }

  stream.markdown('\n### AI insights\n\n');
  const prompt = JSON.stringify({
    spec,
    reportSpec,
    totals: { issues: issues.length },
    velocity,
    byStatus,
    byAssignee,
    byComponent,
    byIssueType,
    risks: {
      staleCount: stale.length,
      blockedLikeCount: blockedLike.length
    }
  });
  const insights = await askLm(
    'You are a senior delivery manager coach. Given the dashboard JSON, produce: (1) 3 insights, (2) 3 risks, (3) 3 next actions. Be concise and suitable for a sprint review.',
    prompt
  );
  stream.markdown(insights + '\n');
}

// ============================================================
// MODE: EXTRACT_DATA
// ============================================================

async function handleExtractData(
  params: Record<string, any>,
  stream: any
): Promise<void> {
  const project = params.project;
  const jql = params.jql || `project = ${project} ORDER BY updated DESC`;
  const format = (params.format ?? 'markdown').toLowerCase();

  if (!project && !params.jql) {
    stream.markdown('Provide a project key or JQL query.');
    return;
  }

  streamPlan(stream, [
    `Search Jira: \`${jql}\``,
    `Export as **${format}**`
  ]);

  const jira = new JiraClient(cfg());
  const issues = await jira.searchIssues(jql);

  if (!issues.length) {
    stream.markdown('No issues found.\n');
    return;
  }

  if (format === 'csv') {
    stream.markdown('```csv\nKey,Summary,Status,Assignee,StoryPoints,Updated\n');
    for (const i of issues) {
      stream.markdown(`${i.key},"${i.summary}",${i.status},${i.assignee},${i.storyPoints},${i.updated}\n`);
    }
    stream.markdown('```\n');
  } else {
    stream.markdown(`| Key | Summary | Status | Assignee | SP | Updated |\n`);
    stream.markdown(`|-----|---------|--------|----------|----|---------|\n`);
    for (const i of issues) {
      stream.markdown(`| ${i.key} | ${i.summary} | ${i.status} | ${i.assignee} | ${i.storyPoints} | ${i.updated.slice(0, 10)} |\n`);
    }
  }

  stream.markdown(`\n**${issues.length}** issue(s) returned.\n`);
}

// ============================================================
// Router — dispatch to the right mode handler
// ============================================================

async function routeIntent(
  classified: ClassifiedIntent,
  stream: any
): Promise<void> {
  switch (classified.intent) {
    case 'READ_ISSUE':       return handleReadIssue(classified.params, stream);
    case 'CREATE_ISSUE':     return handleCreateIssue(classified.params, stream);
    case 'IMPLEMENT':        return handleImplement(classified.params, stream);
    case 'ANALYZE_PROJECT':  return handleAnalyzeProject(classified.params, stream);
    case 'ANALYZE_DYNAMIC':  return handleAnalyzeDynamic(classified.params, stream);
    case 'EXTRACT_DATA':     return handleExtractData(classified.params, stream);
    case 'PUSH':             return handlePush(classified.params, stream);
    default:
      stream.markdown(`Unknown intent: ${classified.intent}. Try: \`@sg explain PROJ-123\` or \`@sg analyze EQC 15 days\``);
  }
}

// ============================================================
// Activation — register commands + chat participant
// ============================================================

export function activate(context: vscode.ExtensionContext) {
  // Command palette shortcut (always IMPLEMENT)
  context.subscriptions.push(
    vscode.commands.registerCommand('sg.implement', async () => {
      try {
        const input = await vscode.window.showInputBox({
          title: 'SGA',
          prompt: 'Enter a Jira key (e.g., PROJ-123)',
          validateInput: s => (JIRA_KEY_RE.test(s) ? undefined : 'Invalid Jira key')
        });
        if (!input) return;
        const key = input.match(JIRA_KEY_RE)?.[0];
        if (!key) throw new Error('Invalid Jira key.');

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `SGA: ${key}`, cancellable: false },
          async () => {
            // Minimal "implement + commit, no push"
            const jira = new JiraClient(cfg());
            const issue = await jira.getIssue(key);
            const edits = await generateEdits(issue);
            await applyFileEdits(edits);
            const git = new GitService();
            const branch = `feature/${key}`;
            try { await git.createBranchAndCheckout(branch); } catch { /* exists */ }
            await git.stageAll();
            await git.commit(`${key}: ${issue.summary}`.slice(0, 72));
            void vscode.window.showInformationMessage(`SGA: committed on ${branch}. Use @sg push ${key} to push + PR.`);
          }
        );
      } catch (e: any) {
        void vscode.window.showErrorMessage(`SGA: ${e?.message ?? String(e)}`);
      }
    })
  );

  // Chat participant — the brain
  const chatApi = (vscode as any).chat;
  if (chatApi?.createChatParticipant) {
    const participant = chatApi.createChatParticipant(
      'sg-agent',
      async (request: any, _ctx: any, stream: any, _token: any) => {
        try {
          const prompt = `${request?.command ?? ''} ${request?.prompt ?? ''}`.trim();
          if (!prompt) {
            stream.markdown(
              'Hello! I\'m **@sg**, your Jira / Copilot / GitHub agent.\n\n' +
              'Examples:\n' +
              '- `@sg what is PROJ-123?`\n' +
              '- `@sg implement PROJ-123`\n' +
              '- `@sg create a Story on EQC to migrate the API`\n' +
              '- `@sg analyze EQC last 15 days`\n' +
              '- `@sg export EQC tickets as CSV`\n' +
              '- `@sg push PROJ-123`\n'
            );
            return;
          }

          // Explicit slash-command shortcuts
          const cmd = String(request?.command ?? '').toLowerCase();
          let classified: ClassifiedIntent;

          if (cmd === 'push') {
            const key = prompt.match(JIRA_KEY_RE)?.[0] ?? '';
            classified = { intent: 'PUSH', params: { issueKey: key } };
          } else if (cmd === 'read') {
            const key = prompt.match(JIRA_KEY_RE)?.[0] ?? '';
            classified = { intent: 'READ_ISSUE', params: { issueKey: key } };
          } else if (cmd === 'implement') {
            const key = prompt.match(JIRA_KEY_RE)?.[0] ?? '';
            classified = { intent: 'IMPLEMENT', params: { issueKey: key, push: false, createPr: false } };
          } else if (cmd === 'create' || cmd === 'analyze' || cmd === 'extract') {
            // Let LM classify for full param extraction
            classified = await classifyIntent(prompt);
          } else if (cmd === 'analyze-dynamic') {
            // Force dynamic analyze mode, let LM extract filters from the remaining prompt
            const p = prompt.replace(/^\s*analyze-dynamic\s+/i, '').trim();
            const confirm = /^\s*(confirm|ok|oui|go)\b/i.test(p);
            const withoutConfirm = p.replace(/^\s*(confirm|ok|oui|go)\b[:\s-]*/i, '').trim();
            const proj =
              (p.match(/\b([A-Z][A-Z0-9]{1,9})\b/) ?? [])[1] ?? extractProjectKeyFromText(p) ?? '';
            const days = extractDaysFromText(p, 14);
            const refine = /^\s*(refine|affine|ajuste|ajuster|raffine|raffiner)\b/i.test(p);
            const cleaned = p.replace(/^\s*(refine|affine|ajuste|ajuster|raffine|raffiner)\b[:\s-]*/i, '').trim();
            const q = confirm ? withoutConfirm : (cleaned || p);
            classified = { intent: 'ANALYZE_DYNAMIC', params: { project: proj, days, query: q, refine, confirm } };
          } else {
            // NLU classification via LM
            stream.markdown('_Analyzing your request…_\n\n');
            classified = await classifyIntent(prompt);
          }

          stream.markdown(`**Mode:** \`${classified.intent}\`\n\n`);
          await routeIntent(classified, stream);
        } catch (e: any) {
          stream.markdown(`**Error:** ${e?.message ?? String(e)}\n`);
        }
      }
    );
    context.subscriptions.push(participant);
  }
}

export function deactivate() {}
