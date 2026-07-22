# Changelog

All notable changes to `@finsys/core` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.5.0] — 2026-07-23

### Added

- **`AdapterManifest.periods`** (optional) — ordered period declarations,
  the contract for the period axis of an adapter's category. The array
  order IS the contract: a period's identity is its POSITION in the
  declared list, and numbering is 1-based — period1 is the first declared
  entry; there is no period0. Declared positions may overlap, nest, vary
  in length, or be staggered (e.g. period1 = an annual table, periods 2–5
  = the four quarters overlapping it), so dates never identify a period —
  identity is contractual position, not dates and not recency. Absent
  means the single-period convention (exactly one implicit period), so
  every pre-existing manifest stays valid and single-period categories
  never need to declare; a declared list must be non-empty. Any
  implementation type may declare periods — the axis is a property of the
  contract, not of how the adapter is implemented. The motivating
  consumer is financial statements, where one document carries period1
  (its current fiscal year) plus period2 (its prior comparative year).

- **`AdapterExtraction.periods` + `PeriodValues`** (optional) —
  per-period value sets on an extraction instance. Each entry carries a
  1-based `position` (its identity — must be >= 1), optional `start`/`end`
  ISO dates (display/temporal metadata only, never identity), a `values`
  record, and optional per-field `confidence`, both with the same shapes
  and semantics as their instance-level counterparts. An instance
  carrying `periods` uses them for period-scoped fields while the
  instance-level `values` remains the home for period-less
  (singleton/instance-scoped) fields; the existing flat `values` path is
  unchanged and remains the single-period path. Periods are scoped within
  one instance — one document's period1 and another document's period1
  are unrelated data points.

## [4.4.0] — 2026-07-22

### Added

- **`extraction-pipeline` adapter implementation type.** A
  declaration-only flavour for adapters whose implementation is the host
  application's own document-extraction pipeline: no code is loaded and
  neither `fetch()` nor `extract()` ever runs — the host's pipeline
  writes the canonical rows and records the runs itself, and the
  manifest exists purely as the declaration plane (`produces`,
  `cardinality`, `fieldAuthorizations`) for data the host was already
  producing. Like `manual-override`, the shape is intentionally empty
  beyond the discriminator.

- **Four document-extraction categories** in the category registry, so
  host pipelines can register manifests for the document data they
  produce:
  - `ic` — identity fields extracted from an IC (MyKad) or passport
    document (9 fields, canonical table `ihs_alt_data_ic`).
  - `finxtract-bank-statement` — bank-statement document extraction
    (8 fields, canonical table `ihsbankstatement`). Deliberately a
    distinct vocabulary from the partner-API `bank-statement` category:
    same real-world domain, different source, zero shared field names.
  - `finxtract-epf` — EPF statement document extraction (9 fields,
    canonical table `ihsepfstatement`).
  - `finxtract-payslip` — payslip document extraction (15 fields,
    canonical table `ihspayslip`).

  Financial-statement and SSM/Form9 categories are deliberately not in
  this release: the financial-statement declaration shape depends on the
  upcoming period-declaration contract, and the SSM/Form9 field sets are
  being consolidated — each arrives with its own release.

## [4.3.0] — 2026-07-21

### Added

- **`AdapterManifest.fieldAuthorizations`** (optional) — declarative
  per-field authorization gating, keyed by canonical field name. No entry
  means a field is visible to every reader (gating is strictly opt-in, so
  every pre-existing manifest is unaffected). An entry restricts: the
  reader must satisfy every dimension the entry declares (AND across
  dimensions), matching any value within a dimension's list (OR within).
  Two dimensions today — `lenderRoles` and `programIds` — both
  host-interpreted opaque strings, keeping the contract
  deployment-agnostic. Entries must declare at least one non-empty
  dimension: an empty list would read as deny-all, which is better
  expressed by not producing the field. Enforcement is the host's job at
  read time; the manifest only declares.

## [4.2.0] — 2026-07-21

### Added

- **`form-intake` + `manual-override` adapter implementation types.** Two
  data-only flavours alongside `declarative` and `typescript` — no code is
  loaded and neither `fetch()` nor `extract()` ever runs. A `form-intake`
  manifest declares form-field-id → canonical-field mappings (the host's
  form submission handler is the runtime), turning an operator- or
  borrower-entered scalar into a canonical, provenance-carrying field
  instead of a hand-wired column write. A `manual-override` manifest
  declares that its `produces` list is operator-overridable
  post-extraction — `produces` IS the override surface, so the shape is
  intentionally empty beyond the discriminator.
- **`AdapterManifest.cardinality`** (`"single" | "multi"`, optional) —
  explicit instance cardinality. Absent means the host infers from the
  original instanceKey convention (empty string → single), keeping every
  pre-existing manifest valid; declaring it lets the host reject a
  mismatched extraction at persistence time instead of silently storing
  it.
- **`AdapterManifest.singletonFields`** (optional) — per-applicant
  singleton fields on a multi-instance category (one value for the
  applicant regardless of how many instances exist, e.g. an account
  holder's name across bank statements). Every entry must also appear in
  `produces`.
- **`AdapterExtraction.observedAt`** (optional ISO-8601) — when the
  instance's data was observed at the source, as distinct from when the
  adapter ran. Hosts fall back to the run timestamp when absent (the
  inference they always did); new adapters should treat it as required.
  Expected to become mandatory at the next major version.
- **`AdapterExtraction.confidence`** (optional) — per-field extraction
  confidence (0..1, keyed by canonical field name), the provenance slot
  probabilistic extractors (OCR/LLM document pipelines) need and
  partner-API adapters simply omit. `null` marks a derived/computed value
  with no extraction confidence. Upstreams the shape already proven in
  the document-extraction host.

## [4.1.0] — 2026-07-11

### Added

- **`IhsStatus.EditingApplication`.** A lender-scoped detour off
  `LenderEvaluation` for manually editing extracted IHS field values — not
  reachable from `ApplicationFinalized`. Added to `IHS_VALID_STATUSES`, not
  to `IHS_TERMINAL_STATUSES`/`IHS_FAILURE_STATUSES` (transient working
  state).
- **`IhsFieldProvenance.origin` gains `'manual'`** alongside the existing
  `'extracted' | 'derived'` — a lender-entered correction, committed once
  its edit overlay is approved. Confidence is always `null` for a manual
  origin, same as `'derived'`. The three origin strings now live in a
  single canonical `IHS_FIELD_ORIGINS` array (mirroring
  `IHS_VALID_STATUSES`), with `IhsFieldOrigin` derived from it.
- **`isValidIhsFieldOrigin()`** runtime guard for the `origin` field,
  matching the existing `isValidIhsStatus`/`isTerminalIhsStatus` pattern —
  previously validated only by the TS union type.
- **`groupColumnsByInstance()` + `buildFileFieldTablesFromInstances()`.**
  The unbounded, instance-based counterpart to `groupColumnsByTimePeriod`/
  `buildFileFieldTables` — builds the same `FileFieldTableData`/
  `FileFieldTableItem` shape from a document-processing backend's
  per-document sibling-table rows (one row per uploaded document, keyed
  by a real `instanceKey`) instead of a fixed, capped `T{n}`-suffixed
  wide-table-column scheme. Requires no catalog changes: base metric
  names are derived by stripping the `T{n}` suffix off the existing
  catalog specs at runtime. Accepts an optional `categoryOverrides` param
  (`CategorySpec`) for categories with no catalog `file` spec at all
  (used for `invoice`, which deliberately stays out of the shared
  `getDocumentTypeGroups()` registry to avoid breaking
  `resolveExtractionStatus`'s wide-table-based status check for a doc
  type that never had a wide-table mirror). Not yet wired into any
  consumer — this release adds the capability; consumer wiring is
  separate follow-up work.
- **`InstanceRow` type** — the row shape `groupColumnsByInstance`/
  `buildFileFieldTablesFromInstances` consume: `instanceKey`,
  `sourceLabel?`, `timePeriod?`, plus arbitrary metric fields.

### Why

Foundation for lender field-editing with a full audit trail. Lenders
correcting/entering IHS data post-extraction is active customer demand
against an original design assumption that values come only from
document extraction. `IhsStatus` stays a closed enum here (unlike
`ExtractionFileType`'s 4.0.0 conversion to an open string) — it mirrors
the origin system's real state machine, not an extensible taxonomy.

Separately, a fixed `T{n}`-suffixed wide-table-column scheme (T1-T6 for
bank statements/payslips, T1-T3 for financial statements/EPF) hardcodes
a cardinality cap that a lender wanting statements from more banks, or a
longer document history, can't represent. The document-processing
backend's storage layer already moved to an unbounded, instance-keyed
scheme; this release adds the render-side counterpart so a future
consumer change can show every uploaded document, not just the first N.

## [4.0.0] — 2026-07-09

### Changed

- **Breaking:** `ExtractionFileType` is now `type ExtractionFileType = string`
  instead of a closed enum. Any consumer accessing it by value (e.g.
  `ExtractionFileType.Ssm`, `Object.values(ExtractionFileType)`) needs to
  migrate to the new `document-types.ts` registry (`getDocumentTypeGroups()`,
  `isDocumentType()`, `assertDocumentType()`).
- Consolidates four previously hand-synchronized document-type structures (a
  closed `ExtractionFileType` enum, a file-type-to-group map, and two
  separate prefix/display-name maps) into one registry derived at runtime
  from the field-spec catalog. Adding a new document type is now a
  data-only catalog edit — no TypeScript union to update, no hand-maintained
  map to keep in sync.
- New catalog tags: `document_type`, `document_group`, `document_group_label`,
  `wire_format`, `document_slot`, `time_period_unit`.

### Why

Four structures describing "what document types exist" had drifted out of
sync with each other over time, since each was maintained by hand in a
different file. Deriving one registry from the catalog at runtime means
there's exactly one place a new document type needs to be declared.

## [3.5.0] — 2026-07-09

### Fixed

- Routes an incorporation-date field through its canonical column instead of
  a retired duplicate column that had drifted out of sync with it.

## [3.4.0] — 2026-07-03

### Added

- **`buildDocumentRows(ihsData)`**, plus the `DocumentRow` /
  `DocumentFileMetadata` / `DocumentRowCapabilities` types, and
  `formatDocumentType` / `formatDocumentSize` / `formatDocumentUploaded`
  formatting helpers — a shared, presentation-agnostic model of the
  documents table shown on an application's detail view, so multiple
  consumer applications render the identical table from the same
  underlying data instead of each reimplementing their own version.

### Why

Purely additive — no existing export changed, so any consumer on a
caret-range dependency picks this up automatically with no code change
required.

## [3.3.0] — 2026-07-02

### Added

- **`IhsFieldProvenance` type** — the canonical shape of a field's
  extraction provenance: `{ source, confidence, observedAt, sourceRunId,
  origin }`.
- **`buildFileFieldTables`/`buildTableForGroup` accept an optional
  `fieldProvenance` map**, attaching per-cell confidence + provenance keyed
  exactly like the cell data itself. `confidence` is only populated for
  `origin: 'extracted'` cells (NaN-guarded); derived cells carry the full
  provenance envelope without a numeric score.
- Lights up single-document columns (fields with exactly one value, not a
  time series) that an earlier, interim value-matching approach had
  skipped.

### Why

Consuming applications need to render a visual confidence indicator next to
extracted field values, sourced from data already persisted upstream. Fully
backward-compatible — the new parameter is optional.

## [3.2.0] — 2026-06-10

### Added

- **`geolocation` adapter category** (SYS-2561). Hourly-granularity movement
  track + derived mobility signals, source-neutral (telco network location,
  mobile-SDK GPS, GIS / address-verification providers all map to it). Two
  instance kinds share `ihs_alt_data_geolocation` (bank-statement
  multi-instance precedent): point instances (`pt:<ISO-hour>` — geoLatitude,
  geoLongitude, geoAccuracyM, geoBucket, geoPlaceLabel) and one summary
  instance (`summary` — geoWorkAttendanceRatio30d, geoWorkDailyHoursAvg30d,
  geoLocationStabilityScore, geoCommuteRegularityRatio, geoVacationDays90d,
  geoHotspotDwellRatio, geoPrimaryStateCode, geoAddressMatchScore). The
  work-attendance signals corroborate declared employment income. Raw
  coordinates are sensitive personal data: product-plane persistence is
  gated on PDPA consent + CRA Act 710 §25 retention review.
- `docs/category-reference.md`: sections for `trade-credit` (missing since
  SYS-2548) and `geolocation`.

## [3.1.0] — 2026-06-05

First release since 2.7.0 — bundles two merged changes (an interim 3.0.0
was never released standalone). Read the breaking change before upgrading.

### Changed

- **Breaking:** `AdapterCategory` is now an open `string` instead of a
  hardcoded TypeScript union. The category set loads at runtime from a JSON
  data file (the single source of truth) — adding a category is a
  data-file edit, not a union edit. Impact: you lose compile-time
  autocomplete and exhaustiveness checking on category ids. Validate at
  trust boundaries with `isAdapterCategory()`/`assertAdapterCategory()`;
  read the canonical set from `ADAPTER_CATEGORY_IDS`/`allCategories()`.
  Existing adapters (telco, payment) are unaffected at runtime.
- Removed vendor brand names from category descriptions, per this
  package's no-vendor-names convention (adapter implementations for
  specific vendors live outside this open-source package).

### Added

- **`trade-credit` category** — an accounting AR/AP + P&L signal model:
  days-sales-outstanding, days-payable-outstanding, outstanding-balance
  ratios, overdue ratios, debtor concentration, a cross-reference revenue
  anchor for accounting-vs-bank consistency checks, gross margin, and
  cash-conversion-cycle days.
- **`social-media` category** — public business-presence / reputation
  signals.

### Migration (2.7.0 → 3.1.0)

Replace any exhaustive `switch` over `AdapterCategory` with a runtime
membership check (`isAdapterCategory`). No storage or adapter-contract
changes — the core adapter interface is unchanged from 2.7.0.

## [2.7.0] — 2026-05-16

Strict-additive minor release. Lets partner adapters own their own
data-fetch loop instead of relying on the host application to stage
payloads ahead of time.

### Added

- **`SourceAdapter.fetch?(identity)`** — an optional partner-data fetch
  path. Adapters that need to call a partner API (live carrier lookups,
  payment-network feeds, etc.) implement it; adapters reading pre-staged
  data omit it and the host treats the raw payload as already-supplied.
  The host feature-detects via `typeof adapter.fetch === "function"`.
- **`ApplicantIdentity<E>`** — a new exported type, generic in the
  partner-extension shape, so a narrowed adapter implementation gets typed
  dot-access on its own partner-specific identity fields rather than
  `unknown`. Defaults to `E = {}` so adapters needing only the core
  identity fields keep working without specifying a generic.
- **`SourceAdapter<E>` is now generic** — `E` flows from the adapter's own
  interface into its `fetch` method automatically.
- **`AdapterManifest.requiredIdentityFields?: string[]`** — an optional
  manifest field listing partner-specific identifier keys an adapter needs
  on the identity object. The host validates these per-applicant before
  invoking `fetch()`. The schema rejects the always-populated core
  identity fields as invalid entries here.
- JSDoc warning on `fetch()` about the method name shadowing the global
  `fetch` function inside its own body — implementations should call
  `globalThis.fetch(...)` or bind to a local reference; a naked
  `fetch(...)` call recurses into the adapter's own method.

### Why

Some partner integrations need to actively call out to a partner's API at
extraction time rather than simply reading data staged in advance by the
host. Making this an optional method (rather than a required part of the
interface) keeps every pre-existing adapter compiling and running
unchanged.

## [2.6.0] — 2026-05-14

### Added

- **Source Adapter framework contract.** New types + helpers describing how
  alt-data sources (telco carriers, payment networks, etc.) ingest raw
  partner-specific payloads and produce canonical credit signals. Adds:
  - `SourceAdapter` interface, `AdapterError` class, `AdapterErrorReason`
    discriminator — the runtime contract every adapter implements. The
    `extract(raw)` method returns `Promise<AdapterExtraction[]>` —
    multi-instance per applicant is first-class (6 bank statements, 12
    monthly payment snapshots, 3 mobile lines per applicant all
    supported by a single adapter call). Multi-VENDOR cases use
    separate adapter registrations (each vendor is its own
    `SourceAdapter`).
  - `AdapterExtraction` shape with `instanceKey` — within-adapter
    instance discriminator; empty string for single-instance adapters.
  - `AdapterCategory` union (`telco-carrier`, `payment-network`) +
    `CategorySchema` with `categorySchemaOf`, `categoryFieldsOf`,
    `allCategories`, `categoryForField` lookup helpers — the publication
    boundary between generic categories declared here and vendor-specific
    implementations that live in private extension directories on the
    host app.
  - `AggregationOp` union (`sum | mean | latest | max | count`) +
    `applyAggregation` helper — operator set the eval engine uses to
    collapse multi-instance canonical-field values to scoring inputs.
    Published from finsys-core so policy fixtures across all consumers
    reference the same surface.
  - `AdapterManifest` TypeScript type + matching JSON-schema at
    `schema/adapter-manifest.schema.json` — the declarative descriptor
    every adapter ships alongside its implementation.
  - Per-category canonical field definitions in
    `data/adapter-categories.json` — the vendor-agnostic field set every
    adapter of a given category produces.

  No implementations, no host wiring — this release ships the contract
  only. Storage layer (SYS-2441), plugin discovery (SYS-2444), reference
  adapters (SYS-2442, SYS-2443) follow as separate PRs that depend on this
  contract. See SYS-2440 + Confluence FinSim / Source Adapter Framework.

### Why

The CRA roadmap (multiple alt-data partnerships) needs an extension
mechanism that decouples vendor adapters from the open-source core.
Vendor names cannot appear in this package; categories must be
vendor-agnostic and the field schemas they publish must be the same
shape whether the underlying source is one carrier or another. Adapter
implementations are deployment artifacts loaded into the host app at
runtime, NOT new npm packages — keeps the rollout chore confined to
core itself.

## [2.5.0] — 2026-05-06

### Changed

- **Decouple base field specs from template-owned fields.** Removed `enableIf`
  clauses from 20 file-upload base fields in `form-field-base-specs.json` that
  referenced a consent field (`formOfDisclosure`) the base catalog cannot
  guarantee exists. Affected fields: `bank_statement_t1..t6`, `financials`,
  `financials_fincap_t1..t2`, `form9`, `ssm`, `ic`, `epf_statement_t1..t2`,
  `payslip_statement_t1..t6`. Templates now own their own document gating via
  inlined `enableIf` overrides at the loan-template level. See SYS-2402.

### Why

Base field definitions describe **what** a field is (type, validation, IHS
column mapping). Behavioral gating (**when** a field appears) is properly
template-level concern — only a template knows which other fields it composes
into the form. The previous coupling produced two latent bugs:

1. Loan templates whose consent field was named differently (e.g.,
   `disclosureOfInformation`) had their inherited document fields silently
   gated on a non-existent value, disabling them.
2. Loan templates without any consent field had base-catalog document fields
   permanently disabled.

Stripping these `enableIf` clauses is non-breaking: no downstream consumer
(audited: `finsys-client`, `finsys-api`, `finsys-borrower-client`,
`finhub-adonisjs`) reads `.enableIf` from `BASE_FIELD_SPECS` as a property.

### Migration

If a downstream consumer depends on document fields being consent-gated, the
consuming loan template must define its own `enableIf` on the inlined field
copy. Example:

```jsonc
{
  "fields": {
    "bank_statement_t1": {
      "displayName": "Bank Statement (Month T-1)",
      "type": "file",
      "enableIf": "{disclosureOfInformation} contains 'yes'",
      "ihs_column_names": ["bankBalanceT1"]
    }
  }
}
```
