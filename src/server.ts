import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGit } from "./git.js";
import { registerSave } from "./tools/save.js";
import { registerRead } from "./tools/read.js";
import { registerSearch } from "./tools/search.js";
import { registerList } from "./tools/list.js";
import { registerUpdate } from "./tools/update.js";
import { registerDelete } from "./tools/delete.js";
import { registerCreateFolder } from "./tools/create_folder.js";
import { registerDeleteFolder } from "./tools/delete_folder.js";
import { registerListFolders } from "./tools/list_folders.js";
import { registerFindBacklinks } from "./tools/find_backlinks.js";
import { registerMove } from "./tools/move.js";
import { registerGitStatus } from "./tools/git_status.js";
import { registerGitCommit } from "./tools/git_commit.js";
import { registerBulkMove } from "./tools/bulk_move.js";

export function createServer(vaultPath: string): McpServer {
  const server = new McpServer({
    name: "archai-mcp",
    version: "1.0.0",
  });

  const git = createGit(vaultPath);

  registerSave(server, vaultPath);
  registerRead(server, vaultPath);
  registerSearch(server, vaultPath);
  registerList(server, vaultPath);
  registerUpdate(server, vaultPath);
  registerDelete(server, vaultPath);
  registerCreateFolder(server, vaultPath);
  registerDeleteFolder(server, vaultPath);
  registerListFolders(server, vaultPath);
  registerFindBacklinks(server, vaultPath);
  registerMove(server, vaultPath);
  registerGitStatus(server, vaultPath, git);
  registerGitCommit(server, vaultPath, git);
  registerBulkMove(server, vaultPath, git);

  return server;
}
