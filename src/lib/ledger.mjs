import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SESSIONS_DIR, loadConfig, isIgnored } from './config.mjs';

/**
 * Per-session work ledger.
 *
 * Events go to an append-only JSONL file: several hooks (some of them async)
 * write concurrently, and a single `appendFileSync` of a short line is the only
 * write pattern that stays consistent without a lock. Mutable bookkeeping lives
 * in a separate small state file that only one hook writes at a time.
 */

const safeId = (sessionId) => String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');

export const eventsPath = (sid) => path.join(SESSIONS_DIR, `${safeId(sid)}.jsonl`);
export const statePath = (sid) => path.join(SESSIONS_DIR, `${safeId(sid)}.state.json`);

function ensureDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function appendEvent(sid, event) {
  ensureDir();
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  fs.appendFileSync(eventsPath(sid), line + '\n', 'utf8');
}

export function readEvents(sid) {
  try {
    return fs.readFileSync(eventsPath(sid), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readState(sid) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sid), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(sid, patch) {
  ensureDir();
  const next = { ...readState(sid), ...patch, sessionId: sid, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath(sid), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// --- git / project detection ------------------------------------------------

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function detectContext(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const repoRoot = root ? root.replace(/\\/g, '/') : '';
  const name = repoRoot ? path.basename(repoRoot) : path.basename(cwd.replace(/[\\/]+$/, ''));
  return { cwd: String(cwd).replace(/\\/g, '/'), repoRoot, branch: branch || '', project: name };
}

export function currentHead(cwd) {
  return git(cwd, ['rev-parse', '--short', 'HEAD']);
}

/**
 * Session context without paying for git on every call.
 *
 * SessionStart already resolved the repository and branch and stored them, so
 * the hooks that fire constantly read from there. git is only consulted when
 * there is no state, which happens when the install came after the session
 * started.
 */
export function contextFor(sid, cwdFallback) {
  const state = readState(sid);
  if (state.cwd) return { cwd: state.cwd, project: state.project, branch: state.branch || '' };
  return detectContext(cwdFallback || process.cwd());
}

// --- capture helpers --------------------------------------------------------

/** Bash commands worth remembering. Everything else is noise. */
const NOTABLE = [
  { re: /\bgit\s+commit\b/, kind: 'commit' },
  { re: /\bgit\s+push\b/, kind: 'push' },
  { re: /\bgit\s+(merge|rebase|revert|cherry-pick|tag)\b/, kind: 'git' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|deploy|publish)\b/, kind: 'build' },
  { re: /\b(pytest|jest|vitest|mocha|go\s+test|cargo\s+test|dotnet\s+test|phpunit)\b/, kind: 'test' },
  { re: /\b(docker|docker-compose|kubectl|helm|terraform|ansible|serverless|vercel|fly|wrangler)\b/, kind: 'deploy' },
  { re: /\b(alembic|prisma|drizzle-kit|knex|flyway|liquibase)\b/, kind: 'migration' },
  { re: /\bmake\s+\w+/, kind: 'build' },
];

export function classifyCommand(cmd) {
  const text = String(cmd || '');
  for (const { re, kind } of NOTABLE) if (re.test(text)) return kind;
  return null;
}

export function parseCommitMessage(cmd) {
  const m = String(cmd).match(/-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|<<'?\w+'?\n([\s\S]*?)\n\w+)/);
  if (!m) return '';
  return (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\"/g, '"').split('\n')[0].trim();
}

export function parseCommitSha(toolOutput) {
  const m = String(toolOutput || '').match(/^\[[\w./-]+\s+(?:\(root-commit\)\s+)?([0-9a-f]{7,40})\]/m);
  return m ? m[1] : '';
}

export function relativeTo(cwd, filePath) {
  if (!filePath) return '';
  const abs = String(filePath).replace(/\\/g, '/');
  const base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && abs.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    return abs.slice(base.length + 1);
  }
  return abs;
}

// --- summarisation ----------------------------------------------------------

/**
 * Fold the event log into something both the Stop hook and the skill can reason
 * about. `sinceSeq` lets callers ask only about work that has not been reported
 * to the ticketing tool yet.
 */
export function summarize(sid, { sinceSeq = 0 } = {}) {
  const cfg = loadConfig();
  const all = readEvents(sid);
  const fresh = all.slice(sinceSeq);

  const fold = (events) => {
    const prompts = [];
    const files = new Map();
    const commands = [];
    const commits = [];
    for (const ev of events) {
      switch (ev.type) {
        case 'prompt':
          if (ev.text) prompts.push({ t: ev.t, text: ev.text });
          break;
        case 'edit':
          if (ev.file && !isIgnored(ev.file, cfg)) {
            files.set(ev.file, (files.get(ev.file) || 0) + 1);
          }
          break;
        case 'bash':
          commands.push({ t: ev.t, cmd: ev.cmd, kind: ev.kind });
          break;
        case 'commit':
          commits.push({ t: ev.t, sha: ev.sha, message: ev.message });
          break;
      }
    }
    return {
      prompts,
      files: [...files.entries()].map(([file, edits]) => ({ file, edits }))
        .sort((a, b) => b.edits - a.edits),
      commands,
      commits,
    };
  };

  return {
    seq: all.length,
    sinceSeq,
    total: fold(all),
    unsynced: fold(fresh),
  };
}

/** Does the unsynced work clear the bar for a ticket? */
export function isWorthReporting(summary, cfg = loadConfig()) {
  const u = summary.unsynced;
  if (u.commits.length > 0) return true;
  if (u.files.length >= cfg.minEdits) return true;
  if (u.files.length >= 1 && u.prompts.length >= cfg.minPrompts &&
      u.commands.some((c) => c.kind === 'test' || c.kind === 'build' || c.kind === 'deploy')) {
    return true;
  }
  return false;
}

export function describeWork(summary) {
  const u = summary.unsynced;
  const bits = [];
  if (u.files.length) bits.push(`${u.files.length} file${u.files.length === 1 ? '' : 's'}`);
  if (u.commits.length) bits.push(`${u.commits.length} commit${u.commits.length === 1 ? '' : 's'}`);
  if (u.commands.length) bits.push(`${u.commands.length} command${u.commands.length === 1 ? '' : 's'}`);
  return bits.join(', ') || 'no changes';
}

/** Find a recent session in the same working directory that has a linked ticket. */
export function findLinkedSessionFor(cwd, { excludeSessionId, maxAgeHours = 72 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.state.json'));
  } catch {
    return null;
  }
  const target = String(cwd).replace(/\\/g, '/').toLowerCase();
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const candidates = [];
  for (const f of files) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (!state.issueId) continue;
      if (state.closed) continue;
      if (state.sessionId === excludeSessionId) continue;
      if (String(state.cwd || '').toLowerCase() !== target) continue;
      const ts = Date.parse(state.updatedAt || 0);
      if (!ts || ts < cutoff) continue;
      candidates.push({ ...state, _ts: ts });
    } catch { /* ignore unreadable state files */ }
  }
  candidates.sort((a, b) => b._ts - a._ts);
  return candidates[0] || null;
}

/** Delete session files older than `days`. Called opportunistically at session start. */
export function pruneOldSessions(days = 30) {
  const cutoff = Date.now() - days * 86400 * 1000;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      const p = path.join(SESSIONS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
