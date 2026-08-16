#!/usr/bin/env node
/**
 * workingon installer.
 *
 *   node install.mjs              install or update
 *   node install.mjs --uninstall  remove hooks and skill, keep config and ledger
 *   node install.mjs --dry-run    show what it would do
 *
 * Options: --home <dir>  --skills <dir>  --settings <file>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const DRY = has('dry-run');
const UNINSTALL = has('uninstall');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOME = path.resolve(flag('home', path.join(CLAUDE_DIR, 'workingon')));
const SKILLS_DIR = path.resolve(flag('skills', path.join(CLAUDE_DIR, 'skills')));
const SKILL_DIR = path.join(SKILLS_DIR, 'workingon');
const SETTINGS = path.resolve(flag('settings', path.join(CLAUDE_DIR, 'settings.json')));

const fwd = (p) => p.replace(/\\/g, '/');
const HOOKS_HOME = fwd(path.join(HOME, 'hooks'));
const CLI = fwd(path.join(HOME, 'bin', 'workingon.mjs'));

const note = (msg) => console.log(msg);

// --- filesystem helpers ------------------------------------------------------

function copyDir(from, to) {
  if (DRY) { note(`  [dry] copy ${fwd(from)} -> ${fwd(to)}`); return; }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function writeFile(target, content) {
  if (DRY) { note(`  [dry] write ${fwd(target)}`); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function backup(file) {
  if (!fs.existsSync(file) || DRY) return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(file)}.workingon-${stamp}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

/** The config file holds API tokens, so lock it to its owner. */
function restrictConfig(file) {
  if (DRY || !fs.existsSync(file)) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(R,W)`], { stdio: 'ignore' });
    } else {
      fs.chmodSync(file, 0o600);
    }
  } catch { /* best effort */ }
}

// --- hook definitions --------------------------------------------------------

// Identifying our own entries by path covers both the default install and any
// custom --home, so reinstalling replaces instead of duplicating.
const DEFAULT_MARKER = '/workingon/hooks/';
const isOurs = (command) => {
  const cmd = String(command || '').replace(/\\/g, '/');
  return cmd.includes(HOOKS_HOME) || cmd.includes(DEFAULT_MARKER);
};

const HOOK_SPEC = {
  SessionStart: [{
    hooks: [{ type: 'command', command: `node "${HOOKS_HOME}/session-start.mjs"`, timeout: 15 }],
  }],
  UserPromptSubmit: [{
    hooks: [{ type: 'command', command: `node "${HOOKS_HOME}/user-prompt.mjs"`, async: true, timeout: 10 }],
  }],
  PostToolUse: [{
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
    hooks: [{ type: 'command', command: `node "${HOOKS_HOME}/post-tool.mjs"`, async: true, timeout: 10 }],
  }],
  Stop: [{
    hooks: [{
      type: 'command',
      command: `node "${HOOKS_HOME}/stop.mjs"`,
      timeout: 30,
      statusMessage: 'Checking work to record',
    }],
  }],
  SessionEnd: [{
    hooks: [{ type: 'command', command: `node "${HOOKS_HOME}/session-end.mjs"`, timeout: 30 }],
  }],
};

/** Drop any previously installed entry so re-running is idempotent. */
function stripOurHooks(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const kept = groups
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const inner = group.hooks.filter((h) => !isOurs(h?.command));
        return inner.length ? { ...group, hooks: inner } : null;
      })
      .filter(Boolean);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function patchSettings() {
  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    } catch (err) {
      console.error(`x ${SETTINGS} is not valid JSON (${err.message}). Fix it and run again.`);
      process.exitCode = 1;
      throw new Error('invalid settings');
    }
  }

  const saved = backup(SETTINGS);
  if (saved) note(`  backup: ${fwd(saved)}`);

  const hooks = stripOurHooks(settings.hooks);
  if (!UNINSTALL) {
    for (const [event, groups] of Object.entries(HOOK_SPEC)) {
      hooks[event] = [...(hooks[event] || []), ...groups];
    }
  }

  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;

  writeFile(SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
  note(`  hooks ${UNINSTALL ? 'removed from' : 'registered in'} ${fwd(SETTINGS)}`);
}

// --- config ------------------------------------------------------------------

const CONFIG_TEMPLATE = {
  provider: '',
  providers: {},
  mode: 'ask',
  writeStyle: 'nudge',
  defaultContainer: '',
  containers: {},
  excluded: [],
  label: 'Claude',
  dryRun: true,
  createLabels: false,
  minEdits: 2,
  minPrompts: 1,
  debounceSeconds: 90,
  trackBash: true,
  maxPromptChars: 500,
  maxDescriptionChars: 600,
  maxCommentChars: 400,
  ignore: [
    '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**',
    '**/target/**', '**/__pycache__/**', '**/*.lock', '**/*-lock.json', '**/*-lock.yaml', '**/*.log',
  ],
  quiet: false,
  debug: false,
};

function ensureConfig() {
  const configPath = path.join(HOME, 'config.json');
  if (fs.existsSync(configPath)) {
    note(`  existing config kept: ${fwd(configPath)}`);
  } else {
    writeFile(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`);
    note(`  config created: ${fwd(configPath)}`);
  }
  restrictConfig(configPath);
  return configPath;
}

// --- main --------------------------------------------------------------------

console.log(UNINSTALL ? 'Uninstalling workingon' : 'Installing workingon');
console.log(`  runtime: ${fwd(HOME)}`);
console.log(`  skill:   ${fwd(SKILL_DIR)}`);
console.log('');

if (UNINSTALL) {
  patchSettings();
  if (!DRY && fs.existsSync(SKILL_DIR)) {
    fs.rmSync(SKILL_DIR, { recursive: true, force: true });
    note(`  skill removed: ${fwd(SKILL_DIR)}`);
  }
  if (!DRY) {
    for (const sub of ['bin', 'lib', 'hooks', 'providers']) {
      const dir = path.join(HOME, sub);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    note(`  code removed from ${fwd(HOME)}`);
  }
  console.log('');
  console.log(`Config and history are kept in ${fwd(HOME)}. Delete them by hand for a clean slate.`);
} else {
  note('Copying runtime');
  copyDir(path.join(HERE, 'src', 'lib'), path.join(HOME, 'lib'));
  copyDir(path.join(HERE, 'src', 'bin'), path.join(HOME, 'bin'));
  copyDir(path.join(HERE, 'src', 'hooks'), path.join(HOME, 'hooks'));
  copyDir(path.join(HERE, 'src', 'providers'), path.join(HOME, 'providers'));

  note('Installing skill');
  for (const file of ['SKILL.md', 'reference.md']) {
    const source = fs.readFileSync(path.join(HERE, 'skill', file), 'utf8');
    writeFile(path.join(SKILL_DIR, file), source.split('{{WORKINGON}}').join(CLI));
  }

  note('Configuration');
  ensureConfig();

  note('Claude Code settings');
  patchSettings();

  console.log('');
  console.log('Done. Now run the three step setup:');
  console.log('');
  console.log(`  node "${CLI}" setup`);
  console.log('');
  console.log('  Step 1  pick your ticketing tool and paste its token');
  console.log('  Step 2  autosave, or ask once per project');
  console.log('  Step 3  where tickets land, and the label to spot them');
  console.log('');
  console.log('Then restart Claude Code so the hooks load.');
  if (DRY) console.log('\n(nothing was written: this was --dry-run)');
}
