# SGUnifyAI

**SGUnifyAI** is a Visual Studio Code extension that connects **Jira**, **GitHub Enterprise**, **Git**, and the **GitHub Copilot** language model in a single chat workflow. Use natural language in the chat participant (**@SGUnifyAI**) or slash commands to read tickets, create work items, generate and commit changes, run analytics, and open pull requests.

---

## Requirements

| Dependency | Purpose |
|------------|---------|
| **VS Code** ≥ 1.90 | Extension host |
| **GitHub Copilot** (or compatible `vscode.lm` model) | Intent classification and code generation (`IMPLEMENT`, analysis copy) |
| **Built-in Git** (`vscode.git`) | Branching, commit, push |
| **Jira** (Cloud or compatible REST) | Issue read/create/search |
| **GitHub Enterprise** (optional) | Pull request creation after push |

---

## Features

| Capability | Description | Example |
|------------|-------------|---------|
| **READ_ISSUE** | Retrieve a ticket and summarize it | `@SGUnifyAI read EXES-1012` |
| **CREATE_ISSUE** | Create an issue from a short specification | `@SGUnifyAI create a Story on EXES to migrate the API to v2` |
| **IMPLEMENT** | Propose file edits via the LM, apply them, commit on `feature/<KEY>` | `@SGUnifyAI implement EXES-1012` |
| **ANALYZE_PROJECT** | Aggregate metrics over a time window | `@SGUnifyAI analyze EXES over the last 15 days` |
| **ANALYZE_DYNAMIC** | NL-driven filters, dashboards (Mermaid), executive-style narrative, optional HTML export | `@SGUnifyAI analyze-dynamic EXES last 2 days top performers` |
| **EXTRACT_DATA** | Export search results as Markdown table or CSV | `@SGUnifyAI export EXES tickets as CSV` |
| **PUSH** | Push the current feature branch and optionally open a PR | `@SGUnifyAI push EXES-1012` |

---

## Configuration

All integration settings live under the `sgunifyai` namespace. Store secrets in **User** settings or a local (untracked) file—never commit tokens.

### Jira

- **Authentication:** Bearer token only (`Authorization: Bearer <token>`). A leading `Bearer ` prefix in the setting value is removed automatically.
- **API:** Requests use `Accept: application/json`. The client tries REST **`/rest/api/2`** first, then **`/rest/api/3`**, depending on instance support.

### GitHub Enterprise

- **API base:** `{sgunifyai.github.url}/api/v3` (the trailing `/api/v3` is appended if omitted from the URL).
- **Authorization:** `token` scheme compatible with GitHub Enterprise API v3.

### Minimal `settings.json` excerpt

```json
{
  "sgunifyai.jira.url": "https://your-company.atlassian.net",
  "sgunifyai.jira.token": "<api-token-or-pat>",
  "sgunifyai.github.url": "https://github.enterprise.example.com",
  "sgunifyai.github.token": "<personal-access-token>"
}
```

---

## Behavior notes

- **Large Jira result sets:** For **ANALYZE_DYNAMIC**, if a query matches more than **2 000** issues, the extension pauses and asks for explicit confirmation before paginating the full result set.
- **Epics:** Dynamic reports and epic distribution charts use epic linkage (`parent` and, on typical Jira Cloud instances, Epic Link **`customfield_10014`**). Other field IDs may require a fork or future configuration if your schema differs.
- **HTML report:** **ANALYZE_DYNAMIC** can write `reports/jira-monthly-report-<timestamp>.html` in the workspace and open it in the default browser (single file, Chart.js).
- **Push and PR:** Creating a PR is tied to explicit push intent (e.g. `@SGUnifyAI push <KEY>`); the classifier avoids confusing French *projet* with “PR”.

---

## Command palette

| Command | ID |
|---------|-----|
| SGUnifyAI: Implement Jira ticket | `sgunifyai.implement` |

**Implement** expects an open workspace folder, a Git repository, valid Jira credentials, and a working Copilot / LM session.

---

## Development

```bash
npm install
npm run compile    # TypeScript build
npm run package    # Produce a .vsix (requires @vscode/vsce)
```

**Run locally:** open this repository in VS Code and press **F5** to launch the Extension Development Host. Open a folder with a Git repository, configure `sgunifyai.*`, then exercise **@SGUnifyAI** in the chat panel.

---

## Project layout

| Path | Responsibility |
|------|----------------|
| `package.json` | Contribution points: commands, configuration, chat participant |
| `src/extension.ts` | Chat routing, intent handling, LM prompts, report orchestration |
| `src/services.ts` | Jira REST client, GitHub REST client, Git wrapper, file edits, analytics helpers |
| `src/monthlyReportHtml.ts` | Standalone HTML report template |

---

## Security

- Treat **Jira** and **GitHub** tokens like production credentials.
- Prefer **User** settings or environment-specific files excluded from version control.
- **IMPLEMENT** applies model-suggested edits only to **workspace-relative** paths; absolute paths and `..` segments are rejected.
