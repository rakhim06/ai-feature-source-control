# AI Feature Source Control — v1.0.0

An AI-assisted Git Source Control view for VS Code. Changes are organized by **feature → component → task**, using the GitHub Copilot Language Model API or an authenticated local Codex CLI. One window can display multiple Git repositories with independent Commit / Push / Publish / Sync controls.

**What v1 promises:** predictable **whole-file** Stage / Unstage and **index-only** Commit, repository-scoped AI requests, bounded diff prompts, manual group assignments that remain pinned, and clear errors that never quote a provider's raw output. It uses the built-in `vscode.git` repositories and does not create duplicate SCM providers.

**What v1 does not promise:** per-hunk staging, perfect AI grouping or guaranteed secret detection. VS Code's original Git `Changes` view still exists; collapse it if you use this view daily.

## Install and upgrade

1. In VS Code, open **Extensions → `…` → Install from VSIX…** and choose `ai-feature-source-control-1.0.0.vsix`.
2. Run **Developer: Reload Window**.
3. Open **Source Control → Changes by Feature**. Use the sparkles action beside a repository to classify *that repository only*.
4. When prompted, read the disclosure about sending diffs and opt in. Consent is per repository per VS Code session.

Existing v0.9 settings and saved classifications remain compatible. You do not need to reclassify unchanged files unless you request a full reclassification.

For Codex, the extension uses **Codex CLI**, not the Codex VS Code extension's private APIs. Run `codex login status` from your terminal. If the extension gets `spawn codex ENOENT`, set `aiFeatureGroups.codexExecutablePath` to the absolute path returned by `which codex` (for example, `/opt/homebrew/bin/codex`).

## Interface

```text
Changes by Feature

▾ hywater-portal-backend  ⎇ feature/async-exports  [4 ↓  0 ↑] [Classify] [Fetch]
  [Commit message...                                           ✨]
  [✓ Commit]
  ▾ Staged Changes                                               [-]
    ▾ feat: Asynchronous exports                                 [-]
      ▾ Job orchestration                                        [-]
          M export-worker.ts                                     [-]
  ▾ Changes                                                      [+]
    ▾ feat: Asynchronous exports                                 [+]
      ▾ Export API                                               [+]
          M exports.controller.ts                                [+]

▾ hywater-portal-frontend  ⎇ feature/fix-chart    [0 ↓  2 ↑] [Classify] [Fetch]
  [Message...                                                   ✨]
  [↑ Push]
```

- The branch name is clickable. `↓` means commits incoming from the **last fetched** upstream, `↑` outgoing. Sync acts on that repository alone.
- The blue action follows Git state: **Commit → Publish Branch (no upstream) / Push / Sync**.
- `Staged Changes` precedes `Changes`; empty sections are hidden. Each group has whole-file `+` / `−` actions. Click a file to inspect the index or worktree diff.
- Use the doublesparkle button beside the commit message to generate a **suggestion** from staged changes only. It never commits automatically.
- Use the AI action beside a repository to classify its diffs. While busy, it turns into **Cancel**.
- All view content is rendered as text, not untrusted HTML. Open files, feature names and diff content do not execute as Webview scripts.

## AI configuration

Set preferences in **Settings (JSON)** or search for `AI Feature Groups` in VS Code Settings:

```json
{
  "aiFeatureGroups.provider": "codex",
  "aiFeatureGroups.codexModel": "",
  "aiFeatureGroups.codexReasoningEffort": "medium",
  "aiFeatureGroups.detailLevel": 2,
  "aiFeatureGroups.autoClassify": false,
  "aiFeatureGroups.maxFilesPerClassification": 80,
  "aiFeatureGroups.maxFilesPerBatch": 10,
  "aiFeatureGroups.maxDiffCharsPerFile": 1200,
  "aiFeatureGroups.maxTotalDiffCharsPerClassification": 40000,
  "aiFeatureGroups.aiRequestTimeoutMs": 120000,
  "aiFeatureGroups.autoClassifyDelayMs": 5000
}
```

| Setting | Effect |
|---|---|
| `provider` | `"copilot"` (uses VS Code LM API) or `"codex"` (uses signed-in Codex CLI). |
| `copilotModelId` | Exact ID from models exposed by the Copilot LM API; empty prompts selection. The public API has no supported per-request reasoning-effort setting. |
| `codexModel` | Exact CLI model ID; empty uses the CLI's built-in default. Availability depends on the account and CLI version. |
| `codexReasoningEffort` | `default`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; only supported efforts work for the chosen model. |
| `detailLevel` | 1 = feature, 2 = feature/component, 3 = feature/component/task. Switching depth is display-only; **no additional tokens**. |
| `autoClassify` | Only auto-classifies repositories explicitly authorized in this VS Code session. Defaults to `true`; set `false` for maximum control. |
| `autoClassifyDelayMs` | Wait after the latest Git change (default 5 seconds) before triggering auto-classification. |
| `maxDiffCharsPerFile` | Maximum raw diff excerpt per file, before local redaction and total budgeting. |
| `maxTotalDiffCharsPerClassification` | Sum of diff excerpt characters per repository classification, not a token count. |
| `maxFilesPerBatch` | Upper bound on files in one model request; lowering it can increase the number of requests. |
| `maxFilesPerClassification` | Hard cap (default 80) on files submitted per repository classification. Other files stay visible and retain previous groups or `Uncategorized`. |
| `aiRequestTimeoutMs` | Request timeout, 5–300 seconds. Codex is terminated on cancellation/timeouts. |
| `excludedFilePatterns` | Additional glob patterns omitted from AI requests, e.g. `"**/config/private/**"`. |

### Tokens and classifications

Classification is **incremental by default**. An unchanged diff with a cached feature/component/task assignment is not resent. Use **AI Feature Groups: Reclassify Repository…** only when a complete new analysis is necessary. The Output panel shows approximate input token counts based on characters divided by four; this is **not** actual billing or metering. Prompt instructions, metadata, output and the model's internal reasoning add tokens.

A repository's cached manual file assignment overrides later AI suggestions. Diff changes are fingerprinted both before and after the AI request: if the file status/content or branch changed, stale AI output is discarded. Several repositories can be open, but only one repository's diffs are classified per user action. The extension never scans unrelated repositories merely because they are open.

## Privacy and security

**Important: local redaction is best-effort, not a guarantee that sensitive data cannot leave the machine.**

Before any AI request, the extension:

1. Skips known sensitive file paths (`.env*`, `.npmrc`, `.netrc`, `id_rsa`, `id_ed25519`, `.pem`, `.p12`, `.key`, `secrets`, `credentials`, `.git`, `node_modules`) and optional user exclusion globs.
2. Blocks diff excerpts containing recognizable PEM/OpenSSH private-key headers.
3. Redacts entire lines with recognizable credential patterns (for example GitHub tokens, AWS access keys, bearer tokens and certain password or API-key assignments).
4. Applies per-file, per-classification and per-batch bounds. Sends only allowed, redacted diff excerpts; Codex executes in an **empty temporary directory** with `--sandbox read-only` and `--ignore-user-config`.
5. Obtains explicit authorization before a repository sends diffs in this session.

**Limitations:** unknown secret formats, context outside the excerpt, personal information, unusual filenames and proprietary information may still be sent. Do not assume this is a DLP solution. The AI provider's data handling terms apply. **For maximum assurance, disable AI classification for sensitive repositories.**

Use **Command Palette → AI Feature Groups: Preview Classification Data (No AI Request)** to inspect a *local* preview of a **full** reclassification. It does not contact Copilot or Codex. The preview itself can contain sensitive information, so review it locally. The real incremental request usually includes fewer files.

If Codex fails, the extension classifies errors into safe categories such as unavailable model, rate limit, authentication or network failure. **Neither the raw stderr (which may echo prompts) nor model prompts are printed in notifications or logs.** Automatic retries stop for the failing repository until you run classification again.

## Git safety rules

- **Whole file only:** selecting a file includes all of its current content. If one file contains two logical features, use VS Code's native partial staging outside this view or create a manual commit split. This extension does not detect or split hunks.
- **Stage/Unstage:** commands revalidate the Git status of every selected file before modifying the index. If state changed, the operation aborts and the view refreshes.
- **Commit:** the blue button commits **only staged index contents**, never all working files or a feature-based `git commit --only`. The v0.9 `Commit Feature` shortcut was intentionally removed for v1. Use `+` on a group, then the normal commit button.
- **Branch:** changing branches uses the native Git API. Git may reject the switch due to local changes; no force checkout is attempted.
- **Push/Publish/Sync:** each operates on exactly one selected repository and current branch. Publishing sets upstream; Sync pulls then pushes only if pull succeeded. Neither force-push nor automatic conflict resolution is implemented.
- Git hooks, signing, remote authentication and Git configuration still apply.

## Commands

`Classify Repository…`, `Reclassify Repository…`, `Preview Classification Data (No AI Request)`, `Cancel Classification`, `Choose AI Provider`, `Open Settings`, `Refresh`. All commands are prefixed **AI Feature Groups:** in the Command Palette.

## Development and verification

Runtime requires only VS Code's built-in Git extension. The optional real VS Code test harness is a **development dependency** and is **not packaged in the VSIX**.

```sh
npm run check
npm test
python3 scripts/package_vsix.py
```

Optional real-extension-host smoke test (downloads VS Code, needs a GUI or Xvfb and network access):

```sh
npm install
npm run test:vscode
# On Linux headless: xvfb-run -a npm run test:vscode
```

The repository includes GitHub Actions CI for syntax checks, Node/Git integration tests, an actual VS Code Extension Host test and VSIX packaging. `test/vscode` validates startup with two genuine Git repositories and command registration. `scripts/ui_smoke.py` is an optional Chromium Webview visual smoke test if Python Playwright/Chromium are available.

**Validation limitations for this release:** unit/Git tests and Chromium smoke tests were run in the authoring environment; the real VS Code test runner was added but could not run here because the npm/VS Code download was unavailable. Production account Codex/Copilot calls and a live macOS graphical VS Code session must still be checked after installation. These checks are not claimed as already passed.

## Compatibility / limitations

- Requires VS Code `^1.100.0` and working local Git.
- Multiple Git repos in one window are supported, but repositories with identical basenames are still distinguished by their full path internally.
- Git's built-in `Changes` UI cannot be structurally replaced through the supported extension API. This is a standalone Source Control **Webview** that uses the native repository API.
- VS Code Git extension APIs: [repository API](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts). [VS Code Webviews](https://code.visualstudio.com/api/extension-guides/webview). [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension). [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference).

MIT license. Local development extension, not a Marketplace publication.
