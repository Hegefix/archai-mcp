import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { posix } from "node:path";
import { normalizeVaultPath, resolveVaultPath, assertKnownTopLevelFolder } from "../paths.js";
import { type VaultRegistry, resolveVault, isLogEnabled } from "../vaults.js";
import { getAllMarkdownFiles } from "../paths.js";
import { gitMove, headCommit, stageVault } from "../git.js";
import { afterWrite } from "../hooks.js";
import { createJournal } from "../rollback.js";
import {
  applyRewrites,
  buildIndex,
  formatRewrites,
  loadNotes,
  planRewrites,
  stem,
  type FileRewrite,
} from "../refactor.js";
import { checkMovable, resolveDestination } from "./move.js";

export type MoveEntry = { from: string; to: string };

export type BatchValidation =
  | { ok: true; ordered: MoveEntry[] }
  | { ok: false; error: string; index?: number };

/**
 * Validate a whole batch before anything is applied, and put it in a safe order.
 *
 * Everything is checked up front on purpose: the guarantee this tool sells is that
 * a batch either happens or doesn't, and the cheapest way to keep it is to reject
 * an impossible batch before the first rename rather than discover the problem
 * half way through and rely on the rollback.
 *
 * `existing` holds the vault's current note paths (`.md` included).
 */
export function validateBatch(
  entries: MoveEntry[],
  existing: Set<string>
): BatchValidation {
  if (entries.length === 0) return { ok: false, error: "moves is empty" };

  const fromStems = new Set(entries.map((e) => stem(e.from)));
  const seenFrom = new Set<string>();
  const seenTo = new Set<string>();
  const seenFromBasename = new Map<string, string>();

  for (const [index, entry] of entries.entries()) {
    const check = checkMovable(entry.from, entry.to);
    if (!check.ok) return { ok: false, index, error: check.error };

    if (!existing.has(entry.from)) {
      return { ok: false, index, error: `file not found at ${entry.from}` };
    }
    if (seenFrom.has(stem(entry.from))) {
      return { ok: false, index, error: `${entry.from} is moved more than once` };
    }
    if (seenTo.has(stem(entry.to))) {
      return { ok: false, index, error: `two moves target ${entry.to}` };
    }

    // A destination may collide with a file only if that file is itself leaving in
    // this batch; otherwise the batch would overwrite a note.
    if (existing.has(entry.to) && !fromStems.has(stem(entry.to))) {
      return {
        ok: false,
        index,
        error: `${entry.to} already exists and is not being moved out of the way`,
      };
    }

    // Links are matched by basename, so two notes sharing a source basename in one
    // batch would make `[[that-basename]]` ambiguous to rewrite.
    const basename = posix.basename(stem(entry.from));
    const clash = seenFromBasename.get(basename);
    if (clash !== undefined) {
      return {
        ok: false,
        index,
        error:
          `${entry.from} and ${clash} share the basename "${basename}", so inbound ` +
          `links to it cannot be rewritten unambiguously — move them in separate calls`,
      };
    }
    seenFromBasename.set(basename, entry.from);

    seenFrom.add(stem(entry.from));
    seenTo.add(stem(entry.to));
  }

  // Order so a destination is always vacated before it is filled. A batch that
  // cannot be ordered contains a cycle (a swap, at minimum), which needs a
  // temporary name this tool deliberately does not invent.
  const pending = [...entries];
  const ordered: MoveEntry[] = [];
  while (pending.length > 0) {
    const next = pending.findIndex(
      (entry) => !pending.some((other) => other !== entry && stem(other.from) === stem(entry.to))
    );
    if (next === -1) {
      const involved = pending.map((e) => `${e.from} -> ${e.to}`).join(", ");
      return { ok: false, error: `moves form a cycle: ${involved}` };
    }
    ordered.push(...pending.splice(next, 1));
  }

  return { ok: true, ordered };
}

export function registerBulkMove(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "bulk_move",
    {
      description:
        "Move or rename several notes in one atomic batch, rewriting all inbound " +
        "wikilinks and landing as a single commit. The whole batch is validated before " +
        "anything moves — no duplicate targets, no overwriting a note that isn't itself " +
        "moving, no cycles — and if any move or rewrite fails part way, the entire batch " +
        "is rolled back and the failing entry is reported. Use dry_run to preview.",
      inputSchema: {
        moves: z
          .array(
            z.object({
              from: z.string().describe("Current path of the note"),
              to: z
                .string()
                .describe('New path; a folder or trailing "/" keeps the filename'),
            })
          )
          .describe("The renames to apply as one unit."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report the plan and write nothing."),
        allowNewTopLevel: z
          .boolean()
          .optional()
          .describe("Allow destinations under top-level folders that don't exist yet."),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ moves, dry_run, allowNewTopLevel, vault }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true as const,
      });

      let vaultPath: string;
      let entries: MoveEntry[];
      try {
        vaultPath = resolveVault(registry, vault);
        entries = [];
        for (const move of moves) {
          const from = normalizeVaultPath(move.from);
          resolveVaultPath(vaultPath, from);
          const to = await resolveDestination(vaultPath, from, move.to);
          resolveVaultPath(vaultPath, to);
          entries.push({ from, to });
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const vaultName = vault ?? registry.defaultName;

      const existing = new Set(await getAllMarkdownFiles(vaultPath));
      const validation = validateBatch(entries, existing);
      if (!validation.ok) {
        const where =
          validation.index === undefined ? "" : ` (moves[${validation.index}])`;
        return fail(`batch rejected${where}: ${validation.error}`);
      }
      const ordered = validation.ordered;

      if (allowNewTopLevel !== true) {
        for (const [index, entry] of ordered.entries()) {
          try {
            await assertKnownTopLevelFolder(vaultPath, vaultName, posix.dirname(entry.to));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return fail(`batch rejected (moves[${index}]): ${msg}`);
          }
        }
      }

      const notes = await loadNotes(vaultPath);
      const mapping = new Map(
        ordered.map((e) => [posix.basename(stem(e.from)), stem(e.to)] as const)
      );
      const movedFiles = new Set(ordered.map((e) => e.from));
      const plan = ordered.map((e) => `${e.from} -> ${e.to}`);

      if (dry_run === true) {
        const projected = await buildIndex(vaultName, vaultPath);
        for (const entry of ordered) {
          projected.paths.delete(stem(entry.from));
          projected.paths.add(stem(entry.to));
        }
        const rewrites = planRewrites(
          notes.filter((n) => !movedFiles.has(n.file)),
          mapping,
          projected
        );
        const links = rewrites.reduce((sum, r) => sum + r.changes.length, 0);
        const diff = rewrites.length > 0 ? `\n\n${formatRewrites(vaultName, rewrites)}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Dry run — would move ${ordered.length} note(s) in [${vaultName}] ` +
                `(+${links} links in ${rewrites.length} files):\n` +
                plan.map((p) => `  ${p}`).join("\n") +
                diff,
            },
          ],
          structuredContent: {
            vault: vaultName,
            dryRun: true,
            moves: ordered,
            links,
            files: rewrites.length,
            rewrites: rewrites.map((r) => ({ file: r.file, changes: r.changes })),
          },
        };
      }

      // The snapshot is a per-file journal, not a git reset: both vaults share one
      // repo and normally carry uncommitted Obsidian edits, so a git-level undo
      // would revert work this tool never touched.
      const before = await headCommit(vaultPath);
      const journal = createJournal();
      let rewrites: FileRewrite[] = [];
      let failedAt: MoveEntry | undefined;

      try {
        for (const entry of ordered) {
          failedAt = entry;
          await journal.record(resolveVaultPath(vaultPath, entry.from));
          await journal.record(resolveVaultPath(vaultPath, entry.to));
          await gitMove(vaultPath, entry.from, entry.to);
        }
        failedAt = undefined;

        const index = await buildIndex(vaultName, vaultPath);
        rewrites = planRewrites(
          notes.filter((n) => !movedFiles.has(n.file)),
          mapping,
          index
        );
        await applyRewrites(vaultPath, rewrites, journal);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const restoreWarnings = await journal.rollback();
        await stageVault(vaultPath, [
          ...ordered.flatMap((e) => [e.from, e.to]),
          ...rewrites.map((r) => r.file),
        ]);
        const which =
          failedAt === undefined
            ? "while rewriting links"
            : `at ${failedAt.from} -> ${failedAt.to}`;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error: batch failed ${which} and was rolled back in full ` +
                `(${journal.size()} file(s) restored): ${detail}` +
                (before === undefined ? "" : `\nVault still at ${before.slice(0, 8)}.`) +
                (restoreWarnings.length > 0 ? `\n${restoreWarnings.join("\n")}` : ""),
            },
          ],
          isError: true,
          structuredContent: {
            vault: vaultName,
            rolledBack: true,
            ...(failedAt === undefined ? {} : { failedEntry: failedAt }),
            reason: detail,
          },
        };
      }

      const links = rewrites.reduce((sum, r) => sum + r.changes.length, 0);
      const warnings = await afterWrite({
        tool: "bulk_move",
        vaultName,
        vaultPath,
        path: ordered[0]?.to ?? "",
        paths: [
          ...ordered.flatMap((e) => [e.from, e.to]),
          ...rewrites.map((r) => r.file),
        ],
        log: isLogEnabled(registry, vaultName),
        message:
          `bulk_move: ${ordered.length} notes (+${links} links in ${rewrites.length} files)`,
      });

      const diff = rewrites.length > 0 ? `\n\n${formatRewrites(vaultName, rewrites)}` : "";
      const trailer = warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Moved ${ordered.length} note(s) in [${vaultName}] ` +
              `(+${links} links in ${rewrites.length} files):\n` +
              plan.map((p) => `  ${p}`).join("\n") +
              diff +
              trailer,
          },
        ],
        structuredContent: {
          vault: vaultName,
          dryRun: false,
          moves: ordered,
          links,
          files: rewrites.length,
          rewrites: rewrites.map((r) => ({ file: r.file, changes: r.changes })),
        },
      };
    }
  );
}
