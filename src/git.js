'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

/** Execute Git without invoking a shell. Filenames and messages remain literal argv. */
async function git(root, args, options = {}) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 25_000, ...options
  });
  return stdout;
}

function parsePorcelain(output) {
  const records = output.split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || row.length < 4) continue;
    const xy = row.slice(0, 2);
    if (xy === '!!') continue;
    const filePath = row.slice(3);
    if (!filePath) continue;
    // For porcelain v1 -z a rename/copy is: XY destination\0source\0.
    const isRename = xy.includes('R') || xy.includes('C');
    const originalPath = isRename ? records[++i] : undefined;
    const untracked = xy === '??';
    changes.push({
      path: filePath,
      originalPath: originalPath || undefined,
      xy,
      untracked,
      staged: !untracked && xy[0] !== ' ' && xy[0] !== '?',
      unstaged: untracked || (xy[1] !== ' ' && xy[1] !== '?'),
      conflicted: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy),
      deleted: xy.includes('D')
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function listChanges(root) {
  return parsePorcelain(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
}

// Additional patterns are user-configurable. These baseline exclusions cannot
// be disabled so ordinary sensitive files are not inadvertently transmitted.
const NEVER_SEND = /(?:^|\/)(?:\.env(?:$|[.\w-])|\.git\/|node_modules\/|\.npmrc$|\.pypirc$|\.netrc$|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)|(?:[^/]*\.)?(?:secret|secrets|credentials|credential)(?:[._-]|$)|secrets?\.tfvars(?:\.json)?$)|\.(?:pem|key|p12|pfx|p8|kdbx)$/i;

function globToRegExp(glob) {
  const slash = String(glob).replace(/\\/g, '/');
  const escaped = slash.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '__ANY_DIR__')
    .replace(/\*\*/g, '__STARSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__ANY_DIR__/g, '(?:.*/)?')
    .replace(/__STARSTAR__/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function shouldExclude(relativePath, patterns = []) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (NEVER_SEND.test(normalized)) return true;
  return patterns.some(glob => {
    try {
      const matcher = globToRegExp(glob);
      return matcher.test(normalized) || (!String(glob).includes('/') && matcher.test(path.posix.basename(normalized)));
    } catch {
      return false;
    }
  });
}

function isBinary(text) {
  return text.includes('\0') || /^(Binary files |GIT binary patch|Binary file )/m.test(text);
}

async function getDiff(root, change, maxChars) {
  const paths = change.originalPath && change.originalPath !== change.path
    ? [change.originalPath, change.path] : [change.path];
  let diff;
  let fingerprint;
  if (change.untracked) {
    const file = path.join(root, change.path);
    try {
      const stats = await fs.lstat(file);
      if (!stats.isFile()) return { text: '', reason: 'Symlink or non-regular file' };
      fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
      const handle = await fs.open(file, 'r');
      let bytes;
      try {
        const buffer = Buffer.alloc(Math.min(16384, maxChars * 3));
        const read = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
      diff = `Untracked file: ${change.path}\n` + bytes.toString('utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { text: '', reason: 'File disappeared' };
      throw error;
    }
  } else {
    try {
      diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', 'HEAD', '--', ...paths]);
    } catch (error) {
      // An initial commit has no HEAD. Combine staged and unstaged diffs.
      if (!await hasHead(root)) {
        const staged = await git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...paths]);
        const unstaged = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', ...paths]);
        diff = staged + '\n' + unstaged;
      } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { text: '', reason: 'Diff exceeds local safety limit (8 MB)' };
      } else {
        throw error;
      }
    }
    if (!diff && change.originalPath) diff = `Renamed ${change.originalPath} -> ${change.path}`;
  }
  if (isBinary(diff)) return { text: '', reason: 'Binary content' };
  const clipped = diff.length > maxChars;
  return {
    text: diff.slice(0, maxChars) + (clipped ? '\n[DIFF TRUNCATED]' : ''),
    contentHash: createHash('sha256').update(fingerprint || '').update(diff).digest('hex'),
    reason: undefined
  };
}

/** Read only the index (what a normal Commit would include), never unstaged hunks. */
async function getStagedDiff(root, change, maxChars = 3200) {
  const paths = change.originalPath && change.originalPath !== change.path
    ? [change.originalPath, change.path] : [change.path];
  let text;
  try {
    text = await git(root, [
      'diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color',
      '--unified=2', '--', ...paths
    ]);
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { text: '', reason: 'Diff too large' };
    throw error;
  }
  if (isBinary(text)) return { text: '', reason: 'Binary content' };
  return { text: text.slice(0, maxChars) + (text.length > maxChars ? '\n[DIFF TRUNCATED]' : ''),
    contentHash: createHash('sha256').update(text).digest('hex'), reason: undefined };
}

async function hasHead(root) {
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(changes) {
  return [...new Set(changes.map(c => c.path))];
}

async function stage(root, changes) {
  if (!changes.length) return;
  await git(root, ['add', '--', ...uniquePaths(changes)]);
}

async function unstage(root, changes) {
  if (!changes.length) return;
  const paths = uniquePaths(changes);
  if (await hasHead(root)) {
    await git(root, ['restore', '--staged', '--', ...paths]);
  } else {
    await git(root, ['rm', '--cached', '-r', '--', ...paths]);
  }
}

/** Reject unexpected paths even when called outside of a validated Webview action. */
function insideRepository(root, filename) {
  if (typeof filename !== 'string' || !filename || path.isAbsolute(filename) || filename.includes('\0')) {
    throw new Error('Invalid Git file path.');
  }
  const relative = path.relative(path.resolve(root), path.resolve(root, filename));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Cannot discard changes outside the selected repository.');
  }
  return path.join(root, filename);
}

/**
 * Snapshot the displayed worktree changes, including index entries and file
 * metadata. The UI obtains this before a confirmation dialog and compares it
 * after confirmation to avoid discarding edits made while the dialog was open.
 * This is not a filesystem lock; Git and other editors can still write later.
 */
async function discardSnapshot(root, selected, entireSection = false) {
  const current = (await listChanges(root)).filter(change => change.unstaged);
  if (entireSection && (current.length !== selected.length ||
      current.some(change => !selected.some(old => old.path === change.path && old.xy === change.xy)))) {
    throw new Error('Git changes have updated. Refresh and retry discarding.');
  }
  const checked = [];
  for (const old of selected) {
    insideRepository(root, old.path);
    if (old.originalPath) insideRepository(root, old.originalPath);
    const change = current.find(item => item.path === old.path && item.xy === old.xy && item.unstaged);
    if (!change || change.originalPath !== old.originalPath || change.untracked !== old.untracked) {
      throw new Error('Git changes have updated. Refresh and retry discarding.');
    }
    if (change.conflicted) {
      throw new Error('Resolve merge conflicts separately before discarding changes.');
    }
    checked.push(change);
  }
  const paths = [...new Set(checked.flatMap(item => [item.path, item.originalPath].filter(Boolean)))];
  const index = paths.length ? await git(root, ['ls-files', '--stage', '-z', '--', ...paths]) : '';
  const stats = await Promise.all(paths.map(async filename => {
    try {
      const stat = await fs.lstat(insideRepository(root, filename));
      return [filename, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.ino];
    } catch (error) {
      if (error.code === 'ENOENT') return [filename, 'absent'];
      throw error;
    }
  }));
  return createHash('sha256').update(JSON.stringify({ checked, index, stats })).digest('hex');
}

/**
 * Discard ONLY unstaged changes. Tracked files are restored from the index,
 * never HEAD, to preserve any already staged changes. Untracked files must be
 * moved to Trash by the caller (VS Code workspace.fs.delete({useTrash:true})).
 */
async function discardUnstaged(root, selected, moveToTrash) {
  if (!selected.length) return;
  if (typeof moveToTrash !== 'function') throw new Error('A recoverable Trash operation is required.');
  const tracked = [];
  const untracked = [];
  for (const change of selected) {
    if (!change.unstaged || change.conflicted) throw new Error('Cannot discard staged-only or conflicted changes.');
    insideRepository(root, change.path);
    if (change.originalPath) insideRepository(root, change.originalPath);
    if (change.untracked) {
      untracked.push(change.path);
    } else if (['R', 'C'].includes(change.xy[1]) && change.originalPath) {
      // Worktree-only rename/copy: restore the index path and trash the new path.
      if (change.xy[1] === 'R') tracked.push(change.originalPath);
      untracked.push(change.path);
    } else {
      tracked.push(change.path);
    }
  }
  if (tracked.length) await git(root, ['restore', '--worktree', '--', ...new Set(tracked)]);
  for (const filename of new Set(untracked)) await moveToTrash(insideRepository(root, filename));
}

async function currentBranch(root) {
  try {
    const name = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (name) return name;
  } catch { /* Detached HEAD. */ }
  try {
    return `detached @ ${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()}`;
  } catch { return '(no commits)'; }
}

/** Standard Git commit: includes ONLY the contents of the index. */
async function commitStaged(root, message) {
  if (!message || !message.trim()) throw new Error('Enter a commit message.');
  const changed = await git(root, ['diff', '--cached', '--name-only', '-z']);
  if (!changed) throw new Error('No staged changes to commit. Stage files with + first.');
  await git(root, ['commit', '-m', message.trim()], { timeout: 120_000 });
}

async function readIndexVersion(root, filename) {
  try {
    const source = await git(root, ['show', `:${filename}`], { maxBuffer: 6 * 1024 * 1024 });
    return isBinary(source) ? '[Binary file: diff preview unavailable]' : source;
  } catch { return ''; }
}

async function readHeadVersion(root, filename) {
  try {
    const source = await git(root, ['show', `HEAD:${filename}`], { maxBuffer: 6 * 1024 * 1024 });
    return isBinary(source) ? '[Binary file: diff preview unavailable]' : source;
  } catch {
    return '';
  }
}

module.exports = {
  git, parsePorcelain, listChanges, shouldExclude, globToRegExp,
  getDiff, getStagedDiff, stage, unstage, commitStaged, currentBranch,
  readIndexVersion, readHeadVersion, hasHead, discardSnapshot, discardUnstaged
};
