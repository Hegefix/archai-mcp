import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { resolveVaultPath, getAllMarkdownFiles } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { describeVaultLayouts, firstTopLevelFolder, type VaultFolderInfo } from "../text.js";

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
  const filtered = folder ? files.filter((f) => f.startsWith(folder)) : files;

  const entries: ListEntry[] = [];
  for (const filePath of filtered) {
    const fullPath = resolveVaultPath(vaultPath, filePath);
    const fileContent = await readFile(fullPath, "utf-8");
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

export function registerList(
  server: McpServer,
  registry: VaultRegistry,
  vaultFolders: VaultFolderInfo[]
): void {
  const defaultVault = vaultFolders.find((v) => v.name === registry.defaultName);
  const layoutSummary = describeVaultLayouts(vaultFolders);
  const folderExample = firstTopLevelFolder(defaultVault) ?? "(this vault is flat — omit folder)";

  server.registerTool(
    "list",
    {
      description:
        "List notes, optionally filtered by folder. Lists all vaults unless a vault is given. Returns paths, titles, status, and creation dates sorted by date descending, labeled by vault.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe(
            `Filter by folder prefix, e.g. "${folderExample}". Known top-level folders — ${layoutSummary}.`
          ),
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
      for (const [name, vaultPath] of targets) {
        entries.push(...(await listVault(name, vaultPath, folder)));
      }

      entries.sort((a, b) => {
        if (a.created === "unknown") return 1;
        if (b.created === "unknown") return -1;
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
