import * as vscode from 'vscode';

const FETCH_TIMEOUT_MS = 60_000;

export type JiraIssue = {
  key: string;
  summary: string;
  descriptionText: string;
};

function requireSetting(cfg: vscode.WorkspaceConfiguration, key: string): string {
  const v = cfg.get<string>(key);
  if (!v || !String(v).trim()) {
    throw new Error(`Missing setting: sg.${key}. Configure it in settings.json.`);
  }
  return String(v).trim();
}

function abortSignal(timeoutMs: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(timeoutMs);
  } catch {
    return undefined;
  }
}

/** Read response body as text; detect HTML login pages; parse JSON. */
async function parseJsonResponse(res: Response, label: string): Promise<any> {
  const text = await res.text();
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const trimmed = text.trim();
  if (trimmed.startsWith('<') || ct.includes('text/html')) {
    throw new Error(
      `${label}: received HTML instead of JSON (often a login page). Check URL and token. Status ${res.status}.`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON. Status ${res.status}. Body: ${text.slice(0, 500)}`);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string
): Promise<Response> {
  const signal = abortSignal(FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, signal ? { ...init, signal } : init);
  } catch (e: any) {
    const msg = e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'request timed out' : String(e?.message ?? e);
    throw new Error(`${label}: ${msg}`);
  }
}

// Jira description (ADF) -> plain text.
function normalizeJiraDescription(description: unknown): string {
  if (!description) return '';
  if (typeof description === 'string') return description;

  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>;
      if (o.type === 'text' && typeof o.text === 'string') {
        parts.push(o.text);
        return;
      }
      if (o.content) walk(o.content);
    }
  };
  walk(description);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export class JiraClient {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  /**
   * Uses only sg.jira.url and sg.jira.token.
   * Authorization: exactly `Bearer ` + token. Accept: application/json.
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const baseUrl = requireSetting(this.cfg, 'jira.url').replace(/\/+$/, '');
    const jiraToken = requireSetting(this.cfg, 'jira.token');

    const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + jiraToken,
          Accept: 'application/json'
        }
      },
      'Jira'
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Jira: GET issue failed (${res.status}) ${errText.slice(0, 800)}`);
    }

    const json = await parseJsonResponse(res, 'Jira');
    return {
      key: json?.key ?? issueKey,
      summary: json?.fields?.summary ?? '',
      descriptionText: normalizeJiraDescription(json?.fields?.description)
    };
  }
}

export type GitRemoteInfo = { owner: string; repo: string; host: string };

function parseGitHubRemoteUrl(remoteUrl: string): GitRemoteInfo {
  const url = remoteUrl.trim();
  const https = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) return { host: https[1], owner: https[2], repo: https[3] };
  const ssh = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };

  throw new Error(`Unsupported Git remote URL: ${remoteUrl}`);
}

function githubApiBaseFromSettings(cfg: vscode.WorkspaceConfiguration): string {
  const githubUrl = requireSetting(cfg, 'github.url').replace(/\/+$/, '');
  const host = (() => {
    try {
      return new URL(githubUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  // github.com uses https://api.github.com (not /api/v3 under github.com)
  if (host === 'github.com') {
    return 'https://api.github.com';
  }
  if (/\/api\/v3$/i.test(githubUrl)) return githubUrl;
  return `${githubUrl}/api/v3`;
}

export class GitHubClient {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  /**
   * Uses only sg.github.url and sg.github.token.
   * Tries `Authorization: token <pat>` first; on 401, retries with `Bearer <pat>`.
   */
  async createPullRequest(params: {
    remoteUrl: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ url: string; number: number }> {
    const githubToken = requireSetting(this.cfg, 'github.token');
    const remote = parseGitHubRemoteUrl(params.remoteUrl);
    const apiBase = githubApiBaseFromSettings(this.cfg);
    const apiUrl = `${apiBase}/repos/${remote.owner}/${remote.repo}/pulls`;

    const body = JSON.stringify({
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body
    });

    const commonHeaders = {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    let res = await fetchWithTimeout(
      apiUrl,
      {
        method: 'POST',
        headers: {
          ...commonHeaders,
          Authorization: 'token ' + githubToken
        },
        body
      },
      'GitHub'
    );

    if (res.status === 401) {
      res = await fetchWithTimeout(
        apiUrl,
        {
          method: 'POST',
          headers: {
            ...commonHeaders,
            Authorization: 'Bearer ' + githubToken
          },
          body
        },
        'GitHub'
      );
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`GitHub: PR creation failed (${res.status}) ${errText.slice(0, 800)}`);
    }

    const json = await parseJsonResponse(res, 'GitHub');
    return { url: json?.html_url ?? '', number: json?.number ?? 0 };
  }
}

type GitExtensionExports = { getAPI(version: 1): GitAPIv1 };
type GitAPIv1 = {
  repositories: Repository[];
};

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
    if (!ext) {
      throw new Error('Built-in Git extension not found (vscode.git).');
    }
    if (!ext.isActive) {
      void ext.activate();
    }
    const api = ext.exports.getAPI(1);
    if (!api.repositories.length) {
      throw new Error('No Git repository detected in this workspace.');
    }
    this.repo = api.repositories[0];
  }

  getCurrentBranchName(): string {
    return this.repo.state.HEAD?.name ?? 'main';
  }

  getOriginRemoteUrl(): string {
    const origin = this.repo.remotes.find((r) => r.name === 'origin') ?? this.repo.remotes[0];
    const url = origin?.pushUrl ?? origin?.fetchUrl;
    if (!url) throw new Error('Unable to determine the remote URL (origin).');
    return url;
  }

  async createAndCheckoutBranch(branch: string): Promise<void> {
    await this.repo.createBranch(branch, true);
  }

  async stageAll(): Promise<void> {
    await this.repo.add();
  }

  async commit(message: string): Promise<void> {
    await this.repo.commit(message);
  }

  async pushCurrentBranch(branch: string): Promise<void> {
    await this.repo.push('origin', branch, true);
  }
}

export type FileEdit = {
  path: string;
  content: string;
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
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      wsEdit.replace(uri, fullRange, e.content);
    } catch {
      wsEdit.createFile(uri, { overwrite: true });
      wsEdit.insert(uri, new vscode.Position(0, 0), e.content);
    }
  }

  const ok = await vscode.workspace.applyEdit(wsEdit);
  if (!ok) throw new Error('Failed to apply edits to the workspace.');
}
