import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type VaultRegistry, toRegistry } from "./vaults.js";
import { registerSave } from "./tools/save.js";
import { registerRead } from "./tools/read.js";
import { registerSearch } from "./tools/search.js";
import { registerList } from "./tools/list.js";
import { registerUpdate } from "./tools/update.js";
import { registerCreateFolder } from "./tools/create_folder.js";
import { registerListVaults } from "./tools/list_vaults.js";

export function createServer(input: string | VaultRegistry): McpServer {
  const registry = toRegistry(input);
  const server = new McpServer({
    name: "archai-mcp",
    version: "1.0.0",
  });

  registerSave(server, registry);
  registerRead(server, registry);
  registerSearch(server, registry);
  registerList(server, registry);
  registerUpdate(server, registry);
  registerCreateFolder(server, registry);
  registerListVaults(server, registry);

  return server;
}
