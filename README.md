# archai-mcp

MCP server for read/write access to an [Obsidian](https://obsidian.md) vault. Operates directly on the filesystem — no database, no sync layer.

## Setup

```bash
npm install
npm run build
```

## Usage

Copy `vaults.example.json` to `vaults.json` in the project root and edit it:

```bash
cp vaults.example.json vaults.json
```

```json
{
  "default": "tech",
  "vaults": {
    "tech": "../archai/tech",
    "work": { "path": "../archai/work", "log": true }
  }
}
```

Vault paths may be absolute, `~`-prefixed, or relative to `vaults.json`. A vault entry is either a bare path string or `{ "path": ..., "log": true }`. `default` is optional and falls back to the first listed vault.

`vaults.json` is **per-machine** and gitignored — it encodes one machine's paths and vault selection; `vaults.example.json` is the committed template.

**Absent vaults are skipped, not fatal.** The vault repo uses `git sparse-checkout`, so one config can list every vault while a machine materialises only some of them. A configured directory that isn't there gets one warning on stderr and is dropped: it never appears in `list_vaults`' vault list (it's reported under `skipped`), `lint_links` names it in `summary.skipped` so a `healthy: true` never covers a vault it didn't read, and naming it explicitly is refused with a message saying it was skipped rather than that it doesn't exist. The server only fails if *nothing* configured is present.

```bash
node dist/index.js
```

### Claude Code

Add to `~/.claude/settings.json` — no env vars needed, the server reads `vaults.json` from its own directory:

```json
{
  "mcpServers": {
    "archai": {
      "command": "node",
      "args": ["/absolute/path/to/archai-mcp/dist/index.js"]
    }
  }
}
```

## Vaults

The server can serve multiple vaults from one instance. Every tool accepts an optional `vault` argument:

- `save`, `save_reference`, `read`, `update`, `create_folder`, `find_backlinks`, `rewrite_links`, `move`, `bulk_move` — default to the **primary** vault (`default` in `vaults.json`).
- `search`, `list`, `lint_links` — span **all** vaults when no `vault` is given; results are labeled `[vaultname]`. Pass `vault` to scope to one.
- `list_vaults` — discover the configured vault names (use these as `vault` values).

## Tools

| Tool | Description |
|------|-------------|
| `save` | Create a note with frontmatter (`status` defaults to `draft`). Rejects Cyrillic titles. Checks for duplicates first — use `force: true` to skip. |
| `save_reference` | Store raw source material verbatim under `references/`. No frontmatter, no duplicate check, immutable. |
| `read` | Read the full content of a note by path. |
| `search` | Search notes by filename and content across all vaults. Returns top 10 with snippets. |
| `list` | List notes across all vaults, optionally filtered by folder. Sorted by creation date. |
| `update` | Replace note body, preserve frontmatter, bump `updated` date, merge `sources`, optionally change `status`/`verified`/`stale_when`. |
| `create_folder` | Create a folder (and any parent folders). |
| `list_vaults` | List configured vaults and their roots. |
| `find_backlinks` | Every note linking to a given note, with line numbers and the link text as written. Read-only. |
| `lint_links` | Classify every wikilink as `ok` / `planned` / `external` / `renamed-candidate` / `broken`, with a machine-readable summary. Read-only. |
| `rewrite_links` | Rewrite link targets from an old→new mapping, preserving aliases and headings. |
| `move` | Rename or relocate a note (`git mv`) and rewrite every inbound wikilink. One commit. |
| `bulk_move` | Several moves as one atomic batch — validated up front, rolled back in full on any failure. |

### Refactoring and link health

Obsidian rewrites wikilinks only when *Obsidian* performs a rename. A rename done from the shell, from git, or by an agent leaves every inbound link dangling — which is what `move` and `bulk_move` exist to prevent, and what `lint_links` exists to catch.

```
move(from: "concepts/old-name.md", to: "concepts/new-name.md")
  -> git mv, then [[old-name]], [[folder/old-name]], [[old-name|Label]] and
     [[old-name#Heading]] all become [[new-name...]] across the vault
```

Aliases and headings survive a rewrite (`[[old|Label]]` → `[[new|Label]]`); losing one would be a silent content regression. Links inside fenced blocks and inline code are not links and are never touched or reported.

`lint_links` distinguishes real breakage from the two kinds that aren't:

- **`planned`** — a dangling link whose line carries `<!-- intentional -->`. The vault deliberately links forward to notes not written yet. Not a failure.
- **`external`** — the target exists in a *different* vault. Each vault is its own Obsidian root, so cross-vault links are unresolvable by design. Never reported as broken, never "fixed".

`renamed-candidate` findings carry a `suggestion`, sourced from git rename history or basename similarity, so bulk repair is one `rewrite_links` call rather than manual triage.

Every mutating tool takes `dry_run: true`, which reports the exact diff a real run would apply and writes nothing.

### References

`save_reference(path, content, vault?)` writes `content` byte-for-byte to `references/<path>` — raw material (a spec, a transcript, a dump) rather than an authored note, so it gets no frontmatter and no kebab-cased filename, and `save`'s duplicate check does not apply.

References are immutable by construction: there is no `update_reference` tool, and writing over an existing reference is refused. Store a corrected copy under a new path instead.

## History

Every successful write — `save`, `update`, `save_reference`, `rewrite_links`, `move`, `bulk_move` — is committed to the vault's git repo. Read-only tools (`read`, `search`, `list`, `list_vaults`, `find_backlinks`, `lint_links`) never write or commit.

- **Repo discovery.** A repo that already governs the vault is reused, whether that's the vault's own `.git` or an enclosing one (a notes repo holding several vaults). `git init` runs only when the vault is in no repo at all, so existing history is never re-rooted or rewritten.
- **Commits stage exactly the paths the tool wrote** — `git add` + `git commit` from the vault root with the written paths as the pathspec, never `.`. All the vaults here live inside *one* repo, so an unscoped commit would sweep in whatever else is dirty; and even scoped to a single vault, `-A -- .` used to pull unrelated in-progress edits into a commit whose message named one file. After a tool call, everything the tool did is committed and everything else is still pending.
- **Best-effort.** A missing git binary, an absent committer identity or a no-op commit never fails the tool call — a warning goes to stderr and the write stands.
- **One commit per operation.** `move` commits the rename *and* every link it rewrote together (`move: a.md -> b.md (+4 links in 1 files)`), and `bulk_move` commits the whole batch — not one commit per file touched.
- **Rollback** for the multi-file tools comes from a per-file journal, not from git. Both vaults may share one repo and normally carry uncommitted Obsidian edits, so `reset --hard` or `stash` would revert work the server never wrote.
- **`log.md`** is **opt-in per vault and off by default** — set `"log": true` on the vault's config entry. It is written in the same commit as the change it describes, so it restates `git log` with less information; vaults that want the human-readable digest ask for it. When enabled it lives at the vault root (one per vault, not per directory), with entries under a `## YYYY-MM-DD` heading:

```markdown
## 2026-08-17

* **Creation**: [[concepts/react-hooks]] — React Hooks
* **Update**: [[concepts/react-hooks]] — React Hooks
* **Reference**: references/rfc/rfc-9110.txt
```

Requires the `git` CLI on `PATH`. There is no git library dependency.

## Note status and expiry

`status` has exactly two values:

- **`draft`** — anything not checked against its source. The default.
- **`verified`** — checked against the source on the date in `verified`.

The two are paired both ways: `status: verified` requires a `verified: YYYY-MM-DD` date, and a date without that status is refused. A verified claim with no date is unfalsifiable, and a date under a draft status is a leftover from a demotion — either makes the field useless for deciding whether to trust a note, which is the only reason it exists. Setting `status: draft` on a verified note drops the date and says so.

The retired `seedling`/`growing`/`evergreen` scale is **rejected by name**, with an error pointing at the replacement. It carried no information — 58 of 76 notes sat in `seedling` purely because it was the default — so a stale client reintroducing it fails loudly instead of quietly.

`stale_when` is free text describing the condition under which a note stops being true:

```yaml
stale_when: 'prod moves past v1.63.0+2053 or the content model changes'
```

Deliberately event-based rather than a date, because that is how these notes actually expire. Nothing evaluates it — it is prose for whoever opens the note. `update` preserves it untouched unless you pass a new value (or `""` to clear it).

## Frontmatter

Notes created via `save` get auto-generated frontmatter:

```yaml
---
title: Note Title
created: 2026-05-04
updated: 2026-05-04
status: draft
tags:
  - example
sources:
  - resource: https://example.com/spec
    id: section-4
    title: Example Spec
    author: Example Author
    last_modified: '2026-08-01'
---
```

`sources` is optional provenance for the material a note was written from, accepted by both `save` and `update`. It is the one frontmatter field `update` does not simply preserve: incoming entries are **merged** into the existing list, deduped on `resource` + `id`, so provenance accumulates over a note's life instead of being replaced. An entry matching an existing `resource` + `id` is merged field-wise in place — a refreshed `last_modified` or a newly known `author` lands without duplicating the entry.

## Testing

```bash
npm test
```

Or with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Set `ARCHAI_PATH` in the inspector's environment configuration.

## Tech Stack

- TypeScript, ES modules
- `@modelcontextprotocol/sdk` — stdio transport
- `gray-matter` — frontmatter parsing
- `glob` — file discovery
