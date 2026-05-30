# archai-mcp

MCP server providing read/write access to an Obsidian vault via the filesystem.

## Build

```
npm run build
```

## Run

```
ARCHAI_PATH=/path/to/obsidian/vault node dist/index.js
```

The `ARCHAI_PATH` environment variable must point to the root of the Obsidian vault.

## Manual testing

```
npx @modelcontextprotocol/inspector node dist/index.js
```

Set `ARCHAI_PATH` in the inspector's environment configuration.

## Architecture

- `src/server.ts` — creates the MCP server, registers all tools
- `src/index.ts` — entry point, stdio transport, exports
- `src/paths.ts` — vault path normalization, traversal protection, file discovery
- `src/text.ts` — kebab-case conversion, folder inference, search helpers
- `src/tools/` — one file per tool
- Stdio transport — designed to be launched by an MCP client (Claude Code, Cursor, etc.)
- Filesystem-backed — all operations read/write markdown files directly in the vault
- `gray-matter` for frontmatter parsing/serialization
- `glob` for file discovery
- Six tools: `save`, `read`, `search`, `list`, `update`, `create_folder`
