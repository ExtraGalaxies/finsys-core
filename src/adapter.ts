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
 * Canonical field values produced by an adapter. Keys MUST be drawn
 * from the field set declared by the adapter's category (see
 * `categoryFieldsOf` in adapter-categories.ts). Values are typed
 * narrowly per field by the category schema; this loose TS type is
 * runtime-validated against the category schema by the host app at
 * registration time, AND at every extract() call result.
 *
 * The framework rejects:
 *   - Field names not declared by the adapter's category
 *   - Values whose runtime type doesn't match the category schema
 *
 * Adapters MAY return a partial set — not every category field has to
 * be produced on every applicant (telco fields may be absent if the
 * borrower didn't opt in, for instance). Missing fields score as zero
 * in the eval engine; that's a feature, not a defect.
 */
export type CanonicalFieldValues = Partial<Record<CanonicalFieldName, CanonicalFieldValue>>;

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
   * the persistence layer, and writes provenance.
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
  extract(raw: RawPayload): Promise<CanonicalFieldValues>;
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
