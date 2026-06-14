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

- `save`, `read`, `update`, `create_folder` — default to the **primary** vault (first in `ARCHAI_VAULTS`).
- `search`, `list` — span **all** vaults when no `vault` is given; results are labeled `[vaultname]`. Pass `vault` to scope to one.
- `list_vaults` — discover the configured vault names (use these as `vault` values).

## Tools

| Tool | Description |
|------|-------------|
| `save` | Create a note with frontmatter. Rejects Cyrillic titles. Checks for duplicates first — use `force: true` to skip. |
| `read` | Read the full content of a note by path. |
| `search` | Search notes by filename and content across all vaults. Returns top 10 with snippets. |
| `list` | List notes across all vaults, optionally filtered by folder. Sorted by creation date. |
| `update` | Replace note body, preserve frontmatter, bump `updated` date. |
| `create_folder` | Create a folder (and any parent folders). |
| `list_vaults` | List configured vaults and their roots. |

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
