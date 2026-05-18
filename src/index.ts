import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export { createServer } from "./server.js";
export { resolveVaultPath } from "./paths.js";
export {
  toKebabCase,
  todayISO,
  inferFolder,
  findWordPositions,
  extractBestSnippet,
} from "./text.js";

async function main(): Promise<void> {
  const vaultPath = process.env["ARCHAI_PATH"];
  if (!vaultPath) {
    console.error("ARCHAI_PATH environment variable is required");
    process.exit(1);
  }
  const server = createServer(vaultPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
