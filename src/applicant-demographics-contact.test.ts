import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categorySchemaOf,
} from "./adapter-categories.js";

/**
 * SYS-3338 — applicant-demographics and applicant-contact, the two categories
 * that finish the applicant-typed identity set alongside applicant-identity
 * (SYS-3166).
 *
 * The scope was chosen against the 60 live form configs rather than against
 * the column list: all 8 demographic columns are collected by a typed input on
 * a live form, while 7 of the 13 contact columns (every AreaCode, the three
 * international ones, the unqualified phoneNumber) are collected by NO form.
 * The CATEGORY still models them, because a category describes the domain; the
 * MANIFEST maps only what a form actually asks.
 *
 * Most of what follows pins deliberate ABSENCES. A field that silently starts
 * sharing a fact is the failure this file exists to catch, and it is invisible
 * to every other test in the suite.
 */
describe("applicant-demographics (SYS-3338)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-demographics");
    expect(categorySchemaOf("applicant-demographics").canonicalTable).toBe(
      "ihs_alt_data_applicant_demographics",
    );
  });

  it("declares exactly the eight columns a live form collects", () => {
    const names = categorySchemaOf("applicant-demographics")
      .fields.map((f) => f.name)
      .sort();
    expect(names).toEqual([
      "dependantsCount",
      "educationLevel",
      "genderCode",
      "maritalStatus",
      "preferredLanguage",
      "raceCode",
      "residenceType",
      "statedAge",
    ]);
  });

  /**
   * The load-bearing one. person-identity attests personGender and personRace
   * as OCR TEXT off a MyKad; a form emits a dropdown CODE whose meaning is
   * per-form (30 of 60 live configs override the base choice set). Declaring
   * them one fact would seat "M" against "LELAKI" in the disagreement surface
   * as a permanent false positive, on one of its highest-volume fields.
   *
   * Two independent things have to stay true for that to hold, so both are
   * asserted: the demographic fields must carry no fact, AND they must not be
   * NAMED the same as the person-identity fields — a field name is bound to
   * one fact registry-wide, so sharing the name would drag the fact along.
   */
  it("does NOT co-attest gender or race with the identity document", () => {
    const fields = categorySchemaOf("applicant-demographics").fields;
    const gender = fields.find((f) => f.name === "genderCode");
    const race = fields.find((f) => f.name === "raceCode");
    expect(gender?.fact).toBeUndefined();
    expect(race?.fact).toBeUndefined();

    // The document side still attests them, alone.
    expect(categoriesAttestingFact("personGender")).toEqual(["person-identity"]);
    expect(categoriesAttestingFact("personRace")).toEqual(["person-identity"]);

    // And no demographic field reuses a person-identity field name.
    const identityNames = new Set(categorySchemaOf("person-identity").fields.map((f) => f.name));
    expect(fields.filter((f) => identityNames.has(f.name))).toEqual([]);
  });

  it("does not reconcile a stated age against a date of birth", () => {
    // An age is true only on the day it was given. Sharing personDateOfBirth's
    // fact would invite a comparison that is wrong for half of every year.
    const age = categorySchemaOf("applicant-demographics").fields.find(
      (f) => f.name === "statedAge",
    );
    expect(age?.fact).toBeUndefined();
    expect(age?.type).toBe("string");
    expect(categoriesAttestingFact("personDateOfBirth")).not.toContain("applicant-demographics");
  });

  it("leaves the dropdown fields kind-less and gives the count a unit", () => {
    const by = new Map(
      categorySchemaOf("applicant-demographics").fields.map((f) => [f.name, f] as const),
    );
    // NOT enum-kind. That promises a closed label set, and the host makes the
    // producing adapter enumerate it — which a form-intake adapter spanning 60
    // heterogeneous forms cannot do, since each defines its own choices. The
    // host refused both adapters until this was corrected; the refusal was
    // right and the category declaration was the overclaim.
    for (const n of [
      "genderCode",
      "raceCode",
      "maritalStatus",
      "educationLevel",
      "preferredLanguage",
      "residenceType",
    ]) {
      expect(by.get(n)?.kind).toBeUndefined();
    }
    expect(by.get("dependantsCount")?.type).toBe("number");
    expect(by.get("dependantsCount")?.unit).toBe("count");
  });

  it("resolves every field to sensitive, because none opts out", () => {
    // Absent means sensitive (SYS-3164), and categorySchemaOf resolves the
    // absence to the literal "sensitive" rather than leaving it undefined —
    // so this asserts the OUTCOME, which is what consumers act on, not the
    // spelling in the data file. Demographics is uniformly sensitive: race,
    // gender, marital status, dependants. An opt-out appearing here later is
    // exactly what this catches.
    for (const f of categorySchemaOf("applicant-demographics").fields) {
      expect(f.confidentiality).toBe("sensitive");
    }
  });
});

describe("applicant-contact (SYS-3338)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-contact");
    expect(categorySchemaOf("applicant-contact").canonicalTable).toBe(
      "ihs_alt_data_applicant_contact",
    );
  });

  it("collapses five flattened phone families into one contact-point shape", () => {
    const names = categorySchemaOf("applicant-contact")
      .fields.map((f) => f.name)
      .sort();
    expect(names).toEqual([
      "contactAreaCode",
      "contactExtension",
      "contactName",
      "contactRelationship",
      "contactValue",
    ]);
  });

  /**
   * contactName is the name of an EMERGENCY CONTACT — a third party. Attesting
   * it as personName would say the applicant is their own next of kin, which
   * is a genuine identity error rather than a formatting one, and it would
   * reach the disagreement surface as a real-looking conflict on every
   * application that fills the field.
   */
  it("does NOT attest a third party's name as the subject's", () => {
    const name = categorySchemaOf("applicant-contact").fields.find((f) => f.name === "contactName");
    expect(name?.fact).toBeUndefined();
    expect(categoriesAttestingFact("personName")).not.toContain("applicant-contact");
  });

  it("declares no shared facts at all — a contact point is not a cross-source claim", () => {
    for (const f of categorySchemaOf("applicant-contact").fields) {
      expect(f.fact).toBeUndefined();
    }
  });
});
