import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readFile } from "node:fs/promises";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  vaultBasename,
} from "../paths.js";
import { scanLinks, contextSnippet, type LinkKind } from "../wikilinks.js";
import * as path from "node:path";

interface Backlink {
  path: string;
  line: number;
  column: number;
  link_type: LinkKind;
  raw: string;
  context: string;
}

function resolveMarkdownLinkUrl(
  notePath: string,
  linkUrl: string
): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(linkUrl)) return null;
  if (linkUrl.startsWith("#")) return null;
  const cleaned = linkUrl.split("#")[0]?.split("?")[0] ?? "";
  if (!cleaned) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    decoded = cleaned;
  }
  const noteDir = path.posix.dirname(notePath);
  const joined = path.posix.normalize(path.posix.join(noteDir, decoded));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined;
}

export function registerFindBacklinks(
  server: McpServer,
  vaultPath: string
): void {
  server.registerTool(
    "find_backlinks",
    {
      description:
        "Find every note in the vault that links to the target. Resolves wikilinks by basename (Obsidian's behavior). Returns each backlink with file path, 1-indexed line/column, link type (wikilink|wikilink_embed|markdown), raw matched text, and ~80 chars of surrounding context. Also returns resolved_files: every vault path whose basename matches the target. If resolved_files.length > 1, the target is ambiguous — callers must rename one of them before doing a basename-changing move.",
      inputSchema: {
        target: z
          .string()
          .describe(
            'Either a basename (e.g. "archai-mcp-server") or a relative path (e.g. "public/tech/archai-mcp-server.md"). Both collapse to a basename match.'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ target }) => {
      let targetBasename: string;
      try {
        if (target.includes("/") || target.endsWith(".md")) {
          targetBasename = vaultBasename(target);
        } else {
          targetBasename = target;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      const files = await getAllMarkdownFiles(vaultPath);
      const resolved_files: string[] = [];
      const backlinks: Backlink[] = [];

      for (const file of files) {
        if (vaultBasename(file) === targetBasename) {
          resolved_files.push(file);
        }
        const full = resolveVaultPath(vaultPath, file);
        const content = await readFile(full, "utf-8");
        const refs = scanLinks(content);
        for (const ref of refs) {
          let isMatch = false;
          if (ref.kind === "wikilink" || ref.kind === "wikilink_embed") {
            isMatch = ref.basename === targetBasename;
          } else if (ref.kind === "markdown" && ref.target) {
            const resolved = resolveMarkdownLinkUrl(file, ref.target);
            if (resolved !== null) {
              isMatch = vaultBasename(resolved) === targetBasename;
            }
          }
          if (!isMatch) continue;
          backlinks.push({
            path: file,
            line: ref.line,
            column: ref.column,
            link_type: ref.kind,
            raw: ref.raw,
            context: contextSnippet(content, ref.offset, ref.length),
          });
        }
      }

      resolved_files.sort();
      const lines = [
        `Found ${backlinks.length} backlink${backlinks.length === 1 ? "" : "s"} to ${targetBasename}.`,
      ];
      if (resolved_files.length === 0) {
        lines.push("No files in the vault have this basename.");
      } else if (resolved_files.length > 1) {
        lines.push(
          `Ambiguous: matches ${resolved_files.length} files (${resolved_files.join(", ")}).`
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          target: targetBasename,
          resolved_files,
          backlinks,
        },
      };
    }
  );
}
