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
   * SYS-3333: the name this field had in the LEGACY flat vocabulary, when
   * the canonical rename moved it.
   *
   * It exists because the two vocabularies were identical until the rename,
   * and code quietly relied on that. `isMonetaryField` in ihs-processing.ts
   * is the worked example: it is handed a FLAT column name and matches it
   * against the set of CANONICAL names declared `kind: "money"`. That worked
   * only while `payslipGrossPay` was both. Rename the canonical side alone
   * and the lookup silently misses — a money value renders as a bare number
   * beside its denominated neighbours, which is the precise failure
   * SYS-3249's denomination work exists to prevent. No exception, no log
   * line, just a wrong-looking table.
   *
   * So the alias lives ON the field it renames rather than in a side map: a
   * side map can drift, and this one is load-bearing for as long as the flat
   * columns exist (Phase 6 drops them, and this goes with them).
   *
   * A legacyName is NOT a second canonical name. It never widens what an
   * adapter may `produce`, it is not addressable in an eval model, and it
   * carries no fact — it is a one-way lookup for code bridging the two
   * vocabularies during the transition.
   */
  readonly legacyName?: string;
  /**
   * Field kind — a semantic refinement of `type`.
   *
   * `"enum"`: the field's value is one label out of a closed set. The
   * category declares ONLY that the field is enumerated — never the
   * values, never an ordering. Value sets are vendor territory: each
   * adapter declares the exact labels it emits in its manifest's
   * `enumValues` (host-validated), because two vendors implementing the
   * same category may bucket differently. Ordering and scoring
   * interpretation live even further out, in the consumer (an eval
   * model's per-value mapping) — an enum label is data, what it is
   * worth is opinion, and opinions don't belong in the data contract.
   * An enum field MUST be `type: "string"` (labels are
   * string-normalized) and MUST NOT declare a `range` (labels are
   * unordered).
   *
   * `"money"` (SYS-3249): the field's value is a monetary amount, and is
   * therefore INCOMPLETE ON ITS OWN. The primitive is still a number —
   * which is why this is a refinement of `type` rather than a member of
   * it — but the number means nothing without a denomination, and the
   * denomination belongs to the observation, not to the field. One
   * source can report several currencies in a single document, so a
   * field-level currency could never be right for more than one of them.
   * The denomination travels with the value on its provenance envelope
   * (`IhsFieldProvenance.currency`).
   *
   * A money field MUST be `type: "number"`, MUST NOT declare a `unit`
   * (there is no unit that is true of the quantity — see
   * `VALID_FIELD_UNITS`), and MUST NOT declare a `range`: a numeric
   * bound on money is denominated by definition, so it can only ever be
   * correct in one currency. `telcoArpuMyr [0, 10000]` was a sane
   * Malaysian bound and is roughly twenty times too small in VND, where
   * ARPU runs about 200,000 — every non-MY row would have failed a
   * constraint the data contract asserted about all of them.
   */
  readonly kind?: "enum" | "money";
  /**
   * SYS-3164: the field's confidentiality class. The ONLY way to declare
   * one is to opt OUT.
   *
   * ABSENT MEANS SENSITIVE. There is deliberately no `"sensitive"`
   * spelling: a field is sensitive unless someone has looked at it and
   * said otherwise, so the failure mode of forgetting is a field that is
   * over-protected, never one that is silently exposed. That polarity is
   * not a preference — it is the lesson already recorded in finhub's
   * SYS-2806 audit-redaction allowlist, where "a newly added IHS column
   * that's never classified here defaults to sensitive, not safe" is the
   * property that makes the list safe to add columns around. An opt-in
   * `sensitive: true` flag inverts exactly that: every field anyone
   * forgot to mark ships in the clear, and neither the data nor the
   * types surface it.
   *
   * What consumes it: canonical storage encrypts sensitive fields at
   * rest. Access-time gating (`fieldAuthorizations`) is its sibling —
   * that says who may read a field, this says how it is held when
   * nobody is reading it.
   *
   * TWO LIMITS, so this is not read as more coverage than it is:
   *
   * It reaches CANONICAL data only. `confidentiality` lives on a
   * category's field spec, and no category is canonical over the legacy
   * wide `ihs` table — the categories cover the `ihs_alt_data_*` tables
   * and the promoted document tables. A field still living in an `ihs`
   * column is untouched by this until the adapter transition relocates
   * it.
   *
   * And the raw payload is a sibling hole. The same values are stored
   * again, unencrypted, in the host's raw-payload table (see
   * docs/security-model.md: "Assume the raw payload is durably stored"),
   * under its own retention window. Encrypting the canonical column
   * while the identical value sits in the clear next to it makes the
   * guarantee "at rest, in one of two places" — so the consumer that
   * honours this must cover both, or say plainly that it does not.
   *
   * Shared-fact attestations must AGREE on this (enforced at load): one
   * real-world fact cannot be sensitive when a document attests it and
   * non-sensitive when a form does.
   *
   * SYS-3171: ALWAYS PRESENT on a built spec, even though authoring stays
   * opt-out-only (see RawCategoryField, where it remains optional and
   * `"sensitive"` is still unspellable). The asymmetry is the point.
   *
   * The registry is serialised verbatim to finhub and finsys-client, and
   * on that wire "absent means sensitive" is carried by NOTHING — a
   * consumer writing `if (field.confidentiality) protect()` reads exactly
   * backwards and compiles clean. Emitting the value explicitly makes the
   * invariant structural rather than documented: every read surface,
   * including the JSON, states the class outright.
   */
  readonly confidentiality: "sensitive" | "non-sensitive";
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
  /**
   * SYS-3333: the id this category had before it was renamed.
   *
   * The transition has to be COMPATIBLE: a manifest that registered yesterday
   * must register today. So a legacy id is not decoration — the host resolves
   * it, warns, and proceeds, rather than refusing a manifest at boot for a
   * name the operator never chose to change.
   *
   * A legacy id may never collide with a LIVE id (enforced below). That rule
   * is why the two bank categories kept their names in this release: reusing
   * `bank-statement` for the document category would have made a pre-sweep
   * manifest saying `bank-statement` genuinely ambiguous — the partner feed
   * before, the document after — with no correct resolution. Renaming them
   * waits for the deprecation window to close.
   */
  readonly legacyId?: string;
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
  legacyName?: string;
  kind?: "enum" | "money";
  confidentiality?: "non-sensitive";
}

interface RawCategory {
  id: string;
  legacyId?: string;
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

const VALID_FIELD_KINDS: ReadonlyArray<NonNullable<CanonicalFieldSpec["kind"]>> = [
  "enum",
  "money",
];

/**
 * SYS-3249: the closed set of units a field may declare, and — more to
 * the point — the set a currency can never join.
 *
 * Every member is an INTRINSIC unit of measure: a property of the
 * quantity itself, true wherever it is observed. A currency is not that.
 * It is a property of the OBSERVATION, it varies between two values of
 * the same field, and one source can report several in a single document
 * (an FX transaction on a bank statement, cross-border settlement on a
 * payment network). Declaring `unit: "MYR"` on a field said something
 * about the field that was only ever true of Malaysian data, and 143
 * fields said it.
 *
 * Money is expressed as `kind: "money"` instead, and the denomination
 * travels with the value on its provenance envelope.
 *
 * The list is closed and validated at load precisely so re-declaring a
 * currency here — or helpfully adding "VND" alongside — is a load error
 * rather than something review has to catch. That is the whole control:
 * `unit` is otherwise documentation-only (its sole consumer is the spec
 * builder passing it through), so nothing else would ever notice.
 */
const VALID_FIELD_UNITS: ReadonlyArray<string> = [
  "ratio",
  "months",
  "days",
  "hours",
  "count",
  "meters",
  "deg",
  "rating",
  "score",
];

/**
 * SYS-3164. One entry, and that is the point — see `confidentiality` on
 * `CanonicalFieldSpec`. "sensitive" is unspellable because it is the
 * default; the only declarable value is the opt-out.
 */
/**
 * SYS-3333: a canonical field name must not encode its denomination.
 * ISO-4217-shaped suffix, matched title-case because that is how these names
 * were formed (`telcoArpuMyr`, `arTotalOutstandingMyr`).
 */
const CURRENCY_SUFFIXED = /(Myr|Usd|Eur|Gbp|Sgd|Vnd|Thb|Idr|Php|Jpy|Cny|Aud)$/;

/**
 * SYS-3333: the retired window convention. `T3`/`T12` said the same thing as
 * `3m`/`12m` in a second dialect, and the T-form additionally collides with
 * the legacy flat T-suffix (`revenueT1`), which means a period position, not a
 * window length — two different ideas wearing one spelling.
 */
const T_WINDOW_SUFFIXED = /T\d+$/;

const VALID_FIELD_CONFIDENTIALITY: ReadonlyArray<
  NonNullable<CanonicalFieldSpec["confidentiality"]>
> = ["non-sensitive"];

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
  /**
   * SYS-3333: legacy flat name → the canonical name that replaced it.
   *
   * One-way and transitional. It exists so code that is handed a FLAT
   * column name can reach the canonical field's declarations (is it money?
   * what kind? what fact?) without every such call site growing its own
   * hardcoded rename table. Empty for a field that was never renamed.
   */
  readonly legacyToCanonical: ReadonlyMap<string, CanonicalFieldName>;
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
  // SYS-3333: legacy flat name -> canonical name. Validated below against
  // BOTH namespaces: a legacy name may not shadow a live canonical name
  // (the lookup would be ambiguous), and two fields may not claim the same
  // legacy name (the lookup would be wrong for one of them).
  const legacyToCanonical = new Map<string, CanonicalFieldName>();
  // Every declaration of a field name seen so far — the shared-fact
  // uniqueness rule needs the full picture, not just the first declarer.
  const declarations = new Map<
    CanonicalFieldName,
    {
      fact: string | undefined;
      kind: RawCategoryField["kind"];
      confidentiality: "non-sensitive" | undefined;
      categories: AdapterCategory[];
    }
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
      if (
        f.legacyName !== undefined &&
        (typeof f.legacyName !== "string" || f.legacyName.length === 0)
      ) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) has an invalid legacyName — expected a non-empty string`,
        );
      }
      if (f.legacyName !== undefined && f.legacyName === f.name) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) declares a legacyName identical to its ` +
            `canonical name — a legacyName records a rename, so an unchanged name must not declare one`,
        );
      }
      // SYS-3333 — the naming conventions, ENFORCED rather than merely applied.
      //
      // The sweep that produced this vocabulary found 5 currency-suffixed
      // names, 15 window-suffixed names in TWO conventions, and ~50 names
      // repeating their own source. None of that was anyone's decision; it
      // accumulated because nothing refused it. A one-time cleanup with no
      // guard is a cleanup that happens again in a year, and this vocabulary
      // is about to be read by a regulated credit bureau.
      //
      // Only mechanically-decidable rules live here. "A name should not repeat
      // its source" needs judgement (`statementDate` in a bank-statement
      // category is fine) and is asserted in the tests instead — a load-time
      // throw that misfires is worse than no rule, because the next person
      // works around it.
      if (CURRENCY_SUFFIXED.test(f.name)) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) bakes a currency into its name. A ` +
            `denomination belongs to the OBSERVATION, not the field (SYS-3249) — one source can report ` +
            `several currencies in one document, so a field-level currency can only ever be right for ` +
            `one of them. Declare kind: "money" and carry the currency on the provenance envelope.`,
        );
      }
      if (T_WINDOW_SUFFIXED.test(f.name)) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) uses the T<n> window convention. The ` +
            `registry has one convention for a time window and it is the unit-suffixed form — 3m, 12m, ` +
            `24m, 90d. Two conventions for one idea is how a reader stops trusting either.`,
        );
      }
      // Hoisted ABOVE the shared-fact block deliberately. When an invalid
      // value arrives on a SECOND declarer, the agreement check would fire
      // first and report `declared sensitive (default) by a but "sensitive"
      // by b — must agree on confidentiality`, which reads as though
      // "sensitive" were a legal value that merely disagrees. That is the
      // exact opposite of the rule, and would cost the next reader an hour.
      // The value check has no dependency on `prior`, so it belongs first.
      if (f.confidentiality !== undefined && !VALID_FIELD_CONFIDENTIALITY.includes(f.confidentiality)) {
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) has invalid confidentiality ` +
            `"${String(f.confidentiality)}" — the only declarable value is "non-sensitive"; ` +
            `sensitive is the default and is expressed by omitting the property`,
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
        // SYS-3164: same drift class again. One real-world fact cannot be
        // sensitive when a document attests it and non-sensitive when a
        // form does — storage would then hold the two attestations of one
        // fact under different protection, and which one you got would
        // depend on which source happened to write last.
        if (prior.confidentiality !== f.confidentiality) {
          const describeConf = (c: string | undefined): string =>
            c === undefined ? "sensitive (default)" : `"${c}"`;
          throw new Error(
            `adapter category data: canonical field "${f.name}" declared ${describeConf(prior.confidentiality)} ` +
              `by ${prior.categories.join(" + ")} but ${describeConf(f.confidentiality)} by ${cat.id} — ` +
              `shared-fact attestations must agree on confidentiality`,
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
      // SYS-3249: `unit` is checked for EVERY field, kind or not. It was
      // free-form until now and read by nothing but the spec builder, so
      // an unusable value could sit in the contract indefinitely without
      // anything noticing — which is exactly what 143 fields declaring
      // `unit: "MYR"` did. Closing the set is the control.
      if (f.unit !== undefined && !VALID_FIELD_UNITS.includes(f.unit)) {
        const looksLikeCurrency = /^[A-Z]{3}$/.test(f.unit);
        throw new Error(
          `adapter category data: field "${f.name}" (${where}) has invalid unit "${String(f.unit)}" — ` +
            (looksLikeCurrency
              ? `a currency is not a unit of measure. It is a property of the OBSERVATION, not of the field: ` +
                `one source can report several currencies in one document, so no field-level currency can be ` +
                `right for more than one of them. Declare kind "money" instead and let the denomination travel ` +
                `with the value on its provenance envelope.`
              : `expected one of ${VALID_FIELD_UNITS.join(", ")}`),
        );
      }
      if (f.kind !== undefined) {
        if (!VALID_FIELD_KINDS.includes(f.kind)) {
          throw new Error(
            `adapter category data: field "${f.name}" (${where}) has invalid kind "${String(f.kind)}"`,
          );
        }
        // Per-kind constraints. Split by kind rather than sharing a
        // block: the two kinds refine `type` in opposite directions
        // (enum narrows a string, money annotates a number), so a shared
        // check would have to be written as a disjunction that is true
        // for neither reason.
        if (f.kind === "enum") {
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
        if (f.kind === "money") {
          if (f.type !== "number") {
            throw new Error(
              `adapter category data: field "${f.name}" (${where}) is kind "money" but type "${f.type}" — a monetary amount's primitive is a number; the denomination is carried separately, on the value's provenance`,
            );
          }
          if (f.unit !== undefined) {
            throw new Error(
              `adapter category data: field "${f.name}" (${where}) is kind "money" and declares unit "${String(f.unit)}" — money has no intrinsic unit. The denomination belongs to the observation and travels on its provenance envelope`,
            );
          }
          if (f.range !== undefined) {
            throw new Error(
              `adapter category data: field "${f.name}" (${where}) is kind "money" and declares a range — a numeric bound on money is denominated by definition, so it can only ever be correct in one currency`,
            );
          }
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
        ...(f.legacyName !== undefined ? { legacyName: f.legacyName } : {}),
        ...(f.kind !== undefined ? { kind: f.kind } : {}),
        // SYS-3171: resolved, never conditional — absence in the data file
        // means sensitive, and the built spec says so out loud.
        confidentiality: f.confidentiality ?? "sensitive",
      });
      fields.push(spec);
      if (prior) {
        prior.categories.push(cat.id);
        // The name is now shared — drop it from the unique-owner index
        // so categoryForField answers null (explicit ambiguity) rather
        // than silently privileging the first declarer.
        fieldToCategory.delete(f.name);
      } else {
        declarations.set(f.name, {
          fact: f.fact,
          kind: f.kind,
          confidentiality: f.confidentiality,
          categories: [cat.id],
        });
        fieldToCategory.set(f.name, cat.id);
      }
      if (f.legacyName !== undefined) {
        const claimed = legacyToCanonical.get(f.legacyName);
        if (claimed !== undefined && claimed !== f.name) {
          throw new Error(
            `adapter category data: legacyName "${f.legacyName}" is claimed by two different canonical ` +
              `fields ("${claimed}" + "${f.name}") — a legacy name must resolve to exactly one canonical field`,
          );
        }
        legacyToCanonical.set(f.legacyName, f.name);
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
      ...(cat.legacyId !== undefined ? { legacyId: cat.legacyId } : {}),
      fields: Object.freeze(fields) as ReadonlyArray<CanonicalFieldSpec>,
    });
    byId.set(cat.id, schema);
    tables.add(cat.canonicalTable);
    all.push(schema);
  }

  // SYS-3333 — a legacy category id must resolve to exactly one live category,
  // and must not shadow one. Checked before the field-level pass so a
  // structurally impossible alias fails on its own terms.
  for (const cat of raw.categories) {
    if (cat.legacyId === undefined) continue;
    if (typeof cat.legacyId !== "string" || cat.legacyId.length === 0) {
      throw new Error(`adapter category data: category "${cat.id}" has an invalid legacyId`);
    }
    if (cat.legacyId === cat.id) {
      throw new Error(
        `adapter category data: category "${cat.id}" declares a legacyId identical to its id — ` +
          `a legacyId records a rename, so an unchanged id must not declare one`,
      );
    }
    if (raw.categories.some((o) => o.id === cat.legacyId)) {
      throw new Error(
        `adapter category data: legacyId "${cat.legacyId}" (on "${cat.id}") is also a LIVE category ` +
          `id — an alias that collides with a live id cannot be resolved, because a manifest naming ` +
          `it could mean either category`,
      );
    }
    const twin = raw.categories.find((o) => o !== cat && o.legacyId === cat.legacyId);
    if (twin) {
      throw new Error(
        `adapter category data: legacyId "${cat.legacyId}" is claimed by two categories ` +
          `("${twin.id}" + "${cat.id}")`,
      );
    }
  }

  // SYS-3333 — deferred to here on purpose. A legacy alias may legally be
  // declared BEFORE the canonical field that would shadow it appears later in
  // the file, so the check is only sound once every category is indexed.
  for (const [legacy, canonical] of legacyToCanonical) {
    if (declarations.has(legacy)) {
      throw new Error(
        `adapter category data: legacyName "${legacy}" (on "${canonical}") is also a LIVE canonical ` +
          `field name — a legacy alias must not shadow a name still in the vocabulary, or a lookup ` +
          `cannot say which one it meant`,
      );
    }
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
    legacyToCanonical,
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
 * SYS-3164: is this field of this category sensitive?
 *
 * Answers TRUE for anything not explicitly declared `"non-sensitive"` —
 * including a field name the category does not declare at all. That last
 * part is deliberate: a caller asking about an unknown field is either
 * mid-rename or wrong, and the safe answer to "should I protect this?"
 * when you do not recognize it is yes. `categorySchemaOf` still throws
 * for an unknown CATEGORY, because that is a wiring error rather than a
 * data question.
 */
export function isFieldSensitive(id: AdapterCategory, field: CanonicalFieldName): boolean {
  const spec = categorySchemaOf(id).fields.find((f) => f.name === field);
  return spec?.confidentiality !== "non-sensitive";
}

/**
 * SYS-3164: every field of this category that is sensitive — i.e. every
 * field that did not opt out. The complement of the declared
 * `"non-sensitive"` set, so a newly added field appears here until
 * someone classifies it.
 */
export function sensitiveFieldsOf(id: AdapterCategory): ReadonlyArray<CanonicalFieldName> {
  return categorySchemaOf(id)
    .fields.filter((f) => f.confidentiality !== "non-sensitive")
    .map((f) => f.name);
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
 * SYS-3333: resolve a name from EITHER vocabulary to the canonical one.
 *
 * Returns `name` unchanged when it is already canonical, the canonical name
 * when `name` is a recorded legacy alias, and null when it is neither. The
 * identity case is deliberate: callers bridging the two vocabularies are
 * handed a mix, and forcing each one to try canonical-first-then-alias is how
 * a call site ends up with its own private rename table.
 *
 * TRANSITIONAL. It exists because the legacy flat columns still exist; it
 * goes when they do (Phase 6). Do not build new addressing on it — a legacy
 * name carries no fact, is not `produce`-able by an adapter, and is not
 * addressable in an eval model.
 */
export function resolveCanonicalCategoryId(id: string): AdapterCategory | null {
  if (registry.byId.has(id)) return id;
  for (const c of registry.all) {
    if (c.legacyId === id) return c.id;
  }
  return null;
}

/**
 * SYS-3333: true when `id` is a RETIRED category id rather than a live one.
 *
 * Callers use this to decide whether to emit a deprecation warning — the
 * resolution itself is the same either way, and a caller that cannot tell the
 * two apart either warns on every call or on none.
 */
export function isLegacyCategoryId(id: string): boolean {
  return !registry.byId.has(id) && registry.all.some((c) => c.legacyId === id);
}

export function resolveCanonicalFieldName(name: string): CanonicalFieldName | null {
  if (registry.fieldToCategory.has(name) || registry.fieldToFact.has(name)) return name;
  const viaLegacy = registry.legacyToCanonical.get(name);
  if (viaLegacy !== undefined) return viaLegacy;
  // A name can be canonical, shared-fact, AND absent from both indexes only
  // if it is uniquely declared with no fact — fieldToCategory covers that —
  // so reaching here means genuinely unknown.
  return null;
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
