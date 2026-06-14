import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

export type VaultRegistry = {
  vaults: Map<string, string>;
  defaultName: string;
};

type VaultConfig = {
  default?: string;
  vaults: Record<string, string>;
};

/** Expand a leading `~` and resolve relative paths against the config file's directory. */
function resolveConfigPath(vaultPath: string, configDir: string): string {
  let expanded = vaultPath;
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = path.join(homedir(), expanded.slice(1));
  }
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

/**
 * Load a vault registry from a JSON config file:
 *   { "default": "tech", "vaults": { "tech": "./tech", "wh40k": "/abs/path" } }
 *
 * Vault paths may be absolute, `~`-prefixed, or relative to the config file.
 * `default` is optional and falls back to the first listed vault.
 */
export async function loadVaultConfig(configPath: string): Promise<VaultRegistry> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(`Cannot read vault config at ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in vault config ${configPath}: ${msg}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Vault config must be a JSON object with a "vaults" map`);
  }
  const config = parsed as Partial<VaultConfig>;
  const rawVaults = config.vaults;
  if (typeof rawVaults !== "object" || rawVaults === null || Array.isArray(rawVaults)) {
    throw new Error(`Vault config "vaults" must be an object mapping names to paths`);
  }

  const configDir = path.dirname(path.resolve(configPath));
  const vaults = new Map<string, string>();
  for (const [name, vaultPath] of Object.entries(rawVaults)) {
    if (typeof vaultPath !== "string" || vaultPath.trim() === "") {
      throw new Error(`Vault "${name}" must have a non-empty path`);
    }
    vaults.set(name, resolveConfigPath(vaultPath.trim(), configDir));
  }

  if (vaults.size === 0) {
    throw new Error(`Vault config "vaults" is empty`);
  }

  let defaultName: string;
  if (config.default !== undefined) {
    if (!vaults.has(config.default)) {
      throw new Error(
        `Default vault "${config.default}" is not listed in "vaults"`
      );
    }
    defaultName = config.default;
  } else {
    defaultName = vaults.keys().next().value as string;
  }

  return { vaults, defaultName };
}

/** Normalize createServer input: a bare path string becomes a single "default" vault. */
export function toRegistry(input: string | VaultRegistry): VaultRegistry {
  if (typeof input === "string") {
    return { vaults: new Map([["default", input]]), defaultName: "default" };
  }
  return input;
}

/** Resolve a vault name to its root path. Undefined name yields the default vault. */
export function resolveVault(registry: VaultRegistry, name?: string): string {
  const key = name ?? registry.defaultName;
  const vaultPath = registry.vaults.get(key);
  if (vaultPath === undefined) {
    const available = [...registry.vaults.keys()].join(", ");
    throw new Error(`vault "${key}" not found. Available: ${available}`);
  }
  return vaultPath;
}
