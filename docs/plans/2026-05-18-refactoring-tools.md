# [archai-mcp] Refactoring Tools

## Objective

Add a set of vault-refactoring tools to `archai-mcp` so notes can be reorganized without breaking wikilinks. Adds `find_backlinks`, `move`, `bulk_move`, `rewrite_links`, `git_status`, `git_commit`, `git_push`, and enhances the existing `create_folder` to match the new contract. Bulk operations are atomic via a git snapshot + `reset --hard` rollback. Wikilink rewrites use a markdown-AST pass so code blocks and inline code are untouched.

## Scope

**In scope:**
- New tools: `find_backlinks`, `move`, `bulk_move`, `rewrite_links`, `git_status`, `git_commit`, `git_push`.
- Enhance `create_folder` to: detect file-collision, normalize/sandbox the path, return `{created, path}` structured payload, stay idempotent.
- Wikilink parser module (AST-based, position-preserving byte rewrite).
- Git wrapper module on `simple-git`, scoped to `ARCHAI_PATH`.
- Path utility module (vault-rooted, posix-normalized, escape-safe).
- Tests for every new tool: happy path + main failure mode + (where applicable) integrity/rollback test.
- README "Refactoring tools" section with a worked `bulk_move` example.
- Split `src/index.ts` into focused modules — keeping everything in one file at 2000+ lines hurts everyone.

**Out of scope:**
- Watching vault for external edits during operation (documented as race-condition risk in README).
- Folder-rename as a primitive (composed via `bulk_move`).
- Conflict resolution on push failure (surface error verbatim).
- Migrating existing tools' return shape to structured content (only new tools use structured payloads; existing tools keep their plain-text returns).
- A separate `archai:rename` tool.

## Architectural Decisions (locked)

1. **Module split: GO.** Current `src/index.ts` is ~650 lines. Adding 7 tools, a wikilink parser, and a git wrapper would push it past 2000. Layout:
   ```
   src/
     index.ts            # entry point: env parsing + main()
     server.ts           # createServer() — registers all tools
     paths.ts            # vault-rooted path helpers (posix, escape-safe)
     wikilinks.ts        # AST-driven wikilink/markdown-link scanner + rewriter
     git.ts              # simple-git wrapper (status, commit, push, snapshot, reset)
     frontmatter.ts      # gray-matter helpers; updated-timestamp bumping
     tools/
       save.ts read.ts search.ts list.ts update.ts delete.ts
       create_folder.ts delete_folder.ts list_folders.ts
       find_backlinks.ts move.ts bulk_move.ts rewrite_links.ts
       git_status.ts git_commit.ts git_push.ts
     index.test.ts       # existing tests — keep mostly as-is, repointed to new imports
     wikilinks.test.ts   # unit tests for the parser
     paths.test.ts       # unit tests for path helpers
     git.test.ts         # integration tests against a temp git repo
     tools.test.ts       # MCP integration tests for new tools (extend existing pattern)
   ```
   Existing exports (`toKebabCase`, `inferFolder`, `findWordPositions`, `extractBestSnippet`, `resolveVaultPath`, `createServer`) keep their signatures and are re-exported from `index.ts` so the test file's import surface is preserved.

2. **Wikilink rewriting: hybrid AST + byte-edit.** Parse with the chosen markdown library to get AST node positions, then apply byte-level edits to the original string in reverse order. AST handles code/inline-code/escape skipping; byte edits preserve everything else verbatim. **Invariant: if any two queued byte-edits overlap, throw.** Should be impossible for wikilinks, asserted as a safety net.

3. **`updated` timestamp format: date-only `YYYY-MM-DD` everywhere.** New writes use date-only. If an existing note has a full ISO 8601 timestamp (or any other format) in its `updated` field, **preserve it verbatim** — do not normalize. Only overwrite the field on a moved note, with date-only.

4. **`create_folder` is already a tool.** Treated as enhancement: same name, stricter behavior, structured output (text fallback included). Existing `is idempotent` test stays green; new file-collision test added.

5. **MCP output shape.** New tools emit `structuredContent` per spec, plus a `content[0]` text summary. Existing tools unchanged.

6. **`git_push` guardrail.** Soft barrier in the tool description; server cannot enforce. Verified by smoke test.

7. **Topological move ordering in `bulk_move`.** Edge from op X → op Y if `Y.to == X.from`. Kahn's algorithm. Cycle → error.

8. **Backlink-only edits do NOT bump `updated`.** Only moved files do.

9. **`bulk_move` snapshot semantics.** Default `snapshot: true`. To skip the snapshot, caller must pass `unsafe_no_snapshot: true` (renamed from `snapshot: false`). Passing neither, or passing `snapshot: false` without `unsafe_no_snapshot`, is rejected with an error.

10. **`force` flag split.** Both `move` and `bulk_move` replace `force` with two explicit booleans:
    - `overwrite: boolean` — permits writing over an existing `to` file.
    - `allow_ambiguity: boolean` — permits proceeding when the destination basename collides with an existing distinct file.

11. **Non-git vault error message** (used by `git_status`, `git_commit`, `git_push`, and `bulk_move` when snapshot is required):
    `"Vault at <path> is not a git repository. Run 'git init' there, or pass unsafe_no_snapshot: true."`
    Tools that don't use the snapshot flag drop the trailing "or pass" clause.

12. **Dependencies to add:** `simple-git`. Plus one markdown parser — `mdast-util-from-markdown` + `micromark-extension-wiki-link` is the leading candidate (smaller surface than full `unified` pipeline). Final pick reported in Step 2 before install.

## Implementation Steps

Numbered iterations. Each ends with a green typecheck + green tests + a focused commit. Don't move to the next until the current is confirmed.

**Order:** 0 module-split → 1 paths → 2 wikilinks → 3 git wrapper → 4 create_folder → 5 find_backlinks → 6 move → **7 git_status → 8 git_commit** → 9 bulk_move → 10 rewrite_links → 11 git_push → 12 README → 13 automated end-to-end test.

(Git status + git_commit are moved before bulk_move so the user can inspect git state during smoke testing.)

### Step 0 — Module split (no behavior change)

**What changes:**
- Move existing utilities and tool handlers out of `src/index.ts` into the layout above.
- `src/index.ts` becomes the entry point only (env var read, `createServer` import, `main()` + direct-run guard).
- Re-export the existing utility functions from `src/index.ts` so `src/index.test.ts` keeps importing from `./index.js`.
- No new tools, no behavior changes.

**How to verify:**
- `npm run build` passes.
- `npm test` passes (existing 35+ assertions across `index.test.ts`).
- Manual sanity: `ARCHAI_PATH=/tmp/empty node dist/index.js` boots without error.

**Edge cases:**
- Import cycles — keep `server.ts` as the only file that imports from `tools/*`; tools import from `paths.ts` / `frontmatter.ts` / `wikilinks.ts` / `git.ts`, never from `server.ts`.
- `node:fs/promises` import surface — keep it identical to current usage.
- The direct-run guard: leave its logic in `index.ts` (it checks `import.meta.url` vs `process.argv[1]`).

**Commit:** `refactor(mcp): split index.ts into focused modules`

---

### Step 1 — Path helpers (`src/paths.ts`)

**What changes:**
- New module exporting:
  - `normalizeVaultPath(input: string): string` — rejects absolute paths, normalizes via `path.posix.normalize`, rejects any segment === `..` after normalization, rejects leading `/`. Returns canonical posix-relative path.
  - `resolveVaultPath(vaultRoot, rel)` — kept compatible with existing signature; routes through `normalizeVaultPath`. Old prefix-check stays as a defensive belt-and-suspenders.
  - `relativeFromTo(fromFile, toFile): string` — `path.posix.relative(path.posix.dirname(fromFile), toFile)`. Used to recompute markdown-style relative links inside a moved note.
  - `vaultBasename(rel): string` — `path.posix.basename(rel, '.md')`.
- Unit tests in `src/paths.test.ts`:
  - Normalizes `./foo/./bar/` → `foo/bar`.
  - Rejects `/etc/passwd`.
  - Rejects `foo/../../etc`.
  - Accepts `foo/bar/../baz` → `foo/baz`.
  - `relativeFromTo('a/b/c.md', 'a/b/d.md')` → `d.md`.
  - `relativeFromTo('a/b/c.md', 'a/x/d.md')` → `../x/d.md`.

**How to verify:**
- `npm test -- paths` green.
- `npm run build` green.

**Edge cases:**
- Windows-style backslashes in input — normalize to forward slashes before `path.posix` ops.
- Empty string → reject.
- Path that is exactly `..` → reject.
- Trailing slash on a path expected to be a file → for `move`/`find_backlinks` callers, require `.md` suffix at the tool level, not here.

**Commit:** `feat(paths): add vault-rooted posix-normalized path helpers`

---

### Step 2 — Wikilink scanner (`src/wikilinks.ts`)

**What changes:**
- Pick the smallest viable parser combo. Default plan: `mdast-util-from-markdown` + `micromark-extension-wiki-link` (smaller surface than full `unified` pipeline). If `remark-wiki-link` is required for ergonomic AST shape, switch and report back before installing.
- New module exporting:
  - `type LinkRef = { kind: 'wikilink' | 'wikilink_embed' | 'markdown'; raw: string; basename: string | null; targetPath: string | null; offset: number; length: number; line: number; column: number }`.
  - `scanLinks(content: string, file: { dir: string }): LinkRef[]` — parses content, walks AST, returns wikilinks and markdown links that target a `.md` file. Frontmatter, code, inline code, and escaped brackets are excluded by the parser; assert this in tests.
  - `rewriteWikilinks(content: string, fromBasename: string, toBasename: string): { content: string; updates: Array<{ raw: string; replacement: string; line: number; column: number }> }` — preserves alias / heading / block-id suffix.
  - `rewriteMarkdownLinks(content: string, predicate: (resolvedTarget: string) => string | null): { content, updates }` — generic; predicate returns the new URL or null (keep).
  - **Overlap invariant:** internal `applyEdits(content, edits[])` helper asserts no two edits' `[offset, offset+length)` ranges overlap. Throws `Error('overlapping edits')` if they do. Test this with a synthetic input.
  - `contextSnippet(content, offset, length, width=80)` — for `find_backlinks` output.
- Unit tests in `src/wikilinks.test.ts`:
  - Detects `[[foo]]`, `[[foo|bar]]`, `[[foo#heading]]`, `[[foo#^block-id]]`, `![[foo]]`, `[text](rel/path.md)`.
  - **Does NOT** detect `` `[[foo]]` `` (inline code), nor a `[[foo]]` inside a fenced block, nor `\[\[foo\]\]`.
  - Frontmatter containing `[[foo]]` is ignored.
  - Rewrite preserves alias: `[[old|display]]` → `[[new|display]]`.
  - Rewrite preserves heading: `[[old#H]]` → `[[new#H]]`.
  - Rewrite is byte-preserving outside the rewritten spans (assert against a fixture with deliberate quirky whitespace).
  - Markdown link rewrite recomputes relative path correctly.

**How to verify:**
- `npm test -- wikilinks` green.

**Edge cases:**
- Multi-byte unicode in content (emoji, etc.) — use `Buffer`-aware indexing if AST offsets are byte-based vs string-index based. micromark uses string positions, which JS handles natively. Cover with a unicode fixture.
- Multiple wikilinks on one line — both must be detected, edits applied in reverse order.
- Trailing newline preservation.

**Commit:** `feat(wikilinks): add AST-driven link scanner and rewriter`

---

### Step 3 — Git wrapper (`src/git.ts`)

**What changes:**
- New module exporting a thin `createGit(vaultRoot)` factory returning:
  - `status(): Promise<{branch, dirty, ahead, behind, staged[], modified[], untracked[]}>`.
  - `snapshot(message): Promise<{committed: boolean, sha?: string, reason?: 'clean'}>` — `add -A`, `commit -m`, returns SHA. If clean, returns `{committed: false, reason: 'clean'}`.
  - `commit(message, allowEmpty)` — same, plus `--allow-empty` when requested.
  - `resetHard(sha?)` — `git reset --hard <sha|HEAD>` then `git clean -fd`.
  - `push(remote?, branch?)` — passes through `simple-git`, no force ever.
  - `currentBranch()`.
  - `isRepo()` — for sanity check at server boot (don't crash, but tools can degrade gracefully).
- Integration tests in `src/git.test.ts`: `mkdtemp` a dir, `git init`, exercise each method. Cover: clean status, dirty status, snapshot when clean (`committed: false`), snapshot when dirty (sha returned), resetHard reverts changes.

**How to verify:**
- `npm test -- git` green. (Tests require `git` on PATH; document in README.)

**Edge cases:**
- `git push` to a remote that doesn't exist — return `{pushed: false, error}` not a thrown error.
- Repo with no remote configured at all — `git_status` returns `ahead: 0, behind: 0`.
- Detached HEAD — `currentBranch()` returns the commit SHA short form; status reports `branch: 'HEAD'`.
- Repo with no commits yet — guard `status()` so it doesn't throw on missing `HEAD`.

**Commit:** `feat(git): add simple-git wrapper scoped to vault root`

---

### Step 4 — Enhance `create_folder` (`src/tools/create_folder.ts`)

**What changes:**
- Replace existing handler. Behavior:
  - Normalize path via `normalizeVaultPath` (rejects escape).
  - If target exists as a directory → no-op success, `{created: false, path}`.
  - If target exists as a file → error.
  - Else `mkdir({recursive: true})` → `{created: true, path}`.
- Description string updated to match.
- Output: `structuredContent` with the shape; `content[0]` text remains `Created folder: <path>` (or `Already exists: <path>`) for human read-out.
- Update existing test "is idempotent" to assert the structured payload (`created: false` on second call). Add a new test: collision-with-file errors.

**How to verify:**
- `npm test -- create_folder` green; full suite green.

**Edge cases:**
- Path is empty string after normalize → reject.
- Path contains only `.` → no-op success (vault root).

**Commit:** `feat(mcp): tighten create_folder with collision check and structured output`

---

### Step 5 — `find_backlinks` (`src/tools/find_backlinks.ts`)

**What changes:**
- Accept `{ target: string }`. Derive basename: strip `.md`, take posix basename.
- Walk all `.md` files via existing `glob` helper.
- For each file: `scanLinks(content, { dir: dirname(file) })`, filter to refs where:
  - `kind === 'wikilink' | 'wikilink_embed'` AND `ref.basename === targetBasename`, OR
  - `kind === 'markdown'` AND `vaultBasename(ref.targetPath) === targetBasename`.
- Emit `{target, resolved_files: string[], backlinks: [{path, line, column, link_type, raw, context}]}` as `structuredContent`. `resolved_files` lists every vault path whose basename matches the target — callers use this to detect basename ambiguity. Text content: short summary `"Found N backlinks to <target>"` plus an "Ambiguous: matches N files" line when `resolved_files.length > 1`.
- Test coverage:
  - Happy path: 3 notes link to a target, returns 3 entries with correct line/column.
  - Backlinks inside code blocks ignored.
  - Aliased link `[[target|display]]` detected, raw preserves the alias.
  - Markdown-style link `[X](./target.md)` detected and reported as `link_type: 'markdown'`.
  - Target with no incoming links → empty backlinks array AND empty `resolved_files`.
  - Ambiguous target: two notes with the same basename in different folders → `resolved_files` has both; backlinks from both files' callers are pooled.

**How to verify:**
- `npm test -- find_backlinks` green.

**Edge cases:**
- Two notes have the same basename in different folders. Spec says backlinks resolve by basename → both files' incoming links are pooled. Document this; if the user wants disambiguation they should rename first.
- Self-references (a note links to itself) — include them but flag in `warnings` field? Spec doesn't have a warnings field on this tool; just include them. Add a test asserting self-references are included.

**Commit:** `feat(mcp): add find_backlinks tool`

---

### Step 6 — `move` (`src/tools/move.ts`)

**What changes:**
- Input: `{ from, to, update_links=true, dry_run=false, overwrite=false, allow_ambiguity=false }`.
- Steps:
  1. Normalize both paths; both must end in `.md`.
  2. If `from === to` → no-op success.
  3. If `from` doesn't exist → error.
  4. If `to` exists and not `overwrite` → error.
  5. Compute: `basenameChanged = vaultBasename(from) !== vaultBasename(to)`.
  6. Find backlinks (same logic as Step 5). Find markdown-style links pointing at `from`'s path (regardless of basename change).
  7. If `basenameChanged` and there's any other file whose basename matches `to`'s basename → ambiguity. If not `allow_ambiguity` → error. If `allow_ambiguity` → record a warning and proceed.
  8. Build the moved-note's new content:
     - Read original, rewrite **outgoing** markdown-style relative links inside the note: each existing relative target gets recomputed via `relativeFromTo(toDir, originalTargetAbsolute)`.
     - Bump frontmatter `updated` (date-only, per decision 3) via `frontmatter.ts` helper.
  9. Build link updates for backlinks:
     - Wikilinks with the old basename → rewrite to new basename, preserving alias/heading/block-id.
     - Markdown links pointing at old path → rewrite URL to new relative path, computed per backlink's location.
  10. If `dry_run` → return planned changes without touching the filesystem.
  11. Else, apply: write new content to `to`, write each backlink's updated content, then `fs.unlink(from)`. Ensure parent directories of `to` exist (`mkdir -p`).
- Output: `{moved, from, to, link_updates[], warnings[], dry_run}` structured + text summary.
- Tests:
  - Move within same folder, basename unchanged → just renames, link_updates empty.
  - Move to new folder, basename unchanged but markdown-style relative link points at old path → markdown link updated.
  - Basename changes, 2 backlinks via wikilink + 1 via markdown → all three rewritten.
  - Ambiguity: another file has the same destination basename, not `allow_ambiguity` → error, no writes.
  - Ambiguity with `allow_ambiguity=true` → proceeds, warning recorded.
  - `to` exists, not `overwrite` → error.
  - `to` exists, `overwrite=true` → proceeds.
  - `from === to` → no-op success.
  - Dry run: returns the plan, filesystem untouched.
  - Outgoing markdown-style link in the moved note recomputed correctly.

**How to verify:**
- `npm test -- move` green.

**Edge cases:**
- `to` parent directory missing → create it.
- `from` is in a subfolder and `to` is at vault root → relative-link recomputation must produce sane paths.
- Moved note has a self-referential link (rare but possible) → after move it should still resolve.
- Backlink note can't be parsed (malformed markdown) → micromark is permissive; if parse throws, surface as IOError on that specific file, abort the move (no writes), no partial state.

**Commit:** `feat(mcp): add move tool with wikilink and markdown-link rewriting`

---

### Step 7 — `bulk_move` (`src/tools/bulk_move.ts`)

**What changes:**
- Input: `{ operations[], update_links=true, dry_run=false, snapshot=true, unsafe_no_snapshot=false, snapshot_message="archai: pre-refactor snapshot", overwrite=false, allow_ambiguity=false }`.
- **Snapshot gating:** if `snapshot=true` (default) AND vault is not a git repo → error with the non-git message. Caller must either `git init` the vault or explicitly pass `unsafe_no_snapshot: true`. If `unsafe_no_snapshot: true`, skip snapshot and rollback. Document loudly that rollback is best-effort in that mode (abort on first error, no automatic state restoration).
- Pre-flight validation (no writes):
  1. Normalize all paths; reject any non-`.md`.
  2. All `from` exist.
  3. No duplicate `to` within the batch.
  4. No `to` collides with an existing file outside the batch (unless `overwrite`). A `to` may collide with another op's `from` — that's the chained case, handled by topo sort.
  5. Topo-sort: edge from op X → op Y if `Y.to == X.from` (Y depends on X first, because Y wants to occupy X's source location). Detect cycles. Output an execution order.
  6. Project the post-move basename set; for each move with a basename change, check ambiguity against the projected set. With `allow_ambiguity`, record a warning instead of erroring.
  7. **Snapshot-coverage check.** If `snapshot=true`, every `from` must be reachable by `git add -A` — i.e., not git-ignored. If any `from` is ignored (e.g., matched by `.gitignore`), error pre-flight: `"<path> is git-ignored; the snapshot would not capture it. Untrack the ignore or pass unsafe_no_snapshot: true."` Untracked-but-not-ignored files are fine — `git add -A` captures them.
- If `dry_run`: also project all link updates (one full scan, applying renames in topo order to a virtual state). Return the full plan. No writes, no git ops.
- Else:
  1. If snapshot path: take snapshot. Record SHA. If working tree is clean and no untracked-relevant files exist, skip commit and record no snapshot SHA. (Snapshot SHA only present when an actual commit happened.)
  2. Try block:
     - Execute file moves in topo order. After all moves, run ONE pass: rewrite all wikilinks across the vault using the consolidated basename rename map; rewrite markdown links pointing at any of the old paths to the new paths.
     - For each moved file, rewrite outgoing markdown-style relative links to be valid from its new location.
     - Bump `updated` frontmatter on every moved file. Do NOT bump on files whose only change is link rewrites (per spec invariant 3: preserve other metadata; the spec says `updated` bumps "on edits" — moved files yes, link-only edits leave `updated` alone).
       - **Open decision:** should backlink-only edits bump `updated`? My read of the spec: no — those notes' meaning didn't change. Confirm.
  3. On any error mid-execution: `git resetHard()`. Return `{success: false, rolled_back: true, errors: [...]}`.
  4. On success: return SHA, results, total link updates. No auto-commit of the resulting state.
- Output per spec.
- Tests:
  - Happy path: 3 moves with cross-links, all succeed, `git log` shows exactly one snapshot commit, all links resolve.
  - Topo: `A→B` and `B→C` succeed in correct order.
  - Cycle: `A→B` and `B→A` → error pre-flight.
  - Duplicate destinations → error pre-flight, no writes.
  - Rollback: induce a failure (e.g., monkey-patch one of the writes to throw). Assert vault state equals snapshot, `rolled_back: true`, no partial files left behind.
  - **Untracked-file rollback:** add a `from` file that is new and uncommitted (untracked). Snapshot, induce failure, assert the file is restored to its original `from` path with original content (decision C confirmation test).
  - **Git-ignored `from`:** add an op whose `from` is git-ignored. Assert pre-flight error.
  - `dry_run`: no commits, no file changes; plan returned.
  - `unsafe_no_snapshot: true` happy path: no commit taken, moves applied.
  - `unsafe_no_snapshot: true` failure mid-execution: aborts on first error, partial state acknowledged in response, `rolled_back: false`.
  - Default `snapshot=true` in a non-git vault: error with the standard message.

**How to verify:**
- `npm test -- bulk_move` green.

**Edge cases:**
- Vault is not a git repo with default `snapshot=true` → return the non-git error: `"Vault at <path> is not a git repository. Run 'git init' there, or pass unsafe_no_snapshot: true."`
- Snapshot commit succeeds but rollback fails (e.g., disk full mid-reset) → return both errors clearly; do not pretend success.
- Operation list is empty → `{success: true, results: [], total_link_updates: 0}`.

**Commit:** `feat(mcp): add bulk_move with snapshot-based atomic rollback`

---

### Step 8 — `rewrite_links` (`src/tools/rewrite_links.ts`)

**What changes:**
- Input: `{ from, to, dry_run=false }`.
- Walk all `.md` files. For each:
  - Apply `rewriteWikilinks(content, from, to)`.
  - Apply `rewriteMarkdownLinks` with a predicate that returns the new URL when the target's basename matches `from`; new URL preserves the directory of the original link.
  - Collect updates.
- If not `dry_run`: write changed files. Do NOT bump `updated` (per same reasoning as bulk_move link-only edits — confirm).
- Output: same shape as `move`'s `link_updates`, plus `dry_run` flag.
- Tests:
  - Rewrites wikilinks across multiple files, preserving aliases/headings.
  - Markdown link with basename `from` (in some path) updated.
  - `dry_run` plans without writing.
  - Inline-code occurrences left alone.

**How to verify:**
- `npm test -- rewrite_links` green.

**Edge cases:**
- `from === to` → no-op success, empty updates list.
- Both `from` and `to` exist as files: this tool doesn't move anything; it just rewrites references. Note in description that callers usually pair it with file moves done in Obsidian's UI.

**Commit:** `feat(mcp): add rewrite_links tool for mass wikilink target renames`

---

### Step 9 — `git_status` (`src/tools/git_status.ts`)

**What changes:**
- Input: `{}`. Output per spec.
- Delegates to `git.status()`. If not a repo: error with actionable message.
- Tests: clean repo, dirty repo with staged + modified + untracked, non-repo.

**Commit:** `feat(mcp): add git_status tool`

---

### Step 10 — `git_commit` (`src/tools/git_commit.ts`)

**What changes:**
- Input: `{message, allow_empty=false}`. Output: `{committed, sha?, reason?}`.
- `git add -A`, then commit; if nothing to commit and not `allow_empty` → `{committed: false, reason: 'clean'}`.
- Tests: clean (returns reason), dirty (returns sha), `allow_empty` on clean (returns sha).

**Commit:** `feat(mcp): add git_commit tool`

---

### Step 11 — `git_push` (`src/tools/git_push.ts`)

**What changes:**
- Input: `{remote='origin', branch?}`. Output: `{pushed, remote, branch, error?}`.
- Description includes the exact sentence from spec: **"This tool MUST NOT be invoked unless the user has explicitly requested a push in their most recent message. Do not call as a follow-up to other operations."** + a second sentence explaining that this is a soft barrier and the LLM is responsible for respecting it.
- Never uses `--force`.
- On push failure (non-fast-forward, auth, etc.): return `{pushed: false, error: <verbatim git stderr>}`. Do not throw.
- Tests: configure a local bare repo as remote in the fixture, push succeeds; push to non-existent remote returns `{pushed: false}` with error; assert error message format.

**Commit:** `feat(mcp): add git_push tool with explicit no-auto-call guardrail`

---

### Step 12 — README update

**What changes:**
- Append a "Refactoring tools" section: one line per new tool.
- Worked example: a 3-note `bulk_move` reorganizing `public/scratch/{a,b,c}.md` → `public/concepts/{a,b,c}.md` with cross-links, showing the input JSON and the expected structured response.
- Add note: requires `git` on PATH for git tools; vault should be a git repo for `bulk_move snapshot=true`.
- Document the race-condition out-of-scope item: external edits during `bulk_move` may be lost in rollback — close Obsidian during refactors.

**How to verify:**
- Manual proofread.

**Commit:** `docs(readme): document refactoring tools and bulk_move example`

---

### Step 13 — Automated end-to-end test

**What:** Single vitest integration test that exercises the full refactoring flow against a `mkdtemp` fixture vault with a real `git init`:

1. Create 3 notes (`a.md`, `b.md`, `c.md`) under `public/scratch/` with cross-wikilinks (a↔b, b→c) and one markdown-style link (a→c).
2. `git add -A && git commit` an initial state.
3. Call `git_status` — assert clean.
4. Call `bulk_move` to relocate all three to `public/concepts/`.
5. Assert: structured response has 3 results, link updates count > 0, a snapshot SHA, `rolled_back: false`.
6. Read each moved file; assert wikilinks now reference each other under the new basenames (basenames unchanged here, so wikilinks may not need rewrite — adjust fixture so at least one rename does change a basename to exercise the rewriter).
7. Assert markdown-style link in `a.md` was recomputed relative to new location.
8. `git log` shows exactly the initial commit + one snapshot commit (no auto-followup).
9. Verify `archai:git_push` was NOT invoked (trivially — test doesn't call it).

Real-vault smoke happens after ship; that's on you, not this code.

## Risks & Open Questions (resolved)

All decisions above are locked. Remaining open item to confirm during execution:

- **Parser library choice** — to be reported in Step 2 before installing the dep. Default plan: `mdast-util-from-markdown` + `micromark-extension-wiki-link`.
