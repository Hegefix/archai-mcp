import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { normalizeVaultPath, resolveVaultPath, getAllMarkdownFiles, readNoteOrNull } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";

type ListEntry = {
  vault: string;
  path: string;
  title: string;
  status: string;
  created: string;
};

async function listVault(
  vaultName: string,
  vaultPath: string,
  folder?: string
): Promise<ListEntry[]> {
  const files = await getAllMarkdownFiles(vaultPath);
  // Compare on a segment boundary: a raw prefix match would let folder "sci"
  // pull in everything under "scifi/".
  const prefix = folder === undefined ? undefined : normalizeVaultPath(folder);
  const filtered =
    prefix === undefined || prefix === "."
      ? files
      : files.filter((f) => f === prefix || f.startsWith(`${prefix}/`));

  const entries: ListEntry[] = [];
  for (const filePath of filtered) {
    const fullPath = resolveVaultPath(vaultPath, filePath);
    const fileContent = await readNoteOrNull(fullPath);
    if (fileContent === null) continue;
    const parsed = matter(fileContent);

    entries.push({
      vault: vaultName,
      path: filePath,
      title:
        (parsed.data["title"] as string | undefined) ??
        filePath.replace(/\.md$/, ""),
      status: String(parsed.data["status"] ?? "unknown"),
      created:
        parsed.data["created"] instanceof Date
          ? (parsed.data["created"].toISOString().split("T")[0] as string)
          : String(parsed.data["created"] ?? "unknown"),
    });
  }
  return entries;
}

export function registerList(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "list",
    {
      description:
        "List notes, optionally filtered by folder. Lists all vaults unless a vault is given. Returns paths, titles, status, and creation dates sorted by date descending, labeled by vault.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Filter by folder, e.g. "tech/concepts". Matches on folder boundaries, not raw prefixes.'),
        vault: z
          .string()
          .optional()
          .describe("Vault name to scope the listing (defaults to all vaults)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, vault }) => {
      const targets: Array<[string, string]> = [];
      if (vault === undefined) {
        for (const [name, vaultPath] of registry.vaults) {
          targets.push([name, vaultPath]);
        }
      } else {
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
        targets.push([vault, vaultPath]);
      }

      const entries: ListEntry[] = [];
      try {
        for (const [name, vaultPath] of targets) {
          entries.push(...(await listVault(name, vaultPath, folder)));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      entries.sort((a, b) => {
        const aUnknown = a.created === "unknown";
        const bUnknown = b.created === "unknown";
        if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
        if (aUnknown) return a.path.localeCompare(b.path);
        return b.created.localeCompare(a.created);
      });

      if (entries.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No notes found." }],
        };
      }

      const formatted = entries
        .map(
          (e) =>
            `- **${e.title}** (${e.status}) [${e.vault}]\n  Path: ${e.path} | Created: ${e.created}`
        )
        .join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    }
  );
}
