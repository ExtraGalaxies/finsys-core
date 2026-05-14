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
  allCategories,
  categorySchemaOf,
  categoryFieldsOf,
  categoryForField,
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
      // @ts-expect-error: deliberately unknown category to test guard
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
