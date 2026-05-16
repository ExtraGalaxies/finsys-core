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
   * `<vendor>-<category-short>-v<n>` (e.g. `celcom-telco-v1`). The id is
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
   */
  readonly implementation: DeclarativeImplementation | TypescriptImplementation;

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
   * Optional free-form notes — useful for partner-side documentation
   * (where to find the adapter's source, who owns it, what version of
   * the partner API it expects). Not consumed by the runtime.
   */
  readonly notes?: string;
}

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
