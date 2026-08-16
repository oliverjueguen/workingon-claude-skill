# Reference: workingon

Load this only when `workingon` itself is not enough: provider specific errors, token permissions, or when a call has to be made by hand.

`WO` = `node {{WORKINGON}}`

## Commands

| Command | Purpose |
|---|---|
| `WO setup` | Guided three step setup |
| `WO providers` | Supported ticketing tools |
| `WO doctor` | Config, connection, destinations, label |
| `WO status [--session SID]` | Destination, linked ticket, pending work |
| `WO ledger --session SID` | Dump the work not recorded yet |
| `WO containers` | Projects, repositories, teams or lists |
| `WO labels [--create NAME --color hex] [--container ID]` | List or create labels |
| `WO find <text> [--container ID] [--all] [--limit N]` | Search, open tickets by default |
| `WO show --issue ID` | Ticket with its latest comments |
| `WO create --title T [--body-file F] [--container ID] [--labels a,b] [--session SID]` | Create and link |
| `WO comment (--issue ID \| --session SID) (--file F \| --text T)` | Progress comment |
| `WO comments --issue ID [--delete <commentId>]` | List or delete comments |
| `WO update (--issue ID \| --session SID) [--title T] [--body-file F] [--done] [--reopen] [--container ID] [--labels a,b]` | Update |
| `WO delete --issue ID[,ID] --yes` | Delete. For the person, never for the skill |
| `WO link --issue ID --session SID [--keep-unsynced]` | Link an existing ticket |
| `WO synced --session SID` | Mark pending work recorded without writing |
| `WO config [--set k=v] [--map folder=id] [--exclude folder] [--include folder]` | Configuration |

`--body-file -` and `--file -` read stdin, which is what makes heredocs work.
`--json` on any command. `--no-dry-run` makes a single run write for real.

## Supported tools

| Tool | Container | Body | Notes |
|---|---|---|---|
| Jira | project key | wiki markup | REST v2 on purpose, see below |
| Linear | team id | markdown | GraphQL |
| GitHub Issues | `owner/repo` | markdown | Issues cannot be deleted through the API, only closed |
| Trello | list id | markdown | No real "done", closing archives the card |
| Vikunja | project id | HTML | PUT creates, POST updates |

### Jira

Basic auth with account email and API token. **REST v2, not v3**: v3 rejects a plain string description and demands Atlassian Document Format, a nested JSON tree, while v2 accepts wiki markup and is still supported. Markdown is converted to wiki markup automatically.

Closing an issue is a workflow transition, not a field: `GET /issue/{key}/transitions` then POST the one whose target status category is `done`. Labels are free-form strings, so nothing has to be created, but they cannot contain spaces.

Issue type defaults to `Task` and is configurable with `setup --step 1 --issueType`.

### Linear

The personal API key goes in `Authorization` **raw, with no `Bearer` prefix**. Adding it fails authentication, and it is the most common mistake with this API. Closing means moving the issue to a workflow state of type `completed`, looked up per team.

### GitHub Issues

Fine-grained token needs Issues read and write plus Metadata read on the target repositories. Issue ids are `owner/repo#number` because every endpoint needs both and the number alone is only unique inside a repository. The issues endpoint also returns pull requests, which are filtered out.

### Trello

Both a key and a token, sent as query parameters, not headers. A container is a list, because that is where cards live. Label colours come from a fixed palette, so hex values are mapped to the closest name.

### Vikunja

Unusual verbs: **PUT creates and POST updates**, and update replaces the whole task, so the client reads, merges and writes. Rich text is HTML because the editor is TipTap; markdown sent raw shows as literal text. `per_page` is capped at the instance maximum and silently truncates, so listings are paginated.

## Bodies are converted per tool

Always author markdown. The provider converts: HTML for Vikunja, wiki markup for Jira, markdown untouched for the rest. The supported subset is headings, lists, task lists, bold, italic, strikethrough, inline code, code blocks, quotes, links and rules.

## Secrets

`redact.mjs` scrubs prompts and commands as they are captured, and scrubs the body of every write again in the client. Seeing `[REDACTED:type]` in a ticket means the original looked like a credential.

Do not try to recover the original or write it back. If the user needs that value in the ticket, they can add it by hand.

## Common errors

| Symptom | Cause and fix |
|---|---|
| Everything says `[SIMULATED]` | `dryRun` is on, which is the default. Review `dry-run.log`, then `config --set dryRun=false`. |
| 401 or 403 | Token wrong, expired, or missing a scope. `doctor` says which credential is loaded. |
| Jira 400 on create | Usually the issue type does not exist in that project. Set a valid one in step 1. |
| Linear authentication fails | The key was sent with a `Bearer` prefix. It must be raw. |
| GitHub cannot delete | Correct: the REST API cannot delete issues. Close them instead. |
| Labels are not applied | The label does not exist and `createLabels` is off. Create it once with `WO labels --create`. |
| Hook records nothing | `mode` is `off`, the folder is excluded, or the work is below `minEdits`. |
| Repeated nudges | Raise `debounceSeconds` or `minEdits`. |

## Ledger

One file per session under `<home>/sessions/`:

- `<session-id>.jsonl`: append only events, of type `prompt`, `edit`, `bash` and `commit`.
- `<session-id>.state.json`: linked ticket, `lastSyncedSeq`, folder context.

`lastSyncedSeq` counts events already recorded. Anything after it is pending. `create`, `comment`, `update` and `synced` advance it. Sessions older than 30 days are pruned on start.

## When not to record

- Questions and exploration with no changes.
- Edits to ignored paths.
- Anything in an excluded folder.
- Work the user said not to record. Use `WO synced` to drop it.
