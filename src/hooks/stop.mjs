#!/usr/bin/env node
/**
 * Stop: the end of a turn is when we know whether real work happened.
 *
 * writeStyle "nudge"  -> hand the decision back to Claude, who has the full
 *                        context and can word a ticket a human wants to read.
 * writeStyle "silent" -> write a factual entry here and never interrupt.
 */
import { run, context } from './_util.mjs';
import { loadConfig, isConfigured, decisionFor, containerFor, logSimulated } from '../lib/config.mjs';
import { createProvider } from '../providers/index.mjs';
import { readState, writeState, summarize, isWorthReporting, describeWork, detectContext } from '../lib/ledger.mjs';
import { mechanicalTitle, mechanicalBody } from '../lib/report.mjs';

run('stop', async (input) => {
  const sid = input.session_id;
  if (!sid) return null;

  // Claude Code is already continuing because of a stop hook. Never chain.
  if (input.stop_hook_active) return null;

  const cfg = loadConfig();
  if (cfg.mode === 'off' || !isConfigured(cfg)) return null;

  // The session is paused waiting on background work, not finished.
  if (Array.isArray(input.background_tasks) && input.background_tasks.length) return null;

  const state = readState(sid);
  const summary = summarize(sid, { sinceSeq: state.lastSyncedSeq || 0 });
  if (!isWorthReporting(summary, cfg)) return null;

  // Debounce, in three layers.
  const syncedSeq = state.lastSyncedSeq || 0;
  const nudgedSeq = state.nudgedSeq || 0;
  // 1. Never say the same thing twice about the same work.
  if (summary.seq <= nudgedSeq) return null;
  // 2. Leave room between notifications, counting from whichever came last.
  const lastTouch = Math.max(Date.parse(state.nudgedAt || 0) || 0, Date.parse(state.lastSyncedAt || 0) || 0);
  const elapsed = lastTouch ? (Date.now() - lastTouch) / 1000 : Infinity;
  if (elapsed < cfg.debounceSeconds) return null;
  // 3. If the previous nudge was ignored, demand clearly more work before
  //    speaking up again, so an unwanted ticket is not nagged for.
  if (nudgedSeq > syncedSeq && summary.seq - nudgedSeq < cfg.minEdits) return null;

  const ctx = state.cwd ? state : detectContext(input.cwd || process.cwd());
  const decision = decisionFor(ctx.cwd, ctx.project, cfg);

  // Nothing is ever recorded from an excluded folder.
  if (decision.status === 'excluded') return null;

  // A folder nobody has decided about: ask, do not assume yes.
  if (decision.status === 'undecided') {
    writeState(sid, { nudgedSeq: summary.seq, nudgedAt: new Date().toISOString() });
    return context('Stop', [
      `[workingon] There is unrecorded work in "${ctx.project}", a folder with no decision yet about whether it goes to the ticketing tool.`,
      'Before writing anything, use AskUserQuestion to ask whether work in this folder should be recorded.',
      'Then save the answer with the `workingon` skill so the question is not repeated: either a destination, or exclude the folder if it is private.',
      'If they exclude it, nothing more is captured from that folder, not even locally.',
    ].join('\n'));
  }

  if (cfg.writeStyle === 'silent') return silentWrite({ sid, cfg, state, summary, ctx, decision });

  writeState(sid, { nudgedSeq: summary.seq, nudgedAt: new Date().toISOString() });

  const lines = [
    `[workingon] Unrecorded work: ${describeWork(summary)}, in "${ctx.project}"${ctx.branch ? ` (branch ${ctx.branch})` : ''}.`,
  ];
  if (state.issueId && !state.closed) {
    lines.push(`Linked ticket: ${state.issueKey || state.issueId} "${state.issueTitle}".`);
    lines.push('Use the `workingon` skill to add a short progress comment to it. If this is a different topic, create a new ticket instead.');
  } else {
    lines.push('Use the `workingon` skill to create the ticket, or link an existing one if it already covers this.');
  }
  lines.push('Record only what was done, do not redo work, and end the turn with one short line naming the ticket.');
  return context('Stop', lines.join('\n'));
});

async function silentWrite({ sid, cfg, state, summary, ctx, decision }) {
  try {
    const p = createProvider(cfg, { onSimulate: logSimulated });
    const containerId = decision.containerId || state.containerId || containerFor(ctx.cwd, ctx.project, cfg);

    if (state.issueId && !state.closed) {
      await p.addComment(state.issueId, mechanicalBody(summary, ctx, { kind: 'comment', limit: cfg.maxCommentChars }));
      writeState(sid, { lastSyncedSeq: summary.seq, lastSyncedAt: new Date().toISOString() });
      return cfg.quiet ? null : { systemMessage: `[workingon] Progress added to ${state.issueKey || state.issueId}.` };
    }

    if (!containerId) {
      return cfg.quiet ? null
        : { systemMessage: `[workingon] No destination for "${ctx.project}". Map it with \`workingon config --map\`.` };
    }

    const issue = await p.createIssue({
      containerId,
      title: mechanicalTitle(summary, ctx, { prefixProject: containerId === String(cfg.defaultContainer) }),
      body: mechanicalBody(summary, ctx, { kind: 'create', limit: cfg.maxDescriptionChars }),
      labels: cfg.label ? [cfg.label] : [],
      allowCreateLabels: Boolean(cfg.createLabels),
    });

    if (issue.__dryRun) {
      writeState(sid, { containerId, lastSyncedSeq: summary.seq, lastSyncedAt: new Date().toISOString() });
      return cfg.quiet ? null : { systemMessage: '[workingon] Simulation mode: the ticket was logged, not created.' };
    }

    writeState(sid, {
      issueId: issue.id, issueKey: issue.key, issueTitle: issue.title, issueUrl: issue.url,
      containerId, lastSyncedSeq: summary.seq, lastSyncedAt: new Date().toISOString(), closed: false,
    });
    return cfg.quiet ? null : { systemMessage: `[workingon] Created ${issue.key}: ${issue.title}` };
  } catch (err) {
    // Do not lose the work: leave it unsynced so the next turn retries.
    writeState(sid, { lastError: String(err.message || err), lastErrorAt: new Date().toISOString() });
    return cfg.quiet ? null : { systemMessage: `[workingon] Could not write to the ticketing tool: ${err.message}` };
  }
}
