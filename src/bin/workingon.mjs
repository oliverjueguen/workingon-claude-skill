#!/usr/bin/env node
/**
 * workingon: bridges a Claude Code session and a ticketing tool.
 *
 * Used by the `workingon` skill and by the Stop hook. Every command prints one
 * short human readable block by default, and full JSON with --json.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, saveCredentials, isConfigured, containerFor, decisionFor,
  CONFIG_PATH, HOME, SESSIONS_DIR, DRY_RUN_LOG, logSimulated,
} from '../lib/config.mjs';
import { PROVIDERS, getProviderClass, createProvider, describeProviders } from '../providers/index.mjs';
import { summarize, readState, writeState, detectContext, describeWork, findLinkedSessionFor } from '../lib/ledger.mjs';

// --- argument parsing --------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const args = parseArgs(process.argv.slice(3));
const command = process.argv[2];
const { flags } = args;
const asJson = Boolean(flags.json);

/** Progress chatter, silenced when the caller asked for JSON. */
const say = (...parts) => { if (!asJson) console.log(...parts); };

function out(human, data) {
  if (asJson) console.log(JSON.stringify(data ?? {}, null, 2));
  else console.log(human);
}

/**
 * Calling process.exit() while sockets are still open trips a libuv assertion
 * on Windows, so nothing here exits abruptly: set the code, unwind, and let
 * node shut down on its own. Measured at about 40ms.
 */
class ExitError extends Error {}

function reportError(message, code = 1) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`x ${message}`);
  process.exitCode = code;
}

function fail(message, code = 1) {
  reportError(message, code);
  throw new ExitError(message);
}

function readText(fileFlag, textFlag) {
  if (textFlag && typeof textFlag === 'string') return textFlag;
  if (!fileFlag || fileFlag === true) return '';
  if (fileFlag === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(fileFlag, 'utf8');
}

function sessionId() {
  const sid = flags.session || process.env.CLAUDE_SESSION_ID;
  if (!sid || sid === true) fail('Missing --session <id>. Use ${CLAUDE_SESSION_ID}.');
  return String(sid);
}

const str = (v) => (typeof v === 'string' ? v : '');

/** `--no-dry-run` makes a single run write for real, without touching config. */
function provider(options = {}) {
  const cfg = loadConfig();
  return createProvider(cfg, {
    ...options,
    dryRun: flags['no-dry-run'] ? false : undefined,
    onSimulate: logSimulated,
  });
}

/**
 * Long bodies are rejected rather than trimmed: truncating loses information
 * silently, and the point is for the writer to summarise.
 */
function enforceLength(text, limit, what) {
  const length = String(text || '').length;
  if (!limit || length <= limit || flags.long) return;
  fail(`${what} is ${length} characters, the limit is ${limit}. `
    + 'Summarise: one sentence of context and a few bullets. '
    + 'Drop file listings, design rationale and conversation recaps, which already live in the code and in git. '
    + 'If the long text is genuinely needed, repeat the command with --long.');
}

const labelsFor = (cfg) => (cfg.label ? [cfg.label] : []);

/**
 * Which install routes are present. Both can be, and then every hook fires
 * twice, so `doctor` needs to be able to say so.
 */
function detectInstalls() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const found = [];
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    const commands = Object.values(settings.hooks || {}).flat()
      .flatMap((group) => group.hooks || []).map((h) => String(h.command || ''));
    if (commands.some((c) => c.replace(/\\/g, '/').includes('/workingon/hooks/'))) found.push('npm package');
  } catch { /* no settings, nothing registered */ }
  try {
    const enabled = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).enabledPlugins || {};
    if (Object.keys(enabled).some((k) => k.startsWith('workingon@'))) found.push('Claude Code plugin');
  } catch { /* ignore */ }
  return found;
}

// --- commands ----------------------------------------------------------------

const commands = {};

/**
 * `npx workingon install` has to work from a package downloaded on the fly, so
 * the installer is reached relative to this file rather than the cwd.
 */
commands.install = async () => {
  const { spawnSync } = await import('node:child_process');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const installer = path.resolve(here, '..', '..', 'install.mjs');
  if (!fs.existsSync(installer)) fail(`Installer not found at ${installer}.`);

  const passthrough = process.argv.slice(3);
  const result = spawnSync(process.execPath, [installer, ...passthrough], { stdio: 'inherit' });
  process.exitCode = result.status ?? 0;
};

commands.uninstall = async () => {
  process.argv.splice(3, 0, '--uninstall');
  return commands.install();
};

commands.providers = async () => {
  const rows = describeProviders();
  out(rows.map((p) => `  ${p.id.padEnd(9)} ${p.label.padEnd(15)} ${p.blurb}`).join('\n'), rows);
};

// --- setup: three steps ------------------------------------------------------

async function ask(rl, question, fallback = '') {
  const answer = (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim();
  return answer || fallback;
}

commands.setup = async () => {
  const step = flags.step ? Number(flags.step) : null;
  const interactive = !flags.step && !flags.provider && !flags.mode && !flags.container;

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      say('workingon setup\n');
      await stepOne({ rl });
      await stepTwo({ rl });
      await stepThree({ rl });
      say('\nDone. Restart Claude Code so the hooks load.');
    } finally {
      rl.close();
    }
    return;
  }

  if (step === 1 || (!step && flags.provider)) return stepOne({});
  if (step === 2 || (!step && flags.mode)) return stepTwo({});
  if (step === 3 || (!step && flags.container)) return stepThree({});
  fail('Use `setup` on its own for the guided flow, or --step 1|2|3 with flags.');
};

/** Step 1: which tool, and the credentials to reach it. */
async function stepOne({ rl }) {
  say('Step 1 of 3: ticketing tool and token');

  let providerId = str(flags.provider);
  if (rl && !providerId) {
    PROVIDERS.forEach((P, i) => say(`  ${i + 1}. ${P.label.padEnd(15)} ${P.blurb}`));
    const pick = await ask(rl, '\nWhich one?', '1');
    const byIndex = PROVIDERS[Number(pick) - 1];
    providerId = byIndex ? byIndex.id : pick.toLowerCase();
  }
  if (!providerId) fail(`Missing --provider. One of: ${PROVIDERS.map((P) => P.id).join(', ')}.`);

  const ProviderClass = getProviderClass(providerId);
  const cfg = loadConfig();
  const existing = cfg.providers?.[ProviderClass.id] || {};

  if (rl) {
    say(`\nHow to get a ${ProviderClass.label} token:`);
    ProviderClass.tokenHelp.steps.forEach((s) => say(`  ${s}`));
    if (ProviderClass.tokenHelp.url) say(`  ${ProviderClass.tokenHelp.url}`);
    say('');
  }

  const credentials = {};
  for (const field of ProviderClass.credentialFields) {
    const fromFlag = str(flags[field.key]);
    if (fromFlag) { credentials[field.key] = fromFlag; continue; }
    if (!rl) continue;
    const current = existing[field.key];
    const shown = current && field.secret ? `${String(current).slice(0, 6)}...` : current;
    const hint = field.placeholder ? ` (${field.placeholder})` : '';
    const answer = await ask(rl, `${field.label}${hint}:`, shown || '');
    // Keeping the existing value means the masked preview was accepted.
    credentials[field.key] = answer === shown && current ? current : answer;
  }

  const merged = { ...existing, ...credentials };
  const probe = new ProviderClass(merged, { dryRun: false });
  const missing = probe.missingCredentials();
  if (missing.length) fail(`${ProviderClass.label} still needs: ${missing.join(', ')}.`);

  let verified = null;
  try {
    verified = await probe.verify();
    say(`  Connected to ${ProviderClass.label}${verified.account ? ` as ${verified.account}` : ''}.`);
  } catch (err) {
    if (!flags.force) {
      fail(`Could not connect: ${err.message}\nNothing was saved. Fix it and run step 1 again, or pass --force to save anyway.`);
    }
    say(`  Warning: could not verify (${err.message}). Saved anyway.`);
  }

  saveCredentials(ProviderClass.id, merged);
  saveConfig({ provider: ProviderClass.id });
  out(`Step 1 done: ${ProviderClass.label} configured. Credentials stored in ${CONFIG_PATH}.`,
    { ok: true, step: 1, provider: ProviderClass.id, account: verified?.account });
}

/** Step 2: save on its own, or ask first. */
async function stepTwo({ rl }) {
  say('\nStep 2 of 3: autosave or ask first');

  let mode = str(flags.mode);
  if (rl && !mode) {
    say('  1. ask      Ask once per folder before recording anything. Best if some projects are private.');
    say('  2. autosave Record automatically everywhere, no questions.');
    say('  3. off      Capture nothing for now.');
    const pick = await ask(rl, '\nWhich one?', '1');
    mode = { 1: 'ask', 2: 'autosave', 3: 'off' }[Number(pick)] || pick.toLowerCase();
  }
  if (!['ask', 'autosave', 'off'].includes(mode)) fail('Use --mode ask|autosave|off.');

  let writeStyle = str(flags['write-style']) || loadConfig().writeStyle;
  if (rl && mode !== 'off') {
    say('\n  Who writes the ticket text?');
    say('  1. nudge   Claude writes it, with the full context of the session. Better wording.');
    say('  2. silent  The hook writes a factual entry itself and never interrupts.');
    const pick = await ask(rl, '\nWhich one?', writeStyle === 'silent' ? '2' : '1');
    writeStyle = { 1: 'nudge', 2: 'silent' }[Number(pick)] || writeStyle;
  }

  let dryRun = loadConfig().dryRun;
  if (flags['dry-run'] !== undefined) dryRun = flags['dry-run'] !== 'false' && flags['dry-run'] !== false;
  if (rl) {
    const answer = await ask(rl, '\nStart in simulation mode, writing nothing until you are happy? (y/n)', dryRun ? 'y' : 'n');
    dryRun = /^y/i.test(answer);
  }

  saveConfig({ mode, writeStyle, dryRun });
  out(`Step 2 done: mode ${mode}, ${writeStyle} writing, simulation ${dryRun ? 'on' : 'off'}.`,
    { ok: true, step: 2, mode, writeStyle, dryRun });
}

/** Step 3: the main information, where tickets land and how to spot them. */
async function stepThree({ rl }) {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) fail('Run step 1 first: no ticketing tool configured yet.');

  const ProviderClass = getProviderClass(cfg.provider);
  say(`\nStep 3 of 3: default ${ProviderClass.containerNoun} and label`);

  let containerId = str(flags.container);
  if (rl && !containerId) {
    const p = provider({ dryRun: false });
    say(`  Loading your ${ProviderClass.containerNoun}s...`);
    const containers = (await p.listContainers()).filter((c) => !c.archived);
    if (!containers.length) fail(`No ${ProviderClass.containerNoun}s visible with this token.`);
    containers.slice(0, 40).forEach((c, i) => say(`  ${String(i + 1).padStart(3)}. ${c.name}`));
    if (containers.length > 40) say(`  ... and ${containers.length - 40} more, type the id directly`);
    const pick = await ask(rl, `\nWhich ${ProviderClass.containerNoun}?`, '1');
    const byIndex = containers[Number(pick) - 1];
    containerId = byIndex ? byIndex.id : pick;
  }
  if (!containerId) fail(`Missing --container <id>. Run \`workingon containers\` to list them.`);

  let label = flags.label !== undefined ? str(flags.label) : cfg.label;
  if (rl) {
    label = await ask(rl, '\nLabel for tickets created from Claude Code (blank for none):', label);
  }

  saveConfig({ defaultContainer: String(containerId), label });
  out(`Step 3 done: tickets go to ${containerId}${label ? `, labelled "${label}"` : ''}.`,
    { ok: true, step: 3, defaultContainer: String(containerId), label });
}

// --- diagnostics -------------------------------------------------------------

commands.doctor = async () => {
  const cfg = loadConfig();
  const lines = [`config: ${CONFIG_PATH}`, `home:   ${HOME}`];
  const report = { ok: true, config: CONFIG_PATH, checks: [] };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.ok = false;
    lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };

  check('ticketing tool selected', Boolean(cfg.provider), cfg.provider || 'none, run `workingon setup`');
  if (!cfg.provider) { out(lines.join('\n'), report); process.exitCode = 1; return; }

  const ProviderClass = getProviderClass(cfg.provider);
  const creds = cfg.providers?.[ProviderClass.id] || {};
  for (const field of ProviderClass.credentialFields) {
    if (field.optional) continue;
    const value = creds[field.key];
    check(`credential ${field.key}`, Boolean(value),
      value ? (field.secret ? `${String(value).slice(0, 6)}... (${String(value).length} chars)` : value) : 'missing');
  }
  if (!report.ok) {
    lines.push('', 'Run `workingon setup --step 1` to fix the credentials.');
    out(lines.join('\n'), report); process.exitCode = 1; return;
  }

  const p = provider({ dryRun: false });
  try {
    const v = await p.verify();
    check('connection', true, `${ProviderClass.label}${v.account ? `, signed in as ${v.account}` : ''}${v.detail ? ` (${v.detail})` : ''}`);
  } catch (err) {
    check('connection', false, err.message);
    out(lines.join('\n'), report); process.exitCode = 1; return;
  }

  let containers = [];
  try {
    containers = await p.listContainers();
    check(`${ProviderClass.containerNoun}s visible`, true, String(containers.length));
  } catch (err) {
    check(`${ProviderClass.containerNoun}s visible`, false, err.message);
  }

  const mappings = Object.entries(cfg.containers || {});
  if (cfg.defaultContainer) {
    const found = containers.find((c) => String(c.id) === String(cfg.defaultContainer));
    check('default destination', containers.length ? Boolean(found) : true,
      found ? found.name : String(cfg.defaultContainer));
    if (cfg.mode === 'autosave') {
      lines.push('  note: in autosave mode every unmapped folder writes there. Use mode "ask" if some projects are private.');
    }
  } else if (mappings.length) {
    check('destination', true, `no default, ${mappings.length} folder(s) mapped. Nothing is written outside them.`);
  } else {
    check('destination', false, 'no default and no mappings. Run `workingon setup --step 3`.');
  }

  for (const [folder, id] of mappings) {
    const found = containers.find((c) => String(c.id) === String(id));
    check(`folder "${folder}" -> ${id}`, containers.length ? Boolean(found) && !found?.archived : true,
      found ? `${found.name}${found.archived ? ' (ARCHIVED)' : ''}` : 'not found or no access');
  }

  if (cfg.label) {
    try {
      const labels = await p.listLabels(cfg.defaultContainer || mappings[0]?.[1]);
      const exists = labels.some((l) => l.name.toLowerCase() === cfg.label.toLowerCase());
      check(`label "${cfg.label}" exists`, exists || cfg.createLabels,
        exists ? 'yes' : (cfg.createLabels ? 'missing, will be created' : 'missing, and createLabels is off so it will be skipped'));
    } catch { /* not every tool exposes labels without a container */ }
  }

  // Installing both ways registers every hook twice. Capture deduplicates by
  // event id so nothing is double counted, but it is still worth saying.
  const installs = detectInstalls();
  if (installs.length > 1) {
    check('single installation', false,
      `installed both as ${installs.join(' and ')}. Capture is deduplicated so counts stay correct, but keep one: `
      + 'either `npx workingon uninstall`, or `/plugin uninstall workingon@workingon` inside Claude Code.');
  }

  if ((cfg.excluded || []).length) lines.push(`  excluded folders: ${cfg.excluded.join(', ')}`);
  lines.push('');
  lines.push(cfg.dryRun
    ? `SIMULATION MODE: nothing is written. Intended writes are logged to ${DRY_RUN_LOG}.\nTurn it off with \`workingon config --set dryRun=false\` once the log convinces you.`
    : 'Simulation off: tickets are created for real.');
  lines.push('', `mode=${cfg.mode}, writeStyle=${cfg.writeStyle}, minEdits=${cfg.minEdits}, debounce=${cfg.debounceSeconds}s`);

  out(lines.join('\n'), report);
  if (!report.ok) process.exitCode = 1;
};

commands.containers = async () => {
  const p = provider();
  const containers = await p.listContainers();
  out(containers.map((c) => `  ${String(c.id).padEnd(24)} ${c.name}${c.archived ? '  (archived)' : ''}`).join('\n')
    || 'None found.', containers);
};

commands.labels = async () => {
  const cfg = loadConfig();
  const p = provider();
  const containerId = str(flags.container) || cfg.defaultContainer;

  if (typeof flags.create === 'string') {
    const created = await p.createLabel(flags.create, str(flags.color) || 'ff8c00', containerId);
    out(created.__dryRun
      ? `[SIMULATED] Nothing written. Would have created label "${flags.create}".`
      : `ok  Label created: ${created.name}${created.color ? ` (${created.color})` : ''}`, { ok: true, ...created });
    return;
  }
  const labels = await p.listLabels(containerId);
  out(labels.map((l) => `  ${l.name}${l.color ? `  ${l.color}` : ''}`).join('\n') || 'None found.', labels);
};

// --- session state -----------------------------------------------------------

commands.ledger = async () => {
  const sid = sessionId();
  const cfg = loadConfig();
  const state = readState(sid);
  const sum = summarize(sid, { sinceSeq: state.lastSyncedSeq || 0 });
  const ctx = state.cwd ? state : detectContext(process.cwd());
  const decision = decisionFor(ctx.cwd, ctx.project, cfg);
  const containerId = decision.status === 'mapped' ? decision.containerId : (state.containerId || containerFor(ctx.cwd, ctx.project, cfg));

  const destination = {
    excluded: 'FOLDER EXCLUDED (private, nothing is recorded)',
    undecided: 'UNDECIDED (ask the user first)',
  }[decision.status] || (containerId || 'NOT MAPPED');

  const u = sum.unsynced;
  const data = {
    sessionId: sid,
    provider: cfg.provider,
    decision: decision.status,
    cwd: ctx.cwd,
    project: ctx.project,
    branch: ctx.branch,
    containerId,
    linkedIssue: state.issueId ? { id: state.issueId, key: state.issueKey, title: state.issueTitle, url: state.issueUrl } : null,
    seq: sum.seq,
    lastSyncedSeq: state.lastSyncedSeq || 0,
    unsynced: u,
  };

  const lines = [
    `Session ${sid}`,
    `Folder: ${ctx.cwd}${ctx.branch ? `  (branch ${ctx.branch})` : ''}`,
    `Destination: ${destination}`,
    state.issueId ? `Linked ticket: ${state.issueKey || state.issueId} ${state.issueTitle || ''}` : 'Linked ticket: none',
    '',
    `Unrecorded work (events ${state.lastSyncedSeq || 0} to ${sum.seq}):`,
    '', `Requests (${u.prompts.length}):`,
    ...u.prompts.map((p, i) => `  ${i + 1}. ${p.text}`),
    '', `Files touched (${u.files.length}):`,
    ...u.files.slice(0, 40).map((f) => `  ${f.file}  (${f.edits}x)`),
  ];
  if (u.files.length > 40) lines.push(`  ...and ${u.files.length - 40} more`);
  if (u.commits.length) {
    lines.push('', `Commits (${u.commits.length}):`, ...u.commits.map((c) => `  ${c.sha || '?'} ${c.message || ''}`));
  }
  if (u.commands.length) {
    lines.push('', `Notable commands (${u.commands.length}):`, ...u.commands.slice(0, 20).map((c) => `  [${c.kind}] ${c.cmd}`));
  }
  out(lines.join('\n'), data);
};

commands.status = async () => {
  const sid = flags.session && flags.session !== true ? String(flags.session) : null;
  const cfg = loadConfig();
  const state = sid ? readState(sid) : {};
  const ctx = state.cwd ? state : detectContext(process.cwd());
  const decision = decisionFor(ctx.cwd, ctx.project, cfg);
  const previous = findLinkedSessionFor(ctx.cwd, { excludeSessionId: sid });
  const sum = sid ? summarize(sid, { sinceSeq: state.lastSyncedSeq || 0 }) : null;

  const data = {
    configured: isConfigured(cfg), provider: cfg.provider, mode: cfg.mode, dryRun: cfg.dryRun,
    cwd: ctx.cwd, project: ctx.project, branch: ctx.branch,
    decision: decision.status,
    containerId: decision.containerId || (state.containerId ?? null),
    linkedIssue: state.issueId ? { id: state.issueId, key: state.issueKey, title: state.issueTitle, url: state.issueUrl } : null,
    previousSessionIssue: previous ? { id: previous.issueId, key: previous.issueKey, title: previous.issueTitle, url: previous.issueUrl } : null,
    pending: sum ? describeWork(sum) : null,
  };
  out([
    `Configured: ${data.configured ? `yes (${cfg.provider})` : 'no'}  mode: ${cfg.mode}  simulation: ${cfg.dryRun ? 'on' : 'off'}`,
    `Folder: ${data.project}  ->  ${data.decision === 'excluded' ? 'EXCLUDED' : data.containerId || 'undecided'}`,
    data.linkedIssue ? `This session's ticket: ${data.linkedIssue.key} ${data.linkedIssue.title}` : "This session's ticket: none",
    data.previousSessionIssue ? `Open ticket from an earlier session here: ${data.previousSessionIssue.key} ${data.previousSessionIssue.title}` : '',
    data.pending ? `Pending: ${data.pending}` : '',
  ].filter(Boolean).join('\n'), data);
};

// --- issues ------------------------------------------------------------------

function resolveContainer(cfg, state, ctx) {
  const explicit = str(flags.container);
  if (explicit) return explicit;
  const decision = decisionFor(ctx.cwd, ctx.project, cfg);
  if (decision.status === 'excluded') {
    fail(`Folder "${ctx.project}" is excluded. Nothing is recorded from it. Undo with \`config --include ${ctx.project}\`.`);
  }
  const id = decision.containerId || state.containerId || containerFor(ctx.cwd, ctx.project, cfg);
  if (!id) {
    fail(`No destination for folder "${ctx.project}". Map it with \`config --map ${ctx.project}=<id>\`, or pass --container <id>. `
      + 'Run `containers` to list them.');
  }
  return String(id);
}

commands.create = async () => {
  const cfg = loadConfig();
  const p = provider();
  const title = str(flags.title) || args.positional.join(' ');
  if (!title) fail('Missing --title "<title>".');

  const sid = flags.session && flags.session !== true ? String(flags.session) : null;
  const state = sid ? readState(sid) : {};
  const ctx = state.cwd ? state : detectContext(process.cwd());
  const containerId = resolveContainer(cfg, state, ctx);

  const body = readText(flags['body-file'] || flags['desc-file'], flags.body || flags.desc);
  enforceLength(body, cfg.maxDescriptionChars, 'Description');

  const labels = [...new Set([...labelsFor(cfg), ...str(flags.labels).split(',').map((s) => s.trim()).filter(Boolean)])];
  const issue = await p.createIssue({
    containerId, title, body, labels,
    priority: flags.priority ? Number(flags.priority) : undefined,
    allowCreateLabels: Boolean(cfg.createLabels),
  });

  const simulated = Boolean(issue.__dryRun);
  if (sid) {
    const sum = summarize(sid);
    writeState(sid, simulated
      ? { containerId, lastSyncedSeq: sum.seq, lastSyncedAt: new Date().toISOString() }
      : {
        issueId: issue.id, issueKey: issue.key, issueTitle: issue.title, issueUrl: issue.url,
        containerId, lastSyncedSeq: sum.seq, lastSyncedAt: new Date().toISOString(), closed: false,
      });
  }

  const notes = [
    issue.labels?.length ? `  labels: ${issue.labels.join(', ')}` : '',
    issue.labelsMissing?.length ? `  labels skipped (missing, and createLabels is off): ${issue.labelsMissing.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  out(simulated
    ? `[SIMULATED] Nothing was written.\n  Would have created in ${containerId}: ${title}\n  Full detail in ${DRY_RUN_LOG}${notes ? `\n${notes}` : ''}`
    : `ok  Created ${issue.key}: ${issue.title}\n  ${issue.url}${notes ? `\n${notes}` : ''}`,
  { ok: true, dryRun: simulated, ...issue, containerId });
};

commands.comment = async () => {
  const cfg = loadConfig();
  const p = provider();
  const sid = flags.session && flags.session !== true ? String(flags.session) : null;
  const state = sid ? readState(sid) : {};
  const issueId = str(flags.issue) || state.issueId || args.positional[0];
  if (!issueId) fail('Missing --issue <id>, or a session with a linked ticket.');

  const text = readText(flags.file, flags.text);
  if (!text.trim()) fail('The comment is empty. Use --file <path> or --text "...".');
  enforceLength(text, cfg.maxCommentChars, 'Comment');

  const result = await p.addComment(issueId, text);
  const simulated = Boolean(result?.__dryRun);
  if (sid) {
    const sum = summarize(sid);
    writeState(sid, { lastSyncedSeq: sum.seq, lastSyncedAt: new Date().toISOString() });
  }
  out(simulated
    ? `[SIMULATED] Nothing written. Would have commented on ${issueId}.\n  Detail in ${DRY_RUN_LOG}`
    : `ok  Comment added to ${issueId}${state.issueUrl ? `\n  ${state.issueUrl}` : ''}`,
  { ok: true, dryRun: simulated, issueId });
};

commands.comments = async () => {
  const p = provider();
  const sid = flags.session && flags.session !== true ? String(flags.session) : null;
  const issueId = str(flags.issue) || (sid ? readState(sid).issueId : '') || args.positional[0];
  if (!issueId) fail('Missing --issue <id>.');

  if (typeof flags.delete === 'string') {
    const result = await p.deleteComment(issueId, flags.delete);
    out(result?.__dryRun
      ? `[SIMULATED] Nothing deleted. Would have removed comment ${flags.delete}.`
      : `ok  Comment ${flags.delete} deleted from ${issueId}.`, { ok: true, issueId, commentId: flags.delete });
    return;
  }
  const list = await p.listComments(issueId);
  out(list.map((c) => `  ${c.id}  ${c.createdAt}\n${c.body}\n`).join('\n') || 'No comments.', list);
};

commands.update = async () => {
  const cfg = loadConfig();
  const p = provider();
  const sid = flags.session && flags.session !== true ? String(flags.session) : null;
  const state = sid ? readState(sid) : {};
  const issueId = str(flags.issue) || state.issueId || args.positional[0];
  if (!issueId) fail('Missing --issue <id>, or a session with a linked ticket.');

  const patch = { allowCreateLabels: Boolean(cfg.createLabels) };
  if (typeof flags.title === 'string') patch.title = flags.title;
  const body = readText(flags['body-file'] || flags['desc-file'], flags.body || flags.desc);
  if (body) { enforceLength(body, cfg.maxDescriptionChars, 'Description'); patch.body = body; }
  if (flags.done) patch.done = true;
  if (flags.reopen) patch.done = false;
  if (str(flags.container)) patch.containerId = str(flags.container);
  if (str(flags.labels)) patch.labels = str(flags.labels).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags.percent !== undefined && flags.percent !== true) patch.percent = Number(flags.percent);
  if (flags.priority !== undefined && flags.priority !== true) patch.priority = Number(flags.priority);

  const meaningful = Object.keys(patch).filter((k) => k !== 'allowCreateLabels');
  if (!meaningful.length) fail('Nothing to update. Use --title, --body-file, --done, --reopen, --container, --labels, --percent or --priority.');

  const issue = await p.updateIssue(issueId, patch);
  const simulated = Boolean(issue?.__dryRun);

  if (sid) {
    const sum = summarize(sid);
    const next = { lastSyncedSeq: sum.seq, lastSyncedAt: new Date().toISOString() };
    if (flags.done) next.closed = true;
    if (flags.reopen) next.closed = false;
    // Closing the ticket ends the reason to stamp commits with it. Leaving the file
    // behind would mark tomorrow's unrelated work with yesterday's ticket, which is
    // worse than not stamping at all: a wrong reference reads as a true one.
    if (flags.done) clearTicketFile();
    if (patch.title) next.issueTitle = patch.title;
    if (patch.containerId) next.containerId = patch.containerId;
    writeState(sid, next);
  }

  const changes = [
    flags.done ? 'closed' : '', flags.reopen ? 'reopened' : '',
    patch.containerId ? `moved to ${patch.containerId}` : '',
    issue.labels?.length ? `labelled ${issue.labels.join(', ')}` : '',
  ].filter(Boolean).join(', ');

  out(simulated
    ? `[SIMULATED] Nothing written. Would have updated ${issueId}${changes ? ` (${changes})` : ''}.`
    : `ok  Updated ${issue.key || issueId}${changes ? ` (${changes})` : ''}: ${issue.title || ''}${issue.url ? `\n  ${issue.url}` : ''}`,
  { ok: true, dryRun: simulated, ...issue });
};

commands.find = async () => {
  const cfg = loadConfig();
  const p = provider();
  const sid = flags.session && flags.session !== true ? String(flags.session) : null;
  const state = sid ? readState(sid) : {};
  const ctx = state.cwd ? state : detectContext(process.cwd());
  const containerId = str(flags.container) || state.containerId || containerFor(ctx.cwd, ctx.project, cfg);

  const issues = await p.searchIssues({
    query: args.positional.join(' ') || str(flags.query),
    containerId,
    openOnly: !flags.all,
    limit: flags.limit ? Number(flags.limit) : 25,
  });
  out(issues.map((i) => `  ${i.key.padEnd(14)} ${i.done ? '[done] ' : ''}${i.title}`).join('\n') || 'No results.', issues);
};

commands.show = async () => {
  const p = provider();
  const issueId = str(flags.issue) || args.positional[0];
  if (!issueId) fail('Missing --issue <id>.');
  const issue = await p.getIssue(issueId);
  let comments = [];
  try { comments = await p.listComments(issueId); } catch { /* may lack permission */ }
  out([
    `${issue.key} ${issue.title}`,
    `${issue.done ? 'done' : 'open'}${issue.labels.length ? `  labels: ${issue.labels.join(', ')}` : ''}`,
    issue.url, '', issue.body || '(no description)',
    '', `Comments (${comments.length}):`,
    ...comments.slice(-5).map((c) => `--- ${c.createdAt}\n${c.body}`),
  ].filter(Boolean).join('\n'), { ...issue, comments });
};

/**
 * Deleting is irreversible, so it needs --yes and the skill is told never to
 * call it: this is a tool for the person, not for the automation.
 */
commands.delete = async () => {
  const p = provider();
  const ids = [...str(flags.issue).split(','), ...args.positional].map((s) => s.trim()).filter(Boolean);
  if (!ids.length) fail('Missing --issue <id>. Accepts several separated by commas.');

  const found = [];
  for (const id of ids) {
    try { found.push(await p.getIssue(id)); }
    catch (err) { console.error(`  (warning: ${id} could not be read: ${err.message})`); }
  }
  if (!found.length) fail('None of those tickets exist or are reachable.');

  if (!flags.yes) {
    fail(`Would delete ${found.length} ticket(s), with no way back:\n${found.map((i) => `  ${i.key} ${i.title}`).join('\n')}\nRepeat with --yes to confirm.`);
  }
  const deleted = [];
  for (const issue of found) {
    const result = await p.deleteIssue(issue.id);
    deleted.push({ id: issue.id, key: issue.key, title: issue.title, dryRun: Boolean(result?.__dryRun) });
  }
  const simulated = deleted.every((d) => d.dryRun);
  out(simulated
    ? `[SIMULATED] Nothing deleted. Would have removed ${deleted.length} ticket(s).`
    : deleted.map((d) => `ok  Deleted ${d.key}: ${d.title}`).join('\n'), { ok: true, dryRun: simulated, deleted });
};

// --- linking -----------------------------------------------------------------

commands.link = async () => {
  const sid = sessionId();
  const p = provider();
  const issueId = str(flags.issue) || args.positional[0];
  if (!issueId) fail('Missing --issue <id>.');
  const issue = await p.getIssue(issueId);
  const sum = summarize(sid);
  writeState(sid, {
    issueId: issue.id, issueKey: issue.key, issueTitle: issue.title, issueUrl: issue.url,
    containerId: issue.containerId,
    lastSyncedSeq: flags['keep-unsynced'] ? (readState(sid).lastSyncedSeq || 0) : sum.seq,
    closed: Boolean(issue.done),
  });

  // Linking a ticket means starting on it, so the board should say so. Moving it
  // here rather than asking is the point: a column that only reflects reality when
  // someone remembers to drag a card is a column nobody trusts.
  //
  // Closing needs no equivalent. When the kanban view has a done bucket configured,
  // Vikunja moves the card itself as soon as the task is marked done, so
  // `update --done` already lands it in the right column. Adding a second write
  // would only race the first.
  const moved = await moveToInProgress(p, issue);
  writeTicketFile(issue);

  out(
    `ok  Session linked to ${issue.key}: ${issue.title}` +
    (moved.note ? `\n  ${moved.note}` : '') +
    `\n  ${issue.url}`,
    { ok: true, ...issue, movedTo: moved.bucket || null },
  );
};

/**
 * Drags the card into the "in progress" column, when there is one and it is
 * unambiguous.
 *
 * Every failure here is deliberately soft. Linking a ticket has to keep working on
 * a board with no kanban view, on a provider that has no columns at all, and on a
 * board whose columns cannot be told apart. Refusing to link because a card could
 * not be dragged would break the useful part to protect the decorative one.
 */
async function moveToInProgress(p, issue) {
  const Provider = p.constructor;
  if (!Provider.capabilities?.buckets || typeof p.board !== 'function') return {};
  if (issue.done) return { note: 'Already done, left where it is.' };

  try {
    const board = await p.board(issue.containerId);
    if (!board) return {};

    const target = Provider.inProgressBucket(board);
    if (!target) {
      // Two or more middle columns, or none. Saying so beats picking one: moving a
      // card to a column the person did not choose looks like it worked.
      return { note: 'No single "in progress" column on this board, so nothing was moved.' };
    }

    const at = typeof p.bucketOf === 'function'
      ? await p.bucketOf(issue.id, issue.containerId, board.viewId)
      : null;
    if (at && at.id === target.id) return { note: `Already in ${target.title}.` };

    await p.moveToBucket(issue.id, issue.containerId, board.viewId, target.id);
    return { note: `Moved to ${target.title}.`, bucket: target.title };
  } catch (err) {
    // The link itself already succeeded and is what matters.
    return { note: `Could not move it on the board: ${err.message}` };
  }
}

/**
 * Unlinks the session from its ticket and sends the card back to the first column.
 *
 * It is the exact undo of `link`: one command that leaves nothing half done. There
 * used to be a flag for the move, off by default, on the argument that stopping
 * work is not the same as never having started it and that sending a card back
 * throws away the "in progress" signal. That argument lost on purpose, because a
 * two step undo is a two step undo, and the second step is the one nobody runs.
 *
 * The consequence is worth knowing: after this, the board says the ticket has not
 * been touched. To keep the card in the in progress column, simply do not unlink;
 * a session ending does not move anything on its own.
 */
/**
 * Where the git hook reads the linked ticket from.
 *
 * A git hook knows nothing about the Claude Code session: it runs in the
 * repository, with no session id and no access to the ledger. So the ticket has to
 * be left somewhere it can find on its own.
 *
 * Inside `.git` and not in the working tree, for three reasons: it is never
 * committed by accident, it disappears with the clone, and it is per repository,
 * which is what "the ticket I am on in THIS repo" means.
 */
function ticketFilePath(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return path.join(r.stdout.trim(), 'workingon-ticket');
}

function writeTicketFile(issue) {
  const file = ticketFilePath();
  if (!file) return;
  try {
    fs.writeFileSync(file, `${issue.url || issue.key || issue.id}\n`, 'utf8');
  } catch { /* not being able to write it only costs the trailer */ }
}

function clearTicketFile() {
  const file = ticketFilePath();
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* nothing to undo */ }
}

commands.unlink = async () => {
  const sid = sessionId();
  const state = readState(sid);
  let note = '';

  if (state.issueId) {
    try {
      const p = provider();
      const issue = await p.getIssue(state.issueId);
      const Provider = p.constructor;
      if (Provider.capabilities?.buckets && typeof p.board === 'function') {
        const board = await p.board(issue.containerId);
        // A finished ticket is left alone. Dragging it out of the done column would
        // reopen it, and Vikunja would clear its done flag along the way.
        if (board?.defaultBucketId && !issue.done) {
          await p.moveToBucket(issue.id, issue.containerId, board.viewId, board.defaultBucketId);
          const col = board.buckets.find((b) => b.id === board.defaultBucketId);
          note = `\n  Moved back to ${col?.title || 'the first column'}.`;
        } else if (issue.done) {
          note = '\n  Already done, left where it is.';
        }
      }
    } catch (err) {
      // Unlinking is what was asked for, and it has to work even when the board
      // does not cooperate.
      note = `\n  Could not move it back: ${err.message}`;
    }
  }

  writeState(sid, { issueId: null, issueKey: null, issueTitle: null, issueUrl: null, closed: false });
  clearTicketFile();
  out(`ok  Session unlinked.${note}`, { ok: true });
};

/** The marker that says a hook is ours, and therefore safe to replace. */
const GIT_HOOK_MARK = '# workingon: adds the linked ticket as a git trailer';

const GIT_HOOK = `#!/bin/sh
${GIT_HOOK_MARK}
#
# Appends "Ticket: <url>" to the commit message when this repository has a linked
# ticket, so the log can be read against the board without anyone remembering to
# type it.
#
# A git hook rather than something inside Claude Code on purpose: this way it also
# stamps the commits you make by hand.

msg_file="$1"
source="$2"

# Nothing to add to a merge or a squash: their messages are generated and the
# trailer would end up on work that is not the linked ticket.
case "$source" in
  merge|squash) exit 0 ;;
esac

git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
ticket_file="$git_dir/workingon-ticket"
[ -f "$ticket_file" ] || exit 0

ticket=$(head -n1 "$ticket_file" | tr -d '\\r\\n')
[ -n "$ticket" ] || exit 0

# Already there, whether from an amend or from a second run.
grep -qi "^Ticket: " "$msg_file" && exit 0

# A blank line before the trailer, unless the message already ends in one, or git
# will treat it as part of the body instead of as a trailer.
[ -n "$(tail -c 1 "$msg_file")" ] && printf '\\n' >> "$msg_file"
printf '\\nTicket: %s\\n' "$ticket" >> "$msg_file"
`;

/**
 * Installs the commit trailer hook in the current repository.
 *
 * Refuses to overwrite a hook it did not write. A prepare-commit-msg that someone
 * put there on purpose is not ours to replace, and silently clobbering it is the
 * kind of help nobody asks for twice.
 */
commands.githook = async () => {
  const dir = ticketFilePath();
  if (!dir) fail('Not inside a git repository.');
  const hooksDir = path.join(path.dirname(dir), 'hooks');
  const hook = path.join(hooksDir, 'prepare-commit-msg');

  if (flags.remove) {
    if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes(GIT_HOOK_MARK)) {
      fs.rmSync(hook, { force: true });
      clearTicketFile();
      out(`ok  Hook removed from ${hook}`, { ok: true, removed: true });
      return;
    }
    out('ok  Nothing of ours to remove.', { ok: true, removed: false });
    return;
  }

  if (fs.existsSync(hook)) {
    const existing = fs.readFileSync(hook, 'utf8');
    if (!existing.includes(GIT_HOOK_MARK)) {
      fail(`There is already a prepare-commit-msg hook that is not ours:\n  ${hook}\nMerge it by hand, or move it aside first.`);
    }
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hook, GIT_HOOK, 'utf8');
  try { fs.chmodSync(hook, 0o755); } catch { /* Windows does not need it */ }
  out(`ok  Commits in this repository will carry the linked ticket.\n  ${hook}`, { ok: true, hook });
};

commands.synced = async () => {
  const sid = sessionId();
  const sum = summarize(sid);
  writeState(sid, { lastSyncedSeq: sum.seq, lastSyncedAt: new Date().toISOString() });
  out(`ok  Ledger marked as recorded (${sum.seq} events).`, { ok: true, seq: sum.seq });
};

// --- config ------------------------------------------------------------------

commands.config = async () => {
  if (typeof flags.set === 'string') {
    const eq = flags.set.indexOf('=');
    if (eq < 0) fail('Format: --set key=value');
    const key = flags.set.slice(0, eq);
    let value = flags.set.slice(eq + 1);
    if (/^\d+$/.test(value)) value = Number(value);
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    saveConfig({ [key]: value });
    out(`ok  ${key} = ${JSON.stringify(value)}`, { ok: true, [key]: value });
    return;
  }

  if (typeof flags.map === 'string') {
    const eq = flags.map.indexOf('=');
    if (eq < 0) fail('Format: --map <folder-or-path>=<container id>');
    const cfg = loadConfig();
    const folder = flags.map.slice(0, eq);
    const containers = { ...(cfg.containers || {}), [folder]: flags.map.slice(eq + 1) };
    const excluded = (cfg.excluded || []).filter((k) => k.toLowerCase() !== folder.toLowerCase());
    saveConfig({ containers, excluded });
    out(`ok  "${folder}" now records to ${flags.map.slice(eq + 1)}.`, { ok: true, containers });
    return;
  }

  if (typeof flags.exclude === 'string') {
    const key = flags.exclude;
    const cfg = loadConfig();
    const containers = { ...(cfg.containers || {}) };
    delete containers[key];
    saveConfig({ excluded: [...new Set([...(cfg.excluded || []), key])], containers });

    // A private folder should not keep whatever was already captured from it.
    let purged = 0;
    try {
      for (const f of fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.state.json'))) {
        try {
          const st = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          const mine = String(st.project || '').toLowerCase() === key.toLowerCase()
            || String(st.cwd || '').replace(/\\/g, '/').toLowerCase().startsWith(key.replace(/\\/g, '/').toLowerCase());
          if (!mine) continue;
          fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
          fs.rmSync(path.join(SESSIONS_DIR, f.replace('.state.json', '.jsonl')), { force: true });
          purged++;
        } catch { /* unreadable state, nothing to purge */ }
      }
    } catch { /* no sessions yet */ }

    // An events file with no state file belongs to no known folder, so it
    // cannot be purged by folder. Deleting it blindly could destroy another
    // project's history, so say it exists rather than guess.
    let orphans = [];
    try {
      const files = fs.readdirSync(SESSIONS_DIR);
      orphans = files.filter((f) => f.endsWith('.jsonl')
        && !files.includes(f.replace(/\.jsonl$/, '.state.json')));
    } catch { /* no sessions yet */ }

    out([
      `ok  "${key}" excluded. Nothing from that folder is captured or recorded.`,
      purged ? `  Deleted local data from ${purged} earlier session(s).` : '',
      orphans.length
        ? `  Note: ${orphans.length} ledger(s) predate folder tracking and cannot be attributed to any folder.\n`
          + `  Review or remove them under ${SESSIONS_DIR}.`
        : '',
    ].filter(Boolean).join('\n'), { ok: true, purgedSessions: purged, orphanLedgers: orphans });
    return;
  }

  if (typeof flags.include === 'string') {
    const cfg = loadConfig();
    saveConfig({ excluded: (cfg.excluded || []).filter((k) => k.toLowerCase() !== flags.include.toLowerCase()) });
    out(`ok  "${flags.include}" is no longer excluded. Map it with --map ${flags.include}=<id>.`, { ok: true });
    return;
  }

  const cfg = loadConfig();
  const redactedProviders = Object.fromEntries(Object.entries(cfg.providers || {}).map(([id, creds]) => [
    id,
    Object.fromEntries(Object.entries(creds).map(([k, v]) => [k, /token|key|secret|password/i.test(k) && v ? `${String(v).slice(0, 6)}...` : v])),
  ]));
  const redacted = { ...cfg, providers: redactedProviders };
  out(JSON.stringify(redacted, null, 2), redacted);
};

commands.help = async () => {
  console.log(`workingon: record what you work on in your ticketing tool

Usage: workingon <command> [options]

Setup
  install [--dry-run]         Install the hooks and the skill
  uninstall                   Remove them, keeping config and history
  setup                       Guided three step setup
  setup --step 1 --provider <id> [--token ... --url ... --email ...]
  setup --step 2 --mode ask|autosave|off [--write-style nudge|silent] [--dry-run true|false]
  setup --step 3 --container <id> [--label "Claude"]
  providers                   List supported ticketing tools
  doctor                      Check configuration, connection and destinations

Session
  ledger    --session SID     Show work not recorded yet
  status   [--session SID]    Destination, linked ticket, pending work
  synced    --session SID     Mark pending work as recorded without writing
  link      --issue ID --session SID [--keep-unsynced]
  unlink    --session SID

Tickets
  containers                  List projects, repos, teams or lists
  labels   [--create NAME --color hex] [--container ID]
  find      <text> [--container ID] [--all] [--limit N]
  show      --issue ID
  create    --title "T" [--body-file F|-] [--container ID] [--labels a,b] [--session SID]
  comment   --issue ID | --session SID   --file F|- | --text "T"
  comments  --issue ID [--delete <commentId>]
  update    --issue ID | --session SID  [--title T] [--body-file F] [--done] [--reopen]
            [--container ID] [--labels a,b] [--percent N] [--priority N]
  delete    --issue ID[,ID] --yes

Config
  config                      Show current configuration
  config --set key=value
  config --map <folder>=<container id>
  config --exclude <folder>   Never record or capture this folder
  config --include <folder>   Undo an exclusion

Global: --json, --no-dry-run, --long

Config file: ${CONFIG_PATH}`);
};

// --- dispatch ----------------------------------------------------------------

const handler = commands[command]
  || (command === undefined || command === '--help' || command === '-h' ? commands.help : null);

if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  await commands.help();
  process.exitCode = 1;
} else {
  try {
    await handler();
  } catch (err) {
    if (err instanceof ExitError) { /* already reported */ }
    else reportError(err?.message || String(err));
  }
}
