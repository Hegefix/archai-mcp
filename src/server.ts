import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type VaultRegistry, toRegistry } from "./vaults.js";
import { registerSave } from "./tools/save.js";
import { registerRead } from "./tools/read.js";
import { registerSearch } from "./tools/search.js";
import { registerList } from "./tools/list.js";
import { registerUpdate } from "./tools/update.js";
import { registerCreateFolder } from "./tools/create_folder.js";
import { registerListVaults } from "./tools/list_vaults.js";
import { registerLintLinks } from "./tools/lint_links.js";
import { registerFindBacklinks } from "./tools/find_backlinks.js";
import { registerMove } from "./tools/move.js";
import { registerRewriteLinks } from "./tools/rewrite_links.js";

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
  registerLintLinks(server, registry);
  registerFindBacklinks(server, registry);
  registerMove(server, registry);
  registerRewriteLinks(server, registry);

  return server;
}
