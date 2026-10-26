'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXTENSION_ID = 'openai.chatgpt';

function bundledRelativePath(platform = process.platform, arch = process.arch) {
  const architectures = { arm64: 'aarch64', x64: 'x86_64' };
  const platforms = { darwin: 'macos', linux: 'linux', win32: 'windows' };
  if (!architectures[arch] || !platforms[platform]) return undefined;
  return path.join('bin', `${platforms[platform]}-${architectures[arch]}`,
    platform === 'win32' ? 'codex.exe' : 'codex');
}

async function isExecutable(file, { stat = fs.stat, access = fs.access, platform = process.platform } = {}) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    // X_OK on POSIX prevents selecting an unusable bundled binary; Windows
    // marks executable files by extension, not by Unix permission bits.
    await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fromPath({ env = process.env, platform = process.platform, stat, access } = {}) {
  const searchPath = env.PATH ?? env.Path ?? '';
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of searchPath.split(delimiter)) {
    // Empty entries refer to the current directory, so skip them rather than
    // accidentally executing a binary from the workspace.
    if (!dir.trim()) continue;
    const candidate = path.join(dir, binary);
    if (await isExecutable(candidate, { stat, access, platform })) return candidate;
  }
  return undefined;
}

async function fromIdeExtension({ extension, platform = process.platform, arch = process.arch, stat, access } = {}) {
  const root = extension?.extensionPath;
  const relative = bundledRelativePath(platform, arch);
  if (!root || !relative) return undefined;
  const candidate = path.join(root, relative);
  if (await isExecutable(candidate, { stat, access, platform })) return candidate;
  return undefined;
}

/**
 * Choose a Codex executable without accessing private extension APIs.
 * An explicitly configured path always takes precedence; an automatic choice
 * is made on each request so extension upgrades do not leave stale paths.
 */
async function resolveCodexExecutable({
  configured = 'auto', extension, env = process.env,
  platform = process.platform, arch = process.arch,
  stat = fs.stat, access = fs.access
} = {}) {
  const preference = typeof configured === 'string' ? configured.trim() : 'auto';
  if (preference && !['auto', 'codex'].includes(preference)) {
    // Support ~/... in user settings. No shell is involved when spawning.
    const fullPath = preference.startsWith('~/') || preference.startsWith('~\\')
      ? path.join(os.homedir(), preference.slice(2))
      : preference;
    if (path.isAbsolute(fullPath) && !await isExecutable(fullPath, { stat, access, platform })) {
      throw new Error('Configured Codex executable does not exist or is not executable. Check aiFeatureGroups.codexExecutablePath.');
    }
    return { executable: fullPath, source: 'configured' };
  }

  const cli = await fromPath({ env, platform, stat, access });
  if (cli) return { executable: cli, source: 'path' };
  const bundled = await fromIdeExtension({ extension, platform, arch, stat, access });
  if (bundled) return { executable: bundled, source: 'ide-extension' };

  throw new Error('Codex executable not found. Install Codex CLI or the official OpenAI Codex VS Code extension, then reload VS Code. You can also set aiFeatureGroups.codexExecutablePath to a full executable path.');
}

module.exports = {
  EXTENSION_ID, bundledRelativePath, fromPath, fromIdeExtension, resolveCodexExecutable
};
