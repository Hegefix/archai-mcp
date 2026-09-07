import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type VaultRegistry, toRegistry, partitionAvailableVaults } from "./vaults.js";
import { listTopLevelFolders } from "./paths.js";
import { type VaultFolderInfo } from "./text.js";
import { registerSave } from "./tools/save.js";
import { registerRead } from "./tools/read.js";
import { registerSearch } from "./tools/search.js";
import { registerList } from "./tools/list.js";
import { registerUpdate } from "./tools/update.js";
import { registerCreateFolder } from "./tools/create_folder.js";
import { registerListVaults } from "./tools/list_vaults.js";
import { registerSaveReference } from "./tools/save_reference.js";
import { registerFindBacklinks } from "./tools/find_backlinks.js";
import { registerLintLinks } from "./tools/lint_links.js";
import { registerRewriteLinks } from "./tools/rewrite_links.js";
import { registerMove } from "./tools/move.js";
import { registerBulkMove } from "./tools/bulk_move.js";

export async function createServer(input: string | VaultRegistry): Promise<McpServer> {
  // Configured-but-absent vaults are dropped here, once, so every tool below sees
  // only vaults that exist. Warnings go to stderr — stdout is the MCP transport.
  const { registry, warnings } = await partitionAvailableVaults(toRegistry(input));
  for (const warning of warnings) {
    console.error(`archai-mcp: ${warning}`);
  }

  const vaultFolders: VaultFolderInfo[] = await Promise.all(
    [...registry.vaults.entries()].map(async ([name, vaultPath]) => ({
      name,
      topLevelFolders: await listTopLevelFolders(vaultPath),
    }))
  );

  const server = new McpServer({
    name: "archai-mcp",
    version: "1.0.0",
  });

  registerSave(server, registry, vaultFolders);
  registerSaveReference(server, registry);
  registerRead(server, registry, vaultFolders);
  registerSearch(server, registry);
  registerList(server, registry, vaultFolders);
  registerUpdate(server, registry);
  registerCreateFolder(server, registry, vaultFolders);
  registerListVaults(server, registry);
  registerFindBacklinks(server, registry, vaultFolders);
  registerLintLinks(server, registry);
  registerRewriteLinks(server, registry);
  registerMove(server, registry, vaultFolders);
  registerBulkMove(server, registry);

  return server;
}
