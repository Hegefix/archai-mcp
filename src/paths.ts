import { join } from "node:path";
import { glob } from "glob";

export function resolveVaultPath(vaultPath: string, relativePath: string): string {
  const resolved = join(vaultPath, relativePath);
  if (!resolved.startsWith(vaultPath)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

export function getAllMarkdownFiles(vaultPath: string): Promise<string[]> {
  return glob("**/*.md", {
    cwd: vaultPath,
    ignore: [".obsidian/**"],
    nodir: true,
  });
}
