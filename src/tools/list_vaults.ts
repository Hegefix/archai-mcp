import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type VaultRegistry } from "../vaults.js";

export function registerListVaults(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "list_vaults",
    {
      description:
        "List the vaults available on this machine and their filesystem roots. Use the " +
        "returned names as the `vault` argument on other tools. Configured vaults whose " +
        "directory is absent (a sparse checkout that left them out) are NOT listed as " +
        "vaults — they are reported separately as skipped, so the count always matches " +
        "what is actually on disk.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const vaults = [...registry.vaults.entries()].map(([name, path]) => ({
        name,
        path,
        default: name === registry.defaultName,
      }));
      const skipped = [...(registry.missing ?? new Map()).entries()].map(
        ([name, path]) => ({ name, path })
      );

      const formatted = vaults
        .map((v) => `- ${v.name}${v.default ? " (default)" : ""}: ${v.path}`)
        .join("\n");
      const skippedText =
        skipped.length === 0
          ? ""
          : `\n\nConfigured but not present on this machine (skipped):\n` +
            skipped.map((v) => `- ${v.name}: ${v.path}`).join("\n");

      return {
        content: [{ type: "text" as const, text: `${formatted}${skippedText}` }],
        structuredContent: { vaults, skipped },
      };
    }
  );
}
