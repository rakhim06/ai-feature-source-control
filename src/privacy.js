'use strict';

/**
 * Conservative, local-only redaction of *diff excerpts* before they reach an AI.
 * This is defense in depth, NOT a secret scanner or a guarantee that every
 * credential / personal datum is removed. High-risk private-key content causes
 * the entire file to be omitted instead of sending partially redacted keys.
 */
const PRIVATE_KEY_BLOCK = /-----BEGIN\s+(?:[A-Z0-9 ]+\s)?PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----/i;
const HIGH_CONFIDENCE = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{15,}\b/,
  /\b(?:sk-proj-|sk-svcacct-|sk-)[A-Za-z0-9_-]{20,}\b/,
  /\b(?:npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{15,})\b/,
  /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=-]{12,}/i,
  /\b(?:password|passwd|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|aws_secret_access_key|authorization)\b\s*["']?\s*[:=]\s*["']?[^\s"'`,;}{]{4,}/i,
  /\b(?:secret|token|credentials)\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._/+\-=]{12,}/i
];

function sanitizeDiff(input) {
  const diff = typeof input === 'string' ? input : '';
  if (PRIVATE_KEY_BLOCK.test(diff)) {
    return { text: '', reason: 'Private key content', redactedLines: 0 };
  }
  let redactedLines = 0;
  const text = diff.split('\n').map(line => {
    if (!HIGH_CONFIDENCE.some(pattern => pattern.test(line))) return line;
    redactedLines++;
    // Preserve only the Git diff line marker; avoid leaking any part of a
    // credential-containing line, including a potentially sensitive prefix.
    return /^[+-](?![+-])/.test(line) ? `${line[0]}[REDACTED POTENTIAL SECRET]` : '[REDACTED POTENTIAL SECRET]';
  }).join('\n');
  return { text, redactedLines, reason: undefined };
}

module.exports = { sanitizeDiff };
