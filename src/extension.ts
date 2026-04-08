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
    throw new Error('Aucun workspace ouvert. Ouvre un dossier/projet avant de lancer @sg.');
  }
}

type JiraIntent = 'implement' | 'fetch';

function detectIntent(text: string): JiraIntent {
  const t = text.toLowerCase();

  // Indices "lecture seule"
  const fetchHints = [
    'résume',
    'resume',
    'résumé',
    'summary',
    'description',
    'définition',
    'definition',
    'détails',
    'details',
    'explique',
    'c’est quoi',
    "c'est quoi",
    'montre',
    'affiche',
    'lis le ticket',
    'récupère',
    'recupere',
    'sans implémenter',
    'sans implementer',
    'ne modifie pas',
    'sans toucher au code',
    'lecture seule',
    'read only'
  ];
  if (fetchHints.some((h) => t.includes(h))) return 'fetch';

  // Indices "implémentation"
  const implementHints = [
    'implémente',
    'implemente',
    'code',
    'modifie',
    'applique',
    'corrige',
    'fix',
    'feat',
    'fais le changement'
  ];
  if (implementHints.some((h) => t.includes(h))) return 'implement';

  // Par défaut: si un ticket est mentionné dans @sg, on implémente (workflow principal).
  return 'implement';
}

async function pickCopilotChatModel(): Promise<any> {
  // API récente: vscode.lm.selectChatModels. Selon la version de VS Code, le filtre peut varier.
  const lmAny = (vscode as any).lm;
  if (!lmAny?.selectChatModels) {
    throw new Error(
      "API vscode.lm indisponible. Mets VS Code à jour et active GitHub Copilot."
    );
  }

  const models = await lmAny.selectChatModels({ vendor: 'copilot' });
  if (models?.length) return models[0];

  // fallback: aucun filtre
  const anyModels = await lmAny.selectChatModels({});
  if (!anyModels?.length) {
    throw new Error('Aucun modèle de chat disponible via vscode.lm.');
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
    "Tu es un agent de modification de code dans VS Code.",
    "Objectif: appliquer le ticket Jira dans le workspace courant.",
    "Contraintes:",
    "- Produis UNIQUEMENT un JSON valide (pas de markdown).",
    "- Schéma attendu: {\"edits\":[{\"path\":\"chemin/relatif\",\"content\":\"contenu complet du fichier\"}]}",
    "- 'path' est relatif à la racine du workspace.",
    "- 'content' est le contenu complet (réécriture) du fichier cible.",
    "- Si tu dois créer un nouveau fichier, fournis son contenu complet.",
    "- Fais le minimum de changements nécessaires pour implémenter le ticket.",
    "- N'inclus jamais de secrets/tokens dans les fichiers."
  ].join('\n');

  const user = [
    `Ticket Jira: ${params.jiraKey}`,
    `Summary: ${params.summary}`,
    `Description:`,
    params.description || '(vide)',
    '',
    'Contexte:',
    '- Tu as accès au contenu du projet local (workspace).',
    "- Si tu as besoin d'inspecter des fichiers existants, suppose que tu peux les lire; mais ta sortie doit être uniquement le JSON d'edits.",
    '',
    "Retourne le JSON maintenant."
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
    throw new Error(`Réponse modèle invalide (pas de JSON). Réponse: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  if (!parsed?.edits || !Array.isArray(parsed.edits)) {
    throw new Error("Réponse modèle invalide (champ 'edits' absent).");
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

  progress?.report({ message: `Jira: récupération ${jiraKey}…` });
  const issue = await jira.getIssue(jiraKey);

  progress?.report({ message: `Copilot: génération des modifications…` });
  const edits = await generateEditsWithModel({
    jiraKey: issue.key,
    summary: issue.summary,
    description: issue.descriptionText
  });

  progress?.report({ message: `Workspace: application des modifications (${edits.length})…` });
  await applyFileEdits(edits);

  const baseBranch = git.getCurrentBranchName();
  const branch = `feature/${issue.key}`;

  progress?.report({ message: `Git: création branche ${branch}…` });
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
    throw new Error('Usage: @sg /implement JIRA-123 (ou via la commande sg.implement).');
  }
  const { prUrl } = await implementFromJira(key, progress);
  return prUrl ? `PR créée: ${prUrl}` : 'Terminé.';
}

async function runFetch(jiraKeyMaybe: string | undefined): Promise<string> {
  const key = jiraKeyMaybe?.trim() || undefined;
  if (!key) throw new Error('Donne un ID Jira (ex: PROJ-123).');
  const { title, description, link } = await fetchJiraOnly(key);
  const desc = description?.trim() ? description.trim() : '(description vide)';
  const header = link ? `${title}\nLien: ${link}` : title;
  return `${header}\n\n${desc}`;
}

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand('sg.implement', async () => {
    try {
      const v = await vscode.window.showInputBox({
        title: '@sg /implement',
        prompt: 'Entre un ID Jira (ex: PROJ-123)',
        validateInput: (s) => (extractJiraKey(s) ? undefined : 'ID Jira invalide')
      });
      if (!v) return;
      const jiraKey = extractJiraKey(v);
      if (!jiraKey) throw new Error('ID Jira invalide.');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '@sg: implémentation', cancellable: false },
        async (progress) => {
          const msg = await runImplement(jiraKey, progress);
          void vscode.window.showInformationMessage(msg);
        }
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`@sg: ${e?.message ?? String(e)}`);
    }
  });
  context.subscriptions.push(cmd);

  const chatAny = (vscode as any).chat;
  if (chatAny?.createChatParticipant) {
    const participant = chatAny.createChatParticipant('sg', async (request: any, ctx: any, stream: any, token: any) => {
      try {
        const fullText = `${request?.command ?? ''} ${request?.prompt ?? ''}`.trim();
        const jiraKey = extractJiraKey(fullText);

        if (!jiraKey) {
          stream.markdown("Donne un ID Jira dans ton message (ex: `PROJ-123`).\n\nExemples:\n- `@sg PROJ-123 implémente ce ticket`\n- `@sg PROJ-123 donne-moi le résumé sans implémenter`");
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
          { location: vscode.ProgressLocation.Notification, title: `@sg: ${jiraKey}`, cancellable: false },
          async (progress) => {
            const msg = await runImplement(jiraKey, progress);
            stream.markdown(msg);
          }
        );
      } catch (e: any) {
        stream.markdown(`Erreur: ${e?.message ?? String(e)}`);
      }
    });

    context.subscriptions.push(participant);
  }
}

export function deactivate() {}

