#!/usr/bin/env node
/**
 * Generates the Claude Code plugin packaging from the same sources the npx
 * install uses.
 *
 * `skill/SKILL.md` is the single source of truth. It carries a `{{WORKINGON}}`
 * placeholder that the npx installer replaces with an absolute path and that
 * this script replaces with `${CLAUDE_PLUGIN_ROOT}`, so the two distribution
 * paths can never describe different commands.
 *
 * Run with --check to verify the generated files are current without writing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECK = process.argv.includes('--check');

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const PLUGIN_CLI = '${CLAUDE_PLUGIN_ROOT}/src/bin/workingon.mjs';
const HOOKS = '${CLAUDE_PLUGIN_ROOT}/src/hooks';

/**
 * Installed as a plugin, Claude Code runs the hooks straight from the plugin
 * directory, so nothing has to be copied into ~/.claude first. Only the config
 * and the ledger live outside, and those resolve from the home directory.
 */
const hooks = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: `node "${HOOKS}/session-start.mjs"`, timeout: 15 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: `node "${HOOKS}/user-prompt.mjs"`, async: true, timeout: 10 }] },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell',
        hooks: [{ type: 'command', command: `node "${HOOKS}/post-tool.mjs"`, async: true, timeout: 10 }],
      },
    ],
    Stop: [
      {
        hooks: [{
          type: 'command',
          command: `node "${HOOKS}/stop.mjs"`,
          timeout: 30,
          statusMessage: 'Checking work to record',
        }],
      },
    ],
    SessionEnd: [
      { hooks: [{ type: 'command', command: `node "${HOOKS}/session-end.mjs"`, timeout: 30 }] },
    ],
  },
};

const pluginManifest = {
  name: 'workingon',
  description: pkg.description,
  version: pkg.version,
  author: { name: 'oliverjueguen' },
  homepage: pkg.homepage,
  repository: pkg.repository.url.replace(/^git\+|\.git$/g, ''),
  license: pkg.license,
  keywords: pkg.keywords,
};

const marketplace = {
  name: 'workingon',
  owner: { name: 'oliverjueguen' },
  metadata: {
    description: pkg.description,
    version: pkg.version,
  },
  plugins: [
    {
      name: 'workingon',
      source: './',
      description: pkg.description,
      version: pkg.version,
      author: { name: 'oliverjueguen' },
      homepage: pkg.homepage,
      license: pkg.license,
      keywords: pkg.keywords,
      category: 'productivity',
    },
  ],
};

const outputs = [
  ['.claude-plugin/marketplace.json', `${JSON.stringify(marketplace, null, 2)}\n`],
  ['.claude-plugin/plugin.json', `${JSON.stringify(pluginManifest, null, 2)}\n`],
  ['hooks/hooks.json', `${JSON.stringify(hooks, null, 2)}\n`],
  [
    'skills/workingon/SKILL.md',
    fs.readFileSync(path.join(REPO, 'skill', 'SKILL.md'), 'utf8').split('{{WORKINGON}}').join(PLUGIN_CLI),
  ],
  [
    'skills/workingon/reference.md',
    fs.readFileSync(path.join(REPO, 'skill', 'reference.md'), 'utf8').split('{{WORKINGON}}').join(PLUGIN_CLI),
  ],
];

let stale = 0;
for (const [relative, content] of outputs) {
  const target = path.join(REPO, relative);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === content) {
    if (!CHECK) console.log(`  unchanged  ${relative}`);
    continue;
  }
  stale++;
  if (CHECK) {
    console.error(`  STALE  ${relative}`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  console.log(`  written    ${relative}`);
}

if (CHECK && stale) {
  console.error(`\n${stale} generated file(s) out of date. Run \`npm run build:plugin\`.`);
  process.exitCode = 1;
} else if (CHECK) {
  console.log('  plugin packaging is up to date');
}
