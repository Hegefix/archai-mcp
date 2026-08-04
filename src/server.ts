import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type VaultRegistry, toRegistry } from "./vaults.js";
import { listTopLevelFolders } from "./paths.js";
import { type VaultFolderInfo } from "./text.js";
import { registerSave } from "./tools/save.js";
import { registerRead } from "./tools/read.js";
import { registerSearch } from "./tools/search.js";
import { registerList } from "./tools/list.js";
import { registerUpdate } from "./tools/update.js";
import { registerCreateFolder } from "./tools/create_folder.js";
import { registerListVaults } from "./tools/list_vaults.js";

export async function createServer(input: string | VaultRegistry): Promise<McpServer> {
  const registry = toRegistry(input);
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
  registerRead(server, registry, vaultFolders);
  registerSearch(server, registry);
  registerList(server, registry, vaultFolders);
  registerUpdate(server, registry);
  registerCreateFolder(server, registry, vaultFolders);
  registerListVaults(server, registry);

  return server;
}
