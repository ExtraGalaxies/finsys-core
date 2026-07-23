# Category Reference

The canonical field set for each adapter category in `@finsys/core` v3.0.0.

This document is the human-readable view of [`src/data/adapter-categories.json`](../src/data/adapter-categories.json) — the data file is the authoritative source; if the two disagree, treat the JSON as correct and file an issue.

When a category gains a new field, this doc and the JSON file are updated together via a minor version bump of `@finsys/core`. Existing adapters keep working unchanged; new adapters can opt into the new field by adding it to their `produces` list.

**Adding a whole category (SYS-2500):** since v3.0.0 the category id set is no longer a hardcoded TypeScript union — it's a runtime registry loaded and validated from `adapter-categories.json` at module load. Adding a category is therefore a single data-file edit plus a minor `@finsys/core` bump: append a category object to the JSON, add a row to this doc, and ship. There is no TS union and no manifest-schema enum to keep in sync. (Adding a category still needs storage on the host side — a canonical table + persistence mapper in finsys-api — until the canonical-data-plane generic-storage work lands.)

## How to read this reference

Each category lists:

- **id** — the string you put in `manifest.json`'s `category` field
- **canonical table** — where rows land after persistence (informational; you don't interact with this directly)
- **fields** — the canonical field set; this is the vocabulary your adapter speaks back to FinSys

Each field has:

- **type** — `number`, `boolean`, `string`, or `ordinal`
- **unit** — `ratio` (0..1), `months`, `days`, `count`, `MYR`, etc. Use the unit in your own conversion logic; FinSys assumes values come in already-converted. Not applicable to `ordinal` fields.
- **range** — soft hints, not enforced. Wildly out-of-range values are accepted but will look anomalous on operator dashboards. Not applicable to `ordinal` fields — see **levels** instead.
- **levels** — only present on `ordinal` fields: the field's closed, ordered bucket set, e.g. `1=excellent, 2=good, 3=fair, 4=poor`. Use this instead of `range`/`unit` for a partner that returns a small discrete tier code (e.g. `1`-`4`) rather than a continuous number. **Ordering convention**: `value` always ascends with severity — `1` is the most favorable level, the highest `value` the least favorable, regardless of what the field measures. This is fixed across every ordinal field so generic aggregation (`max` = worst tier wins) doesn't need a per-field direction lookup. There's no interpolation between levels — an ordinal value is always exactly one of the declared levels, never something in between.

If you need a field that isn't in any category here, talk to FinHero about adding it (or proposing a new category).

---

## `telco-carrier`

**Description**: Mobile carrier bill-payment + account-history signals. Any major telco provider implementing this category produces the same canonical field set.

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
| `telcoPaymentReliabilityTier` | ordinal | — | levels: `1=excellent, 2=good, 3=fair, 4=poor` | Coarse bill-payment reliability bucket, for partners that return a tier code instead of a continuous ratio. Parallel signal to `telcoOnTimePaymentRatio24m`. |
| `telcoTenureTier` | ordinal | — | levels: `1=established, 2=developing, 3=new, 4=very-new` | Coarse account-age bucket, for partners that return a tenure tier code instead of a continuous month count. Parallel signal to `telcoTenureMonths`. |
| `telcoDistressTier` | ordinal | — | levels: `1=none, 2=moderate, 3=severe` | Coarse account-distress bucket, for partners that return a distress tier code instead of discrete counts. Parallel signal to `telcoSuspensionsCount24m` / `telcoLateDays24m`. |

**Multi-instance notes**: A business account with multiple lines is a natural multi-instance fit. Use the MSISDN or line-id as the `instanceKey`. Eval policies that want a single value per applicant typically use the `mean` operator for on-time ratio and `sum` or `latest` for tenure depending on the scoring intent. For the ordinal tier fields, aggregate with `max` (numerically highest level = worst tier across instances) or `latest`; both operate generically on the tier's underlying integer value, same as any other numeric field.

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

## `social-media`

**Description**: Public business-presence signals from social / commerce platforms — establishment, reach, engagement authenticity, customer reputation, and account standing. Vendor-agnostic: any platform exposing a public business profile maps its data to this canonical field set. Useful as thin-file corroboration of a borrower's operating reality where formal financials are sparse.

**Canonical table**: `ihs_alt_data_social_media`

| Field | Type | Unit | Range | Description |
|---|---|---|---|---|
| `socialAccountTenureMonths` | number | months | 0..600 | Age of the oldest verified public business presence across linked profiles. Establishment / continuity proxy, parallel to telco + payment-network tenure. |
| `socialFollowerCount` | number | count | 0..100000000 | Aggregate audience size across linked public profiles. Coarse reach / scale proxy — gameable on its own, so read alongside `socialEngagementRate90d`. |
| `socialEngagementRate90d` | number | ratio | 0..1 | Mean interactions per impression over the trailing 90 days. Authenticity signal: a large follower count with near-zero engagement indicates a bought or dormant audience. |
| `socialPostingConsistency12m` | number | ratio | 0..1 | Fraction of weeks in the trailing 12 months with at least one public post. Ongoing-operation signal — distinguishes an active business from a stale listing. |
| `socialVerifiedBusinessAccount` | boolean |  |  | Has at least one platform-verified business / commerce profile. Legitimacy signal — the platform has performed its own business-identity check. |
| `socialCustomerRatingAvg` | number | rating | 0..5 | Mean public customer rating (normalised to a 0–5 scale) across review-bearing profiles. Reputation signal; especially predictive for consumer-facing SMEs. |
| `socialNegativeSentimentRatio90d` | number | ratio | 0..1 | Fraction of public mentions / reviews classified as negative over the trailing 90 days. Reputation-risk / distress signal independent of overall rating volume. |
| `socialAccountFlags24m` | number | count | 0..100 | Policy strikes, suspensions, or content takedowns across linked profiles in the last 24 months. Distress signal, parallel to `telcoSuspensionsCount24m`. |

**Multi-instance notes**: Usually single-instance per applicant (one consolidated business presence). If you model each linked profile as its own instance, key on a stable profile id; eval policies typically use `mean` for rates/ratings and `sum` for follower count and flags. The verified-account flag is a natural `latest`/`max` (any verified profile → verified).

---

## `trade-credit`

**Description**: Accounts-receivable / accounts-payable aging and ledger-derived working-capital signals sourced from a business's accounting / ERP system. Captures how promptly the business collects from its debtors and pays its creditors, the aging profile and concentration of its receivables, and P&L / cash-conversion efficiency. A direct, high-signal view of trade-obligation behaviour, and the anchor for cross-referencing self-reported accounting figures against bank-statement reality.

**Canonical table**: `ihs_alt_data_trade_credit`

| Field | Type | Unit | Range | Description |
|---|---|---|---|---|
| `arDaysSalesOutstanding` | number | days | 0..365 | Average days to collect receivables (DSO). |
| `apDaysPayableOutstanding` | number | days | 0..365 | Average days taken to pay creditors (DPO). |
| `arTotalOutstandingMyr` | number | MYR |  | Total receivables currently outstanding. |
| `arCurrentRatio` | number | ratio | 0..1 | Share of receivables not yet past due. |
| `arOverdue90PlusRatio` | number | ratio | 0..1 | Share of receivables overdue 90+ days — the distress headline. |
| `debtorConcentrationTop5Ratio` | number | ratio | 0..1 | Share of receivables owed by the top-5 debtors. |
| `tradeReferenceDefaults12m` | number | count | 0..100 | Trade-reference defaults in the last 12 months. |
| `accountingRevenue12mMyr` | number | MYR |  | Self-reported trailing-12-month revenue — cross-checked against bank inflows by consistency tiers. |
| `grossMarginPct` | number | ratio | 0..1 | Gross margin from the P&L summary. |
| `cashConversionCycleDays` | number | days | -200..600 | Cash Conversion Cycle; negative (collect before paying suppliers) is strongest. |

**Multi-instance notes**: Single-instance per applicant (one consolidated AR/AP + P&L summary). Eval policies use `latest`.

---

## `geolocation`

**Description**: Hourly-granularity movement track plus derived mobility signals, sourced from any location-capable provider (telco network location, mobile-SDK GPS, GIS / address-verification services). The derived signals corroborate income reliability (regular full-time work-anchor dwell), residential stability, and exposure to operator-flagged hotspot zones. Raw coordinates are sensitive personal data — product-plane persistence is gated on PDPA consent + CRA Act 710 §25 retention review.

**Canonical table**: `ihs_alt_data_geolocation`

| Field | Type | Unit | Range | Description |
|---|---|---|---|---|
| `geoLatitude` | number | deg | -90..90 | Observed latitude for the hourly bucket (point instances only). |
| `geoLongitude` | number | deg | -180..180 | Observed longitude for the hourly bucket (point instances only). |
| `geoAccuracyM` | number | meters | 0..100000 | Source-reported horizontal accuracy radius. Cell-tower fixes: hundreds of meters; GPS: tens. |
| `geoBucket` | string |  |  | ISO-8601 hour bucket, e.g. `2026-06-01T08`. Redundant with the instance key for query convenience. |
| `geoPlaceLabel` | string |  |  | Classified place: `home \| work \| commute \| leisure \| travel \| hotspot \| other`. |
| `geoWorkAttendanceRatio30d` | number | ratio | 0..1 | Fraction of the last 30 weekdays with ≥ 6h dwell at the work anchor — the income-reliability headline (summary only). |
| `geoWorkDailyHoursAvg30d` | number | hours | 0..24 | Mean daily work-anchor dwell hours over the last 30 weekdays (summary only). |
| `geoLocationStabilityScore` | number | score | 0..1 | Share of nights at the primary home anchor (summary only). |
| `geoCommuteRegularityRatio` | number | ratio | 0..1 | Fraction of weekdays matching the dominant commute rhythm (summary only). |
| `geoVacationDays90d` | number | days | 0..90 | Days fully away from both anchors in the last 90 (summary only). |
| `geoHotspotDwellRatio` | number | ratio | 0..1 | Share of buckets inside operator-flagged hotspot zones. Review trigger, not auto-decline (summary only). |
| `geoPrimaryStateCode` | string |  |  | Malaysian state / FT code of the home anchor, e.g. `PNG`, `KUL` (summary only). |
| `geoAddressMatchScore` | number | score | 0..1 | Agreement between the inferred home anchor and the registered residential address (summary only). |

**Multi-instance notes**: Two instance kinds share the table (bank-statement precedent). **Point instances** — `instanceKey = "pt:<ISO-hour>"`, one per hourly bucket, carrying only the point fields. **Summary instance** — `instanceKey = "summary"`, exactly one per adapter run, carrying only the derived signals. Eval policies bind summary fields with `latest`; the point track is for playback/analysis UIs, not direct scoring inputs.

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

**`ordinal` fields**: an ordinal value IS a number under the hood (the level's `value`), so the "Numeric" column above applies unchanged — no special-cased ordinal aggregation exists or is needed. `sum`/`mean` are numerically valid but rarely meaningful for a tier code; `max` (worst tier wins, per the ascending-with-severity convention) and `latest` are the operators eval policies actually want for ordinal fields.

---

## What's NOT yet a category

These data sources are part of the roadmap but don't have a published category as of v3.0.0:

- **E-commerce platforms** (Shopify, WooCommerce order history)
- **Logistics / delivery** (consignment volumes, on-time rate)
- **Utility bills** (electric, water — non-telco recurring payment history)

If your use case fits one of these, the category may land in a future minor release. Coordinate with FinHero on the canonical field set early — the category schema is the most expensive thing to change retroactively.
