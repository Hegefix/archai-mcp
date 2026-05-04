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
