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

- **type** — `number`, `boolean`, `string`, or `list`. A `list` (SYS-3728) is a table the source prints: its value is stored as a JSON **string** of an array of row objects, and the field declares `items` — the row's columns, each `{ name, displayName, type: "string" | "number", kind?: "money" }`. A list declares no `kind`, `unit`, `range` or `fact`: it is never a scorable value. Write each row under the item names (camelCase); a kebab-case key is accepted as its camelCase item (`appointment-date` → `appointmentDate`). A key no item declares breaks the write contract: the validator refuses it and a renderer shows the whole cell as an invalid value, never its content. A list's columns are listed under the field's row as *Items*.
- **unit** — an INTRINSIC unit of measure, from a closed set: `ratio` (0..1), `months`, `days`, `hours`, `count`, `meters`, `deg`, `rating`, `score`. Validated at load — anything else is a hard error. Use the unit in your own conversion logic; FinSys assumes values come in already-converted.
- **kind** — a semantic refinement of `type`. `enum` (one label from a closed set; must be `type: string`, no `range`) or `money` (a monetary amount; must be `type: number`, and declares NEITHER a `unit` NOR a `range`).
  A currency is **not** a unit and must never be declared as one. It is a property of the OBSERVATION, not of the field: one document can report several currencies, so no field-level currency can be right for more than one of them. The denomination travels with the value on its provenance envelope (`IhsFieldProvenance.currency`). Likewise a `range` on money is denominated by definition, so it can only be correct in one currency — `telcoArpuMyr [0, 10000]` is sane in ringgit and roughly twenty times too small in dong.
- **Write contract (SYS-3728)** — every value a writer stores is checked by `validateAdapterExtraction` / `validateCanonicalFields`, and every table re-checks it before rendering. A `string` field has an effective **`maxLength`** (default 256; a field or list item holding longer printed text declares more, and only such long text may contain a newline or tab), may declare a full-match **`pattern`** (only where the writer provably normalizes the format) and **`jurisdictionPatterns`** (a pattern per jurisdiction, applied only under that jurisdiction — never defaulted to MY). A `list` has an effective **`maxItems`** (default 500). Kind **`currency`** is an ISO 4217 code from `CURRENCY_CODES`, normalized from the printed form with `normalizeCurrency` (a bare `$` is ambiguous and refused). No string may open with a structure (a first visible `{`, or `[` outside a long-text tag), hold an invisible, format, private-use, unassigned or control character, stack more than four combining marks, or be blank; a number or money value is a finite number, never text, a count is a non-negative integer, and a declared `range` is enforced. A `format` (`date` / `year`) is calendar-checked and `notAfter` orders two dates. Writers call `prepareExtractionForWrite` and persist the snapshot it returns. Spreadsheet formula injection is an export-encoding concern, not this contract's.
- **range** — inclusive bounds, ENFORCED by the write contract since SYS-3728 (a value outside is refused as `out-of-range`); before that they were documentation only.

If you need a field that isn't in any category here, talk to FinHero about adding it (or proposing a new category).

---

## `telco-carrier`

**Description**: Mobile carrier bill-payment + account-history signals. Any major telco provider implementing this category produces the same canonical field set.

**Canonical table**: `ihs_alt_data_telco`

| Field | Type | Unit / kind | Range | Description |
|---|---|---|---|---|
| `telcoOnTimePaymentRatio24m` | number | ratio | 0..1 | Fraction of bills paid on time over the last 24 months. Strongest single telco predictor; ≥0.95 is the clean-history signal. |
| `telcoTenureMonths` | number | months | 0..600 | Account age. ≥48 months is the thin-file uplift trigger. |
| `telcoSuspensionsCount24m` | number | count | 0..100 | Non-payment-driven account suspensions in the last 24 months. ≥3 is a strong distress signal. |
| `telcoLateDays24m` | number | days | 0..800 | Cumulative days late across all bills in the trailing 24-month window. |
| `telcoHandsetFinancingActive` | boolean |  |  | Has an active handset-EMI account currently. Proxy for financing capacity already extended. |
| `telcoHandsetFinancingDelinquent` | boolean |  |  | Recent handset-EMI delinquency in the last 24 months. Distress signal even with otherwise clean bill payment. |
| `telcoArpuMyr` | number | money | | Average Revenue Per User (monthly) in Malaysian Ringgit. Coarse spending-capacity proxy. |

**Multi-instance notes**: A business account with multiple lines is a natural multi-instance fit. Use the MSISDN or line-id as the `instanceKey`. Eval policies that want a single value per applicant typically use the `mean` operator for on-time ratio and `sum` or `latest` for tenure depending on the scoring intent.

---

## `payment-network`

**Description**: Merchant-side payment-flow signals from POS / gateway networks (payment gateways, POS-terminal networks, etc.). Captures actual transaction velocity rather than self-reported revenue.

**Canonical table**: `ihs_alt_data_payments`

| Field | Type | Unit / kind | Range | Description |
|---|---|---|---|---|
| `paymentsMonthlyVolumeMyrT3` | number | money | | Mean monthly inbound transaction volume (RM) over the trailing 3 months. |
| `paymentsMonthlyVolumeMyrT12` | number | money | | Mean monthly inbound transaction volume (RM) over the trailing 12 months. Pair with T3 for trend direction. |
| `paymentsArpuStability12m` | number | ratio | 0..1 | Coefficient-of-variation inverse over monthly ARPU in the trailing 12 months. Closer to 1 = steadier; closer to 0 = volatile. |
| `paymentsDisputeRate12m` | number | ratio | 0..1 | Fraction of transactions disputed or refunded in the trailing 12 months. |
| `paymentsCustomerConcentrationTop5Pct` | number | ratio | 0..1 | Revenue share from the top-5 recurring customers. Above ~0.7 is concentration risk. |
| `paymentsActiveTenureMonths` | number | months | 0..600 | Months since first transaction on the payment network. Establishment / continuity proxy. |

**Multi-instance notes**: Usually single-instance per (applicant, payment network). A merchant with accounts on multiple gateways might be modelled as multiple instances keyed by gateway id, but the more common pattern is one adapter per gateway producing a single instance per applicant.

---

## `bank-statement`

**Description**: Per-month bank-statement extractions. Naturally multi-instance: one statement per (account, month). Eval components typically aggregate across instances (sum closing balance, max debit, count of bounced transactions).

**Canonical table**: `ihs_alt_data_bank_statements`

| Field | Type | Unit / kind | Range | Description |
|---|---|---|---|---|
| `bankStatementMonth` | string |  |  | Statement period in YYYY-MM format. Used as the instance_key discriminator + by the `latest` aggregation operator. |
| `bankClosingBalanceMyr` | number | money | | Closing balance for the statement period. |
| `bankTotalCreditsMyr` | number | money | | Sum of credit transactions during the period. |
| `bankTotalDebitsMyr` | number | money | | Sum of debit transactions during the period. |
| `bankLargestSingleCreditMyr` | number | money | | Largest single inbound transaction in the period. Useful for spotting one-off injections vs steady revenue. |
| `bankBouncedTransactionsCount` | number | count | 0..1000 | Bounced / returned transactions in the period. Distress signal at counts > 0. |

**Multi-instance notes**: Inherently multi-instance. Use the statement month (`YYYY-MM`) as the `instanceKey` — it's both the natural discriminator AND a value the `latest` operator can sort lexicographically (ISO month strings are correctly ordered alphanumerically).

---

## `social-media`

**Description**: Public business-presence signals from social / commerce platforms — establishment, reach, engagement authenticity, customer reputation, and account standing. Vendor-agnostic: any platform exposing a public business profile maps its data to this canonical field set. Useful as thin-file corroboration of a borrower's operating reality where formal financials are sparse.

**Canonical table**: `ihs_alt_data_social_media`

| Field | Type | Unit / kind | Range | Description |
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

| Field | Type | Unit / kind | Range | Description |
|---|---|---|---|---|
| `arDaysSalesOutstanding` | number | days | 0..365 | Average days to collect receivables (DSO). |
| `apDaysPayableOutstanding` | number | days | 0..365 | Average days taken to pay creditors (DPO). |
| `arTotalOutstandingMyr` | number | money | | Total receivables currently outstanding. |
| `arCurrentRatio` | number | ratio | 0..1 | Share of receivables not yet past due. |
| `arOverdue90PlusRatio` | number | ratio | 0..1 | Share of receivables overdue 90+ days — the distress headline. |
| `debtorConcentrationTop5Ratio` | number | ratio | 0..1 | Share of receivables owed by the top-5 debtors. |
| `tradeReferenceDefaults12m` | number | count | 0..100 | Trade-reference defaults in the last 12 months. |
| `accountingRevenue12mMyr` | number | money | | Self-reported trailing-12-month revenue — cross-checked against bank inflows by consistency tiers. |
| `grossMarginPct` | number | ratio | 0..1 | Gross margin from the P&L summary. |
| `cashConversionCycleDays` | number | days | -200..600 | Cash Conversion Cycle; negative (collect before paying suppliers) is strongest. |

**Multi-instance notes**: Single-instance per applicant (one consolidated AR/AP + P&L summary). Eval policies use `latest`.

---

## `geolocation`

**Description**: Hourly-granularity movement track plus derived mobility signals, sourced from any location-capable provider (telco network location, mobile-SDK GPS, GIS / address-verification services). The derived signals corroborate income reliability (regular full-time work-anchor dwell), residential stability, and exposure to operator-flagged hotspot zones. Raw coordinates are sensitive personal data — product-plane persistence is gated on PDPA consent + CRA Act 710 §25 retention review.

**Canonical table**: `ihs_alt_data_geolocation`

| Field | Type | Unit / kind | Range | Description |
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

## `credit-bureau-report`

**Description**: Fields extracted from an uploaded credit-bureau report by the host's extraction pipeline. Vendor-neutral: any bureau-report adapter produces this field set. ONE INSTANCE PER SUBJECT ENTRY, not per document — a report ordered on a company carries the company (section ccris) followed by one entry per party with business interest (pbi-1..n); a report ordered on an individual carries one entry (section iriss). A field the report does not print is absent. Figures the source prints as text (RM 300,000.00, 74.02%) are parsed by the adapter; tables are carried as JSON-encoded lists, the company-profile category's precedent for directors and shareholders. Subject identity here is a THIRD party's as often as the applicant's, so no field co-attests an applicant identity fact.

**Canonical table**: `ihs_alt_data_credit_bureau_report`

**Column labels** (`instanceColumns`, SYS-3728): an instance is a report SUBJECT, not a period, so a table column is labeled `<subjectName> (<subjectRole>)` — principal first, then parties in section order, per document. When the table holds more than one report, each label also carries the report's identity: `· <reportOrderDate>`, else `· report <n>`.

**Document type**: `experianReports` — declared on its catalog entry (`extraction_category`), because the type has no v1 wide-table columns for the migration map to derive it from (SYS-3705). Rendered under canonical field names.

| Field | Type | Unit / kind | Range | Description |
|---|---|---|---|---|
| `section` | string |  |  | Which subject entry of the report this instance is, as the reader sets it: `ccris` (a company the report was ordered on), `iriss` (an individual the report was ordered on), or `pbi-1`, `pbi-2`, … (each party with business interest, in printed order). |
| `subjectRole` | string | enum |  | `principal` for the subject the report was ordered on (section ccris or iriss); `party` for a party with business interest (section pbi-n). |
| `reportBanner` | string |  |  | The report-type banner line as printed, which names the layout (company report, individual report, or a party-with-business-interest entry). |
| `reportOrderId` | string |  |  | The bureau's order id for the report, from the running page header. |
| `reportOrderDate` | string |  |  | The order date and time from the running page header, as printed. |
| `subjectName` | string |  |  | The subject's name in the bureau's databank record. |
| `subjectProvidedName` | string |  |  | The subject's name as the requester typed it when ordering the report. |
| `subjectRegistrationNo` | string |  |  | The company registration number in the databank record (company subjects). |
| `subjectProvidedRegistrationNo` | string |  |  | The company registration number as provided by the requester (company subjects). |
| `subjectIcPassportNo` | string |  |  | The old IC or passport number in the databank record (individual and party subjects). |
| `subjectNewIcNo` | string |  |  | The new IC number in the databank record (individual and party subjects). |
| `subjectProvidedIcPassportNo` | string |  |  | The old IC or passport number as provided by the requester. |
| `subjectProvidedNewIcNo` | string |  |  | The new IC number as provided by the requester. |
| `subjectNationality` | string |  |  | The nationality of an individual the report was ordered on. |
| `subjectRelationship` | string |  |  | A party's relationship to the principal subject (director, shareholder, …). |
| `bureauScore` | number | score |  | The bureau's own credit score for the subject, parsed from the score the report prints (the i-SCORE on the first adapter's reports). Absent when the report prints no score (N/A). |
| `bankingApprovedApplications12m` | number | count |  | Credit applications approved in the last 12 months, from the banking (CCRIS) summary. |
| `bankingPendingApplicationsCount` | number | count |  | Credit applications pending, from the banking summary. |
| `bankingSpecialAttentionAccountsCount` | number | count |  | Accounts under special attention, from the banking summary. |
| `bankingLegalActionsCount` | number | count |  | Banking facilities with legal action taken, from the banking summary. |
| `bankingExistingFacilitiesCount` | number | count |  | Existing banking facilities, from the banking summary. |
| `windingUpRecordsCount` | number | count |  | Winding-up records in the bureau's own databank summary (company subjects). |
| `bankruptcyRecordsCount` | number | count |  | Bankruptcy records in the bureau's own databank summary (individual and party subjects). |
| `legalSuitsCount` | number | count |  | Legal suits in the bureau's own databank summary. |
| `tradeCreditReferencesCount` | number | count |  | Trade / credit references in the bureau's own databank summary. |
| `enquiries12m` | number | count |  | Enquiries made on the subject in the last 12 months. |
| `businessInterestsCount` | number | count |  | Companies or businesses the subject holds an interest in. |
| `shareholdingInterests` | list |  |  | JSON-encoded list of the companies the subject holds an interest or position in, one entry per printed row (name, registration number, incorporation date, paid-up capital, activity, position, appointment date, shareholding, percentage, remark). *Items:* `no`, `name`, `registrationNo`, `incorporationDate`, `paidUpCapital`, `activity`, `position`, `appointed`, `businessExpiryDate`, `shareholding`, `percentage`, `remark`, `lastUpdatedByExperian`. |
| `corporationName` | string |  |  | Company name (or business name, for a sole proprietorship) from the corporation-details section (company subjects). |
| `corporationIncorporationDate` | string |  |  | Incorporation or registration date from the corporation-details section, as printed. |
| `corporationPaidUpCapital` | number | money |  | Total issued and paid-up capital from the corporation-details section. |
| `corporationBusinessSector` | string |  |  | Business sector from the corporation-details section, as printed. |
| `directorsAndOfficers` | list |  |  | JSON-encoded list of directors and officers from the corporation-details section, one entry per printed row (name, appointment date, designation). *Items:* `name`, `designation`, `appointmentDate`. |
| `shareholdersAndMembers` | list |  |  | JSON-encoded list of shareholders from the corporation-details section, one entry per printed row (name, shareholding, percentage), the closing total row excluded. *Items:* `name`, `shareholding`, `percentage`. |
| `ccrisEntityName` | string |  |  | The entity name of the banking-credit (CCRIS) record the report selected. |
| `securedFacilitiesCount` | number | count |  | Number of secured banking facilities. |
| `securedOutstandingBalance` | number | money |  | Total outstanding balance across secured facilities. |
| `securedOutstandingToLimitRatio` | number | ratio |  | Secured outstanding balance as a fraction of the total secured limit (the printed percentage divided by 100; can exceed 1). |
| `securedMaxInstallmentsInArrears12m` | number | count |  | Highest number of installments in arrears on any secured facility in the last 12 months. |
| `unsecuredFacilitiesCount` | number | count |  | Number of unsecured banking facilities. |
| `unsecuredOutstandingBalance` | number | money |  | Total outstanding balance across unsecured facilities. |
| `unsecuredOutstandingToLimitRatio` | number | ratio |  | Unsecured outstanding balance as a fraction of the total unsecured limit (the printed percentage divided by 100; can exceed 1). |
| `unsecuredMaxInstallmentsInArrears12m` | number | count |  | Highest number of installments in arrears on any unsecured facility in the last 12 months. |
| `liabilitiesOutstanding` | number | money |  | Total outstanding as borrower, from the liabilities summary. |
| `liabilitiesTotalLimit` | number | money |  | Total limit as borrower, from the liabilities summary. |
| `liabilitiesFecLimit` | number | money |  | Foreign-exchange-contract limit, from the liabilities summary. |
| `liabilitiesLegalActionTaken` | string |  |  | Legal-action-taken indicator or count from the liabilities summary, as printed (the source does not fix whether it is a flag or a number). |
| `liabilitiesSpecialAttention` | string |  |  | Special-attention-account indicator or count from the liabilities summary, as printed (the source does not fix whether it is a flag or a number). |
| `outstandingCreditFacilities` | list |  |  | JSON-encoded list of the outstanding banking credit facilities, ONE ENTRY PER FACILITY: the lines the source prints for one account (its approval line, its collateral lines, its facility line) combined into a single row, with the limit, balance and instalment parsed as money and the twelve monthly conduct-of-account marks carried together as conduct12m. Rows stored before that regrouping (one entry per printed line) carry undeclared keys, so they break the write contract and render as an invalid value until re-extracted. *Items:* `accountNo`, `approvalDate`, `capacity`, `lenderType`, `accountLimit` (money), `collateralTypes`, `status`, `facility`, `balance` (money), `balanceUpdated`, `instalment` (money), `repaymentTerm`, `conduct12m`, `legalStatus`, `statusUpdated`, `collateralDetail`. |
| `creditApplications` | list |  |  | JSON-encoded list of banking credit applications, one entry per printed line as the source returns them. *Items:* `no`, `date`, `sts`, `capacity`, `lenderType`, `facility`, `totalOutstandingBalanceRm`, `dateBalanceUpdated`, `limitRm`, `prinRepymtTerm`, `colType`, `conductOfAccountM01`, `conductOfAccountM02`, `conductOfAccountM03`, `conductOfAccountM04`, `conductOfAccountM05`, `conductOfAccountM06`, `conductOfAccountM07`, `conductOfAccountM08`, `conductOfAccountM09`, `conductOfAccountM10`, `conductOfAccountM11`, `conductOfAccountM12`, `legalSts`, `dateStatusUpdate`, `propertyStatus`, `address`, `districtCityTown`, `postcode`, `state`, `country`. |
| `specialAttentionAccounts` | list |  |  | JSON-encoded list of special-attention accounts, one entry per printed line as the source returns them. *Items:* `no`, `date`, `sts`, `capacity`, `lenderType`, `facility`, `totalOutstandingBalanceRm`, `dateBalanceUpdated`, `limitRm`, `prinRepymtTerm`, `colType`, `conductOfAccountM01`, `conductOfAccountM02`, `conductOfAccountM03`, `conductOfAccountM04`, `conductOfAccountM05`, `conductOfAccountM06`, `conductOfAccountM07`, `conductOfAccountM08`, `conductOfAccountM09`, `conductOfAccountM10`, `conductOfAccountM11`, `conductOfAccountM12`, `legalSts`, `dateStatusUpdate`, `propertyStatus`, `address`, `districtCityTown`, `postcode`, `state`, `country`. |
| `outstandingCreditTotalBalance` | number | money |  | Total outstanding balance printed under the outstanding-credit table. |
| `outstandingCreditTotalLimit` | number | money |  | Total limit printed under the outstanding-credit table. |
| `creditApplicationsTotalLimit` | number | money |  | Total limit printed under the credit-application table. |
| `suitsAsDefendantCount` | number | count |  | Number of legal suits with the subject as defendant. |
| `limitedDetailSuitsAsDefendantCount` | number | count |  | Number of other known suits, with limited details, with the subject as defendant. |
| `suitsAsPlaintiffCount` | number | count |  | Number of legal suits with the subject as plaintiff. |
| `windingUpAsDefendantCount` | number | count |  | Number of winding-up actions against the subject (company subjects). |
| `windingUpAsPetitionerCount` | number | count |  | Number of winding-up actions brought by the subject (company subjects). |
| `bankruptcyActionsCount` | number | count |  | Number of bankruptcy actions (individual and party subjects). |
| `suitsAsDefendant` | list |  |  | JSON-encoded list of legal suits with the subject as defendant, one entry per suit. *Items:* `subjectName`, `subjectAddress`, `localNo`, `icPpNoNewIcNo`, `caseNo`, `plaintiffAddress`, `plaintiff`, `defendantAddress`, `defendant`, `solicitorAddress`, `solicitorTel`, `solicitorFax`, `solicitorEmail`, `solicitorRef`, `solicitor`, `amountClaimed`, `suitDate`, `hearingDate`, `caseStatus`, `suitRef`, `windingUpOrderDateRef`, `windingUpOrderDate`, `petitionDate`, `petitionRef`. |
| `limitedDetailSuitsAsDefendant` | list |  |  | JSON-encoded list of other known suits, with limited details, with the subject as defendant. *Items:* `subjectName`, `subjectAddress`, `localNo`, `icPpNoNewIcNo`, `caseNo`, `plaintiffAddress`, `plaintiff`, `defendantAddress`, `defendant`, `solicitorAddress`, `solicitorTel`, `solicitorFax`, `solicitorEmail`, `solicitorRef`, `solicitor`, `amountClaimed`, `suitDate`, `hearingDate`, `caseStatus`, `suitRef`, `windingUpOrderDateRef`, `windingUpOrderDate`, `petitionDate`, `petitionRef`. |
| `suitsAsPlaintiff` | list |  |  | JSON-encoded list of legal suits with the subject as plaintiff, one entry per suit. *Items:* `subjectName`, `subjectAddress`, `localNo`, `icPpNoNewIcNo`, `caseNo`, `plaintiffAddress`, `plaintiff`, `defendantAddress`, `defendant`, `solicitorAddress`, `solicitorTel`, `solicitorFax`, `solicitorEmail`, `solicitorRef`, `solicitor`, `amountClaimed`, `suitDate`, `hearingDate`, `caseStatus`, `suitRef`, `windingUpOrderDateRef`, `windingUpOrderDate`, `petitionDate`, `petitionRef`. |
| `windingUpActionsAsDefendant` | list |  |  | JSON-encoded list of winding-up actions against the subject, one entry per action. *Items:* `subjectName`, `subjectAddress`, `localNo`, `icPpNoNewIcNo`, `caseNo`, `plaintiffAddress`, `plaintiff`, `defendantAddress`, `defendant`, `solicitorAddress`, `solicitorTel`, `solicitorFax`, `solicitorEmail`, `solicitorRef`, `solicitor`, `amountClaimed`, `suitDate`, `hearingDate`, `caseStatus`, `suitRef`, `windingUpOrderDateRef`, `windingUpOrderDate`, `petitionDate`, `petitionRef`. |
| `windingUpActionsAsPetitioner` | list |  |  | JSON-encoded list of winding-up actions brought by the subject, one entry per action. *Items:* `subjectName`, `subjectAddress`, `localNo`, `icPpNoNewIcNo`, `caseNo`, `plaintiffAddress`, `plaintiff`, `defendantAddress`, `defendant`, `solicitorAddress`, `solicitorTel`, `solicitorFax`, `solicitorEmail`, `solicitorRef`, `solicitor`, `amountClaimed`, `suitDate`, `hearingDate`, `caseStatus`, `suitRef`, `windingUpOrderDateRef`, `windingUpOrderDate`, `petitionDate`, `petitionRef`. |
| `bankruptcyActions` | list |  |  | JSON-encoded list of bankruptcy cases, one entry per case. *Items:* `status`, `defendantName`, `defendantAddress`, `newIcNo`, `icPpNo`, `caseNo`, `solicitorAddress`, `solicitorTel`, `solicitorFax`, `solicitorEmail`, `solicitorRef`, `solicitor`, `amountClaimed`, `petitionDate`, `petitionRef`, `hearingDate`, `adjudicationOrderDateRef`, `adjudicationOrderDate`, `dischargeDateRef`, `dischargeDate`, `creditors`. |
| `bankruptcyActionCreditors` | list |  |  | JSON-encoded list of the creditors named in the bankruptcy cases (name and IC / passport / registration number). *Items:* `creditorsName`, `creditorsIcPpLocalNoRegNo`. |
| `tradeCreditReferences` | list |  |  | JSON-encoded list of trade / credit references lodged against the subject, one entry per reference (creditor, amount due, days overdue, debt type, status, …). *Items:* `subjectName`, `subjectId`, `creditorsName`, `amountDue`, `creditorsContact`, `agingDays`, `refNo`, `debtType`, `industry`, `documentStatusDate`, `solicitorsName`, `solicitorsContact`, `guarantorOwner`, `remark`. |
| `nonBankLenderFacilities` | list |  |  | JSON-encoded list of non-bank lender credit facilities, one entry per printed line as the source returns them, including the twelve monthly conduct-of-account marks. *Items:* `no`, `aprvDate`, `capacity`, `accStatus`, `lenderType`, `facility`, `limitRm`, `instalmentAmountRm`, `instalmentTenorMth`, `dateBalanceUpdated`, `totalOutstandingBalanceRm`, `prinRepymtTerm`, `colType`, `conductOfAccountM01`, `conductOfAccountM02`, `conductOfAccountM03`, `conductOfAccountM04`, `conductOfAccountM05`, `conductOfAccountM06`, `conductOfAccountM07`, `conductOfAccountM08`, `conductOfAccountM09`, `conductOfAccountM10`, `conductOfAccountM11`, `conductOfAccountM12`, `legalStatus`, `dateStatusUpdate`, `propertyStatus`, `address`, `districtCityTown`, `postcode`, `state`, `country`. |
| `nonBankLenderTotalLimit` | number | money |  | Total limit printed under the non-bank lender table. |
| `nonBankLenderTotalOutstanding` | number | money |  | Total outstanding balance printed under the non-bank lender table. |
| `amlCftScreening` | string | enum |  | AML / CFT list name-match verdict, as printed (MATCHED or NOT MATCHED). |
| `bafiaScreening` | string | enum |  | BAFIA list name-match verdict, as printed. |
| `msbaScreening` | string | enum |  | MSBA list name-match verdict, as printed. |
| `kdnScreening` | string | enum |  | KDN list name-match verdict, as printed (individual and party subjects). |
| `unSanctionsScreening` | string | enum |  | UN sanctions list name-match verdict, as printed (individual and party subjects). |

**Multi-instance notes**: One instance per subject entry, all sharing their document's position, so the instance-shaped table labels each column by `section` (`T1 · ccris`, `T1 · pbi-1`). The adapter derives `subjectRole` from `section`. Eval policies that want the applicant's own record filter on `subjectRole = principal`; the party entries are the directors' and shareholders' own reports.

---

## `management-account`

**Description**: Fields extracted from an uploaded management account (an SME's balance sheet and profit and loss, as produced by a bookkeeper or accounting package) by the host's extraction pipeline. Periodized: one document carries up to three reporting periods, newest first, stored per (instance, period position) — position 1 is the latest period (T-1), 2 the one before it, 3 the one before that. Totals are numbers where the statement prints them (plus one host-computed revenue total, since the statement prints revenue only as lines); every line-item category is a JSON-encoded list of the account lines printed under it. Metric names carry the mgmt prefix because the bare accounting vocabulary (totalAssets, grossProfit, …) is already declared by the audited financial-statement category, and field names are global.

**Canonical table**: `ihs_alt_data_management_account`

**Document type**: `managementAccounts` — declared on its catalog entry (`extraction_category`), as for `credit-bureau-report` (SYS-3705). Rendered under canonical field names.

| Field | Type | Unit / kind | Range | Description |
|---|---|---|---|---|
| `companyName` | string |  |  | Business name as printed on the statement. Attestation of the shared companyName fact — the Form 9, SSM and financial-statement extraction categories attest the same fact from their own documents. |
| `mgmtCurrency` | string | currency |  | The statement's reporting currency as an ISO 4217 code; normalized from the printed form (RM, MYR, ...) by the writer, and absent when the statement prints none or prints a form that names no single currency. |
| `mgmtPeriodEnd` | string |  |  | Reporting period end, normalized to ISO YYYY-MM-DD. Null when the statement prints only a year. |
| `mgmtPeriodStart` | string |  |  | Profit-and-loss period start, normalized to ISO YYYY-MM-DD, when printed. |
| `mgmtPeriodYear` | string |  |  | The year of the reporting period, as a four-digit year (e.g. 2025) — a label, like the EPF statement's statementYear, not a measure. |
| `mgmtStatementsRead` | string |  |  | Which statements this period was read from: BS (balance sheet), PL (profit and loss), or both. |
| `mgmtPeriodSource` | string | enum |  | `own` when the period's own statement was in the upload; `comparative` when its figures come from the comparative column of a newer statement. |
| `mgmtRevenueTotal` | number | money |  | Host-computed sum of the period's sales-revenue line items (mgmtSalesRevenueItems), each printed amount parsed. NOT printed on the document. Absent if any line fails to parse, so a partial sum is never presented as the total. |
| `mgmtCostOfGoodsSold` | number | money |  | Total cost of goods sold / cost of sales, where printed. |
| `mgmtGrossProfit` | number | money |  | Gross profit (negative for a loss), where printed. |
| `mgmtTotalExpenses` | number | money |  | Total operating / administrative expenses, where printed. |
| `mgmtNetProfitBeforeTax` | number | money |  | Net profit before taxation (negative for a loss), where printed. |
| `mgmtTaxation` | number | money |  | Tax expense for the period, where printed. |
| `mgmtNetProfitAfterTax` | number | money |  | Net profit after taxation (negative for a loss), where printed. |
| `mgmtProfitLossForTheYear` | number | money |  | Current-year profit (negative for a loss) as shown in the equity section, where printed. |
| `mgmtPropertyPlantEquipment` | number | money |  | The single property, plant and equipment net line, as printed in audited-style statements. |
| `mgmtFixedAssetsNet` | number | money |  | Total of the block the statement labels Fixed Assets (net book value), where printed. |
| `mgmtTotalNonCurrentAssets` | number | money |  | Total of the block the statement labels Non-current Assets, where printed. A statement may print this, the fixed-assets block, or both with different figures. |
| `mgmtTotalCurrentAssets` | number | money |  | Total current assets, where printed. |
| `mgmtTotalAssets` | number | money |  | Total assets, where printed. |
| `mgmtTotalCurrentLiabilities` | number | money |  | Total current liabilities, where printed. |
| `mgmtTotalNonCurrentLiabilities` | number | money |  | Total non-current / long-term liabilities, where printed. |
| `mgmtTotalLiabilities` | number | money |  | Total liabilities, where printed. |
| `mgmtNetAssets` | number | money |  | Net assets / net worth / total equity, where printed; a capital deficiency is negative. |
| `mgmtWorkingCapital` | number | money |  | Working capital / net current assets, where the statement prints it. |
| `mgmtSalesRevenueItems` | list |  |  | JSON-encoded list of the account lines the statement prints under sales, revenue and turnover, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtCostOfGoodsSoldItems` | list |  |  | JSON-encoded list of the account lines the statement prints under cost of sales (purchases, opening and closing stock, direct labor, freight and other direct costs), for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtOtherIncomeItems` | list |  |  | JSON-encoded list of the account lines the statement prints under other operating and non-operating income, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtSalariesWagesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under salaries, wages, statutory contributions and owners' or directors' remuneration, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtRentRatesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under rental of premises and equipment, quit rent and assessment, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtUtilitiesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under utilities (electricity, water, gas, sewerage), for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtTelephoneInternetItems` | list |  |  | JSON-encoded list of the account lines the statement prints under telephone, internet, hosting and subscriptions, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtMotorVehicleItems` | list |  |  | JSON-encoded list of the account lines the statement prints under motor-vehicle running costs, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtRepairsMaintenanceItems` | list |  |  | JSON-encoded list of the account lines the statement prints under repairs, upkeep and maintenance, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtInsuranceItems` | list |  |  | JSON-encoded list of the account lines the statement prints under insurance premiums, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtProfessionalFeesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under accounting, audit, secretarial, tax, legal and consultancy fees, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtTravelEntertainmentItems` | list |  |  | JSON-encoded list of the account lines the statement prints under travel, accommodation, entertainment and meals, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtStaffCostsOtherItems` | list |  |  | JSON-encoded list of the account lines the statement prints under other staff costs (welfare, allowances, medical, training, recruitment, levy), for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtDepreciationItems` | list |  |  | JSON-encoded list of the account lines the statement prints under depreciation and amortization, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtOtherExpensesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under every other expense account, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtTradeReceivablesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under trade debtors / trade receivables, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtOtherDebtorsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under other debtors and receivables, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtCashAtBankItems` | list |  |  | JSON-encoded list of the account lines the statement prints under bank accounts and fixed deposits, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtPettyCashItems` | list |  |  | JSON-encoded list of the account lines the statement prints under cash in hand / petty cash, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtDepositsPrepaymentsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under deposits paid and prepayments, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtInventoryItems` | list |  |  | JSON-encoded list of the account lines the statement prints under stock, inventories and work in progress, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtLandBuildingItems` | list |  |  | JSON-encoded list of the account lines the statement prints under land and buildings (cost, accumulated depreciation and net book value rows), for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtRenovationsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under renovations and other improvements, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtFurnitureFittingsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under furniture, fittings and office equipment, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtVehiclesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under motor vehicles and other vehicles, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtEquipmentToolsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under plant, machinery, tools and other equipment, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtComputerEquipmentItems` | list |  |  | JSON-encoded list of the account lines the statement prints under computers and IT hardware, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtSystemSoftwareItems` | list |  |  | JSON-encoded list of the account lines the statement prints under software, systems and licenses capitalized as assets, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtTradePayablesItems` | list |  |  | JSON-encoded list of the account lines the statement prints under trade creditors / accounts payable, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtOtherCreditorsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under other creditors and payables, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtAccrualsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under accruals, accrued expenses and accrued wages, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtHirePurchaseItems` | list |  |  | JSON-encoded list of the account lines the statement prints under hire purchase and lease creditors, current and non-current, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtLoansFinancingItems` | list |  |  | JSON-encoded list of the account lines the statement prints under bank loans, term loans, overdrafts, SME financing and other alternative or peer-to-peer financing, current and non-current, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtShareCapitalItems` | list |  |  | JSON-encoded list of the account lines the statement prints under share capital and owners' or partners' capital, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtRetainedEarningsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under retained earnings and accumulated profits or losses, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |
| `mgmtDrawingsItems` | list |  |  | JSON-encoded list of the account lines the statement prints under owners' or partners' drawings and dividends, for this period: one entry per account with its code (when printed), its term as printed, and its amount. *Items:* `code`, `term`, `amount` (money), `amountAsPrinted`. |

**Multi-instance notes**: One instance per (document, period). The period coordinate (`periodPosition`, 1 = latest) is the rendered period, `T1`..`T3`. Eval policies that want the latest period select position 1; `mgmtPeriodSource` says whether a period's figures came from its own statement or from a newer statement's comparative column.

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

These data sources are part of the roadmap but don't have a published category as of v3.0.0:

- **E-commerce platforms** (Shopify, WooCommerce order history)
- **Logistics / delivery** (consignment volumes, on-time rate)
- **Utility bills** (electric, water — non-telco recurring payment history)

If your use case fits one of these, the category may land in a future minor release. Coordinate with FinHero on the canonical field set early — the category schema is the most expensive thing to change retroactively.
