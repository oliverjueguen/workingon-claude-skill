---
name: workingon
description: Record the work done in this Claude Code session in the configured ticketing tool (Jira, Linear, GitHub Issues, Trello or Vikunja), creating the ticket, adding a short progress comment, linking an existing one or closing it. Use it when the [workingon] hook reports unrecorded work, when the user types /workingon, and when they ask to log, track or file what they are working on.
when_to_use: Hook messages starting with "[workingon]", "log this", "file a ticket", "what was I working on", "close the ticket", "record this in Jira/Linear/GitHub/Trello".
argument-hint: "[new <topic> | done | link <id> | status | doctor | setup]"
allowed-tools: Bash(node {{WORKINGON}} *), Read
---

Bridge between this session and the ticketing tool. A local ledger, filled in by hooks, records what was asked, which files were touched, which commits landed and which notable commands ran.

`WO` = `node {{WORKINGON}}`. Every command accepts `--json`.

## Rules

- Record, do not redo. The work is already done; this only documents it.
- One ticket per task, not per session. Work continuing the linked ticket becomes a comment. A different topic becomes a new ticket.
- Never invent anything that is not in the ledger or in the conversation.
- Write in the user's language.
- End the turn with one short line: ticket reference and URL. Nothing else.

## The workspace may be shared

Colleagues may be looking at these boards.

- **Never** create projects, boards or repositories, and never touch tickets this tool did not create.
- **Never** delete anything. `delete` exists for the person to run, not for you. If asked to delete, show what would go and wait for explicit confirmation.
- Only write to the destination that `ledger` resolves. If it says `UNDECIDED`, ask first. Never pick a destination that merely looks right.
- If `create` or `comment` answer `[SIMULATED]`, **nothing was written**. Say exactly that, without implying a ticket exists.

## Default flow

**1. Read the state.**

```
WO ledger --session ${CLAUDE_SESSION_ID}
```

Returns the folder, branch, destination, linked ticket and the work not recorded yet. If the destination is `UNDECIDED`, go to [Undecided folder](#undecided-folder).

**2. Decide.**

- Linked ticket and the work continues it: progress comment (step 3b).
- Linked ticket but this is a different topic: new ticket (step 3a).
- No linked ticket: search before creating.
  ```
  WO find "keywords" --session ${CLAUDE_SESSION_ID}
  ```
  If one is clearly the same thing, link it with `WO link --issue <id> --session ${CLAUDE_SESSION_ID} --keep-unsynced` and go to 3b. Otherwise create.

**3a. Create.**

```
WO create --session ${CLAUDE_SESSION_ID} --title "Title" --body-file - <<'END'
<markdown body>
END
```

**3b. Comment.**

```
WO comment --session ${CLAUDE_SESSION_ID} --file - <<'END'
<markdown comment>
END
```

Both mark the ledger as recorded. Do not run `WO synced` afterwards.

If the heredoc is awkward, write the text to a temporary file and pass its path.

**4. Ask whether it is finished.**

Only when the session had a ticket linked from the start, and only after the
comment or the ticket is written. One question, in the user's language:

> ¿Doy la tarea por acabada?

- **Yes** → `WO update --session ${CLAUDE_SESSION_ID} --done`
- **No** → nothing more. The ticket stays where it is.

Ask, do not decide. Whether something is finished is a judgement about intent, not
about the diff: tests can pass on work that is half of what the person meant. A
ticket closed early is worse than one left open, because nobody looks at closed
tickets again.

Ask once, at the end, and accept the answer. Do not ask again in the same session
if the answer was no.

### The board moves itself

`WO link` drags the card into the "in progress" column, and `WO update --done`
lands it in the done column. Neither needs a separate command and neither should
get one: on Vikunja the second is the server's own doing, because a kanban view
with a done bucket moves the card as soon as the task is marked done.

So never move cards by hand, and never tell the person to. If a card did not move,
`link` says why on its second line, and the reason is always the same kind: no
kanban view, no single column that means "in progress", or a provider without
columns. Report that line as it is rather than working around it.

## How to write the ticket

**Title**: what it achieves, not what was touched. One line under 80 characters, no prefixes.

- Good: `Migrate session auth to JWT`
- Bad: `Changes in auth.ts and login.tsx`, `Work on 12 March`

**Body**: five lines at most. One sentence of context and up to four bullets.

```markdown
<One sentence: what this achieves.>

- <change>
- <change>

Pending: <one line, only if something is left>
```

Leave out file listings, design rationale, conversation recaps, notes sections and test counts. All of that already lives in the code and in git, and in a ticket it only gets in the way.

**Progress comment**: two lines. What moved and what is left. Nothing already in the ticket.

Limits are 600 characters for a body and 400 for a comment, enforced by `create`, `update` and `comment`. If a command rejects your text, summarise it. Do not reach for `--long`.

## Arguments

| Argument | Action |
|---|---|
| _(empty)_ | The default flow above. |
| `new <topic>` | Force a new ticket on that topic, without searching. |
| `<free text>` | Default flow, using that text as the main topic of the title. |
| `done` / `close` | `WO update --session ${CLAUDE_SESSION_ID} --done`. Add a closing comment first if work is unrecorded. |
| `link <id>` | `WO link --issue <id> --session ${CLAUDE_SESSION_ID} --keep-unsynced`, then comment the pending progress. |
| `status` | `WO status --session ${CLAUDE_SESSION_ID}`, summarise in two lines. Do not write. |
| `doctor` | `WO doctor`. If something fails, explain the concrete fix. Do not write. |
| `setup` | See [Setting up](#setting-up). |
| `skip` / `ignore` | `WO synced --session ${CLAUDE_SESSION_ID}`. Drops the pending work without recording it. |

## Undecided folder

Each folder is decided once. Until then nothing is written, and the hook says so.

Ask with AskUserQuestion, one question, these options:

- Record it in the default destination, naming it.
- Record it somewhere else. If chosen, show `WO containers` and ask which.
- Do not record anything from this folder, it is private.

Always save the answer so the question is not repeated:

```
WO config --map <folder>=<container id>     record there
WO config --exclude <folder>                private folder
```

`--exclude` also deletes whatever was already captured locally from that folder, and from then on the hooks store nothing about it.

Then continue the normal flow, or say in one line that nothing was recorded.

## Setting up

`WO setup` runs three steps and can be driven with flags:

1. `WO setup --step 1 --provider jira|linear|github|trello|vikunja` plus that tool's credentials.
2. `WO setup --step 2 --mode ask|autosave|off [--write-style nudge|silent]`
3. `WO setup --step 3 --container <id> [--label "Claude"]`

Never ask the user to paste a token into the chat. Tell them to run `WO setup` themselves in the terminal, or to put it in the config file that `WO doctor` points at. `WO providers` lists the supported tools and `WO doctor` says what is missing.

Full API details and error tables in [reference.md](reference.md).
