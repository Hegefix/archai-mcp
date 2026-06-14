# archai-mcp

MCP server providing read/write access to one or more Obsidian vaults via the filesystem.

## Build

```
npm run build
```

## Run

```
node dist/index.js
```

The server reads `vaults.json` from the project root (resolved one level up from `dist/`). No env vars. Shape:

```json
{ "default": "tech", "vaults": { "tech": "../archai/tech", "warhammer40k": "../archai/warhammer40k" } }
```

Vault paths may be absolute, `~`-prefixed, or relative to `vaults.json`; `default` is optional (falls back to the first listed vault). `vaults.json` is gitignored; `vaults_example.json` is the committed template.

## Manual testing

```
npx @modelcontextprotocol/inspector node dist/index.js
```

Requires a `vaults.json` in the project root.

## Architecture

- `src/server.ts` — creates the MCP server, registers all tools, normalizes the vault registry
- `src/index.ts` — entry point, stdio transport, exports
- `src/vaults.ts` — vault registry: loads `vaults.json`, resolves a vault name to a root path
- `src/paths.ts` — vault path normalization, traversal protection, file discovery
- `src/text.ts` — kebab-case conversion, folder inference, search helpers
- `src/tools/` — one file per tool
- Stdio transport — designed to be launched by an MCP client (Claude Code, Cursor, etc.)
- Filesystem-backed — all operations read/write markdown files directly in the vault
- `gray-matter` for frontmatter parsing/serialization
- `glob` for file discovery
- Multi-vault: every tool takes an optional `vault` arg. `save`/`read`/`update`/`create_folder` default to the primary vault; `search`/`list` span all vaults (labeled `[name]`) unless scoped.
- Seven tools: `save`, `read`, `search`, `list`, `update`, `create_folder`, `list_vaults`
