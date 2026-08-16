#!/usr/bin/env node
/**
 * UserPromptSubmit: record what was asked. Silent by design, runs async so it
 * adds no latency to the prompt.
 */
import { run } from './_util.mjs';
import { loadConfig, isExcluded } from '../lib/config.mjs';
import { appendEvent, contextFor } from '../lib/ledger.mjs';
import { redact } from '../lib/redact.mjs';

run('user-prompt', async (input) => {
  const sid = input.session_id;
  if (!sid) return null;

  const cfg = loadConfig();
  if (cfg.mode === 'off') return null;

  // An excluded folder leaves no trace, not even locally.
  const ctx = contextFor(sid, input.cwd);
  if (isExcluded(ctx.cwd, ctx.project, cfg)) return null;

  const raw = String(input.user_input ?? input.prompt ?? '').trim();
  if (!raw) return null;

  // Slash commands are harness actions, not statements of intent, with the one
  // exception of the skill itself which we never want echoed into a ticket.
  if (/^\/\w/.test(raw)) return null;

  // Scrub before anything touches disk: the ledger feeds ticket descriptions,
  // and a pasted token would otherwise end up published on a shared board.
  const { text: safe, found } = redact(raw);

  const text = safe.length > cfg.maxPromptChars
    ? `${safe.slice(0, cfg.maxPromptChars).trimEnd()}...`
    : safe;

  appendEvent(sid, { type: 'prompt', text, ...(found.length ? { redacted: found } : {}) });
  return null;
});
