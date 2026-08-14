import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categorySchemaOf,
} from "./adapter-categories.js";

/** One field of a category schema — the map lookups below are keyed on plain
 * strings, so the Map has to be widened off the literal union. */
type CategoryField = ReturnType<typeof categorySchemaOf>["fields"][number];

/**
 * SYS-3337 — applicant-employment and applicant-income.
 *
 * These are the first applicant-typed categories that genuinely SHARE facts
 * with a document category. applicant-identity shares with the IC, but only
 * because SYS-3333 had already de-prefixed it; here the pairing is the point
 * of the ticket: a borrower's stated employer and stated income competing with
 * what their payslip says is the highest-value comparison the disagreement
 * surface will see on this data.
 *
 * subject-company is deliberately NOT in this file. The ticket scopes it
 * alongside these two, but all six of its columns are collected by no live
 * form, so a form-intake adapter over them could only ever attest values the
 * applicant never gave.
 */
describe("applicant-employment (SYS-3337)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-employment");
    expect(categorySchemaOf("applicant-employment").canonicalTable).toBe(
      "ihs_alt_data_applicant_employment",
    );
  });

  it("declares the ten employment columns", () => {
    expect(
      categorySchemaOf("applicant-employment")
        .fields.map((f) => f.name)
        .sort(),
    ).toEqual([
      "businessSector",
      "dateJoined",
      "employerName",
      "employmentSector",
      "employmentStatus",
      "employmentType",
      "lengthOfServiceMonths",
      "lengthOfServiceYears",
      "occupation",
      "subEmploymentSector",
    ]);
  });

  /**
   * The pairing this ticket exists for. The payslip attests employerName from
   * the document side — SYS-3333 de-prefixed it from payslipEmployerName,
   * which is precisely the dependency the ticket was blocked on.
   */
  it("co-attests employerName with the payslip", () => {
    const f = categorySchemaOf("applicant-employment").fields.find(
      (x) => x.name === "employerName",
    );
    expect(f?.fact).toBe("employerName");
    expect([...categoriesAttestingFact("employerName")].sort()).toEqual([
      "applicant-employment",
      "payslip",
    ]);
  });

  it("keeps length of service as two figures, each with its own unit", () => {
    const by = new Map<string, CategoryField>(
      categorySchemaOf("applicant-employment").fields.map((f) => [f.name, f] as const),
    );
    expect(by.get("lengthOfServiceYears")?.unit).toBe("years");
    expect(by.get("lengthOfServiceMonths")?.unit).toBe("months");
  });

  it("declares no enum kind on any selected field", () => {
    // The six forms collecting these share one choice set each TODAY —
    // measured — but a form config can add a choice without the manifest
    // knowing, and kind "enum" makes each producing adapter enumerate what it
    // emits. The closure is not the category's to promise.
    const by = new Map<string, CategoryField>(
      categorySchemaOf("applicant-employment").fields.map((f) => [f.name, f] as const),
    );
    for (const n of [
      "employmentStatus",
      "employmentType",
      "occupation",
      "employmentSector",
      "subEmploymentSector",
    ]) {
      expect(by.get(n)?.kind).toBeUndefined();
    }
  });
});

describe("applicant-income (SYS-3337)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-income");
    expect(categorySchemaOf("applicant-income").canonicalTable).toBe(
      "ihs_alt_data_applicant_income",
    );
  });

  /**
   * grossPay and netPay are money AND shared with the payslip, which makes
   * three separate contracts land on one field. All three are asserted,
   * because the failure modes are different and independent:
   *
   *   - the fact makes it comparable across sources
   *   - kind "money" makes it denominated, so it renders with a currency
   *   - legacyName keeps isMonetaryField answering to the FLAT column name,
   *     which is the whole reason SYS-3333 added the alias
   */
  it("co-attests grossPay and netPay with the payslip, as money, without losing the flat name", () => {
    const by = new Map(categorySchemaOf("applicant-income").fields.map((f) => [f.name, f] as const));

    for (const [canonical, flat] of [
      ["grossPay", "monthlyGrossIncome"],
      ["netPay", "monthlyNetIncome"],
    ] as const) {
      const f = by.get(canonical);
      expect(f?.fact, `${canonical} fact`).toBe(canonical);
      expect(f?.kind, `${canonical} kind`).toBe("money");
      expect(f?.type, `${canonical} type`).toBe("number");
      // Money carries no unit and no range — the denomination travels on the
      // observation, not the field.
      expect(f?.unit, `${canonical} unit`).toBeUndefined();
      expect(f?.legacyName, `${canonical} legacyName`).toBe(flat);
    }

    expect([...categoriesAttestingFact("grossPay")].sort()).toEqual(["applicant-income", "payslip"]);
    expect([...categoriesAttestingFact("netPay")].sort()).toEqual(["applicant-income", "payslip"]);
  });

  it("is single-instance material — no field describes one job", () => {
    // Unlike employment, these describe the person overall. The assertion is
    // indirect but real: nothing here is employer- or job-scoped, so a second
    // job does not imply a second income row.
    const names = categorySchemaOf("applicant-income").fields.map((f) => f.name);
    expect(names.filter((n) => /employer|job|occupation/i.test(n))).toEqual([]);
  });
});
