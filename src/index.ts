import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "./server.js";
import { loadVaultConfig } from "./vaults.js";

export { createServer } from "./server.js";
export { resolveVaultPath, listTopLevelFolders, assertKnownTopLevelFolder } from "./paths.js";
export {
  checkStatus,
  checkVerifiedPairing,
  resolveStatusFields,
  STATUS_VALUES,
  DEFAULT_STATUS,
  RETIRED_STATUSES,
} from "./frontmatter.js";
export {
  toKebabCase,
  describeVaultLayouts,
  firstTopLevelFolder,
  findWordPositions,
  extractBestSnippet,
} from "./text.js";
export { mergeSources, sourceKey } from "./sources.js";
export { formatLogEntry, appendUnderToday, LOG_FILE } from "./log.js";
export {
  findRepoRoot,
  ensureRepo,
  commitVault,
  gitMove,
  listRenamedBasenames,
  headCommit,
  stageVault,
} from "./git.js";
export { isLogEnabled, partitionAvailableVaults, resolveVault, loadVaultConfig } from "./vaults.js";
export { scanWikilinks, rewriteWikilinks, renderWikilink } from "./wikilinks.js";
export {
  buildVaultIndex,
  resolveTarget,
  classifyLink,
  basenameSimilarity,
  suggestTarget,
  summarize,
  PLANNED_MARKER,
  LINK_CLASSES,
} from "./lint-candidates.js";
export {
  stem,
  loadNotes,
  buildIndex,
  findBacklinks,
  preferredTarget,
  normalizeMapping,
  planRewrites,
  describeRewrites,
} from "./refactor.js";
export { createJournal } from "./rollback.js";
export { checkMovable, resolveDestination, titleDivergence } from "./tools/move.js";
export { validateBatch } from "./tools/bulk_move.js";
export { referencePath, REFERENCES_DIR } from "./tools/save_reference.js";

// vaults.json lives in the project root, one level up from the compiled dist/.
const CONFIG_PATH = fileURLToPath(new URL("../vaults.json", import.meta.url));

async function main(): Promise<void> {
  let registry;
  try {
    registry = await loadVaultConfig(CONFIG_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `${msg}\nCreate vaults.json in the archai-mcp root (copy vaults.example.json).`
    );
    process.exit(1);
  }
  const server = await createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
