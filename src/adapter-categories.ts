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

/**
 * Generic adapter category catalogue.
 *
 * Each category declares the canonical field set produced by any
 * adapter of that category — regardless of vendor. This is the
 * public, vendor-agnostic vocabulary that clients (finhub views,
 * finsys-client eval engine, CRA report renderer) read so they know
 * what data shape to expect from a given alt-data source TYPE.
 *
 * Specific vendor implementations (e.g. "Celcom telco v1", "iPay88
 * payments v1") live OUTSIDE this open-source package, in private
 * extension directories loaded by the host app. The category schemas
 * are the publication boundary — vendors map their raw payload to
 * these canonical fields; clients render against these canonical
 * fields. Vendor identity never crosses that boundary.
 */

import categoriesData from "./data/adapter-categories.json" with { type: "json" };

interface RawCategoryField {
  name: string;
  type: "number" | "boolean" | "string";
  unit?: string;
  range?: [number, number];
  description: string;
}

interface RawCategory {
  id: string;
  displayName: string;
  description: string;
  canonicalTable: string;
  fields: RawCategoryField[];
}

interface RawCategoryData {
  schemaVersion: string;
  categories: RawCategory[];
}

const data = categoriesData as RawCategoryData;

/**
 * Generic categories declared in this package. The set is union-typed
 * so consumers get TypeScript autocomplete (`'telco-carrier' |
 * 'payment-network' | ...`) and a compile-time error if they reference
 * a category that doesn't exist.
 *
 * NB: adding a new category is a finsys-core minor version bump.
 * Vendor adapters can ship freely (deployment-time, no core change)
 * but the CATEGORY they implement must exist here.
 */
export type AdapterCategory = "telco-carrier" | "payment-network" | "bank-statement";

/**
 * Per-field metadata for a canonical field declared by a category.
 * Frozen at module load — the data file is authoritative.
 */
export interface CanonicalFieldSpec {
  readonly name: CanonicalFieldName;
  readonly type: "number" | "boolean" | "string";
  readonly unit?: string;
  readonly range?: readonly [number, number];
  readonly description: string;
}

/**
 * Per-category schema bundle. Used by:
 *   - host app: validate adapter `produces` lists at registration
 *   - clients (finhub, finsys-client): render UI conditionally on
 *     category activation
 *   - CRA report: render provenance metadata
 */
export interface CategorySchema {
  readonly id: AdapterCategory;
  readonly displayName: string;
  readonly description: string;
  readonly canonicalTable: string;
  readonly fields: ReadonlyArray<CanonicalFieldSpec>;
}

/**
 * Union of all canonical field names declared by any category in this
 * package. Loose-typed at compile time (string) because the actual
 * union grows with each category-added minor; runtime helpers below
 * narrow against the data.
 *
 * Adapter `produces` lists are typed as ReadonlyArray<CanonicalFieldName>
 * — the host validates membership against the adapter's category at
 * registration time, refusing adapters that promise fields outside
 * their category.
 */
export type CanonicalFieldName = string;

/**
 * Look up a category schema by id. Throws if the id is unknown — this
 * is a programmer error (the type system should prevent it).
 */
export function categorySchemaOf(id: AdapterCategory): CategorySchema {
  const found = data.categories.find((c) => c.id === id);
  if (!found) {
    throw new Error(
      `Unknown adapter category: ${id}. Available: ${data.categories.map((c) => c.id).join(", ")}`,
    );
  }
  return found as CategorySchema;
}

/**
 * The canonical field names a given category produces. Convenience
 * for callers that don't need the full schema — common case in the
 * eval engine ("does this policy reference any fields from a category
 * that isn't loaded?").
 */
export function categoryFieldsOf(id: AdapterCategory): ReadonlyArray<CanonicalFieldName> {
  return categorySchemaOf(id).fields.map((f) => f.name);
}

/**
 * Every category currently declared. Order is data-file order; treat
 * as unstable across versions.
 */
export function allCategories(): ReadonlyArray<CategorySchema> {
  return data.categories as ReadonlyArray<CategorySchema>;
}

/**
 * Reverse lookup: which category declares a given canonical field?
 * Returns null if the field name isn't declared by any category in
 * this version of finsys-core. Useful when the host app is reading
 * canonical field values back from storage + wants to identify the
 * producing category for rendering.
 */
export function categoryForField(field: CanonicalFieldName): AdapterCategory | null {
  for (const cat of data.categories) {
    if (cat.fields.some((f) => f.name === field)) {
      return cat.id as AdapterCategory;
    }
  }
  return null;
}
