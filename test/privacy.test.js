'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDiff } = require('../src/privacy');

test('redacts known tokens without echoing the secret in AI context', () => {
  const key = `AKIA${'A'.repeat(16)}`;
  const input = `diff --git a/src/config.ts b/src/config.ts\n+export const key = '${key}';\n+export const safe = 42;`;
  const result = sanitizeDiff(input);
  assert.equal(result.redactedLines, 1);
  assert.doesNotMatch(result.text, /AKIA/);
  assert.match(result.text, /\+\[REDACTED POTENTIAL SECRET\]/);
  assert.match(result.text, /safe = 42/);
});

test('omits entire private-key files instead of exposing parts of a key', () => {
  const result = sanitizeDiff('+-----BEGIN OPENSSH PRIVATE KEY-----\n+not-safe\n+-----END OPENSSH PRIVATE KEY-----');
  assert.equal(result.text, '');
  assert.equal(result.reason, 'Private key content');
});

test('redacts generic credentials and authorization headers', () => {
  const secret = 'very-private-long-secret';
  const result = sanitizeDiff(`+password = "${secret}"\n+Authorization: Bearer ${secret}\n+function fun() {}`);
  assert.equal(result.redactedLines, 2);
  assert.doesNotMatch(result.text, /very-private/);
  assert.match(result.text, /function fun/);
});

test('non-sensitive patches are unchanged; the scanner is not a comprehensive PII detector', () => {
  const diff = '+const exports = await createReport();\n-const exports = createReport();';
  assert.deepEqual(sanitizeDiff(diff), { text: diff, redactedLines: 0, reason: undefined });
});
