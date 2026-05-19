# archai-mcp

MCP server for read/write access to an [Obsidian](https://obsidian.md) vault. Operates directly on the filesystem — no database, no sync layer.

## Setup

```bash
npm install
npm run build
```

## Usage

Set the `ARCHAI_PATH` environment variable to the root of your Obsidian vault, then run the server:

```bash
ARCHAI_PATH=/path/to/vault node dist/index.js
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "archai": {
      "command": "node",
      "args": ["/absolute/path/to/archai-mcp/dist/index.js"],
      "env": {
        "ARCHAI_PATH": "/path/to/vault"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `save` | Create a note with frontmatter. Checks for duplicates first — use `force: true` to skip. |
| `read` | Read the full content of a note by path. |
| `search` | Search notes by filename and content. Returns top 10 with snippets. |
| `list` | List notes, optionally filtered by folder. Sorted by creation date. |
| `update` | Replace note body, preserve frontmatter, bump `updated` date. |
| `delete` | Delete a note by path. |
| `create_folder` | Create a folder (and any parent folders). |
| `delete_folder` | Delete a folder. Use `force: true` for non-empty folders. |
| `list_folders` | List subfolders, optionally under a parent path. |

### Refactoring tools

These keep the vault internally consistent when notes are renamed, moved, or reorganized. All operations that rewrite links use a markdown AST scan so wikilinks inside fenced code blocks, inline code, frontmatter, and escaped brackets are never matched.

| Tool | Description |
|------|-------------|
| `find_backlinks` | Find every note linking to a target (wikilinks resolve by basename, markdown-style links by URL). Returns `resolved_files` so you can detect basename ambiguity before a refactor. |
| `move` | Move/rename a single note. Rewrites wikilinks across the vault when the basename changes, recomputes markdown-style relative links, bumps the moved note's `updated`. `dry_run`, `overwrite`, `allow_ambiguity` flags. |
| `bulk_move` | Atomic batch of moves with `git reset --hard` rollback on failure. Topologically orders chained moves (A→B, B→C). Rejects cycles, duplicate destinations, and git-ignored sources. |
| `rewrite_links` | Mass-rename a wikilink target without moving any files. Use when a note was renamed outside this server (e.g. in Obsidian's UI) and references broke. |
| `lint_links` | Vault-wide audit of broken wikilinks. Classifies each as `title_form`, `typo`, or `phantom` with suggested fixes. Read-only. |

Git inspection and push are intentionally NOT exposed as tools — use your terminal. `bulk_move` uses git internally for its snapshot/rollback safety net.

#### Worked example: `bulk_move`

Reorganizing three scratch notes into `public/concepts/`:

```jsonc
// Request
{
  "operations": [
    { "from": "public/scratch/distributed-locks.md", "to": "public/concepts/distributed-locks.md" },
    { "from": "public/scratch/leader-election.md",   "to": "public/concepts/leader-election.md" },
    { "from": "public/scratch/raft.md",              "to": "public/concepts/raft.md" }
  ]
}
```

```jsonc
// structuredContent
{
  "success": true,
  "snapshot_sha": "a1b2c3d",
  "results": [
    { "from": "public/scratch/distributed-locks.md", "to": "public/concepts/distributed-locks.md", "moved": true, "link_updates_count": 0 },
    { "from": "public/scratch/leader-election.md",   "to": "public/concepts/leader-election.md",   "moved": true, "link_updates_count": 0 },
    { "from": "public/scratch/raft.md",              "to": "public/concepts/raft.md",              "moved": true, "link_updates_count": 0 }
  ],
  "total_link_updates": 2,                    // markdown-style links from notes outside the batch
  "warnings": [],
  "errors": [],
  "rolled_back": false,
  "dry_run": false
}
```

- Basenames didn't change → wikilinks elsewhere don't need rewriting.
- Markdown-style links like `[locks](./public/scratch/distributed-locks.md)` elsewhere in the vault get recomputed to point at the new location.
- A single snapshot commit is left in `git log` for the user to keep, amend, or squash. `bulk_move` does NOT auto-commit the resulting state.

#### Snapshot rules

By default `bulk_move` takes a `git add -A && git commit -m "archai: pre-refactor snapshot"` before touching files. To skip this you must pass **both** `snapshot:false` AND `unsafe_no_snapshot:true` — passing only one is rejected. In `unsafe_no_snapshot` mode the tool aborts on first error and leaves partial state for the user to recover manually.

If the vault isn't a git repo and the default snapshot path is used, the tool errors with: `Vault at <path> is not a git repository. Run 'git init' there, or pass unsafe_no_snapshot: true.`

#### Caveats

- **Concurrent edits during refactor are not handled.** Close Obsidian (or pause autosave) before running `bulk_move`; if Obsidian writes a file mid-operation, the snapshot rollback may overwrite that write.
- `find_backlinks` resolves wikilinks by basename (matches Obsidian). If two notes share a basename, `resolved_files.length > 1` — rename one of them before a basename-changing move.

#### Required for `bulk_move`

A `git` binary on `PATH` and a git repo at the vault root (`git init` if needed), unless you pass `unsafe_no_snapshot: true`.

### Linting

`lint_links` walks the vault, finds every wikilink that doesn't resolve to a file, and classifies it. Use this periodically to clean up the graph or after a bulk import. Read-only — apply suggested fixes via `rewrite_links` after review.

| Classification | Meaning |
|---|---|
| `title_form` | Broken target is a human-readable title for an existing note (e.g. `[[How the Internet Works — HTTP, HTML, Protocols]]` when the file is `how-the-internet-works-http-html-protocols.md`). High confidence rewrite. |
| `typo` | Broken target is a close edit-distance match to an existing basename. Confidence depends on similarity. |
| `phantom` | No plausible candidate. Either the note needs to be created or the link removed — needs user decision. |

```jsonc
// Request
{ "scope": "public", "ignore_intentional": true }
```

```jsonc
// structuredContent (truncated)
{
  "scanned_files": 27,
  "total_wikilinks": 89,
  "broken_count": 3,
  "broken_links": [
    {
      "target": "How the Internet Works — HTTP, HTML, Protocols",
      "occurrences": [
        { "path": "public/notes/web-basics.md", "line": 14, "column": 3, "raw": "[[How the Internet Works — HTTP, HTML, Protocols]]", "context": "...see [[How the Internet Works — HTTP, HTML, Protocols]] for the deep dive..." }
      ],
      "classification": "title_form",
      "candidates": [
        { "basename": "how-the-internet-works-http-html-protocols", "path": "public/tech/how-the-internet-works-http-html-protocols.md", "similarity": 1.0, "reason": "title_match" }
      ],
      "suggested_fix": { "action": "rewrite_to", "target_basename": "how-the-internet-works-http-html-protocols", "confidence": "high" }
    }
  ],
  "summary": {
    "by_classification": { "title_form": 1, "typo": 1, "phantom": 1 },
    "high_confidence_fixes": 2,
    "needs_user_decision": 1
  }
}
```

#### Intentional placeholders

To mark a wikilink as a deliberate stub (e.g. for future content), append `<!-- intentional -->` on the same line:

```markdown
- [[future-concept]] <!-- intentional --> — to be written after the deep dive
```

These are skipped by default (`ignore_intentional: true`). Pass `ignore_intentional: false` to surface them.

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
---
```

## Testing

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Set `ARCHAI_PATH` in the inspector's environment configuration.

## Tech Stack

- TypeScript, ES modules
- `@modelcontextprotocol/sdk` — stdio transport
- `gray-matter` — frontmatter parsing
- `glob` — file discovery
