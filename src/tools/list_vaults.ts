import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type VaultRegistry } from "../vaults.js";

export function registerListVaults(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "list_vaults",
    {
      description:
        "List the configured vaults and their filesystem roots. Use the returned names as the `vault` argument on other tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const vaults = [...registry.vaults.entries()].map(([name, path]) => ({
        name,
        path,
        default: name === registry.defaultName,
      }));

      const formatted = vaults
        .map((v) => `- ${v.name}${v.default ? " (default)" : ""}: ${v.path}`)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
        structuredContent: { vaults },
      };
    }
  );
}
