import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { createGit, type GitClient } from "../git.js";

export function registerGitPush(
  server: McpServer,
  vaultPath: string,
  gitClient?: GitClient
): void {
  const git = gitClient ?? createGit(vaultPath);

  server.registerTool(
    "git_push",
    {
      description:
        "Push the vault repo to a remote. **This tool MUST NOT be invoked unless the user has explicitly requested a push in their most recent message. Do not call as a follow-up to other operations.** This is a soft barrier — the server cannot see chat context, so respecting this rule is the calling model's responsibility. Never uses --force; on push failure the git stderr is returned verbatim in `error` for the user to resolve.",
      inputSchema: {
        remote: z
          .string()
          .optional()
          .describe('Remote name. Default "origin".'),
        branch: z
          .string()
          .optional()
          .describe("Branch to push. Default: current branch."),
      },
    },
    async ({ remote, branch }) => {
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
      const r = await git.push(remote, branch);
      const lines = r.pushed
        ? [`Pushed ${r.branch} → ${r.remote}`]
        : [`Push failed (${r.remote}/${r.branch || "?"}):`, r.error ?? "(no error message)"];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: r as unknown as Record<string, unknown>,
        isError: !r.pushed,
      };
    }
  );
}
