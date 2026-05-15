# Category Reference

The canonical field set for each adapter category in `@finsys/core` v2.6.0.

This document is the human-readable view of [`src/data/adapter-categories.json`](../src/data/adapter-categories.json) — the data file is the authoritative source; if the two disagree, treat the JSON as correct and file an issue.

When a category gains a new field, this doc and the JSON file are updated together via a minor version bump of `@finsys/core`. Existing adapters keep working unchanged; new adapters can opt into the new field by adding it to their `produces` list.

## How to read this reference

Each category lists:

- **id** — the string you put in `manifest.json`'s `category` field
- **canonical table** — where rows land after persistence (informational; you don't interact with this directly)
- **fields** — the canonical field set; this is the vocabulary your adapter speaks back to FinSys

Each field has:

- **type** — `number`, `boolean`, or `string`
- **unit** — `ratio` (0..1), `months`, `days`, `count`, `MYR`, etc. Use the unit in your own conversion logic; FinSys assumes values come in already-converted.
- **range** — soft hints, not enforced. Wildly out-of-range values are accepted but will look anomalous on operator dashboards.

If you need a field that isn't in any category here, talk to FinHero about adding it (or proposing a new category).

---

## `telco-carrier`

**Description**: Mobile carrier bill-payment + account-history signals. Any telco vendor (Celcom, Maxis, DiGi, U-Mobile, etc.) implementing this category produces the same canonical field set.

**Canonical table**: `ihs_alt_data_telco`

| Field | Type | Unit | Range | Description |
|---|---|---|---|---|
| `telcoOnTimePaymentRatio24m` | number | ratio | 0..1 | Fraction of bills paid on time over the last 24 months. Strongest single telco predictor; ≥0.95 is the clean-history signal. |
| `telcoTenureMonths` | number | months | 0..600 | Account age. ≥48 months is the thin-file uplift trigger. |
| `telcoSuspensionsCount24m` | number | count | 0..100 | Non-payment-driven account suspensions in the last 24 months. ≥3 is a strong distress signal. |
| `telcoLateDays24m` | number | days | 0..800 | Cumulative days late across all bills in the trailing 24-month window. |
| `telcoHandsetFinancingActive` | boolean |  |  | Has an active handset-EMI account currently. Proxy for financing capacity already extended. |
| `telcoHandsetFinancingDelinquent` | boolean |  |  | Recent handset-EMI delinquency in the last 24 months. Distress signal even with otherwise clean bill payment. |
| `telcoArpuMyr` | number | MYR | 0..10000 | Average Revenue Per User (monthly) in Malaysian Ringgit. Coarse spending-capacity proxy. |

**Multi-instance notes**: A business account with multiple lines is a natural multi-instance fit. Use the MSISDN or line-id as the `instanceKey`. Eval policies that want a single value per applicant typically use the `mean` operator for on-time ratio and `sum` or `latest` for tenure depending on the scoring intent.

---

## `payment-network`

**Description**: Merchant-side payment-flow signals from POS / gateway networks (iPay88, GHL, etc.). Captures actual transaction velocity rather than self-reported revenue.

**Canonical table**: `ihs_alt_data_payments`

| Field | Type | Unit | Range | Description |
|---|---|---|---|---|
| `paymentsMonthlyVolumeMyrT3` | number | MYR | 0..100000000 | Mean monthly inbound transaction volume (RM) over the trailing 3 months. |
| `paymentsMonthlyVolumeMyrT12` | number | MYR | 0..100000000 | Mean monthly inbound transaction volume (RM) over the trailing 12 months. Pair with T3 for trend direction. |
| `paymentsArpuStability12m` | number | ratio | 0..1 | Coefficient-of-variation inverse over monthly ARPU in the trailing 12 months. Closer to 1 = steadier; closer to 0 = volatile. |
| `paymentsDisputeRate12m` | number | ratio | 0..1 | Fraction of transactions disputed or refunded in the trailing 12 months. |
| `paymentsCustomerConcentrationTop5Pct` | number | ratio | 0..1 | Revenue share from the top-5 recurring customers. Above ~0.7 is concentration risk. |
| `paymentsActiveTenureMonths` | number | months | 0..600 | Months since first transaction on the payment network. Establishment / continuity proxy. |

**Multi-instance notes**: Usually single-instance per (applicant, payment network). A merchant with accounts on multiple gateways might be modelled as multiple instances keyed by gateway id, but the more common pattern is one adapter per gateway producing a single instance per applicant.

---

## `bank-statement`

**Description**: Per-month bank-statement extractions. Naturally multi-instance: one statement per (account, month). Eval components typically aggregate across instances (sum closing balance, max debit, count of bounced transactions).

**Canonical table**: `ihs_alt_data_bank_statements`

| Field | Type | Unit | Range | Description |
|---|---|---|---|---|
| `bankStatementMonth` | string |  |  | Statement period in YYYY-MM format. Used as the instance_key discriminator + by the `latest` aggregation operator. |
| `bankClosingBalanceMyr` | number | MYR | -100000000..100000000 | Closing balance for the statement period. |
| `bankTotalCreditsMyr` | number | MYR | 0..100000000 | Sum of credit transactions during the period. |
| `bankTotalDebitsMyr` | number | MYR | 0..100000000 | Sum of debit transactions during the period. |
| `bankLargestSingleCreditMyr` | number | MYR | 0..100000000 | Largest single inbound transaction in the period. Useful for spotting one-off injections vs steady revenue. |
| `bankBouncedTransactionsCount` | number | count | 0..1000 | Bounced / returned transactions in the period. Distress signal at counts > 0. |

**Multi-instance notes**: Inherently multi-instance. Use the statement month (`YYYY-MM`) as the `instanceKey` — it's both the natural discriminator AND a value the `latest` operator can sort lexicographically (ISO month strings are correctly ordered alphanumerically).

---

## Aggregation operators

For reference; these aren't called by your adapter but they're what eval policies use to collapse the multi-instance output your adapter produces.

| Operator | Numeric | Boolean | String | Notes |
|---|---|---|---|---|
| `sum` | ✓ | — | — | Sum across instances. Returns `null` if no numeric values. |
| `mean` | ✓ | — | — | Arithmetic mean. Returns `null` if no numeric values. |
| `latest` | ✓ | ✓ | ✓ | Most-recent instance's value by `observedAt`. Type preserved. |
| `max` | ✓ | — | — | Maximum value. Returns `null` if no numeric values. |
| `count` | ✓ | ✓ | ✓ | Count of non-null instances. Returns `0` if list is empty. |

Operators that don't apply to a type (e.g., `sum` on booleans) throw at evaluation time — the eval engine surfaces this as a policy authoring error, not a silent zero.

---

## What's NOT yet a category

These data sources are part of the roadmap but don't have a published category as of v2.6.0:

- **E-commerce platforms** (Shopify, WooCommerce order history)
- **Logistics / delivery** (consignment volumes, on-time rate)
- **Utility bills** (electric, water — non-telco recurring payment history)
- **Social / business directory** (rated reviews, business listings)

If your use case fits one of these, the category may land in a future minor release. Coordinate with FinHero on the canonical field set early — the category schema is the most expensive thing to change retroactively.
