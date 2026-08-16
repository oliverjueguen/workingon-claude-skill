#!/usr/bin/env node
/**
 * SessionStart: prepare the ledger and say whether this folder already has a
 * ticket, or no decision yet.
 */
import { run, context } from './_util.mjs';
import { loadConfig, isConfigured, decisionFor, CONFIG_PATH } from '../lib/config.mjs';
import { writeState, readState, detectContext, findLinkedSessionFor, pruneOldSessions, summarize } from '../lib/ledger.mjs';
import { detectSpecKit } from '../lib/speckit.mjs';

run('session-start', async (input) => {
  const sid = input.session_id;
  if (!sid) return null;

  const cfg = loadConfig();
  if (cfg.mode === 'off') return null;

  const ctx = detectContext(input.cwd || process.cwd());
  const decision = decisionFor(ctx.cwd, ctx.project, cfg);

  // Excluded folder: no state, no context, no trace.
  if (decision.status === 'excluded') return null;

  const speckit = detectSpecKit(ctx.cwd, { branch: ctx.branch });
  const previous = readState(sid);

  writeState(sid, {
    cwd: ctx.cwd,
    project: ctx.project,
    branch: ctx.branch,
    repoRoot: ctx.repoRoot,
    containerId: decision.containerId || previous.containerId || null,
    speckitFeature: speckit?.activeFeature || null,
    startedAt: previous.startedAt || new Date().toISOString(),
  });

  pruneOldSessions(30);

  // A compact restarts the session but not the work: stay quiet.
  if (input.source === 'compact') return null;

  const lines = [];

  if (!isConfigured(cfg)) {
    if (!cfg.quiet) {
      lines.push(`[workingon] Not set up yet. Run \`workingon setup\` (config lives in ${CONFIG_PATH}). Nothing is being recorded.`);
    }
    return lines.length ? context('SessionStart', lines.join('\n')) : null;
  }

  const state = readState(sid);
  if (state.issueId && !state.closed) {
    const pending = summarize(sid, { sinceSeq: state.lastSyncedSeq || 0 });
    lines.push(`[workingon] Ticket for this session: ${state.issueKey || state.issueId} "${state.issueTitle}" (${state.issueUrl}).`);
    if (pending.unsynced.files.length || pending.unsynced.commits.length) lines.push('It has work not recorded yet.');
  } else {
    const earlier = findLinkedSessionFor(ctx.cwd, { excludeSessionId: sid });
    if (earlier) {
      lines.push(`[workingon] An earlier session in this folder left ${earlier.issueKey || earlier.issueId} "${earlier.issueTitle}" open (${earlier.issueUrl}).`);
      lines.push('If today continues that work, link it with the `workingon` skill instead of creating a new ticket.');
    }
  }

  if (decision.status === 'undecided' && !cfg.quiet) {
    lines.push(`[workingon] No decision yet on whether work in "${ctx.project}" is recorded. You will be asked before anything is written.`);
  }

  if (speckit?.activeFeature) {
    lines.push(`[workingon] Active SpecKit feature: ${speckit.activeFeature}${speckit.title ? ` ("${speckit.title}")` : ''}, ${speckit.openTasks.length} open tasks in tasks.md.`);
  }

  return lines.length ? context('SessionStart', lines.join('\n')) : null;
});
