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
 */
export interface SourceAdapter {
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
   * Implementation note: this method is named `fetch` which shadows
   * the global `fetch()` inside the method body. Do NOT write a naked
   * `fetch(url, ...)` call inside your `fetch()` implementation — it
   * will recurse into the adapter method instead of hitting the
   * global. Either bind to a local (`const httpFetch = globalThis.fetch`)
   * or use `globalThis.fetch(url, ...)` explicitly. The Node 18+
   * runtime + the @finsys/adapter-toolkit fake-* reference adapters
   * use the explicit-global pattern.
   */
  fetch?<E extends Record<string, unknown> = Record<string, unknown>>(
    identity: ApplicantIdentity<E>,
  ): Promise<RawPayload>;
}

/**
 * Identity payload the host hands to fetch() so adapters can call
 * partner APIs with the right per-applicant identifiers.
 *
 * Core fields are always present (the host populates them from the
 * IHS row). Partner-specific fields land under the open string-keyed
 * extension — adapters declare what they need via the manifest's
 * `requiredIdentityFields`, and the host validates per-applicant
 * before invoking fetch().
 *
 * Type parameter `E` lets adapter authors narrow the partner-specific
 * shape:
 *
 *     interface CelcomExtensions { msisdn: string; accountRef: string }
 *     const identity: ApplicantIdentity<CelcomExtensions> = ...
 *     identity.msisdn  // string, not unknown
 *
 * The default `Record<string, unknown>` preserves the open shape so
 * partners who don't bother narrowing still get the v0 behavior
 * (dot access lands on `unknown`, just like before).
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
 *
 * Implementation note on the open index signature: reading a key not
 * declared on the type returns `unknown`, so partners adding ad-hoc
 * fields (`identity.someThing` without narrowing) must validate the
 * value before passing it to an external call.
 */
export interface ApplicantIdentity<
  E extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Internal IHS id — always present. */
  readonly ihsId: number;
  /** Malaysian IC (or analogous national id). May be empty for non-MY scope. */
  readonly ic: string;
  /** Applicant full legal name. */
  readonly fullName: string;
  /** Partner-specific identifiers — typed by the optional `E` parameter; falls back to `unknown` for ad-hoc reads. */
  readonly extensions?: E;
  /** Catch-all for ad-hoc reads (typed `unknown` — validate before use). */
  readonly [key: string]: unknown;
}

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
