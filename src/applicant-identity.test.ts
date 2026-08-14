import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categorySchemaOf,
} from "./adapter-categories.js";

/**
 * SYS-3166 — applicant-identity, the registry's first NON-DOCUMENT attestor.
 *
 * Every other category is an extraction pipeline reading a document. These are
 * values a person typed about themselves, which is why this category is what
 * finally makes the disagreement surface mean something: a borrower's spelling
 * of their own name competing with an OCR read of their IC.
 *
 * These assertions exist because adding a category was previously INVISIBLE to
 * this suite — the category count, the field set and the attestor sets were all
 * unasserted, so a fourteenth category could appear, or an existing one could
 * silently stop attesting a shared fact, with 586 tests still green. For a
 * vocabulary published to public npm, that is the wrong amount of coverage.
 */
describe("applicant-identity (SYS-3166)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-identity");
    const schema = categorySchemaOf("applicant-identity");
    expect(schema.canonicalTable).toBe("ihs_alt_data_applicant_identity");
  });

  it("declares exactly the four facts that are comparable across sources", () => {
    const names = categorySchemaOf("applicant-identity")
      .fields.map((f) => f.name)
      .sort();
    expect(names).toEqual([
      "personDateOfBirth",
      "personIdNumber",
      "personName",
      "personNationality",
    ]);
  });

  it("every field is an attestation — none is declared without a fact", () => {
    // A field here without a `fact` would be a private column wearing a shared
    // name: it would read as identity data and compare with nothing.
    for (const field of categorySchemaOf("applicant-identity").fields) {
      expect(field.fact, `${field.name} must declare a fact`).toBe(field.name);
    }
  });

  it("joins the existing attestors of each fact rather than replacing them", () => {
    // Asserted as exact sets. A count would pass while the wrong category
    // dropped out, and the identity of an attestor is the whole point — "who
    // says so" is what a disagreement is between.
    expect([...categoriesAttestingFact("personName")].sort()).toEqual([
      "applicant-identity",
      "epf-statement",
      "finxtract-bank-statement",
      "payslip",
      "person-identity",
    ]);
    expect([...categoriesAttestingFact("personIdNumber")].sort()).toEqual([
      "applicant-identity",
      "epf-statement",
      "person-identity",
    ]);
    expect([...categoriesAttestingFact("personDateOfBirth")].sort()).toEqual([
      "applicant-identity",
      "person-identity",
    ]);
    expect([...categoriesAttestingFact("personNationality")].sort()).toEqual([
      "applicant-identity",
      "person-identity",
    ]);
  });

  it("does NOT co-attest gender or race — they are not comparable values", () => {
    // Deliberate, and the reason belongs next to the assertion or someone will
    // "complete" the category later and think they are fixing an omission.
    //
    // The live forms collect gender and race as DROPDOWNS carrying codes — "M",
    // "01" — while person-identity attests whatever is printed on the card, as
    // free text off an OCR read. Same concept, two vocabularies.
    //
    // NOT a missing code-to-label mapping: this package already ships one in
    // BASE_FIELD_SPECS ("M" -> Male, "01" -> Malaysian - Chinese). Two narrower
    // things block it.
    //
    //   1. Shared facts must agree on `kind`, and person-identity declares
    //      these as free strings because OCR text is not a closed set. So
    //      declaring the form side `kind: "enum"` throws, and declaring it a
    //      free string would be false about a dropdown. The registry enforces
    //      the first; nothing enforces the second, which is why this test is
    //      the only thing standing between here and a wrong declaration.
    //
    //   2. Even after resolving the code, "Male" has to be compared against
    //      what the card actually prints — Malay, on a MyKad. That is a second
    //      mapping and it does not exist.
    //
    // Until both are settled a comparison would report disagreement on every
    // row and teach everyone to ignore the surface, which is the failure this
    // phase exists to avoid.
    expect(categoriesAttestingFact("personGender")).toEqual(["person-identity"]);
    expect(categoriesAttestingFact("personRace")).toEqual(["person-identity"]);
  });
});
