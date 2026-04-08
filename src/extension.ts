import * as vscode from 'vscode';
import { applyFileEdits, FileEdit, GitHubClient, GitService, JiraClient } from './services';

const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/g;

function extractJiraKey(text: string): string | undefined {
  const m = text.match(JIRA_KEY_RE);
  return m?.[0];
}

function getCfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sg');
}

function requireWorkspace(): void {
  if (!vscode.workspace.workspaceFolders?.length) {
    throw new Error('No workspace folder is open. Open a project folder before using SGA.');
  }
}

type JiraIntent = 'implement' | 'fetch';

function detectIntent(text: string): JiraIntent {
  const t = text.toLowerCase();

  // "Read-only" hints
  const fetchHints = [
    'summarize',
    'resume',
    'summary',
    'description',
    'definition',
    'details',
    'explain',
    "what is",
    'montre',
    'show',
    'display',
    'read the ticket',
    'fetch',
    'recupere',
    'without implementing',
    "don't implement",
    'do not modify',
    "don't modify",
    'no code changes',
    'read-only',
    'read only'
  ];
  if (fetchHints.some((h) => t.includes(h))) return 'fetch';

  // "Implementation" hints
  const implementHints = [
    'implemente',
    'implement',
    'code',
    'modify',
    'apply',
    'fix',
    'fix',
    'feat',
    'make the change'
  ];
  if (implementHints.some((h) => t.includes(h))) return 'implement';

  // Default: if a Jira key is mentioned in SGA, implement it (primary workflow).
  return 'implement';
}

async function pickCopilotChatModel(): Promise<any> {
  // Recent API: vscode.lm.selectChatModels. Exact filtering can vary by VS Code version.
  const lmAny = (vscode as any).lm;
  if (!lmAny?.selectChatModels) {
    throw new Error(
      'vscode.lm API is unavailable. Update VS Code and ensure GitHub Copilot is enabled.'
    );
  }

  const models = await lmAny.selectChatModels({ vendor: 'copilot' });
  if (models?.length) return models[0];

  // Fallback: no filter
  const anyModels = await lmAny.selectChatModels({});
  if (!anyModels?.length) {
    throw new Error('No chat model is available via vscode.lm.');
  }
  return anyModels[0];
}

async function generateEditsWithModel(params: {
  jiraKey: string;
  summary: string;
  description: string;
}): Promise<FileEdit[]> {
  const model = await pickCopilotChatModel();

  const system = [
    'You are a code-editing agent running inside VS Code.',
    'Goal: implement the Jira ticket in the current workspace.',
    'Constraints:',
    '- Output ONLY valid JSON (no markdown).',
    '- Expected schema: {"edits":[{"path":"relative/path","content":"full file content"}]}',
    "- 'path' is relative to the workspace root.",
    "- 'content' is the full content of the target file (rewrite).",
    '- If you need to create a new file, provide its full content.',
    '- Make the minimal set of changes necessary to implement the ticket.',
    '- Never include secrets/tokens in any file.'
  ].join('\n');

  const user = [
    `Ticket Jira: ${params.jiraKey}`,
    `Summary: ${params.summary}`,
    'Description:',
    params.description || '(vide)',
    '',
    'Context:',
    '- You have access to the local project (workspace).',
    "- If you need to inspect existing files, assume you can read them; but your output must be ONLY the JSON edits.",
    '',
    'Return the JSON now.'
  ].join('\n');

  const messages = [
    (vscode as any).LanguageModelChatMessage?.from?.('system', system) ??
      { role: 'system', content: system },
    (vscode as any).LanguageModelChatMessage?.from?.('user', user) ??
      { role: 'user', content: user }
  ];

  const resp = await model.sendRequest(messages, {}, new (vscode as any).CancellationTokenSource().token);
  const text = typeof resp?.text === 'string' ? resp.text : (await collectResponseText(resp));
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error(`Invalid model response (no JSON). Response: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  if (!parsed?.edits || !Array.isArray(parsed.edits)) {
    throw new Error("Invalid model response (missing 'edits').");
  }
  return parsed.edits as FileEdit[];
}

async function collectResponseText(resp: any): Promise<string> {
  if (!resp) return '';
  if (typeof resp.text === 'string') return resp.text;
  if (typeof resp.response?.text === 'string') return resp.response.text;
  if (resp.stream && Symbol.asyncIterator in resp.stream) {
    let out = '';
    for await (const chunk of resp.stream) {
      out += chunk?.text ?? '';
    }
    return out;
  }
  return String(resp);
}

async function implementFromJira(jiraKey: string, progress?: vscode.Progress<{ message?: string }>): Promise<{ prUrl?: string }> {
  requireWorkspace();

  const cfg = getCfg();
  const jira = new JiraClient(cfg);
  const gh = new GitHubClient(cfg);
  const git = new GitService();

  progress?.report({ message: `Jira: fetching ${jiraKey}…` });
  const issue = await jira.getIssue(jiraKey);

  progress?.report({ message: 'Copilot: generating changes…' });
  const edits = await generateEditsWithModel({
    jiraKey: issue.key,
    summary: issue.summary,
    description: issue.descriptionText
  });

  progress?.report({ message: `Workspace: applying edits (${edits.length})…` });
  await applyFileEdits(edits);

  const baseBranch = git.getCurrentBranchName();
  const branch = `feature/${issue.key}`;

  progress?.report({ message: `Git: creating branch ${branch}…` });
  await git.createAndCheckoutBranch(branch);

  progress?.report({ message: 'Git: stage + commit…' });
  await git.stageAll();
  const commitMsg = `${issue.key}: ${issue.summary}`.slice(0, 72);
  await git.commit(commitMsg);

  progress?.report({ message: 'GitHub: push + PR…' });
  await git.pushCurrentBranch(branch);
  const remoteUrl = git.getOriginRemoteUrl();

  const jiraUrl = cfg.get<string>('jira.url')?.replace(/\/+$/, '');
  const jiraLink = jiraUrl ? `${jiraUrl}/browse/${issue.key}` : issue.key;
  const pr = await gh.createPullRequest({
    remoteUrl,
    head: branch,
    base: baseBranch || 'main',
    title: `${issue.key}: ${issue.summary}`,
    body: `Ticket Jira: ${jiraLink}\n\nRésumé:\n- ${issue.summary}\n`
  });

  return { prUrl: pr.url };
}

async function fetchJiraOnly(jiraKey: string): Promise<{ title: string; description: string; link?: string }> {
  const cfg = getCfg();
  const jira = new JiraClient(cfg);
  const issue = await jira.getIssue(jiraKey);
  const jiraUrl = cfg.get<string>('jira.url')?.replace(/\/+$/, '');
  const link = jiraUrl ? `${jiraUrl}/browse/${issue.key}` : undefined;
  return { title: `${issue.key}: ${issue.summary}`, description: issue.descriptionText, link };
}

async function runImplement(jiraKeyMaybe: string | undefined, progress?: vscode.Progress<{ message?: string }>): Promise<string> {
  const key = jiraKeyMaybe?.trim() || undefined;
  if (!key) {
    throw new Error('Provide a Jira key (e.g., PROJ-123).');
  }
  const { prUrl } = await implementFromJira(key, progress);
  return prUrl ? `PR created: ${prUrl}` : 'Done.';
}

async function runFetch(jiraKeyMaybe: string | undefined): Promise<string> {
  const key = jiraKeyMaybe?.trim() || undefined;
  if (!key) throw new Error('Provide a Jira key (e.g., PROJ-123).');
  const { title, description, link } = await fetchJiraOnly(key);
  const desc = description?.trim() ? description.trim() : '(empty description)';
  const header = link ? `${title}\nLink: ${link}` : title;
  return `${header}\n\n${desc}`;
}

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('sg.implement', async () => {
    try {
      const v = await vscode.window.showInputBox({
        title: 'SGA',
        prompt: 'Enter a Jira key (e.g., PROJ-123)',
        validateInput: (s) => (extractJiraKey(s) ? undefined : 'Invalid Jira key')
      });
      if (!v) return;
      const jiraKey = extractJiraKey(v);
      if (!jiraKey) throw new Error('Invalid Jira key.');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SGA: running', cancellable: false },
        async (progress) => {
          const msg = await runImplement(jiraKey, progress);
          void vscode.window.showInformationMessage(msg);
        }
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`SGA: ${e?.message ?? String(e)}`);
    }
  });
  context.subscriptions.push(cmd);

  const chatAny = (vscode as any).chat;
  if (chatAny?.createChatParticipant) {
    const participant = chatAny.createChatParticipant('sg-agent', async (request: any, ctx: any, stream: any, token: any) => {
      try {
        const fullText = `${request?.command ?? ''} ${request?.prompt ?? ''}`.trim();
        const jiraKey = extractJiraKey(fullText);

        if (!jiraKey) {
          stream.markdown(
            "Include a Jira key in your message (e.g., `PROJ-123`).\n\nExamples:\n- `SGA PROJ-123 implement this ticket`\n- `SGA PROJ-123 show me the summary (read-only)`"
          );
          return;
        }

        const cmd = String(request?.command ?? '').toLowerCase();
        const explicitFetch = cmd === 'jira' || cmd === 'fetch' || /\/(jira|fetch)\b/i.test(fullText);
        const explicitImplement = cmd === 'implement' || /\/implement\b/i.test(fullText);

        const intent: JiraIntent = explicitFetch ? 'fetch' : explicitImplement ? 'implement' : detectIntent(fullText);

        if (intent === 'fetch') {
          stream.markdown(await runFetch(jiraKey));
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `SGA: ${jiraKey}`, cancellable: false },
          async (progress) => {
            const msg = await runImplement(jiraKey, progress);
            stream.markdown(msg);
          }
        );
      } catch (e: any) {
        stream.markdown(`Error: ${e?.message ?? String(e)}`);
      }
    });

    context.subscriptions.push(participant);
  }
}

export function deactivate() {}

