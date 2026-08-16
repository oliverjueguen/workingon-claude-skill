# workingon

Records what you work on in Claude Code into your ticketing tool, without you having to remember.

While you work, hooks note in a local ledger what you asked for, which files were touched, which commands ran and which commits landed. When a turn ends, if that adds up to real work, the matching ticket is created or updated.

Supports **Jira**, **Linear**, **GitHub Issues**, **Trello** and **Vikunja**.

## Why hooks and a skill together

A skill alone depends on the model remembering to invoke it. A hook alone cannot write a ticket a human wants to read. Each does what it is good at:

- **Hooks** capture. Deterministic, cheap, and they never break a session.
- **The skill** writes. It has the whole conversation, so the title and body come out readable.

The `Stop` hook joins the two: it notices unrecorded work and hands the decision to Claude.

## Install

```bash
node install.mjs
node ~/.claude/workingon/bin/workingon.mjs setup
```

Setup is three steps:

1. **Token.** Pick your ticketing tool. It prints where to get a token for that specific tool, then verifies the credentials before saving anything.
2. **Autosave or ask.** Record everywhere automatically, or ask once per project. Also who writes the text, and whether to start in simulation mode.
3. **Main information.** Which project, board, repository or team tickets land in, and the label that marks them.

Each step can also run non-interactively:

```bash
workingon setup --step 1 --provider linear --token lin_api_xxx
workingon setup --step 2 --mode ask --write-style nudge
workingon setup --step 3 --container team_abc --label Claude
```

Then restart Claude Code so the hooks load. `workingon doctor` checks everything.

Uninstall with `node install.mjs --uninstall`. It removes the hooks and the skill and keeps your config and history.

## Daily use

Normally you do nothing: work, and the ticket appears at the end of the turn.

| Command | What it does |
|---|---|
| `/workingon` | Record what is pending right now |
| `/workingon new <topic>` | Force a new ticket |
| `/workingon done` | Close this session's ticket |
| `/workingon link 42` | Link the session to an existing ticket |
| `/workingon status` | What is pending and where |
| `/workingon skip` | Drop the pending work without recording it |
| `/workingon doctor` | Diagnose configuration and connection |

## Modes

**`mode`** decides whether you are asked:

- `ask` (default): the first time work piles up in a new folder, you are asked whether it should be recorded, and the answer is remembered. Best if any of your projects are private.
- `autosave`: record everywhere, using the default destination.
- `off`: capture nothing.

**`writeStyle`** decides who writes:

- `nudge` (default): Claude writes the ticket, with the full session context. Better wording, at the cost of an occasional extra turn.
- `silent`: the hook writes a factual entry itself and never interrupts. Titles come from your first request, verbatim.

## Private projects

`workingon config --exclude <folder>` marks a folder private. Nothing from it is sent **and nothing is captured locally either**: the prompt and tool hooks return before writing, SessionStart creates no state, and whatever had already been captured from that folder is deleted.

Blocking only the upload would not be enough. Your prompts and file names would still pile up in a ledger on disk, which for a private project is nearly as bad.

Exclusion beats any mapping, so an old `--map` cannot resurrect it. Undo with `--include`.

## Secrets

Everything captured passes through a redactor before touching disk. A token pasted into the chat would otherwise land in the ledger, and from there into a ticket body the whole team reads.

Redaction happens at three points: capturing the prompt, capturing the command, and again in the client just before any write, in case the model composed the text by hand.

It recognises Vikunja, JWT, GitHub, Anthropic, OpenAI, AWS, Slack and Google tokens, `Authorization` headers, credentials inside a URL, private key blocks and assignments like `API_KEY=...`.

What it deliberately leaves alone: git shas, file paths and ordinary prose mentioning the word password. A redactor with false positives gets switched off, so the rules are anchored to recognisable prefixes rather than to "long hex string".

## Safe defaults for shared workspaces

- **`dryRun: true`.** Nothing is written. Every intended write is logged in full to `~/.claude/workingon/dry-run.log`. Watch it for a few days, then `config --set dryRun=false`.
- **No default destination.** Until step 3 runs, only mapped folders record anything. An unmapped folder writes nowhere rather than somewhere wrong.
- **`createLabels: false`.** No invented labels in a shared workspace. A missing label is skipped and reported.
- The skill is told never to create projects, never to touch tickets it did not create, and never to delete.

## What counts as work

At least one commit, or two modified files. `node_modules`, `.git`, `dist`, lockfiles and similar noise are ignored, as are irrelevant commands: only commits, pushes, tests, builds, deploys and migrations are kept.

Tune with `minEdits`, `minPrompts`, `ignore` and `trackBash`.

The Stop hook also never says the same thing twice, respects `debounceSeconds`, demands clearly more work before repeating a nudge you ignored, stays quiet while background tasks are running, and never chains into itself.

## Ticket shape

Bodies are capped at 600 characters and comments at 400, enforced by `create`, `update` and `comment`. Over the limit is rejected, not truncated: cutting text loses information silently, and the point is to make the writer summarise. `--long` exists as an explicit escape hatch.

## Layout

```
src/providers/   one adapter per tool, plus the shared contract in base.mjs
src/lib/         config, ledger, markdown conversion, redaction, SpecKit
src/bin/         the command line interface
src/hooks/       session-start, user-prompt, post-tool, stop, session-end
skill/           SKILL.md and reference.md
test/            mocked APIs for all five tools, and the suite
```

The ledger lives in `~/.claude/workingon/sessions/`: an append-only `.jsonl` of events per session, plus a `.state.json` holding the linked ticket. Sessions older than 30 days are pruned automatically.

## Tests

```bash
npm test
```

Starts a mock server impersonating all five APIs, installs into a temporary directory, and runs 180 checks. Half of them are a contract every provider must satisfy, run five times; the rest cover the hooks, redaction, brevity and per folder decisions. Nothing touches a real instance.

## Per tool notes

- **Jira**: REST v2 on purpose. v3 rejects a plain string description and demands Atlassian Document Format, a nested JSON tree. Closing an issue is a workflow transition, not a field.
- **Linear**: the personal API key goes in `Authorization` raw. Adding `Bearer` fails authentication.
- **GitHub**: issues cannot be deleted through the API, only closed. Issue ids are `owner/repo#number`.
- **Trello**: a container is a list, because that is where cards live. There is no "done", so closing archives the card.
- **Vikunja**: PUT creates and POST updates, update replaces the whole task, and rich text is HTML. `per_page` is capped by the instance and truncates silently, so listings are paginated.

If a repository uses [SpecKit](https://speckit.org), the active feature is detected from the branch and surfaced at session start.

More detail in `skill/reference.md`.
