import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

export type VaultRegistry = {
  vaults: Map<string, string>;
  defaultName: string;
  /**
   * Vaults with `log.md` appending switched on. Opt-in: a vault absent from this
   * set — which is every vault unless its config says otherwise — is still
   * committed to git on write, just not logged.
   */
  logEnabled?: Set<string>;
  /**
   * Vaults that are configured but not present on this machine, name -> the path
   * that was configured. The vault repo uses `git sparse-checkout`, so a machine
   * materializes only the vaults it wants while the config can list them all.
   * These are kept rather than forgotten so tools can say "skipped" instead of
   * "clean" or "no such vault".
   */
  missing?: Map<string, string>;
};

/** A vault is configured as a bare path, or as an object when it needs options. */
type VaultEntry = string | { path: string; log?: boolean };

type VaultConfig = {
  default?: string;
  vaults: Record<string, VaultEntry>;
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
  const logEnabled = new Set<string>();
  for (const [name, entry] of Object.entries(rawVaults)) {
    const isObject = typeof entry === "object" && entry !== null && !Array.isArray(entry);
    const vaultPath = isObject ? (entry as { path?: unknown }).path : entry;
    if (typeof vaultPath !== "string" || vaultPath.trim() === "") {
      throw new Error(`Vault "${name}" must have a non-empty path`);
    }
    if (isObject) {
      const log = (entry as { log?: unknown }).log;
      if (log !== undefined && typeof log !== "boolean") {
        throw new Error(`Vault "${name}" option "log" must be a boolean`);
      }
      if (log === true) logEnabled.add(name);
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

  return { vaults, defaultName, logEnabled };
}

/** Normalize createServer input: a bare path string becomes a single "default" vault. */
export function toRegistry(input: string | VaultRegistry): VaultRegistry {
  if (typeof input === "string") {
    return { vaults: new Map([["default", input]]), defaultName: "default" };
  }
  return input;
}

/**
 * Whether writes to `name` should append to the vault's `log.md`.
 *
 * Defaults to false. The log duplicates `git log` with strictly less information —
 * it is written in the same commit as the change it describes, has no dedup, and
 * as it accumulates note titles it starts matching `save`'s duplicate-title scan.
 * Vaults that want the human-readable digest opt in per vault in `vaults.json`.
 */
export function isLogEnabled(registry: VaultRegistry, name: string): boolean {
  return registry.logEnabled?.has(name) ?? false;
}

/** Resolve a vault name to its root path. Undefined name yields the default vault. */
export function resolveVault(registry: VaultRegistry, name?: string): string {
  const key = name ?? registry.defaultName;
  const vaultPath = registry.vaults.get(key);
  if (vaultPath === undefined) {
    const available = [...registry.vaults.keys()].join(", ");
    // Distinguish "you named a vault that doesn't exist" from "that vault is real
    // but not checked out here" — those call for completely different fixes.
    const configuredPath = registry.missing?.get(key);
    if (configuredPath !== undefined) {
      throw new Error(
        `vault "${key}" is configured but its directory is missing at ${configuredPath}, ` +
          `so it was skipped on this machine (check your git sparse-checkout). ` +
          `Available: ${available}`
      );
    }
    throw new Error(`vault "${key}" not found. Available: ${available}`);
  }
  return vaultPath;
}

/**
 * Split a registry into the vaults that actually exist on this machine and those
 * that don't.
 *
 * A configured vault whose directory is absent must not be a hard failure: with
 * sparse checkout that is the normal state of every vault this machine opted out
 * of. It also must not be silently served as an empty vault — a tool reporting a
 * clean bill of health for something it never looked at is exactly the
 * documented-vs-real drift this project has already been bitten by. So: drop it
 * from `vaults`, record it in `missing`, and return a warning to print.
 *
 * Throws only when NOTHING is present, since then there is nothing to serve.
 */
export async function partitionAvailableVaults(
  registry: VaultRegistry
): Promise<{ registry: VaultRegistry; warnings: string[] }> {
  const present = new Map<string, string>();
  const missing = new Map<string, string>();
  const warnings: string[] = [];

  for (const [name, vaultPath] of registry.vaults) {
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(vaultPath)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) {
      present.set(name, vaultPath);
    } else {
      missing.set(name, vaultPath);
      warnings.push(`vault "${name}" skipped: no directory at ${vaultPath}`);
    }
  }

  if (present.size === 0) {
    const configured = [...registry.vaults.entries()]
      .map(([name, p]) => `${name} (${p})`)
      .join(", ");
    throw new Error(
      `None of the configured vaults exist on this machine: ${configured}. ` +
        `Check vaults.json and your git sparse-checkout.`
    );
  }

  let defaultName = registry.defaultName;
  if (!present.has(defaultName)) {
    const fallback = present.keys().next().value as string;
    warnings.push(
      `default vault "${defaultName}" is not present; falling back to "${fallback}"`
    );
    defaultName = fallback;
  }

  const result: VaultRegistry = { vaults: present, defaultName };
  if (registry.logEnabled !== undefined) result.logEnabled = registry.logEnabled;
  if (missing.size > 0) result.missing = missing;
  return { registry: result, warnings };
}
