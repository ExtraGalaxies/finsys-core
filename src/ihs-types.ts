/*
 * IHS data processing types.
 * Used by finsys-client and finhub-adonisjs to render application details.
 */

export enum IhsValueFormat {
  STRING = 'string',
  CURRENCY = 'currency',
  NUMBER = 'number',
  PERCENTAGE = 'percentage',
  DATE = 'date',
  TABLE = 'table',
}

export interface IhsFieldDetail {
  name: string
  displayName: string
  category: string
  value: unknown
  valueFormat: IhsValueFormat
}

export interface IhsDetailCategory {
  category: string
  items: { name: string; displayName: string; value: unknown; valueFormat: IhsValueFormat }[]
}

export enum FileFieldTableType {
  TIME_SERIES = 'timeSeries',
  KEY_VALUE = 'keyValue',
}

/**
 * Per-field extraction provenance (SYS-2737/SYS-2741). The single canonical
 * envelope — finsys-api writes it (ihs_field_metadata), finsys-core surfaces it
 * onto detail cells, both consumers render it. Vocabulary mirrors adapter_runs
 * (SYS-2441) so FinXtract + adapter provenance converge at SYS-2499 Phase 5.
 *
 *   source      — who produced the value, e.g. "finxtract:ssm"
 *   confidence  — normalized 0..1; null when derived/computed (no score)
 *   observedAt  — ISO wall-clock of the extraction run
 *   sourceRunId — the extraction run/job id that wrote it
 *   origin      — "extracted" (a real {value,confidence} leaf) vs "derived"
 *                 (computed / no-confidence path) vs "manual" (SYS-2806, a
 *                 lender-entered correction, committed once its edit overlay
 *                 is approved). A "derived" field must render as "no
 *                 confidence available", never a fabricated low score; a
 *                 "manual" field must render as an edit indicator, not a
 *                 confidence dot — confidence is always null for it too.
 */
/**
 * Canonical origin values, single source of truth (Gemini-review finding:
 * avoids duplicating the literal strings between the type and the runtime
 * guard) -- mirrors the IhsStatus/IHS_VALID_STATUSES pattern in
 * ihs-status.ts.
 */
export const IHS_FIELD_ORIGINS = ['extracted', 'derived', 'manual'] as const
export type IhsFieldOrigin = (typeof IHS_FIELD_ORIGINS)[number]

export interface IhsFieldProvenance {
  source: string
  confidence: number | null
  /**
   * ISO wall-clock of the extraction run.
   *
   * SYS-3334 F7/F10 (round 2): `fieldProvenanceFromView` (ihs-processing.ts)
   * writes `''` here when the source instance carries no `observedAt` at
   * all — kept a required `string` rather than made optional, because
   * loosening this type ripples into every consumer that already
   * destructures it as one (a required→optional change is exactly the kind
   * of narrowing-at-the-read-site this package's semver discipline tries to
   * avoid inflicting on downstream `tsc` builds). A reader that formats this
   * value must treat `''` the same as "unknown", exactly as it must already
   * treat a value that never arrived: `new Date('')` is `Invalid Date`, not
   * a thrown error, so a caller that skips the guard fails quietly rather
   * than loudly. Documented here rather than fixed silently, so the sentinel
   * is a decision on record instead of a bug waiting to be rediscovered.
   */
  observedAt: string
  sourceRunId: string | null
  origin: IhsFieldOrigin
  /**
   * SYS-3249: the denomination of a monetary value (ISO 4217, e.g. "MYR",
   * "VND", "THB"). Present only for `kind: "money"` canonical fields.
   *
   * It lives here rather than on the field definition because currency is
   * a property of the OBSERVATION, not of the field: one source can report
   * several currencies in a single document, so a field-level currency
   * could never be right for more than one of them. This envelope is
   * already written per-field, by the same call that writes the value, at
   * the same instant — which is exactly the granularity a denomination
   * needs.
   *
   * OPTIONAL, and absence is not "no currency" — it is "written before
   * SYS-3249, or by a producer that does not yet record one". Readers must
   * treat absence as unknown and say so, never as a default currency. A
   * value silently rendered in the wrong denomination is the failure this
   * field exists to prevent, and defaulting would reintroduce it wearing a
   * different hat.
   *
   * PRECEDENCE against the document-level `currency` canonical field.
   * `finxtract-financial-statement` also declares a canonical field named
   * `currency` ("Reporting currency stated on the document"). The two are
   * not rivals and must not be merged:
   *
   *   - that field is the DOCUMENT's declared reporting currency, one value
   *     per statement, and is a data point in its own right;
   *   - this is the denomination of ONE observed value.
   *
   * This wins wherever both exist, because the whole reason currency sits on
   * the observation is that a single document can report several — an FX
   * transaction, a foreign-currency balance. When this is absent the document
   * field is a reasonable SOURCE for a producer populating it, but it is not
   * a substitute at read time: a reader that falls back to it would state a
   * denomination the value never claimed.
   */
  currency?: string
}

/**
 * `IhsFieldProvenance` plus the value an overlay projection REPLACED.
 *
 * SYS-3334 F3 (round 2): `fieldProvenanceFromView` synthesizes provenance
 * from `CanonicalView` envelopes, which — under a lender-overlay projection
 * (`?overlay=mine`) — can carry `originalValue` (`CanonicalFieldEnvelope`'s
 * own member: the attested value a staged edit is standing in for). Plain
 * `IhsFieldProvenance` has nowhere to put that; widening it for every
 * consumer to carry an almost-always-absent member is the wrong trade for
 * what only this one path needs, so it is a separate, ADDITIVE type instead.
 * `originalValue` is `unknown` rather than the envelope's own
 * `number | boolean | string`, because a table cell already renders `unknown`
 * data (`FileFieldTableItem.data`) and narrowing it here would just move the
 * cast to every caller.
 */
export type IhsFieldProvenanceWithOriginal = IhsFieldProvenance & { originalValue?: unknown }

/**
 * Type guard: narrows an unknown value to `IhsFieldOrigin` iff it is one of
 * the three canonical origin strings. `origin` was previously validated
 * only by the TS union — this is the first runtime check.
 */
export function isValidIhsFieldOrigin(origin: unknown): origin is IhsFieldOrigin {
  return typeof origin === 'string' && (IHS_FIELD_ORIGINS as readonly string[]).includes(origin)
}

export interface FileFieldTableItem {
  displayName: string
  timePeriods: string[]
  data: Record<string, unknown>
  formattedData: Record<string, string>
  type: FileFieldTableType
  isNumeric: boolean
  /**
   * SYS-2741: per-cell extraction provenance, keyed exactly like `data` (period
   * key for TIME_SERIES, `'value'` for KEY_VALUE). `confidence` carries only
   * scored (origin 'extracted') cells so a numeric dot never renders for a
   * derived value; `provenance` carries the full envelope for every known cell.
   */
  confidence?: Record<string, number>
  provenance?: Record<string, IhsFieldProvenance>
}

export interface FileFieldTableData {
  name: string
  displayName: string
  type: FileFieldTableType
  items: FileFieldTableItem[]
  hasData: boolean
}

/**
 * One sibling-table row as finsys-api's `docInstanceStorageService` writes
 * it (SYS-2842) -- the unbounded counterpart to a T{n}-suffixed wide-table
 * slot. `instanceKey` is the real, collision-free per-document key;
 * `sourceLabel` is a human label when the doc type has one (e.g. a bank
 * name); `timePeriod` is the same descriptive value column the legacy
 * T{n} scheme used, kept for period-labeling and legacy provenance lookup
 * (SYS-2886 Phase 5) -- no longer the row's key. Metric fields are the
 * category's own base (unsuffixed) column names.
 */
export interface InstanceRow {
  instanceKey: string
  sourceLabel?: string | null
  timePeriod?: string | null
  [metricKey: string]: unknown
}

// ── Documents table (SYS-2765 / SYS-2766) ──────────────────────

/**
 * Per-document File metadata attached by finsys-api `getIhsDetailsById` as the
 * `documentMetadata` sibling map (SYS-2765), keyed by the document's raw stored
 * path. The single source for the documents table's Type / Size / Uploaded
 * columns — the IHS doc fields themselves carry only the path.
 */
export interface DocumentFileMetadata {
  fileName: string | null
  fileType: string | null
  fileSize: number | null
  createdAt: string | null
}

/**
 * Intrinsic, data-derived capability eligibility for a document row. Reflects
 * ONLY what the IHS payload implies (doc type + a resolvable file); the consumer
 * ANDs in its own runtime gates (readOnly, allowReupload, and — for viewJson —
 * whether extraction has actually completed) before showing a control.
 */
export interface DocumentRowCapabilities {
  /** A downloadable original exists (a resolvable documentId). */
  download: boolean
  /** The doc type produces extracted JSON (consumer still gates on "Extracted"). */
  viewJson: boolean
  /** The doc type can be re-extracted. */
  reExtract: boolean
  /** The doc type accepts a replacement upload (finsys-api /ihs/client/update/document). */
  reUpload: boolean
}

/**
 * One uploaded document, presentation-agnostic — built by `buildDocumentRows`
 * from the IHS payload + its `documentMetadata` map. Rendered identically by
 * FinHub (React) and finsys-client (Edge). Live extraction status + confidence
 * are NOT payload-derived; the consumer overlays them by matching
 * `(docType, timePeriod)`.
 */
export interface DocumentRow {
  /** IHS field key, e.g. 'bankStatements'. */
  docType: string
  /** Human label for the doc-type group, e.g. 'Bank Statements'. */
  label: string
  /** 0-based position within the docType group. */
  index: number
  /** Best display name (resolved file name, or a label + period/index fallback). */
  displayName: string
  /** Id for the download link; null when no file path is resolvable. */
  documentId: string | null
  /** Raw stored path — the join key back to `documentMetadata`. */
  path: string | null
  /** Extraction time-period token: 'T{month|year}' or 'ALL'. */
  timePeriod: string
  /** Human period label ('Jan 2026' / 'Year 2024') or null. */
  periodLabel: string | null
  /** Resolved file name; null when the stored name looks like an opaque id. */
  fileName: string | null
  /** File type label (extension → MIME subtype, upper-cased) or null. */
  fileType: string | null
  /** File size in bytes, or null when unknown. */
  fileSize: number | null
  /** ISO upload timestamp (File.createdAt) or null. */
  uploadedAt: string | null
  /** Intrinsic capability eligibility (consumer overlays its runtime gates). */
  capabilities: DocumentRowCapabilities
}
