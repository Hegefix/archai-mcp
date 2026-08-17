import { z } from "zod/v3";

/** Provenance entry recorded in a note's frontmatter. */
export const sourceSchema = z.object({
  resource: z
    .string()
    .describe("Where the material came from, e.g. a URL, connector or system name"),
  id: z.string().optional().describe("Identifier of the item within that resource"),
  title: z.string().optional().describe("Human-readable title of the source item"),
  author: z.string().optional().describe("Author or owner of the source item"),
  last_modified: z
    .string()
    .optional()
    .describe("When the source item last changed, ISO 8601"),
});

export type Source = z.infer<typeof sourceSchema>;

const FIELDS = ["resource", "id", "title", "author", "last_modified"] as const;

/**
 * Identity of a source entry: `resource` plus `id`. An entry without an id is the
 * resource itself, so it is distinct from any of that resource's items.
 *
 * The NUL separator keeps `"a b"` + no id from colliding with `"a"` + id `"b"`.
 */
export function sourceKey(source: Source): string {
  return `${source.resource}\u0000${source.id ?? ""}`;
}

/** Drop undefined fields and fix key order, so the YAML written stays stable. */
function normalize(source: Source): Source {
  const clean: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value !== "") clean[field] = value;
  }
  return clean as unknown as Source;
}

function isSource(value: unknown): value is Source {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { resource?: unknown }).resource === "string"
  );
}

/** Existing frontmatter `sources` coerced to a list; unusable values are dropped. */
function readExisting(existing: unknown): Source[] {
  if (Array.isArray(existing)) return existing.filter(isSource);
  if (isSource(existing)) return [existing];
  return [];
}

/**
 * Accumulate provenance rather than replace it: incoming entries are appended, and
 * an entry whose `resource`+`id` already appears is merged field-wise over the one
 * already there (so a refreshed `last_modified` or a newly known `author` lands)
 * while keeping its original position.
 */
export function mergeSources(existing: unknown, incoming: Source[]): Source[] {
  const merged = readExisting(existing).map(normalize);
  const byKey = new Map<string, number>();
  merged.forEach((source, index) => byKey.set(sourceKey(source), index));

  for (const raw of incoming) {
    const source = normalize(raw);
    const key = sourceKey(source);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, merged.length);
      merged.push(source);
    } else {
      merged[at] = { ...merged[at], ...source } as Source;
    }
  }

  return merged;
}
