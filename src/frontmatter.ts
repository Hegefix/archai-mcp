/**
 * Frontmatter field rules that both `save` and `update` enforce.
 *
 * Pure: takes and returns plain values, so every rule is directly unit-testable
 * and neither tool can drift from the other's interpretation.
 */

/** The whole status scale. Two values, deliberately. */
export const STATUS_VALUES = ["draft", "verified"] as const;

export type Status = (typeof STATUS_VALUES)[number];

/** What a note gets when the caller says nothing. */
export const DEFAULT_STATUS: Status = "draft";

/**
 * The scale this replaced, kept only so it can be REJECTED by name.
 *
 * The four-state scale carried no information — 58 of 76 notes sat in `seedling`
 * purely because it was the default. Silently accepting an old value from a
 * stale client would reintroduce exactly that, so they are named and refused.
 */
export const RETIRED_STATUSES = ["seedling", "growing", "evergreen"] as const;

/** Date-only, the same shape `created`/`updated` use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUS_VALUES as readonly string[]).includes(value);
}

export function isRetiredStatus(value: unknown): boolean {
  return (
    typeof value === "string" && (RETIRED_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Validate a caller-supplied status, or undefined when none was given.
 *
 * Returns an error message rather than throwing, so the tools can surface it as
 * an ordinary `isError` result like every other refusal.
 */
export function checkStatus(status: string | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (isStatus(status)) return undefined;

  if (isRetiredStatus(status)) {
    return (
      `status "${status}" is no longer accepted — the scale is ` +
      `${STATUS_VALUES.join(" | ")}. Use "draft" for anything unverified, or ` +
      `"verified" together with a verified: YYYY-MM-DD date recording when it was ` +
      `checked against the source.`
    );
  }
  return `status must be one of ${STATUS_VALUES.join(" | ")}, got "${status}"`;
}

/**
 * Enforce the pairing invariant: `status: verified` and a `verified` date exist
 * together or not at all.
 *
 * `verified` means "checked against the source ON this date". A verified status
 * with no date is an unfalsifiable claim, and a date with a draft status is a
 * leftover from a demotion — both make the field useless for deciding whether to
 * trust a note, which is the only reason it exists.
 */
export function checkVerifiedPairing(
  status: string | undefined,
  verified: unknown
): string | undefined {
  const hasDate = verified !== undefined && verified !== null && verified !== "";

  if (hasDate && (typeof verified !== "string" || !ISO_DATE.test(verified))) {
    return `verified must be a YYYY-MM-DD date, got ${JSON.stringify(verified)}`;
  }
  if (status === "verified" && !hasDate) {
    return (
      `status "verified" requires a verified: YYYY-MM-DD date recording when the ` +
      `note was checked against its source. Pass verified, or use status "draft".`
    );
  }
  if (hasDate && status !== "verified") {
    return (
      `a verified date is only meaningful with status "verified" (got ` +
      `${status === undefined ? "no status" : `"${status}"`}). Set status "verified" ` +
      `or drop the verified date.`
    );
  }
  return undefined;
}

/**
 * Resolve the status/verified pair for a write.
 *
 * `stored` is what the note already carries (empty for a new note); `input` is
 * what the caller passed. Caller input wins; anything not supplied is inherited.
 *
 * Returns the fields to write plus any `notes` worth telling the caller about,
 * because two of the outcomes change stored data:
 *   - demoting to `draft` drops a now-meaningless `verified` date rather than
 *     leaving the pair inconsistent;
 *   - a stored status from the retired scale is migrated to `draft`, since it is
 *     no longer a value this server will write or accept.
 */
export function resolveStatusFields(
  stored: { status?: unknown; verified?: unknown },
  input: { status?: string; verified?: string }
): {
  error?: string;
  status: Status;
  verified?: string;
  notes: string[];
} {
  const notes: string[] = [];

  const statusError = checkStatus(input.status);
  if (statusError !== undefined) {
    return { error: statusError, status: DEFAULT_STATUS, notes };
  }

  let status: Status;
  if (input.status !== undefined) {
    status = input.status as Status;
  } else if (isStatus(stored.status)) {
    status = stored.status;
  } else {
    if (isRetiredStatus(stored.status)) {
      notes.push(
        `stored status "${String(stored.status)}" is from the retired scale and was ` +
          `normalized to "${DEFAULT_STATUS}".`
      );
    }
    status = DEFAULT_STATUS;
  }

  // An explicit status of "draft" is a demotion: the stored date no longer applies.
  const inheritedDate =
    input.status === "draft" && input.verified === undefined ? undefined : stored.verified;
  const verified = input.verified ?? inheritedDate;

  if (
    input.status === "draft" &&
    input.verified === undefined &&
    stored.verified !== undefined &&
    stored.verified !== null
  ) {
    notes.push(
      `dropped the verified date (${String(stored.verified)}) — it only applies to ` +
        `status "verified".`
    );
  }

  const pairingError = checkVerifiedPairing(status, verified);
  if (pairingError !== undefined) {
    return { error: pairingError, status, notes };
  }

  return verified === undefined || verified === null || verified === ""
    ? { status, notes }
    : { status, verified: verified as string, notes };
}
