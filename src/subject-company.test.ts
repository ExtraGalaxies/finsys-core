import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categorySchemaOf,
} from "./adapter-categories.js";

/**
 * SYS-3359 — subject-company.
 *
 * This category was declared once before and dropped, on a measurement that
 * said no live form collects any of its six columns. Three of them are
 * collected; the measurement queried FinHub's `form_configs` table alone, and
 * those three arrive from the lead-gen SPAs, whose configs are compiled into
 * the SPA bundle rather than stored as rows.
 *
 * So the tests below pin the SHAPE that mistake produced: three fields and not
 * six, each named apart from company-profile's document-attested equivalent,
 * and none of them sharing a fact across that line. Every one of these would
 * have been green under the wrong measurement too — what they actually guard
 * is the next person's assumption, so each says which assumption.
 */
describe("subject-company (SYS-3359)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("subject-company");
    expect(categorySchemaOf("subject-company").canonicalTable).toBe(
      "ihs_alt_data_subject_company",
    );
  });

  it("declares exactly the three fields a live form can feed", () => {
    const names = categorySchemaOf("subject-company").fields.map((f) => f.name);
    expect(names.sort()).toEqual([
      "businessNatureCode",
      "companySizeCode",
      "entityTypeCode",
    ]);
  });

  /**
   * The negative half, and the one worth keeping. companyBackground,
   * noOfEmployees and companyWebsite are non-null on 0 of the sim's 4,622 ihs
   * rows and appear on no live form in either population. A field here could
   * only ever mint an APPLICANT attestation for a value no applicant gave —
   * which is worse than the column staying wide-table-only, because it would
   * carry provenance saying somebody said it.
   */
  it("declares NO field for the three columns nothing collects", () => {
    const names = categorySchemaOf("subject-company").fields.map((f) => f.name);
    for (const absent of ["companyBackground", "noOfEmployees", "companyWebsite"]) {
      expect(names).not.toContain(absent);
    }
  });

  /**
   * The registry refuses one field name across two categories unless both
   * attest the same fact, so entityTypeCode vs company-profile's
   * companyEntityType is enforced. businessNatureCode vs businessNature is
   * NOT — the spellings differ, so nothing would have complained. That is the
   * one this test exists for: a distinction resting on an accident is a
   * distinction that disappears the first time someone tidies a name.
   */
  it("shares no fact with company-profile — a form code is not an OCR read", () => {
    const fields = categorySchemaOf("subject-company").fields;
    for (const f of fields) {
      expect(
        (f as { fact?: string }).fact,
        `${f.name} must declare no fact: it is a per-form dropdown code, and ` +
          `company-profile's equivalent is read off an SSM document. The two ` +
          `vocabularies have never been mapped.`,
      ).toBeUndefined();
    }
    // And nothing else has quietly started attesting them.
    for (const name of ["entityTypeCode", "companySizeCode", "businessNatureCode"]) {
      expect([...categoriesAttestingFact(name)]).toEqual([]);
    }
  });

  /**
   * kind "enum" promises a CLOSED label set and obliges every producing
   * adapter to enumerate what it emits. The only producer here is a lead-gen
   * SPA whose form config ships from a separate repo, so the promise could go
   * false on a release this registry never sees.
   */
  it("declares no enum kind — the choice set is not this registry's to promise", () => {
    for (const f of categorySchemaOf("subject-company").fields) {
      expect((f as { kind?: string }).kind).not.toBe("enum");
      expect(f.type).toBe("string");
    }
  });
});
