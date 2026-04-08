import * as vscode from 'vscode';

export type JiraIssue = {
  key: string;
  summary: string;
  descriptionText: string;
};

function requireSetting(cfg: vscode.WorkspaceConfiguration, key: string): string {
  const v = cfg.get<string>(key);
  if (!v || !v.trim()) {
    throw new Error(`Missing setting: sg.${key}. Configure it in settings.json.`);
  }
  return v.trim();
}

// Jira description (ADF) -> reasonable plain text.
function normalizeJiraDescription(description: any): string {
  if (!description) return '';
  if (typeof description === 'string') return description;

  const parts: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node.type === 'text' && typeof node.text === 'string') {
      parts.push(node.text);
      return;
    }
    if (node.content) walk(node.content);
  };
  walk(description);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export class JiraClient {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const baseUrl = requireSetting(this.cfg, 'jira.url').replace(/\/+$/, '');
    const jiraToken = requireSetting(this.cfg, 'jira.token');

    const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${jiraToken}`,
        Accept: 'application/json'
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jira: GET issue failed (${res.status}) ${body}`);
    }
    const json = (await res.json()) as any;
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

  // Supports:
  // - https://host/owner/repo(.git)
  // - git@host:owner/repo(.git)
  const https = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) return { host: https[1], owner: https[2], repo: https[3] };
  const ssh = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };

  throw new Error(`Unsupported Git remote URL: ${remoteUrl}`);
}

export class GitHubClient {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  private getApiBaseUrl(): string {
    const githubUrl = (this.cfg.get<string>('github.url') ?? 'https://github.com').trim().replace(/\/+$/, '');
    // For GitHub Enterprise: typically {base}/api/v3
    if (/\/api\/v3$/i.test(githubUrl)) return githubUrl;
    return `${githubUrl}/api/v3`;
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

    const apiUrl = `${this.getApiBaseUrl()}/repos/${remote.owner}/${remote.repo}/pulls`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub: PR creation failed (${res.status}) ${body}`);
    }

    const json = (await res.json()) as any;
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
      throw new Error("Built-in Git extension not found (vscode.git).");
    }
    if (!ext.isActive) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      ext.activate();
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
    if (!url) throw new Error("Unable to determine the remote URL (origin).");
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
  path: string; // workspace-relative
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

