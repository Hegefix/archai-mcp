import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { stat } from "node:fs/promises";
import { posix } from "node:path";
import matter from "gray-matter";
import { normalizeVaultPath, resolveVaultPath, assertKnownTopLevelFolder } from "../paths.js";
import { type VaultRegistry, resolveVault, isLogEnabled } from "../vaults.js";
import { describeVaultLayouts, firstTopLevelFolder, toKebabCase, type VaultFolderInfo } from "../text.js";
import { gitMove, stageVault } from "../git.js";
import { afterWrite } from "../hooks.js";
import { createJournal } from "../rollback.js";
import { LOG_FILE } from "../log.js";
import { REFERENCES_DIR } from "./save_reference.js";
import {
  applyRewrites,
  buildIndex,
  formatRewrites,
  loadNotes,
  planRewrites,
  stem,
  type FileRewrite,
} from "../refactor.js";

/** Refusal reasons that are about the vault's structure rather than the paths given. */
export type MoveCheck = { ok: true } | { ok: false; error: string };

/**
 * Structural rules on a move, independent of the filesystem.
 *
 * `references/` is immutable by design — there is no `update_reference`, and
 * `save_reference` refuses to overwrite — so moving a file into or out of it would
 * be the edit path the tool surface deliberately withholds. `log.md` is the
 * vault's own bookkeeping, not a note.
 */
export function checkMovable(from: string, to: string): MoveCheck {
  for (const [label, path] of [["from", from], ["to", to]] as const) {
    if (path === LOG_FILE) {
      return { ok: false, error: `refusing to move ${label} the vault's ${LOG_FILE}` };
    }
    if (path === REFERENCES_DIR || path.startsWith(`${REFERENCES_DIR}/`)) {
      return {
        ok: false,
        error:
          `refusing to move ${label} ${REFERENCES_DIR}/: references are immutable ` +
          `captured source material`,
      };
    }
  }
  if (stem(from) === stem(to)) {
    return { ok: false, error: `from and to are the same path: ${from}` };
  }
  return { ok: true };
}

/**
 * Settle the destination path.
 *
 * A `to` that names an existing directory, or ends in a slash, means "move the
 * note in here under its current name" — the common folder reshuffle. A `to` with
 * no extension gets `.md`, matching `save`'s filename generation.
 */
export async function resolveDestination(
  vaultPath: string,
  from: string,
  to: string
): Promise<string> {
  const looksLikeFolder = to.endsWith("/") || (await isDirectory(vaultPath, to));
  const joined = looksLikeFolder
    ? posix.join(normalizeVaultPath(to), posix.basename(from))
    : normalizeVaultPath(to);
  return /\.[^/]+$/.test(joined) ? joined : `${joined}.md`;
}

async function isDirectory(vaultPath: string, relative: string): Promise<boolean> {
  try {
    return (await stat(resolveVaultPath(vaultPath, relative))).isDirectory();
  } catch {
    return false;
  }
}

export type MovePlan = {
  from: string;
  to: string;
  rewrites: FileRewrite[];
  /** Set when the note's frontmatter title no longer matches its filename. */
  titleNote?: string;
};

/**
 * Note when the frontmatter title and the new filename have drifted apart.
 *
 * The title is deliberately not rewritten — filename and title are decoupled in
 * this vault by design (`stack-state.md` is titled "GoodHabitz Mobile Stack
 * State") — so the divergence is reported for the caller to judge rather than
 * silently "fixed".
 */
export function titleDivergence(content: string, to: string): string | undefined {
  let title: unknown;
  try {
    title = matter(content).data["title"];
  } catch {
    return undefined;
  }
  if (typeof title !== "string" || title.trim() === "") return undefined;

  const basename = posix.basename(stem(to));
  if (toKebabCase(title) === basename) return undefined;
  return (
    `frontmatter title "${title}" does not match the new filename "${basename}". ` +
    `Titles are not rewritten by move; update it with the update tool if you want them aligned.`
  );
}

export function registerMove(
  server: McpServer,
  registry: VaultRegistry,
  vaultFolders: VaultFolderInfo[]
): void {
  const defaultVault = vaultFolders.find((v) => v.name === registry.defaultName);
  const layoutSummary = describeVaultLayouts(vaultFolders);
  const folder = firstTopLevelFolder(defaultVault);
  const example = folder ? `${folder}/example-note.md` : "example-note.md";

  server.registerTool(
    "move",
    {
      description:
        "Move or rename a note and rewrite every inbound wikilink so the graph stays " +
        "intact. The file is moved with git mv, so history follows the rename. Refuses " +
        "to overwrite an existing target. Frontmatter titles are never rewritten — a " +
        "divergence between title and filename is reported instead. Use dry_run to see " +
        "the plan first.",
      inputSchema: {
        from: z
          .string()
          .describe(`Current path of the note, e.g. "${example}".`),
        to: z
          .string()
          .describe(
            `New path. A folder (or a trailing "/") keeps the current filename; a ` +
              `missing extension gets ".md". Known top-level folders — ${layoutSummary}.`
          ),
        update_links: z
          .boolean()
          .optional()
          .describe(
            "Rewrite inbound wikilinks in other notes to point at the new path. " +
              "Defaults to true; false moves the file and leaves links dangling."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report what would change and write nothing."),
        allowNewTopLevel: z
          .boolean()
          .optional()
          .describe(
            "Allow a destination under a top-level folder that doesn't exist yet."
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ from, to, update_links, dry_run, allowNewTopLevel, vault }) => {
      const fail = (msg: string) => ({
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true as const,
      });

      let vaultPath: string;
      let fromRel: string;
      let toRel: string;
      try {
        vaultPath = resolveVault(registry, vault);
        // All path safety comes from paths.ts, including the traversal messages.
        fromRel = normalizeVaultPath(from);
        resolveVaultPath(vaultPath, fromRel);
        toRel = await resolveDestination(vaultPath, fromRel, to);
        resolveVaultPath(vaultPath, toRel);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const vaultName = vault ?? registry.defaultName;

      const check = checkMovable(fromRel, toRel);
      if (!check.ok) return fail(check.error);

      try {
        const fromStat = await stat(resolveVaultPath(vaultPath, fromRel));
        if (!fromStat.isFile()) return fail(`${fromRel} is not a file`);
      } catch {
        return fail(`file not found at ${fromRel}`);
      }

      try {
        await stat(resolveVaultPath(vaultPath, toRel));
        return fail(`${toRel} already exists — refusing to overwrite`);
      } catch {
        // Free destination, which is what we need.
      }

      if (allowNewTopLevel !== true) {
        try {
          await assertKnownTopLevelFolder(vaultPath, vaultName, posix.dirname(toRel));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      }

      const notes = await loadNotes(vaultPath);
      const source = notes.find((n) => n.file === fromRel);
      const titleNote =
        source === undefined ? undefined : titleDivergence(source.content, toRel);

      if (dry_run === true) {
        // Predict the post-move index so the reported link forms are the ones a real
        // run would write.
        const projected = await buildIndex(vaultName, vaultPath);
        projected.paths.delete(stem(fromRel));
        projected.paths.add(stem(toRel));
        const rewrites =
          update_links === false
            ? []
            : planRewrites(
                notes.filter((n) => n.file !== fromRel),
                new Map([[posix.basename(stem(fromRel)), stem(toRel)]]),
                projected
              );
        const links = rewrites.reduce((sum, r) => sum + r.changes.length, 0);
        const diff = rewrites.length > 0 ? `\n\n${formatRewrites(vaultName, rewrites)}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Dry run — would move [${vaultName}] ${fromRel} -> ${toRel} ` +
                `(+${links} links in ${rewrites.length} files)${diff}` +
                (titleNote === undefined ? "" : `\n\nNote: ${titleNote}`),
            },
          ],
          structuredContent: {
            vault: vaultName,
            from: fromRel,
            to: toRel,
            dryRun: true,
            links,
            files: rewrites.length,
            rewrites: rewrites.map((r) => ({ file: r.file, changes: r.changes })),
            ...(titleNote === undefined ? {} : { titleNote }),
          },
        };
      }

      const journal = createJournal();
      let rewrites: FileRewrite[] = [];
      try {
        // Journal both ends of the rename so a rollback puts the file back.
        await journal.record(resolveVaultPath(vaultPath, fromRel));
        await journal.record(resolveVaultPath(vaultPath, toRel));
        await gitMove(vaultPath, fromRel, toRel);

        if (update_links !== false) {
          // Index after the move, so a link's written form reflects the vault as it
          // now stands rather than as it was.
          const index = await buildIndex(vaultName, vaultPath);
          rewrites = planRewrites(
            notes.filter((n) => n.file !== fromRel),
            new Map([[posix.basename(stem(fromRel)), stem(toRel)]]),
            index
          );
          await applyRewrites(vaultPath, rewrites, journal);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const restoreWarnings = await journal.rollback();
        await stageVault(vaultPath, [fromRel, toRel, ...rewrites.map((r) => r.file)]);
        return fail(
          `move failed and was rolled back: ${detail}` +
            (restoreWarnings.length > 0 ? `\n${restoreWarnings.join("\n")}` : "")
        );
      }

      const links = rewrites.reduce((sum, r) => sum + r.changes.length, 0);
      const summary = `(+${links} links in ${rewrites.length} files)`;

      // One commit for the whole operation — the rename and every link it dragged
      // along describe a single change.
      const warnings = await afterWrite({
        tool: "move",
        vaultName,
        vaultPath,
        path: toRel,
        // Both ends of the rename plus every note whose links changed — the commit
        // is scoped to exactly this list.
        paths: [fromRel, toRel, ...rewrites.map((r) => r.file)],
        log: isLogEnabled(registry, vaultName),
        message: `move: ${fromRel} -> ${toRel} ${summary}`,
      });

      const diff = rewrites.length > 0 ? `\n\n${formatRewrites(vaultName, rewrites)}` : "";
      const notes_ = [
        ...(titleNote === undefined ? [] : [`Note: ${titleNote}`]),
        ...warnings,
      ];
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Moved: [${vaultName}] ${fromRel} -> ${toRel} ${summary}${diff}` +
              (notes_.length > 0 ? `\n\n${notes_.join("\n")}` : ""),
          },
        ],
        structuredContent: {
          vault: vaultName,
          from: fromRel,
          to: toRel,
          dryRun: false,
          links,
          files: rewrites.length,
          rewrites: rewrites.map((r) => ({ file: r.file, changes: r.changes })),
          ...(titleNote === undefined ? {} : { titleNote }),
        },
      };
    }
  );
}
