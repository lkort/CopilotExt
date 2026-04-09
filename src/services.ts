import * as vscode from 'vscode';

// ============================================================
// HTTP helpers — timeout, HTML detection, JSON parsing
// ============================================================

const FETCH_TIMEOUT_MS = 60_000;

/** Read a VS Code setting; throw with a clear message if absent. */
export function requireSetting(
  cfg: vscode.WorkspaceConfiguration,
  key: string
): string {
  const v = cfg.get<string>(key);
  if (!v || !String(v).trim()) {
    throw new Error(`Missing setting: sg.${key}  — configure it in settings.json.`);
  }
  return String(v).trim();
}

/** Build an AbortSignal with a timeout (gracefully returns undefined if unsupported). */
function abortSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/**
 * Read the response body as text, detect HTML login pages,
 * then parse JSON. Throws with a descriptive message on any issue.
 */
async function parseJsonResponse(res: Response, label: string): Promise<any> {
  const text = await res.text();
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();

  // Many corporate proxies / Jira instances return a login HTML page on 200
  if (text.trim().startsWith('<') || ct.includes('text/html')) {
    throw new Error(
      `${label}: received HTML instead of JSON (likely a login page). ` +
        `Check sg.${label.toLowerCase()}.url and sg.${label.toLowerCase()}.token. Status ${res.status}.`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label}: response is not valid JSON. Status ${res.status}. Body (first 500 chars): ${text.slice(0, 500)}`
    );
  }
}

/** fetch() wrapper with timeout + label-aware error messages. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string
): Promise<Response> {
  const signal = abortSignal(FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, signal ? { ...init, signal } : init);
  } catch (e: any) {
    const msg =
      e?.name === 'AbortError' || e?.name === 'TimeoutError'
        ? 'request timed out'
        : String(e?.message ?? e);
    throw new Error(`${label}: ${msg}`);
  }
}

// ============================================================
// Jira description normalizer (handles ADF and plain text)
// ============================================================

function normalizeJiraDescription(description: unknown): string {
  if (!description) return '';
  if (typeof description === 'string') return description;

  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') { parts.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>;
      if (o.type === 'text' && typeof o.text === 'string') { parts.push(o.text); return; }
      if (o.content) walk(o.content);
    }
  };
  walk(description);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// ============================================================
// Jira Client — Bearer auth, Accept: application/json
// ============================================================

export type JiraIssue = {
  key: string;
  summary: string;
  descriptionText: string;
  status: string;
  storyPoints: number;
  assignee: string;
  created: string;
  updated: string;
  resolutionDate: string;
};

/** Try to extract story points from common custom-field names. */
function extractStoryPoints(fields: Record<string, any>): number {
  const candidates = [
    fields.story_points,
    fields.customfield_10016,   // Jira Cloud default
    fields.customfield_10028,   // common alternative
    fields.customfield_10002,
  ];
  for (const v of candidates) {
    if (typeof v === 'number') return v;
  }
  return 0;
}

function mapIssue(raw: any): JiraIssue {
  const f = raw?.fields ?? {};
  return {
    key: raw?.key ?? '',
    summary: f.summary ?? '',
    descriptionText: normalizeJiraDescription(f.description),
    status: f.status?.name ?? '',
    storyPoints: extractStoryPoints(f),
    assignee: f.assignee?.displayName ?? 'Unassigned',
    created: f.created ?? '',
    updated: f.updated ?? '',
    resolutionDate: f.resolutiondate ?? ''
  };
}

export class JiraClient {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  /** Common headers: Bearer token + JSON accept. */
  private headers(): Record<string, string> {
    const token = requireSetting(this.cfg, 'jira.token');
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  private base(): string {
    return requireSetting(this.cfg, 'jira.url').replace(/\/+$/, '');
  }

  // ---- READ ---------------------------------------------------
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const url =
      `${this.base()}/rest/api/2/issue/${encodeURIComponent(issueKey)}` +
      `?fields=summary,description,status,assignee,created,updated,resolutiondate,` +
      `story_points,customfield_10016,customfield_10028,customfield_10002`;

    const res = await fetchWithTimeout(url, { method: 'GET', headers: this.headers() }, 'Jira');

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jira: GET ${issueKey} failed (${res.status}) ${body.slice(0, 800)}`);
    }

    return mapIssue(await parseJsonResponse(res, 'Jira'));
  }

  // ---- CREATE -------------------------------------------------
  async createIssue(params: {
    project: string;
    summary: string;
    description: string;
    issueType: string;
  }): Promise<{ key: string }> {
    const url = `${this.base()}/rest/api/2/issue`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          fields: {
            project: { key: params.project.toUpperCase() },
            summary: params.summary,
            description: params.description,
            issuetype: { name: params.issueType || 'Story' }
          }
        })
      },
      'Jira'
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jira: CREATE issue failed (${res.status}) ${body.slice(0, 800)}`);
    }

    const json = await parseJsonResponse(res, 'Jira');
    return { key: json?.key ?? '' };
  }

  // ---- SEARCH (JQL) -------------------------------------------
  async searchIssues(
    jql: string,
    maxResults = 200
  ): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    const perPage = Math.min(maxResults, 100);

    while (startAt < maxResults) {
      const url =
        `${this.base()}/rest/api/2/search` +
        `?jql=${encodeURIComponent(jql)}` +
        `&startAt=${startAt}&maxResults=${perPage}` +
        `&fields=summary,description,status,assignee,created,updated,resolutiondate,` +
        `story_points,customfield_10016,customfield_10028,customfield_10002`;

      const res = await fetchWithTimeout(url, { method: 'GET', headers: this.headers() }, 'Jira');

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Jira: SEARCH failed (${res.status}) ${body.slice(0, 800)}`);
      }

      const json = await parseJsonResponse(res, 'Jira');
      const issues: any[] = json?.issues ?? [];
      if (!issues.length) break;

      for (const raw of issues) allIssues.push(mapIssue(raw));
      startAt += issues.length;
      if (startAt >= (json?.total ?? 0)) break;
    }

    return allIssues;
  }
}

// ============================================================
// GitHub Client — token auth, {url}/api/v3
// ============================================================

export type GitRemoteInfo = { owner: string; repo: string; host: string };

/** Parse HTTPS or SSH remote URLs into owner/repo/host. */
function parseGitHubRemoteUrl(remoteUrl: string): GitRemoteInfo {
  const url = remoteUrl.trim();
  // https://host/owner/repo(.git)
  const https = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) return { host: https[1], owner: https[2], repo: https[3] };
  // git@host:owner/repo(.git)
  const ssh = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };

  throw new Error(`Unsupported Git remote URL: ${remoteUrl}`);
}

export class GitHubClient {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  /** Build API base: always {sg.github.url}/api/v3. */
  private apiBase(): string {
    const ghUrl = requireSetting(this.cfg, 'github.url').replace(/\/+$/, '');
    if (/\/api\/v3$/i.test(ghUrl)) return ghUrl;
    return `${ghUrl}/api/v3`;
  }

  async createPullRequest(params: {
    remoteUrl: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number: number }> {
    const token = requireSetting(this.cfg, 'github.token');
    const remote = parseGitHubRemoteUrl(params.remoteUrl);
    const apiUrl = `${this.apiBase()}/repos/${remote.owner}/${remote.repo}/pulls`;

    const res = await fetchWithTimeout(
      apiUrl,
      {
        method: 'POST',
        headers: {
          'Authorization': 'token ' + token,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: params.title,
          head: params.head,
          base: params.base,
          body: params.body
        })
      },
      'GitHub'
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub: PR creation failed (${res.status}) ${body.slice(0, 800)}`);
    }

    const json = await parseJsonResponse(res, 'GitHub');
    return { url: json?.html_url ?? '', number: json?.number ?? 0 };
  }
}

// ============================================================
// Git Service — wraps the built-in vscode.git extension
// ============================================================

type GitExtensionExports = { getAPI(version: 1): GitAPIv1 };
type GitAPIv1 = { repositories: Repository[] };

type Repository = {
  rootUri: vscode.Uri;
  state: { HEAD?: { name?: string } };
  remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  checkout(branch: string): Promise<void>;
  add(resources?: vscode.Uri[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(remote?: string, name?: string, setUpstream?: boolean): Promise<void>;
};

export class GitService {
  private readonly repo: Repository;

  constructor() {
    const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!ext) throw new Error('Built-in Git extension not found (vscode.git).');
    if (!ext.isActive) void ext.activate();
    const api = ext.exports.getAPI(1);
    if (!api.repositories.length) throw new Error('No Git repository detected in this workspace.');
    this.repo = api.repositories[0];
  }

  currentBranch(): string {
    return this.repo.state.HEAD?.name ?? 'main';
  }

  originRemoteUrl(): string {
    const origin = this.repo.remotes.find(r => r.name === 'origin') ?? this.repo.remotes[0];
    const url = origin?.pushUrl ?? origin?.fetchUrl;
    if (!url) throw new Error('Unable to determine the remote URL (origin).');
    return url;
  }

  async createBranchAndCheckout(branch: string): Promise<void> {
    await this.repo.createBranch(branch, true);
  }

  async stageAll(): Promise<void> {
    await this.repo.add();
  }

  async commit(message: string): Promise<void> {
    await this.repo.commit(message);
  }

  async push(branch: string): Promise<void> {
    await this.repo.push('origin', branch, true);
  }
}

// ============================================================
// File Editing — apply generated code to workspace files
// ============================================================

export type FileEdit = {
  path: string;   // workspace-relative
  content: string; // full file content (rewrite)
};

export async function applyFileEdits(edits: FileEdit[]): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder is open.');
  const root = folders[0].uri;

  const wsEdit = new vscode.WorkspaceEdit();
  for (const e of edits) {
    const uri = vscode.Uri.joinPath(root, e.path);
    try {
      await vscode.workspace.fs.stat(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      wsEdit.replace(uri, fullRange, e.content);
    } catch {
      wsEdit.createFile(uri, { overwrite: true });
      wsEdit.insert(uri, new vscode.Position(0, 0), e.content);
    }
  }

  const ok = await vscode.workspace.applyEdit(wsEdit);
  if (!ok) throw new Error('Failed to apply edits to the workspace.');
}

// ============================================================
// Analytics Engine — compute project metrics from Jira data
// ============================================================

export type ProjectMetrics = {
  period: { project: string; days: number; totalIssues: number };
  velocity: { completedCount: number; totalStoryPoints: number };
  backlogHealth: {
    total: number;
    withoutDescription: number;
    healthPercent: number;
  };
  stabilityIndex: {
    completed: number;
    reopened: number;
    ratio: number;
  };
  teamFlow: {
    blocked: Array<{ key: string; summary: string; status: string; daysStuck: number }>;
  };
};

export async function computeProjectMetrics(
  jira: JiraClient,
  project: string,
  days: number
): Promise<ProjectMetrics> {
  // 1 — All issues touched in the period
  const allIssues = await jira.searchIssues(
    `project = ${project} AND updatedDate >= -${days}d ORDER BY updated DESC`
  );

  // 2 — Completed (Done) in the period
  const completed = allIssues.filter(i =>
    i.status.toLowerCase() === 'done' || i.status.toLowerCase() === 'closed'
  );

  // 3 — Reopened (heuristic: status contains "reopen")
  const reopened = allIssues.filter(i =>
    i.status.toLowerCase().includes('reopen')
  );

  // 4 — Story points velocity
  const totalSP = completed.reduce((sum, i) => sum + i.storyPoints, 0);

  // 5 — Backlog health: issues without description
  const withoutDesc = allIssues.filter(i => !i.descriptionText.trim());

  // 6 — Team flow: issues stuck > 5 days (last updated > 5 days ago, not Done)
  const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const blocked = allIssues
    .filter(i => {
      const notDone = !['done', 'closed'].includes(i.status.toLowerCase());
      const stale = new Date(i.updated).getTime() < fiveDaysAgo;
      return notDone && stale;
    })
    .map(i => ({
      key: i.key,
      summary: i.summary,
      status: i.status,
      daysStuck: Math.round((Date.now() - new Date(i.updated).getTime()) / (24 * 60 * 60 * 1000))
    }));

  const completedCount = completed.length;
  const reopenedCount = reopened.length;

  return {
    period: { project, days, totalIssues: allIssues.length },
    velocity: { completedCount, totalStoryPoints: totalSP },
    backlogHealth: {
      total: allIssues.length,
      withoutDescription: withoutDesc.length,
      healthPercent: allIssues.length
        ? Math.round(((allIssues.length - withoutDesc.length) / allIssues.length) * 100)
        : 100
    },
    stabilityIndex: {
      completed: completedCount,
      reopened: reopenedCount,
      ratio: completedCount + reopenedCount > 0
        ? Math.round((reopenedCount / (completedCount + reopenedCount)) * 100)
        : 0
    },
    teamFlow: { blocked }
  };
}
