'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safeProviderFailure, AIRequestError } = require('./ai-errors');
const { EXTENSION_ID, resolveCodexExecutable } = require('./codex-discovery');

const commitMessageSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false
};

const outputSchema = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, group: { type: 'string' },
          component: { type: 'string' }, task: { type: 'string' } },
        required: ['path', 'group', 'component', 'task'],
        additionalProperties: false
      }
    }
  },
  required: ['assignments'],
  additionalProperties: false
};

class CopilotProvider {
  constructor() { this.model = undefined; }


  async authorize() {
    // Explicit user interaction only: VS Code prompts the user for permission.
    const configuredId = vscode.workspace.getConfiguration('aiFeatureGroups').get('copilotModelId', '').trim();
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models.length) {
      throw new Error('No Copilot model found. Sign in to GitHub Copilot, or choose the Codex provider.');
    }
    if (configuredId) {
      const configured = models.find(model => model.id === configuredId);
      if (!configured) {
        throw new Error(`Copilot model "${configuredId}" is unavailable. Available IDs: ${models.map(m => m.id).join(', ')}`);
      }
      this.model = configured;
      return;
    }
    // Default behavior is backward-compatible: interactive selection when
    // multiple accessible models exist; no token-consuming probe is required.
    if (this.model && models.some(m => m.id === this.model.id)) {
      this.model = models.find(m => m.id === this.model.id);
      return;
    }
    if (models.length === 1) {
      this.model = models[0];
      return;
    }
    const selected = await vscode.window.showQuickPick(models.map(model => ({
      label: model.name || model.id,
      description: model.id,
      detail: `Maximum input: ${model.maxInputTokens ?? 'unknown'} tokens`,
      model
    })), { placeHolder: 'Choose the Copilot model for Git change classification' });
    if (!selected) throw new Error('Model selection cancelled');
    this.model = selected.model;
  }

  async classify(prompt, token) { return this.request(prompt, token); }

  async generateCommitMessage(prompt, token) { return this.request(prompt, token); }

  async request(prompt, token) {
    if (!this.model) throw new Error('Copilot has not been authorized this session. Run Classify Changes or use Generate Commit Message.');
    try {
      const answer = await this.model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)], {}, token
      );
      let text = '';
      for await (const part of answer.text) {
        if (token.isCancellationRequested) throw new AIRequestError('AI request cancelled.', 'AI_CANCELLED');
        text += part;
        if (text.length > 200_000) throw new AIRequestError('Model output exceeds safety limit.', 'AI_OUTPUT_TOO_LARGE');
      }
      return text;
    } catch (error) {
      if (error instanceof AIRequestError) throw error;
      if (token.isCancellationRequested) throw new AIRequestError('AI request cancelled.', 'AI_CANCELLED');
      throw new AIRequestError(safeProviderFailure(error?.message || '', 'Copilot'), 'AI_PROVIDER_FAILURE');
    }
  }
}

class CodexCliProvider {
  async authorize() {
    // Verify local availability without sending diffs or contacting any model.
    // The IDE extension's binary shares the usual Codex home, but authentication
    // is still checked by Codex when a real request is made.
    await this.findExecutable();
  }

  async findExecutable() {
    const preference = vscode.workspace.getConfiguration('aiFeatureGroups')
      .get('codexExecutablePath', 'auto');
    const extension = vscode.extensions?.getExtension(EXTENSION_ID);
    return resolveCodexExecutable({ configured: preference, extension });
  }

  async classify(prompt, token) { return this.request(prompt, token, outputSchema); }

  async generateCommitMessage(prompt, token) { return this.request(prompt, token, commitMessageSchema); }

  async request(prompt, token, schema) {
    // Resolve again for each request: updating the official Codex extension
    // changes its installation path, but should not require editing settings.
    const { executable } = await this.findExecutable();
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-feature-groups-'));
    const schemaFile = path.join(temp, 'schema.json');
    const outputFile = path.join(temp, 'answer.json');
    try {
      await fs.writeFile(schemaFile, JSON.stringify(schema));
      const config = vscode.workspace.getConfiguration('aiFeatureGroups');
      const model = config.get('codexModel', '').trim();
      const reasoningEffort = config.get('codexReasoningEffort', 'default');
      const timeoutMs = config.get('aiRequestTimeoutMs', 120000);
      await runCodex(executable, temp, schemaFile, outputFile, prompt, token, { model, reasoningEffort, timeoutMs });
      let size;
      try { size = (await fs.stat(outputFile)).size; }
      catch { throw new AIRequestError('Codex finished without writing a structured response.', 'AI_OUTPUT_MISSING'); }
      if (size > 500000) throw new AIRequestError('Codex output exceeds safety limit.', 'AI_OUTPUT_TOO_LARGE');
      return await fs.readFile(outputFile, 'utf8');
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}

function codexModelArguments({ model = '', reasoningEffort = 'default' } = {}) {
  const args = [];
  if (model) {
    // Arguments are passed directly to spawn; also reject invalid model IDs
    // rather than accepting whitespace or unexpected option-like strings.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model)) {
      throw new Error('Invalid Codex model ID in aiFeatureGroups.codexModel.');
    }
    args.push('--model', model);
  }
  const valid = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  if (!valid.has(reasoningEffort)) {
    throw new Error('Invalid aiFeatureGroups.codexReasoningEffort setting.');
  }
  if (reasoningEffort !== 'default') {
    // Only Codex CLI exposes a documented per-request effort override.
    args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  return args;
}

function runCodex(executable, cwd, schemaFile, outputFile, prompt, token, options = {}) {
  return new Promise((resolve, reject) => {
    // Never run Codex inside the user's project. It receives only filtered diffs
    // on stdin and has a separate empty cwd with a read-only sandbox.
    const argv = [
      'exec', '-C', cwd, '--skip-git-repo-check', '--sandbox', 'read-only',
      ...codexModelArguments(options),
      '--ignore-user-config', '--ephemeral', '--output-schema', schemaFile,
      '--output-last-message', outputFile, '-'
    ];
    const child = spawn(executable, argv, {
      cwd, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true
    });
    let stderr = '';
    let didTimeout = false;
    let didCancel = false;
    const timeoutMs = Math.max(5000, Math.min(300000, Number(options.timeoutMs) || 120000));
    let hardKill;
    const terminate = () => {
      child.kill();
      hardKill = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1500);
      hardKill.unref?.();
    };
    const deadline = setTimeout(() => { didTimeout = true; terminate(); }, timeoutMs);
    const cancellation = token.onCancellationRequested(() => { didCancel = true; terminate(); });
    // Codex can echo the entire prompt (including diffs) on stderr. Never log
    // or surface this buffer directly: inspect only coarse error categories.
    child.stderr.on('data', piece => { stderr = (stderr + piece.toString()).slice(-12000); });
    child.stdin.on('error', () => {}); // Process can close stdin after spawn error.
    child.stdin.end(prompt);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(hardKill);
      cancellation.dispose();
      if (error) reject(error);
      else resolve();
    };
    child.on('error', error => {
      finish(new AIRequestError(error?.code === 'ENOENT' ?
        'Codex executable could not be launched. Check the Codex CLI installation or the official Codex VS Code extension.' :
        'Cannot launch Codex CLI. Check its installation and permissions.', 'AI_LAUNCH_FAILURE'));
    });
    child.on('close', code => {
      if (didTimeout) return finish(new AIRequestError(`Codex request timed out (${Math.round(timeoutMs / 1000)}s).`, 'AI_TIMEOUT'));
      if (didCancel || token.isCancellationRequested) return finish(new AIRequestError('AI request cancelled.', 'AI_CANCELLED'));
      if (code !== 0) return finish(new AIRequestError(`${safeProviderFailure(stderr, 'Codex')} (exit ${Number.isInteger(code) ? code : 'unknown'}).`, 'AI_PROVIDER_FAILURE'));
      finish();
    });
  });
}

module.exports = { CopilotProvider, CodexCliProvider, outputSchema, commitMessageSchema, codexModelArguments, runCodex };
