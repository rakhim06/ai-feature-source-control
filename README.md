# AI Feature Source Control

Organize your Git changes by feature, directly in VS Code.

When you're working on several things at once, the Source Control panel can get messy. Files related to the same change might be spread across different folders, making it harder to see what belongs together.

AI Feature Source Control adds a **Changes by Feature** view that groups modified files based on their purpose. It uses OpenAI Codex or GitHub Copilot to suggest the groups, and you can adjust them yourself.

## What it looks like

Say you've been working on an export feature and fixed an unrelated validation issue. Instead of seeing all the modified files in one list, you get something like this:

```text
Changes by Feature

▾ feat: Asynchronous data exports
    ▾ Export API
        exports.controller.ts
        exports.service.ts
    ▾ Background processing
        export-worker.ts

▾ fix: Request validation
    validation.ts
    validation.test.ts

▾ chore: Update dependencies
    package.json
```

You can choose how much detail to display: features only, features with components, or features with individual tasks.

The grouping is generated once and reused when you switch between detail levels.

## Work with your changes

The extension includes the Git actions you'd normally use in Source Control:

- **Stage and unstage** individual files or entire groups.
- **Review diffs or open files** directly from the tree.
- **Commit, push, pull and publish branches** without leaving the view.
- **Generate commit messages** from staged changes using your selected AI provider.
- **Manage multiple repositories** in the same window, each with its own branch and Git actions.

You can also discard changes, switch branches, and manually move files between groups when the AI gets something wrong.

Everything works with your existing Git repositories. The built-in Source Control view remains available.

## Getting started

Install **AI Feature Source Control** from the VS Code Marketplace, then open the Source Control panel.

You'll find a new section called **Changes by Feature**.

Choose your AI provider in the extension settings:

**GitHub Copilot** uses the models available through VS Code's Language Model API.

**OpenAI Codex** uses a Codex executable, either installed separately or bundled with the official Codex VS Code extension.

Click the sparkle icon next to a repository to classify its changes. The extension will ask for permission before sending any diffs to the selected provider.

Once classified, you can browse your changes, adjust the groups and stage files as usual.

## Using Codex

Starting with v1.1.0, the extension can automatically find Codex on your machine.

It checks the following locations:

1. A custom executable path, if you've configured one.
2. The Codex CLI available in your system PATH.
3. The executable bundled with the official OpenAI Codex VS Code extension.

If you already have Codex installed in VS Code, you may not need to install the CLI separately.

To use automatic detection, set:

```json
{
  "aiFeatureGroups.provider": "codex",
  "aiFeatureGroups.codexExecutablePath": "auto"
}
```

You can leave the executable path setting at its existing default as well. No additional configuration is needed when Codex is detected successfully.

If automatic detection fails, you can still provide the full path to your Codex executable:

```json
{
  "aiFeatureGroups.codexExecutablePath": "/opt/homebrew/bin/codex"
}
```

The executable must be authenticated and support the CLI options used by this extension.

**Note:** The Codex binary bundled with the official VS Code extension is an implementation detail, not a public integration API. Its location or behavior may change in future Codex updates.

## Settings

You can configure the model, reasoning effort (when supported), classification detail and how much context gets sent to the AI.

For example:

```json
{
  "aiFeatureGroups.provider": "codex",
  "aiFeatureGroups.codexExecutablePath": "auto",
  "aiFeatureGroups.codexReasoningEffort": "medium",
  "aiFeatureGroups.detailLevel": 2,
  "aiFeatureGroups.autoClassify": false,
  "aiFeatureGroups.maxDiffCharsPerFile": 1200,
  "aiFeatureGroups.maxTotalDiffCharsPerClassification": 40000
}
```

Classification is incremental, so unchanged diffs with cached results don't need to be analyzed again. You can also disable automatic classification if you'd rather control when AI requests happen.

## Privacy

Before sending diffs to your AI provider, the extension excludes common sensitive files and attempts to redact recognizable credentials.

Only limited diff excerpts are submitted for classification, and you can configure additional file exclusions.

These protections aren't exhaustive. Sensitive information can still appear in a diff, so avoid classifying repositories containing information you can't share with your AI provider.

A local preview command lets you inspect classification data without making an AI request.

## Current limitations

Grouping works at the file level. If a file contains changes for two different features, it will still appear in one group.

Staging a file includes all its changes. For partial staging, you can continue using VS Code's built-in Git tools.

AI classifications are suggestions, so you may occasionally need to move files into a different group.

## Feedback

The extension is open source. Issues, bug reports and contributions are welcome.

[GitHub repository](https://github.com/rakhim06/ai-feature-source-control) · [Report an issue](https://github.com/rakhim06/ai-feature-source-control/issues)

MIT License.