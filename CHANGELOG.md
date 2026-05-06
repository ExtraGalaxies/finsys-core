# Changelog

All notable changes to `@finsys/core` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
