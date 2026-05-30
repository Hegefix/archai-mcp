import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSave } from "./tools/save.js";
import { registerRead } from "./tools/read.js";
import { registerSearch } from "./tools/search.js";
import { registerList } from "./tools/list.js";
import { registerUpdate } from "./tools/update.js";
import { registerCreateFolder } from "./tools/create_folder.js";

export function createServer(vaultPath: string): McpServer {
  const server = new McpServer({
    name: "archai-mcp",
    version: "1.0.0",
  });

  registerSave(server, vaultPath);
  registerRead(server, vaultPath);
  registerSearch(server, vaultPath);
  registerList(server, vaultPath);
  registerUpdate(server, vaultPath);
  registerCreateFolder(server, vaultPath);

  return server;
}
