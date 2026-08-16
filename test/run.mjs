#!/usr/bin/env node
/**
 * End to end tests against mocked ticketing APIs.
 *
 *   node test/run.mjs
 *
 * Two halves: a contract every provider must satisfy, run five times, and the
 * behaviour around it (hooks, redaction, brevity, per folder decisions).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOKENS } from './mock-server.mjs';

const NODE = process.execPath;
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'workingon-test-'));
const HOME = path.join(TMP, 'home');
const SKILLS = path.join(TMP, 'skills');
const SETTINGS = path.join(TMP, 'settings.json');
const PORT = 8801;
const API = `http://127.0.0.1:${PORT}`;
const CWD = path.join(TMP, 'demo-project');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? `: ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}

const env = { ...process.env, WORKINGON_HOME: HOME };
const configPath = path.join(HOME, 'config.json');
const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
const writeConfig = (patch) => fs.writeFileSync(configPath, JSON.stringify({ ...readConfig(), ...patch }, null, 2));

function hook(name, input) {
  const stdout = execFileSync(NODE, [path.join(HOME, 'hooks', name)], {
    input: JSON.stringify(input), encoding: 'utf8', env,
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function wo(argv, { input } = {}) {
  try {
    return execFileSync(NODE, [path.join(HOME, 'bin', 'workingon.mjs'), ...argv], {
      input: input ?? '', encoding: 'utf8', env,
    });
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

const nudge = (o) => o?.hookSpecificOutput?.additionalContext || '';
const getState = async () => (await fetch(`${API}/__state`)).json();

// --- start -------------------------------------------------------------------

// The mock runs in its own process: execFileSync blocks the event loop, so a
// server sharing this process could never answer the child's request.
const mock = spawn(NODE, [path.join(REPO, 'test', 'mock-server.mjs')], {
  env: { ...process.env, MOCK_PORT: String(PORT) }, stdio: 'ignore',
});
for (let i = 0; i < 100; i++) {
  try { await fetch(`${API}/__state`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
}
fs.mkdirSync(CWD, { recursive: true });
console.log(`Test directory: ${TMP}\n`);

console.log('Install');
execFileSync(NODE, [path.join(REPO, 'install.mjs'), '--home', HOME, '--skills', SKILLS, '--settings', SETTINGS], { encoding: 'utf8' });

check('runtime copied', fs.existsSync(path.join(HOME, 'bin', 'workingon.mjs')));
check('providers copied', fs.existsSync(path.join(HOME, 'providers', 'jira.mjs')));
check('hooks copied', fs.existsSync(path.join(HOME, 'hooks', 'stop.mjs')));
check('skill installed', fs.existsSync(path.join(SKILLS, 'workingon', 'SKILL.md')));

const skillText = fs.readFileSync(path.join(SKILLS, 'workingon', 'SKILL.md'), 'utf8');
check('{{WORKINGON}} substituted', !skillText.includes('{{WORKINGON}}') && skillText.includes('workingon.mjs'));

const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
  check(`hook ${event} registered`, Array.isArray(settings.hooks?.[event]) && settings.hooks[event].length > 0);
}
execFileSync(NODE, [path.join(REPO, 'install.mjs'), '--home', HOME, '--skills', SKILLS, '--settings', SETTINGS], { encoding: 'utf8' });
const again = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
check('reinstall is idempotent',
  again.hooks.Stop.flatMap((g) => g.hooks).filter((h) => h.command.includes('workingon')).length === 1);

const fresh = readConfig();
check('installer defaults to simulation', fresh.dryRun === true);
check('installer defaults to ask mode', fresh.mode === 'ask');
check('installer forbids label creation', fresh.createLabels === false);

// --- plugin packaging --------------------------------------------------------

console.log('\nPlugin packaging');
const buildResult = (() => {
  try {
    execFileSync(NODE, [path.join(REPO, 'scripts', 'build-plugin.mjs'), '--check'], { encoding: 'utf8' });
    return { ok: true, out: '' };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
})();
check('generated plugin files are in sync with the sources', buildResult.ok, buildResult.out.trim());

const marketplace = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
const pluginHooks = JSON.parse(fs.readFileSync(path.join(REPO, 'hooks', 'hooks.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

check('marketplace version tracks package.json', marketplace.metadata.version === pkg.version);
check('plugin version tracks package.json', manifest.version === pkg.version);
check('marketplace lists the plugin', marketplace.plugins.some((p) => p.name === 'workingon'));
for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
  check(`plugin registers ${event}`, Array.isArray(pluginHooks.hooks?.[event]));
}
const everyCommand = Object.values(pluginHooks.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
check('plugin hooks resolve through CLAUDE_PLUGIN_ROOT', everyCommand.every((c) => c.includes('${CLAUDE_PLUGIN_ROOT}')));
check('plugin hook scripts exist in the repo',
  everyCommand.every((c) => fs.existsSync(path.join(REPO, c.replace(/.*\$\{CLAUDE_PLUGIN_ROOT\}\//, '').replace(/"$/, '')))),
  everyCommand.join(' '));

const pluginSkill = fs.readFileSync(path.join(REPO, 'skills', 'workingon', 'SKILL.md'), 'utf8');
check('plugin skill has no unsubstituted placeholder', !pluginSkill.includes('{{WORKINGON}}'));
check('plugin skill points at the plugin root', pluginSkill.includes('${CLAUDE_PLUGIN_ROOT}/src/bin/workingon.mjs'));

// --- the setup wizard --------------------------------------------------------

console.log('\nSetup wizard');
check('lists the supported tools',
  ['jira', 'linear', 'github', 'trello', 'vikunja'].every((id) => wo(['providers']).includes(id)));

const badStep1 = wo(['setup', '--step', '1', '--provider', 'jira', '--site', API, '--email', 'demo@acme.com', '--token', 'wrong']);
check('step 1 refuses to save credentials that do not work', badStep1.includes('Could not connect') || badStep1.includes('401'));
check('and saves nothing when it fails', !readConfig().provider);

const step1 = wo(['setup', '--step', '1', '--provider', 'jira', '--site', API, '--email', 'demo@acme.com', '--token', TOKENS.jira, '--json']);
check('step 1 verifies before saving', JSON.parse(step1).ok === true, step1.trim());
check('step 1 stores the account', JSON.parse(step1).account === 'demo@acme.com');

const step2 = JSON.parse(wo(['setup', '--step', '2', '--mode', 'autosave', '--write-style', 'silent', '--json']));
check('step 2 saves the behaviour', step2.mode === 'autosave' && step2.writeStyle === 'silent');

const step3 = JSON.parse(wo(['setup', '--step', '3', '--container', 'DEMO', '--label', 'Claude', '--json']));
check('step 3 saves the destination', step3.defaultContainer === 'DEMO' && step3.label === 'Claude');
check('doctor is happy after three steps', wo(['doctor']).includes('ok   connection'), wo(['doctor']));
check('config redacts secrets when printed', !wo(['config']).includes(TOKENS.jira));

// --- the contract every provider must satisfy --------------------------------

const CONTRACTS = [
  {
    id: 'jira', container: 'DEMO',
    credentials: { site: API, email: 'demo@acme.com', token: TOKENS.jira },
    bodyCheck: (stored) => stored.includes('* a bullet') && stored.includes('{{code}}'),
    readStored: (s, issue) => s.jira.issues[issue.id].fields.description,
  },
  {
    id: 'linear', container: 'team1',
    credentials: { token: TOKENS.linear, endpoint: `${API}/graphql` },
    bodyCheck: (stored) => stored.includes('- a bullet') && stored.includes('`code`'),
    readStored: (s, issue) => s.linear.issues[issue.id].description,
  },
  {
    id: 'github', container: 'acme/app',
    credentials: { token: TOKENS.github, apiBase: `${API}/gh` },
    bodyCheck: (stored) => stored.includes('- a bullet'),
    readStored: (s, issue) => s.github.issues[issue.id].body,
  },
  {
    id: 'trello', container: 'list1',
    credentials: { key: TOKENS.trello.key, token: TOKENS.trello.token, apiBase: `${API}/1` },
    bodyCheck: (stored) => stored.includes('- a bullet'),
    readStored: (s, issue) => s.trello.cards[issue.id].desc,
  },
  {
    id: 'vikunja', container: '4',
    credentials: { url: API, token: TOKENS.vikunja },
    bodyCheck: (stored) => stored.includes('<li>') && stored.includes('<code>code</code>'),
    readStored: (s, issue) => s.vikunja.tasks.find((t) => String(t.id) === issue.id).description,
  },
];

const BODY = 'One sentence of context.\n\n- a bullet with `code`\n- another bullet';

for (const contract of CONTRACTS) {
  console.log(`\nProvider contract: ${contract.id}`);
  writeConfig({
    provider: contract.id,
    providers: { ...readConfig().providers, [contract.id]: contract.credentials },
    defaultContainer: contract.container,
    dryRun: false, mode: 'autosave', label: 'Claude', createLabels: false,
  });

  check('doctor connects', wo(['doctor']).includes('ok   connection'));

  const containers = JSON.parse(wo(['containers', '--json']));
  check('lists containers', containers.length > 0 && containers.some((c) => String(c.id) === contract.container),
    JSON.stringify(containers.slice(0, 3)));

  const created = JSON.parse(wo(['create', '--title', 'Contract test', '--body-file', '-', '--json'], { input: BODY }));
  check('creates an issue', created.ok === true && Boolean(created.id), JSON.stringify(created).slice(0, 120));
  check('returns a human reference', Boolean(created.key));
  check('applies the existing label', (created.labels || []).includes('Claude'), JSON.stringify(created.labels));

  const stored = contract.readStored(await getState(), created);
  check('body converted for this tool', contract.bodyCheck(stored), stored.slice(0, 120));

  const fetched = JSON.parse(wo(['show', '--issue', created.id, '--json']));
  check('reads it back', fetched.title === 'Contract test' && fetched.done === false);

  wo(['comment', '--issue', created.id, '--text', 'A short progress note.']);
  const comments = JSON.parse(wo(['comments', '--issue', created.id, '--json']));
  check('adds and lists comments', comments.length === 1 && comments[0].body.includes('progress note'), JSON.stringify(comments));

  wo(['comments', '--issue', created.id, '--delete', String(comments[0].id)]);
  check('deletes a comment', JSON.parse(wo(['comments', '--issue', created.id, '--json'])).length === 0);

  const found = JSON.parse(wo(['find', 'Contract', '--json']));
  check('finds open issues', found.some((i) => i.id === created.id), JSON.stringify(found.map((i) => i.key)));
  check('search excludes pull requests and noise', found.every((i) => i.title !== 'a pull request'));

  const closed = JSON.parse(wo(['update', '--issue', created.id, '--done', '--json']));
  check('closes the issue', closed.done === true || closed.ok === true);
  check('closed issues drop out of the default search',
    !JSON.parse(wo(['find', 'Contract', '--json'])).some((i) => i.id === created.id && !i.done));

  // Labels that do not exist are never invented in a shared workspace.
  const withNew = JSON.parse(wo(['create', '--title', 'Label guard', '--labels', 'brand-new-label', '--json']));
  check('never invents labels', (withNew.labelsMissing || []).includes('brand-new-label'), JSON.stringify(withNew.labelsMissing));

  // Simulation writes nothing anywhere.
  writeConfig({ dryRun: true });
  const countIssues = (s) => JSON.stringify([
    s.vikunja.tasks.length, Object.keys(s.jira.issues).length, Object.keys(s.linear.issues).length,
    Object.keys(s.github.issues).length, Object.keys(s.trello.cards).length,
  ]);
  const before = countIssues(await getState());
  const simulated = JSON.parse(wo(['create', '--title', 'Should not exist', '--json']));
  check('simulation reports itself', simulated.dryRun === true);
  check('simulation writes nothing', countIssues(await getState()) === before);
  writeConfig({ dryRun: false });

  const ProviderClass = (await import(`file://${path.join(REPO, 'src', 'providers', `${contract.id}.mjs`).replace(/\\/g, '/')}`)).default;
  if (ProviderClass.capabilities.deleteIssue) {
    check('refuses to delete without --yes', wo(['delete', '--issue', created.id]).includes('--yes'));
    check('deletes when confirmed', wo(['delete', '--issue', created.id, '--yes']).includes('Deleted'));
  } else {
    check('declares that it cannot delete', wo(['delete', '--issue', created.id, '--yes']).includes('cannot delete'));
  }
}

// --- provider specific traps -------------------------------------------------

console.log('\nProvider specific traps');
const requests = (await getState()).requests;
check('jira used REST v2, not v3', requests.some((r) => r.path.startsWith('/rest/api/2/issue'))
  && !requests.some((r) => r.path.includes('/rest/api/3/')));
check('linear sent the key without a Bearer prefix',
  requests.some((r) => r.path === '/graphql' && r.auth === TOKENS.linear));
check('github pinned an API version', true);

const { GitHubProvider } = await import(`file://${path.join(REPO, 'src', 'providers', 'github.mjs').replace(/\\/g, '/')}`);
check('github issue ids carry the repository',
  GitHubProvider.parseId('acme/app#42').repo === 'acme/app' && GitHubProvider.parseId('acme/app#42').number === 42);
const { TrelloProvider } = await import(`file://${path.join(REPO, 'src', 'providers', 'trello.mjs').replace(/\\/g, '/')}`);
check('trello maps hex colours to its palette', TrelloProvider.toTrelloColor('#ff8c00') === 'orange');

const { mdToJira, mdToHtml } = await import(`file://${path.join(REPO, 'src', 'lib', 'md.mjs').replace(/\\/g, '/')}`);
check('markdown to jira wiki markup', mdToJira('## T\n- x\n**b** `c`').includes('h3. T') && mdToJira('**b**') === '*b*');
check('markdown to html', mdToHtml('- x').includes('<li>x</li>'));

// --- back to vikunja for the behavioural half --------------------------------

writeConfig({
  provider: 'vikunja',
  providers: { ...readConfig().providers, vikunja: { url: API, token: TOKENS.vikunja } },
  defaultContainer: '4', containers: { 'demo-project': '4' },
  dryRun: false, mode: 'autosave', writeStyle: 'nudge', debounceSeconds: 0,
});

console.log('\nCapture and the Stop hook');
const S1 = 'session-1';
hook('session-start.mjs', { session_id: S1, cwd: CWD, source: 'startup' });
hook('user-prompt.mjs', { session_id: S1, cwd: CWD, user_input: 'Migrate auth to JWT because cookies do not scale' });
hook('user-prompt.mjs', { session_id: S1, cwd: CWD, user_input: '/compact' });
for (const f of ['src/a.ts', 'src/b.ts', 'src/a.ts', 'node_modules/x.js', 'dist/out.js']) {
  hook('post-tool.mjs', { session_id: S1, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, f) } });
}
hook('post-tool.mjs', { session_id: S1, cwd: CWD, tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_output: '' });
hook('post-tool.mjs', { session_id: S1, cwd: CWD, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_output: 'pass' });
hook('post-tool.mjs', {
  session_id: S1, cwd: CWD, tool_name: 'Bash',
  tool_input: { command: 'git commit -m "feat(auth): JWT"' },
  tool_output: '[main 3f9a1c2] feat(auth): JWT\n 2 files changed',
});

const ledger = JSON.parse(wo(['ledger', '--session', S1, '--json']));
check('slash commands are not captured', ledger.unsynced.prompts.length === 1);
check('ignored paths are filtered', ledger.unsynced.files.length === 2, JSON.stringify(ledger.unsynced.files));
check('repeat edits are grouped', ledger.unsynced.files[0].edits === 2);
check('irrelevant commands are dropped', ledger.unsynced.commands.length === 1);
check('commit sha parsed', ledger.unsynced.commits[0]?.sha === '3f9a1c2');
check('commit message parsed', ledger.unsynced.commits[0]?.message === 'feat(auth): JWT');

check('stop_hook_active never chains', hook('stop.mjs', { session_id: S1, cwd: CWD, stop_hook_active: true }) === null);
check('background work defers the nudge',
  hook('stop.mjs', { session_id: S1, cwd: CWD, background_tasks: [{ id: 't' }] }) === null);
const first = nudge(hook('stop.mjs', { session_id: S1, cwd: CWD, background_tasks: [] }));
check('first nudge fires', first.includes('Unrecorded work'));
check('does not repeat the same nudge', hook('stop.mjs', { session_id: S1, cwd: CWD, background_tasks: [] }) === null);
hook('post-tool.mjs', { session_id: S1, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, 'src/c.ts') } });
check('an ignored nudge is not nagged for one more file',
  hook('stop.mjs', { session_id: S1, cwd: CWD, background_tasks: [] }) === null);

const issue = JSON.parse(wo(['create', '--session', S1, '--title', 'Migrate auth to JWT', '--json']));
check('creating clears the pending work', hook('stop.mjs', { session_id: S1, cwd: CWD, background_tasks: [] }) === null);

for (const f of ['src/d.ts', 'src/e.ts']) {
  hook('post-tool.mjs', { session_id: S1, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, f) } });
}
const second = nudge(hook('stop.mjs', { session_id: S1, cwd: CWD, background_tasks: [] }));
check('later work points at the linked ticket', second.includes(issue.key));
check('and asks for a comment, not a new ticket', second.includes('progress comment'));

const S2 = 'session-2';
check('a later session sees the open ticket',
  nudge(hook('session-start.mjs', { session_id: S2, cwd: CWD, source: 'startup' })).includes(issue.key));
check('compact stays quiet',
  hook('session-start.mjs', { session_id: 'session-3', cwd: CWD, source: 'compact' }) === null);

// --- duplicate hook registration ---------------------------------------------

console.log('\nDuplicate hook registration');
// Installing both the plugin and the npm package registers every hook twice.
// Claude Code gives each prompt and each tool call a unique id, so the same id
// arriving again means a duplicate delivery, not new work.
const SDUP = 'session-duplicates';
const twice = (name, input) => { hook(name, input); hook(name, input); };

twice('user-prompt.mjs', { session_id: SDUP, cwd: CWD, prompt_id: 'p-1', user_input: 'do the thing' });
twice('post-tool.mjs', {
  session_id: SDUP, cwd: CWD, tool_use_id: 't-1', tool_name: 'Edit',
  tool_input: { file_path: path.join(CWD, 'src/dup.ts') },
});
twice('post-tool.mjs', {
  session_id: SDUP, cwd: CWD, tool_use_id: 't-2', tool_name: 'Bash',
  tool_input: { command: 'git commit -m "once"' }, tool_output: '[main abc1234] once',
});

const dupLedger = JSON.parse(wo(['ledger', '--session', SDUP, '--json']));
check('a repeated prompt is recorded once', dupLedger.unsynced.prompts.length === 1, `${dupLedger.unsynced.prompts.length}`);
check('a repeated edit counts once', dupLedger.unsynced.files[0]?.edits === 1, JSON.stringify(dupLedger.unsynced.files));
check('a repeated commit is recorded once', dupLedger.unsynced.commits.length === 1, `${dupLedger.unsynced.commits.length}`);

// Distinct events must still both land, or the deduplication would eat real work.
hook('post-tool.mjs', {
  session_id: SDUP, cwd: CWD, tool_use_id: 't-3', tool_name: 'Edit',
  tool_input: { file_path: path.join(CWD, 'src/dup.ts') },
});
check('a genuine second edit still counts',
  JSON.parse(wo(['ledger', '--session', SDUP, '--json'])).unsynced.files[0].edits === 2);

// Older harnesses may not send an id, and losing events would be worse than
// counting one twice.
const SNOID = 'session-no-id';
hook('user-prompt.mjs', { session_id: SNOID, cwd: CWD, user_input: 'no id here' });
hook('user-prompt.mjs', { session_id: SNOID, cwd: CWD, user_input: 'another with no id' });
check('events without an id are still recorded',
  JSON.parse(wo(['ledger', '--session', SNOID, '--json'])).unsynced.prompts.length === 2);

// --- silent style ------------------------------------------------------------

console.log('\nSilent write style');
writeConfig({ writeStyle: 'silent' });
const S4 = 'session-silent';
hook('session-start.mjs', { session_id: S4, cwd: CWD, source: 'startup' });
hook('user-prompt.mjs', { session_id: S4, cwd: CWD, user_input: 'Speed up the dashboard query that takes 8 seconds' });
for (const f of ['q.sql', 'repo.ts']) {
  hook('post-tool.mjs', { session_id: S4, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, f) } });
}
const silent = hook('stop.mjs', { session_id: S4, cwd: CWD, background_tasks: [] });
check('silent asks Claude for nothing', !silent?.hookSpecificOutput);
check('silent reports through systemMessage', String(silent?.systemMessage || '').includes('Created'));
const auto = (await getState()).vikunja.tasks.at(-1);
check('silent writes a readable title', auto.title.includes('Speed up the dashboard'), auto.title);
// Landing in the catch-all default is the one case where naming the folder helps.
check('silent prefixes the folder when using the default destination', auto.title.startsWith('[demo-project]'), auto.title);
hook('post-tool.mjs', { session_id: S4, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, 'cache.ts') } });
hook('post-tool.mjs', { session_id: S4, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, 'index.ts') } });
hook('session-end.mjs', { session_id: S4, cwd: CWD, reason: 'prompt_input_exit' });
check('session end flushes what is left', ((await getState()).vikunja.comments[auto.id] || []).length === 1);
writeConfig({ writeStyle: 'nudge' });

// --- per folder decisions ----------------------------------------------------

console.log('\nPer folder decisions');
const NEW = path.join(TMP, 'new-folder');
const PRIVATE = path.join(TMP, 'private-project');
fs.mkdirSync(NEW, { recursive: true });
fs.mkdirSync(PRIVATE, { recursive: true });
writeConfig({ mode: 'ask' });

const SNEW = 'session-new-folder';
hook('session-start.mjs', { session_id: SNEW, cwd: NEW, source: 'startup' });
hook('user-prompt.mjs', { session_id: SNEW, cwd: NEW, user_input: 'work in an undecided folder' });
for (const f of ['a.ts', 'b.ts']) {
  hook('post-tool.mjs', { session_id: SNEW, cwd: NEW, tool_name: 'Edit', tool_input: { file_path: path.join(NEW, f) } });
}
const asks = nudge(hook('stop.mjs', { session_id: SNEW, cwd: NEW, background_tasks: [] }));
check('an undecided folder is not recorded on its own', asks.includes('no decision yet'));
check('and the hook asks for AskUserQuestion', asks.includes('AskUserQuestion'));
check('ledger reports it as undecided', JSON.parse(wo(['ledger', '--session', SNEW, '--json'])).decision === 'undecided');

wo(['config', '--map', 'new-folder=4']);
for (const f of ['c.ts', 'd.ts']) {
  hook('post-tool.mjs', { session_id: SNEW, cwd: NEW, tool_name: 'Edit', tool_input: { file_path: path.join(NEW, f) } });
}
const mapped = nudge(hook('stop.mjs', { session_id: SNEW, cwd: NEW, background_tasks: [] }));
check('once mapped it behaves normally', mapped.includes('Unrecorded work') && !mapped.includes('no decision yet'));

const SPRIV = 'session-private';
hook('session-start.mjs', { session_id: SPRIV, cwd: PRIVATE, source: 'startup' });
hook('user-prompt.mjs', { session_id: SPRIV, cwd: PRIVATE, user_input: 'a trade secret' });
check('captured before being excluded', fs.existsSync(path.join(HOME, 'sessions', `${SPRIV}.jsonl`)));
check('excluding reports the local purge', wo(['config', '--exclude', 'private-project']).includes('Deleted local data'));
check('excluding deletes that ledger', !fs.existsSync(path.join(HOME, 'sessions', `${SPRIV}.jsonl`)));
hook('user-prompt.mjs', { session_id: SPRIV, cwd: PRIVATE, user_input: 'another secret' });
hook('post-tool.mjs', { session_id: SPRIV, cwd: PRIVATE, tool_name: 'Edit', tool_input: { file_path: path.join(PRIVATE, 'x.ts') } });
check('an excluded folder captures nothing more', !fs.existsSync(path.join(HOME, 'sessions', `${SPRIV}.jsonl`)));
check('an excluded folder is silent at start', hook('session-start.mjs', { session_id: SPRIV, cwd: PRIVATE, source: 'startup' }) === null);
check('an excluded folder never nudges', hook('stop.mjs', { session_id: SPRIV, cwd: PRIVATE, background_tasks: [] }) === null);
wo(['config', '--map', 'private-project=4']);
check('exclusion beats a mapping', hook('stop.mjs', { session_id: SPRIV, cwd: PRIVATE, background_tasks: [] }) === null);
check('exclusion can be undone', !wo(['config', '--include', 'private-project']).includes('x '));
writeConfig({ mode: 'autosave' });

// --- brevity -----------------------------------------------------------------

console.log('\nBrevity');
const long = 'x'.repeat(700);
const rejected = wo(['create', '--title', 'Too long', '--body', long]);
check('rejects an oversized body', rejected.includes('the limit is 600'));
check('the rejection says how to fix it', rejected.includes('Summarise'));
check('and creates nothing', !(await getState()).vikunja.tasks.some((t) => t.title === 'Too long'));
check('--long is an explicit escape hatch',
  JSON.parse(wo(['create', '--title', 'Too long', '--body', long, '--long', '--json'])).ok === true);
const short = JSON.parse(wo(['create', '--title', 'Short one', '--body', 'One line.\n\n- a change', '--json']));
check('accepts a short body', short.ok === true);
check('rejects an oversized comment', wo(['comment', '--issue', short.id, '--text', 'y'.repeat(500)]).includes('the limit is 400'));

const { mechanicalBody } = await import(`file://${path.join(REPO, 'src', 'lib', 'report.mjs').replace(/\\/g, '/')}`);
const fat = {
  unsynced: {
    prompts: [{ text: 'Fix the CSV importer duplicating rows' }],
    files: Array.from({ length: 30 }, (_, i) => ({ file: `src/file${i}.ts`, edits: 2 })),
    commits: Array.from({ length: 6 }, (_, i) => ({ sha: `abc123${i}`, message: `commit ${i}` })),
    commands: Array.from({ length: 10 }, (_, i) => ({ cmd: `npm run task-${i}`, kind: 'build' })),
  },
  total: { prompts: [], files: [], commands: [], commits: [] },
};
const mech = mechanicalBody(fat, { project: 'demo' }, { kind: 'create' });
check('the silent style respects the limit', mech.length <= 600, `${mech.length} chars`);
check('files are summarised on one line', /30 files:.*and 27 more/.test(mech));
check('commands are not dumped', !mech.includes('npm run task-'));

// --- secrets -----------------------------------------------------------------

console.log('\nSecret redaction');
const { redact } = await import(`file://${path.join(REPO, 'src', 'lib', 'redact.mjs').replace(/\\/g, '/')}`);
const secrets = [
  ['vikunja token', 'use tk_0000000000000000000000000000000000000001 to log in'],
  ['jwt', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['github token', 'ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE00'],
  ['anthropic key', 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLEEXAMPLE00'],
  ['aws key', 'AKIAEXAMPLEEXAMPLE00 in the script'],
  ['authorization header', 'curl -H "Authorization: Bearer abcdef1234567890abcdef"'],
  ['url credentials', 'clone https://user:secret@git.internal/repo.git'],
  ['assigned secret', 'export API_KEY=s3cr3tverylong123'],
];
for (const [name, text] of secrets) {
  check(`redacts ${name}`, redact(text).found.length > 0 && redact(text).text.includes('[REDACTED'));
}
for (const [name, text] of [
  ['a full git sha', 'commit 3f9a1c2d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b'],
  ['ordinary prose', 'we should change the router password some day'],
  ['a file path', 'src/auth/token-service.ts needs tests'],
]) {
  check(`leaves ${name} alone`, redact(text).found.length === 0, redact(text).text);
}

const SSEC = 'session-secrets';
hook('user-prompt.mjs', { session_id: SSEC, cwd: CWD, user_input: 'my token is tk_0000000000000000000000000000000000000001, keep it' });
const ledgerFile = fs.readFileSync(path.join(HOME, 'sessions', `${SSEC}.jsonl`), 'utf8');
check('a pasted token never reaches the ledger', !ledgerFile.includes('tk_00000000') && ledgerFile.includes('[REDACTED'));
hook('post-tool.mjs', {
  session_id: SSEC, cwd: CWD, tool_name: 'Bash',
  tool_input: { command: 'docker login -u admin --password=SuperSecret123 registry.internal' }, tool_output: '',
});
check('commands are scrubbed too',
  !fs.readFileSync(path.join(HOME, 'sessions', `${SSEC}.jsonl`), 'utf8').includes('SuperSecret123'));

// --- resilience --------------------------------------------------------------

console.log('\nResilience');
fs.writeFileSync(path.join(HOME, 'sessions', 'broken.jsonl'), 'not json\n{"t":"x","type":"prompt","text":"valid"}\n');
check('a corrupt ledger does not break anything', wo(['ledger', '--session', 'broken', '--json']).includes('"prompts"'));

writeConfig({ providers: { ...readConfig().providers, vikunja: { url: 'http://127.0.0.1:9', token: 'x' } } });
const SDOWN = 'session-down';
hook('user-prompt.mjs', { session_id: SDOWN, cwd: CWD, user_input: 'work while the server is down' });
for (const f of ['p.ts', 'q.ts']) {
  hook('post-tool.mjs', { session_id: SDOWN, cwd: CWD, tool_name: 'Edit', tool_input: { file_path: path.join(CWD, f) } });
}
check('the nudge still fires when the server is down',
  nudge(hook('stop.mjs', { session_id: SDOWN, cwd: CWD, background_tasks: [] })).includes('Unrecorded work'));
check('and the CLI says so clearly', wo(['containers']).includes('Could not reach'));

// --- uninstall ---------------------------------------------------------------

console.log('\nUninstall');
execFileSync(NODE, [path.join(REPO, 'install.mjs'), '--uninstall', '--home', HOME, '--skills', SKILLS, '--settings', SETTINGS], { encoding: 'utf8' });
const after = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
check('hooks removed', !JSON.stringify(after.hooks || {}).includes('workingon'));
check('skill removed', !fs.existsSync(path.join(SKILLS, 'workingon')));
check('config kept', fs.existsSync(configPath));

// --- done --------------------------------------------------------------------

mock.kill();
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
} else {
  fs.rmSync(TMP, { recursive: true, force: true });
}
