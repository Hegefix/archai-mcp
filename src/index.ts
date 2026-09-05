import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { createServer } from "./server.js";
import { loadVaultConfig } from "./vaults.js";

export { createServer } from "./server.js";
export { resolveVaultPath } from "./paths.js";
export {
  toKebabCase,
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

// argv[1] can be relative or a symlink; compare resolved real paths. It can
// also be missing or already gone (test runners, REPL) — treat that as "not us".
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
