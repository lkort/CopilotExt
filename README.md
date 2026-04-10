# SGUnifyAI — Jira / Copilot / GitHub

VS Code extension that understands natural language to orchestrate Jira (Bearer), GitHub Enterprise, and your local workspace.

## Modes

| Mode | What it does | Example |
|------|-------------|---------|
| **READ_ISSUE** | Fetch and explain a Jira ticket | `@SGUnifyAI read EXES-1012` |
| **CREATE_ISSUE** | Create a new Jira ticket | `@SGUnifyAI create a Story on EXES to migrate the API to v2` |
| **IMPLEMENT** | Generate code, apply edits, commit | `@SGUnifyAI implement EXES-1012` |
| **ANALYZE_PROJECT** | Project metrics and AI insights | `@SGUnifyAI analyze EXES over the last 15 days` |
| **ANALYZE_DYNAMIC** | Dynamic analysis + visual report (epics, charts) | `@SGUnifyAI analyze-dynamic EXES last 2 days top performers for epic Infra` |
| **EXTRACT_DATA** | Export tickets as Markdown or CSV | `@SGUnifyAI export EXES tickets as CSV` |
| **PUSH** | Push a committed branch + create PR | `@SGUnifyAI push EXES-1012` |

## Install

```bash
npm install
```

## Build

```bash
npm run compile
```

## Package (.vsix)

```bash
npm run package
```

## Configuration (settings.json)

Four settings — URL + token for Jira and GitHub. Jira uses **Bearer** only (`Authorization: Bearer <token>`). If the token was pasted with a `Bearer ` prefix, it is stripped automatically.

```json
{
  "sgunifyai.jira.url": "https://your-company.atlassian.net",
  "sgunifyai.jira.token": "JIRA_API_TOKEN_OR_PAT",
  "sgunifyai.github.url": "https://ghe.example.com",
  "sgunifyai.github.token": "GITHUB_PAT"
}
```

### Auth details

- **Jira**: Bearer token only. `Accept: application/json`. Tries REST `/rest/api/2` then `/rest/api/3`.
- **GitHub Enterprise**: `Authorization: token <token>`. API: `{sgunifyai.github.url}/api/v3`.

## Large-result guardrail (ANALYZE_DYNAMIC)

If a dynamic analysis matches more than **2000** issues, the agent asks for confirmation before paginating the full result. (Fixed threshold — no setting.)

## Epics vs components

Reports and charts use **epic** linkage (`parent`, Epic Link `customfield_10014` on typical Jira Cloud). There is no Jira “component” filter in the dynamic builder anymore.

## Monthly HTML report

`ANALYZE_DYNAMIC` writes **single-file HTML** under `reports/jira-monthly-report-*.html` and tries to open it in the browser.

## Command palette

- **SGUnifyAI: Implement Jira ticket** (`sgunifyai.implement`) — requires an open workspace folder, a Git repo, Jira settings, and Copilot LM for code generation.

## Debug / Test

1. Open this folder in VS Code.
2. Press **F5** (Extension Development Host).
3. In the dev host, open a workspace with a Git repo and try:

   - `@SGUnifyAI read EXES-1012`
   - `@SGUnifyAI implement EXES-1012`
   - `@SGUnifyAI analyze EXES last 15 days`
   - `@SGUnifyAI analyze-dynamic EXES last 2 days top performers`
   - `@SGUnifyAI analyze-dynamic EXES distribution by status under epic EXES-100`
   - `@SGUnifyAI push EXES-1012`

## Architecture

```
package.json      — commands, settings, chat participant
src/extension.ts  — intent classification (LM), routing, handlers
src/services.ts   — Jira REST, GitHub REST, Git (vscode.git), analytics
```

## Notes

- Git uses the built-in `vscode.git` extension.
- Push / PR require an explicit `@SGUnifyAI push KEY` (or classified push intent).
- Do not commit tokens in `settings.json`.
