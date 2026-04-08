# SGA — Jira → Copilot → Git → Pull Request

VS Code extension that automates the workflow:

Read Jira ticket → generate changes via `vscode.lm` (Copilot) → apply edits to workspace files → create branch → commit → push → create GitHub Pull Request.

## Install

```bash
npm install
```

## Build

```bash
npm run compile
```

## Configuration (settings.json)

Paste this into your VS Code `settings.json` and replace the values.

```json
{
  "sg.jira.url": "https://your-company.atlassian.net",
  "sg.jira.token": "JIRA_PAT",
  "sg.github.url": "https://github.com",
  "sg.github.token": "GITHUB_PAT_WITH_REPO_PERMS"
}
```

### GitHub Enterprise

Set `sg.github.url` to your GitHub Enterprise base URL, for example:

```json
{
  "sg.github.url": "https://alm-github.systems.uk.hsbc/"
}
```

For **github.com**, set `sg.github.url` to `https://github.com` (the extension uses `https://api.github.com` for API calls). For **GitHub Enterprise**, the extension uses `${githubUrl}/api/v3`.

## Usage

### Chat (recommended)

- Implement (natural language, no `/implement` required):
  - `SGA PROJ-123 implement this ticket`
  - `SGA PROJ-123 apply the changes`
- Fetch only (read-only, no code changes, no git):
  - `SGA PROJ-123 show me the summary and description (read-only)`
  - `SGA PROJ-123 without implementing, display the ticket`

### Command Palette

- `SGA: Implement Jira ticket`

## Debug / Test in VS Code

1. Open this folder in VS Code.
2. Press `F5` (Run → Start Debugging) to launch the “Extension Development Host” window.
3. In the dev host window:
   - Open a workspace that contains a Git repository with an `origin` remote pointing to GitHub.
   - Open Chat and try:
     - `SGA PROJ-123 implement this ticket`
     - `SGA PROJ-123 show the ticket without implementing`

## Notes

- Git operations use the built-in Git extension (`vscode.git`).
- PR creation uses GitHub REST API with `sg.github.token`.
- Tokens are configured through `settings.json`; do not commit them.

