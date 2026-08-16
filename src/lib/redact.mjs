/**
 * Secret scrubbing for everything the ledger captures.
 *
 * A user pastes a token into the chat, the prompt hook stores it verbatim, and
 * the next ticket publishes it to a board the whole team reads. That path has
 * to be closed at capture time, not at publish time, so the secret never
 * reaches disk in the first place.
 *
 * Patterns are deliberately anchored on recognisable prefixes and shapes. No
 * generic "long hex string" rule: a 40 character git sha would match it, and a
 * redactor that eats commit hashes gets turned off.
 */

const RULES = [
  // Private key blocks, before anything else can chop them up.
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },

  { name: 'vikunja-token', re: /\btk_[A-Za-z0-9]{16,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-key', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },

  // Credentials embedded in a URL: https://user:secret@host
  { name: 'url-credential', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}[REDACTED:url-credential]@` },

  // Authorization headers, however they were quoted.
  { name: 'auth-header', re: /\b(Authorization\s*:\s*)(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: (_m, prefix, scheme) => `${prefix}${scheme} [REDACTED:auth-header]` },

  // key=value / key: value forms. Requires a secret-ish key name so ordinary
  // prose mentioning the word password is left alone.
  {
    name: 'assigned-secret',
    re: /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|token|secret)["'\s]*[:=]\s*["']?)([^\s"',;)}]{8,})/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED:assigned-secret]`,
  },
];

/**
 * @param {string} text
 * @returns {{text: string, found: string[]}}
 */
export function redact(text) {
  let out = String(text ?? '');
  const found = [];
  for (const rule of RULES) {
    out = out.replace(rule.re, (...matchArgs) => {
      found.push(rule.name);
      return rule.replace ? rule.replace(...matchArgs) : `[REDACTED:${rule.name}]`;
    });
  }
  return { text: out, found: [...new Set(found)] };
}

/** Convenience wrapper for call sites that only want the cleaned string. */
export function scrub(text) {
  return redact(text).text;
}

export function containsSecret(text) {
  return redact(text).found.length > 0;
}
