import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  vaultBasename,
} from "../paths.js";
import {
  rewriteWikilinks,
  rewriteMarkdownLinks,
} from "../wikilinks.js";
import { resolveMarkdownLinkUrl } from "../refactor.js";

interface LinkUpdateRecord {
  path: string;
  old: string;
  new: string;
  line: number;
}

function replaceBasenameInUrl(url: string, newBasename: string): string {
  const hashIdx = url.indexOf("#");
  const queryIdx = url.indexOf("?");
  let cutIdx = -1;
  if (hashIdx !== -1) cutIdx = hashIdx;
  if (queryIdx !== -1 && (cutIdx === -1 || queryIdx < cutIdx)) cutIdx = queryIdx;
  const pathPart = cutIdx === -1 ? url : url.slice(0, cutIdx);
  const suffix = cutIdx === -1 ? "" : url.slice(cutIdx);
  const dir = path.posix.dirname(pathPart);
  const newPath = dir === "." ? `${newBasename}.md` : `${dir}/${newBasename}.md`;
  return newPath + suffix;
}

export function registerRewriteLinks(
  server: McpServer,
  vaultPath: string
): void {
  server.registerTool(
    "rewrite_links",
    {
      description:
        "Mass-rename wikilink targets across the vault without moving any files. Useful when a note was renamed in Obsidian's UI and links broke, or when consolidating aliases. Rewrites [[from...]] / ![[from...]] preserving alias / heading / block-id, and markdown-style links whose target basename matches `from` (preserving the link's directory).",
      inputSchema: {
        from: z
          .string()
          .describe('Old basename, e.g. "archai-mcp-server"'),
        to: z.string().describe("New basename"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Plan only — do not write. Default false."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ from, to, dry_run = false }) => {
      if (typeof from !== "string" || typeof to !== "string") {
        return {
          content: [
            { type: "text" as const, text: "Error: from and to must be strings" },
          ],
          isError: true,
        };
      }
      if (from === to) {
        return {
          content: [
            { type: "text" as const, text: "No-op: from === to" },
          ],
          structuredContent: { updates: [], dry_run },
        };
      }

      const fromBasename =
        from.replace(/\.md$/, "").split("/").pop() ?? from;
      const toBasename =
        to.replace(/\.md$/, "").split("/").pop() ?? to;

      const files = await getAllMarkdownFiles(vaultPath);
      const updates: LinkUpdateRecord[] = [];
      const writes = new Map<string, string>();

      for (const file of files) {
        const full = resolveVaultPath(vaultPath, file);
        const original = await readFile(full, "utf-8");
        let current = original;

        const wl = rewriteWikilinks(current, fromBasename, toBasename);
        if (wl.updates.length > 0) {
          current = wl.content;
          for (const u of wl.updates) {
            updates.push({
              path: file,
              old: u.raw,
              new: u.replacement,
              line: u.line,
            });
          }
        }

        const ml = rewriteMarkdownLinks(current, (url) => {
          const resolved = resolveMarkdownLinkUrl(file, url);
          if (resolved === null) return null;
          if (vaultBasename(resolved) !== fromBasename) return null;
          return replaceBasenameInUrl(url, toBasename);
        });
        if (ml.updates.length > 0) {
          current = ml.content;
          for (const u of ml.updates) {
            updates.push({
              path: file,
              old: u.raw,
              new: u.replacement,
              line: u.line,
            });
          }
        }

        if (current !== original) writes.set(file, current);
      }

      if (!dry_run) {
        for (const [file, content] of writes) {
          await writeFile(
            resolveVaultPath(vaultPath, file),
            content,
            "utf-8"
          );
        }
      }

      const verb = dry_run ? "[dry-run] Would rewrite" : "Rewrote";
      return {
        content: [
          {
            type: "text" as const,
            text: `${verb} ${updates.length} link(s) across ${writes.size} file(s).`,
          },
        ],
        structuredContent: { updates, dry_run },
      };
    }
  );
}
