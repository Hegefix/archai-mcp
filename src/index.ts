import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import { loadVaultConfig } from "./vaults.js";

export { createServer } from "./server.js";
export { resolveVaultPath } from "./paths.js";
export {
  toKebabCase,
  inferFolder,
  findWordPositions,
  extractBestSnippet,
} from "./text.js";

// vaults.json lives in the project root, one level up from the compiled dist/.
const CONFIG_PATH = fileURLToPath(new URL("../vaults.json", import.meta.url));

async function main(): Promise<void> {
  let registry;
  try {
    registry = await loadVaultConfig(CONFIG_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${msg}\nCreate vaults.json in the archai-mcp root (copy vaults_example.json).`
    );
    process.exit(1);
  }
  const server = createServer(registry);
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
