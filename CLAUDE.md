# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# archai-mcp

MCP server providing read/write access to one or more Obsidian vaults via the filesystem. Stdio transport, no database — every tool reads/writes markdown files directly.

## Commands

```bash
npm run build       # tsc -p tsconfig.build.json → dist/
npm start            # node dist/index.js
npm test             # vitest run (all tests, once)
npm run test:watch   # vitest (watch mode)
npx vitest run src/paths.test.ts   # run a single test file
```

There is no lint script configured.

The server reads `vaults.json` from the project root (resolved one level up from `dist/`, see `CONFIG_PATH` in `src/index.ts`). No env vars. Shape:

```json
{ "default": "tech", "vaults": { "tech": "../archai/tech", "warhammer40k": "../archai/warhammer40k" } }
```

Vault paths may be absolute, `~`-prefixed, or relative to `vaults.json`; `default` is optional (falls back to the first listed vault). `vaults.json` is gitignored; `vaults_example.json` is the committed template. To manually test against real data, `cp vaults_example.json vaults.json`, edit it, then either run `node dist/index.js` directly or via the inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

## Architecture

- `src/server.ts` — creates the `McpServer` and calls each tool's `register*` function against a shared `VaultRegistry`. `createServer` is `async`: it stats each configured vault's top-level directories first (via `listTopLevelFolders`) and passes that `VaultFolderInfo[]` down to the tools whose schema descriptions need real folder examples.
- `src/index.ts` — entry point; loads `vaults.json`, wires up the stdio transport, and re-exports internals (`createServer`, `resolveVaultPath`, text helpers) that `src/index.test.ts` imports and tests directly. `isDirectRun` guards `main()` so importing this module (as the test does) doesn't start the server.
- `src/vaults.ts` — `VaultRegistry` = `{ vaults: Map<name, absPath>, defaultName }`. `loadVaultConfig` parses/validates `vaults.json`; `toRegistry` normalizes a bare path string into a single-vault registry (used when embedding the server without a config file); `resolveVault(registry, name?)` resolves a vault name to its root, throwing a listing of available vaults on a bad name.
- `src/paths.ts` — `normalizeVaultPath`/`resolveVaultPath` are the traversal guard: every tool that touches a file path must route it through `resolveVaultPath(vaultPath, relativePath)` before reading/writing. `getAllMarkdownFiles` globs `**/*.md` under a vault root, excluding `.obsidian/**`. `listTopLevelFolders` reads the vault root's real subdirectories (excluding `.obsidian`) so tool descriptions and validation stay in sync with the filesystem instead of hardcoding folder names. `assertKnownTopLevelFolder` throws unless a relative path's first segment is one of those real top-level folders (vault-root paths are always allowed) — this is the guard behind `save`/`create_folder`'s `allowNewTopLevel` behavior below.
- `src/text.ts` — pure helpers: `toKebabCase` (filename generation for `save`), `findWordPositions`/`extractBestSnippet` (naive scoring/snippet extraction shared by `search` and `save`'s duplicate check), `describeVaultLayouts`/`firstTopLevelFolder` (format a `VaultFolderInfo[]` into the human-readable layout summaries and example paths used in tool descriptions — kept pure and separate from the `listTopLevelFolders` filesystem read in `paths.ts`).
- `src/tools/*.ts` — one file per tool, each exporting `register<Name>(server, registry, vaultFolders?)`, called from `server.ts`. Tool schemas use `zod/v3` (the SDK's `registerTool` expects v3-shaped schemas even though the project may have zod 4 available transitively). Tools return `{ content: [...], isError?: true, structuredContent?: {...} }`; errors from `resolveVault` are caught per-tool and surfaced as `isError: true` text rather than thrown.
- Multi-vault dispatch pattern, consistent across tools: `save`/`read`/`update`/`create_folder` take an optional `vault` arg, defaulting to `registry.defaultName` via `resolveVault`. `search`/`list` instead default to iterating every vault in `registry.vaults` (results labeled `[vaultname]`) and only scope to one when `vault` is explicitly passed.
- Frontmatter is read/written with `gray-matter` (`matter()` / `matter.stringify()`) everywhere notes are touched — `save` generates `{ title, created, updated, status: "seedling", tags? }`; `update` preserves existing frontmatter fields and only bumps `updated`. `save` has no content-based folder inference — a note is written to the vault root unless `folder` is given explicitly.
- `save` and `create_folder` reject a target path whose first segment isn't an existing top-level folder in that vault, naming the vault and listing its valid top-level folders in the error. This only gates the *top-level* segment — nesting further under an already-known top-level folder (e.g. `concepts/react/hooks` when `concepts` exists) is always allowed and creates intermediate folders as needed. Pass `allowNewTopLevel: true` to explicitly opt into creating a brand-new top-level folder.
- `save` also rejects titles containing Cyrillic characters, and unless `force: true` is passed it scans the vault for filename/content matches on the title's words and returns those instead of creating the note (short-circuiting the write, before the top-level-folder check ever runs).
- Tests (`src/*.test.ts`) mix pure unit tests of `text.ts`/`paths.ts` helpers with integration tests that spin up a real `createServer` over `InMemoryTransport` against a `mkdtemp`-created scratch vault (see the top of `src/index.test.ts`) — prefer that pattern (in-memory client/server pair + temp dir) over mocking the filesystem when adding tool tests.
