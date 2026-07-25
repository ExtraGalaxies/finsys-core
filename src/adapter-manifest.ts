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
 * Adapter manifest — the declarative descriptor every adapter ships
 * alongside its implementation. The host app's discovery mechanism
 * (SYS-2444) reads `manifest.json` from each adapter directory, validates
 * it against the JSON-schema in `schema/adapter-manifest.schema.json`,
 * and uses the manifest to construct + register the runtime adapter.
 *
 * Two adapter flavours both use this manifest shape:
 *
 *   1. Declarative JSON-only adapter (no TypeScript code) — `manifest.json`
 *      includes a `fieldMap` declaring source-path → canonical-field
 *      translations. The host's adapter runner applies the mapping +
 *      transforms generically. Suitable for partners whose API maps
 *      cleanly to canonical fields with rename + simple transforms.
 *
 *   2. TypeScript adapter — `manifest.json` includes an `entryPoint`
 *      pointing at an `extract.ts` (or compiled `.js`) module that
 *      exports a function implementing the `SourceAdapter#extract`
 *      contract. Used when the source needs OAuth, multi-endpoint
 *      merging, OCR pipelines, or partner-version negotiation.
 *
 * The JSON-schema (`schema/adapter-manifest.schema.json`) is the
 * authoritative format; this TypeScript type mirrors it. They MUST
 * stay in sync — when one changes, change the other.
 */

import type { AdapterCategory, CanonicalFieldName } from "./adapter-categories.js";

/**
 * Top-level manifest shape. Mirrors `schema/adapter-manifest.schema.json`.
 */
export interface AdapterManifest {
  /** Manifest format version. Bump this file's schema → bump this field. */
  readonly manifestVersion: 1;

  /**
   * Globally unique adapter id. Conventional pattern:
   * `<vendor>-<category-short>-v<n>` (e.g. `example-telco-v1`). The id is
   * what `SourceAdapter#id` returns + what provenance records pin to.
   */
  readonly id: string;

  /** Human-readable label rendered in operator UIs. */
  readonly displayName: string;

  /**
   * Generic category this adapter implements. Determines which
   * canonical fields the adapter is allowed to produce + which
   * canonical sibling table its output is persisted into.
   */
  readonly category: AdapterCategory;

  /**
   * Monotonic version per adapter. Bump on any change to payload shape,
   * field-mapping logic, or output semantics. Multiple versions of the
   * same adapter family MAY coexist in a deployment (deployment-time
   * pin).
   */
  readonly version: number;

  /**
   * Which canonical fields (subset of the category's field set) this
   * adapter promises to produce. The host validates at registration
   * time that every entry is declared by `categoryFieldsOf(category)`;
   * adapters promising out-of-category fields are refused.
   */
  readonly produces: ReadonlyArray<CanonicalFieldName>;

  /**
   * Adapter implementation flavour. Discriminator drives the rest of
   * the manifest shape.
   *
   *   - `declarative` — JSON-only adapter; `fieldMap` is required, no
   *     code is loaded.
   *   - `typescript` — TS/JS adapter; `entryPoint` is required, the
   *     host imports it dynamically.
   *   - `form-intake` — SYS-2501: data-only adapter declaring
   *     form-field-id → canonical-field mappings. No code is loaded and
   *     no fetch()/extract() ever runs; the host's form submission
   *     handler IS the runtime, and this manifest is how a
   *     borrower-entered scalar becomes a canonical, provenance-carrying
   *     field instead of a hand-wired column write.
   *   - `manual-override` — SYS-2501: data-only adapter declaring that
   *     this category's fields may be operator-overridden
   *     post-extraction. `produces` IS the override surface (a separate
   *     list could only duplicate or contradict it); the host's
   *     override endpoints gate on membership.
   *   - `extraction-pipeline` — SYS-2998: declaration-only adapter whose
   *     implementation IS the host application's own document-extraction
   *     pipeline. No code is loaded and neither fetch() nor extract()
   *     ever runs — the host's pipeline writes the canonical rows and
   *     records the adapter runs itself; the manifest exists purely as
   *     the declaration plane (produces, cardinality,
   *     fieldAuthorizations) for data the host was already producing.
   *   - `external-assertion` — SYS-3036 (ownership moved here from a
   *     host-local extension): declaration-only adapter that is executed
   *     entirely OUTSIDE the host. An externally-orchestrated process
   *     completes its own ceremony/extraction and PUSHES the result to
   *     the host's assertion-ingest surface. No code is loaded and
   *     neither fetch() nor extract() ever runs — the same
   *     declaration-only shape as `form-intake`/`manual-override`/
   *     `extraction-pipeline`, but data arrives via an external push
   *     rather than the host's own pipeline, form submission, or a
   *     dynamic-imported/declarative extract() call.
   */
  readonly implementation:
    | DeclarativeImplementation
    | TypescriptImplementation
    | FormIntakeImplementation
    | ManualOverrideImplementation
    | ExtractionPipelineImplementation
    | ExternalAssertionImplementation;

  /**
   * SYS-2502: explicit instance cardinality.
   *
   *   - `single` — at most one instance per applicant; extract() returns
   *     one AdapterExtraction with `instanceKey: ""`.
   *   - `multi` — unbounded instances per applicant, each with a stable,
   *     non-empty instanceKey.
   *
   * OPTIONAL for backward compatibility: manifests written before this
   * field existed rely on the original implicit convention
   * (instanceKey `""` → single, non-empty → multi), and the host infers
   * accordingly when the field is absent. New manifests should declare
   * it — an explicit declaration lets the host REJECT a mismatched
   * extraction (a multi-keyed instance from a declared-single adapter,
   * or vice versa) at persistence time instead of silently storing it.
   */
  readonly cardinality?: "single" | "multi";

  /**
   * SYS-2502: per-applicant singleton fields on a multi-instance
   * category — fields whose value describes the APPLICANT (one value
   * regardless of how many instances exist) rather than the instance,
   * e.g. accountHolderName on bank statements. Every entry MUST also
   * appear in `produces` (host validates at registration, same as
   * `produces` ⊆ category fields). Only meaningful when cardinality is
   * `multi`; the host treats a singleton field's value as shared across
   * the instance set.
   */
  readonly singletonFields?: ReadonlyArray<CanonicalFieldName>;

  /**
   * v2.7.0 — partner-specific identity fields the adapter needs from
   * the IHS row when fetch() is invoked. Strings name the keys that
   * MUST be present on the ApplicantIdentity payload — the host
   * validates per-applicant before calling fetch() and skips the
   * adapter (with a logged warning) if any required field is missing.
   *
   * Examples:
   *   - Telco adapter: `["ic", "msisdn"]`
   *   - Payment-network adapter: `["businessRegistrationNumber"]`
   *   - Bank-statement-from-OCR adapter: `[]` (no fetch — extract
   *     reads from FinXtract output staged elsewhere)
   *
   * Omit entirely (or use empty array) for adapters that don't
   * implement fetch() — the host then passes an empty raw payload
   * to extract() and the adapter is responsible for sourcing data
   * via some other path (FinXtract output, webhook ingest, etc.).
   *
   * Core identity fields (`ihsId`, `ic`, `fullName`) are always
   * present — declaring them is harmless but unnecessary.
   */
  readonly requiredIdentityFields?: ReadonlyArray<string>;

  /**
   * SYS-2503: declarative per-field authorization gating. Keyed by
   * canonical field name (every key MUST also appear in `produces` —
   * host validates at registration, same as `singletonFields`).
   *
   * Semantics, enforced by the HOST at read time (the manifest only
   * declares):
   *
   *   - No entry for a field → visible to every reader (gating is
   *     strictly opt-in; pre-existing manifests are unaffected).
   *   - An entry restricts: the reader must satisfy EVERY dimension
   *     the entry declares (AND across dimensions), matching ANY value
   *     within a dimension's list (OR within a list).
   *   - `lenderRoles` — reader's lender-role identifier must be listed.
   *   - `programIds` — the application's program must be listed.
   *
   * Both dimensions are host-interpreted opaque strings: core neither
   * knows nor validates what a "role" or "program id" is, keeping the
   * contract deployment-agnostic. An entry must declare at least one
   * dimension, and a declared dimension must be non-empty — an empty
   * list would read as deny-all, which is better expressed by simply
   * not producing the field.
   */
  readonly fieldAuthorizations?: Readonly<
    Partial<Record<CanonicalFieldName, FieldAuthorization>>
  >;

  /**
   * SYS-3002: ordered period declarations — the contract for the
   * period axis of this adapter's category.
   *
   * The period axis is ordered BY CONTRACT: `periodN` is a POSITIONAL
   * identifier into this array. Numbering is 1-BASED — period1 is the
   * FIRST declared period (array index 0); there is no period0.
   * Position is the period's IDENTITY: two extractions' period1 values
   * are comparable because they occupy the same contractual slot, not
   * because their dates match.
   *
   * Declared positions may overlap, nest, vary in length, or be
   * staggered — e.g. period1 = an annual table, periods 2–5 = the four
   * quarters overlapping it. The declaration makes no statement about
   * dates; each extraction-time period carries its own dated metadata
   * (see `PeriodValues.start`/`end`) for display and temporal
   * reasoning, never for identity. Periods are scoped WITHIN one
   * instance: one document's period1 and another document's period1
   * are unrelated data points.
   *
   * ABSENT means the single-period convention: the adapter's output
   * has exactly one implicit period, and instance-level `values` is
   * that period's value set. Single-period categories (bank
   * statements, EPF, payslips) never need to declare. Non-empty when
   * present — declaring zero periods would contradict the implicit
   * single-period convention, so the schema requires at least one
   * entry.
   *
   * The motivating consumer is financial statements — one document
   * carries period1 (its current fiscal year) plus period2 (its prior
   * comparative year) — but any implementation type may declare
   * periods: the axis is a property of the contract, not of how the
   * adapter is implemented.
   */
  readonly periods?: ReadonlyArray<PeriodDeclaration>;

  /**
   * Vendor-specific value sets for the enum-kind fields this adapter
   * produces. The category declares only THAT a field is enumerated
   * (`kind: "enum"` — no values, no ordering); the manifest declares
   * exactly WHICH labels this vendor emits, because two vendors
   * implementing the same category may bucket differently. Scoring
   * interpretation lives further out still, in the consumer (an eval
   * model's per-value mapping with a mandatory fallback) — never here.
   *
   * Host-validated at registration (same posture as `produces` ⊆
   * category fields):
   *   - every key MUST appear in `produces`;
   *   - every key MUST be declared `kind: "enum"` by the adapter's
   *     category — a non-enum field with declared values is refused;
   *   - every enum-kind field in `produces` MUST have an entry here —
   *     an adapter that promises an enum field but not its labels
   *     gives clients nothing to render or map against;
   *   - each value set is a non-empty array of unique, string-
   *     normalized labels (non-empty, no leading/trailing whitespace).
   *
   * At runtime the adapter emits labels from its declared set
   * VERBATIM; the host refuses out-of-set values at ingest, so a
   * vendor-side vocabulary change is a loud manifest-version bump,
   * never silent data drift. Clients (form-spec and eval-model
   * editors) read these sets through the registry-metadata surface to
   * offer the labels without hardcoding any vendor's vocabulary.
   *
   * Matching is EXACT-STRING — case and whitespace variations from a
   * declared label are treated as distinct (and therefore out-of-set),
   * deliberately. `uniqueItems` at the schema layer is likewise
   * exact-match, so e.g. `["High", "high"]` is a legal (if unusual)
   * two-label set; nothing here folds case or reconciles near-miss
   * spelling. Silently normalizing would band-aid over a vendor-side
   * inconsistency instead of surfacing it — a vendor emitting `"high"`
   * when its manifest declares `"High"` is a vendor bug that should be
   * refused loudly, not coerced into matching. Vendors own their exact
   * label byte-for-byte; hosts never guess at reconciliation.
   */
  readonly enumValues?: Readonly<Record<CanonicalFieldName, ReadonlyArray<string>>>;

  /**
   * Optional free-form notes — useful for partner-side documentation
   * (where to find the adapter's source, who owns it, what version of
   * the partner API it expects). Not consumed by the runtime.
   */
  readonly notes?: string;
}

/**
 * SYS-3002: one declared period on the adapter's period axis. See
 * {@link AdapterManifest.periods} for the positional (1-based) identity
 * semantics — the entry's position in the `periods` array IS the
 * period's identity; the entry itself only labels the role.
 */
export interface PeriodDeclaration {
  /**
   * Human role label for the position, e.g. "Current fiscal year",
   * "Prior comparative year". Rendered in operator UIs; carries no
   * identity semantics.
   */
  readonly name: string;

  /** Optional longer description of what this position holds. */
  readonly description?: string;
}

/**
 * SYS-2503: one field's authorization gate. See
 * {@link AdapterManifest.fieldAuthorizations} for semantics.
 *
 * A union rather than an all-optional interface so a no-op gate (`{}`)
 * is unrepresentable at COMPILE time too, not just rejected by the JSON
 * schema's `minProperties: 1` at runtime — the TS type and the schema
 * enforce the same invariant at their respective layers.
 */
export type FieldAuthorization =
  | {
      readonly lenderRoles: ReadonlyArray<string>;
      readonly programIds?: ReadonlyArray<string>;
    }
  | {
      readonly lenderRoles?: ReadonlyArray<string>;
      readonly programIds: ReadonlyArray<string>;
    };

export interface DeclarativeImplementation {
  readonly type: "declarative";

  /**
   * Each entry maps a JSONPath into the raw payload to a canonical
   * field name, optionally applying a transform. The host's adapter
   * runner walks this list per `extract()` invocation.
   */
  readonly fieldMap: ReadonlyArray<FieldMapEntry>;
}

export interface TypescriptImplementation {
  readonly type: "typescript";

  /**
   * Relative path (from the adapter's directory) to the module that
   * exports the extract function. The host's discovery mechanism
   * dynamic-imports this path at adapter registration time.
   */
  readonly entryPoint: string;
}

/**
 * SYS-2501: data-only implementation for borrower/operator form intake.
 * The manifest declares which form fields feed which canonical fields;
 * the host's form submission handler applies the mapping — no adapter
 * code exists to load, and neither fetch() nor extract() ever runs.
 */
export interface FormIntakeImplementation {
  readonly type: "form-intake";

  /**
   * form-field-id → canonical-field mappings. `formFieldId` is the form
   * spec's field name (the same identifier UnifiedFormConfig fields
   * carry); `canonical` MUST be declared by the adapter's category —
   * host validates at registration, exactly like declarative fieldMap
   * entries. Values arrive already typed from the form layer, so there
   * is deliberately no transform slot here: a form field needing value
   * transformation is a form-spec concern, not an adapter one.
   */
  readonly fieldMap: ReadonlyArray<FormIntakeFieldMapEntry>;
}

export interface FormIntakeFieldMapEntry {
  /** The form spec's field name this mapping consumes. */
  readonly formFieldId: string;

  /**
   * Canonical field name this maps to. MUST be declared by the
   * adapter's category. Host validates at registration.
   */
  readonly canonical: CanonicalFieldName;
}

/**
 * SYS-2501: data-only implementation declaring that the adapter's
 * `produces` list is operator-overridable post-extraction. The manifest
 * gates the override surface; the host's override endpoints check
 * membership in `produces` before accepting a manual value. No code, no
 * fetch(), no extract() — the discriminator alone carries the meaning,
 * so this shape is intentionally empty beyond `type`.
 */
export interface ManualOverrideImplementation {
  readonly type: "manual-override";
}

/**
 * SYS-2998: declaration-only implementation for adapters whose
 * implementation IS the host application's own extraction pipeline
 * (e.g. the FinXtract document-processing pipeline wrapped as
 * "finxtract-bank-statement-v1"). The host's pipeline code performs the
 * extraction, writes the canonical rows, and records the adapter runs —
 * this manifest is how that pipeline's output becomes declared,
 * provenance-carrying, per-field-gateable adapter data instead of
 * hand-wired writes. No code, no fetch(), no extract(); like
 * `manual-override`, the discriminator alone carries the meaning.
 *
 * Distinct from `form-intake` (whose runtime is the form submission
 * handler and which needs a fieldMap) and from `manual-override` (which
 * declares an override SURFACE): an extraction-pipeline manifest
 * declares the pipeline's produced fields verbatim — `produces` is the
 * contract, and the host validates the pipeline's writes against it.
 */
export interface ExtractionPipelineImplementation {
  readonly type: "extraction-pipeline";
}

/**
 * SYS-3036: declaration-only implementation for adapters that are
 * executed entirely OUTSIDE the host application. An externally-
 * orchestrated process (a partner-run ceremony, an out-of-band
 * verification flow, etc.) completes its own extraction and PUSHES the
 * result to the host's assertion-ingest surface, rather than the host
 * pulling it via `fetch()`/`extract()` or a form submission. No code,
 * no fetch(), no extract(); like `manual-override` and
 * `extraction-pipeline`, the discriminator alone carries the meaning —
 * the shape is intentionally empty beyond `type`.
 *
 * Ownership note: this type + its schema branch were previously a
 * host-local extension (a runtime clone of the compiled schema with one
 * extra `oneOf` branch bolted on) because core hadn't yet published the
 * concept. Publishing it here means every host validates the SAME
 * schema — no more per-host schema patches for this discriminator.
 */
export interface ExternalAssertionImplementation {
  readonly type: "external-assertion";
}

/**
 * SYS-3036: how a registered adapter participates at execution time,
 * derived purely from `implementation.type`. Published here (rather than
 * re-derived per host) so every host classifies manifests identically:
 *
 *   - `Runnable` — the host loads (declarative) or dynamic-imports
 *     (typescript) a `SourceAdapter`; the host's run loop executes it.
 *   - `DeclarationOnly` — the manifest is pure declaration plane
 *     (`form-intake`, `manual-override`, `extraction-pipeline`). No code
 *     exists to load; the entry is registered so `list()`-style
 *     consumers (field-authorization gating, provenance rendering,
 *     diagnostics) see the manifest, and every execution path skips it.
 *   - `ExternallyAsserted` — the manifest declares
 *     `implementation.type: "external-assertion"`. Same "no code, host
 *     never calls fetch()/extract()" shape as `DeclarationOnly`, but data
 *     arrives via an external push rather than the host's own
 *     extraction pipeline or form intake. Hosts that used to fork on
 *     this case separately can safely fold it into the same "not
 *     Runnable" branch that already skips `DeclarationOnly` entries.
 *
 * String values mirror the discriminators they classify so a logged
 * `executionMode` reads naturally alongside `implementation.type`.
 */
export enum AdapterExecutionMode {
  Runnable = "runnable",
  DeclarationOnly = "declaration-only",
  ExternallyAsserted = "externally-asserted",
}

/**
 * SYS-3036: classify a manifest's `implementation.type` into its
 * `AdapterExecutionMode`. Exhaustive over every discriminator this
 * version of `@finsys/core` publishes — the switch has an explicit case
 * per type and THROWS on anything else (Ajv should already have refused
 * an unrecognized discriminator at validation time, but a schema/host
 * version skew must surface as a loud refusal here too, never as a
 * silently-guessed mode; no fallback branch assigns one).
 */
export function executionModeOf(
  manifest: Pick<AdapterManifest, "implementation">,
): AdapterExecutionMode {
  const implementationType = manifest.implementation.type;
  switch (implementationType) {
    case "declarative":
    case "typescript":
      return AdapterExecutionMode.Runnable;
    case "form-intake":
    case "manual-override":
    case "extraction-pipeline":
      return AdapterExecutionMode.DeclarationOnly;
    case "external-assertion":
      return AdapterExecutionMode.ExternallyAsserted;
    default: {
      const unhandled: never = implementationType;
      throw new Error(`unknown adapter implementation type: ${String(unhandled)}`);
    }
  }
}

export interface FieldMapEntry {
  /**
   * JSONPath expression into the raw payload. E.g.
   * `$.bill.payment_24m_pct` or `$.account.tenure_months`. Single-
   * value extraction; arrays + objects MUST be flattened by the
   * partner-API client before invoking the adapter.
   */
  readonly source: string;

  /**
   * Canonical field name this maps to. MUST be declared by the
   * adapter's category. Host validates at registration.
   */
  readonly canonical: CanonicalFieldName;

  /**
   * Optional value transform applied between source extraction +
   * canonical-field write. Built-in transforms TBD as the pattern
   * settles; v1 supports:
   *   - `identity`        — default; pass through
   *   - `pct_to_ratio01`  — divide by 100, clamp to [0, 1]
   *   - `to_boolean`      — truthy → true, falsy → false
   *   - `to_integer`      — round + cast
   * Adapters needing more complex transforms should use the
   * `typescript` implementation flavour instead.
   */
  readonly transform?: "identity" | "pct_to_ratio01" | "to_boolean" | "to_integer";
}
