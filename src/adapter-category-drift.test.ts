/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";
import {
  type AdapterCategory,
  allCategories,
  categoryFieldsOf,
} from "./adapter-categories.js";
import manifestSchema from "./schema/adapter-manifest.schema.json" with { type: "json" };
import categoriesData from "./data/adapter-categories.json" with { type: "json" };

/**
 * Three sources of truth declare the AdapterCategory id set:
 *   - TS union: `AdapterCategory` in `adapter-categories.ts`
 *   - data file: `categories[].id` in `data/adapter-categories.json`
 *   - JSON-schema: `properties.category.enum` in
 *     `schema/adapter-manifest.schema.json`
 *
 * They MUST agree. This test fails loudly when one is updated without
 * the others. The TS union is enumerated here by hand — that's the
 * point: adding a category requires touching this list deliberately,
 * not via inference.
 */
const TS_CATEGORIES_HARDCODED: ReadonlyArray<AdapterCategory> = [
  "telco-carrier",
  "payment-network",
  "bank-statement",
];

describe("AdapterCategory drift guard", () => {
  it("data file ids match the TS union", () => {
    const dataIds = (categoriesData as { categories: Array<{ id: string }> }).categories
      .map((c) => c.id)
      .sort();
    const expected = [...TS_CATEGORIES_HARDCODED].sort();
    expect(dataIds).toEqual(expected);
  });

  it("JSON-schema enum matches the TS union", () => {
    const schema = manifestSchema as unknown as {
      properties: { category: { enum: string[] } };
    };
    const enumIds = [...schema.properties.category.enum].sort();
    const expected = [...TS_CATEGORIES_HARDCODED].sort();
    expect(enumIds).toEqual(expected);
  });

  it("allCategories() agrees with the data file", () => {
    const fromHelper = allCategories().map((c) => c.id).sort();
    const expected = [...TS_CATEGORIES_HARDCODED].sort();
    expect(fromHelper).toEqual(expected);
  });

  it("every declared category has at least one canonical field", () => {
    for (const id of TS_CATEGORIES_HARDCODED) {
      const fields = categoryFieldsOf(id);
      expect(fields.length, `category "${id}" has no fields`).toBeGreaterThan(0);
    }
  });
});
