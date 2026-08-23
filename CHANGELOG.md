# Changelog

All notable changes to `@finsys/core` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [8.1.2] - 2026-08-23

Patch, and every item in it is a PARITY FIX rather than a change anyone chose.
Phase 5's mandate is that the eval system answers the same under either read
shape, so a v1/v2 divergence on data v1 itself wrote means **v2 is the wrong
one** — which makes each of these a correction, not a breaking change, even
where the correction is visible. Three consumer-visible effects fall out of
the first fix and are described in those terms below, because a consumer
diffing a before-picture will see them and should not have to re-derive
whether they are intended.

Measured end to end on the finsim stack 2026-08-22: two finsys-client
containers, byte-identical image and env, differing only in
`APPLICATION_READ_SHAPE` (v1 / v2), driven over
`POST /api/v1/application/evaluate-flexible/{ihsId}` for 54 applications
carrying financial statements × 6 eval models, comparing resolved
`evaluationResults.variables` — **62 evaluable pairs, 39 agreeing, 23
diverging before; 72 evaluable pairs, 65 agreeing, 7 diverging after.** Ten
pairs that could not evaluate under v2 at all now do and agree
("RatioVariable Solvency Ratio must have non-zero denominator" fell 18 → 8):
a fabricated T1 was feeding 0 into a ratio denominator. The 7 remaining are
one shape — two rows claiming one T-slot. The sweep numbers above were taken
with the FIRST fix only; the second fix below closes
this package's half of it.

### Fixed — a coordinate row's ABSENT `legacySlot` is an assertion, not silence (SYS-3517)

- `timePeriodOf` gained one rule, between the existing rules 1 and 2, and it
  is a STOP rather than another derivation: when an instance carries a
  well-shaped `periodPosition` and no usable `legacySlot`, its period is
  `null`. A producer that stores a category by (instance, period) coordinate
  stamps `legacySlot` on every row that HAS a v1 slot, so on such a row the
  slot's absence is the producer saying "the v1 model had no slot for this
  one". Rules 2-4 are all approximations of a slot the wire did not state,
  and on a coordinate row each of them manufactures one.
- The row this protects is DEVOPS-535's: a year-2 financial statement's own
  current fiscal year, stored at position 1 with `timePeriod = NULL` — the
  only (year, position) pair that maps to null. Its key routinely ends `#T1`,
  which is not a period but a HISTORICAL key the re-extraction adopted.
  Reading the period off that key rewrites the one null the coordinate model
  exists to preserve into a second claimant on slot T1, so the consumer's
  coordinate branch (`timePeriod === null && periodPosition === 1`) can never
  fire — reinstating, under v2 only, the exact overlap projection DEVOPS-535
  removed. Measured on a two-document fixture: 90000 returned where the document
  says 77777, and on 282 the fabricated claimant also won `latest/currentYear`,
  returning 77777 where 120000 was right.
- **SCOPE, checked rather than assumed:** `periodPosition` is emitted only for
  a row whose table carries the column, which today is financial statements
  alone. Every bank / payslip / EPF / SSM / Form 9 / IC / alt-data instance
  has no coordinate, so this rule cannot fire for them and their cascade is
  byte-identical.
- **This is a new obligation on producers, and it is stated in the published
  `.d.ts`** (`CanonicalInstance.periodPosition`): it is the first member of
  that interface whose ABSENCE is meaningful, so a producer that stamps a
  coordinate must stamp `legacySlot` wherever a v1 slot exists. Omitting one
  there no longer reads as "unknown, derive it"; it reads as "there is none".

Three consumer-visible effects on the same data, all of them the correction
rather than a regression:

1. **A slotless row's `data` key changes from `T1 (2)` to its instance key.**
   Before, the coordinate row collided with the real T1 and
   `instanceColumnLabels` disambiguated it to `T1 (2)` — a header ASSERTING
   that a second T1 slot exists. It does not. With no slot, the label falls
   back to `row.instanceKey`, which is honest and is a 64-hex column header in
   a lender-facing table. **This is parity, not a new shape:** v1's own
   sidecar carries `timePeriod: null` on that row and renders it through the
   SAME `instanceColumnLabel`, so v1 already shows that header. Naming the
   period a document carries that the v1 slot model has no name for is a
   display decision, and these labels are the literal object keys of
   `FileFieldTableItem.data`, so any vocabulary invented here would become a
   payload contract. Left to the table's owner as a follow-up.
2. **`timePeriods` ordering changes.** `['T1', 'T1 (2)', 'T2', 'T3']` becomes
   `['T1', 'T2', 'T3', '<instanceKey>']` — a row with no parseable period
   sorts last (unchanged F5 rule), where the fabricated `T1 (2)` used to sort
   second. Consumers indexing that array positionally see the move; consumers
   reading it as keys into `data` do not.
3. **The genuine T1 column REGAINS its confidence dot.** The fabricated T1
   wrote the same `netProfitT1` provenance key as the real T1, and the
   collision guard (which deletes BOTH sides rather than rendering the
   winner's confidence on the loser's column) removed it. A slotless row
   contributes no period key at all, so there is nothing to collide with and
   the real column keeps its entry. Pinned by a test whose mutation puts
   `netProfitT1` back in `collided`.

### Fixed — a contested T-slot resolves LAST-write-wins on the flat path (SYS-3526)

- Three consumers answer "two rows claim one T-slot, which value does a lender
  score on?" and this was the one that disagreed. v1's
  `getIhsDetailsById` merges each sibling row's `toSuffixedObject()` into one
  accumulating object under `order: { id: "ASC" }` — the LAST row by id owns
  the slot, and finsys-api's own comment on all four list reads calls that
  "later-masks-earlier" behavior a contract rather than an accident.
  finsys-client's `selectFinancialRow` is also last-matching-row-wins.
  `flatRecordFromView` took `withField[0]`, the FIRST match. It now takes the
  last.
- finsys-api #611 added `order: { id: "ASC" }` to the v2 read — correct, and
  necessary for the instance path — which made this path *deterministically*
  wrong rather than accidentally so: `withField[0]` became guaranteed to be
  the OLDEST row. Measured on a fixture pairing a stale `legacy:T1` row
  and the hashed re-extraction that superseded it both claim T1: v1 served the
  fresh value, the flat path served the stale one.
- "Last" means last-by-ARRIVAL, and that holds on two facts, both pinned:
  the emitter now hands rows over in id order, and `instanceRowPairsFromView`
  does not destroy it — its period sort is stable, and rows contending on one
  slot share a period by construction, so they reach the lookup in the view's
  own emission order.
- **Where this is still not exactly v1, stated rather than papered over.**
  (a) v1 overwrites with NULL: `toSuffixedObject()` emits every non-excluded
  column including a null one, so a later row's null blanks an earlier row's
  value; the canonical projection omits a null field entirely and deliberately
  (a gated field and a never-produced field must be indistinguishable), so
  this package cannot see that a null was there to write. (b) v1 pre-filters
  by recency before spreading — financial statements drop a T1 row whose
  `financialYearEnd` is not the newest, bank statements keep only the newest
  `statementDate` per period; EPF and payslip have no filter, so for those two
  v1 is pure last-write-wins. `financialYearEnd` has no v1 wide column, so it
  never reaches the v1-shaped instance row this function reads — but it IS
  carried on the canonical instance beside it, so the filter is REACHABLE and
  was declined, not impossible: reading it here would make this a second
  implementation of "which document is newest", the drift SYS-2994 exists to
  stop on the finsys-api side.
  The cost of declining, measured rather than assumed: last-match is right
  whenever the newer document also has the higher id — the ordinary case — and
  WRONG when it has the lower id. On the finsim corpus that is 12 of 50
  contested financial T1 groups and 6 of 21 contested bank buckets, against 53
  divergences closed across the four categories. Net strongly positive, NOT
  strictly positive, and those 18 are exactly the groups first-match got right.
  finsys-api's own SYS-2972 comment names the class: "'Newest' is by
  `financialYearEnd` ... NOT by row id, since upload order and fiscal recency
  are independent." The durable fix is producer-side and filed separately.
- Behavior otherwise unchanged: an uncontested slot picks one row out of one
  and is byte-identical, the `ambiguous` signal still reports that a contested
  slot was decided, and a row that does not carry the field is still not a
  candidate.

### Fixed — `icInstances` has a disposition in the v1 migration map (SYS-3517)

- Five per-category instance sidecars were in the map and the sixth was not,
  so a consumer porting off v1 had no answer for exactly one category. The
  cause is the one the map generator's own docstring already names for
  `consents`: **the key list is a union of live records, and a conditionally
  emitted key is invisible to it.** finsys-api writes `icInstances` under
  `if (canonicalRows.ic?.length)` where the other five are assigned
  unconditionally as `[]`, so no sampled subject could contribute the key and
  nothing could report it missing. Declared in the generator next to that
  evidence and unioned in — the measurement stays a measurement. Audited
  against every conditional assignment in that serializer: of seven,
  `icInstances` was the only one the union missed.

### Changed — `periodPosition` is accepted in exactly the shape its producer emits

- The coordinate gate was `Number.isInteger(p) && p >= 1`; finsys-api's
  projector uses `Number.isFinite(p) && p >= 1`. A receiver stricter than its
  producer discards values that were sent, and here that is not inert: with
  the coordinate dropped, the rule above does not fire, the row's adopted
  `#T{n}` key is read as a real slot, and the DEVOPS-535 overlap returns for
  that row. The two gates now read the same. Unreachable today — the column is
  `int` — so this is a consistency fix, made while it is still free. An
  admitted-but-odd coordinate is inert downstream: the consumer branch tests
  `periodPosition === 1`, so such a row is simply slotless, which is what v1
  did with a NULL-`timePeriod` row too.

## [8.1.1] - 2026-08-19

Patch. Three declared-vs-actual defects, each found after 8.1.0 froze. No
breaking change; two of the fixes are consumer-visible — a new root type
export, and one extra documents-table row where invoices exist — and every
consumer on `^8.1.0` picks them up on its next install; nothing needs a PR.
This is intended to be the last core release until Phase 6 (9.0.0), barring
a prioritized feature. Also: `package-lock.json` declared 8.0.0 through the
8.1.0 release; it now carries the package's own version.

### Fixed — `ViewDocument` is exported from the root (SYS-3438)

- `documentsOfType()` returns `ViewDocument[]`, and the 8.1.0 notes said the
  type was exported. It was declared `export interface` in `ihs-processing`
  and never added to `index.ts` — the published d.ts had it outside the
  `export {}` block, and `import type { ViewDocument } from '@finsys/core'`
  was TS2459. Exported now, with a ROOT-entry pin (same shape as
  `CanonicalAttestation`'s) so `tsc` fails if it is ever dropped again.

### Fixed — the payslip category declares the table that exists (SYS-3327)

- `finxtract-payslip.canonicalTable` read `ihspayslip`; the physical table is
  `ihsPayslip` — the ONE camel-cased sibling (bank/epf/financial are
  lowercase) — on a database with `lower_case_table_names=0`, so the declared
  name resolved to no table at all. Measured on the finsim MySQL 2026-08-19.
- The registry validator was lowercase-only (`/^ihs[a-z0-9_]*$/`), which is
  WHY the declaration was wrong: it could not be written correctly, and its
  test restated the wrong literal. The validator is case-preserving now; the
  namespace prefix stays the invariant. One consumer already resolves
  storage from `canonicalTable`: finsys-api's v2 read (`ihsCanonicalRead-
  Service.resolveCategoryTable`) matches it against TypeORM entity metadata
  CASE-INSENSITIVELY, precisely because of this mismatch, and its drift test
  pinned `payslip` as the one known exception "until the two declarations
  converge — the resolver may then be tightened". They have; it can. No
  other consumer reads the field. The drift guard against the physical
  schema belongs in the host, which has both. The duplicate-table guard now
  compares case-insensitively, so two declarations differing only by case are
  refused rather than admitted as two tables. SYS-3341 (derive the table from
  the category id) retires the question.

### Fixed — invoices render in the documents table (SYS-3376)

- `invoices` is a host pointer slot (finsys-api `IHS_DOCUMENT_POINTER_FIELDS`,
  array storage, extraction: true) that the doc catalog never named, so
  `buildDocumentRows` and `buildDocumentRowsFromView` both dropped it — an
  uploaded invoice was stored, billed for on extraction, and rendered in
  NEITHER product. It is a row now (label `Invoices`, extractable, not
  re-uploadable), in catalog order: after payslips, before SSM. Consumers
  that index rows positionally will see one more row where invoices exist;
  the (docType, index) alignment with `resolveExtractionStatusFromView` is
  unchanged. The slot list is host-owned; the comparator that every host
  slot is in `getDocDisplayNames()` belongs beside the list, in finsys-api.

## [8.1.0] - 2026-08-18

Additive. Nothing renamed, nothing removed — a consumer on 8.0.0 upgrades
without touching anything. **This is Phase 5's last core release**: it carries
everything a consumer needs to render an IHS from a v2 `CanonicalView` instead
of the flat v1 record, with the SAME output types, so the flag flip on the
consumer is a migration and can be checked against a before-picture. Every
claim below was measured on 157 sim subjects with both paths run on the same
record.

### Added — the instance-shaped path (SYS-3334)

- **`processIhsDetailsFromView(view)`** → `IhsFieldDetail[]`, feeding the
  unchanged `groupDetailsByCategory`. Labels and groupings come from the LEGACY
  column name, recovered per field through the v1 migration map in reverse, so
  the panel a v1 consumer had is the panel it gets. Identical on the sim
  except for four classes, none of them the processor's: (a) keys the map
  marks `relocated` (Loan/Account Information — the application record, which
  v2 deliberately does not carry) or `needs-decision` (`phoneNumber`);
  (b) v1's DECIMAL-as-string vs v2's typed number; (c) three `text`-typed
  document pointers v1 rendered as raw DMS paths in the panel
  (`myKadOrPassport`, `tnbBills`, `incomeEPF_iakaun`) — their v2 home is
  `document-intake`, which the panel excludes; (d) per-subject dual-write
  divergences in the data plane. A canonical-only field with no legacy key
  gets a collision-proof name and lands in `General`, which the grouping
  drops — as v1 did with alt-data keys. Two producers on one key are BOTH
  emitted, in the same group, the second labeled by its producer: a
  disagreement between producers is what a reviewer should see, not something
  a render helper hides or dies on.
- **`resolveExtractionStatusFromView(view, jobRecords?)`** — a RE-DERIVATION,
  not a port; three decisions, each pinned by a test that names the numbers:
  (1) uploaded = the type's `document-intake` instances ∪ the extraction
  category's documents (an extracted document was uploaded; covers uploads
  that predate the intake writer); (2) per-document status joined by the
  document's DMS hash — intake's `pathInDms` tail is the extraction key's
  hash, `#T1`/`#T2` period rows grouped as one document — not by array
  position; positional job records apply ONLY to the intake-ordered prefix,
  never to an extraction-only document; (3) `totalColumns` is the registry's
  field set for the extraction category. On that last one, stated exactly:
  v1's slot widths equal the registry for bank (8), payslip (15), EPF (9),
  IC (9), SSM (16) and Form 9 (3); financial statements were 13 on the first
  slot and 0 on the second (v1's slots were misaligned with its documents),
  so the only visible denominator change is 13 → 122 there, and it is a
  correction. Also corrected: v1 counted a wide column as populated by Form 9
  when SSM or the applicant form had filled it. `populatedColumns` are
  canonical names. New optional members on `DocExtractionResult`:
  `documentId` (the hash — the join key to `DocumentRow.documentId`) and
  `unlinked` (an extraction-only document, kept observable so a join
  regression cannot masquerade as a pre-writer upload).
- **`v1KeyForAddress(category, field, instanceKey?)`** — the reverse lookup;
  null for a canonical-only address and, deliberately, for a T-slot family.
  Admits `mapped-pending-build` (a label is right whether or not the address
  is written yet). **`v1AddressHasKeyedEntries(category, field)`** — whether
  an instance key carries discriminating power for that field; the detail
  processor falls back to the keyless entry only when it does not, a rule
  that does not depend on `cardinality`, which the API omits when no manifest
  is reachable.
- **`extractionCategoryOf(documentType): AdapterCategory | null`** and
  **`documentCategoryIds(): ReadonlySet<AdapterCategory>`** — derived from
  the document-type groups through the map (intersection across a type's
  columns, so the fan-out key `incorporatedDate` resolves Form 9 →
  company-registration and SSM → company-profile), not hand-listed. A
  document type added after the map would resolve to null; the test that
  pins the seven types by name is what catches that.

### Added — two optional members on the envelope, for the lender overlay (SYS-3415)

- `CanonicalFieldEnvelope.originalValue?` and `CanonicalView.overlay?`. Both
  present ONLY when a view is read under the lender-overlay projection
  (`?overlay=mine` on the v2 read routes): an overlaid envelope carries the
  calling lender's staged value as `value`, `origin: 'manual'`, and the
  attested value it stands in for as `originalValue`; the view carries
  `overlay: {lenderId, applied, updatedAt, unprojected[]}` — the signal that
  the SDK's 2.5.0 notes said neither payload had. Absent on the facts-only
  view. Additive; the compat pins in both packages cover them.

### Added — two optional members for resolved corrections (SYS-3421)

- `CanonicalFieldEnvelope.attestations?: CanonicalAttestation[]` and
  `resolvedBy?: string`, and the `CanonicalAttestation` type. Present only when
  more than one attestation exists for a field (an extraction and a committed
  manual correction): `value` is the RESOLVED one under the named policy
  (`class-precedence@1` — a manual correction outranks a later extraction by
  what it is, not when it arrived: SYS-3392, CONFLICT SURFACES), and the list
  carries every attestation including the loser, so the disagreement is
  visible. Scoring consumes `value`, never the list. Absent when nothing
  needed resolving. Additive. `CanonicalAttestation.value` admits `null` — a
  lender clearing a field is an attestation too, and the ledger must show it
  even though the envelope's own `value` never carries null (a resolved
  clear makes the field absent). `CanonicalAttestation` is exported from the
  root entry, and a lint-time pin now holds every envelope member there — the
  first 8.1.0 candidate declared it and forgot the export (finsys-api found
  it, TS2305).

### Added — the documents table from the view (SYS-3378)

- **`buildDocumentRowsFromView(view, metadata?)`** → `DocumentRow[]` — the
  Phase 6 blocker: until this existed, dropping a pointer column blanked the
  documents table in both products. Reads `document-intake` instances (same
  DOC_DISPLAY_NAMES grouping and order; a type outside it is dropped, as v1
  dropped its pointer column) unioned with extracted-only documents, in the
  ONE order `resolveExtractionStatusFromView` uses — shared
  **`documentsOfType()`** — so a consumer aligning status to rows by
  (docType, index) still can, and both carry the hash as `documentId` so it
  can join by identity instead. `uploadedAt` from the instance (`uploadedAt`
  field, else `observedAt`), `uploadedBy` from the instance, the consumer's
  `documentMetadata` map consulted first for name/type/size as before.
  Stated plainly: uploads carry no period, so `timePeriod` is `'ALL'` and
  `periodLabel` null (v1's was the slot ordinal, "Year 1"). On the sim: same
  row count and same (docType, documentId) set as the flat path on 156 of
  157 subjects; the one is the replaced-file case the intake log remembers.
  Also exported: `documentHashOfKey`, `documentHashOfPath`, `ViewDocument`.

### Added — the last flat function's instance-shaped sibling (SYS-3334)

- **`buildFileFieldTablesFromView(view, fieldProvenance?)`** →
  `Record<string, FileFieldTableData>` — the fourth and final flat file-field
  function to get a `CanonicalView` counterpart, closing out the instance-shaped
  path this release carries. For every document-type group, resolves its
  extraction category and its `InstanceRow[]` (see `instanceRowsFromView`
  below), keyed by `documentGroup` — the same key
  `buildFileFieldTablesFromInstances` already groups its own catalog output
  by — and hands the map to that unchanged function. **v2 envelopes carry
  `confidence`/`origin` per field with no v1 sidecar behind them**, so this
  function SYNTHESIZES one via `fieldProvenanceFromView` (below): `{ source:
  adapterId, confidence, observedAt, sourceRunId, origin }` per field, keyed
  BY EVERY NAME `buildInstanceTable` OR a v1 sidecar might read for that cell
  — corrected, H1, round 4: this bullet used to say "keyed the way
  `buildInstanceTable` already expects (`${legacyBaseName}${timePeriod}`)",
  as if that were the only name a cell needed. `buildInstanceTable` reads
  ONLY that period-suffixed form, unconditionally — never the exact v1 key,
  even when the field has one and even when that exact key IS its legacy
  base (true of `ssm`/`form9`/`ic`, whose single-instance columns carry no
  T-suffix at all). Emitting only the exact key, as this path did before
  H1, therefore lost 100% of those three document types' provenance. Both
  names are emitted when both resolve now — see `fieldProvenanceFromView`'s
  own doc for the mechanism and the gate that keeps a scalar field's F6
  position-rescue from minting a meaningless `<base><period>` twin. A
  caller-supplied `fieldProvenance` entry still overrides the synthesized
  one, per key it names. An envelope asserting neither `confidence` nor
  `origin` synthesizes nothing for that cell (L1, round 4: `originalValue`
  alone does not count either — see `fieldProvenanceFromView`'s doc), rather
  than fabricating a `{ confidence: null, origin: 'derived' }` record the
  source never sent. NOT carried through: per-observation currency — the
  denomination `IhsFieldProvenance.currency` records on the flat sidecar.
  `CanonicalFieldEnvelope` has no such member yet, so money values through
  this path format without a denomination, same honest "unknown" behavior
  `formatValue` already had.

  **On the "confidence dots keep working with zero caller-supplied
  provenance" claim this bullet used to make outright — corrected twice
  now.** First (F11, round 2 review): on the wire as of 2026-08-19 they do
  not, for any document category — finsys-api's read attaches provenance to
  0 of 68k extraction fields (probed live), and this function has nothing to
  synthesize FROM until finsys-api's own provenance-on-the-wire fix ships.
  Second (H1, round 4): even once it does, `ssm`/`form9`/`ic` specifically
  ALSO needed the fix above — their exact key winning outright, with no
  period-suffixed twin, meant they would still have rendered zero dots
  regardless of what finsys-api ships. Once both are true — the wire fix AND
  H1 — confidence dots work from the envelopes with zero caller-supplied
  provenance, exactly as designed, for every document category alike. Until
  then this path renders no dots, and — H2, round 4 (see the
  `fieldProvenanceFromView` bullet below) — where two instances land on one
  slot it renders NEITHER instance's dot rather than one instance's real
  number on the other's column: absent, never fabricated.
- **`instanceRowsFromView(view, category)`** → `InstanceRow[]` — one row per
  v2 instance of a category, ORDERED BY NUMERIC PERIOD (F5, round 2 — see
  below), values keyed by their legacy BASE column name (via
  `v1LegacyBaseNameOf`, below) so the rows are consumable by
  `buildFileFieldTablesFromInstances` without it knowing what a
  `CanonicalView` is. `timePeriod` resolves in priority order (F4, round 2
  widened this from three rules to four): (1) `instance.legacySlot`,
  VERBATIM, when the source row carried one (see `legacySlot` below); (2) a
  `#T{n}` suffix on the instance key (financial statements' two-period
  documents); (3) a `legacy:T{n}` key's own ordinal; else (4) — for every
  category whose instances carry no period on the wire at all (bank /
  payslip / EPF / SSM / Form 9 / IC) — the instance's 0-based position in
  `documentsOfType`'s ordering of that category's documents, as
  `T{position + 1}`. **Corrected (F4/F11, round 2): rule 4 is NOT "the exact
  numbering v1's own T1..T6 wide-table slots used", as this bullet
  previously claimed.** v1's T-number was the UPLOADER-DECLARED slot (bank
  `month`, EPF `year`, payslip `period`), stored on the sibling row as
  `timePeriod`; upload-order position is a different fact that equals it
  only when uploads are ordered, complete, and unique per slot. Rule 1
  (`legacySlot`) is the honest fix — it carries the ACTUAL v1 slot once
  finsys-api's provenance-on-the-wire fix exposes it — and rule 4 is now
  documented as the approximation it always was. `sourceLabel` prefers the
  wire's own per-instance label (`instance.sourceLabel`) when present, else
  falls back to the registry-derived one for `finxtract-bank-statement`, the
  one category the registry gives an obvious per-instance label field
  (`issuingBankName` — different statements can be different banks), else
  null; F6 (round 2) additionally guards a no-period, `instanceKey: ''` row
  against rendering a BLANK column header — `'T1'` when it is the only
  instance of its category, else labeled by array position (`#1`, `#2`).
- **`legacySlot?: string` and `sourceLabel?: string` on `CanonicalInstance`**
  (F4, round 2 — `canonical-view.ts`) — the honest fix for a review finding
  that `T{position+1}` is not v1's own numbering: v1's T-number is the
  uploader-declared slot on the file entry, stored on the sibling row as
  `timePeriod` with `sourceLabel` beside it. finsys-api exposes both on the
  wire under the provenance-on-the-wire fix (the same fix F11's confidence-
  dots correction above depends on). Present through the migration window
  only, retiring with the wide table; optional, additive to the envelope's
  semver contract.
- **`fieldProvenanceFromView(view)`** →
  `{ provenance: Record<string, IhsFieldProvenanceWithOriginal>; collided:
  string[] }` (F3, HIGH, round 2 — hoisted out of
  `buildFileFieldTablesFromView` and fixed at the same time). The provenance
  map used to be built inline, keyed per (base, period) with a bare
  `synthesized[key] = entry` — so two instances landing on the same key (a
  re-extraction of the SAME document, or two filings both `#T1`) collided
  SILENTLY, last-write-wins, with no signal a collision even happened. Fixed
  to keep the entry with the newer `observedAt` (falling back to the larger
  `runId`, then last-in-order) and to COUNT collisions in the returned
  `collided` array. Now covers EVERY category, not only document-extraction
  ones. Keyed by the v1 column name — the exact address via
  `v1KeyForAddress` (with the same keyless fallback
  `processIhsDetailsFromView` uses) AND (H1, HIGH, round 4 — see below)
  `${legacyBase}${timePeriod}` when a document-extraction category resolves
  one, `timePeriod` being `row.timePeriod` from the SAME resolved rows
  `instanceRowsFromView` renders (M1, round 4 — corrected below; was a
  second `timePeriodOf` call that could silently disagree with what the row
  shows). No entry when the envelope asserts neither `confidence` nor
  `origin` (L1, round 4 — corrected from "none of `confidence`, `origin`, or
  `originalValue`": `originalValue` alone used to admit an envelope here
  too, then fabricate `origin: 'derived'` for a field that asserted nothing
  beyond the value an overlay replaced); `originalValue` (SYS-3415's overlay
  projection) is still carried onto an entry one of the other two
  justified, via `IhsFieldProvenanceWithOriginal = IhsFieldProvenance &
  { originalValue?: unknown }` (`ihs-types.ts`).

  **H1 (HIGH, round 4): the exact key and the period-suffixed key are BOTH
  emitted when both resolve, not the exact key only.** `buildInstanceTable`
  reads ONLY `${legacyBaseName}${timePeriod}`, unconditionally, never the
  exact key — a fact this map did not act on before H1: whenever the exact
  key existed it won outright, and for `ssm`/`form9`/`ic` (single-instance
  columns with no T-suffix, so their exact key IS their legacy base) that
  meant the period-suffixed key `buildInstanceTable` actually reads was
  NEVER written. Measured: `ssm_documents` 16/16, `ic_documents` 9/9,
  `form9` 3/3 base columns lost 100% of their provenance through the view
  path. Fixed by emitting both names for the same cell whenever both
  resolve, gated to the categories `buildInstanceTable` is ever fed
  (`documentTypeOfCategory(category) !== null`) — ungated, a scalar
  category's own position-rescued period (F6) would mint a
  `<legacyBase><period>` twin nothing reads (an `applicant-identity`
  `fullName` gaining a spurious `fullNameT1`, say).

  **Corrected (C-2, round 5): the "16/16 … 3/3" recovery claim above is only
  true when `incorporatedDate`'s SIBLING document is absent.** `incorporatedDate`
  is the one base name inside those 28 columns that is ALSO the map's only
  `mapped-fanout` key — SSM's `company-profile`/`companyIncorporationDate`
  and Form 9's `company-registration`/`companyIncorporationDate` are two
  DIFFERENT (category, field) addresses that both resolve to the SAME
  period-suffixed key (`incorporatedDateT1`). Before H-1 (round 5, below),
  this map's own collision logic could not tell that apart from two
  instances of ONE category landing on one slot, so whenever BOTH SSM and
  Form 9 were present, the two attestors collided with each other and H2
  (below) dropped BOTH — SSM alone rendered a confidence dot; SSM + Form 9
  rendered NEITHER, on identical values. H1's fix restored the OTHER 27
  columns unconditionally; `incorporatedDate` needed H-1 as well.

  **H2 (HIGH, round 4): a collided key is DROPPED from `provenance`, not
  resolved to the winner.** NAMED, NOT HIDDEN (unchanged): the map stays per
  (base, slot) — `buildInstanceTable`'s own key contract — so two DIFFERENT
  instances sharing a slot necessarily share ONE provenance entry; that
  remains a limitation of `buildInstanceTable`'s key format, not of this
  function. But rendering the WINNER's confidence on that shared slot — the
  behavior before H2 — put a wrong-but-plausible number on the LOSING
  instance's column, whose real confidence was never that: a real shape
  during the `legacySlot` migration window (one instance carrying it
  verbatim, its sibling falling through to the SAME position-fallback slot).
  **This contradicted the "it never fabricates one" guarantee stated
  elsewhere in this file** (a rendered confidence the source instance never
  asserted is exactly what that guarantee means to rule out) — fixed to
  match it: a collided key is now removed from `provenance` entirely (absent
  is honest), `collided` still names it for a caller that wants to log or
  investigate.

  **H-1 (HIGH, round 5): a `mapped-fanout` key's two DIFFERENT attestors are
  NOT a collision.** `incorporatedDate` is attested by TWO categories
  (`company-profile` from SSM, `company-registration` from Form 9), and
  SYS-2722 designed the fanout precisely so BOTH survive — that is what a
  two-address entry means. H2's collision logic (above) did not know the
  difference between "two attestors of one fanout key" and "two instances of
  one category on one slot", so it treated the former as a collision too:
  SSM alone rendered `incorporatedDateT1` with a confidence dot; SSM + Form 9
  present together rendered NEITHER table's dot, on the SAME agreeing value.
  Fixed by `v1FanoutAddressOf` (`v1-migration-map.ts`) and `sharedFanoutOf`
  (`ihs-processing.ts`): when two writers to one key are DIFFERENT addresses
  that are both attestors of the SAME fanout entry, the write is kept —
  whichever address is FIRST in the map's own `addresses` order, the same
  rule `flatRecordFromView`'s `mapped-fanout` branch already used to place a
  value — and the key is never added to `collided`. Two instances of the
  SAME attestor category (e.g. two SSM uploads) still collide exactly as
  before; the exception is per ADDRESS, not per key.

  **M-5 (round 5): the F3-era temporal tie-break (`challengerWins`,
  `winnerMeta`) is DELETED — SHIPPED BEHAVIOR restated plainly.** H2 (above)
  unconditionally deletes a collided key's `provenance` entry regardless of
  which write "won" a temporal comparison, so every key that ever reached
  `challengerWins` had its result thrown away at the end — the comparison
  was computing an answer nobody could ever read. A collided key is now
  simply recorded (`collided.add(key)`) and left alone: **a collided key is
  reported in `collided` and absent from `provenance`; no winner is chosen,
  because a winner would be a guess.** Behavior is unchanged for every case
  this suite already covered — the deletion removes dead code, it does not
  change an output.

  `buildFileFieldTablesFromView` now calls this and uses its `.provenance`;
  a caller-supplied `fieldProvenance` still overrides per key — **except
  (M-4, round 4, doc corrected round 5) for the SAME 28 base columns (ssm 16,
  ic 9, form9 3): a caller sidecar keyed by the bare v1 name never reaches
  `buildInstanceTable`'s `${base}${period}` lookup, so an override (and any
  `currency` on it) on those 28 must be keyed the SAME way the synthesized
  twin is (`<base>T1`, not the bare v1 name) or it silently does nothing.**
- **`v1LegacyBaseNameOf(category, field)`** → `string | null`, in
  `v1-migration-map.ts` — the T-suffix-stripped legacy name every REVERSIBLE
  v1 key (`mapped`, `mapped-fanout`, or `mapped-pending-build` — corrected,
  F1, round 2; see the Fixed section below) at a (category, field) address
  shares (`bankBalanceT1..T6` → `bankBalance`), the bridge the two functions
  above are built on. Distinct from `v1KeyForAddress`, which refuses this
  exact case (there is no SINGLE v1 key once a field has six T-slot
  siblings) — this only needs the shared BASE, which the family agrees on
  by construction. Excludes any address discriminated by an instance key or
  key prefix (contact type, address type, a document-intake fan-out) rather
  than colliding unrelated legacy names into one slot; throws if two
  DIFFERENT base names ever map to one instance-less address, which would
  mean the map disagrees with its own T-slot convention. Null for a
  canonical-only field the wide table genuinely never had — not, as F1
  found, for a `mapped-fanout` field that DID have one.

### Changed — currency is derived, not listed (SYS-3259)

- `inferValueFormat` now asks the registry: a legacy name resolves through
  the map to a canonical field, and `kind: money` makes it CURRENCY — 471 v1
  keys, where the hand-written set named four. So `monthlyNetIncome`,
  `purchasePriceOTR` and every other money field stop rendering as a plain
  string, on BOTH paths. **This is a visible change on the flat path too**, on
  the consumer's next core bump. The ticket's premise ("Phase 2.6 makes this
  a deletion") held for one of the four names: `totalFinancing` is
  `relocated` and `approvedAmount` / `monthlyInstallment` are not adapter
  fields, so they stay as **`APPLICATION_RECORD_CURRENCY_FIELDS`** — named
  for what they are, with a test that fails if any of them ever becomes
  derivable. `registryMoneyLegacyNames()` is exported.

`groupDetailsByCategory` needs no instance variant: the detail type is
preserved. `buildFileFieldTablesFromInstances` itself is UNCHANGED —
`buildFileFieldTablesFromView` (above) is the new bridge that feeds it from a
`CanonicalView`, not a rewrite of it.

### Fixed

- **`processIhsDetailsFromView` threw on a category with no `instances`** —
  the sibling instance-shaped functions already guarded `?.instances ?? []`;
  this one didn't, and the API can serve that shape. Guarded the same way.
- **`processIhsDetailsFromView` could emit two identical disambiguated
  names** when three or more instances shared one (instanceKey, adapterId,
  field): the collision-disambiguated name (`…@vendor-a`) was never itself
  checked against `seen`, so a third producer collided with the second.
  Numbered past the first collision until unique.
- **`documentHashOfPath` stripped `?` but not `#`** — a DMS URL fragment
  (`…/HASH#frag`) leaked into the returned hash, breaking the join to the
  extraction key. Strips both now.

### Fixed — an opus review of the built `dist/`, round 2 (SYS-3334)

A second review — executed against the built `dist/`, not just read — found
seven more issues on the instance-shaped path above. Fixed here, before this
candidate ships; the finding numbers are the review's own.

- **F1, CRITICAL: `mapped-fanout` was excluded from `legacyBaseNameIndex`,
  so `incorporatedDate` silently vanished from the SSM and Form 9 tables
  while the value sat right there in the view.** `legacyBaseNameIndex`
  admitted only `disposition === 'mapped'`; `reverseIndex` (backing
  `v1KeyForAddress`) already admitted `mapped` + `mapped-fanout` +
  `mapped-pending-build`. `incorporatedDate` is `mapped-fanout` (two
  addresses: `company-profile`/`companyIncorporationDate`,
  `company-registration`/`companyIncorporationDate`); `instanceRowsFromView`
  `continue`d at the null and the row lost the column. Fixed by admitting
  the SAME disposition set `reverseIndex` uses — one shared constant,
  `REVERSIBLE_DISPOSITIONS`, backs both bridges now, so they cannot disagree
  again. The existing conflict guard (two different base names at one
  address) is unchanged and still catches a fanout whose siblings disagree.
  Corrected the three doc sites that claimed a field with no legacy base
  name "never had a wide column" (`v1-migration-map.ts`,
  `ihs-processing.ts`'s `instanceRowsFromView`, and this file — see above).

  **The parity delta this fix measures, named rather than left implicit:**
  with F1 fixed, exactly two catalog base columns still cannot render
  through the view path — `financials`/`tangibleAssets` (`vocabulary-gap`,
  no canonical field declared for it yet) and `financials`/`currentAssetCash`
  (`needs-decision`, eight plausible financial-statement targets and no
  exact match). A runtime test DERIVES this set from the live catalog + map
  rather than asserting a hand-written list, so a third column losing its
  address — or one of these two gaining one — fails the test immediately.

- **The honest fix for F4: `legacySlot` and `sourceLabel` on
  `CanonicalInstance`.** The review is right that `T{position+1}` is NOT
  v1's numbering — see the corrected `instanceRowsFromView` bullet above and
  the two new optional members documented there. `timePeriodOf`'s cascade
  widened from three rules to four, with `instance.legacySlot` outranking
  every derived rule; its own doc comment states plainly that the old
  rule-4 fallback is an APPROXIMATION, exact only when uploads are ordered,
  complete, and unique per slot — not "the exact numbering v1 used", which
  is what it said before this fix.

- **F3, HIGH: the provenance map's collision was silent — a re-extraction
  could stamp the OLDER value with the NEWER run's confidence.**
  `synthesized[\`${legacyBase}${row.timePeriod}\`]` was keyed per (base,
  period), not per instance, so two instances of the same document (a
  re-extraction) or two filings both `#T1` collided with a bare
  `synthesized[key] = entry` — last write wins, no signal. Fixed by hoisting
  the synthesis into the new, exported `fieldProvenanceFromView` (documented
  above), which keeps the entry with the newer `observedAt` (falling back to
  the larger `runId`, then last-in-order) and returns which keys collided.
  `buildFileFieldTablesFromView` now calls it internally; its own tests (the
  existing describe's test (f) included) now exercise this function rather
  than inline logic that could drift from it.

- **F5, MEDIUM: column order followed the extraction array, not the
  period.** `instanceRowsFromView` returned rows in view order; when intake
  order and extraction order disagreed, the table rendered descending. v1's
  `extractTimePeriods` sorted its T-slots ascending before rendering, and
  this path did not. Fixed: rows now sort by numeric period (`T1 < T2 <
  …`), rows without one trailing in original order. The `rows[i] ↔
  instances[i]` positional coupling `buildFileFieldTablesFromView` used to
  rely on to recover a row's source instance does not survive a sort, so
  that coupling was removed rather than preserved: the internal
  `instanceRowPairsFromView` now carries `{ row, instance }` PAIRS instead
  of two arrays a caller indexes in lockstep.

- **F6, MEDIUM: `instanceKey: ''` (a single-cardinality instance) rendered
  a BLANK column header.** `timePeriodOf` answered null for a row with no
  period and an empty `instanceKey`, and `instanceColumnLabel` fell back to
  `row.instanceKey` itself — `''`. Fixed: such a row now gets `timePeriod:
  'T1'` when it is the ONLY instance of its category (a single-cardinality
  category's one instance IS slot 1), else is labeled by its array position
  (`#1`, `#2`) — never `''`.

- **F7/F10: two doc-honesty fixes, named so a future reader does not have
  to rediscover either.** `legacyOriginOf`'s comment claimed a value
  degrading to `'derived'` used "the type's own documented meaning" —
  true for most cases, but not for `'form-intake'`: `IhsFieldOrigin`'s own
  doc says `derived` means "computed / no-confidence path", and a
  form-intake value is an APPLICANT's real assertion, not a computed one.
  `'derived'` is now documented as the least-wrong CLOSED-vocabulary answer,
  not a correct one. Separately, `observedAt: instance.observedAt ?? ''`
  writes a sentinel a naive date formatter chokes on
  (`new Date('')` → `Invalid Date`, not a thrown error); rather than
  loosening `IhsFieldProvenance.observedAt` to optional — which would ripple
  into every consumer that already destructures it as a plain `string` —
  the sentinel is documented at its declaration site instead, so a future
  reader finds a decision on record rather than rediscovering a bug.

- **F11: CHANGELOG claims that exceeded the code, corrected in place
  above** — the confidence-dots claim (now conditioned on finsys-api's own
  provenance-on-the-wire fix, which has not shipped as of 2026-08-19), the
  "exact numbering v1 used" claim (see F4/`legacySlot`), and the "wide table
  never had" claim (see F1). Two claims this candidate never made, ADDED
  now because a consumer needs them:

  - **`ssm_documents` / `ic_documents` / `form9` change TABLE TYPE AND CELL
    KEY between the two paths.** v1's `buildFileFieldTables` gives these
    groups `FileFieldTableType.KEY_VALUE` (their catalog columns carry no
    T-suffix, so `extractTimePeriods` finds none), each item's one cell
    keyed `'value'`. The view path's `buildInstanceTable` ALWAYS produces
    `TIME_SERIES` — unconditionally, by its own doc comment — so these
    render as a ONE-COLUMN `TIME_SERIES` table (`'T1'`) instead: the same
    "one value per field" information, under a different type enum and a
    different cell key. Inherited from `buildFileFieldTablesFromInstances`,
    unchanged by this candidate — but a consumer swapping one call for the
    other must know (finsys-client already special-cases `ssm_documents`
    for exactly this reason).
  - **Two filings both landing on `#T1`/`#T2` render FOUR columns** (`T1`,
    `T2`, `T1 (2)`, `T2 (2)`), values intact — v1's fixed three slots held
    one filing at a time. Nothing yet names WHICH filing a `(2)` column
    belongs to; that is unbuilt, not broken.

### Map correction — six PriorYear keys pointed at the CURRENT-year address

`netProfitPriorYearT1..T3` and `totalEquityPriorYearT1..T3` were `mapped`
(`via: wide-column-feeder`) onto `financial-statement`/`netProfit` and
`/totalEquity` — the SAME address as `netProfitT{n}` / `totalEquityT{n}`.
They are the Vietnam financial-statement spec's prior-year COMPARATIVE
columns, written on the SAME row as the current-year value
(`financialStatementSpecVN.ts` — the "total-comprehensive-income-…-(t-2)"
column); the registry declares no prior-year field, and the VN spec is not
period-aware. Any forward walk resolving `netProfitPriorYearT1` through the
map — a v1-shape bridge, a provenance lookup — returned the CURRENT-year net
profit under the PRIOR-year name, silently wrong.

Fixed in the generator's hand-authored overrides
(`scripts/build-v1-migration-map.py`'s new `PRIOR_YEAR_COMPARATIVE`, checked
by the RAW v1 key rather than by `base`, because these six strip to the
SAME base as their current-year siblings under the generator's own PERIOD
regex — a base-keyed override could not single them out without also
catching the six correctly-mapped current-year columns). Disposition
`needs-decision`; the note on each key names the two candidate resolutions —
(1) make the VN spec period-aware, so the comparative becomes period 2 of
the same document; (2) declare `netProfitPriorYear`/`totalEquityPriorYear`
as their own registry fields — an owner decides which. Map regenerated;
`v1-migration-map.test.ts` re-passes against the new file, plus a new pinned
assertion for these six.

**Counts moved:** `mapped` 673 → 667 (the six PriorYear keys left it);
`needs-decision` 5 → 11 (they landed there). No other disposition changed —
diffed the regenerated map against its prior committed version to confirm.

`v1LegacyBaseNameOf`'s conflict guard remains correct: `needs-decision`
entries carry no address, so they never reach `legacyBaseNameIndex`'s loop
at all. The `(PriorYear)?` branch of `v1-migration-map.ts`'s
`TIME_PERIOD_SUFFIX` regex is now UNREACHABLE there — no `mapped` /
`mapped-fanout` / `mapped-pending-build` key contains "PriorYear" anymore —
and stays in place, documented as such: it regains a live match the moment
either candidate resolution ships a PriorYear key back into `mapped`, and it
stays literal-identical to the Python generator's own PERIOD constant rather
than forking the two.

### Added — the v1-shape bridge (SYS-3334)

Both Phase 5 consumers read the v1 flat record in many places besides the
four functions above: an evaluation-data factory that walks EVERY flat key
into scoring, an SSM panel reading a dozen-plus flat keys, `jurisdictionOf`,
`MatchingUtil.isSatisfied`, header reads (`fullName`, `status`), and several
places reading the v1 `fieldProvenance` sidecar (keyed by v1 column name).
If each consumer re-derives those reads from a `CanonicalView` on its own,
the walks diverge. So core owns the bridge too.

- **`flatRecordFromView(view, record?): FlatRecordFromView`** — a v1 SHAPE
  from v2 bytes, for the migration window ONLY (C-1, round 5, stated
  plainly): new code reads the view directly; this bridge retires with the
  wide table. re-derived from a `CanonicalView` (+ an optional
  `ApplicationRecordLike` for the `relocated` keys), plus the four
  `<category>Instances` sidecars — the migration map run FORWARD (v1 key →
  address → value), so `EvaluationDataFactory`, `MatchingUtil`,
  `jurisdictionOf` and the SSM panel can read a view through one map instead
  of each growing its own reverse walk. **Iterates `v1MigrationKeys()`, not
  the view: a v1 key with no v2 value is reported, never dropped.** THE
  CEILING (C-1): 52 of the map's 771 keys (13 `retired` + 10
  `vocabulary-gap` + 11 `needs-decision` + 11 `mapped-pending-build` + 7
  `structural`) can NEVER be placed, regardless of what the view or record
  hold — so `record` holds at most 719 of 771 keys (`mapped` 667 +
  `mapped-fanout` 1 + `relocated` 51), and only that many when every one of
  them actually resolves. Every key the map holds ends up in exactly one
  place:
  - `mapped` (a plain address): the first instance carrying the field, in
    the SAME period-sorted order the rendered file-field tables use (M-1,
    round 5 — corrected from "view order"; see C-5 below), preferring the
    first NON-SENTINEL value (L-2, round 5: `null`/`''`/`'Not Specified'`/
    `false` — the same sentinels `processIhsDetailsFromView` skips before a
    reviewer ever sees them; if every instance carries only a sentinel, the
    first is placed anyway). Flags the key in `ambiguous: string[]` ONLY
    when a candidate value genuinely DIFFERS (L-1, round 5 — corrected from
    "more than one instance carries the field": two attestors reporting the
    identical fact, one as a v1 decimal string and one as a v2 typed number,
    are not a disagreement, and comparing them with a strict `!==` buried
    the keys that really do disagree in noise).
  - `mapped` with `instanceKey`: the one instance naming it.
  - `mapped` with `instanceKeyPrefix` (the document-intake pointer columns):
    the first instance whose key EQUALS the prefix or continues it at a `#`
    boundary (L-3, round 5 — corrected from a bare `startsWith`, which let a
    LONGER sibling prefix steal the match, e.g. `bankStatements` matching
    `bankStatementsExtraordinary#1`) — v1 held one path per pointer column,
    so first-in-order is the parity choice, and (unlike the plain-address
    collision above) never flagged, because it is the STATED contract rather
    than an accident.
  - A T-slot family key (`bankBalanceT1`, …): the base name every sibling
    shares (`v1LegacyBaseNameOf`, not a second regex-strip) at the row whose
    `timePeriod` equals the key's own slot (`instanceRowsFromView` — the SAME
    rows and the same `timePeriodOf` cascade the rendered file-field tables
    use, so this can't silently disagree with what a reader sees there) —
    **and now (C-5, round 5) the SAME claim holds for the WHOLE function,
    not only this branch: M-1 (above) fixed the plain-address branch to read
    this identical resolved order too, so "one derivation, read by every
    caller" is accurate for `flatRecordFromView` as a whole, not merely
    aspirational for the T-slot path alone.** More than one row sharing the
    slot places the first (the rule is unchanged) AND flags `ambiguous`
    (M-2, round 5 — a T-slot key names a SLOT, not an INSTANCE, so
    `buildInstanceTable` can render two columns under one period header
    while this can only ever place one value; before this fix the second row
    was silently dropped with no signal). Absent → `unplaced`, reason ONE OF
    THREE DISTINCT causes (L-5, round 5 — corrected from one fixed
    `'no T{n} instance'` string for all three): `'no legacy base name'`
    (defensive; unreachable via `v1MigrationKeys()` today — every T-slot
    `mapped` key's own address always contributes its base), `'no T{n} row'`,
    or `'T{n} row lacks <base>'`.
  - `mapped-fanout` (`incorporatedDate`, the map's only member today): the
    first address (the map's own address order) that has a value; a second
    address with a DIFFERENT value also flags `ambiguous`.
  - `relocated`: the three top-level specials (`ihsId` <- `applicationId`,
    `status` <- `status`, `statusDescription` <- `statusDescription`) read
    straight off `record`; every other relocated key walks `record.parties`
    -> `record.facility` -> `record.system` BY PRESENCE, not nullishness
    (H-2, round 5, HIGH — corrected from a `??` chain: `parties.jurisdiction:
    null` beside `facility.jurisdiction: 'X'` used to silently return `'X'`
    — the WRONG bucket — because `??` treats an explicit `null` as "try the
    next bucket", and it did so inconsistently: a `null` in the LAST bucket
    still got placed, because nothing was left to fall through to). **A
    bucket's explicit `null` is placed as `null` (C-6, round 5, stated
    plainly) — v1 served null for an empty relocated column, and that is a
    real assertion, never "try the next bucket".** `record` undefined, or
    the key present in NONE of the buckets, → `unplaced`, reason now NAMES
    THE SURFACE (M-3, round 5 — corrected from a bare `'relocated: not on
    the application record'` string that read identically whether the
    record genuinely lacked the key or a caller simply forgot a bucket):
    `` `relocated (surface: ${entry.surface}): not on the application
    record` `` — 48 of the 51 relocated keys carry
    `GET /lender/applications/:ihsId`, 3 (`consentCrossSelling`,
    `consentObtainInfoFromCtos`, `disclosureOfInformation`) carry the
    consent engine. A `Date` instance in ANY relocated bucket normalizes to
    its ISO string (L-6, round 5) — the ONE normalization this function
    performs on a relocated value, shape not value coercion: v1 served every
    relocated timestamp (`createdAt`, `updatedAt`, …) as an ISO string, and a
    caller assembling `ApplicationRecordLike` from an ORM row hands back
    `Date` objects instead.
  - `retired`, `vocabulary-gap`, `needs-decision`, `mapped-pending-build`,
    `structural`: NEVER placed, regardless of what the view holds —
    `unplaced` with the map entry's own `note`/`reason`. `structural` covers
    seven entries: the four instance sidecars (below) plus `documentMetadata`
    (v2 carries that as canonical `document-intake` fields), `fieldProvenance`
    (superseded by the per-value envelope — see `fieldProvenanceFromView`),
    and `invoiceInstances` (no invoice category exists in the registry yet).
  - Value coercion: NONE. Whatever the envelope (or `InstanceRow`) holds is
    placed verbatim; the consumer's own `coerceFieldValue` already handles a
    v1 decimal-as-string next to a v2 typed number.
  - The overlay projection: nothing to do — an overlaid envelope's `value`
    already IS the overlaid one, exactly as v1's own details-merge behaved.

  `unplaced: { key, disposition, reason }[]` names every v1 key this call
  could NOT place, one entry per key, never silent — a completeness pin
  (`unplaced.length + Object.keys(record).length === v1MigrationKeys().length`)
  holds for any view/record pair, so a new disposition added to the map
  cannot fall through unreported. `instances` carries the four `structural`
  sidecars (`financialStatementInstances`, `bankStatementInstances`,
  `epfStatementInstances`, `payslipInstances`) as `instanceRowsFromView`
  output — v1 shipped these as sibling arrays beside the flat record, never
  as flat keys, and this function keeps that shape rather than flattening
  them into `record`. `ApplicationRecordLike`'s own doc (round 5, L-6) now
  states the record contract plainly: WHICH key lives in WHICH bucket is the
  caller's decision, not this package's — `system` in practice carries the
  administrative/timestamp keys, `facility` the financing terms, `parties`
  borrower/lender identity.

  **L-4 (round 5): a call-local cache removes a rebuild `flatRecordFromView`
  used to pay 504 times per call.** M-1 (above) made the plain-address
  branch call `instanceRowPairsFromView` per key, same as the T-slot branch
  already did — and most keys share a category with many siblings
  (`finxtract-bank-statement` alone backs 8 T-slot base columns × up to 6
  periods). A `Map<AdapterCategory, InstanceRowPair[]>`, built once per
  `flatRecordFromView` call and shared by both lookups, turns that into one
  rebuild per category actually visited. Measured on a representative
  fixture (6 document categories, 500 calls): ~1.04ms/call uncached, ~0.19ms/call
  cached — roughly 5.6x.

### Fixed — an opus review of the built `dist/`, round 4 (SYS-3334)

A third review, over the round-2-fixed `fieldProvenanceFromView` /
`instanceRowsFromView` / `buildFileFieldTablesFromView` — nine more findings.
H1 and H2 are documented in place above (the `buildFileFieldTablesFromView`
and `fieldProvenanceFromView` bullets); the rest are here. Finding numbers
are the review's own.

- **M1: `fieldProvenanceFromView` recomputed a row's period with a second
  `timePeriodOf` call, independent of the resolved row — so F6's rescue (a
  sole `instanceKey: ''` instance position-falling-back to `'T1'`) never
  reached it.** `instanceRowsFromView` (via `instanceRowPairsFromView`)
  already resolves the FULL four-rule cascade including F6's rescue onto
  `row.timePeriod`; `fieldProvenanceFromView` threw that answer away and
  asked `timePeriodOf` again with the RAW instance, which does not know
  about F6 and answered `null` for exactly the row F6 exists to save — so a
  sole rescued instance's column could render with a `'T1'` header and never
  a confidence dot. Fixed by consuming `instanceRowPairsFromView`'s pairs
  directly, making the `.instance` member load-bearing for the first time
  (it was dead before this fix — see L2 next). One derivation of a row's
  period, read by both the rendered row and its provenance.

- **L2: the `InstanceRowPair` doc block described a coupling that no longer
  existed.** It said `buildFileFieldTablesFromView` was the reason pairs
  (not two arrays) exist — that function only ever calls `instanceRowsFromView`,
  which keeps `.row` and discards `.instance`; `fieldProvenanceFromView`
  didn't consume pairs at all yet. Corrected to name the ACTUAL reason (F5's
  sort breaking a `rows[i] ↔ instances[i]` positional coupling) and the
  actual consumer M1 makes of `.instance`.

- **M4: `instance.legacySlot` was consumed verbatim, with no shape check.**
  A producer emitting `'1'`, `'2026-06'`, or `'T1 '` (a stray trailing
  character) would put that string directly into a rendered column header
  and into a provenance key (`bankBalance2026-06`, say). finsys-api has not
  shipped this member on any real instance as of 2026-08-19 (see
  `CanonicalInstance.legacySlot`'s doc), which is what makes this the
  cheapest moment to pin the contract, before a real producer has a chance
  to violate it. Fixed: `timePeriodOf` now accepts only `/^T[1-9]\d*$/` —
  REJECTED outright when it does not match, never trimmed, so a producer bug
  is visible as a DIFFERENT (derived) period rather than accepted verbatim.
  The rule is stated on `CanonicalInstance.legacySlot`'s own doc
  (`canonical-view.ts`), not only in `ihs-processing.ts`.

- **L1: an envelope carrying ONLY `originalValue` fabricated `origin:
  'derived'`.** The no-entry guard admitted an envelope asserting none of
  `confidence`/`origin`/`originalValue`, but let `originalValue` alone
  through the gate — then stamped it `origin: legacyOriginOf(undefined)` =
  `'derived'`, the exact synthesized-from-nothing shape this function's own
  doc says it never emits. Fixed: an entry is now synthesized only when
  `confidence` or `origin` is present; `originalValue` is still carried onto
  such an entry, never a reason to create one by itself.

- **L3: `CanonicalInstance.observedAt` had no stated format**, despite
  `fieldProvenanceFromView`'s collision resolution (`challengerWins`)
  comparing it as a plain string. Documented on the member itself
  (`canonical-view.ts`): ISO-8601, UTC `Z` offset — the format that makes
  string comparison equal chronological comparison. No code change; the
  behavior was already correct, only unstated.

- **M2: the flat-vs-view parity test's item-list equality was a fixture
  artifact, and its own comment gave the wrong reason.** The fixture
  populated all 8 bank-statement base columns on both instances, which is
  the ONLY reason `viewTable.items` and `flatTable.items` could be asserted
  equal — `buildInstanceTable` DROPS a base column with no value in ANY
  instance (`if (!hasAny) continue`), while v1's `buildTableForGroup`
  (`TIME_SERIES` branch) has no such guard and renders one item per catalog
  base column regardless of data. Sparsened to 3 of 8 columns; the test now
  asserts what is actually true — view items are a SUBSET of flat items (by
  displayName), values equal by position on the ones both sides have — and
  states the real difference: **a partial extraction renders only the
  fields that came back — v1 rendered every catalog column with blank
  cells; consumers must not read a shorter view table as missing data**
  (inherited from `buildFileFieldTablesFromInstances`, unchanged by this
  candidate — named here because the old fixture's full population hid it).

- **M3: the derived-unreachable-set test covered one hand-picked document
  group (`financialStatements`) rather than all seven.** A base column
  losing its address in any OTHER group was invisible to the suite. Widened
  to loop `getDocumentTypeGroups()` and assert the whole map — six empty
  sets plus `financials`'s known two (`currentAssetCash`, `tangibleAssets`)
  — so a regression in any group goes red, not only in the one this test
  happened to check.

- **L5: four historical Jira IDs (`SYS-3249`, `SYS-3191`, `SYS-2842`,
  `SYS-2827`) had crept into NEW comment lines** across this candidate's
  three prior rounds — reworded to prose; only `SYS-3334` (this ticket) and
  `SYS-3421` (active on this same train — see the envelope's `attestations`/
  `resolvedBy` section above) remain in code comments.

### Added — `CanonicalInstance.periodPosition?` (SYS-3334)

- The 1-based period COORDINATE of a period-aware document instance (financial
  statements: 1 = the document's own current fiscal year, 2 = its prior
  comparative), when the source row stores one — distinct from `legacySlot`:
  a year-2 document's own current-year column has position 1 and NO slot (v1
  discarded it). `instanceRowsFromView` copies it onto `InstanceRow.periodPosition`
  verbatim, because v1's sidecar rows carried it and the finsys-client resolver
  selects "the true current-year row" by it — without this the view path
  silently reverted a fixed scoring bug (the T2-overlap projection standing in
  for the current year). Absent when the wire has none. Additive.

### Fixed — an executed check of the frozen candidate, round 5 addendum (SYS-3334)

- `fieldProvenanceFromView`: the mapped-fanout carve-out (two attestors of one v1
  key are not a collision) now applies ONLY when the two attestors AGREE on the
  value. When SSM and Form 9 disagree on `incorporatedDate`, each table keeps its
  own value and NEITHER carries a confidence — the key is reported in `collided`.
  Without this, the surviving entry paired one table's value with the OTHER
  attestor's confidence, source and run: a wrong-but-plausible dot. Pinned.

### Fixed — an opus review of the built `dist/`, round 5 (SYS-3334)

A fourth review, executing the tree rather than only reading it — ten more
findings on `fieldProvenanceFromView` / `flatRecordFromView` /
`valueAtTSlot` / `valueAtPlainAddress` / `valueAtInstanceKeyPrefix`. H-1,
H-2, M-1 through M-5, and the caller-override correction (M-4) are
documented in place above, next to the functions and claims they correct
(search this file for "round 5"); this section is the index. Finding
numbers are the review's own.

- **H-2 (HIGH): the `relocated` bucket walk used `??`, so an explicit `null`
  in one bucket fell through to a LATER bucket that also carried the key —
  the WRONG bucket's value.** Fixed to walk by presence
  (`Object.prototype.hasOwnProperty`), documented above next to the
  `relocated` bullet.
- **M-1: `valueAtPlainAddress` read the view's raw extraction-array order,
  not F5's period-sorted order** — a category whose upload order disagreed
  with its period order could place the flat scalar from a DIFFERENT
  document than the one the rendered table's own T1 column shows for the
  same field. Paired with **L-4**: a call-local cache of
  `instanceRowPairsFromView` (~5.6x on a representative fixture — see
  above), since the fix makes the plain-address branch call it per key too.
- **H-1 (HIGH): a `mapped-fanout` key's two attestors read as a collision.**
  `incorporatedDate`'s two addresses (SSM, Form 9) landed on the SAME
  provenance key; the collision logic could not tell that apart from two
  instances of ONE category on one slot, so SSM+Form9 present together
  dropped BOTH tables' confidence dot that SSM alone rendered fine. Fixed —
  documented above next to `fieldProvenanceFromView`'s H1/H2 bullets.
- **M-2: two rows sharing a T-slot silently picked the first with no
  signal.** A T-slot key names a SLOT, not an INSTANCE — `buildInstanceTable`
  can render two columns under one period header while the flat scalar can
  only ever hold one. Now flags `ambiguous`, same rule unchanged (place the
  first).
- **L-1: `ambiguous` fired on mere instance count, not on actual
  disagreement** — two SSM uploads reporting the identical `companyName`
  flagged as ambiguous. Fixed with a shared `candidateValuesAgree` numish/
  String compare, used identically by the plain-address pick and the
  `mapped-fanout` disagreement check.
- **L-2: the plain-address pick could place a sentinel (`''`,
  `'Not Specified'`, `null`, `false`) while a LATER instance held the real
  value** — the detail panel (reading the same view) would show the real
  name while a scoring consumer of `record` read the sentinel. Fixed to
  prefer the first NON-sentinel instance (`isSentinelValue`, shared with
  `processIhsDetailsFromView`'s own rule).
- **L-3: `valueAtInstanceKeyPrefix` used a bare `startsWith`**, so a longer
  sibling doc type's prefix (`bankStatementsExtraordinary`) could steal the
  match from a shorter one (`bankStatements`) whenever it sorted first.
  Fixed to require an exact match or a `#`-delimited continuation.
- **L-5: the T-slot `unplaced` reason was one fixed string
  (`'no T{n} instance'`) for three distinct causes.** Now distinguishes
  `'no legacy base name'` (defensive, unreachable via `v1MigrationKeys()`
  today), `'no T{n} row'`, and `'T{n} row lacks <base>'`.
- **L-6: a relocated `Date` value (an ORM row's `createdAt`/`updatedAt`)
  had no normalization** — v1 served every relocated timestamp as an ISO
  string. `ApplicationRecordLike`'s own doc now states the record contract
  (which bucket carries which keys) and the one normalization this function
  performs (`normalizeRelocatedValue`: shape, not value coercion).
- **M-5: the F3-era temporal tie-break (`challengerWins`, `winnerMeta`) was
  dead code.** H2 (round 4) unconditionally deletes a collided key's
  `provenance` entry regardless of which write "won", so the comparison's
  result was never observable. Deleted; a collision is now just recorded and
  left alone. No behavior change — every case the suite already covered
  still passes identically.
- **M-3: the relocated `unplaced` reason conflated "the record genuinely
  does not carry this" with "the caller forgot a bucket".** Now names the
  entry's `surface` (48 of 51 relocated keys are the application record's
  own `GET` route; 3 are the consent engine).

At the end of this round: `git diff -U0 -- . ':(exclude)CHANGELOG.md' | grep
'^+' | grep -oE 'SYS-[0-9]+' | sort | uniq -c` shows only `SYS-3334` and
`SYS-3421` in new code comments, same discipline L5 (round 4) established.

## [8.0.0] - 2026-08-18

**Breaking, in exactly one way, and it is a fix.** Everything else in this
release is unchanged from 7.10.0 — the category registry, the field catalogue,
the v1 migration map, the v2 envelope types, every function.

### Removed

- **The `survey-core` type re-exports from the root entry (SYS-3420):**
  `IQuestion`, `IPage`, `ISurvey`, `IPanel`, `IElement`. Import them from
  `survey-core` directly — a one-line change:

  ```ts
  // before
  import type { IQuestion } from '@finsys/core'
  // after
  import type { IQuestion } from 'survey-core'
  ```

  **Why this is a fix and not housekeeping.** `survey-core` was an *optional*
  peer, which npm does not install. The root declaration file re-exported from
  it unconditionally, so for any consumer with `skipLibCheck: false` — tsc's
  default — loading `@finsys/core` at all was
  `dist/index.d.ts(3,61): error TS2307: Cannot find module 'survey-core'`.
  This repo's own tsconfig sets `skipLibCheck: true`, so nothing here ever
  saw it; the frontier review of `@finsys/lender-client` 2.6.0 — the first
  package to put this root `.d.ts` in front of external lenders — did.
  Reproduced under node16, nodenext, bundler and node10; 7.x is broken for
  such a consumer whether or not this line is removed. Measured before
  removing: zero consumers in the estate import these five names from this
  package, and this package uses none of them itself.

- **The `survey-core` peer dependency.** It was vestigial: `generateSurveyJson`
  emits plain JSON and never imported SurveyJS. Rendering that JSON is your
  app's concern and your app's dependency. Removing the peer also removes the
  peer-range-rot hazard that broke 7.0.0 for survey-core 3 users.

### Added

- **`npm run test:consumer`** (`scripts/check-consumer-typecheck.sh`), run in
  CI: packs the tarball, installs *only* it into a fresh fixture — no optional
  peers, no repo `.npmrc` — and typechecks an import of the root entry with
  `skipLibCheck: false` under `nodenext` and `bundler`. Observed red on the
  7.10.0 tree before the fix (the exact TS2307 above), green after. Also runs
  for any package using the shared `npm-package-ci.yml` that defines the
  script.

- **A stated semver contract for the five `Canonical*` envelope types**
  (`src/canonical-view.ts`): adding a required member, removing or renaming
  *any* member — optional included, since `confidence?`/`origin?`/`runId?`
  are what a consumer uses to judge a value — or narrowing a type is a major
  of this package; adding an optional member is a minor. They are re-exported
  by the lender SDK, so a change reaches external consumers on their next
  install.

### Dependents

`@finsys/adapter-toolkit`'s peer range was `>=6.0.1 <8`; it is widened to
`<9` and released **before** this version so there is no window in which the
two cannot co-install. `@finsys/lender-client` 2.6.0 depends on `^8.0.0`.
finsys-api, finhub-adonisjs and finsys-client stay on `^7.8.0` until their
next core-touching change; none imports the removed names.

## [7.10.0] - 2026-08-18

Additive. Nothing renamed, nothing removed — a consumer on 7.9.0 upgrades
without touching anything.

### Added

- **The v2 canonical envelope types (SYS-3334).** `CanonicalView`,
  `CanonicalCategory`, `CanonicalInstance`, `CanonicalFieldEnvelope` and
  `CanonicalAddress`.

  **These describe the wire shape of a published API, and they lived only in
  `@finsys/lender-client` — the SDK built for external lenders.** Every other
  consumer therefore had two bad options: depend on an SDK meant for somebody
  else, or re-declare the shape. finhub reads finsys-api through its own
  gateway and would have re-declared it; FHD's portal would have been the third
  declaration.

  **Two declarations of one wire shape, drifting apart with nothing comparing
  them, is this estate's signature defect.** So the shape lives once, in the
  package that already owns published vocabulary — the category registry, the
  field catalogue, the v1 migration map — and the SDK re-exports it.

  Member-for-member identical to what `@finsys/lender-client` 2.5.0 declares
  (proved by parsing both `.d.ts` files, not by reading them). But note what
  2.5.0 actually shipped: it *declared* these five interfaces and never
  exported them from its index — `import type { CanonicalView } from
  '@finsys/lender-client'` is `TS2305` on 2.5.0, proved with `tsc`. A 2.5.0
  consumer holds a `CanonicalView` only as the unnamed return type of
  `getCanonicalView()`. So the SDK's re-export is not a no-op for that
  consumer: it is the first release in which the names are importable. Still
  additive — nothing a 2.5.0 consumer could write stops compiling.

  `canonical-view.test.ts` pins every member, in both directions — a literal
  carrying all optional members catches a dropped one, and a minimal literal
  catches an optional member being made required. Both pins are compile-time
  (`tsc --noEmit`) and both were mutation-proven. The two-way assignability
  check against the SDK's declaration lives in the SDK's own suite, which is
  the only place both declarations exist at once; core must not depend on a
  package that depends on core.

  **This file describes a payload, not a client.** There is no fetching here
  and no instance-selection rule: selection is the one decision every consumer
  must make identically, so it belongs with the code that reads the envelope,
  not with the types that describe it.

## [7.9.0] - 2026-08-18

Additive. Nothing renamed, nothing removed, no existing type changed — a
consumer on 7.8.0 upgrades without touching anything.

### Added

- **The v1 → canonical migration map (SYS-3414).** Where every one of the 771
  keys the v1 flat IHS response can emit goes in v2 — `v1MigrationEntry(key)`,
  `v1Addresses(key)`, `v1KeysByDisposition(d)`.

  **It answers "nothing, and here is why" as carefully as it answers "read it
  here".** 673 of 771 keys have an address. The other 98 do not, and those are
  the ones a rename table would omit — which is also where data gets lost.
  Every key without a destination carries a reason: `retired` (13),
  `relocated` to another surface (51), `structural` (7), `vocabulary-gap`
  where a destination is wanted and no canonical field exists to be one (10),
  and `needs-decision` where more than one destination is defensible and the
  choice needs an owner rather than a lookup (5).

  **The key list is a UNION over live records, and the union has to be WIDE.**
  The v1 serializer emits a key only where the record has the data, so there
  is no fixed key set: across 390 records the per-record key set ranges 346–662
  in **17 distinct shapes**.

  This bit twice, the same way. Generating from a single rich record shipped
  the map without `consents` — that record had no consent events, so the key
  was never in the input and nothing could report it missing. Widening to 150
  records fixed that and still missed **108 keys**: the whole flat projection
  of `payslip` (15 fields × T1–T6) and `epf-statement` (9 × T1–T2), because no
  SEEDED application carries those documents — only applications the e2e suite
  creates do. Both gaps were found by finsim asserting the map against a live
  deployment, which is the only place the question can be asked.

  The lesson is not "sample more". It is that a corpus is a sample of the
  surface and never the surface, so the assertion has to live where the API
  runs and keep running as the data changes.

  **Read `retired` as "this key has no v2 destination", never as "this data is
  gone."** Several retired keys are live data arriving under a different name:
  `city` and `postcode` are submitted as `permanentcity` / `permanentpostcode`,
  and `countryOfPermanentResident` arrives as `nationality`. One,
  `ssmIncorporatedDate`, is a dead column with live readers — SYS-2722
  consolidated the fact onto `incorporatedDate` in July and the two UIs that
  render it were never repointed. Finding that produced SYS-3419.

  **`mapped-fanout` is its own disposition because a fanout key cannot be
  read like the others.** One legacy column, two attestors: the wide table
  could hold one value so the second writer overwrote the first, and v2 keeps
  both instances because the disagreement is the signal. `v1Addresses()`
  therefore returns an ARRAY for every key, including single ones — an API
  returning an optional single address invites a caller to handle only that
  case and silently report one attestor's answer as "the" answer.

  **The addresses are derived from authored bridges, and the map records
  which.** `via` distinguishes `wide-column-feeder` and `form-intake-fieldmap`
  (somebody wrote the bridge down) from `name-equality` (the names simply
  matched). That distinction is not documentation. Matching on name alone put
  `companyName` on `financial-statement` and split one bank statement's fields
  across two categories while its own siblings went to a third — all
  well-formed, all wrong, because 14 canonical names are declared by more than
  one category and the first one in the file wins a match nobody checked. An
  ambiguous name is now refused rather than resolved.

  **Closure is proven on every run, not asserted once.** The generator's gate
  runs once, on a laptop; `v1-migration-map.test.ts` re-checks every address
  against the registry as it is TODAY, so renaming a canonical field turns the
  map red instead of leaving a dangling address behind. What it deliberately
  does NOT prove: that these 771 keys ARE the v1 response — this package has
  never seen that response. That check now lives in finsim as a standing spec
  (`131_sys3414_v1_map_covers_the_response.spec.ts`), asserting the map against
  a live deployment over a broad sample. It is what found `consents`, and then
  the 108 payslip/EPF keys.

  The map is `0.3.0-draft` and versioned separately from the package: it is a
  migration instrument, read once while porting, and it retires with the v1
  surface. Nothing reads it at request time.

## [7.8.0] - 2026-08-16

Additive. No field renamed, no category removed, no existing type changed — a
consumer on 7.7.0 upgrades without touching anything.

### Added

- **`document-intake` category (SYS-3174).** One instance per uploaded
  document file, with FOUR fields: `documentType`, `pathInDms`, `uploadedAt`,
  `uploadedBy`.

  **This is about the POINTER, not the document's contents.** The extracted
  values already live in `bank-statement`, `payslip`, `financial-statement`
  and the rest, each carrying full provenance. The pointer had none — a bare
  string, or a JSON array of them, in a wide column with no record of who put
  it there or when. The category gives a pointer the same standing as every
  other fact on the canonical plane. It deliberately carries no value parsed
  OUT of the document: a category mixing a file's identity with a file's
  contents makes it impossible to say which run attested what.

  **The field set was specified before it was built.** These four names were
  written down in the harness as the named contract this release has to
  satisfy, and the test asserts the set EXACTLY rather than as a superset — a
  category that quietly grows a fifth field is a vocabulary change, and
  vocabulary changes in this registry are what have repeatedly cost a major.

  **`documentType` is deliberately not `kind: "enum"`.** The closed set of
  document slots belongs to the host, varies by jurisdiction and form catalog,
  and restating it here would create a second list to keep in step with the
  first.

  All four fields resolve to `sensitive`, none opting out. Loosening a field
  later is additive; tightening one is a behavior change for every consumer
  already reading it, so the protective direction is the only safe one to ship
  first.

- **`document-intake` implementation type (SYS-3174).** A seventh
  discriminator, declaration-only: no code is loaded and neither `fetch()` nor
  `extract()` ever runs. The host's own upload path writes the canonical rows
  and records the run; the manifest is how that write becomes declared,
  provenance-carrying data rather than an untracked poke at a wide column.

  **Deliberately not filed under `extraction-pipeline`,** which is the type it
  most resembles and the one it would have been easiest to reuse. An upload
  happens BEFORE extraction and frequently without any extraction following —
  a supplementary document may never be parsed. Sharing that discriminator
  would leave provenance unable to distinguish "this file arrived" from "this
  file was read" by type alone, which is the question the `document-intake`
  category exists to answer. A type name asserting the wrong origin is not
  cosmetic here: it is baked into every provenance row written under it, and
  unpicking it later means rewriting history rather than changing a constant.

  Not `manual-override` either (an operator-override surface, and the type the
  correction model needs) nor `external-assertion` (the host never saw the
  process; here the host handles the upload itself).

  `executionModeOf` classifies it as `DeclarationOnly` and remains exhaustive —
  the `never` check makes an unhandled type a compile error, and the runtime
  still throws rather than guessing when a host runs a newer schema than its
  core.

- **`ParsedDocFile` is now exported (SYS-3174),** from the package root as well
  as its module. The host is about to attest these entries as `document-intake`
  rows, and the alternative to naming the shape here was for it to declare a
  private copy — which is exactly how the consuming codebase ended up with
  seven hand-written, mutually-disagreeing lists of "the document fields".

- **`ParsedDocFile.uploadedBy` (SYS-3174).** The one genuine gap in the stored
  file shape. Every other property the category names already travels with each
  uploaded entry; this one had no declaration anywhere in the package while a
  single upload route wrote it ad hoc into one column's entries — so for every
  other document the answer was unrecoverable rather than merely missing.
  Optional, and absent on every entry written before that route existed:
  consumers must treat "no uploader recorded" as a real and common state, not a
  defect.

### Notes

- Registry totals move from 23 categories / 283 canonical fields to **24 /
  287**. The generated vocabulary union is regenerated accordingly, so
  `document-intake` is a legal `AdapterCategoryId` at every consumer and an
  unknown id remains a compile error rather than a runtime miss.
- **No adapter, manifest or storage path ships here.** Those are the consuming
  side and could not be written until this vocabulary existed, because the
  category id is a closed generated union.

## [7.7.0] - 2026-08-15

_7.5.0 and 7.6.0 were published to the local Verdaccio during the Phase 2.6
parallel build and each carries only half of this release — 7.5.0 has
subject-company, 7.6.0 has the other three. Neither reached public npm. 7.7.0
is the integrated release and the only one that carries all four categories._

### Added

- **`subject-company` category (SYS-3359).** The company an application is
  about, as the applicant describes it. THREE fields — `entityTypeCode`,
  `companySizeCode`, `businessNatureCode` — single-instance, because one
  application has one subject company.

  **Three and not the six the transition plan grouped here.**
  `companyBackground`, `noOfEmployees` and `companyWebsite` are collected by no
  live form and are non-null on 0 of the sim's 4,622 `ihs` rows. A field no
  form can feed is worse than a missing one: an adapter over it would mint an
  APPLICANT attestation, carrying provenance saying somebody stated a value
  nobody stated.

  **This category was dropped once already, on a measurement wrong in its
  population rather than its arithmetic.** The earlier reading — all six
  columns collected by no live form — was taken against FinHub's
  `form_configs` table, 60 active rows, the corpus every Phase 2.6 manifest was
  built from. It cannot see the four lead-gen SPAs, whose form configs are
  compiled into the SPA bundle rather than stored as rows, and those are
  customer-facing. Measured across BOTH populations, `companyEntityType` is
  non-null on 507 rows, `natureOfBusiness` on 453, `companySize` on 34. Any
  future "no live form collects this" claim has to name which population it
  queried.

  **Every field is named apart from company-profile's equivalent, and none
  shares a fact with it** — the `genderCode` / `personGender` split, for the
  same reason: a per-form dropdown code and a value OCR-read off an SSM
  document are not the same fact until somebody maps the vocabularies. The
  registry enforces this for `entityTypeCode`, refusing one name across two
  categories that do not share a fact. It does NOT enforce it for
  `businessNatureCode` vs `businessNature`, where the spellings happen to
  differ — so a test pins that one, because a distinction resting on an
  accident disappears the first time someone tidies a name.

  No field declares kind `enum`. That promises a closed label set and obliges
  every producing adapter to enumerate what it emits; the only producer is a
  lead-gen SPA whose config ships from a separate repo, so the promise could go
  false on a release this registry never sees.

  `schemaVersion` 1.3.0 → 1.4.0 (additive).

- **`applicant-collateral`, `applicant-obligations` and `related-person`
  categories (SYS-3339).** Shipped in the same release as subject-company
  because Phase 2.6 lands as one train.

  `applicant-collateral` declares all 11 vehicle columns; only 3 are mapped by
  a manifest (`modelOfVehicle`, `purchasePriceOTR`, `vehicleCondition` — the
  ones a live form actually collects, and `modelOfVehicle` only on the lead-gen
  side). Declaring a field nothing maps is the `applicant-contact` precedent:
  the category models the shape, the manifest attests only what somebody gave.

  `applicant-obligations` and `related-person` are declared with **no canonical
  table and no manifest**, and recorded in an `UNBACKED_CATEGORIES` list beside
  `geolocation` with the reason. Their columns are collected by nothing —
  related-person's eight `contactPerson*` columns are not even present in
  core's v2 authoring catalog, so no lender can put them on a form today. A
  table with no writer is dead schema that reads as a shipped capability.

  The modelling arguments never depended on the counts and still hold:
  obligations is the DSR input, and five columns collapsing to
  `{obligationType, monthlyInstallment}` is what makes a sixth debt capturable.

## [7.4.0] - 2026-08-14

### Added

- **`applicant-employment` and `applicant-income` categories (SYS-3337).** The
  first applicant-typed categories that share facts with a DOCUMENT category on
  purpose: `employerName` co-attests the payslip's, and `grossPay` / `netPay`
  co-attest the payslip's. That pairing is the point — a borrower's stated
  employer or income competing with what their payslip says.

  Both money fields declare a `legacyName` (`monthlyGrossIncome`,
  `monthlyNetIncome`) so `isMonetaryField` still answers to the FLAT column
  name. Without it a stated income renders as a bare number beside denominated
  neighbours, which is the exact regression the alias exists to prevent.

  **Why these share a fact when `genderCode` does not:** both sides here are
  numbers in the same space, so a comparator has something to work with — it
  just has to read the payslip instance's `payPeriod` first, since a monthly
  statement against a fortnightly payslip differs by construction rather than
  by error. `genderCode` had no resolution between the two sides at all.

  `applicant-employment` is `multi` (a person can hold two jobs; the wide table
  cannot say so). `applicant-income` is `single` — nothing in it is job-scoped.

## [7.3.0] - 2026-08-14

_Internal only — published to a local Verdaccio during SYS-2499 Phase 2.6 and never released to npm. Superseded by 7.4.0; `npm install @finsys/core@7.3.0` will 404._

### Added

- **`applicant-address` category (SYS-3336).** ONE address shape —
  `addressLine1..3`, city, postcode, `addressStateCode`, country — distinguished
  by instance key rather than by column prefix. The wide `ihs` table spends a
  whole column family on each of permanent, residential and office and cannot
  hold a fourth; declaring this `single` would have re-encoded that limit
  permanently, and unlike a wrong field name it is not repairable later because
  the information would never have been captured.

- **`years` as a valid field unit.** A residency duration arrives as two inputs
  (years and months) and form intake has no transform slot to fold them into
  one figure, so both have to be expressible.

### Notes

- No field co-attests `personAddress`. Two categories already do —
  `person-identity` AND `epf-statement` — and they share it legitimately because
  both attest the same free-text blob. This category attests a STRUCTURED
  address across up to three instances, none obviously the one a document names;
  co-attesting would need an address normalizer and an instance correspondence,
  neither of which exists.

## [7.2.1] - 2026-08-14

_Internal only — published to a local Verdaccio during SYS-2499 Phase 2.6 and never released to npm. Superseded by 7.4.0; `npm install @finsys/core@7.2.1` will 404._

### Fixed

- **Removed `kind: "enum"` from the per-form dropdown fields** on
  `applicant-demographics` and `applicant-contact`. The host REFUSES an adapter
  whose produced enum-kind fields do not enumerate their labels, and it was
  right to: `kind: "enum"` promises a CLOSED label set, while these choice sets
  are defined per form config. A form-intake adapter spanning 60 heterogeneous
  forms cannot enumerate them, so the closure was never the category's to
  promise. The declaration, not the refusal, was the defect.

## [7.2.0] - 2026-08-14

_Internal only — published to a local Verdaccio during SYS-2499 Phase 2.6 and never released to npm. Superseded by 7.4.0; `npm install @finsys/core@7.2.0` will 404._

### Added

- **`instanceKey` on a form-intake `fieldMap` entry (SYS-3358).** A form-intake
  adapter could previously produce only ONE instance per category, which would
  have re-encoded the wide `ihs` table's central limitation — the suffixed
  column family (`bankBalanceT1..T6`, `mobilePhoneNo` beside `officePhoneNo`) —
  into the canonical model that exists to replace it. The suffix IS the
  instance, and it is why a third address or a second job is uncapturable
  today.

  Omitted means the single instance (`""`), so every existing manifest is
  unchanged and this is purely additive.

  Two decisions worth stating, because both are load-bearing:

  - **The key is declared per entry, not derived from the column name.** A rule
    reading `T1` off the end of a suffix groups `bankBalanceT1` with
    `totalCreditsT1` correctly and `emerContactTelNo1` with them wrongly, and
    nothing in the resulting data records which it did.
  - **An explicitly empty `instanceKey` is refused** (`minLength: 1`). Absent
    and `""` land in the same row, so permitting both spellings would make two
    manifests that differ on paper indistinguishable in storage.

  The schema governs SHAPE only. The invariant that a manifest declaring
  `cardinality: "single"` must carry no `instanceKey` is the HOST's to enforce.
  Not because JSON Schema is incapable — draft-07 `if`/`then` expresses it
  correctly, which a review of this release proved by execution — but because
  doing so requires restating the `fieldMap` item shape outside its
  `oneOf` branch, leaving two copies of one shape that must stay in step, and
  degrades the error from naming the adapter and its offending keys to
  "must NOT be valid". Every other cross-referencing invariant in this file
  (`produces` ⊆ category fields, `singletonFields` ⊆ `produces`,
  `fieldAuthorizations` keys ⊆ `produces`) is host-validated for the same
  reason. The split is stated on `FormIntakeFieldMapEntry` so neither side
  assumes the other did it.

- **`applicant-demographics` and `applicant-contact` categories (SYS-3338).**
  They complete the applicant-typed identity set alongside `applicant-identity`.
  Scope was measured against the 60 live form configs rather than the column
  list: all 8 demographic columns are collected by a typed input on a live
  form, while 7 of the 13 contact columns (every `*AreaCode`, the three
  `international*` ones, the unqualified `phoneNumber`) are collected by none.
  The categories still model those fields — a category describes the domain,
  while a manifest maps what a form actually asks.

  `applicant-contact` is **multi-instance**, keyed by the kind of contact point,
  and is the first category to use `instanceKey` above.

  Three deliberate ABSENCES of shared facts, each pinned by a test:

  - **`genderCode` / `raceCode` do not co-attest `personGender` / `personRace`.**
    The identity document attests OCR text off a MyKad; a form emits a dropdown
    code whose meaning is per-form — a form config carries its own choices, so
    the value set is not closed. One fact would seat `M` against `LELAKI` in the disagreement
    surface as a permanent false positive on a high-volume field. They are
    named apart as well as fact-free, since a field name is bound to one fact
    registry-wide and sharing the name would drag the fact along.
  - **`statedAge` does not reconcile against `personDateOfBirth`.** An age is
    true only on the day it was given.
  - **`contactName` does not attest `personName`.** It is an emergency
    contact — a third party — and attesting it as the subject's name is a
    genuine identity error, not a formatting one.

## [7.1.0] - 2026-08-14

_Internal only — published to a local Verdaccio during SYS-2499 Phase 2.6 and never released to npm. Superseded by 7.4.0; `npm install @finsys/core@7.1.0` will 404._

### Added

- **`applicant-identity` category — the registry's first non-document attestor.**
  Every existing category is an extraction pipeline reading a document; this one
  carries values a person typed about themselves on an application form. It is
  what makes the disagreement surface mean something on identity data: a
  borrower's spelling of their own name competing with an OCR read of their IC.

  Four fields, each co-attesting an existing fact — `personName`,
  `personIdNumber`, `personDateOfBirth`, `personNationality` — written to
  `ihs_alt_data_applicant_identity`. Additive: no existing category, field or
  fact changed, so `7.0.x` consumers are unaffected until they opt in.

  The field set was confirmed against the **60 live form configs**, not assumed.
  Two findings shaped it:

  - `personAddress`, `personReligion` and `personPlaceOfBirth` are collected by
    no form, so applicant-identity attests 4 of person-identity's 9 fields.
  - **`gender` and `race` are deliberately excluded.** Forms collect them as
    dropdowns carrying codes (`M`, `01`) while the identity document attests
    whatever is printed on the card, as free text off an OCR read. Same concept,
    two vocabularies.

    A code-to-label mapping does exist — `BASE_FIELD_SPECS` seeds one (`M` →
    Male, `01` → Malaysian - Chinese) — but it is not authoritative, because a
    form config may override and extend those choices and 30 of the live ones
    do. So the mapping that applies to any given value is *that form's*, which
    means resolving a code is a per-attestation lookup rather than a constant.

    Two further things block it. Shared facts must agree on `kind`, and
    `person-identity` declares these as free strings because OCR text is not a
    closed set — so declaring the form side `enum` throws, and declaring it a
    free string would be false about a dropdown. And even once the code is
    resolved, the label has to be compared against what the card actually
    prints, which is Malay on a MyKad — a second mapping that does not exist.
    Until those are settled, a comparison would report disagreement on every row
    and train everyone to ignore the surface.

  Adding a category was previously invisible to the test suite — count, field
  set and attestor sets were all unasserted. `applicant-identity.test.ts` closes
  that, and pins the gender/race exclusion so it is not later "completed" by
  someone who reads it as an omission.

## [7.0.1] - 2026-08-14

### Fixed

- **`survey-core` peer range widened to `>=2.5.0 <4`.** survey-core 3.0.0
  published on 2026-08-11; 7.0.0 shipped two days later still declaring
  `^2.5.0`, so `npm install @finsys/core` **failed outright** for anyone with a
  current survey-core:

  ```
  npm error Conflicting peer dependency: survey-core@2.5.38
  npm error   peerOptional survey-core@"^2.5.0" from @finsys/core@7.0.0
  ```

  Note `peerDependenciesMeta.optional` does **not** rescue this. Optional means
  npm tolerates the peer being *absent*; a peer that is present and out of range
  is still a hard `ERESOLVE`. 7.0.0 cannot be repaired in place (npm unpublish is
  restricted) — use 7.0.1.

  Both ends of the new range are exercised, not assumed: 2.5.x by CI, and 3.0.0
  by a full `tsc --noEmit` + build + 586-test run. Core's only coupling to
  survey-core is a type re-export (`IQuestion`, `IPage`, `ISurvey`, `IPanel`,
  `IElement`) and SurveyJS-shaped JSON generation; all five types exist
  unchanged in 3.x.

- **The release preflight mis-read `||` ranges.** `admitsMajor()` matched only
  the first clause of a union, so a valid `^2.5.0 || ^3.0.0` was reported as
  excluding a latest of 3 — a wrong verdict rather than the fail-closed the
  parser is documented to produce. It now splits on `||`, admits when any clause
  admits, and returns "unreadable" only when no clause admits and one cannot be
  parsed.

## [7.0.0] - 2026-08-14

### Changed — BREAKING

- **`AdapterCategory` and `CanonicalFieldName` are literal unions, generated from
  the registry.** Both were aliases to `string`, so every "typed" vocabulary in
  every consumer was unchecked. The original reasoning held while the set only
  GREW — growth is backwards-compatible and a runtime check suffices. It stopped
  holding once names get RETIRED: the registry's lookups fail *open* by design
  (`resolveCanonical*` answers null and callers read null as "not a rename"), so
  a retired name left in a consumer is a silent runtime miss. Compile-time
  membership turns that into a build failure at the site that needs editing, and
  `tsc` suggests the replacement by proximity.

  **What breaks:** assigning an arbitrary `string` to either type. Boundary
  functions are unaffected — `resolveCanonicalCategoryId`,
  `resolveCanonicalFieldName`, `isAdapterCategory` and `assertAdapterCategory`
  keep `string` parameters (they exist to test untrusted input) and now narrow
  on return.

  **What does not break:** the vocabulary itself. No field, category or schema
  changed — verified by diffing 6.0.2's `adapter-categories.json` against this
  release's: byte-identical. A running service built against 6.x is unaffected;
  types are erased.

- **`AdapterManifest.enumValues` is now `Partial<Record<…>>`.** It was a total
  `Record`, which only ever type-checked because the key was `string` — an index
  signature any subset satisfied. Under a literal union a total record demands
  all 224 canonical fields, which was never the intent: `enumValues` is a sparse
  map naming only the enum-kind fields an adapter produces. Every other
  vocabulary-keyed map was already `Partial`; this was the outlier.

### Added

- **`src/vocabulary.generated.ts`** — `AdapterCategoryId`,
  `CanonicalFieldNameLiteral` and `RetiredFieldName` as literal unions
  (13 categories, 224 canonical fields, 84 retired names). Committed rather than
  built on the fly, because the union diff is the review artifact: retiring a
  name should be visible in the PR that does it, not discovered later by a
  consumer's failing build.

- **A generation-drift check.** `npm run gen:vocabulary -- --check` fails when
  the committed file has drifted from `adapter-categories.json`, and runs in the
  test suite. A stale generated file is worse than none — it asserts a
  vocabulary the platform no longer has.

- **A disjointness guarantee.** The generator refuses to emit overlapping
  unions, and a test asserts the same of the shipped registry: a name cannot be
  both live and retired, or a consumer cannot tell which meaning applies.

### Migration

Consumers pin with a caret below 7 and commit lockfiles, so nothing upgrades
automatically — the cutover is the PR that edits `package.json`, not a deploy.
On upgrading, `tsc` reports every stale vocabulary literal. Deliberate escapes
(a test asserting a runtime guard rejects an invalid name, a synthetic fixture
registry) should be named rather than bare casts, so they stay greppable.

Types say nothing about the **wire**: a build against 7 talking to a service on
6 remains a runtime concern.


## [6.0.2] - 2026-08-13

### Fixed

- **The 6.0.1 release notes described a category rename that never shipped.** They
  said the partner feed became `bank-account-activity` and the document became
  `bank-statement`. Neither happened — it was reverted before release, because
  reusing `bank-statement` for a different category made it simultaneously a live
  id and another category's recorded `legacyId`. A partner feeding bank-statement
  **documents** who followed those notes would have set `category: "bank-statement"`
  and been silently validated against the partner-feed field set, with no warning,
  because it is a live id. Corrected, with the revert and its reason recorded.
- Release notes were filed under `6.0.0`, which was tagged internally and never
  published. `6.0.1` is the first 6.x release on npm.
- Three counts in those notes were wrong (88 renamed fields, 4 category ids, 38
  across the six categories). Measured: **84** of 236 fields, **6** category ids,
  **44** across those six.

### Changed

- **Shared-fact attestations must now agree on `type` and `unit`**, not only on
  `fact`, `kind` and `confidentiality`. `kind` implies type for money and enum,
  so that subset was already refused — which is what made this look covered. The
  six kind-less shared facts (`personName`, `personIdNumber`, `personAddress`,
  `companyName`, `companyRegNo`, `companyIncorporationDate`) were unpoliced: one
  could be declared `string` by three categories and `number` by a fourth and the
  registry would load clean. Cross-source comparability is the entire reason a
  fact id exists, so two attestations that cannot be compared as the same
  primitive are not attestations of the same fact.

  No shipped data changes — the current registry already agrees. This closes the
  next edit, not this one.

## [6.0.1] - 2026-08-13

_6.0.0 was tagged internally and never published; 6.0.1 is the first 6.x release on npm._

### Changed — BREAKING: the whole-registry naming sweep (SYS-3333)

Widened 2026-08-13 from the document categories to the entire registry, on the
reasoning that this epic is the one pass over the full field list before a
CRA-regulated bureau ships, and a half-swept vocabulary is worse than either end
state because it looks finished.

The sweep, measured rather than estimated:

| class | found | 
|---|---|
| category ids renamed | 6 |
| field names baking in a currency | 5 — all already `kind: "money"` |
| field names baking in a time window | 15, in **two** conventions (`24m`/`90d` vs `T3`/`T12`) |
| field names repeating their own source | ~50 |

**Category ids** — `finxtract-` names a vendor and belongs on ADAPTER ids:
`ic`→`person-identity`, `finxtract-epf`→`epf-statement`,
`finxtract-payslip`→`payslip`, `finxtract-financial-statement`→`financial-statement`,
`finxtract-form9`→`company-registration`, `finxtract-ssm`→`company-profile`.

The two bank categories keep the ids they have: `bank-statement` is the partner
feed of derived monthly metrics, and `finxtract-bank-statement` is the statement
document — the one id in the registry still carrying a vendor prefix.

An earlier draft of this release renamed both (`bank-statement`→
`bank-account-activity`, `finxtract-bank-statement`→`bank-statement`) and it was
**reverted before shipping**. Reusing `bank-statement` for a different category
made it simultaneously a live id and another category's recorded `legacyId`, so
a pre-existing manifest naming it became genuinely ambiguous with no correct
resolution. The loader now refuses such a registry outright.

If you feed bank-statement **documents**, your category is
`finxtract-bank-statement`. Note that `bank-statement` will resolve without a
warning — it is a live id, just not yours.

**Fields** — 84 renamed, of 236 across 13 categories. Currencies come off names (SYS-3249: a
denomination belongs to the observation); `T3`/`T12` become `3m`/`12m`; every
`telco*`/`payments*`/`social*`/`geo*`/`bank*`/`payslip*`/`epf*`/`ssm*` prefix
comes off, because the category already says the source and a prefixed name can
never share a fact.

Two places the mechanical rule produced a WORSE name, listed rather than
silently applied: `bankName`→`issuingBankName` (not `name`, which is meaningless
in a report) and `geoAccuracyM`→`accuracyMeters` (not `accuracyM`, which hides a
unit). `arTotalOutstanding` keeps its `ar`: accounts-receivable is a domain
term, not a source.

**Shared facts go from 3 to 9.** `personName` is now attested by four
categories, `closingBalance` / `totalCredits` / `totalDebits` by both bank
sources. Each is a proposition two sources can visibly disagree about — which is
the point.

### Added — the conventions are enforced at load

A one-time cleanup with no guard is a cleanup that happens again. `buildCategoryRegistry`
now refuses a currency-suffixed field name and the retired `T<n>` window form,
with errors that explain the rule rather than merely citing it.

Only mechanically-decidable rules are enforced. "A name should not repeat its
source" needs judgement — `statementDate` in a `bank-statement` category is fine
— so it is asserted in the tests instead. A load-time throw that misfires is
worse than no rule, because the next person works around it.

### Changed — the document-category half (SYS-3333)

A category is a **field set, not a source**. Until now several categories said
otherwise in their own ids and field names, and that is what made a shared fact
inexpressible: core binds a fact id to exactly one field NAME, so
`payslipEmployeeName` could never attest the same fact as `personName` no
matter how obviously they are the same person.

Measured before the change, against the live registry: **four sources already
attest an applicant's name** — `ic.personName`, `payslipEmployeeName`,
`epfAccountHolderName`, `accountHolderName` — and exactly one declared it as a
fact. A borrower typing a name different from their IC was caught; a payslip in
a different name was not.

**Category ids** (`finxtract-` names the vendor and stays on *adapter* ids):

| was | now |
|---|---|
| `ic` | `person-identity` |
| `finxtract-epf` | `epf-statement` |
| `finxtract-payslip` | `payslip` |

`finxtract-bank-statement` deliberately keeps its id: de-prefixing it collides
with the partner-feed `bank-statement` category, and resolving that means
renaming the *partner* category — a partner-facing contract, and a separate
decision. The field-level shared facts below do not depend on it.

**Fields**: 44 renamed off their source prefix across `payslip`,
`epf-statement`, `person-identity`, `finxtract-bank-statement`,
`bank-statement` and `finxtract-ssm`. Nine facts are now attested by more than
one category — `personName` by four.

`bankClosingBalanceMyr` / `bankTotalCreditsMyr` / `bankTotalDebitsMyr` /
`bankLargestSingleCreditMyr` lose the baked-in currency, per SYS-3249: a
denomination belongs to the observation, not to the field name.

This reverses a prior deliberate decision that the two bank categories share
**zero** canonical names, on the reasoning that "a manifest can never
accidentally produce across the two vocabularies". That concern is now handled
by a stronger rule than name-disjointness: core refuses a shared name unless
every declaration carries the same fact id, so sharing is a written-down
decision rather than an accident.

### Added — `legacyName`, and the silent degrade that required it

Renaming the canonical vocabulary broke something that had nothing to do with
naming. `isMonetaryField()` is handed a **flat** column name and matched it
against **canonical** names — which worked only while the two were identical.
Once `payslipGrossPay` became `grossPay` canonically while the flat column kept
its own name, the lookup missed and a money value rendered as a bare number
beside its denominated neighbours. No exception, no log line: exactly the
failure SYS-3249's denomination work exists to prevent, reintroduced by a
rename. Caught by core's own tests, not by review.

So a renamed field now records its previous flat name **on itself**, where it
cannot drift from the rename that created it:

- `CanonicalFieldSpec.legacyName` — the pre-rename flat name.
- `resolveCanonicalFieldName(name)` — resolves a name from *either* vocabulary,
  returning it unchanged when already canonical. Transitional: it exists
  because the flat columns still exist, and goes when they do.

Load-time guards, because an alias that resolves to the wrong field is worse
than no alias: a legacy name may not shadow a live canonical name, two fields
may not claim the same legacy name, and a field may not declare a legacy name
identical to its own.

A `legacyName` is **not** a second canonical name — it never widens what an
adapter may `produce`, is not addressable in an eval model, and carries no
fact.


## [5.5.0] - 2026-08-08

### Added — a national id does not always carry a birth date (SYS-3257)

`JURISDICTION_NATIONAL_ID_ENCODES_BIRTH_DATE` and `nationalIdEncodesBirthDate`.

A Malaysia-specific parsing rule was running on every application regardless of
jurisdiction: the first six digits of an NRIC are the birth date as `YYMMDD`,
and that is true of no other national id we accept. Measured against real id
shapes rather than reasoned about:

| Jurisdiction | Id | Derived | |
|---|---|---|---|
| MY NRIC | `900115085432` | `1990-01-15` | correct |
| VN CCCD | `001201123456` | `2000-12-01` | **plausible and wrong** |
| TH natID | `1103701234567` | `"Invalid date"` | |
| TH natID | `5501200098765` | `2055-01-20` | **thirty years in the future** |

A Vietnamese CCCD leads with a province code, a gender/century digit and a
two-digit birth *year* — not a date. A Thai national id encodes no birth date
anywhere. So the failure was silent in both directions: sometimes an
unparseable string written to a date column, sometimes a believable date that
is simply false.

**Absence resolves to Malaysia**, via `resolveJurisdiction`, and that is
load-bearing rather than merely consistent. Rows created without a resolved
program carry `jurisdiction = null` and every one of them is Malaysian — a
literal `=== 'MY'` check at the call site would stop deriving for all of them,
turning a fix for Vietnam into a regression for Malaysia. An **unresolvable**
jurisdiction returns `false`; deriving on a code we do not recognise is the
guess this replaces.

A registry entry rather than a check at the call site, so a fourth jurisdiction
is a line here instead of an edit to whatever function happens to parse ids
that week.

## [5.4.0] - 2026-08-07

### Added — one money formatter for every app (SYS-3284 / SYS-3285)

`formatMoney(value, { currency?, jurisdiction? })`, plus
`resolveDisplayCurrency` and `JURISDICTION_DISPLAY_CURRENCY`.

FinHub and finsys-client each had their own. FinHub hardcoded
`Intl.NumberFormat('en-MY', { currency: 'MYR' })` on the IHS views, so a
Vietnamese application's amounts read as ringgit. finsys-client had five
separate no-currency implementations plus two copy-pasted `myr()` helpers that
stamped `RM` unconditionally — including into the text fed to the AI analyst,
so the model reasoned about a Vietnamese company in ringgit.

**Precedence:** the value's own recorded currency wins, then the
jurisdiction's display default (MY→MYR, VN→VND, TH→THB), then *nothing* — and
nothing prints a grouped number with no denomination, which is honest where a
guess is not.

**This does not undo SYS-3249.** A currency belongs to the OBSERVATION, because
one document can legitimately report several. This map is a display default
for values that do not say — never written to a record, never returned as its
currency, and always losing to a value that carries its own.

An *unresolvable* jurisdiction yields no currency rather than Malaysia.
Defaulting there would be the same class of error as the hardcoded literal it
replaces, only harder to see.

`currencyDisplay: 'code'` is deliberate: under `en-US`, USD renders as a bare
`$` while MYR/VND/THB/SGD render as codes — symbol display hands the one
unambiguous-looking glyph to the currency whose glyph several others share.

### Added — `NO_JURISDICTION_BASIS`, and `formatMoney` requires a jurisdiction

There are two different "I have no jurisdiction", and 5.4.0 initially
collapsed them. `formatMoney(v, {})` returned **MYR** — identical to
`formatMoney(v, { jurisdiction: null })`, which is a different claim:

- a **record** whose jurisdiction column is null *is* Malaysian (every such
  row predates jurisdictions), so `null` is a real answer;
- a **call site** with no record — a form with no program selected, a total
  spanning countries, a page never told — has no basis, and answering that
  with a confident MYR is the exact bug these helpers replace.

Both consumers built private defenses against this before the release: FinHub
made its wrapper's parameter required with a warning comment, finsys-client
defined its own empty-string sentinel. Two independent workarounds for one
missing idea is what named it.

`jurisdiction` is now a **required** key on `formatMoney`, so the careless call
does not compile rather than being documented as wrong, and
`NO_JURISDICTION_BASIS` is the exported way to say there is no basis — giving
`resolveJurisdiction('')`'s fail-closed behavior a name and a contract instead
of leaving it an implementation detail two repos happened to discover.

Precedence is unchanged: a currency carried by the value still wins over both.

### Changed — a form-field label no longer names a currency (SYS-3289)

`form-field-base-specs.json` shipped `"Financing Amount (RM)"` and
`"Car Price (MYR)"`. Because the currency was *prose inside the label*, it
rendered identically under a Vietnamese program — where it is simply false —
and no rendering code could correct it. Found by running the two-jurisdiction
demo: a Vietnamese borrower was being asked for ringgit.

Those three labels lose their currency, and the fields that hold money declare
`kind: "money"` instead. That is the same word `CanonicalFieldSpec.kind`
already uses (SYS-3249), so both halves of the system say one thing: a field
says it holds money, and the *denomination* comes from elsewhere — the
program's jurisdiction at render time, or the value's own provenance envelope
once it has one.

`FieldData.kind` is typed for the first time here; it previously arrived
through the interface's index signature.

A guard test refuses a currency token in any `displayName`, `placeholder`,
`title` or validator message, drawing its token list from
`JURISDICTION_DISPLAY_CURRENCY` so it widens as jurisdictions are added. One
string is exempt by name — `"Income must be at least RM 2000."` — because
there the threshold and the currency are a single statement, and deleting the
word would only make it less obviously wrong. That is SYS-3290.

**Consumers must move together.** FinHub's `FieldRenderer` decides whether to
show a currency prefix by substring-matching the label for `RM`, so a consumer
that takes this catalog without the matching renderer change loses the prefix
on Malaysian sliders. Form configs already stored in production are not
migrated; they keep today's behavior through the renderer's legacy fallback.

## [5.3.0] - 2026-08-06

### Added — Thailand (SYS-3258)

`JURISDICTION.THAILAND = 'TH'`, plus the matching entry in
`unified-form.schema.json`'s enum.

Adding a third jurisdiction was an experiment, not a customer requirement: two
jurisdictions cannot show whether an axis is additive, because the second is
always special-cased. In core it cost exactly two edits, and **both were named
by failing tests rather than found by hand** — the registry pin, and the drift
test that caught the schema enum lagging behind the registry. That duplicate
enum is a deliberate second source of truth (FinHub validates form configs only
through the schema, never via `FormSpec`), so it *can* drift; the test is why
it cannot drift silently.

### Fixed

- `package.json` said `5.2.0` while `package-lock.json` said `5.3.0`. `npm ci`
  tolerates that silently, but `npm publish` reads `package.json` and would
  have attempted to republish an existing version.
- `unified-form.schema.json` declared `jurisdiction` **twice** in the same
  `properties` object. JSON keeps the last, so the first block — including its
  explanation of why the enum exists — was authoritative-looking dead text. A
  future edit touching only that block would have been silently ignored while
  appearing correct.

### Known limit

Adding a jurisdiction is **not** purely additive for document uploads:
extraction requires a `documentLanguage` for any non-Malaysian jurisdiction,
and the only field carrying `document_language_options` is `financials_vn` —
with `document-types.test.ts` actively forbidding another. Tracked as SYS-3277.

## [5.2.0] - 2026-08-06

### Added — the jurisdiction compatibility predicate (SYS-3266)

`checkJurisdictionCompatibility(formJurisdiction, programJurisdiction)`, plus
`describeIncompatibility` and the `IncompatibilityReason` enum.

One predicate with three call sites, because the rule is symmetric: filter forms for a chosen
program, filter programs for a chosen form, and refuse a mismatch at submit. The first two
are the reason nobody reaches the third.

- Consumed by **FinHub** (the manager tier) and **@finsys/borrower-client** (the SDK tier).
  Raw HTTP callers are unguarded by design.
- **Absence resolves to Malaysia on both sides**, through `resolveJurisdiction`, so there is
  one definition of absent rather than another. An empty string is *not* absent.
- **An unrecognized value is compatible with nothing — including an identical unrecognized
  value on the other side.** Two sides both declaring `"VM"` is the same typo twice, not
  agreement; letting a pair of mistakes authorise each other is the silent pass this axis
  exists to prevent.
- Returns a result rather than a boolean, so every tier phrases a refusal identically instead
  of re-deriving it from inputs.


### Added — form specs declare a jurisdiction (SYS-3263)

A form declares the SINGLE jurisdiction it is valid for. A form for jurisdiction X may be
used by many programs in jurisdiction X; forms are not scoped to a program. The rule — that
a form's jurisdiction and its target program's jurisdiction must agree — is NOT enforced
here: that is SYS-3265, blocked on SYS-3264, because a submission does not currently record
which form produced it.

- `FormSpec.jurisdiction` (optional) and `effectiveJurisdiction`, which returns the
  declaration, Malaysia when absent, and **null when present but unrecognized**. Callers must
  handle null: it means "declares something we do not recognize", not "is Malaysian".
- `UnifiedFormConfig.jurisdiction` — declared here too, because FinHub never constructs a
  `FormSpec` and handles form configs only as this shape.
- A new jurisdiction registry: `JURISDICTION`, `DEFAULT_JURISDICTION`, `JURISDICTION_CODES`,
  `isJurisdiction`, `resolveJurisdiction`, `Jurisdiction`.
- **Absent means Malaysia** — `undefined` and `null` both. No form authored before this
  declares anything and none is backfilled, matching the null-means-MY precedent SYS-2872 set.
  An **empty string is NOT absent**: it is unresolvable, because finsys-api fails closed on it
  and returning Malaysia would turn "refuse extraction" into "extract as Malaysian".

### Changed — `validateFormConfig` accepts a strictly smaller set

**Not purely additive, despite being a minor.** The unified-form schema has no root
`additionalProperties: false`, so `jurisdiction` was previously an ignored unknown key and any
value passed. It is now constrained: an unrecognized code, or a non-string, is rejected.
Nothing writes the key today so the practical risk is nil — but FinHub is trunk-to-prod and
rejects form-config uploads on this validator, so the shrink is stated rather than assumed.

The schema's `enum` is a deliberate second source of truth for the code set, kept because
FinHub validates ONLY through the schema and would otherwise store an unknown jurisdiction
unchecked. A drift test pins it against `JURISDICTION_CODES`; adding a jurisdiction means
editing both, and the test fails if you edit one.


## [5.1.0] — 2026-08-06

### Changed — currency belongs to the value, not the field definition (SYS-3249)

143 canonical fields declared `unit: "MYR"`. That asserts a Malaysian denomination as a
property of the FIELD, on fields a Vietnamese financial statement already writes. Currency
is a property of the OBSERVATION: one source can report several currencies in a single
document, so no field-level currency can be right for more than one of them.

- **`kind` gains `"money"`** alongside `"enum"` — still a semantic refinement of `type`,
  because a monetary value's primitive is a number; what differs is that the number is
  incomplete without a denomination. A money field must be `type: "number"` and declares
  neither a `unit` nor a `range`.
- **`unit` is now a closed, load-validated set** of intrinsic measures (`ratio`, `months`,
  `days`, `hours`, `count`, `meters`, `deg`, `rating`, `score`). Declaring a currency is a
  hard load error with an explanation. An allow-list rather than a currency blocklist: a
  blocklist only catches the shapes someone thought of.
- **`IhsFieldProvenance.currency`** (optional) carries the ISO 4217 denomination per value.
  Absence means UNKNOWN, never a default — defaulting would render a VND figure as ringgit,
  the exact failure this prevents.
- **`data/adapter-categories.json`**: 143 fields moved `unit: "MYR"` → `kind: "money"`; the
  9 that also carried a MYR-scaled `range` had it removed (a numeric bound on money is
  denominated by definition — `telcoArpuMyr [0, 10000]` is sane in ringgit and ~20x too
  small in dong). `schemaVersion` 1.2.0 → 1.3.0.
- **Rendering**: `buildFileFieldTables` / `processIhsDetails` format monetary values in
  their carried currency, so fraction digits come from the currency (VND is zero-decimal).
  Monetary fields are now identified from the category registry rather than a substring
  word list, which had missed 51 of the 143.

- **Fraction digits are no longer invented.** The numeric branch previously forced
  `minimumFractionDigits: 2` on everything. That is a claim about precision, and it was wrong
  in two directions: not every number here is money (`cashConversionCycleDays` rendered
  `45.00`, `totalShareIssued` rendered `1,000,000.00`), and not every currency has two decimal
  places — VND and JPY have none, so a value whose currency we do *not* know is exactly the
  one we have no basis to render with two decimals. Now: where the currency is known it
  decides; otherwise the value is grouped and its own precision preserved.

**Visible rendering changes for existing data, currency or not.** Two, both affecting the IHS
detail view in finhub-adonisjs and finsys-client:

- The 51 previously-invisible money fields gain thousands separators — `payslipGrossPay`
  renders `15,000,000` where it rendered `15000000`.
- Amounts no longer gain trailing `.00`. `1234.5` renders `1,234.5` rather than `1,234.50`
  when no currency is recorded, and `MYR 1,234.50` when it is.

Both are corrections rather than regressions, but they are what an existing user sees without
any new data arriving.

**A note for consumers that string-match or export.** When a currency IS known, `Intl`
separates the code from the amount with U+00A0 (a non-breaking space), e.g.
`MYR 1,234.50`. That is deliberate on Intl's part and is left intact rather than
rewritten; anything comparing or exporting these strings should normalise whitespace.

**Not breaking.** `unit` appears nowhere in the adapter manifest contract — it exists only
in this package's own data file — and nothing outside the loader's own validation consumed
`unit` or `range`. Verified against finsys-api, finhub-adonisjs and finsys-client.

**One behaviour change to expect downstream:** consumers that branch on `kind` see a new
value. finsys-client's `evaluation_model.ts` warns (`EnumMapFieldKind`) when an eval model
maps enum labels against a field whose `kind` is neither `string` nor `enum` — so models
mapping a monetary field will begin emitting that warning once finsys-client bumps. Correct
and non-blocking, but new.

**Deferred, breaking, needs its own major:** nine field names still carry a `Myr` suffix
(`telcoArpuMyr`, `bankClosingBalanceMyr`, …). Names are fact ids, so renaming them is a
major — `icName` → `personName` (SYS-3163) is the precedent. Their descriptions no longer
claim a denomination.

## [5.0.0] — 2026-08-02

### Changed — BREAKING (vocabulary)

- **Five `ic` identity fields lose the source prefix (SYS-3163).** `icName` →
  `personName`, `icNumber` → `personIdNumber`, `icDateOfBirth` →
  `personDateOfBirth`, `icNationality` → `personNationality`, `icRace` →
  `personRace`. Each pre-declares a matching `fact` id.

  **Why these five and not all nine:** the `ic*` prefix encoded the SOURCE of
  a value, which the adapter model already records far better via manifest
  identity and adapter runs. A fact id is bound to exactly one field name
  registry-wide, so two categories can only share a fact by declaring the same
  name — meaning a borrower-typed name could never share a fact with an
  IC-extracted one while the names differed. These five are exactly the ones a
  form-intake `applicant-identity` category will also attest (they have
  counterparts in the live lead-gen form configs). `icAddress`, `icGender`,
  `icReligion` and `icPlaceOfBirth` keep the prefix deliberately: no form
  collects them, so they have no second attester and nothing to share with.

  The `fact` is pre-declared even though `ic` is the only attester today. A
  uniquely-declared field may carry one, and doing it now makes the eventual
  `applicant-identity` category purely ADDITIVE — it declares the same name
  and fact, and nothing about `ic` changes. Without it the shared-name rule
  would refuse the pair and force a second edit to a published contract.

  **Breaking for consumers that name these fields**, on the same terms as the
  company-fact change above: a manifest listing an old name in `produces` is
  refused at registration. finsys-api's builtin `finxtract-ic-v1` is such a
  caller. No database change implied.
- **`AdapterManifest.cardinality` is now REQUIRED (SYS-3171).** It was optional
  so pre-existing manifests could rely on the implicit convention (instanceKey
  `""` → single, non-empty → multi) with the host inferring. Inference is the
  problem: it cannot distinguish a declared-single adapter emitting a
  multi-keyed instance from a legitimately multi one, so the host stored the
  mismatch silently instead of rejecting it. Every in-repo manifest already
  declared it, so this costs nothing here — the migration is for adapters
  maintained outside this package.

- **Removed the deprecated `validateFormSpec` and `validatePagesConfig`
  exports (SYS-3171).** Both only called `validateFormConfig`. A sweep of
  finsys-api, finhub-adonisjs, finsys-client, lead-gen-ui and
  finsys-adapter-toolkit found zero consumers; a major is the one moment
  removing them is free.

- **`CanonicalFieldSpec.confidentiality` is now always present on a built
  spec (SYS-3171).** Authoring is unchanged and still opt-out-only — the data
  file omits the property, and `"sensitive"` remains unspellable there — but
  the registry now resolves it, so every built spec states the class outright
  (`"sensitive" | "non-sensitive"`). The registry is serialised verbatim to
  finhub and finsys-client, and on that wire "absent means sensitive" was
  carried by nothing: a consumer writing `if (field.confidentiality)
  protect()` read exactly backwards and compiled clean. This makes the
  invariant structural rather than documented. Breaking only for code that
  CONSTRUCTS a `CanonicalFieldSpec`; consumers that read or spread are
  unaffected.

- **Company name and registration number are now shared facts across all three
  attesting documents (SYS-3163).** `finxtract-ssm` renames `ssmCompanyName` →
  `companyName` and `ssmCompanyRegNo` → `companyRegNo`, both carrying the
  matching `fact` id; `finxtract-form9`'s `companyRegNo` gains `fact:
  "companyRegNo"`, which the shared-name rule requires (a name declared by two
  categories where one carries no fact is refused at load).

  **Why:** three documents attest a company's name — Form 9, SSM and the
  financial statement — but only two shared the fact, because SSM's was a
  separately-named field. A Form 9 / SSM name conflict was therefore invisible
  to the disagreement surface, by construction rather than by oversight. Same
  for the registration number.

  **Breaking for consumers that name these fields.** `ssmCompanyName` and
  `ssmCompanyRegNo` no longer exist in the category vocabulary, so any adapter
  manifest listing them in `produces` will be REFUSED at registration
  (`categoryFieldsOf` membership check). finsys-api's builtin
  `finxtract-ssm-v1` manifest is one such caller and must be updated in
  lockstep — its rename is deliberately sequenced AFTER this release, because
  doing it first would break SSM extraction against the currently-installed
  core.

  No database change is implied. Canonical rows already decouple the physical
  column from the field name via TypeORM's `name:` mapping, so consumers rename
  entity properties and leave their columns alone.

### Fixed

- **Field-confidentiality follow-ups (SYS-3169).** Corrections to the SYS-3164
  contract that landed after 4.10.0 was cut. The `confidentiality` doc comment
  claimed more coverage than the mechanism has, and that comment propagates
  into the published `.d.ts` — it now states the two limits plainly: it reaches
  CANONICAL data only (no category is canonical over the legacy wide `ihs`
  table, so a field still living in an `ihs` column is untouched until the
  adapter transition relocates it), and raw payloads store the same values
  separately under their own retention window, so encrypting a canonical
  column alone makes the guarantee "at rest, in one of two places".
  Repo-side, removed a test that would have gone red the moment anyone
  classified the first field — it asserted a precondition its title only
  stated — added the missing positive case for agreeing shared-fact
  attestations, de-tautologised the default test so it actually exercises
  `isFieldSensitive`, and moved the value check ahead of the shared-fact
  agreement check so an invalid value no longer reports as a disagreement.
  No behaviour change; no field is classified.

### Added

- **Field confidentiality on canonical field specs (SYS-3164).** New optional
  `confidentiality?: "non-sensitive"` on `CanonicalFieldSpec`, plus
  `isFieldSensitive(category, field)` and `sensitiveFieldsOf(category)`.
  **Absence means sensitive** — there is deliberately no `"sensitive"`
  spelling, so a field is protected unless someone explicitly opted it out
  and the failure mode of forgetting is over-protection rather than silent
  exposure. Shared-fact attestations must agree on it (enforced at load,
  alongside the existing `fact`/`kind` drift rules): one real-world fact
  cannot be sensitive when a document attests it and non-sensitive when a
  form does. No field is classified in this release, so the payload
  `allCategories()` publishes is byte-identical and every field currently
  reads as sensitive — the intended starting point for a fail-closed
  default. Consumers honouring it should note two limits: it covers
  canonical data only (nothing is canonical over the legacy wide `ihs`
  table), and raw payloads store the same values separately.

- **Per-file document-language selector tag (SYS-2873).** New optional catalog
  tag `document_language_options` on file-type entries (`TaggedFieldData`),
  plus `ParsedDocFile.documentLanguage` so the per-file choice parses out of
  IHS doc fields. First carrier: new `financials_vn` catalog entry (Vietnam
  financial statement — single slot, yearly, no wide-table columns) offering
  `["vi", "en"]`. Malaysia entries carry no tag, so no selector renders for
  them. The tag is UX metadata; the server-side endpoint registry remains
  authoritative for which languages are actually callable (SYS-2875).

### Changed

- Dev-infra: `allowScripts` now covers `fsevents` (strict-allow-scripts was
  blocking fresh installs on macOS).

## [4.9.1] — 2026-07-27

Removes named third-party companies from documentation and source comments.
No API, schema or catalog changes.

Three sites named payment-network vendors as examples: the `payment-network`
category description, a manifest-naming example, and the header comment in
`adapter-categories.ts`. All now describe the category instead. Both companies
have since rebranded, so the names were also stale -- and a wrong name is worse
than none.

Worth noting for anyone auditing similar packages: these survived an earlier
name-removal pass because published **source maps embed the original source
text, including comments**. Editing a comment in `src/` does not remove it from
an already-published `.map`. Verify by unpacking the built tarball, not by
grepping the source tree.

## [4.9.0] — 2026-07-26

### Added

- **`external-assertion` adapter implementation type.** A declaration-only
  flavor, alongside `form-intake`/`manual-override`/`extraction-pipeline`,
  for adapters whose data arrives via an external push rather than
  through the host's own extraction pipeline, a form submission, or a
  dynamic-imported/declarative `extract()` call — an externally-
  orchestrated process completes its own ceremony and pushes the result
  to the host's ingest surface. No code is loaded and neither `fetch()`
  nor `extract()` ever runs, the same shape as its declaration-only
  siblings: empty beyond the discriminator, and every other manifest rule
  (`produces` ⊆ category, `enumValues` contract, field-authorization
  gating, periods) still applies unchanged. Previously implemented as a
  per-host schema patch (a runtime-cloned copy of this package's compiled
  schema with one extra branch bolted on); publishing it here means every
  host validates the same schema, with no local patching required.
- **`AdapterExecutionMode` + `executionModeOf()`.** A three-value closed
  enum (`Runnable` / `DeclarationOnly` / `ExternallyAsserted`) and a pure
  classifier that maps any `implementation.type` to its execution mode.
  Published so hosts read this classification directly instead of
  re-deriving their own copy of the same switch statement.

## [4.8.0] — 2026-07-24

### Added

- **The `enum` field kind** in the category registry. A canonical field
  may now declare `kind: "enum"`, marking its value as one label out of
  a closed set — with the values themselves deliberately absent from
  the category. Value sets are vendor territory: each adapter declares
  the exact labels it emits in its manifest's new `enumValues` map
  (host-validated at registration — keys must appear in `produces`,
  enum-kind fields in `produces` must have an entry, and each set must
  be non-empty, unique, string-normalized labels). Ordering and scoring
  interpretation live further out still, in the consumer's per-value
  mapping — an enum label is data; what it is worth is opinion, and
  opinions don't belong in the data contract. Enum fields must be
  `type: "string"` and must not declare a `range`; shared-fact
  attestations must agree on kind (the same drift rule facts already
  follow).
- **Four `telco-carrier` tier fields** — `telcoPaymentReliabilityTier`,
  `telcoTenureTier`, `telcoDistressTier`, `telcoHandsetRiskTier` — the
  first enum-kind fields in the catalogue, for carriers that return
  coarse bucket labels instead of (or alongside) the category's
  continuous signals. Category data `schemaVersion` is now `1.2.0`.

## [4.7.0] — 2026-07-23

### Added

- **Shared-fact attestations** in the category registry. A canonical
  field may now declare an optional `fact` — a global fact identifier
  marking the field as an ATTESTATION of a shared real-world fact (a
  company has exactly one incorporation date, no matter which document
  it was extracted from). The registry's uniqueness rule is refined
  accordingly: a field name may be declared by more than one category
  **iff every declaring category carries the same `fact` id**. A name
  declared with a fact in one place and without (or with a different
  fact) elsewhere is refused at load time, as is one fact id carried by
  two different field names — both are the silent-drift patterns this
  model exists to prevent. Names declared by exactly one category need
  no `fact` (but may carry one). Two new lookups round out the model:
  `factOf(field)` returns the fact a field attests (or null), and
  `categoriesAttestingFact(factId)` enumerates every attesting category
  — the lookup a future cross-source disagreement comparison keys on.
  `categoryForField` now answers **null for shared-fact names**: with
  multiple attesters there is no single owning category, and the
  explicit null forces callers to reason per-attestation instead of
  being handed one arbitrary declarer. Uniquely-declared names resolve
  exactly as before. `CanonicalFieldSpec` gains the optional `fact`
  property; the data-file schema version moves to 1.1.0.

- **`finxtract-form9` category** — fields extracted from an uploaded
  SSM Form 9 (certificate of incorporation) document by the host's
  extraction pipeline. 3 canonical fields (canonical table
  `ihs_alt_data_form9`): `companyRegNo`, plus the first two shared-fact
  attestations — `companyName` (also attested by
  `finxtract-financial-statement`, whose existing declaration now
  carries the matching `fact`; additive metadata, no behavior change
  for existing readers) and `companyIncorporationDate` (also attested
  by `finxtract-ssm`).

- **`finxtract-ssm` category** — fields extracted from an uploaded SSM
  company-profile document by the host's extraction pipeline. 16
  canonical fields (canonical table `ihs_alt_data_ssm`) covering
  registration identity (`ssmCompanyName`, `ssmCompanyRegNo`,
  `ssmCompanyEntityType`), status and origin, key dates
  (`companyIncorporationDate` as a shared-fact attestation,
  `businessCommencementDate`, `companyNameDateOfChange`), nature of
  business, registered address, capital figures (`totalShareIssued`,
  `ssmPaidUpCapital` in MYR), the JSON-encoded officer/shareholder
  registers (`directors`, `shareholders`, `previousDirectors`), and
  name-change history (`companyLastOldName`).

## [4.6.0] — 2026-07-23

### Added

- **`finxtract-financial-statement` category** in the category registry —
  the fifth document-extraction category, deferred from the 4.4.0 batch
  until the period-declaration contract (4.5.0) existed to describe its
  shape. Fields extracted from an uploaded audited financial-statement
  document by the host's extraction pipeline: one document = one audited
  financial statement carrying TWO declared periods per the period-axis
  contract — period1 is its current fiscal year, period2 is its prior
  comparative year. 122 canonical fields (canonical table
  `ihsfinancialstatement`), taken verbatim and unprefixed from the host's
  flat financial-metric vocabulary: header/structural fields with their
  true types (`localNo`, `companyName`, `financialYearEnd`, `currency` as
  strings; `consolidated` boolean; `year` an ordinal number) plus the
  balance-sheet, income-statement, and cash-flow-statement line items as
  MYR-denominated numbers. Bare names are safe here — the registry's
  load-time global-uniqueness guard confirms zero collisions with every
  other category's vocabulary. Purely a data-file addition: no schema
  change, no new exports.

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
