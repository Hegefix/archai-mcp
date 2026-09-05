import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  normalizeVaultPath,
  vaultBasename,
} from "../paths.js";
import { rewriteWikilinks } from "../wikilinks.js";
import {
  recomputeMovedFileLinks,
  rewriteMarkdownLinksByPathMap,
  bumpUpdated,
  findAmbiguityConflicts,
} from "../refactor.js";

interface LinkUpdateRecord {
  path: string;
  old: string;
  new: string;
  line: number;
}

type Resp = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function errText(msg: string): Resp {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

function ok(structured: Record<string, unknown>, text: string): Resp {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

export function registerMove(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "move",
    {
      description:
        "Move or rename a note. By default updates all wikilinks and markdown-style links across the vault so references stay valid. If the destination basename collides with an existing distinct file, the move is refused unless allow_ambiguity=true. If the destination path exists, the move is refused unless overwrite=true. Set dry_run=true to inspect the planned link updates without writing. Bumps the moved note's frontmatter `updated` field (date-only); backlink-only edits in other notes do not bump theirs.",
      inputSchema: {
        from: z
          .string()
          .describe('Source path relative to vault root, must end in .md'),
        to: z
          .string()
          .describe('Destination path relative to vault root, must end in .md'),
        update_links: z
          .boolean()
          .optional()
          .describe('Rewrite incoming wikilinks and markdown links across the vault. Default true.'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Plan only — do not write. Default false.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Permit writing over an existing destination file. Default false.'),
        allow_ambiguity: z
          .boolean()
          .optional()
          .describe('Permit proceeding when the destination basename already names another file in the vault. Default false.'),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({
      from: fromRaw,
      to: toRaw,
      update_links = true,
      dry_run = false,
      overwrite = false,
      allow_ambiguity = false,
      vault,
    }) => {
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

      let from: string;
      let to: string;
      try {
        from = normalizeVaultPath(fromRaw);
        to = normalizeVaultPath(toRaw);
      } catch (err) {
        return errText(err instanceof Error ? err.message : String(err));
      }
      if (!from.endsWith(".md")) {
        return errText(`from must end in .md, got "${from}"`);
      }
      if (!to.endsWith(".md")) {
        return errText(`to must end in .md, got "${to}"`);
      }

      if (from === to) {
        return ok(
          {
            moved: false,
            from,
            to,
            link_updates: [],
            warnings: ["from === to (no-op)"],
            dry_run,
          },
          `No-op: from === to (${from})`
        );
      }

      const fromFull = resolveVaultPath(vaultPath, from);
      const toFull = resolveVaultPath(vaultPath, to);

      let fromContent: string;
      try {
        fromContent = await readFile(fromFull, "utf-8");
      } catch {
        return errText(`from not found: ${from}`);
      }

      let toExists = false;
      try {
        await stat(toFull);
        toExists = true;
      } catch {
        toExists = false;
      }
      if (toExists && !overwrite) {
        return errText(
          `to already exists: ${to}. Pass overwrite: true to replace it.`
        );
      }

      const fromBasename = vaultBasename(from);
      const toBasename = vaultBasename(to);
      const basenameChanged = fromBasename !== toBasename;

      const warnings: string[] = [];
      if (basenameChanged) {
        const exclude = [from];
        if (overwrite && toExists) exclude.push(to);
        const conflicts = await findAmbiguityConflicts(
          vaultPath,
          toBasename,
          exclude
        );
        if (conflicts.length > 0) {
          if (!allow_ambiguity) {
            return errText(
              `Destination basename "${toBasename}" already used by: ${conflicts.join(", ")}. Pass allow_ambiguity: true to proceed.`
            );
          }
          warnings.push(
            `Destination basename "${toBasename}" already used by: ${conflicts.join(", ")}`
          );
        }
      }

      const pathMap = new Map<string, string>([[from, to]]);
      const outgoing = recomputeMovedFileLinks(
        fromContent,
        from,
        to,
        pathMap
      );
      const movedContent = bumpUpdated(outgoing.content);

      const linkUpdates: LinkUpdateRecord[] = [];
      const backlinkWrites = new Map<string, string>();

      if (update_links) {
        const files = await getAllMarkdownFiles(vaultPath);
        for (const file of files) {
          if (file === from || file === to) continue;
          const full = resolveVaultPath(vaultPath, file);
          const original = await readFile(full, "utf-8");
          let current = original;

          if (basenameChanged) {
            const wl = rewriteWikilinks(current, fromBasename, toBasename);
            if (wl.updates.length > 0) {
              current = wl.content;
              for (const u of wl.updates) {
                linkUpdates.push({
                  path: file,
                  old: u.raw,
                  new: u.replacement,
                  line: u.line,
                });
              }
            }
          }

          const ml = rewriteMarkdownLinksByPathMap(current, file, pathMap);
          if (ml.updates.length > 0) {
            current = ml.content;
            for (const u of ml.updates) {
              linkUpdates.push({
                path: file,
                old: u.raw,
                new: u.replacement,
                line: u.line,
              });
            }
          }

          if (current !== original) {
            backlinkWrites.set(file, current);
          }
        }
      }

      const result = {
        moved: !dry_run,
        from,
        to,
        link_updates: linkUpdates,
        warnings,
        dry_run,
      };

      if (dry_run) {
        return ok(
          result,
          `[dry-run] Would move ${from} → ${to}. ${linkUpdates.length} link update(s) across ${backlinkWrites.size} file(s).`
        );
      }

      await mkdir(dirname(toFull), { recursive: true });
      await writeFile(toFull, movedContent, "utf-8");
      for (const [file, content] of backlinkWrites) {
        await writeFile(
          resolveVaultPath(vaultPath, file),
          content,
          "utf-8"
        );
      }
      if (fromFull !== toFull) {
        await unlink(fromFull);
      }

      return ok(
        result,
        `Moved ${from} → ${to}. ${linkUpdates.length} link update(s) across ${backlinkWrites.size} file(s).${warnings.length > 0 ? "\nWarnings: " + warnings.join("; ") : ""}`
      );
    }
  );
}
