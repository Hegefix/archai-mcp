import { describe, it, expect } from "vitest";
import {
  checkStatus,
  checkVerifiedPairing,
  resolveStatusFields,
  STATUS_VALUES,
  DEFAULT_STATUS,
  RETIRED_STATUSES,
} from "./frontmatter.js";

describe("status scale", () => {
  it("is exactly draft and verified, defaulting to draft", () => {
    expect(STATUS_VALUES).toEqual(["draft", "verified"]);
    expect(DEFAULT_STATUS).toBe("draft");
  });

  it("accepts both live values", () => {
    expect(checkStatus("draft")).toBeUndefined();
    expect(checkStatus("verified")).toBeUndefined();
  });

  it("accepts an absent status", () => {
    expect(checkStatus(undefined)).toBeUndefined();
  });

  // A stray value from an old client is how the previous scale became meaningless
  // (58 of 76 notes sat in the default), so each retired value is refused by name.
  it.each(RETIRED_STATUSES)("rejects the retired value %s by name", (retired) => {
    const error = checkStatus(retired);
    expect(error).toContain(retired);
    expect(error).toContain("draft | verified");
  });

  it("rejects an unknown value, listing the valid ones", () => {
    expect(checkStatus("wip")).toBe('status must be one of draft | verified, got "wip"');
  });
});

describe("checkVerifiedPairing", () => {
  it("accepts draft with no date", () => {
    expect(checkVerifiedPairing("draft", undefined)).toBeUndefined();
  });

  it("accepts verified with a date", () => {
    expect(checkVerifiedPairing("verified", "2026-08-25")).toBeUndefined();
  });

  it("rejects verified with no date", () => {
    const error = checkVerifiedPairing("verified", undefined);
    expect(error).toContain("requires a verified: YYYY-MM-DD date");
  });

  it("rejects a date without the verified status", () => {
    const error = checkVerifiedPairing("draft", "2026-08-25");
    expect(error).toContain('only meaningful with status "verified"');
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(checkVerifiedPairing("verified", "25 Aug 2026")).toContain(
      "must be a YYYY-MM-DD date"
    );
    expect(checkVerifiedPairing("verified", 20260825)).toContain(
      "must be a YYYY-MM-DD date"
    );
  });
});

describe("resolveStatusFields", () => {
  it("defaults a new note to draft with no date", () => {
    const result = resolveStatusFields({}, {});
    expect(result).toMatchObject({ status: "draft" });
    expect(result.verified).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("creates a verified note when both fields are supplied", () => {
    const result = resolveStatusFields({}, { status: "verified", verified: "2026-08-25" });
    expect(result).toMatchObject({ status: "verified", verified: "2026-08-25" });
  });

  it("refuses a verified note with no date", () => {
    expect(resolveStatusFields({}, { status: "verified" }).error).toContain(
      "requires a verified"
    );
  });

  it("refuses a retired value from the caller", () => {
    expect(resolveStatusFields({}, { status: "seedling" }).error).toContain("seedling");
  });

  it("inherits a stored status when the caller passes none", () => {
    const result = resolveStatusFields(
      { status: "verified", verified: "2026-08-07" },
      {}
    );
    expect(result).toMatchObject({ status: "verified", verified: "2026-08-07" });
  });

  it("promotes a draft note to verified", () => {
    const result = resolveStatusFields({ status: "draft" }, {
      status: "verified",
      verified: "2026-08-25",
    });
    expect(result).toMatchObject({ status: "verified", verified: "2026-08-25" });
  });

  it("refreshes the date on an already-verified note", () => {
    const result = resolveStatusFields(
      { status: "verified", verified: "2026-08-07" },
      { status: "verified", verified: "2026-08-25" }
    );
    expect(result.verified).toBe("2026-08-25");
  });

  // Demotion has to drop the date, or the pair says "not verified" and "verified on
  // this date" at the same time.
  it("drops the stored date when demoting to draft, and says so", () => {
    const result = resolveStatusFields(
      { status: "verified", verified: "2026-08-07" },
      { status: "draft" }
    );
    expect(result).toMatchObject({ status: "draft" });
    expect(result.verified).toBeUndefined();
    expect(result.notes.join(" ")).toContain("dropped the verified date");
  });

  it("migrates a stored retired status to draft and says so", () => {
    const result = resolveStatusFields({ status: "seedling" }, {});
    expect(result).toMatchObject({ status: "draft" });
    expect(result.notes.join(" ")).toContain("retired scale");
  });

  it("refuses a stored date that contradicts a stored draft status", () => {
    const result = resolveStatusFields(
      { status: "draft", verified: "2026-08-07" },
      {}
    );
    expect(result.error).toContain('only meaningful with status "verified"');
  });
});
