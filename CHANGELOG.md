# Changelog

## v1.0.1 — Marketplace packaging

- Set publisher `Rakhim`, the extension icon and GitHub metadata for Marketplace distribution.
- Package runtime sources, Webview assets, README, license, changelog and icon with the official VS Code packaging tool; exclude development tools and generated files.
- Align CI packaging and the extension-host test with the published extension identity.
- No extension functionality changes.

## v1.0.0 — Stable interface and safety hardening (2026-10-15)

- Added **Open File** (document/arrow) before **Revert** and **Stage** on unstaged files, and before **Unstage** on staged files. Opens the real working-tree file in a separate, non-preview editor tab. Clicking the file row still opens its diff; deleted files receive a clear message rather than opening a nonexistent file.

- Added a **Revert** (back-arrow) button immediately before `+` on each unstaged file and on each repository's `Changes` header. `Staged Changes` never shows Revert. Both operations require explicit confirmation and check for changes while the dialog is open.
- Revert restores tracked files from the Git index (preserving staged content) and moves untracked files to VS Code's Trash. Merge conflicts are refused rather than silently reset. All operations remain repository-scoped.
- Single Source Control Webview, with no duplicate Git providers and independent multi-repo staging/commit/sync controls.
- Removed the advanced `Commit Feature` path: group staging followed by a standard **index-only** commit is the single commit workflow.
- Revalidate Git state before group/file staging; discard AI classifications if files or branches changed during inference.
- Codex failures no longer expose raw stderr / diff prompts. Recognize model, auth, rate and network errors; support request cancellation and configurable timeouts.
- Best-effort local sensitive-line redaction and private-key blocking, plus a no-network payload preview command; explicit per-repo consent retained.
- Incremental AI cache, configurable debounce and hard per-repo file cap to reduce unnecessary token usage; model and reasoning settings preserved.
- Keep manual group assignments pinned. Avoid artificial `General` / `Other changes` hierarchy nodes when there is nothing meaningful to split.
- Added dedicated privacy, provider and Git race regression tests; Chromium UI smoke test; GitHub Actions CI and optional real VS Code extension-host integration harness.
- Known limitation: actual GUI VS Code integration and account-backed providers were not executable in the authoring environment and remain to be verified.

## 0.9.0

- Scope manual, forced and automatic classification to a single explicitly authorized repository; add a Classify action to each repository header.
- Make diff-character budgets per repository rather than pooled across the whole workspace.
- Move the feature detail selector into `aiFeatureGroups.detailLevel` (VS Code User/Workspace Settings); changing it is display-only.
- Add configured Copilot model ID and Codex CLI model/effort options, including clear unsupported-model failures.
- Add large, keyboard-accessible `▾` / `▸` disclosure chevrons for hierarchy nodes and repository headers.
- Preserve the existing multi-repository Git view, commit actions, sync counters and staged-only commit-message generation.
- Add model settings, per-repo isolation, HTML/Webview smoke tests and Codex argument validation tests.

## 0.8.0

- Added three semantic grouping levels: feature, component, implementation task, all inferred in one model request.
- Added persistent compact 1/2/3 detail selector; level switching never triggers AI.
- Added stage/unstage and context menu commit for component/task groups.
- Added manual reassignment of files into components or tasks without model requests.
- Added global workspace diff-context budget (`maxTotalDiffCharsPerClassification`, default 60k characters).
- Made Classify Changes incremental by default, added explicit Reclassify All command for deliberate full rescans.
- Cache fingerprints now include full tracked Git diffs, even when only a truncated excerpt is sent.
- Preserved existing stored feature classifications on upgrade; pinned manual feature names remain intact.
- Added request-size metadata to the extension Output channel, without logging diff contents.
- Added semantic hierarchy, scoped subgroup staging, budget and Chromium UI tests.


## 0.7.0

- Replace the single-star commit generator icon with a **double-sparkle** icon resembling VS Code’s native commit-message action.
- Hide empty `Changes` and `Staged Changes` sections completely; preserve staged-first ordering for nonempty sections.
- Display both sync counts even at zero, **number before arrow**, in incoming/outgoing order: `4 ↓  0 ↑`. Do not pretend zero when a branch has no upstream.
- Give all interactive icon buttons concise, one-word hover tooltips while preserving detailed accessible labels.
- Explain precisely that sensitive-file filtering is based on **names/paths**, not content scanning, both in the consent prompt and README.

## 0.6.0

- Place a **selectable branch name** in each repository header, immediately followed by Sync (`↑/↓`) and Fetch/Refresh. Switch local branches via the native repository Git API without acting on other repositories.
- Add contextual **icons** for each primary action: Commit (check), Publish Branch (cloud arrow), Push (up arrow), Sync Changes (cycle arrows).
- Make the commit textarea **start at one line and auto-grow** for a longer message.
- Add a **sparkle button** inside the commit input to generate a message with the selected Copilot or Codex provider. The prompt contains only safe, bounded staged diffs, never unstaged patches; it requires explicit consent and does not automatically commit.
- Guard against stale AI responses when the staged changes, branch, or draft message have changed during generation.
- Remove distracting repository, section, feature, and staged file-count badges. Keep nonzero Git ahead/behind counts only.
- Add real Git branch checkout, Codex output-schema, staged-diff isolation, and Webview interaction tests.

## 0.5.0

- Show **all Git repositories simultaneously**, in a single collapsible Changes by Feature view. No dropdown or duplicate Git SCM providers.
- Put **Staged Changes** above Changes; use compact numeric counts and remove the `Index only` label.
- Add per-repository **Fetch**, **Push / Publish Branch**, and **Sync** controls plus ahead/upstream (`up`) and behind (`down`) counts.
- Blue primary button switches from **Commit** to **Publish Branch** for committed branches without upstream, **Push** for outgoing commits, and **Sync Changes** for incoming commits.
- Publish with the native `git.push(remote, branch, true)` API (equivalent to `git push -u`); ask which remote to use when several are configured.
- Enforce strict per-repository action scope and avoid pushing after a failed pull.
- Add multi-repository and real bare-remote publication tests.

## 0.4.0

- Replace TreeView with a single themed Webview in Source Control, showing branch, commit text, Commit action, stage/unstage actions, and grouped Git changes together.
- Bind commit text to the existing Git provider's public inputBox; use native Git `commit` API where available.
- Add a compact repository selector for multi-repository workspaces; still no duplicate Git SCM providers.
- Keep AI classification, diff preview, feature staging, file actions, and stored feature assignments.
- Strict CSP, display AI strings as text, and validate all Webview-requested Git operations against current Git changes.

## 0.3.0

- Remove the duplicate `AI Feature Git` source-control provider and support a single TreeView across repositories.

## 0.2.0

- Add Git-like SCM group layout (superseded due to duplicate providers).

## 0.1.0

- Initial AI feature grouping.
