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
 * Source Adapter contract — the framework for ingesting unstructured
 * or partner-specific inputs and producing canonical field values that
 * the eval engine + CRA report consume.
 *
 * The contract has no vendor-specific knowledge. Generic categories
 * (telco-carrier, payment-network, document-extractor, social-presence,
 * …) are declared here; specific vendor implementations live OUTSIDE
 * this open-source package, in private extension directories loaded
 * by the host app at runtime (see SYS-2444 plugin discovery).
 *
 * Design notes:
 *   - extract() is async — every real adapter does I/O (HTTP, OCR, LLM).
 *   - Errors are thrown as `AdapterError` instances. We DELIBERATELY
 *     don't use a Result<> type — the rest of finsys-core uses throw/
 *     catch, and bringing a Result idiom in for one subsystem creates
 *     dialect inconsistency.
 *   - The contract makes no statement about persistence. The host app's
 *     adapter runner catches the return value, persists canonical fields
 *     + raw payload to the storage tables (SYS-2441), and writes
 *     provenance to `ihs_extraction_runs`. Adapters are pure functions
 *     of (raw payload) → (canonical fields). This separation lets
 *     adapters be swapped, replayed, and tested without DB state.
 */

import type { AdapterCategory, CanonicalFieldName } from "./adapter-categories.js";

/**
 * An adapter receives a raw payload — opaque to the framework. The
 * shape is whatever the vendor's source produces: a JSON object from a
 * partner API, a base64 PDF blob, a web-scrape result. Vendor adapters
 * narrow this type internally. The host app's adapter runner is
 * responsible for putting the bytes/structure in front of the adapter;
 * what those bytes are is the adapter's problem.
 */
export type RawPayload = unknown;

/**
 * Canonical field values produced by an adapter for ONE instance.
 * Keys MUST be drawn from the field set declared by the adapter's
 * category (see `categoryFieldsOf` in adapter-categories.ts). Values
 * are typed narrowly per field by the category schema; this loose TS
 * type is runtime-validated against the category schema by the host
 * app at registration time, AND at every extract() call result.
 *
 * The framework rejects:
 *   - Field names not declared by the adapter's category
 *   - Values whose runtime type doesn't match the category schema
 *
 * Adapters MAY return a partial set — not every category field has to
 * be produced on every applicant (telco fields may be absent if the
 * borrower didn't opt in, for instance). Missing fields are aggregated
 * as zero / null in the eval engine; that's a feature, not a defect.
 */
export type CanonicalFieldValues = Partial<Record<CanonicalFieldName, CanonicalFieldValue>>;

/**
 * One extraction "instance" — the framework supports multi-instance
 * per applicant per adapter. Examples:
 *   - 6 bank statements from one bank (one adapter call, 6 instances)
 *   - 12 monthly payment-summary snapshots from one payment network
 *   - 3 mobile lines from one telco carrier
 *
 * For multi-VENDOR cases (3 different telco carriers), use separate
 * adapter registrations — each vendor is its own SourceAdapter with
 * its own id. For multi-INSTANCE-from-one-vendor (6 statements from
 * one bank), the adapter returns multiple AdapterExtraction entries
 * in a single extract() call.
 *
 * `instanceKey` is the within-adapter discriminator: free-form, but
 * MUST be stable across re-extractions so the storage layer can
 * replace-in-place rather than accumulating duplicates. Conventions:
 *   - For periodic data: encode the period (`'2026-Q1'`, `'2026-03'`)
 *   - For per-line data: encode the line id (`'msisdn-60123456789'`,
 *     `'card-last4-1234'`)
 *   - For natively single-instance adapters: use the empty string `''`
 *     (the framework treats `''` as "this adapter only ever has one
 *     instance per applicant").
 */
export interface AdapterExtraction {
  /**
   * Stable within-adapter instance discriminator. Empty string for
   * adapters that only ever produce one instance per applicant.
   */
  readonly instanceKey: string;

  /**
   * The canonical field values for this instance.
   */
  readonly values: CanonicalFieldValues;

  /**
   * SYS-2502: when this instance's data was OBSERVED at the source
   * (ISO-8601) — the statement's own date, the partner snapshot's
   * timestamp — as distinct from when the adapter RAN. Optional for
   * backward compatibility with already-shipped adapters (the host
   * falls back to the run's ranAt when absent, exactly the inference
   * it always did), but new adapters should treat it as required:
   * ranAt-inference conflates "when we fetched" with "when it was
   * true", which corrupts recency ordering for backfilled or delayed
   * data. Expected to become mandatory at the next major version.
   */
  readonly observedAt?: string;

  /**
   * SYS-2502 (prototyped in finsys-api under SYS-2977): optional
   * per-field extraction confidence, 0..1, keyed by canonical field
   * name. This is the provenance slot SYS-2819 identified as the
   * missing precondition for FinXtract-as-adapter — probabilistic
   * extractors (OCR/LLM) carry real per-field confidence; partner-API
   * adapters (a telco returning a number) simply omit it. `null` marks
   * a field whose value is derived/computed rather than directly
   * extracted (renders as "no confidence" rather than low confidence,
   * matching IhsFieldProvenance.origin semantics).
   */
  readonly confidence?: Partial<Record<CanonicalFieldName, number | null>>;

  /**
   * SYS-3002: per-period value sets for adapters whose category
   * declares a period axis (see `AdapterManifest.periods`). Each entry
   * carries the values for ONE contractual position; `position` is
   * 1-based — period1 is the first declared period, there is no
   * period0.
   *
   * An instance carrying `periods` uses them for period-scoped fields,
   * while the instance-level `values` above remains the home for
   * period-less (singleton / instance-scoped) fields. Instances of
   * single-period adapters (no `periods` on the manifest) omit this
   * entirely and keep everything in `values` — the existing flat path
   * is unchanged and remains the single-period path.
   *
   * Periods are scoped WITHIN this instance: this instance's period1
   * and another instance's period1 are unrelated data points.
   */
  readonly periods?: ReadonlyArray<PeriodValues>;
}

/**
 * SYS-3002: one period's value set within an AdapterExtraction
 * instance. Identity is `position` — the 1-based index into the
 * manifest's declared `periods` array — never the dates: declared
 * positions may overlap, nest, vary in length, or be staggered (e.g.
 * period1 = an annual table, periods 2–5 = the four quarters
 * overlapping it), so dates cannot identify a period and recency
 * ordering across positions is meaningless.
 */
export interface PeriodValues {
  /**
   * 1-based contractual position into the manifest's `periods`
   * declaration. MUST be >= 1 — period1 is the first declared period;
   * there is no period0. This IS the period's identity.
   */
  readonly position: number;

  /**
   * ISO-8601 date the period starts — display/temporal metadata only,
   * NEVER identity.
   */
  readonly start?: string;

  /**
   * ISO-8601 date the period ends — display/temporal metadata only,
   * NEVER identity.
   */
  readonly end?: string;

  /**
   * The canonical field values for this period, same shape as the
   * instance-level `values`.
   */
  readonly values: CanonicalFieldValues;

  /**
   * Optional per-field extraction confidence for this period's values,
   * same semantics as the instance-level `confidence` (0..1 keyed by
   * canonical field name; `null` marks a derived/computed value).
   */
  readonly confidence?: Partial<Record<CanonicalFieldName, number | null>>;
}

/**
 * Allowed value shapes for canonical fields. Per-field type narrowing
 * happens at the category schema level — telcoOnTimePaymentRatio24m is
 * a number 0..1; telcoHandsetFinancingActive is a boolean; etc.
 * Numbers + booleans + strings cover everything we expect from credit
 * signals; nested objects are intentionally excluded to keep canonical
 * fields atomic + queryable.
 */
export type CanonicalFieldValue = number | string | boolean | null;

/**
 * The interface every adapter implements. Adapters are loaded by the
 * host app's discovery mechanism (SYS-2444); the host app constructs
 * the adapter from its manifest + extract module, then registers it
 * against the registry by `id`.
 *
 * Type parameter `E` lets adapter authors declare the partner-specific
 * extension shape on ApplicantIdentity. v2.7.0+ — defaults to `{}` so
 * v2.6.0 adapters (which didn't have fetch and never read identity)
 * stay assignment-compatible. A telco adapter that needs an MSISDN
 * declares it once at the interface level:
 *
 *     interface CelcomExt { msisdn: string }
 *     const celcomTelco: SourceAdapter<CelcomExt> = {
 *       async fetch(identity) {
 *         identity.msisdn  // string  (typed via E)
 *         identity.ic      // string  (core)
 *       },
 *       ...
 *     }
 *
 * The generic flows from interface → method, so implementations
 * don't have to redeclare it on fetch.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SourceAdapter<E extends Record<string, unknown> = {}> {
  /**
   * Globally unique id for this adapter instance. By convention:
   * `<vendor>-<category-short>-v<n>` — e.g. `celcom-telco-v1`. Vendor
   * names appear here in deployment-specific code, NEVER in
   * finsys-core. The id is what the registry uses to dedupe + what
   * provenance records pin to.
   */
  readonly id: string;

  /**
   * Which generic category this adapter implements. Determines which
   * canonical fields the adapter MAY produce + how its output is
   * persisted (each category has its own canonical sibling table —
   * `ihs_alt_data_telco`, `ihs_alt_data_payments`, etc.).
   */
  readonly category: AdapterCategory;

  /**
   * Monotonic version per adapter. Bumped whenever the adapter's
   * payload shape, field-mapping logic, or output semantics change.
   * Versions are stored alongside each extraction run for replay /
   * audit; the framework allows multiple versions of the same adapter
   * to coexist in the registry (deployment-controlled).
   */
  readonly version: number;

  /**
   * Subset of the adapter's category fields that this adapter promises
   * to produce. Used by the host app at boot to log adapter capability
   * + by the CRA report to render "provided by adapter X" badges.
   * MUST be a subset of `categoryFieldsOf(category)`; the host app
   * validates this at registration time and refuses to load adapters
   * that promise fields outside their category.
   */
  readonly produces: ReadonlyArray<CanonicalFieldName>;

  /**
   * Transform a raw payload into canonical field values. The host app
   * calls this once per applicant per adapter, passes the result to
   * the persistence layer (one row per AdapterExtraction in the
   * canonical sibling table), and writes provenance.
   *
   * The return is ALWAYS a list, even when the adapter produces only
   * one instance per applicant — return a one-element array in that
   * case with `instanceKey: ''`. The list shape exists to support
   * inherently multi-instance sources (6 bank statements, 12 monthly
   * payment snapshots, 3 mobile lines) without forcing adapters to
   * batch their own calls.
   *
   * Throw `AdapterError` for any failure path — network timeout,
   * schema mismatch, partner API rate limit, malformed payload. The
   * host's adapter runner catches AdapterError + records the failure
   * on `ihs_extraction_runs` so the operator sees what happened
   * without losing the applicant.
   *
   * Adapters MUST NOT throw plain `Error` or unknown types — the
   * runner will treat those as adapter implementation bugs and surface
   * them to logs separately. Stick to AdapterError for the
   * expected-failure path.
   */
  extract(raw: RawPayload): Promise<AdapterExtraction[]>;

  /**
   * Optional partner-data fetch path. v2.7.0+ — adapters that own their
   * partner-API integration declare this method; the host invokes it
   * before extract() and passes the result through. Adapters that
   * receive raw payload from elsewhere (e.g., bank-statement adapters
   * reading FinXtract OCR output, or webhook-driven push ingest) omit
   * fetch() entirely and the host treats raw as already-staged.
   *
   * The host builds `identity` from the IHS row (ic, fullName, etc.)
   * plus any partner-specific fields the adapter declared via the
   * manifest's `requiredIdentityFields`. If a required field is missing
   * from the IHS, the host logs + skips this adapter for the run
   * (no extract call, no canonical rows).
   *
   * Implementations should:
   *   - Throw AdapterError('source_unavailable') ONLY on transient,
   *     retryable upstream failures (timeouts, 5xx, rate limits). The
   *     host runner is free to retry these; misclassifying a permanent
   *     failure here will burn retry budget for nothing.
   *   - Throw AdapterError('not_applicable') on permanent
   *     no-relationship signals — 404 ("applicant unknown to partner"),
   *     410, an explicit "not a subscriber" response. Communicates
   *     'we asked and they said no' so the host records the run + skips
   *     retry. This is the correct reason for most non-retryable
   *     upstream conditions.
   *   - Throw AdapterError('payload_invalid') if the partner returned
   *     a malformed response (200 with garbage body, schema violation).
   *   - Return a RawPayload that extract() will translate. The same
   *     adapter's extract() is the only consumer; the host doesn't
   *     inspect the shape.
   *
   * Strict additive — v2.6.0 read-only adapters that omit fetch()
   * keep working without change.
   *
   * @example WRONG — recurses into the adapter method:
   * ```ts
   * const adapter: SourceAdapter = {
   *   async fetch(identity) {
   *     const res = await fetch(`/api/lookup/${identity.ic}`)  // infinite recursion
   *     return res.json()
   *   },
   *   ...
   * }
   * ```
   *
   * @example RIGHT — explicit globalThis access:
   * ```ts
   * const adapter: SourceAdapter = {
   *   async fetch(identity) {
   *     const res = await globalThis.fetch(`/api/lookup/${identity.ic}`)
   *     return res.json()
   *   },
   *   ...
   * }
   * ```
   *
   * Implementation note: this method is named `fetch` which shadows
   * the global `fetch()` inside the method body — see the @example
   * blocks above. The fake-* reference adapters in
   * @finsys/adapter-toolkit use the explicit-globalThis pattern.
   * Partner repos can also pin this with the lint rule
   * `no-restricted-syntax`: `CallExpression[callee.name='fetch']`
   * inside any method literal named `fetch`.
   */
  fetch?(identity: ApplicantIdentity<E>): Promise<RawPayload>;
}

/**
 * Identity payload the host hands to fetch() so adapters can call
 * partner APIs with the right per-applicant identifiers.
 *
 * The shape is an intersection of three pieces:
 *   - Core fields (`ihsId`, `ic`, `fullName`) — always present, the
 *     host populates them from the IHS row before invoking fetch().
 *   - Partner extensions (`E`) — typed declaratively per adapter.
 *     Defaults to `{}` (no extra typed fields) for adapters that only
 *     need the core trio.
 *   - Open index signature (`[k: string]: unknown`) — catches any
 *     ad-hoc field a host might pass through; reads land on `unknown`
 *     so partners must validate before use.
 *
 * Narrowing example (the ergonomics win this type is designed to deliver):
 *
 *     interface CelcomExt { msisdn: string; accountRef: string }
 *
 *     // declare adapter with the extension shape baked in:
 *     const celcom: SourceAdapter<CelcomExt> = {
 *       async fetch(identity) {
 *         identity.ic        // string
 *         identity.msisdn    // string  (NOT unknown — narrowed by E)
 *         identity.foo       // unknown (falls through to index signature)
 *         // ...
 *       },
 *       // ...
 *     }
 *
 * The intersection puts narrowed members at the root, so partners get
 * `identity.msisdn` (not `identity.extensions?.msisdn`) — matching the
 * pattern the host actually uses (it spreads partner-required fields
 * onto the root identity object, no nested 'extensions' envelope).
 *
 * Examples:
 *   - Telco adapter declares `requiredIdentityFields: ['msisdn']`.
 *     Identity arrives with msisdn populated; adapter calls partner API.
 *     (Don't include 'ihsId', 'ic', or 'fullName' in
 *     `requiredIdentityFields` — those are core fields. `ic` in
 *     particular can be legitimately empty for non-MY scope, so
 *     declaring it required would cause the host to skip every applicant.)
 *   - Payment-network adapter declares `requiredIdentityFields:
 *     ['businessRegistrationNumber']`. Adapter looks it up + calls.
 *   - An adapter that only needs the IHS id declares no extra
 *     fields; identity has just the core trio.
 */
export type ApplicantIdentity<
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  E extends Record<string, unknown> = {},
> = {
  /** Internal IHS id — always present. */
  readonly ihsId: number;
  /** Malaysian IC (or analogous national id). May be empty for non-MY scope. */
  readonly ic: string;
  /** Applicant full legal name. */
  readonly fullName: string;
} & E & {
  /** Catch-all for ad-hoc reads (typed `unknown` — validate before use). */
  readonly [key: string]: unknown;
};

/**
 * Typed error thrown by adapters on expected failure paths. The
 * `reason` discriminator lets the host app's adapter runner classify
 * failures (transient vs permanent, partner-side vs schema-side)
 * without parsing strings.
 */
export class AdapterError extends Error {
  public readonly reason: AdapterErrorReason;
  public readonly cause?: unknown;

  constructor(reason: AdapterErrorReason, message: string, cause?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Discriminator for adapter failure modes. The runner uses this to
 * decide whether to retry, surface to the operator, or write off the
 * extraction run.
 *
 *   payload_invalid     — the raw payload didn't conform to the
 *                         adapter's expected source shape. Permanent;
 *                         re-running won't help. Likely a partner-side
 *                         schema change → bump adapter version.
 *
 *   source_unavailable  — the upstream source was unreachable or
 *                         returned a transient error (timeout, 5xx,
 *                         rate limit). Transient; safe to retry.
 *
 *   mapping_failed      — extraction logic raised a domain-specific
 *                         failure (e.g. value out of expected range).
 *                         Permanent for this payload; surface to the
 *                         operator.
 *
 *   not_applicable      — the applicant doesn't have data for this
 *                         adapter (e.g. no telco opt-in). Not a
 *                         failure per se — the runner records a
 *                         no-op extraction run, eval engine sees no
 *                         canonical fields, components score zero.
 */
export type AdapterErrorReason =
  | "payload_invalid"
  | "source_unavailable"
  | "mapping_failed"
  | "not_applicable";
