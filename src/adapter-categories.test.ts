/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  allCategories,
  assertAdapterCategory,
  buildCategoryRegistry,
  categorySchemaOf,
  categoryFieldsOf,
  categoryForField,
  factOf,
  categoriesAttestingFact,
  resolveCanonicalFieldName,
  isAdapterCategory,
  isFieldSensitive,
  sensitiveFieldsOf,
} from "./adapter-categories.js";

describe("Adapter category catalogue", () => {
  it("declares at least two categories (telco-carrier, payment-network)", () => {
    const cats = allCategories();
    expect(cats.length).toBeGreaterThanOrEqual(2);
    const ids = cats.map((c) => c.id);
    expect(ids).toContain("telco-carrier");
    expect(ids).toContain("payment-network");
  });

  it("every category has at least one canonical field", () => {
    for (const cat of allCategories()) {
      expect(cat.fields.length).toBeGreaterThan(0);
      for (const f of cat.fields) {
        expect(f.name).toMatch(/\S/);
        expect(["number", "boolean", "string"]).toContain(f.type);
        expect(f.description).toMatch(/\S/);
      }
    }
  });

  it("canonical field names are unique across all categories — except shared-fact attestations", () => {
    const seen = new Map<string, { category: string; fact: string | undefined }>();
    for (const cat of allCategories()) {
      for (const f of cat.fields) {
        const prior = seen.get(f.name);
        if (prior) {
          // A shared name is only legal when EVERY declaration carries
          // the SAME fact id (independent attestations of one fact).
          expect(
            prior.fact,
            `duplicate canonical field "${f.name}" across categories without a shared fact: ${prior.category} + ${cat.id}`,
          ).toBeDefined();
          expect(
            f.fact,
            `"${f.name}" (${cat.id}) reuses a name that ${prior.category} declares with fact "${prior.fact}" — it must attest the same fact`,
          ).toBe(prior.fact);
        }
        seen.set(f.name, { category: cat.id, fact: f.fact });
      }
    }
  });

  it("every category declares a distinct canonical storage table", () => {
    const tables = new Set<string>();
    for (const cat of allCategories()) {
      // SYS-2998: the invariant is the IHS namespace prefix — alt-data
      // tables (ihs_alt_data_*) AND promoted legacy sibling tables
      // (ihsbankstatement, ...) are both canonical now.
      expect(cat.canonicalTable).toMatch(/^ihs[a-z0-9_]*$/);
      expect(tables.has(cat.canonicalTable)).toBe(false);
      tables.add(cat.canonicalTable);
    }
  });
});

describe("categorySchemaOf", () => {
  it("returns the schema for a known category", () => {
    const telco = categorySchemaOf("telco-carrier");
    expect(telco.id).toBe("telco-carrier");
    expect(telco.canonicalTable).toBe("ihs_alt_data_telco");
    expect(telco.fields.map((f) => f.name)).toContain(
      "onTimePaymentRatio24m",
    );
  });

  it("throws on unknown category id", () => {
    expect(() =>
      categorySchemaOf("absurd-category-that-does-not-exist"),
    ).toThrow(/Unknown adapter category/);
  });
});

describe("categoryFieldsOf", () => {
  it("returns the canonical field names for telco-carrier", () => {
    const fields = categoryFieldsOf("telco-carrier");
    expect(fields).toContain("onTimePaymentRatio24m");
    expect(fields).toContain("tenureMonths");
    expect(fields).toContain("suspensionsCount24m");
  });

  it("returns a different field set for payment-network", () => {
    const telco = new Set(categoryFieldsOf("telco-carrier"));
    const payments = new Set(categoryFieldsOf("payment-network"));
    // Disjoint — telco fields shouldn't appear in payments.
    for (const f of telco) expect(payments.has(f)).toBe(false);
    for (const f of payments) expect(telco.has(f)).toBe(false);
  });
});

describe("categoryForField", () => {
  it("identifies the producing category for a known telco field", () => {
    expect(categoryForField("onTimePaymentRatio24m")).toBe(
      "telco-carrier",
    );
  });

  it("identifies the producing category for a known payments field", () => {
    expect(categoryForField("monthlyVolume3m")).toBe(
      "payment-network",
    );
  });

  it("returns null for a field not declared by any category", () => {
    expect(categoryForField("clearlyNotACanonicalField")).toBeNull();
  });
});

// ── SYS-2500: extensible registry helpers ────────────────────────────

describe("ADAPTER_CATEGORY_IDS", () => {
  it("lists every category id from allCategories()", () => {
    expect([...ADAPTER_CATEGORY_IDS].sort()).toEqual(
      allCategories()
        .map((c) => c.id)
        .sort(),
    );
  });
});

describe("isAdapterCategory / assertAdapterCategory", () => {
  it("isAdapterCategory is true for declared ids, false otherwise", () => {
    expect(isAdapterCategory("telco-carrier")).toBe(true);
    expect(isAdapterCategory("social-media")).toBe(true);
    expect(isAdapterCategory("fortune-teller")).toBe(false);
    expect(isAdapterCategory("")).toBe(false);
  });

  it("assertAdapterCategory returns the id for a declared category", () => {
    expect(assertAdapterCategory("payment-network")).toBe("payment-network");
  });

  it("assertAdapterCategory throws (listing available ids) for an unknown category", () => {
    expect(() => assertAdapterCategory("fortune-teller")).toThrow(
      /Unknown adapter category.*Available:/,
    );
  });
});

// ── SYS-2500: the social-media category (extensibility demonstrator) ──

describe("social-media category", () => {
  it("is declared with the canonical social table", () => {
    const social = categorySchemaOf("social-media");
    expect(social.canonicalTable).toBe("ihs_alt_data_social_media");
    expect(social.fields.length).toBeGreaterThanOrEqual(8);
  });

  it("declares the expected credit-actionable fields", () => {
    const fields = new Set(categoryFieldsOf("social-media"));
    for (const f of [
      "accountTenureMonths",
      "followerCount",
      "engagementRate90d",
      "postingConsistency12m",
      "verifiedBusinessAccount",
      "customerRatingAvg",
      "negativeSentimentRatio90d",
      "accountFlags24m",
    ]) {
      expect(fields.has(f), `expected social-media field "${f}"`).toBe(true);
    }
  });

  it("maps a social field back to its category", () => {
    expect(categoryForField("engagementRate90d")).toBe("social-media");
  });

  it("carries a boolean field type for the verified-account flag", () => {
    const spec = categorySchemaOf("social-media").fields.find(
      (f) => f.name === "verifiedBusinessAccount",
    );
    expect(spec?.type).toBe("boolean");
  });
});

// ── SYS-2548: the trade-credit category (accounting AR/AP model) ────

describe("trade-credit category", () => {
  it("is declared with the canonical trade-credit table", () => {
    const trade = categorySchemaOf("trade-credit");
    expect(trade.canonicalTable).toBe("ihs_alt_data_trade_credit");
    expect(trade.fields.length).toBeGreaterThanOrEqual(8);
  });

  it("declares the AR/AP + P&L accounting fields", () => {
    const fields = new Set(categoryFieldsOf("trade-credit"));
    for (const f of [
      "arDaysSalesOutstanding",
      "apDaysPayableOutstanding",
      "arTotalOutstanding",
      "arCurrentRatio",
      "arOverdue90PlusRatio",
      "debtorConcentrationTop5Ratio",
      "tradeReferenceDefaults12m",
      "accountingRevenue12m",
      "grossMarginPct",
      "cashConversionCycleDays",
    ]) {
      expect(fields.has(f), `expected trade-credit field "${f}"`).toBe(true);
    }
  });

  it("carries the cross-reference revenue anchor for bank-statement consistency checks", () => {
    // accountingRevenue12m is the self-reported figure the dashboard's
    // consistency tier cross-checks against payment-network + bank inflows.
    expect(categoryForField("accountingRevenue12m")).toBe("trade-credit");
  });

  it("allows a negative lower bound on the cash-conversion cycle", () => {
    const spec = categorySchemaOf("trade-credit").fields.find(
      (f) => f.name === "cashConversionCycleDays",
    );
    expect(spec?.range?.[0]).toBeLessThan(0);
  });

  it("locks the [0,1] range contract on ratio fields", () => {
    for (const name of [
      "arCurrentRatio",
      "arOverdue90PlusRatio",
      "debtorConcentrationTop5Ratio",
      "grossMarginPct",
    ]) {
      const spec = categorySchemaOf("trade-credit").fields.find((f) => f.name === name);
      expect(spec?.range, `range for ${name}`).toEqual([0, 1]);
    }
  });
});

// ── SYS-2500: the loader is genuinely data-driven ────────────────────

type RawArg = Parameters<typeof buildCategoryRegistry>[0];

/** A minimal, valid raw category data object usable as a base for cases. */
function validRaw(): RawArg {
  return {
    schemaVersion: "1.0.0",
    categories: [
      {
        id: "fixture-source",
        displayName: "Fixture Source",
        description: "A category that exists only in this test.",
        canonicalTable: "ihs_alt_data_fixture",
        fields: [
          {
            name: "fixtureScore",
            type: "number",
            unit: "ratio",
            range: [0, 1],
            description: "A test field.",
          },
        ],
      },
    ],
  };
}

describe("buildCategoryRegistry (data-driven loader)", () => {
  it("builds a registry from arbitrary conforming data — including a brand-new category id", () => {
    // Proof that categories are NOT hardcoded: a category id that does
    // not exist anywhere in the package loads and is fully queryable.
    const reg = buildCategoryRegistry(validRaw());
    expect(reg.ids).toEqual(["fixture-source"]);
    expect(reg.byId.get("fixture-source")?.canonicalTable).toBe("ihs_alt_data_fixture");
    expect(reg.fieldToCategory.get("fixtureScore")).toBe("fixture-source");
  });

  it("rejects a missing/empty schemaVersion", () => {
    const raw = validRaw() as unknown as Record<string, unknown>;
    raw.schemaVersion = "";
    expect(() => buildCategoryRegistry(raw as unknown as RawArg)).toThrow(/schemaVersion/);
  });

  it("rejects an empty categories array", () => {
    const raw = validRaw();
    raw.categories = [];
    expect(() => buildCategoryRegistry(raw)).toThrow(/non-empty array/);
  });

  it("rejects a duplicate category id", () => {
    const raw = validRaw();
    raw.categories.push({ ...raw.categories[0], canonicalTable: "ihs_alt_data_other" });
    expect(() => buildCategoryRegistry(raw)).toThrow(/duplicate category id/);
  });

  it("rejects a duplicate canonicalTable", () => {
    const raw = validRaw();
    raw.categories.push({ ...raw.categories[0], id: "fixture-two" });
    expect(() => buildCategoryRegistry(raw)).toThrow(/duplicate canonicalTable/);
  });

  it("rejects a canonicalTable outside the ihs namespace", () => {
    // SYS-2998 widened the invariant from the ihs_alt_data_ naming scheme
    // to the ihs table-namespace prefix (promoted sibling tables like
    // ihsbankstatement are canonical now) — but a table outside the
    // namespace is still refused.
    const raw = validRaw();
    raw.categories[0].canonicalTable = "some_other_table";
    expect(() => buildCategoryRegistry(raw)).toThrow(/"ihs"-prefixed/);
  });

  it("rejects a category with no fields", () => {
    const raw = validRaw();
    raw.categories[0].fields = [];
    expect(() => buildCategoryRegistry(raw)).toThrow(/at least one field/);
  });

  it("rejects a canonical field name reused across categories", () => {
    const raw = validRaw();
    raw.categories.push({
      id: "fixture-two",
      displayName: "Fixture Two",
      description: "Second test category.",
      canonicalTable: "ihs_alt_data_fixture_two",
      fields: [{ name: "fixtureScore", type: "number", description: "Clashes." }],
    });
    expect(() => buildCategoryRegistry(raw)).toThrow(/globally unique/);
  });

  // ── Shared-fact attestations ──────────────────────────────────────────

  function secondCategory(fields: RawArg["categories"][0]["fields"]): RawArg["categories"][0] {
    return {
      id: "fixture-two",
      displayName: "Fixture Two",
      description: "Second test category.",
      canonicalTable: "ihs_alt_data_fixture_two",
      fields,
    };
  }

  it("accepts the same field name across categories when every declaration attests the same fact", () => {
    const raw = validRaw();
    raw.categories[0].fields.push({
      name: "sharedThing",
      type: "string",
      fact: "sharedThing",
      description: "First attestation.",
    });
    raw.categories.push(
      secondCategory([
        { name: "sharedThing", type: "string", fact: "sharedThing", description: "Second attestation." },
        { name: "fixtureTwoOwn", type: "string", description: "Unique to fixture-two." },
      ]),
    );
    const reg = buildCategoryRegistry(raw);
    // Shared name → no single owning category in the reverse index.
    expect(reg.fieldToCategory.has("sharedThing")).toBe(false);
    // Unique names keep their owner.
    expect(reg.fieldToCategory.get("fixtureScore")).toBe("fixture-source");
    expect(reg.fieldToCategory.get("fixtureTwoOwn")).toBe("fixture-two");
    // Fact indexes carry the attestation graph.
    expect(reg.fieldToFact.get("sharedThing")).toBe("sharedThing");
    expect(reg.factToCategories.get("sharedThing")).toEqual(["fixture-source", "fixture-two"]);
  });

  it("rejects the same field name with DIFFERENT facts", () => {
    const raw = validRaw();
    raw.categories[0].fields.push({
      name: "sharedThing",
      type: "string",
      fact: "factA",
      description: "First attestation.",
    });
    raw.categories.push(
      secondCategory([
        { name: "sharedThing", type: "string", fact: "factB", description: "Mismatched attestation." },
      ]),
    );
    expect(() => buildCategoryRegistry(raw)).toThrow(/attests the same fact/);
  });

  it("rejects the same field name declared with a fact in one category and without in another (both orders)", () => {
    for (const [firstFact, secondFact] of [
      ["theFact", undefined],
      [undefined, "theFact"],
    ] as Array<[string | undefined, string | undefined]>) {
      const raw = validRaw();
      raw.categories[0].fields.push({
        name: "sharedThing",
        type: "string",
        ...(firstFact !== undefined ? { fact: firstFact } : {}),
        description: "First declaration.",
      });
      raw.categories.push(
        secondCategory([
          {
            name: "sharedThing",
            type: "string",
            ...(secondFact !== undefined ? { fact: secondFact } : {}),
            description: "Second declaration.",
          },
        ]),
      );
      expect(
        () => buildCategoryRegistry(raw),
        `fact ${firstFact} then ${secondFact} should be rejected`,
      ).toThrow(/attests the same fact/);
    }
  });

  it("rejects the same field name declared twice within ONE category, even with matching facts", () => {
    const raw = validRaw();
    raw.categories[0].fields.push(
      { name: "sharedThing", type: "string", fact: "sharedThing", description: "Once." },
      { name: "sharedThing", type: "string", fact: "sharedThing", description: "Twice." },
    );
    expect(() => buildCategoryRegistry(raw)).toThrow(/more than once/);
  });

  it("rejects an empty-string fact", () => {
    const raw = validRaw();
    raw.categories[0].fields[0].fact = "";
    expect(() => buildCategoryRegistry(raw)).toThrow(/invalid fact/);
  });

  it("rejects one fact id carried by two different field names", () => {
    const raw = validRaw();
    raw.categories[0].fields.push({
      name: "thingOne",
      type: "string",
      fact: "theFact",
      description: "First name.",
    });
    raw.categories.push(
      secondCategory([
        { name: "thingTwo", type: "string", fact: "theFact", description: "Different name, same fact." },
      ]),
    );
    expect(() => buildCategoryRegistry(raw)).toThrow(/exactly one canonical field name/);
  });

  it("a fact on a single-category field is allowed and indexed", () => {
    const raw = validRaw();
    raw.categories[0].fields[0].fact = "fixtureScore";
    const reg = buildCategoryRegistry(raw);
    // Uniquely declared → still has an owning category.
    expect(reg.fieldToCategory.get("fixtureScore")).toBe("fixture-source");
    expect(reg.fieldToFact.get("fixtureScore")).toBe("fixtureScore");
    expect(reg.factToCategories.get("fixtureScore")).toEqual(["fixture-source"]);
  });

  it("rejects an invalid field type", () => {
    const raw = validRaw() as unknown as { categories: Array<{ fields: Array<{ type: string }> }> };
    raw.categories[0].fields[0].type = "timestamp";
    expect(() => buildCategoryRegistry(raw as unknown as RawArg)).toThrow(/invalid type/);
  });

  it("rejects a range with lo > hi", () => {
    const raw = validRaw();
    raw.categories[0].fields[0].range = [1, 0];
    expect(() => buildCategoryRegistry(raw)).toThrow(/invalid range/);
  });

  it("rejects a non-finite range bound (NaN / Infinity)", () => {
    for (const bad of [
      [0, NaN],
      [NaN, 1],
      [0, Infinity],
    ] as Array<[number, number]>) {
      const raw = validRaw();
      raw.categories[0].fields[0].range = bad;
      expect(
        () => buildCategoryRegistry(raw),
        `range ${JSON.stringify(bad)} should be rejected`,
      ).toThrow(/invalid range/);
    }
  });

  it("rejects a field with no description", () => {
    const raw = validRaw() as unknown as { categories: Array<{ fields: Array<{ description: string }> }> };
    raw.categories[0].fields[0].description = "";
    expect(() => buildCategoryRegistry(raw as unknown as RawArg)).toThrow(/non-empty description/);
  });
});

// ── SYS-2561: the geolocation category (hourly track + derived signals) ──

describe("geolocation category", () => {
  it("is declared with the canonical geolocation table", () => {
    const geo = categorySchemaOf("geolocation");
    expect(geo.canonicalTable).toBe("ihs_alt_data_geolocation");
    expect(geo.fields.length).toBe(13);
  });

  it("declares the point-track fields and the derived summary fields", () => {
    const fields = new Set(categoryFieldsOf("geolocation"));
    for (const f of [
      // point instances (instanceKey "pt:<ISO-hour>")
      "latitude",
      "longitude",
      "accuracyMeters",
      "bucket",
      "placeLabel",
      // summary instance (instanceKey "summary")
      "workAttendanceRatio30d",
      "workDailyHoursAvg30d",
      "locationStabilityScore",
      "commuteRegularityRatio",
      "vacationDays90d",
      "hotspotDwellRatio",
      "primaryStateCode",
      "addressMatchScore",
    ]) {
      expect(fields.has(f), `expected geolocation field "${f}"`).toBe(true);
    }
  });

  it("routes the income-reliability headline field to geolocation", () => {
    expect(categoryForField("workAttendanceRatio30d")).toBe("geolocation");
  });

  it("locks coordinate and ratio range contracts", () => {
    const spec = (name: string) =>
      categorySchemaOf("geolocation").fields.find((f) => f.name === name);
    expect(spec("latitude")?.range).toEqual([-90, 90]);
    expect(spec("longitude")?.range).toEqual([-180, 180]);
    for (const name of [
      "workAttendanceRatio30d",
      "locationStabilityScore",
      "commuteRegularityRatio",
      "hotspotDwellRatio",
      "addressMatchScore",
    ]) {
      expect(spec(name)?.range, `${name} should be [0,1]`).toEqual([0, 1]);
    }
  });
});

// ── SYS-2998: FinXtract document-extraction categories ──────────────────
describe("FinXtract document-extraction categories", () => {
  it("declares the four doc-extraction categories with their canonical tables", () => {
    // SYS-3333 de-prefixed three of the four category ids. `finxtract-` names
    // the VENDOR and stays on the adapter ids (finxtract-payslip-v1 and
    // friends); a category is a field set, not a source, so the source has no
    // business in its id. The tables are untouched — no data moved.
    expect(categorySchemaOf("person-identity").canonicalTable).toBe("ihs_alt_data_ic");
    // The two bank categories KEEP their ids this release. De-prefixing the
    // document one would land on `bank-statement`, which the partner feed
    // already holds — and a legacy alias may never collide with a live id, or
    // a pre-sweep manifest saying "bank-statement" is unresolvable (partner
    // feed before, document after). Renaming them waits for the deprecation
    // window to close. Their FIELDS are swept regardless, which is where the
    // shared facts come from.
    expect(categorySchemaOf("epf-statement").canonicalTable).toBe("ihsepfstatement");
    expect(categorySchemaOf("payslip").canonicalTable).toBe("ihspayslip");
    // The fourth keeps its id, and the reason is worth stating: de-prefixing
    // it lands on `bank-statement`, which the partner-feed category already
    // holds. Resolving that means renaming the PARTNER category (its fields
    // are monthly account activity, not a statement document), which touches a
    // partner-facing contract — a separate decision, deliberately not taken
    // here. The field-level shared facts below do not depend on it.
  });

  it("person-identity declares exactly the nine identity fields (unblocks finxtract-ic-v1 registration)", () => {
    // SYS-3163 renamed five off the ic* prefix; SYS-3333 finished the job. The
    // four that kept the prefix did so on the reasoning that "no form collects
    // them, so they have no second attester and nothing to share with" — which
    // was true of a form, and false of the EPF statement, which attests the
    // holder's address. Measured: four sources attest a person's name and one
    // declared the fact.
    expect([...categoryFieldsOf("person-identity")].sort()).toEqual([
      "personAddress",
      "personDateOfBirth",
      "personGender",
      "personIdNumber",
      "personName",
      "personNationality",
      "personPlaceOfBirth",
      "personRace",
      "personReligion",
    ]);
  });

  it("person-identity declares a fact on every identity field", () => {
    // A uniquely-declared field MAY carry a fact, and declaring it up front is
    // what keeps a later attester purely additive: the second category
    // declares the same name + fact and nothing here changes. Without it the
    // shared-name rule refuses the pair (a name declared by two categories
    // where one carries no fact is a load error) and forces a second edit to a
    // published contract.
    const spec = (name: string) =>
      categorySchemaOf("person-identity").fields.find((f) => f.name === name);
    for (const name of categoryFieldsOf("person-identity")) {
      expect(spec(name)?.fact, `${name} should declare its fact`).toBe(name);
    }
    // Routing: a SHARED-fact name has no single owning category, so
    // categoryForField returns null for it by design. Only the still-unique
    // ones route to a category — asserting that keeps this test honest about
    // which names actually gained a second attester in this change.
    for (const shared of ["personName", "personIdNumber", "personAddress"]) {
      expect(categoryForField(shared), `${shared} is attested by >1 category`).toBeNull();
    }
    for (const solo of ["personGender", "personReligion", "personPlaceOfBirth"]) {
      expect(categoryForField(solo), `${solo} still routes to person-identity`).toBe(
        "person-identity",
      );
    }
  });

  it("the bank feed and the bank document share exactly the facts that ARE shared", () => {
    // REVERSES a prior decision, deliberately. This test used to assert ZERO
    // shared names between the two, on the reasoning that "a manifest can never
    // accidentally produce across the two vocabularies". The concern is real
    // and is now handled by a stronger rule than name-disjointness: core
    // refuses a shared name UNLESS both declarations carry the same fact id, so
    // sharing is a written-down decision rather than an accident. `companyName`
    // has spanned three categories on exactly that basis since SYS-3163.
    //
    // The cost of the old rule was that a partner feed and an uploaded
    // statement reporting DIFFERENT closing balances were structurally
    // incomparable — which is the signal this whole phase exists to surface.
    const partner = new Set(categoryFieldsOf("bank-statement"));
    const document = new Set(categoryFieldsOf("finxtract-bank-statement"));
    expect(document.size).toBe(8);

    const shared = [...document].filter((n) => partner.has(n)).sort();
    expect(shared).toEqual(["closingBalance", "totalCredits", "totalDebits"]);

    // …and NOT the ones that merely look alike. `statementMonth` is a
    // PERIOD (YYYY-MM, and the partner category's instance key);
    // `statementDate` is a POINT on a document. Collapsing them would assert
    // one fact where there are two.
    expect(partner.has("statementDate"), "a period is not a date").toBe(false);
    expect(document.has("statementMonth"), "a date is not a period").toBe(false);
  });

  it("epf-statement and payslip declare their document field sets, unprefixed", () => {
    expect(categoryFieldsOf("epf-statement")).toHaveLength(9);
    expect(categoryFieldsOf("payslip")).toHaveLength(15);
    // The prefixes are gone: they encoded the SOURCE, which provenance already
    // records, and they made a shared fact inexpressible because a fact id
    // binds to exactly one field NAME.
    expect([...categoryFieldsOf("payslip")]).toContain("netPay");
    expect([...categoryFieldsOf("epf-statement")]).toContain("totalContribution");
    // The point of the exercise: one person, several documents, one fact.
    for (const c of ["payslip", "epf-statement", "finxtract-bank-statement"]) {
      expect([...categoryFieldsOf(c)], `${c} should attest personName`).toContain("personName");
    }
  });
});

// ── SYS-3003: the financial-statement document-extraction category ──────
// Deferred from the 4.4.0 batch until the period-declaration contract
// (SYS-3002) landed: one document = one audited financial statement
// carrying period1 (its current fiscal year) + period2 (its prior
// comparative year).
describe("finxtract-financial-statement category", () => {
  it("is declared with the promoted financial-statement sibling table", () => {
    const cat = categorySchemaOf("financial-statement");
    expect(cat.canonicalTable).toBe("ihsfinancialstatement");
    // The canonical vocabulary is exactly the host's 122 financial
    // metric keys, verbatim and unprefixed.
    expect(cat.fields).toHaveLength(122);
  });

  it("declares the header/structural fields with their true types", () => {
    const spec = (name: string) =>
      categorySchemaOf("financial-statement").fields.find(
        (f) => f.name === name,
      );
    expect(spec("localNo")?.type).toBe("string");
    expect(spec("companyName")?.type).toBe("string");
    expect(spec("financialYearEnd")?.type).toBe("string");
    expect(spec("consolidated")?.type).toBe("boolean");
    expect(spec("currency")?.type).toBe("string");
    expect(spec("year")?.type).toBe("number");
    // year is an ordinal, not money — no MYR unit.
    expect(spec("year")?.unit).toBeUndefined();
  });

  it("declares the monetary metrics as kind money, carrying no currency of their own", () => {
    // SYS-3249: these declared unit: "MYR" until the currency of a value
    // stopped being a property of its field. The denomination now travels
    // on the value's provenance envelope, so the field says only THAT it
    // is money — never WHICH money. A VN financial statement writes these
    // same columns, which is precisely why the field cannot name one.
    const spec = (name: string) =>
      categorySchemaOf("financial-statement").fields.find(
        (f) => f.name === name,
      );
    for (const name of ["totalEquity", "netProfit", "revenue", "totalAssets"]) {
      expect(spec(name)?.type, `${name} type`).toBe("number");
      expect(spec(name)?.kind, `${name} kind`).toBe("money");
      expect(spec(name)?.unit, `${name} unit`).toBeUndefined();
    }
  });

  it("keeps the bare metric vocabulary disjoint from every other category — except its declared shared facts", () => {
    // The registry's load-time guard already enforces uniqueness (the
    // suite would not load otherwise) — this pins the invariant
    // explicitly for the new bare-name set. Since the shared-fact
    // attestation model landed, `companyName` is the ONE deliberate
    // exception: the form9 extraction category attests the same fact.
    const sharedFacts = new Set(["companyName"]);
    const mine = new Set(categoryFieldsOf("financial-statement"));
    for (const cat of allCategories()) {
      if (cat.id === "financial-statement") continue;
      for (const f of cat.fields) {
        if (sharedFacts.has(f.name)) continue;
        expect(mine.has(f.name), `"${f.name}" (${cat.id}) collides`).toBe(false);
      }
    }
  });

  it("maps a bare metric back to its category", () => {
    expect(categoryForField("totalEquity")).toBe("financial-statement");
    expect(categoryForField("netOperatingCashFlow")).toBe(
      "financial-statement",
    );
  });

  it("companyName is now a shared-fact attestation (form9 attests the same fact)", () => {
    const spec = categorySchemaOf("financial-statement").fields.find(
      (f) => f.name === "companyName",
    );
    expect(spec?.fact).toBe("companyName");
    // Shared across categories → no single owning category.
    expect(categoryForField("companyName")).toBeNull();
  });
});

// ── SYS-3004: SSM Form 9 + SSM company-profile extraction categories ────
// The last two FinXtract doc types join the category registry — and the
// first exercise of the shared-fact attestation model: form9 + ssm both
// extract a company's incorporation date, and form9 + the financial
// statement both extract the company's name. One fact, N attestations.
describe("finxtract-form9 category", () => {
  it("is declared with its canonical alt-data table and exactly three fields", () => {
    const cat = categorySchemaOf("company-registration");
    expect(cat.canonicalTable).toBe("ihs_alt_data_form9");
    expect([...categoryFieldsOf("company-registration")].sort()).toEqual([
      "companyIncorporationDate",
      "companyName",
      "companyRegNo",
    ]);
  });

  it("declares three shared-fact attestations, no unique fields", () => {
    // SYS-3163: companyRegNo gained a fact when finxtract-ssm was renamed
    // onto the same name. The shared-name rule REQUIRES it — a name declared
    // by two categories where one carries no fact is refused at load, so
    // form9's declaration had to gain the fact in the same change.
    const spec = (name: string) =>
      categorySchemaOf("company-registration").fields.find((f) => f.name === name);
    expect(spec("companyName")?.fact).toBe("companyName");
    expect(spec("companyIncorporationDate")?.fact).toBe("companyIncorporationDate");
    expect(spec("companyRegNo")?.fact).toBe("companyRegNo");
    // All three are document strings.
    for (const name of ["companyName", "companyRegNo", "companyIncorporationDate"]) {
      expect(spec(name)?.type, `${name} type`).toBe("string");
    }
  });

  it("leaves every one of its names ambiguous — all three are now shared", () => {
    // categoryForField answers null for a shared name by design (explicit
    // ambiguity rather than privileging the first declarer).
    expect(categoryForField("companyRegNo")).toBeNull();
    expect(categoryForField("companyName")).toBeNull();
    expect(categoryForField("companyIncorporationDate")).toBeNull();
  });
});

describe("finxtract-ssm category", () => {
  it("is declared with its canonical alt-data table and exactly the sixteen profile fields", () => {
    const cat = categorySchemaOf("company-profile");
    expect(cat.canonicalTable).toBe("ihs_alt_data_ssm");
    // SYS-3333: ssmCompanyEntityType -> companyEntityType and
    // ssmPaidUpCapital -> paidUpCapital. The ssm* prefix named the SOURCE,
    // which provenance already records, and it is what would stop a future
    // subject-company category attesting the same entity type.
    expect([...categoryFieldsOf("company-profile")].sort()).toEqual([
      "businessCommencementDate",
      "businessNature",
      "businessOrigin",
      "companyEntityType",
      "companyIncorporationDate",
      "companyLastOldName",
      "companyName",
      "companyNameDateOfChange",
      "companyRegNo",
      "companyStatus",
      "directors",
      "paidUpCapital",
      "previousDirectors",
      "registeredAddress",
      "shareholders",
      "totalShareIssued",
    ]);
    expect(cat.fields).toHaveLength(16);
  });

  it("declares the capital figures as numbers and everything else as strings", () => {
    const cat = categorySchemaOf("company-profile");
    for (const f of cat.fields) {
      if (f.name === "totalShareIssued" || f.name === "paidUpCapital") {
        expect(f.type, `${f.name} type`).toBe("number");
      } else {
        expect(f.type, `${f.name} type`).toBe("string");
      }
    }
    // SYS-3249: was unit "MYR"; a field declares that it is money, not
    // which currency the money is in.
    const paidUp = cat.fields.find((f) => f.name === "paidUpCapital");
    expect(paidUp?.kind).toBe("money");
    expect(paidUp?.unit).toBeUndefined();
  });

  it("attests three shared facts; all other names are unique to ssm", () => {
    // SYS-3163: companyName and companyRegNo joined companyIncorporationDate.
    // Three documents attest a company's name — Form 9, SSM and the financial
    // statement — and before this they did not share the fact, so a Form 9 /
    // SSM conflict was invisible to the disagreement surface.
    const SHARED = new Set(["companyIncorporationDate", "companyName", "companyRegNo"]);
    const cat = categorySchemaOf("company-profile");
    for (const f of cat.fields) {
      if (SHARED.has(f.name)) {
        expect(f.fact, `${f.name} should carry its own name as its fact`).toBe(f.name);
        expect(categoryForField(f.name)).toBeNull();
      } else {
        expect(f.fact, `${f.name} should carry no fact`).toBeUndefined();
        expect(categoryForField(f.name), `${f.name} should route to finxtract-ssm`).toBe(
          "company-profile",
        );
      }
    }
  });

  it("stays disjoint from every other category except the declared shared facts", () => {
    const sharedFacts = new Set(["companyIncorporationDate", "companyName", "companyRegNo"]);
    const mine = new Set(categoryFieldsOf("company-profile"));
    for (const cat of allCategories()) {
      if (cat.id === "company-profile") continue;
      for (const f of cat.fields) {
        if (sharedFacts.has(f.name)) continue;
        expect(mine.has(f.name), `"${f.name}" (${cat.id}) collides`).toBe(false);
      }
    }
  });
});

describe("factOf / categoriesAttestingFact (shared-fact public API)", () => {
  it("factOf returns the fact id for attestation fields and null otherwise", () => {
    expect(factOf("companyIncorporationDate")).toBe("companyIncorporationDate");
    expect(factOf("companyName")).toBe("companyName");
    // SYS-3163: companyRegNo became a shared fact when finxtract-ssm was
    // renamed onto the name form9 already used.
    expect(factOf("companyRegNo")).toBe("companyRegNo");
    // Uniquely-declared, fact-less names → null.
    expect(factOf("onTimePaymentRatio24m")).toBeNull();
    // Unknown names → null.
    expect(factOf("clearlyNotACanonicalField")).toBeNull();
  });

  it("categoriesAttestingFact enumerates every attesting category in data-file order", () => {
    expect(categoriesAttestingFact("companyIncorporationDate")).toEqual([
      "company-registration",
      "company-profile",
    ]);
    // SYS-3163: three documents attest a company's name, and now all three
    // share the fact. Before this, SSM's was a separate fact-less name, so a
    // Form 9 / SSM conflict could not be seen at all.
    expect(categoriesAttestingFact("companyName")).toEqual([
      "financial-statement",
      "company-registration",
      "company-profile",
    ]);
    expect(categoriesAttestingFact("companyRegNo")).toEqual([
      "company-registration",
      "company-profile",
    ]);
    expect(categoriesAttestingFact("not-a-fact")).toEqual([]);
  });
});

// ── The `enum` field kind (vendor value sets live on manifests) ────────

describe("enum field kind", () => {
  function rawWithEnumField(overrides: Record<string, unknown> = {}): RawArg {
    const raw = validRaw();
    (raw.categories[0].fields as unknown as Record<string, unknown>[]).push({
      name: "fixtureTier",
      type: "string",
      kind: "enum",
      description: "A tier label whose value set is vendor territory.",
      ...overrides,
    });
    return raw;
  }

  it("parses kind 'enum' onto the field spec (string type, no range)", () => {
    const reg = buildCategoryRegistry(rawWithEnumField());
    const field = reg.byId.get("fixture-source")?.fields.find((f) => f.name === "fixtureTier");
    expect(field?.kind).toBe("enum");
    expect(field?.type).toBe("string");
  });

  it("a field without kind has kind undefined (kind is opt-in)", () => {
    const reg = buildCategoryRegistry(validRaw());
    const field = reg.byId.get("fixture-source")?.fields.find((f) => f.name === "fixtureScore");
    expect(field?.kind).toBeUndefined();
  });

  it("rejects an unknown kind", () => {
    expect(() => buildCategoryRegistry(rawWithEnumField({ kind: "ordinal" }))).toThrow(
      /invalid kind "ordinal"/,
    );
  });

  it("rejects kind 'enum' on a non-string type — labels are string-normalized", () => {
    expect(() => buildCategoryRegistry(rawWithEnumField({ type: "number" }))).toThrow(
      /enum.*must be type "string"/,
    );
  });

  it("rejects kind 'enum' with a range — labels are unordered", () => {
    expect(() => buildCategoryRegistry(rawWithEnumField({ range: [1, 4] }))).toThrow(
      /enum.*range/,
    );
  });

  it("shared-fact attestations must agree on TYPE — the gap the kind clause only appeared to cover", () => {
    // SYS-3350. `kind` implies type for money and enum, so that subset was
    // already caught — which is exactly what made this look covered. The six
    // KIND-LESS shared facts (personName, personIdNumber, personAddress,
    // companyName, companyRegNo, companyIncorporationDate) had nothing checking
    // them at all: a review set epf-statement's personName to type "number"
    // against the SHIPPED data and it LOADED CLEAN, after which one fact was
    // served as a string by three categories and a number by a fourth.
    // Cross-source comparability is the whole reason a fact id exists.
    const raw = validRaw();
    const attester = (id: string, type: "number" | "boolean" | "string", desc: string) => ({
      id,
      displayName: id,
      description: desc,
      canonicalTable: `ihs_alt_data_${id.replace(/-/g, "_")}`,
      fields: [{ name: "sharedName", type, fact: "sharedName", description: desc }],
    });
    raw.categories.push(attester("fixture-type-a", "string", "Attested as a string here."));
    raw.categories.push(attester("fixture-type-b", "number", "Drifts to a number here."));
    expect(() => buildCategoryRegistry(raw)).toThrow(/must agree on type/);
  });

  it("shared-fact attestations must agree on UNIT — one number, two quantities otherwise", () => {
    // SYS-3350. Same class: without this, one fact could be a count in one
    // category and a ratio in another, and the disagreement comparison the fact
    // id exists for would be comparing two different quantities.
    const raw = validRaw();
    const attester = (id: string, unit: string) => ({
      id,
      displayName: id,
      description: "Unit drift fixture.",
      canonicalTable: `ihs_alt_data_${id.replace(/-/g, "_")}`,
      fields: [
        {
          name: "sharedCount",
          type: "number" as const,
          fact: "sharedCount",
          description: "Unit drift fixture.",
          unit,
        },
      ],
    });
    raw.categories.push(attester("fixture-unit-a", "months"));
    raw.categories.push(attester("fixture-unit-b", "days"));
    expect(() => buildCategoryRegistry(raw)).toThrow(/must agree on unit/);
  });

  it("shared-fact attestations must agree on kind (drift refused at load)", () => {
    const raw = validRaw();
    raw.categories.push({
      id: "fixture-doc-a",
      displayName: "Fixture Doc A",
      description: "First attester.",
      canonicalTable: "ihs_alt_data_fixture_a",
      fields: [
        {
          name: "sharedTier",
          type: "string",
          kind: "enum",
          fact: "sharedTier",
          description: "Attested as an enum here.",
        },
      ],
    });
    raw.categories.push({
      id: "fixture-doc-b",
      displayName: "Fixture Doc B",
      description: "Second attester — drifts on kind.",
      canonicalTable: "ihs_alt_data_fixture_b",
      fields: [
        {
          name: "sharedTier",
          type: "string",
          fact: "sharedTier",
          description: "Attested as a plain string here.",
        },
      ],
    });
    expect(() => buildCategoryRegistry(raw)).toThrow(/must agree on kind/);
  });

  // ── SYS-3164: field confidentiality (fail-closed) ──────────────────

  it("SYS-3171: an unclassified field is RESOLVED to sensitive on the built spec", () => {
    // The asymmetry is the design. AUTHORING stays opt-out-only — the data
    // file omits the property and "sensitive" is unspellable there — but the
    // BUILT spec always states the class outright, because the registry is
    // serialised verbatim to finhub and finsys-client and on that wire
    // "absent means sensitive" is carried by nothing.
    const raw = validRaw();
    const rawField = raw.categories[0].fields[0];
    expect(rawField.confidentiality).toBeUndefined();

    const reg = buildCategoryRegistry(raw);
    const built = reg.all[0].fields.find((f) => f.name === rawField.name);
    expect(built?.confidentiality, "built spec resolves the default").toBe("sensitive");
    // Nothing is left absent — the whole point of resolving it.
    for (const cat of reg.all) {
      for (const f of cat.fields) {
        expect(f.confidentiality, `${cat.id}.${f.name}`).toBeDefined();
      }
    }

    // ...and the ACCESSOR must agree, or this is tautological and would pass
    // with isFieldSensitive fully inverted — the one bug it exists to catch.
    // Asserted against a LIVE category, because isFieldSensitive reads the
    // module-level registry rather than the fixture one built above.
    const live = allCategories()[0];
    const liveUnclassified = live.fields.find((f) => f.confidentiality === "sensitive");
    expect(liveUnclassified).toBeDefined();
    expect(isFieldSensitive(live.id, liveUnclassified!.name)).toBe(true);
  });

  it("only 'non-sensitive' is declarable — 'sensitive' is refused at load", () => {
    const raw = validRaw();
    // The double cast is load-bearing, not laziness: TypeScript ALREADY
    // refuses `confidentiality: "sensitive"` (the type admits only the
    // opt-out), so this is the one way to reach the runtime guard. And
    // the runtime guard is the one that matters — adapter-categories.json
    // is plain JSON, so no compile-time check ever sees it.
    raw.categories[0].fields[0] = {
      ...raw.categories[0].fields[0],
      confidentiality: "sensitive",
    } as unknown as RawArg["categories"][number]["fields"][number];
    expect(() => buildCategoryRegistry(raw)).toThrow(/invalid confidentiality/);
  });

  it("shared-fact attestations must agree on confidentiality (drift refused at load)", () => {
    const raw = validRaw();
    raw.categories.push({
      id: "fixture-conf-a",
      displayName: "Fixture Conf A",
      description: "Attests the fact as sensitive (by omission).",
      canonicalTable: "ihs_alt_data_fixture_conf_a",
      fields: [
        { name: "sharedName", type: "string", fact: "sharedName", description: "Sensitive here." },
      ],
    });
    raw.categories.push({
      id: "fixture-conf-b",
      displayName: "Fixture Conf B",
      description: "Same fact, opted out — incoherent.",
      canonicalTable: "ihs_alt_data_fixture_conf_b",
      fields: [
        {
          name: "sharedName",
          type: "string",
          fact: "sharedName",
          confidentiality: "non-sensitive",
          description: "Non-sensitive here.",
        },
      ],
    });
    expect(() => buildCategoryRegistry(raw)).toThrow(/must agree on confidentiality/);
  });

  it("shared-fact attestations with MATCHING confidentiality load fine", () => {
    // The negative case above proves drift is refused; without this, a bug
    // that wrongly refused AGREEING opt-outs would ship green, because the
    // live data file only ever exercises the both-absent case. Mirrors the
    // existing positive test for `kind`.
    const raw = validRaw();
    for (const id of ["fixture-agree-a", "fixture-agree-b"]) {
      raw.categories.push({
        id,
        displayName: `Fixture Agree ${id.slice(-1).toUpperCase()}`,
        description: "Attests the shared fact, both opted out.",
        canonicalTable: `ihs_alt_data_${id.replace(/-/g, "_")}`,
        fields: [
          {
            name: "sharedPublicTier",
            type: "string",
            fact: "sharedPublicTier",
            confidentiality: "non-sensitive",
            description: "Non-sensitive in both.",
          },
        ],
      });
    }
    const reg = buildCategoryRegistry(raw);
    expect(reg.factToCategories.get("sharedPublicTier")).toEqual([
      "fixture-agree-a",
      "fixture-agree-b",
    ]);
  });

  it("shared-fact attestations with MATCHING kind load fine", () => {
    const raw = validRaw();
    for (const suffix of ["a", "b"] as const) {
      raw.categories.push({
        id: `fixture-doc-${suffix}`,
        displayName: `Fixture Doc ${suffix.toUpperCase()}`,
        description: "An attester.",
        canonicalTable: `ihs_alt_data_fixture_${suffix}`,
        fields: [
          {
            name: "sharedTier",
            type: "string",
            kind: "enum",
            fact: "sharedTier",
            description: "Attested as an enum in both categories.",
          },
        ],
      });
    }
    const reg = buildCategoryRegistry(raw);
    expect(reg.factToCategories.get("sharedTier")).toEqual(["fixture-doc-a", "fixture-doc-b"]);
  });
});

describe("telco-carrier enum tier fields", () => {
  const TIER_FIELDS = [
    "paymentReliabilityTier",
    "tenureTier",
    "distressTier",
    "handsetRiskTier",
  ] as const;

  it("declares all four tier fields as enum-kind strings, no range, no baked value sets", () => {
    const schema = categorySchemaOf("telco-carrier");
    for (const name of TIER_FIELDS) {
      const field = schema.fields.find((f) => f.name === name);
      expect(field, name).toBeDefined();
      expect(field?.kind, name).toBe("enum");
      expect(field?.type, name).toBe("string");
      expect(field?.range, name).toBeUndefined();
      // The category must not smuggle an ordering or a value list into
      // the description — vendor labels live on manifests.
      expect(field?.description, name).not.toMatch(/1=|2=|3=|4=|levels:/);
    }
  });

  it("tier fields are uniquely owned by telco-carrier", () => {
    for (const name of TIER_FIELDS) {
      expect(categoryForField(name)).toBe("telco-carrier");
    }
  });
});

describe("isFieldSensitive / sensitiveFieldsOf (SYS-3164)", () => {
  const someCategory = ADAPTER_CATEGORY_IDS[0];

  it("treats an undeclared field as sensitive — the safe answer to a name it does not recognize", () => {
    // Mid-rename callers and plain mistakes both land here. Answering
    // "no, not sensitive" for a field nobody has heard of is the one
    // answer that can silently leak.
    expect(isFieldSensitive(someCategory, "aFieldThatDoesNotExist")).toBe(true);
  });

  it("sensitiveFieldsOf is the complement of the declared opt-outs", () => {
    for (const id of ADAPTER_CATEGORY_IDS) {
      const schema = categorySchemaOf(id);
      const optedOut = schema.fields
        .filter((f) => f.confidentiality === "non-sensitive")
        .map((f) => f.name);
      const sensitive = sensitiveFieldsOf(id);
      expect([...sensitive, ...optedOut].sort()).toEqual(categoryFieldsOf(id).slice().sort());
      for (const name of optedOut) {
        expect(isFieldSensitive(id, name)).toBe(false);
      }
    }
  });

  it("throws for an unknown CATEGORY rather than answering — that is a wiring error, not a data question", () => {
    expect(() => isFieldSensitive("no-such-category", "anything")).toThrow(
      /Unknown adapter category/,
    );
  });
})

// ── SYS-3249: currency belongs to the value, not the field ───────────
describe("monetary fields and the closed unit set", () => {
  const CURRENCY_CODE = /^[A-Z]{3}$/;

  it("no canonical field anywhere declares a currency as its unit", () => {
    // The census, and the point of the whole change. 143 fields declared
    // unit: "MYR" — a statement that was only ever true of Malaysian data,
    // on fields a Vietnamese financial statement writes too. This fails if
    // one comes back.
    const offenders: string[] = [];
    for (const cat of allCategories()) {
      for (const f of cat.fields) {
        if (f.unit !== undefined && CURRENCY_CODE.test(f.unit)) {
          offenders.push(`${cat.id}.${f.name} (unit "${f.unit}")`);
        }
      }
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  it("every money field is a number, and declares neither unit nor range", () => {
    // A range on money is denominated by definition — arpu's
    // [0, 10000] was sane in ringgit and ~20x too small in dong. A unit on
    // money is the currency wearing a disguise.
    const money = allCategories().flatMap((cat) =>
      cat.fields.filter((f) => f.kind === "money").map((f) => ({ cat: cat.id, f })),
    );
    // Pinned, not `toBeGreaterThan(0)`. The 143 were converted by a SCRIPT,
    // and a script is exactly what can drop 140 of them while leaving 3 —
    // which a lower bound would wave through. If this number changes, that
    // is either a new money field (raise it deliberately) or a regression.
    expect(money.length).toBe(143);
    for (const { cat, f } of money) {
      expect(f.type, `${cat}.${f.name} type`).toBe("number");
      expect(f.unit, `${cat}.${f.name} unit`).toBeUndefined();
      expect(f.range, `${cat}.${f.name} range`).toBeUndefined();
    }
  });

  it("a currency unit is refused at load, and says why", () => {
    const raw = validRaw();
    raw.categories[0].fields[0] = {
      ...raw.categories[0].fields[0],
      unit: "MYR",
      range: undefined,
    } as unknown as RawArg["categories"][number]["fields"][number];
    expect(() => buildCategoryRegistry(raw)).toThrow(/a currency is not a unit of measure/);
  });

  it("an unrecognized non-currency unit is refused too — the set is closed, not currency-blocklisted", () => {
    // A blocklist of currency codes would only catch the shapes someone
    // thought of. The allow-list catches "furlongs" as readily as "VND".
    const raw = validRaw();
    raw.categories[0].fields[0] = {
      ...raw.categories[0].fields[0],
      unit: "furlongs",
    } as unknown as RawArg["categories"][number]["fields"][number];
    expect(() => buildCategoryRegistry(raw)).toThrow(/invalid unit "furlongs"/);
  });

  it("kind money refuses a non-number type, a unit, and a range", () => {
    const withMoneyField = (extra: Record<string, unknown>): RawArg => {
      const raw = validRaw();
      raw.categories[0].fields[0] = {
        name: "fixtureAmount",
        type: "number",
        kind: "money",
        description: "A monetary test field.",
        ...extra,
      } as unknown as RawArg["categories"][number]["fields"][number];
      return raw;
    };
    expect(() => buildCategoryRegistry(withMoneyField({ type: "string" }))).toThrow(
      /is kind "money" but type "string"/,
    );
    expect(() => buildCategoryRegistry(withMoneyField({ unit: "ratio" }))).toThrow(
      /is kind "money" and declares unit/,
    );
    expect(() => buildCategoryRegistry(withMoneyField({ range: [0, 10000] }))).toThrow(
      /is kind "money" and declares a range/,
    );
  });

  it("a well-formed money field LOADS — the guards above reject the bad case, not every case", () => {
    // The positive control. Without it, the three rejections above would
    // pass just as happily if buildCategoryRegistry threw unconditionally,
    // and the suite would report a working guard that permits nothing.
    const raw = validRaw();
    raw.categories[0].fields[0] = {
      name: "fixtureAmount",
      type: "number",
      kind: "money",
      description: "A monetary test field.",
    } as unknown as RawArg["categories"][number]["fields"][number];
    const reg = buildCategoryRegistry(raw);
    const spec = reg.byId.get("fixture-source")?.fields.find((f) => f.name === "fixtureAmount");
    expect(spec?.kind).toBe("money");
    expect(spec?.unit).toBeUndefined();
  });
})

// ── SYS-3249: the drift guard the allow-list alone does not give you ─
describe("monetary declaration cannot be skipped by silence", () => {
  it("every numeric canonical field declares a unit OR kind money", () => {
    // The allow-list closes "declares MYR" and the per-kind block closes
    // "declares money AND a unit". Neither closes the cheapest path of all:
    // declare NOTHING. A bare { type: "number" } money field loads clean,
    // gets no denomination forever, and fails no test — and post-change,
    // saying nothing is the only route that never throws.
    //
    // Exactly two numeric fields are legitimately bare, so the counter-
    // pressure costs almost nothing. Both are named, not pattern-matched:
    // an exception you have to type is an exception someone has to justify.
    const LEGITIMATELY_BARE = new Set([
      "year", // a document ordinal, not a measure
      "totalShareIssued", // a count of shares, not an amount of money
    ]);
    const bare: string[] = [];
    for (const cat of allCategories()) {
      for (const f of cat.fields) {
        if (f.type !== "number") continue;
        if (f.unit !== undefined || f.kind === "money") continue;
        if (LEGITIMATELY_BARE.has(f.name)) continue;
        bare.push(`${cat.id}.${f.name}`);
      }
    }
    expect(
      bare,
      `numeric field(s) declaring neither a unit nor kind "money" — if monetary, declare it; if not, add it to LEGITIMATELY_BARE with a reason: ${bare.join(", ")}`,
    ).toEqual([]);
  });
})

// ── SYS-3333: the legacy-name bridge ─────────────────────────────────────
describe("legacyName — the bridge between the canonical and flat vocabularies", () => {
  it("a renamed money field is still detected as money under its FLAT name", () => {
    // The regression this contract exists for, stated at the level it broke.
    // isMonetaryField() in ihs-processing.ts is handed a flat column name and
    // matches it against canonical names; before legacyName existed, renaming
    // grossPay left `payslipGrossPay` unrecognised and its value rendered as a
    // bare number beside denominated neighbours. Silent, and wrong-looking.
    const money = new Map<string, string | undefined>();
    for (const cat of allCategories()) {
      for (const f of cat.fields) {
        if (f.kind === "money") money.set(f.name, f.legacyName);
      }
    }
    const grossPay = money.get("grossPay");
    expect(grossPay, "grossPay should be money and should record its flat name").toBe(
      "payslipGrossPay",
    );
    // …and the count is asserted so a future rename that forgets the alias
    // shows up here rather than as a table of undenominated numbers.
    const renamedMoney = [...money.values()].filter(Boolean);
    expect(renamedMoney.length, "renamed money fields must all record a legacyName").toBeGreaterThan(
      15,
    );
  });

  it("resolves a name from either vocabulary, and nothing else", () => {
    expect(resolveCanonicalFieldName("grossPay")).toBe("grossPay"); // already canonical
    expect(resolveCanonicalFieldName("payslipGrossPay")).toBe("grossPay"); // legacy
    expect(resolveCanonicalFieldName("personName")).toBe("personName"); // shared-fact name
    expect(resolveCanonicalFieldName("epfAccountHolderName")).toBe("personName");
    expect(resolveCanonicalFieldName("noSuchFieldAnywhere")).toBeNull();
  });

  it("refuses a legacyName that shadows a live canonical name", () => {
    // Otherwise a lookup cannot say which field was meant, and it would
    // resolve to whichever the loader happened to index.
    const raw = {
      schemaVersion: "1.0.0",
      categories: [
        {
          id: "fixture-a",
          displayName: "A",
          description: "d",
          canonicalTable: "ihs_fixture_a",
          fields: [{ name: "alpha", type: "string", description: "d", legacyName: "beta" }],
        },
        {
          id: "fixture-b",
          displayName: "B",
          description: "d",
          canonicalTable: "ihs_fixture_b",
          fields: [{ name: "beta", type: "string", description: "d" }],
        },
      ],
    };
    expect(() => buildCategoryRegistry(raw as never)).toThrow(/also a LIVE canonical field name/);
  });

  it("refuses two canonical fields claiming the same legacyName", () => {
    const raw = {
      schemaVersion: "1.0.0",
      categories: [
        {
          id: "fixture-a",
          displayName: "A",
          description: "d",
          canonicalTable: "ihs_fixture_a",
          fields: [{ name: "alpha", type: "string", description: "d", legacyName: "old" }],
        },
        {
          id: "fixture-b",
          displayName: "B",
          description: "d",
          canonicalTable: "ihs_fixture_b",
          fields: [{ name: "gamma", type: "string", description: "d", legacyName: "old" }],
        },
      ],
    };
    expect(() => buildCategoryRegistry(raw as never)).toThrow(/claimed by two different canonical/);
  });

  it("refuses a legacyName identical to the field's own name", () => {
    // Not pedantry: it reads as "this was renamed" while recording no rename,
    // and it would quietly satisfy any drift guard counting aliases.
    const raw = {
      schemaVersion: "1.0.0",
      categories: [
        {
          id: "fixture-a",
          displayName: "A",
          description: "d",
          canonicalTable: "ihs_fixture_a",
          fields: [{ name: "alpha", type: "string", description: "d", legacyName: "alpha" }],
        },
      ],
    };
    expect(() => buildCategoryRegistry(raw as never)).toThrow(/legacyName identical to its/);
  });
});

// ── SYS-3333: the naming conventions, enforced at load ───────────────────
describe("naming conventions are refused at load, not merely applied once", () => {
  const one = (field: Record<string, unknown>) => ({
    schemaVersion: "1.0.0",
    categories: [
      {
        id: "fixture-a",
        displayName: "A",
        description: "d",
        canonicalTable: "ihs_fixture_a",
        fields: [{ type: "string", description: "d", ...field }],
      },
    ],
  });

  it("refuses a currency baked into a field name", () => {
    // The sweep found five of these, every one already kind:"money" — so the
    // name contradicted the field's own declaration. Nothing refused them.
    expect(() => buildCategoryRegistry(one({ name: "arpuMyr" }) as never)).toThrow(
      /bakes a currency into its name/,
    );
    expect(() => buildCategoryRegistry(one({ name: "volumeUsd" }) as never)).toThrow(
      /bakes a currency into its name/,
    );
  });

  it("refuses the retired T<n> window convention", () => {
    expect(() => buildCategoryRegistry(one({ name: "monthlyVolumeT12" }) as never)).toThrow(
      /uses the T<n> window convention/,
    );
  });

  it("accepts the conventions the registry actually uses", () => {
    // The negative cases above prove the guard fires; this proves it is not
    // simply refusing everything, which a too-greedy regex would.
    for (const name of ["monthlyVolume12m", "engagementRate90d", "arpu", "closingBalance"]) {
      expect(() => buildCategoryRegistry(one({ name }) as never), name).not.toThrow();
    }
  });

  it("the shipped registry satisfies every convention it enforces", () => {
    // Belt and braces: the guards run at load, so this can only fail if a
    // guard is weakened. That is exactly when it should fail.
    for (const cat of allCategories()) {
      // `finxtract-bank-statement` is the ONE documented exception, and it is
      // temporary: see the canonical-tables test above for why the rename is
      // blocked on the deprecation window rather than on taste. Asserted as a
      // named exception so a SECOND vendor-named id still fails.
      if (cat.id !== "finxtract-bank-statement") {
        expect(cat.id, `${cat.id} names a vendor`).not.toMatch(/^finxtract-/);
      }
      for (const f of cat.fields) {
        expect(f.name, `${cat.id}.${f.name}`).not.toMatch(/(Myr|Usd|Vnd|Thb|Sgd)$/);
        expect(f.name, `${cat.id}.${f.name}`).not.toMatch(/T\d+$/);
      }
    }
  });
});
