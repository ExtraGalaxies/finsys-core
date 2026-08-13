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
  ADAPTER_CATEGORY_IDS,
  allCategories,
  categoryFieldsOf,
  isAdapterCategory,
} from "./adapter-categories.js";
import manifestSchema from "./schema/adapter-manifest.schema.json" with { type: "json" };
import categoriesData from "./data/adapter-categories.json" with { type: "json" };

/**
 * SYS-2500 changed the model. The AdapterCategory id set used to live in
 * THREE places that had to agree (a TS union, the data file, the
 * manifest JSON-schema enum), guarded by a hand-maintained list here.
 * It now lives in ONE place — `data/adapter-categories.json` — loaded
 * into a runtime registry. There is no TS union and no schema enum to
 * drift.
 *
 * This guard's job is therefore inverted: instead of checking that the
 * three sources agree, it checks that the single source of truth stays
 * single — i.e. that nobody reintroduces a hardcoded enum/union that
 * could silently drift from the data file again.
 */
describe("AdapterCategory single-source-of-truth guard", () => {
  it("the runtime registry matches the data file exactly", () => {
    const dataIds = (categoriesData as { categories: Array<{ id: string }> }).categories
      .map((c) => c.id)
      .sort();
    expect([...ADAPTER_CATEGORY_IDS].sort()).toEqual(dataIds);
    expect(
      allCategories()
        .map((c) => c.id)
        .sort(),
    ).toEqual(dataIds);
  });

  it("the manifest JSON-schema `category` is an OPEN string, not an enum", () => {
    // The whole point of SYS-2500: adding a category is a data-file edit
    // with no schema change. A reintroduced enum would re-create the
    // three-sources-of-truth drift problem. Fail loudly if one appears.
    const category = (
      manifestSchema as unknown as {
        properties: { category: Record<string, unknown> };
      }
    ).properties.category;
    expect(category.type).toBe("string");
    expect(category).not.toHaveProperty("enum");
  });

  it("isAdapterCategory agrees with the registry for every declared id", () => {
    for (const id of ADAPTER_CATEGORY_IDS) {
      expect(isAdapterCategory(id)).toBe(true);
    }
    expect(isAdapterCategory("absurd-category-that-does-not-exist")).toBe(false);
  });

  it("every declared category has at least one canonical field", () => {
    for (const id of ADAPTER_CATEGORY_IDS) {
      expect(categoryFieldsOf(id).length, `category "${id}" has no fields`).toBeGreaterThan(0);
    }
  });

  it("includes the baseline categories plus the social-media category", () => {
    for (const id of ["telco-carrier", "payment-network", "bank-account-activity", "social-media"]) {
      expect(ADAPTER_CATEGORY_IDS, `expected "${id}" in registry`).toContain(id);
    }
  });
});
