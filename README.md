# @sg — Agent Jira → Copilot → Git → Pull Request

Extension VS Code qui automatise le flux:

Lecture du ticket Jira → génération des changements via `vscode.lm` (Copilot) → application aux fichiers → création de branche → commit → push → création de Pull Request GitHub.

## Installation

```bash
npm install
```

## Compilation

```bash
npm run compile
```

## Configuration (settings.json)

Colle ceci dans ton `settings.json` (et remplace les valeurs).

```json
{
  "sg.jira.url": "https://mon-entreprise.atlassian.net",
  "sg.jira.email": "prenom.nom@mon-entreprise.com",
  "sg.jira.token": "ATLAS_API_TOKEN",
  "sg.github.token": "GITHUB_PAT_REPO_SCOPE"
}
```

## Utilisation

- Via le Chat:
  - Implémenter (langage naturel, sans `/implement`):
    - `@sg PROJ-123 implémente ce ticket`
    - `@sg PROJ-123 applique les changements`
  - Lire seulement (sans implémenter):
    - `@sg PROJ-123 donne-moi le résumé et la description (lecture seule)`
    - `@sg PROJ-123 sans implémenter, affiche le ticket`
- Via la palette de commandes:
  - `@sg: Implement Jira ticket`

## Test en mode Debug

1. Ouvre ce dossier dans VS Code.
2. Appuie sur `F5` (Run → Start Debugging) pour lancer une nouvelle fenêtre “Extension Development Host”.
3. Dans la fenêtre de debug:
   - Ouvre un workspace qui contient un dépôt Git (avec remote `origin` vers GitHub).
   - Ouvre le Chat et lance par exemple:
     - `@sg PROJ-123 implémente ce ticket`
     - `@sg PROJ-123 affiche le ticket sans implémenter`

## Notes importantes

- L’extension s’appuie sur l’extension Git intégrée (`vscode.git`) pour les opérations Git.
- La création de PR utilise l’API REST GitHub via `sg.github.token`.
- Les tokens sont configurés via `settings.json` comme demandé; évite de les committer dans un dépôt.

