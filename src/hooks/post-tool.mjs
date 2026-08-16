#!/usr/bin/env node
/**
 * PostToolUse: record which files were touched and which notable commands ran.
 * Silent, async, cheap.
 */
import { run } from './_util.mjs';
import { loadConfig, isIgnored, isExcluded } from '../lib/config.mjs';
import {
  appendEvent, relativeTo, classifyCommand, parseCommitMessage, parseCommitSha, contextFor,
} from '../lib/ledger.mjs';
import { scrub } from '../lib/redact.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update']);

run('post-tool', async (input) => {
  const sid = input.session_id;
  if (!sid) return null;

  const cfg = loadConfig();
  if (cfg.mode === 'off') return null;

  const cwdCtx = contextFor(sid, input.cwd);
  if (isExcluded(cwdCtx.cwd, cwdCtx.project, cfg)) return null;

  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();

  if (EDIT_TOOLS.has(tool)) {
    const candidates = [
      toolInput.file_path,
      toolInput.notebook_path,
      ...(Array.isArray(toolInput.edits) ? toolInput.edits.map((e) => e.file_path) : []),
    ].filter(Boolean);

    for (const candidate of new Set(candidates)) {
      const rel = relativeTo(cwd, candidate);
      if (!rel || isIgnored(rel, cfg)) continue;
      appendEvent(sid, { type: 'edit', file: rel, tool });
    }
    return null;
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    if (!cfg.trackBash) return null;
    const cmd = String(toolInput.command || '').replace(/\s+/g, ' ').trim();
    if (!cmd) return null;

    const kind = classifyCommand(cmd);
    if (!kind) return null;

    if (kind === 'commit') {
      appendEvent(sid, {
        type: 'commit',
        sha: parseCommitSha(input.tool_output),
        message: scrub(parseCommitMessage(cmd)),
      });
      return null;
    }

    // Commands routinely carry credentials: curl headers, inline env vars,
    // deploy tokens. Same rule as prompts, scrub before it reaches disk.
    const safe = scrub(cmd);
    appendEvent(sid, {
      type: 'bash',
      kind,
      cmd: safe.length > 200 ? `${safe.slice(0, 197)}...` : safe,
    });
  }

  return null;
});
