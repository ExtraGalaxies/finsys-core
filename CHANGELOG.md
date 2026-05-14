# Changelog

All notable changes to `@finsys/core` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0] — 2026-05-14

### Added

- **Source Adapter framework contract.** New types + helpers describing how
  alt-data sources (telco carriers, payment networks, etc.) ingest raw
  partner-specific payloads and produce canonical credit signals. Adds:
  - `SourceAdapter` interface, `AdapterError` class, `AdapterErrorReason`
    discriminator — the runtime contract every adapter implements.
  - `AdapterCategory` union (`telco-carrier`, `payment-network`) +
    `CategorySchema` with `categorySchemaOf`, `categoryFieldsOf`,
    `allCategories`, `categoryForField` lookup helpers — the publication
    boundary between generic categories declared here and vendor-specific
    implementations that live in private extension directories on the
    host app.
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
