import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categorySchemaOf,
  resolveCanonicalFieldName,
} from "./adapter-categories.js";

/**
 * SYS-3339 — applicant-collateral, applicant-obligations, related-person.
 *
 * Three categories, ONE shipped manifest between them, and the asymmetry is
 * the thing these tests exist to hold still. The measurement behind it, taken
 * 2026-08-15 against BOTH live form-spec populations plus the sim's `ihs`:
 *
 *   applicant-collateral    3 of 11 columns collected by a live form
 *   applicant-obligations   0 of 5
 *   related-person          0 of 8
 *
 * "BOTH populations" is load-bearing and is the trap this phase already fell
 * into once. FinHub's `form_configs` table (60 rows) is what every earlier
 * Phase 2.6 measurement used, and it CANNOT see the four lead-gen SPAs
 * (fincap-sme, fincap-daas, finhero-sme, finhero-auto), whose form specs are
 * compiled into the SPA bundle. `modelOfVehicle` appears in zero of the 60
 * form_configs and in the finhero-auto bundle — measuring form_configs alone
 * reports it as collected by nobody while 8 rows of it sit in `ihs`.
 */

function field(category: string, name: string) {
  const f = categorySchemaOf(category as never).fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name} on ${category}`);
  return f;
}

function names(category: string): string[] {
  return categorySchemaOf(category as never)
    .fields.map((f) => f.name)
    .sort();
}

describe("applicant-collateral (SYS-3339)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-collateral");
    expect(categorySchemaOf("applicant-collateral").canonicalTable).toBe(
      "ihs_alt_data_applicant_collateral",
    );
  });

  it("declares all eleven COLLATERAL_FIELDS of the lender Open API, named for the vehicle", () => {
    // Equality, not containment. The lender Open API's `collateral[0]` block
    // accepts exactly these eleven attributes (finsys-api
    // src/utils/ihsFieldDefs.ts, COLLATERAL_FIELDS), so a category declaring
    // TEN would silently drop a field a lender is already permitted to send.
    expect(names("applicant-collateral")).toEqual([
      "collateralMarketValue",
      "collateralPurchasePriceOnTheRoad",
      "vehicleChassisNo",
      "vehicleConditionCode",
      "vehicleEngineNo",
      "vehicleLadenWeightOver2500kg",
      "vehicleMake",
      "vehicleModel",
      "vehicleRegistrationDate",
      "vehicleRegistrationNo",
      "vehicleYearMake",
    ]);
  });

  it("bridges back to all eleven flat column names", () => {
    // The legacyName map is what lets code holding a FLAT column name reach
    // the canonical spec — isMonetaryField being the worked example. Asserted
    // per column rather than by count, because a count passes while a script
    // drops ten and adds ten wrong ones.
    const expected: Record<string, string> = {
      makeOfVehicle: "vehicleMake",
      modelOfVehicle: "vehicleModel",
      yearMake: "vehicleYearMake",
      vehicleCondition: "vehicleConditionCode",
      chassisNo: "vehicleChassisNo",
      engineNo: "vehicleEngineNo",
      registrationNo: "vehicleRegistrationNo",
      registrationDate: "vehicleRegistrationDate",
      bdmMoreThan2500kg: "vehicleLadenWeightOver2500kg",
      marketValue: "collateralMarketValue",
      purchasePriceOTR: "collateralPurchasePriceOnTheRoad",
    };
    for (const [flat, canonical] of Object.entries(expected)) {
      expect(resolveCanonicalFieldName(flat), `${flat} must bridge to ${canonical}`).toBe(canonical);
    }
  });

  it("keeps the dropdown code apart from any future document reading, and refuses enum", () => {
    // The genderCode / raceCode precedent. vehicleCondition is a per-form
    // dropdown emitting 'N' / 'U' / 'UN' / 'UR' / 'PR'; a JPJ card or a
    // valuation report would attest printed prose. Naming them one fact puts
    // a permanent false positive into the disagreement surface.
    expect(field("applicant-collateral", "vehicleConditionCode").name).toMatch(/Code$/);
    expect(field("applicant-collateral", "vehicleConditionCode").fact).toBeUndefined();
    // kind "enum" promises a CLOSED label set and obliges every producing
    // adapter to enumerate its labels. A form config carries its OWN choices
    // and a lender can add a sixth condition tomorrow, so the promise would go
    // quietly false. That the seven live forms agree today is exactly the kind
    // of measurement that expires.
    expect(field("applicant-collateral", "vehicleConditionCode").kind).toBeUndefined();
  });

  it("declares the two money fields as money, with neither unit nor range", () => {
    for (const name of ["collateralMarketValue", "collateralPurchasePriceOnTheRoad"]) {
      const f = field("applicant-collateral", name);
      expect(f.kind, `${name} kind`).toBe("money");
      expect(f.type, `${name} type`).toBe("number");
      expect(f.unit, `${name} unit`).toBeUndefined();
      expect(f.range, `${name} range`).toBeUndefined();
    }
  });

  it("bounds the model year wider than any one form, and calls it a count not a duration", () => {
    const f = field("applicant-collateral", "vehicleYearMake");
    expect(f.type).toBe("number");
    // The v2 authoring catalog bounds yearMake [2014, 2100] per form. A
    // CATEGORY bound must hold for every lender, including a used-vehicle
    // programme accepting a 1998 model, so it is deliberately wider.
    expect(f.range).toEqual([1900, 2100]);
    expect(f.range![0]).toBeLessThan(2014);
    // `years` would read as a duration and be wrong by about two thousand.
    expect(f.unit).toBe("count");
  });

  it("keeps the laden-weight flag a string, because the column and the form input are text", () => {
    // Boolean-SHAPED but not boolean-TYPED. ihs.bdmMoreThan2500kg is
    // varchar(10) and the v2 catalog authors it as free text, so 'Y' / 'N' /
    // 'Yes' all arrive. Declaring boolean asserts a coercion nobody performs,
    // and its failure mode is silent — a truthiness test reads 'N' as true.
    expect(field("applicant-collateral", "vehicleLadenWeightOver2500kg").type).toBe("string");
  });

  it("keeps the registration date a string, matching an unnormalized varchar source", () => {
    expect(field("applicant-collateral", "vehicleRegistrationDate").type).toBe("string");
  });

  it("co-attests nothing — no vehicle fact has a second source yet", () => {
    for (const f of categorySchemaOf("applicant-collateral").fields) {
      expect(f.fact, `${f.name} must not claim a shared fact`).toBeUndefined();
    }
  });
});

describe("applicant-obligations (SYS-3339)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-obligations");
    expect(categorySchemaOf("applicant-obligations").canonicalTable).toBe(
      "ihs_alt_data_applicant_obligations",
    );
  });

  it("collapses five fixed columns into two fields — the flattening this phase exists to undo", () => {
    // THE assertion of this category. The wide table spends one column on
    // each of five FIXED obligation kinds, so an applicant with a sixth
    // commitment has nowhere to put it and the DSR is computed from an amount
    // that is knowably incomplete. Two fields plus an instance key make the
    // sixth a row.
    expect(names("applicant-obligations")).toEqual([
      "obligationMonthlyInstallment",
      "obligationType",
    ]);
    // And no field may be named after one of the five kinds — that would
    // re-encode the limit into the model, where it would be permanent.
    for (const n of names("applicant-obligations")) {
      expect(n, `${n} must not name a specific obligation kind`).not.toMatch(
        /housing|hirePurchase|personal|creditCard|otherFinancing/i,
      );
    }
  });

  it("declares NO legacyName on either field, and the reason differs per field", () => {
    // obligationMonthlyInstallment: five flat columns collapse into it, so a
    // legacyName would be right about one and a lie about four. A legacyName
    // is a one-to-one rename and this is a per-instance function.
    expect(field("applicant-obligations", "obligationMonthlyInstallment").legacyName).toBeUndefined();
    // obligationType: there is no flat column at all. In the flat shape the
    // kind was not stored — it was encoded in WHICH column held a number.
    expect(field("applicant-obligations", "obligationType").legacyName).toBeUndefined();
    // Consequence, stated rather than assumed: none of the five flat spellings
    // resolves to anything. Code holding one is on its own until a manifest
    // ships, which is honest, and is why this is asserted rather than left to
    // be discovered.
    for (const flat of [
      "housingLoanMonthlyInstallment",
      "hirePurchaseMonthlyInstallment",
      "personalLoanMonthlyInstallment",
      "creditCardMonthlyInstallment",
      "otherFinancingMonthlyInstallment",
    ]) {
      expect(resolveCanonicalFieldName(flat), `${flat} must not resolve`).toBeNull();
    }
  });

  it("refuses enum on obligationType — the closed set is exactly what proved too small", () => {
    expect(field("applicant-obligations", "obligationType").kind).toBeUndefined();
  });

  it("declares the installment as money", () => {
    const f = field("applicant-obligations", "obligationMonthlyInstallment");
    expect(f.kind).toBe("money");
    expect(f.type).toBe("number");
  });
});

describe("related-person (SYS-3339)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("related-person");
    expect(categorySchemaOf("related-person").canonicalTable).toBe("ihs_alt_data_related_person");
  });

  it("models a person with a role — identity facts a contact POINT cannot carry", () => {
    expect(names("related-person")).toEqual([
      "relatedPersonDateOfBirth",
      "relatedPersonEmail",
      "relatedPersonIdNumber",
      "relatedPersonIdType",
      "relatedPersonName",
      "relatedPersonPhone",
      "relatedPersonPhoneAreaCode",
      "relatedPersonRole",
    ]);
    // The line against applicant-contact, which is the nearest neighbour:
    // it models a CHANNEL and carries contactName / contactRelationship so an
    // emergency contact's channel can say whose it is. It has no id number, no
    // id type and no date of birth, and should not — a contact point carrying
    // identity facts would be two things at once.
    const contact = names("applicant-contact");
    for (const n of ["relatedPersonIdNumber", "relatedPersonIdType", "relatedPersonDateOfBirth"]) {
      expect(contact, `${n} has no applicant-contact equivalent`).not.toContain(n);
    }
    expect(contact).toContain("contactName");
    expect(contact).not.toContain("contactIdNumber");
  });

  it("never co-attests the SUBJECT's identity — a third party's name is not the applicant's", () => {
    // The applicant-contact contactName call, applied to a whole category.
    // A shared fact means two sources describing ONE real-world thing; these
    // are two different people, so a shared fact would file a genuine identity
    // error as a formatting disagreement.
    for (const f of categorySchemaOf("related-person").fields) {
      expect(f.fact, `${f.name} must not claim a shared fact`).toBeUndefined();
    }
    for (const fact of ["personName", "personIdNumber", "personDateOfBirth"]) {
      expect(categoriesAttestingFact(fact)).not.toContain("related-person");
    }
    // Positive control: the probe is reading a registry where shared facts
    // really do exist, so "not contained" cannot pass by reading nothing.
    expect(categoriesAttestingFact("personName").length).toBeGreaterThan(1);
  });

  it("bridges back to all eight contactPerson* flat columns", () => {
    const expected: Record<string, string> = {
      contactPersonName: "relatedPersonName",
      contactPersonIdNo: "relatedPersonIdNumber",
      contactPersonIdType: "relatedPersonIdType",
      contactPersonDateOfBirth: "relatedPersonDateOfBirth",
      contactPersonPosition: "relatedPersonRole",
      contactPersonEmail: "relatedPersonEmail",
      contactPersonPhoneNo: "relatedPersonPhone",
      contactPersonPhoneNoAreaCode: "relatedPersonPhoneAreaCode",
    };
    for (const [flat, canonical] of Object.entries(expected)) {
      expect(resolveCanonicalFieldName(flat), `${flat} must bridge to ${canonical}`).toBe(canonical);
    }
  });

  it("refuses enum on the two free-vocabulary fields", () => {
    // No adapter exists to consult for labels, and the values arrive through
    // the lender Open API from a caller whose vocabulary is its own.
    expect(field("related-person", "relatedPersonIdType").kind).toBeUndefined();
    expect(field("related-person", "relatedPersonRole").kind).toBeUndefined();
  });
});

describe("all three categories, together", () => {
  it("resolve every field to sensitive, because none opts out", () => {
    for (const id of ["applicant-collateral", "applicant-obligations", "related-person"]) {
      for (const f of categorySchemaOf(id as never).fields) {
        expect(f.confidentiality, `${id}.${f.name}`).toBe("sensitive");
      }
    }
  });

  it("keep the SSM person blobs where they are — the open call, recorded", () => {
    // SYS-3339 carried an open call: company-profile's `directors`,
    // `shareholders` and `previousDirectors` are JSON blobs of people with
    // roles, and no category covers their contents. Decided NO for this
    // ticket, on three grounds that are measurements rather than preferences:
    //
    //  1. THE SUBJECT DIFFERS. related-person's role is against an
    //     APPLICATION (a named contact, a guarantor). The SSM blobs describe
    //     the officers of a COMPANY, attested by a document about that
    //     company. Fusing them would make one instance key mean two
    //     unrelated things.
    //  2. THE SHAPES DIFFER, so "the same shape" — the premise the open call
    //     offered — does not survive reading the extractor. finsys-api's
    //     ihsService builds directors from officer-name /
    //     officer-ic-passport-number / officer-address / officer-designation
    //     / nationality, and shareholders from shareholder-name /
    //     shareholder-ic-passport-number / AMOUNT-OF-SHARES-HELD. A
    //     shareholding percentage is a property of the RELATIONSHIP, not of
    //     the person, and related-person has nowhere to put it. A corporate
    //     shareholder is not a person at all.
    //  3. NOTHING WOULD EXERCISE IT. All three blob columns are 0-populated
    //     in the sim (0 of 4,629 `ihs` rows, 0 of 329 ihs_alt_data_ssm rows,
    //     measured 2026-08-15), so canonicalising them here would ship a
    //     model no test could run.
    //
    // The blobs therefore stay declared on company-profile as opaque strings.
    // This assertion is the record: it fails the day someone canonicalises
    // them without revisiting the reasoning above.
    const profile = categorySchemaOf("company-profile");
    for (const name of ["directors", "shareholders", "previousDirectors"]) {
      const f = profile.fields.find((x) => x.name === name);
      expect(f, `company-profile must still declare ${name}`).toBeDefined();
      expect(f!.type, `${name} stays an opaque JSON string`).toBe("string");
    }
    expect(names("related-person").some((n) => /director|shareholder/i.test(n))).toBe(false);
  });
});
