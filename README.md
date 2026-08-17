# archai-mcp

MCP server for read/write access to an [Obsidian](https://obsidian.md) vault. Operates directly on the filesystem — no database, no sync layer.

## Setup

```bash
npm install
npm run build
```

## Usage

Copy `vaults_example.json` to `vaults.json` in the project root and edit it:

```bash
cp vaults_example.json vaults.json
```

```json
{
  "default": "tech",
  "vaults": {
    "tech": "../archai/tech",
    "warhammer40k": "../archai/warhammer40k"
  }
}
```

Vault paths may be absolute, `~`-prefixed, or relative to `vaults.json`. `default` is optional and falls back to the first listed vault. `vaults.json` is gitignored (it holds local paths); `vaults_example.json` is the committed template.

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

- `save`, `save_reference`, `read`, `update`, `create_folder` — default to the **primary** vault (`default` in `vaults.json`).
- `search`, `list` — span **all** vaults when no `vault` is given; results are labeled `[vaultname]`. Pass `vault` to scope to one.
- `list_vaults` — discover the configured vault names (use these as `vault` values).

## Tools

| Tool | Description |
|------|-------------|
| `save` | Create a note with frontmatter. Rejects Cyrillic titles. Checks for duplicates first — use `force: true` to skip. |
| `save_reference` | Store raw source material verbatim under `references/`. No frontmatter, no duplicate check, immutable. |
| `read` | Read the full content of a note by path. |
| `search` | Search notes by filename and content across all vaults. Returns top 10 with snippets. |
| `list` | List notes across all vaults, optionally filtered by folder. Sorted by creation date. |
| `update` | Replace note body, preserve frontmatter, bump `updated` date, merge `sources`. |
| `create_folder` | Create a folder (and any parent folders). |
| `list_vaults` | List configured vaults and their roots. |

### References

`save_reference(path, content, vault?)` writes `content` byte-for-byte to `references/<path>` — raw material (a spec, a transcript, a dump) rather than an authored note, so it gets no frontmatter and no kebab-cased filename, and `save`'s duplicate check does not apply.

References are immutable by construction: there is no `update_reference` tool, and writing over an existing reference is refused. Store a corrected copy under a new path instead.

## History

Every successful write — `save`, `update`, `save_reference` — is committed to the vault's git repo and appended to the vault's `log.md`. Read-only tools (`read`, `search`, `list`, `list_vaults`) never write or commit.

- **Repo discovery.** A repo that already governs the vault is reused, whether that's the vault's own `.git` or an enclosing one (a notes repo holding several vaults). `git init` runs only when the vault is in no repo at all, so existing history is never re-rooted or rewritten.
- **Commits** are `git add -A -- .` + `git commit -m "<tool>: <path>" -- .` from the vault root. The pathspec scopes the commit to the written vault, so a write to one vault leaves a sibling vault's working-tree changes alone. Note that `-A` also sweeps up any *other* pending changes inside that vault.
- **Best-effort.** A missing git binary, an absent committer identity or a no-op commit never fails the tool call — a warning goes to stderr and the write stands.
- **`log.md`** lives at each vault root (one per vault, not per directory). Entries are appended under a `## YYYY-MM-DD` heading:

```markdown
## 2026-08-17

* **Creation**: [[concepts/react-hooks]] — React Hooks
* **Update**: [[concepts/react-hooks]] — React Hooks
* **Reference**: references/rfc/rfc-9110.txt
```

Requires the `git` CLI on `PATH`. There is no git library dependency.

## Frontmatter

Notes created via `save` get auto-generated frontmatter:

```yaml
---
title: Note Title
created: 2025-05-04
updated: 2025-05-04
status: seedling
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
