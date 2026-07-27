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
 * Specific vendor implementations (e.g. "example-telco-v1",
 * "example-payments-v1") live OUTSIDE this open-source package, in private
 * extension directories loaded by the host app. The category schemas
 * are the publication boundary — vendors map their raw payload to
 * these canonical fields; clients render against these canonical
 * fields. Vendor identity never crosses that boundary.
 *
 * SYS-2500 (extensible categories)
 * --------------------------------
 * The category id set used to be a hardcoded TypeScript union, kept in
 * sync by hand with the data file and the manifest JSON-schema enum
 * (three sources of truth, a drift test, and a deliberate edit in each
 * place to add a category). It is now backed by a single source of
 * truth: this package's `data/adapter-categories.json`, loaded +
 * validated into a runtime registry at module load. Adding a category
 * is a JSON-file edit plus a finsys-core minor bump — no union edit, no
 * schema enum edit. `AdapterCategory` is an open `string`; membership
 * is validated at trust boundaries via `isAdapterCategory()` /
 * `assertAdapterCategory()`.
 */

import categoriesData from "./data/adapter-categories.json" with { type: "json" };

/**
 * Adapter category identifier.
 *
 * Open `string` type (SYS-2500). The authoritative set lives in the
 * runtime registry built from `data/adapter-categories.json`; there is
 * no compile-time union to enumerate. The trade-off vs. the old
 * literal union is the loss of autocomplete + exhaustiveness on
 * category ids — validate at boundaries with `isAdapterCategory()` /
 * `assertAdapterCategory()` instead, and read the canonical set from
 * `ADAPTER_CATEGORY_IDS` / `allCategories()`.
 */
export type AdapterCategory = string;

/**
 * Union of all canonical field names declared by any category. Loose-
 * typed (string) because the set grows with each category-added minor;
 * the runtime registry narrows against the data file.
 *
 * Adapter `produces` lists are typed as ReadonlyArray<CanonicalFieldName>
 * — the host validates membership against the adapter's category at
 * registration time, refusing adapters that promise fields outside
 * their category.
 */
export type CanonicalFieldName = string;

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
  /**
   * Global fact identifier marking this field as an ATTESTATION of a
   * shared real-world fact (e.g. a company has exactly one
   * incorporation date, no matter which document it was extracted
   * from). Multiple categories may declare the SAME field name iff
   * every declaring category carries the same `fact` id — each
   * category's value is then an independent attestation of one fact,
   * comparable across sources (the future disagreement-comparison
   * feature's unit of comparison). A `fact` id is bound to exactly one
   * field name registry-wide; by convention the field name IS the fact
   * id. Uniquely-declared fields need no `fact` (but may carry one).
   */
  readonly fact?: string;
  /**
   * Field kind — a semantic refinement of `type`. Currently the only
   * kind is `"enum"`: the field's value is one label out of a closed
   * set. The category declares ONLY that the field is enumerated —
   * never the values, never an ordering. Value sets are vendor
   * territory: each adapter declares the exact labels it emits in its
   * manifest's `enumValues` (host-validated), because two vendors
   * implementing the same category may bucket differently. Ordering
   * and scoring interpretation live even further out, in the consumer
   * (an eval model's per-value mapping) — an enum label is data, what
   * it is worth is opinion, and opinions don't belong in the data
   * contract. An enum field MUST be `type: "string"` (labels are
   * string-normalized) and MUST NOT declare a `range` (labels are
   * unordered).
   */
  readonly kind?: "enum";
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

// ── Raw data shape (as it appears in the JSON file) ──────────────────

interface RawCategoryField {
  name: string;
  type: "number" | "boolean" | "string";
  unit?: string;
  range?: [number, number];
  description: string;
  fact?: string;
  kind?: "enum";
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

// ── Registry: load-time validation + indexing ────────────────────────

const VALID_FIELD_TYPES: ReadonlyArray<CanonicalFieldSpec["type"]> = [
  "number",
  "boolean",
  "string",
];

const VALID_FIELD_KINDS: ReadonlyArray<NonNullable<CanonicalFieldSpec["kind"]>> = ["enum"];

/**
 * The validated, indexed, immutable category registry. Built once at
 * module load from the bundled data file (and rebuildable from any
 * conforming data object in tests via `buildCategoryRegistry`).
 */
export interface CategoryRegistry {
  /** All category schemas, in data-file order. */
  readonly all: ReadonlyArray<CategorySchema>;
  /** Category ids, in data-file order. */
  readonly ids: ReadonlyArray<AdapterCategory>;
  /** id → schema, O(1) lookup. */
  readonly byId: ReadonlyMap<AdapterCategory, CategorySchema>;
  /**
   * canonical field name → owning category id, O(1) reverse lookup.
   * Only UNIQUELY-declared names appear here — a shared-fact name
   * (declared by more than one category) is deliberately absent, so
   * `categoryForField` answers null for it (explicit ambiguity).
   */
  readonly fieldToCategory: ReadonlyMap<CanonicalFieldName, AdapterCategory>;
  /** canonical field name → fact id, for every field declaring one. */
  readonly fieldToFact: ReadonlyMap<CanonicalFieldName, string>;
  /** fact id → every category attesting it, in data-file order. */
  readonly factToCategories: ReadonlyMap<string, ReadonlyArray<AdapterCategory>>;
}

/**
 * Validate + index raw category data into an immutable registry.
 *
 * Pure function — exported so the loader can be exercised against
 * fixture data in tests (SYS-2500: prove the registry is genuinely
 * data-driven, not hardcoded). Throws on ANY structural violation so a
 * malformed JSON edit fails loudly at module load rather than producing
 * silent gaps at read time. The invariants enforced here are the ones
 * the old test suite asserted after the fact; making them load-time
 * guarantees is what lets the data file be the single source of truth.
 */
export function buildCategoryRegistry(raw: RawCategoryData): CategoryRegistry {
  if (!raw || typeof raw !== "object") {
    throw new Error("adapter category data: expected an object");
  }
  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion.length === 0) {
    throw new Error("adapter category data: missing schemaVersion");
  }
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) {
    throw new Error("adapter category data: categories must be a non-empty array");
  }

  const byId = new Map<AdapterCategory, CategorySchema>();
  const fieldToCategory = new Map<CanonicalFieldName, AdapterCategory>();
  const fieldToFact = new Map<CanonicalFieldName, string>();
  const factToCategories = new Map<string, AdapterCategory[]>();
  // Every declaration of a field name seen so far — the shared-fact
  // uniqueness rule needs the full picture, not just the first declarer.
  const declarations = new Map<
    CanonicalFieldName,
    { fact: string | undefined; kind: "enum" | undefined; categories: AdapterCategory[] }
  >();
  const tables = new Set<string>();
  const all: CategorySchema[] = [];

  for (const cat of raw.categories) {
    const where = `category "${cat?.id ?? "<unknown>"}"`;

    if (typeof cat.id !== "string" || cat.id.length === 0) {
      throw new Error("adapter category data: every category needs a non-empty id");
    }
    if (byId.has(cat.id)) {
      throw new Error(`adapter category data: duplicate category id "${cat.id}"`);
    }
    if (typeof cat.displayName !== "string" || cat.displayName.length === 0) {
      throw new Error(`adapter category data: ${where} needs a non-empty displayName`);
    }
    if (typeof cat.description !== "string" || cat.description.length === 0) {
      throw new Error(`adapter category data: ${where} needs a non-empty description`);
    }
    // Canonical tables live in the host's IHS namespace. Originally every
    // category stored into a dedicated `ihs_alt_data_*` table; since the
    // document-extraction categories (SYS-2998), a category may instead be
    // canonical over a promoted legacy sibling table (`ihsbankstatement`,
    // `ihsepfstatement`, ...) — so the invariant is the namespace prefix,
    // not the alt-data naming scheme.
    if (typeof cat.canonicalTable !== "string" || !/^ihs[a-z0-9_]*$/.test(cat.canonicalTable)) {
      throw new Error(
        `adapter category data: ${where} canonicalTable must be an "ihs"-prefixed table identifier (got "${cat.canonicalTable}")`,
      );
    }
    if (tables.has(cat.canonicalTable)) {
      throw new Error(
        `adapter category data: duplicate canonicalTable "${cat.canonicalTable}" (${where})`,
      );
    }
    if (!Array.isArray(cat.fields) || cat.fields.length === 0) {
      throw new Error(`adapter category data: ${where} must declare at least one field`);
    }

    const fields: CanonicalFieldSpec[] = [];
    for (const f of cat.fields) {
      if (typeof f.name !== "string" || f.name.length === 0) {
        throw new Error(`adapter category data: ${where} has a field with no name`);
      }
      if (f.fact !== undefined && (typeof f.fact !== "string" || f.fact.length === 0)) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) has an invalid fact — expected a non-empty string`,
        );
      }
      // Shared-fact uniqueness rule: a field name may be declared by
      // more than one category iff EVERY declaration carries the SAME
      // `fact` id — the declarations are then independent attestations
      // of one shared real-world fact. A name declared with a fact in
      // one place and without (or with a different fact) elsewhere is
      // the SYS-2722 drift pattern and is refused at load time.
      const prior = declarations.get(f.name);
      if (prior) {
        if (prior.categories.includes(cat.id)) {
          throw new Error(
            `adapter category data: ${where} declares field "${f.name}" more than once`,
          );
        }
        if (prior.fact === undefined || f.fact === undefined || prior.fact !== f.fact) {
          const describeFact = (fact: string | undefined): string =>
            fact === undefined ? "no fact" : `fact "${fact}"`;
          throw new Error(
            `adapter category data: canonical field "${f.name}" declared by more than one category ` +
              `(${prior.categories.join(" + ")} with ${describeFact(prior.fact)} + ${cat.id} with ` +
              `${describeFact(f.fact)}) — field names must be globally unique unless every ` +
              `declaring category attests the same fact`,
          );
        }
        // Same drift class as the fact rule: attestations of one fact
        // must agree on kind — an enum label in one category and a free
        // string in another are not comparable values of "the same
        // fact", and the disagreement-comparison feature would be
        // comparing apples to labels.
        if (prior.kind !== f.kind) {
          const describeKind = (kind: string | undefined): string =>
            kind === undefined ? "no kind" : `kind "${kind}"`;
          throw new Error(
            `adapter category data: canonical field "${f.name}" declared with ${describeKind(prior.kind)} ` +
              `by ${prior.categories.join(" + ")} but ${describeKind(f.kind)} by ${cat.id} — ` +
              `shared-fact attestations must agree on kind`,
          );
        }
      }
      if (f.fact !== undefined) {
        // A fact id is bound to exactly one field name registry-wide —
        // two different names attesting "the same fact" is drift by
        // another name (a fact must be comparable across its attesters
        // via one canonical field name).
        for (const [otherName, otherFact] of fieldToFact) {
          if (otherFact === f.fact && otherName !== f.name) {
            throw new Error(
              `adapter category data: fact "${f.fact}" is carried by two different field names ` +
                `("${otherName}" + "${f.name}") — a fact id must map to exactly one canonical field name`,
            );
          }
        }
      }
      if (!VALID_FIELD_TYPES.includes(f.type)) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) has invalid type "${f.type}"`,
        );
      }
      if (f.kind !== undefined) {
        if (!VALID_FIELD_KINDS.includes(f.kind)) {
          throw new Error(
            `adapter category data: field "${f.name}" (${where}) has invalid kind "${String(f.kind)}"`,
          );
        }
        if (f.type !== "string") {
          throw new Error(
            `adapter category data: field "${f.name}" (${where}) is kind "enum" but type "${f.type}" — enum labels are string-normalized, so an enum field must be type "string"`,
          );
        }
        if (f.range !== undefined) {
          throw new Error(
            `adapter category data: field "${f.name}" (${where}) is kind "enum" but declares a range — enum labels are unordered; ordering belongs to the consumer, never the data contract`,
          );
        }
      }
      if (typeof f.description !== "string" || f.description.length === 0) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) needs a non-empty description`,
        );
      }
      if (f.range !== undefined) {
        // Number.isFinite rejects non-numbers, NaN, and ±Infinity — a
        // typeof check alone would let [NaN, NaN] through (typeof NaN ===
        // "number" and NaN > NaN is false), silently corrupting any
        // downstream clamp that reads the range.
        if (
          !Array.isArray(f.range) ||
          f.range.length !== 2 ||
          !Number.isFinite(f.range[0]) ||
          !Number.isFinite(f.range[1]) ||
          f.range[0] > f.range[1]
        ) {
          throw new Error(
            `adapter category data: field "${f.name}" (${where}) has an invalid range — expected [lo, hi] with finite lo <= hi`,
          );
        }
      }

      const spec: CanonicalFieldSpec = Object.freeze({
        name: f.name,
        type: f.type,
        ...(f.unit !== undefined ? { unit: f.unit } : {}),
        ...(f.range !== undefined ? { range: Object.freeze([f.range[0], f.range[1]]) as readonly [number, number] } : {}),
        description: f.description,
        ...(f.fact !== undefined ? { fact: f.fact } : {}),
        ...(f.kind !== undefined ? { kind: f.kind } : {}),
      });
      fields.push(spec);
      if (prior) {
        prior.categories.push(cat.id);
        // The name is now shared — drop it from the unique-owner index
        // so categoryForField answers null (explicit ambiguity) rather
        // than silently privileging the first declarer.
        fieldToCategory.delete(f.name);
      } else {
        declarations.set(f.name, { fact: f.fact, kind: f.kind, categories: [cat.id] });
        fieldToCategory.set(f.name, cat.id);
      }
      if (f.fact !== undefined) {
        fieldToFact.set(f.name, f.fact);
        const attesters = factToCategories.get(f.fact);
        if (attesters) {
          attesters.push(cat.id);
        } else {
          factToCategories.set(f.fact, [cat.id]);
        }
      }
    }

    const schema: CategorySchema = Object.freeze({
      id: cat.id,
      displayName: cat.displayName,
      description: cat.description,
      canonicalTable: cat.canonicalTable,
      fields: Object.freeze(fields) as ReadonlyArray<CanonicalFieldSpec>,
    });
    byId.set(cat.id, schema);
    tables.add(cat.canonicalTable);
    all.push(schema);
  }

  return Object.freeze({
    all: Object.freeze(all) as ReadonlyArray<CategorySchema>,
    ids: Object.freeze(all.map((c) => c.id)) as ReadonlyArray<AdapterCategory>,
    byId,
    fieldToCategory,
    fieldToFact,
    factToCategories: new Map(
      [...factToCategories].map(([fact, cats]) => [
        fact,
        Object.freeze(cats) as ReadonlyArray<AdapterCategory>,
      ]),
    ),
  });
}

/**
 * The package's category registry — built + validated once at module
 * load from `data/adapter-categories.json`. A malformed data file
 * throws here, failing the import (and the build/test) loudly.
 */
const registry = buildCategoryRegistry(categoriesData as RawCategoryData);

/**
 * Every category id declared by this version of finsys-core, in
 * data-file order. The runtime equivalent of the old hardcoded union —
 * derived from the single source of truth rather than maintained by
 * hand. Treat order as unstable across versions.
 */
export const ADAPTER_CATEGORY_IDS: ReadonlyArray<AdapterCategory> = registry.ids;

/**
 * Look up a category schema by id. Throws if the id is unknown.
 */
export function categorySchemaOf(id: AdapterCategory): CategorySchema {
  const found = registry.byId.get(id);
  if (!found) {
    throw new Error(
      `Unknown adapter category: ${id}. Available: ${registry.ids.join(", ")}`,
    );
  }
  return found;
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
  return registry.all;
}

/**
 * Reverse lookup: which category declares a given canonical field?
 * Returns null if the field name isn't declared by any category in
 * this version of finsys-core — AND for shared-fact names (declared by
 * more than one category), where "the" category is genuinely ambiguous.
 * The null is deliberate: a caller holding a shared-fact name must
 * decide per-attestation, via `categoriesAttestingFact(factOf(name))`,
 * rather than being handed one arbitrary declarer. Useful when the
 * host app is reading canonical field values back from storage + wants
 * to identify the producing category for rendering. O(1).
 */
export function categoryForField(field: CanonicalFieldName): AdapterCategory | null {
  return registry.fieldToCategory.get(field) ?? null;
}

/**
 * The fact id a canonical field attests, or null when the field
 * declares no fact (or isn't declared at all). By convention the fact
 * id equals the field name, but callers must not assume it — read it
 * from here. O(1).
 */
export function factOf(field: CanonicalFieldName): string | null {
  return registry.fieldToFact.get(field) ?? null;
}

/**
 * Every category attesting a given shared fact, in data-file order.
 * Empty for an unknown fact id. This is the lookup the disagreement-
 * comparison feature keys on: each attesting category's value for the
 * fact's field is an independent observation of the same real-world
 * fact, so cross-category mismatches are surfaceable.
 */
export function categoriesAttestingFact(factId: string): ReadonlyArray<AdapterCategory> {
  return registry.factToCategories.get(factId) ?? [];
}

/**
 * Runtime membership check — is `id` a category declared by this
 * version of finsys-core? Use this at trust boundaries (parsing a
 * manifest, validating an API parameter) now that `AdapterCategory` is
 * an open `string` and the compiler can no longer reject unknown ids.
 */
export function isAdapterCategory(id: string): boolean {
  return registry.byId.has(id);
}

/**
 * Assert membership: returns `id` if it names a declared category,
 * throws otherwise. Note this is a RUNTIME guard only — `AdapterCategory`
 * is an open `string`, so there is no type-level narrowing to apply.
 * The companion to `isAdapterCategory` for call sites that want a hard
 * failure (e.g. the host rejecting a manifest whose category isn't in
 * this finsys-core version's catalogue).
 */
export function assertAdapterCategory(id: string): AdapterCategory {
  if (!registry.byId.has(id)) {
    throw new Error(
      `Unknown adapter category: ${id}. Available: ${registry.ids.join(", ")}`,
    );
  }
  return id;
}
