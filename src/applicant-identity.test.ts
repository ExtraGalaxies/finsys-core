import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categoryForField,
  categorySchemaOf,
} from "./adapter-categories.js";
import type { CanonicalFieldName } from "./adapter-categories.js";
import { validateCanonicalFields } from "./canonical-validation.js";

/**
 * The published name of applicant-identity's id-type qualifier (SYS-3874).
 * The one literal in the suite: everything else finds the field as the
 * category's only fact-less field, so a rename is the registry entry, this
 * pin, and a regenerate.
 */
const ID_TYPE_FIELD = "personIdTypeCode";
const idTypeSpec = () => categorySchemaOf("applicant-identity").fields.find((f) => f.name === ID_TYPE_FIELD);

/**
 * applicant-identity, the registry's first NON-DOCUMENT attestor.
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

  it("declares exactly the four facts that are comparable across sources, and the id-type qualifier", () => {
    const names = categorySchemaOf("applicant-identity")
      .fields.map((f) => f.name)
      .sort();
    expect(names).toEqual(
      ["personDateOfBirth", "personIdNumber", ID_TYPE_FIELD, "personName", "personNationality"].sort(),
    );
  });

  it("every field but the id-type qualifier is an attestation", () => {
    // A field here without a `fact` would be a private column wearing a shared
    // name: it would read as identity data and compare with nothing. There is
    // exactly one exception, the id-type qualifier: it qualifies personIdNumber
    // and has nothing to agree with (SYS-3874, below). The generator and the
    // other suites find the qualifier by this property, so it must stay unique.
    const factless = categorySchemaOf("applicant-identity")
      .fields.filter((f) => f.fact === undefined)
      .map((f) => f.name);
    expect(factless).toEqual([ID_TYPE_FIELD]);
    for (const field of categorySchemaOf("applicant-identity").fields) {
      if (field.name === ID_TYPE_FIELD) continue;
      expect(field.fact, `${field.name} must declare a fact`).toBe(field.name);
    }
  });

  it("SYS-3874: the id-type qualifier is a free string with no fact and no enum", () => {
    // It says which identification scheme personIdNumber is from, as the
    // intake form codes it. No `kind: "enum"`: a form config carries its own
    // choices, so a form-intake adapter cannot enumerate a closed set (the
    // reasoning recorded on genderCode, raceCode and relatedPersonIdType).
    // No `fact`: no other category declares an id type for the applicant —
    // person-identity has none, and related-person's is a third party's.
    const field = idTypeSpec();
    expect(field, `${ID_TYPE_FIELD} must be declared`).toBeDefined();
    expect(field!.type).toBe("string");
    expect(field!.kind).toBeUndefined();
    expect(field!.valueLabels).toBeUndefined();
    expect(field!.fact).toBeUndefined();
    expect(field!.legacyName).toBeUndefined();
    expect(field!.description).toMatch(/personIdNumber/);
    // Uniquely declared, so a bare name resolves to this category.
    expect(categoryForField(ID_TYPE_FIELD as CanonicalFieldName)).toBe("applicant-identity");
    expect(categoriesAttestingFact(ID_TYPE_FIELD)).toEqual([]);
  });

  it("SYS-3874: the id-type qualifier is at most 50 characters, the width of the column that stores it", () => {
    // The host's column is varchar(50). Without the declaration the 256
    // default applies, and a 51..256-character value would pass this
    // validator and then fail the whole identity row at the database.
    expect(idTypeSpec()!.maxLength).toBe(50);
    const rules = (value: string) =>
      validateCanonicalFields("applicant-identity", { [ID_TYPE_FIELD]: value }, { enumMembership: "skip" })
        .violations.map((v) => v.rule);
    expect(rules("M".repeat(50))).toEqual([]);
    expect(rules("M".repeat(51))).toContain("max-length");
    expect(rules("MK")).toEqual([]);
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
    // NOT simply a missing code-to-label mapping. BASE_FIELD_SPECS seeds one
    // ("M" -> Male, "01" -> Malaysian - Chinese), but it is a DEFAULT, not an
    // authority: a form config may override and extend those choices, and 30 of
    // the 60 live forms carry choices that differ from the base spec. So the
    // mapping that applies to a value is the one on the form that captured it —
    // a per-attestation lookup, not a constant. Three things block it.
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
