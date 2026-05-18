import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { createGit, type GitClient } from "../git.js";

export function registerGitCommit(
  server: McpServer,
  vaultPath: string,
  gitClient?: GitClient
): void {
  const git = gitClient ?? createGit(vaultPath);

  server.registerTool(
    "git_commit",
    {
      description:
        "Stage everything (git add -A) and create a commit. Returns {committed:false, reason:'clean'} when the tree is clean unless allow_empty=true. Used as a checkpoint before or after a refactor.",
      inputSchema: {
        message: z.string().describe("Commit message"),
        allow_empty: z
          .boolean()
          .optional()
          .describe(
            "Create the commit even if the working tree is clean. Default false."
          ),
      },
    },
    async ({ message, allow_empty }) => {
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
      const r = await git.commit(message, allow_empty ?? false);
      const text = r.committed
        ? `Committed: ${r.sha?.slice(0, 7) ?? ""}`
        : `Nothing to commit (reason: ${r.reason ?? "unknown"})`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: r as unknown as Record<string, unknown>,
      };
    }
  );
}
