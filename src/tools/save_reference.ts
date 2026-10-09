import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { posix, dirname } from "node:path";
import { normalizeVaultPath, resolveVaultPath, REFERENCES_DIR } from "../paths.js";
import { type VaultRegistry, resolveVault, isLogEnabled } from "../vaults.js";
import { afterWrite } from "../hooks.js";
import { buildIndex } from "../refactor.js";
import { INDEX_NOTE, isIndexed, readIndexCoverage } from "../index-coverage.js";

export { REFERENCES_DIR };

/**
 * Place a caller-supplied path inside `references/`.
 *
 * The caller's path is normalized first (rejecting absolute paths and anything
 * escaping the vault), then normalized again after joining, so a path like
 * `../notes/x` cannot climb out of `references/` while still resolving inside the
 * vault. All path safety comes from `normalizeVaultPath`/`resolveVaultPath`.
 */
export function referencePath(input: string): string {
  const relative = normalizeVaultPath(posix.join(REFERENCES_DIR, normalizeVaultPath(input)));
  if (relative === REFERENCES_DIR || !relative.startsWith(`${REFERENCES_DIR}/`)) {
    throw new Error(
      `Reference path must name a file inside ${REFERENCES_DIR}/, got: ${input}`
    );
  }
  return relative;
}

export function registerSaveReference(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "save_reference",
    {
      description:
        `Store raw source material verbatim under ${REFERENCES_DIR}/ in an Obsidian vault. ` +
        "Content is written as given — no frontmatter, no kebab-casing, no duplicate check. " +
        "References are immutable: there is no tool to edit one, and writing over an " +
        "existing reference is refused. Use save/update for authored notes instead. " +
        "When the vault has a root index.md, the result says whether it already lists the " +
        "reference's path (structured `indexed`); references are listed by path, not wikilink.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Path of the reference relative to ${REFERENCES_DIR}/, extension included, ` +
              `e.g. "rfc/rfc-9110.txt". Stored at ${REFERENCES_DIR}/<path>.`
          ),
        content: z.string().describe("Raw content, written verbatim"),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ path: inputPath, content, vault }) => {
      let vaultPath: string;
      try {
        vaultPath = resolveVault(registry, vault);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      let relativePath: string;
      try {
        relativePath = referencePath(inputPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      const fullPath = resolveVaultPath(vaultPath, relativePath);

      // Immutability: overwriting an existing reference would be an edit path, which
      // this tool deliberately does not offer.
      try {
        await stat(fullPath);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Error: reference already exists at ${relativePath}. ` +
                "References are immutable — write it under a different path instead.",
            },
          ],
          isError: true,
        };
      } catch {
        // Doesn't exist — fall through to write.
      }

      // `references/` is created on demand: the top-level segment is fixed by this
      // tool rather than supplied by the model, so the assertKnownTopLevelFolder
      // guard has nothing to protect against here.
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");

      const vaultName = vault ?? registry.defaultName;
      await afterWrite({
        tool: "save_reference",
        vaultName,
        vaultPath,
        path: relativePath,
        log: isLogEnabled(registry, vaultName),
      });

      // References sit outside the wikilink graph, so the map reaches them by path.
      const coverage = await readIndexCoverage(
        vaultPath,
        await buildIndex(vaultName, vaultPath)
      );
      const indexed = coverage === null ? undefined : isIndexed(coverage, relativePath);
      const reminder =
        indexed === false
          ? `\n\nNot in ${INDEX_NOTE} yet. ${INDEX_NOTE} is this vault's map and lists ` +
            `references too: read it and add [${posix.basename(relativePath)}](${relativePath}) ` +
            `with a one-line description where it lists references, then write that back ` +
            `with update — in this same pass. A [[wikilink]] does not count: references are ` +
            `outside the link graph. Until then lint_links reports it as unindexed.`
          : "";

      return {
        content: [
          { type: "text" as const, text: `Stored: [${vaultName}] ${relativePath}${reminder}` },
        ],
        structuredContent: {
          path: relativePath,
          vault: vaultName,
          ...(indexed === undefined ? {} : { indexed }),
        },
      };
    }
  );
}
