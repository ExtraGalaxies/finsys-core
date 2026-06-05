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
  isAdapterCategory,
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

  it("canonical field names are unique across all categories", () => {
    const seen = new Map<string, string>();
    for (const cat of allCategories()) {
      for (const f of cat.fields) {
        const prior = seen.get(f.name);
        expect(
          prior,
          `duplicate canonical field "${f.name}" across categories: ${prior} + ${cat.id}`,
        ).toBeUndefined();
        seen.set(f.name, cat.id);
      }
    }
  });

  it("every category declares a distinct canonical storage table", () => {
    const tables = new Set<string>();
    for (const cat of allCategories()) {
      expect(cat.canonicalTable).toMatch(/^ihs_alt_data_/);
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
      "telcoOnTimePaymentRatio24m",
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
    expect(fields).toContain("telcoOnTimePaymentRatio24m");
    expect(fields).toContain("telcoTenureMonths");
    expect(fields).toContain("telcoSuspensionsCount24m");
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
    expect(categoryForField("telcoOnTimePaymentRatio24m")).toBe(
      "telco-carrier",
    );
  });

  it("identifies the producing category for a known payments field", () => {
    expect(categoryForField("paymentsMonthlyVolumeMyrT3")).toBe(
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
      "socialAccountTenureMonths",
      "socialFollowerCount",
      "socialEngagementRate90d",
      "socialPostingConsistency12m",
      "socialVerifiedBusinessAccount",
      "socialCustomerRatingAvg",
      "socialNegativeSentimentRatio90d",
      "socialAccountFlags24m",
    ]) {
      expect(fields.has(f), `expected social-media field "${f}"`).toBe(true);
    }
  });

  it("maps a social field back to its category", () => {
    expect(categoryForField("socialEngagementRate90d")).toBe("social-media");
  });

  it("carries a boolean field type for the verified-account flag", () => {
    const spec = categorySchemaOf("social-media").fields.find(
      (f) => f.name === "socialVerifiedBusinessAccount",
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
      "arTotalOutstandingMyr",
      "arCurrentRatio",
      "arOverdue90PlusRatio",
      "debtorConcentrationTop5Ratio",
      "tradeReferenceDefaults12m",
      "accountingRevenue12mMyr",
      "grossMarginPct",
      "cashConversionCycleDays",
    ]) {
      expect(fields.has(f), `expected trade-credit field "${f}"`).toBe(true);
    }
  });

  it("carries the cross-reference revenue anchor for bank-statement consistency checks", () => {
    // accountingRevenue12mMyr is the self-reported figure the dashboard's
    // consistency tier cross-checks against payment-network + bank inflows.
    expect(categoryForField("accountingRevenue12mMyr")).toBe("trade-credit");
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

  it("rejects a canonicalTable without the ihs_alt_data_ prefix", () => {
    const raw = validRaw();
    raw.categories[0].canonicalTable = "some_other_table";
    expect(() => buildCategoryRegistry(raw)).toThrow(/ihs_alt_data_/);
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
