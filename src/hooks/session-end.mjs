#!/usr/bin/env node
/**
 * SessionEnd: last chance to persist. It cannot talk to Claude, so it either
 * writes silently or leaves a marker the next session in this folder surfaces.
 */
import { run } from './_util.mjs';
import { loadConfig, isConfigured, decisionFor, containerFor, logSimulated } from '../lib/config.mjs';
import { createProvider } from '../providers/index.mjs';
import { readState, writeState, summarize, isWorthReporting, describeWork, detectContext } from '../lib/ledger.mjs';
import { mechanicalTitle, mechanicalBody } from '../lib/report.mjs';

run('session-end', async (input) => {
  const sid = input.session_id;
  if (!sid) return null;

  const cfg = loadConfig();
  if (cfg.mode === 'off' || !isConfigured(cfg)) return null;

  const state = readState(sid);
  const ctx = state.cwd ? state : detectContext(input.cwd || process.cwd());
  const decision = decisionFor(ctx.cwd, ctx.project, cfg);
  if (decision.status === 'excluded') return null;

  const summary = summarize(sid, { sinceSeq: state.lastSyncedSeq || 0 });
  if (!isWorthReporting(summary, cfg)) {
    writeState(sid, { endedAt: new Date().toISOString(), endReason: input.reason || '' });
    return null;
  }

  writeState(sid, {
    endedAt: new Date().toISOString(),
    endReason: input.reason || '',
    pending: describeWork(summary),
  });

  // Only the silent style writes without a model in the loop, and only when the
  // destination is already decided.
  if (cfg.writeStyle !== 'silent' || decision.status === 'undecided') return null;

  try {
    const p = createProvider(cfg, { onSimulate: logSimulated });
    if (state.issueId && !state.closed) {
      await p.addComment(state.issueId, mechanicalBody(summary, ctx, { kind: 'comment', limit: cfg.maxCommentChars }));
    } else {
      const containerId = decision.containerId || state.containerId || containerFor(ctx.cwd, ctx.project, cfg);
      if (!containerId) return null;
      const issue = await p.createIssue({
        containerId,
        title: mechanicalTitle(summary, ctx, { prefixProject: containerId === String(cfg.defaultContainer) }),
        body: mechanicalBody(summary, ctx, { kind: 'create', limit: cfg.maxDescriptionChars }),
        labels: cfg.label ? [cfg.label] : [],
        allowCreateLabels: Boolean(cfg.createLabels),
      });
      if (!issue.__dryRun) {
        writeState(sid, {
          issueId: issue.id, issueKey: issue.key, issueTitle: issue.title, issueUrl: issue.url, containerId,
        });
      }
    }
    writeState(sid, { lastSyncedSeq: summary.seq, lastSyncedAt: new Date().toISOString(), pending: null });
  } catch {
    // Keep `pending` set so the next session in this folder can pick it up.
  }
  return null;
});
