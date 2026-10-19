'use strict';

/**
 * Provider diagnostics can contain a full prompt/diff (Codex echoes stdin on
 * stderr). Never include provider stderr or unknown exception messages in a
 * notification, output channel, or telemetry. Match categories only.
 */
function safeProviderFailure(raw = '', provider = 'AI') {
  const value = String(raw).slice(-15000);
  if (/\b(?:429|rate[_ -]?limit|quota|too many requests|usage limit)\b/i.test(value)) {
    return `${provider} rate or usage limit reached. Retry later or change the model.`;
  }
  if (/\b(?:unknown model|model not found|model does not exist|unsupported model|model .*not supported|model .*not available|model .*not accessible|model .*does not exist)\b/i.test(value)) {
    return `${provider} model unavailable. Check the configured model ID or leave it empty to use the default.`;
  }
  if (/\b(?:401|not logged in|authentication failed|authentication required|login required|invalid api key)\b/i.test(value)) {
    return `${provider} authentication failed. Reauthenticate with Codex CLI or Copilot.`;
  }
  if (/\b(?:403|permission denied|access denied|not authorized)\b/i.test(value)) {
    return `${provider} permission denied. Check your account and model access.`;
  }
  if (/\b(?:ECONNRESET|ENOTFOUND|ETIMEDOUT|connection refused|network error|connection error)\b/i.test(value)) {
    return `${provider} network error. Check connectivity and retry.`;
  }
  return `${provider} request failed. Verify the selected model and authentication; check the CLI directly for diagnostics.`;
}

function isCancellation(error) {
  return Boolean(error && (error.code === 'AI_CANCELLED' || error.name === 'CancellationError'));
}

class AIRequestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AIRequestError';
    this.code = code;
  }
}

module.exports = { safeProviderFailure, isCancellation, AIRequestError };
