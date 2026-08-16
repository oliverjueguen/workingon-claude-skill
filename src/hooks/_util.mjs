/**
 * Shared plumbing for the workingon hooks.
 *
 * Rule number one: a hook must never break a Claude Code session. Every entry
 * point swallows its own errors and exits 0 unless it deliberately wants to
 * speak to Claude.
 */
import { log } from '../lib/config.mjs';

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function emit(payload) {
  if (payload) process.stdout.write(JSON.stringify(payload));
}

export function context(eventName, additionalContext, extra = {}) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext, ...extra } };
}

/**
 * Wrap a hook body. Any throw is logged and swallowed so the session continues.
 */
export async function run(name, fn) {
  try {
    const input = await readStdin();
    const result = await fn(input);
    if (result) emit(result);
  } catch (err) {
    log(`[${name}] error:`, err?.stack || String(err));
  }
  // Deliberately no process.exit(): forcing an exit while undici still holds
  // sockets trips a libuv assertion on Windows. Natural shutdown costs ~40ms.
  process.exitCode = 0;
}
