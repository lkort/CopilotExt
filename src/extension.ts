import * as vscode from 'vscode';
import {
  applyFileEdits,
  computeProjectMetrics,
  FileEdit,
  GitHubClient,
  GitService,
  JiraClient,
  ProjectMetrics,
  requireSetting
} from './services';

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
  const any = await lm.selectChatModels({});
  if (!any?.length) throw new Error('No chat model available via vscode.lm.');
  return any[0];
}

function lmMessage(role: 'system' | 'user', content: string): any {
  const ctor = (vscode as any).LanguageModelChatMessage;
  if (ctor?.from) return ctor.from(role, content);
  return { role, content };
}

async function collectText(resp: any): Promise<string> {
  if (!resp) return '';
  if (typeof resp.text === 'string') return resp.text;
  if (resp.stream && Symbol.asyncIterator in resp.stream) {
    let out = '';
    for await (const c of resp.stream) out += c?.text ?? '';
    return out;
  }
  return String(resp);
}

/** Send a system + user prompt to the LM and get a text response. */
async function askLm(system: string, user: string): Promise<string> {
  const model = await pickModel();
  const messages = [lmMessage('system', system), lmMessage('user', user)];
  const token = new (vscode as any).CancellationTokenSource().token;
  const resp = await model.sendRequest(messages, {}, token);
  return typeof resp?.text === 'string' ? resp.text : await collectText(resp);
}

/** Ask the LM and parse the first JSON object found in its response. */
async function askLmJson(system: string, user: string): Promise<any> {
  const raw = await askLm(system, user);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`LM did not return valid JSON. Response: ${raw.slice(0, 300)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

// ============================================================
// Intent Classification — Chain-of-Thought via LM
// ============================================================

type Intent =
  | 'READ_ISSUE'
  | 'CREATE_ISSUE'
  | 'IMPLEMENT'
  | 'ANALYZE_PROJECT'
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
  "intent": "<one of READ_ISSUE | CREATE_ISSUE | IMPLEMENT | ANALYZE_PROJECT | EXTRACT_DATA | PUSH>",
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

EXTRACT_DATA — list/export tickets
  params: { "project": "PROJ", "jql": "", "format": "markdown" }

PUSH — push an already-committed branch and optionally create a PR
  params: { "issueKey": "PROJ-123" }

Rules:
- Default push and createPr to false unless the user explicitly says "push" or "PR".
- If the user says "don't push" or "commit only", set push=false.
- Extract project keys and issue keys accurately.
- days defaults to 14 if the user doesn't specify.`;

async function classifyIntent(userMessage: string): Promise<ClassifiedIntent> {
  const json = await askLmJson(CLASSIFY_SYSTEM, userMessage);
  return {
    intent: json.intent ?? 'READ_ISSUE',
    params: json.params ?? {}
  };
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
