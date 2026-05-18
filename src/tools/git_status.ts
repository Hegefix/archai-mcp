import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGit, type GitClient } from "../git.js";

export function registerGitStatus(
  server: McpServer,
  vaultPath: string,
  gitClient?: GitClient
): void {
  const git = gitClient ?? createGit(vaultPath);

  server.registerTool(
    "git_status",
    {
      description:
        "Read the git state of the vault: current branch, dirty flag, ahead/behind counts, and lists of staged / modified / untracked files. Use before suggesting a refactor so you know whether a snapshot is needed and whether the working tree is in a state worth preserving.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!(await git.isRepo())) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Vault at ${vaultPath} is not a git repository. Run 'git init' there.`,
            },
          ],
          isError: true,
        };
      }
      const s = await git.status();
      const lines = [
        `branch: ${s.branch}`,
        `dirty: ${s.dirty}`,
        `ahead: ${s.ahead}, behind: ${s.behind}`,
        `staged: ${s.staged.length === 0 ? "(none)" : s.staged.join(", ")}`,
        `modified: ${s.modified.length === 0 ? "(none)" : s.modified.join(", ")}`,
        `untracked: ${s.untracked.length === 0 ? "(none)" : s.untracked.join(", ")}`,
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: s as unknown as Record<string, unknown>,
      };
    }
  );
}
