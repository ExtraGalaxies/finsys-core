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
 * SYS-3334 — the v2 canonical envelope, as a shape this package owns.
 *
 * WHY IT MOVED HERE. These types described the wire shape of a published API
 * and lived only in `@finsys/lender-client`, which is the SDK built for
 * EXTERNAL lenders. Every other consumer therefore had two bad options: take a
 * dependency on an SDK meant for someone else, or re-declare the shape. finhub
 * reads finsys-api through its own gateway and would have re-declared it;
 * FHD's portal would have been the third declaration.
 *
 * Two declarations of one wire shape drifting apart, with nothing comparing
 * them, is this estate's signature defect. So the shape lives once, in the
 * package that already owns published vocabulary — the category registry, the
 * field catalogue, the v1 migration map — and `@finsys/lender-client`
 * re-exports it. Member-for-member identical to what the SDK's 2.5.0
 * declared — but 2.5.0 never exported these names from its index (TS2305 on
 * `import type { CanonicalView } from '@finsys/lender-client'`), so the SDK's
 * re-export is the first release in which a consumer can name them. Additive
 * either way; the members and their meaning are unchanged.
 *
 * SEMVER CONTRACT (SYS-3420, from the review of @finsys/lender-client 2.6.0).
 * These five interfaces are re-exported by the lender SDK, so a change here
 * reaches external consumers on THEIR next install, not on an SDK release.
 * Therefore: adding a REQUIRED member, removing or renaming ANY member
 * (optional included — `confidence?`, `origin?`, `runId?` are what a consumer
 * uses to judge a value), or narrowing a member's type is a MAJOR of this
 * package. Adding an OPTIONAL member is a minor. The SDK's own compat suite
 * pins both directions, `keyof` included, against its previous release.
 *
 * WHAT THIS FILE IS NOT. It is a description of a payload, not a client. There
 * is no fetching here and no instance-selection rule — selection is one
 * decision that every consumer must make identically, so it belongs with the
 * code that reads the envelope rather than with the types that describe it.
 */

/** One canonical value, with everything needed to judge it. */
export interface CanonicalFieldEnvelope {
  value: number | boolean | string
  /** Present only when it can be attributed to this instance's run. */
  confidence?: number
  origin?: string
  confidentiality: string
  /**
   * SYS-3415: present ONLY under a lender-overlay projection (`?overlay=mine`)
   * on a field the calling lender has a staged, uncommitted edit for — the
   * attested value this envelope's `value` is standing in for. `origin` is
   * 'manual' on such an envelope and `confidence` is absent. Never present on
   * the facts-only view; a committed correction is a fact (a manual-override
   * run) and carries no originalValue.
   */
  originalValue?: number | boolean | string
  /**
   * SYS-3421 (the SYS-3392 decision, CONFLICT SURFACES): when more than one
   * attestation exists for this field — an extraction and a committed manual
   * correction — `value` is the RESOLVED one and this lists every attestation
   * behind it, the winner included, so the disagreement is visible rather
   * than the loser silently discarded. Absent when there is exactly one.
   * Scoring consumes `value`, never this list.
   */
  attestations?: CanonicalAttestation[]
  /**
   * SYS-3421: the policy that chose `value` when `attestations` is present —
   * `'<policy-id>@<version>'`, e.g. `class-precedence@1`. A policy VERSION
   * bump changes this visibly rather than changing values silently. Absent
   * when nothing needed resolving.
   */
  resolvedBy?: string
}

/**
 * One attestation of a field's value — who said it, when, from which run.
 * The same information an instance carries, at field grain, so a manual
 * correction can stand beside the extraction it corrects.
 */
export interface CanonicalAttestation {
  /**
   * `null` is a real attestation: a lender CLEARED the field (SYS-3421). The
   * envelope's own `value` never carries null — a resolved clear makes the
   * field ABSENT from the instance — but the attestation list must still
   * show that someone said "nothing", or a later, lower-ranked value would
   * appear uncontested. Unlike the envelope, this is the ledger, not the
   * answer.
   */
  value: number | boolean | string | null
  /** 'extraction' | 'form-intake' | 'manual' | … — the assertion class the resolver ranks. */
  origin: string
  adapterId: string
  adapterVersion: number
  runId?: number
  observedAt?: string
  /** Present on a manual attestation: the lender that committed it. */
  lenderId?: number
}

export interface CanonicalInstance {
  /** '' for a single-cardinality category. */
  instanceKey: string
  adapterId: string
  adapterVersion: number
  runId?: number
  /**
   * ISO-8601, UTC (`Z` offset), e.g. `'2026-08-19T00:00:00.000Z'`. Carried
   * verbatim onto a synthesized `IhsFieldProvenance.observedAt` entry
   * (`fieldProvenanceFromView`, `ihs-processing.ts`) — a plain string, never
   * parsed there. SYS-3334 M-5 (round 5) removed the one place this used to
   * be COMPARED as a string (a temporal tie-break for two instances
   * contending on one slot): every key that comparison was ever consulted on
   * has its provenance entry deleted regardless of the result (H2, round 4),
   * so the comparison was computing an answer nobody could read.
   *
   * SYS-3542 REINTRODUCED ordering by this field — `subjectViewFromRecords`
   * (`subject-canonical-view.ts`) sorts a subject's merged instances by it.
   * It does NOT reintroduce the string comparison the paragraph above
   * describes as removed: a raw string comparison silently breaks on two
   * inputs this package cannot police at the type level (mixed UTC offsets —
   * `+08:00`, this estate's own timezone, sorts as "later" than an earlier
   * moment written as `Z`; mixed precision — a no-millis `Z` timestamp
   * outsorts every millisecond-precision one, because `'Z'` > `'.'`
   * byte-for-byte) — so that function parses with `Date.parse` instead and
   * documents its own rule for a value that fails to parse. Read that
   * function's own doc before adding a second ordering consumer of this
   * field; the requirement is "parse it", not "trust the format" — a single
   * drifting producer is exactly what a raw string comparison cannot catch.
   */
  observedAt?: string
  fields: Record<string, CanonicalFieldEnvelope>
  /**
   * The v1 wide-table slot this instance projected to (`'T1'`..`'T6'`, or a
   * financial-statement `'T3'`), carried through the migration window ONLY:
   * present when the source row stored one, absent when it did not (a
   * post-cutover financial-statement coordinate v1 discarded, an alt-data
   * instance that never had a wide column). Consumers reproducing a v1
   * shape read THIS, never a derived position; consumers on v2 ignore it.
   * Retires with the wide table.
   *
   * SHAPE CONTRACT (M4, SYS-3334 round 4): `/^T[1-9]\d*$/` — bare `T`
   * followed by a positive integer, no leading zero, no whitespace, no
   * suffix. finsys-api has not shipped this member as of 2026-08-19, so no
   * producer has violated it yet; every consumer (`timePeriodOf`,
   * `ihs-processing.ts`, the cheapest place to pin it before one does)
   * REJECTS a value outside this shape rather than trimming or coercing it
   * — a rejected value is treated as ABSENT, and is therefore never accepted
   * verbatim into a column header or a provenance key.
   *
   * WHAT "ABSENT" RESOLVES TO depends on whether the instance carries a
   * `periodPosition`, and this doc said otherwise until SYS-3517. It used to
   * promise "falling through to a derived period, so a producer bug is
   * visible as a DIFFERENT period". That is still true for an instance with
   * NO coordinate. On a COORDINATE-bearing instance it is not: absence is an
   * assertion there (see `periodPosition` below), so the period resolves to
   * NULL rather than to something derived. For a position-1 row that
   * genuinely owned T1, a malformed value therefore renders as
   * `timePeriod: null, periodPosition: 1` — the same shape a consumer's
   * coordinate branch selects for, so it would read as a true current-year
   * row rather than as a visible anomaly. No producer emits an out-of-shape
   * value today (probed against every sibling table, 2026-08-22); a producer
   * that starts to should fail loudly at the emitter, because no consumer
   * rule can make a malformed slot safe on a coordinate row.
   */
  legacySlot?: string
  /** A per-instance human label the source row carried (a bank statement's issuing bank). */
  sourceLabel?: string
  /**
   * The 1-based period coordinate of a period-aware document instance
   * (financial statements: 1 = the document's own current fiscal year, 2 =
   * its prior comparative year), when the source row stores one. Distinct
   * from `legacySlot`: a year-2 document's own current-year column has
   * position 1 and NO legacy slot (v1 discarded it) — the coordinate is how
   * a consumer selects "the true current-year row" without the T-slot
   * projection guessing for it. Absent for rows that carry none (bank,
   * payslip, EPF, alt-data). Additive; the migration-window bridge copies
   * it onto `InstanceRow.periodPosition` verbatim.
   *
   * SHAPE CONTRACT: a finite number >= 1. Out of range is treated as absent
   * — never coerced to 1, never rounded. The same test finsys-api's own
   * projector applies on the way out, deliberately character for character:
   * a receiver stricter than its producer discards values that were sent,
   * which here would silently re-enable the fabricated slot below.
   *
   * PRESENCE OF THIS MEMBER CHANGES WHAT AN ABSENT `legacySlot` MEANS, and
   * that is a real obligation on producers, not a consumer detail (SYS-3517
   * rule 1b). On an instance with NO coordinate, an absent `legacySlot` is
   * SILENCE: the consumer derives a period from the key or the ordering, as
   * it always has. On an instance WITH one, it is an ASSERTION — the
   * producer saying "the v1 model had no slot for this row" — and the
   * period resolves to null instead of being derived.
   *
   * So a producer that stamps this member takes on the duty to stamp
   * `legacySlot` on every row that HAS a v1 slot. Omitting one there no
   * longer reads as "unknown, please derive"; it reads as "there is none",
   * and the row goes slotless. The row this protects is a year-2 financial
   * statement's own current fiscal year: stored at position 1 with no slot,
   * under a HISTORICAL key ending `#T1` that a re-extraction adopted. Read
   * the period off that key and the one null the coordinate model exists to
   * preserve becomes a second claimant on T1, which is exactly the overlap
   * projection DEVOPS-535 removed.
   *
   * This is the first member of this interface whose ABSENCE is meaningful,
   * which is why it is stated here rather than left to the consumer's own
   * cascade doc: a producer cannot honor a contract it can only read in a
   * consumer's source.
   */
  periodPosition?: number
}

export interface CanonicalCategory {
  /**
   * From the producing adapter's manifest, and it describes ONE RECORD:
   * `single` means at most one instance per application. It does NOT mean the
   * subject has one value — see the note on CanonicalView.
   */
  cardinality?: 'single' | 'multi'
  instances: CanonicalInstance[]
}

/**
 * THE SCOPE OF THIS RESPONSE IS ONE APPLICATION. Every instance below comes
 * from the record named by `ihsId`, which is why instances carry no
 * per-instance source reference — at this scope it would be a constant.
 *
 * Do not write code that assumes this is interchangeable with a subject-scoped
 * view. That response would carry source attribution per instance and would
 * re-scope or omit `cardinality`; a consumer that read `single` as licence to
 * take instances[0] is correct here and wrong there.
 */
export interface CanonicalView {
  ihsId: number
  categories: Record<string, CanonicalCategory>
  /**
   * SYS-3415: present iff the view was read under a lender-overlay projection
   * (`?overlay=mine`). Its presence is the signal that `value`s in this view
   * may be the calling lender's staged edits rather than attested facts — the
   * signal the SDK's 2.5.0 notes said neither payload carried. `applied` counts
   * fields overlaid; `unprojected` names any staged column that could not be
   * placed on the canonical plane (a legacy column with no address, or a
   * T-slot the sibling storage cannot resolve) — surfaced, never dropped.
   * ABSENT on the facts-only view, and absent for a caller with no active
   * overlay only if the projection was not requested at all.
   */
  overlay?: {
    lenderId: number
    applied: number
    updatedAt: string | null
    unprojected: string[]
  }
}

/**
 * Where a v1 field lives on the canonical plane. Resolve it with a shared
 * resolver, never by hand — instance selection is the part consumers get
 * subtly different from each other, and a wrongly chosen instance is a
 * plausible value rather than an error.
 */
export interface CanonicalAddress {
  category: string
  field: string
  /**
   * Present: resolve to exactly this instance.
   * Absent: latest by observedAt, which is what v1's flat mirror actually did.
   */
  instanceKey?: string
}

/**
 * SYS-3554 — WHO furnished an observation, as the bureau knows it.
 *
 * THE PAIR IS THE IDENTITY. A contributed observation is identified by
 * `(furnisherId, recordRef)` and by nothing else. Neither half identifies
 * anything on its own: a furnisher contributes many records, and a record ref
 * is scoped to the furnisher that issued it, so two furnishers using the same
 * ref have said nothing to each other. This replaces `{ sourceIhsId: number }`,
 * which was one furnisher's auto-increment primary key doing the work of a
 * global identity — the SYS-3554 defect. A bureau aggregating many furnishers
 * is the product, not an edge case, and lender A's application 7 and lender
 * B's application 7 are the same number.
 *
 * BOTH MEMBERS ARE STRINGS, AND THAT IS DELIBERATE RATHER THAN INCIDENTAL.
 * `recordRef` is opaque BY CONTRACT: it is the furnisher's own identifier,
 * meaningful only to the furnisher that minted it, and the bureau's only
 * legitimate operations on it are equality and handing it back on the s.31
 * correction channel. A numeric type would invite exactly the reasoning that
 * produced the defect being fixed here — `b.source.sourceIhsId -
 * a.source.sourceIhsId` was a subtraction of two furnishers' unrelated
 * sequence numbers, and it typechecked. A string cannot be subtracted, so the
 * old tie-break is not merely removed from this package: it no longer
 * COMPILES in any consumer either. The same argument covers `furnisherId`:
 * bureau-minted and stable, but never an ordinal.
 *
 * NEVER JOIN THE TWO INTO A STRING. Both halves are opaque, so no delimiter is
 * safe: `'a' + '#' + 'b#c'` and `'a#b' + '#' + 'c'` are one value, and code
 * that splits a joined key back apart recovers the wrong half without any
 * signal that it did. Consumers key on the PAIR — a `Map<furnisherId,
 * Map<recordRef, …>>`, or `sameSubjectSource` (`subject-canonical-view.ts`)
 * on a linear scan. This is not stylistic: finsys-client's subject seat
 * de-qualifies today by slicing at the first `#`, and its own docblock states
 * the argument that made that safe — "sourceIhsId is numeric, so the FIRST `#`
 * is unambiguously the qualification boundary even when the raw key itself
 * contains one." Once the qualifier is an opaque string that argument
 * collapses, which is why the qualification scheme is gone rather than
 * re-delimited (see `SubjectInstance.instanceKey` below).
 *
 * IT NEVER APPEARS IN REPORT CONTENT. s.25(1)(a) wants the source's NAME AND
 * ADDRESS, which live on the bureau's furnisher registry keyed by
 * `furnisherId`; `recordRef` flows back to the furnisher that issued it on the
 * s.31 correction path and nowhere else. An identifier is only ever presented
 * to the party that minted it — the same rule that removed `ihsId` from the
 * subscriber wire.
 */
export interface SubjectSource {
  /**
   * BUREAU-MINTED and stable — the bureau's own furnisher-registry id, which
   * is local to the bureau and shares a keyspace with nothing outside it.
   *
   * IT IS STAMPED FROM THE CREDENTIALED CHANNEL, NEVER FROM PAYLOAD CONTENT.
   * Every pull is bureau-initiated against one furnisher's endpoint with that
   * furnisher's credential, so the bureau already knows who it is pulling from
   * at the moment of authentication. No furnisher self-declares its identity
   * here and no payload can spoof it — which is why `subjectViewFromRecords`
   * takes this on `SubjectViewRecord` rather than reading it off the
   * `CanonicalView` it is given.
   */
  furnisherId: string
  /**
   * The furnisher's own identifier for the record this instance came from —
   * OPAQUE, furnisher-scoped, and never parsed, ordered or arithmetically
   * compared. At a finsys-api furnisher it happens to be an application id;
   * that is a fact about one furnisher's implementation and not a contract,
   * and every consumer that reasons from it is reintroducing SYS-3554.
   */
  recordRef: string
}

/**
 * SYS-3542 (SYS-3463a) — the subject-scoped view `CanonicalView`'s own doc
 * anticipates and declines to be: "Do not write code that assumes this is
 * interchangeable with a subject-scoped view. That response would carry
 * source attribution per instance and would re-scope or omit `cardinality`."
 * This is that response.
 *
 * A `CanonicalInstance` widened with the source that furnished it. Subject
 * scope means MULTIPLE records, from MULTIPLE furnishers, can each contribute
 * an instance to one category, so source attribution — a constant at
 * `CanonicalView`'s single-application scope, and therefore absent there —
 * becomes per-instance information here.
 *
 * `instanceKey` IS THE RAW, UNQUALIFIED KEY (SYS-3554), exactly as
 * `CanonicalInstance` documents it — `''` for a single-cardinality category
 * included. UNIQUENESS IS THE TUPLE `(source.furnisherId, source.recordRef,
 * instanceKey)`, and a consumer that keys on `instanceKey` alone is wrong at
 * this scope: two records will legitimately both key an instance `''`.
 *
 * This REVERSES SYS-3542, which rewrote every key to
 * `${sourceIhsId}#${rawInstanceKey}` so that a lookup over the category's
 * instances could stay one-dimensional. That scheme depended on the qualifier
 * being numeric to be reversible, and on one furnisher's id space being
 * global to be unique — neither survives a second furnisher. Re-delimiting it
 * was considered and rejected: both halves of `(furnisherId, recordRef)` are
 * opaque strings, so there is no character guaranteed absent from both, and a
 * scheme whose correctness rests on "this delimiter probably will not appear"
 * fails SILENTLY, which is the same failure class as the collision it would be
 * fixing. The source is therefore carried STRUCTURALLY, in `source` below, and
 * nobody parses anything.
 *
 * TWO `CanonicalInstance` MEMBERS ARE OMITTED (SYS-3542 review, F12), for the
 * same reason `SubjectCanonicalCategory` omits `cardinality` — republishing
 * them here would tell a consumer the opposite of what is true, because each
 * describes exactly one application's structure and stops meaning anything
 * once merged across several:
 *   - `legacySlot` — the v1 wide-table slot THIS INSTANCE projected to.
 *     Three applications can each legitimately own `T1`; carried through
 *     unchanged that reads as the "two instances contending for one slot"
 *     defect shape `ihs-processing.ts` documents as a real collision.
 *   - `periodPosition` — orders periods WITHIN one application's own v1
 *     reconstruction; across applications it orders nothing.
 * `source` (below) is how a consumer that genuinely needs either value gets it
 * back: ask that furnisher for that record's own `CanonicalView`, which is
 * where the field means something.
 */
export interface SubjectInstance extends Omit<CanonicalInstance, 'legacySlot' | 'periodPosition'> {
  source: SubjectSource
}

/**
 * `CanonicalCategory` re-scoped to a subject: `cardinality` is OMITTED, not
 * carried through unchanged — `CanonicalView`'s own doc names this exact
 * requirement. `cardinality` described one adapter's per-APPLICATION
 * contract ('single' = at most one instance per application). At subject
 * scope a subject with three applications legitimately carries three
 * instances of a 'single'-cardinality category, one per source — republishing
 * the flag here would tell a consumer the opposite of what is true, which is
 * worse than omitting it: `'single'` used to license reading `instances[0]`
 * as THE value, full stop. That license does not survive the re-scoping —
 * `instances` can legitimately hold more than one CURRENT instance (a
 * subject with a live application in two lenders' pipelines, several bank
 * accounts each with their own statement) — but `instances[0]` is not
 * meaningless; see its own doc below for what it IS.
 */
export interface SubjectCanonicalCategory {
  /**
   * Sorted LATEST-FIRST by `observedAt`, across every source record,
   * regardless of the order records were merged in — see
   * `subjectViewFromRecords`'s own doc (`subject-canonical-view.ts`) for the
   * parsing rule and for what happens when `observedAt` cannot separate two
   * instances.
   *
   * `instances[0]` is the single instance `CanonicalAddress`'s existing
   * "latest wins" rule would pick for an unaddressed field — BUT ONLY WHEN
   * `contestedLead` IS ABSENT. When it is present, `[0]`'s position ahead of
   * the other tied instances is arbitrary, and reading it as "the latest" is
   * the SYS-3554 misordering under a new name. Check `contestedLead` before
   * treating `[0]` as an answer.
   *
   * It is never license to ignore `instances[1..]` either — see this
   * interface's own doc above for why `'single'`'s old licence to do that does
   * not survive the re-scoping.
   */
  instances: SubjectInstance[]
  /**
   * SYS-3554 — present IFF the instances tied at the top of `instances` come
   * from MORE THAN ONE source, i.e. `observedAt` (the only evidential ordering
   * key this package has) ranks them equal and the merge has no honest way to
   * say which is later. Lists the distinct sources involved, in the order they
   * appear in `instances`. Absent — the normal case — means `instances[0]` won
   * on evidence.
   *
   * WHY THIS EXISTS RATHER THAN A TIE-BREAK THAT PICKS ONE. Until SYS-3554
   * the merge broke such a tie on `sourceIhsId` descending, a recency proxy
   * whose own docblock stated the assumption that killed it: applications are
   * "id-ordered by creation in every producer this package has observed" —
   * singular producer. Across furnishers that proxy systematically prefers
   * whoever has higher sequence numbers, silently, with no signal to any
   * consumer that an ordering had been invented. There is no replacement
   * proxy available: the only per-record axis a furnisher could have ordered
   * by is `recordRef`, which this package makes opaque precisely so nobody
   * reasons from it. So the merge stops inventing an answer and reports the
   * question instead, per SYS-3464's principle — two records that can
   * disagree about a disputed value are worse than one incomplete record, and
   * the disagreement is itself the finding.
   *
   * A CONSUMER'S OBLIGATION IS TO SURFACE IT, NOT TO RESOLVE IT. Rendering a
   * contested lead as a single uncontested value is what s.29 RACUN's "not
   * misleading" forbids; the per-field resolution that would legitimately
   * settle it (with per-field provenance) is SYS-3464's, not this merge's.
   */
  contestedLead?: {
    sources: SubjectSource[]
  }
}

/**
 * THE SCOPE OF THIS RESPONSE IS ONE SUBJECT — every application the subject
 * registry (IC / SSM regno) has attached to them, merged. Where
 * `CanonicalView` is deliberately silent about which application produced an
 * instance (a per-response constant at that scope), this type is deliberately
 * silent about `cardinality` (see `SubjectCanonicalCategory`) and explicit
 * about source (see `SubjectInstance`) — the two swap places, which is the
 * whole reason the two types cannot be interchangeable and must not drift
 * apart from each other unnoticed. `subjectViewFromRecords` in
 * `subject-canonical-view.ts` is the one function that builds this shape;
 * read that file for the merge and ordering rules, which are a runtime
 * decision this file deliberately does not make (see "WHAT THIS FILE IS NOT"
 * on `CanonicalView`, above).
 */
export interface SubjectCanonicalView {
  subjectKind: string
  categories: Record<string, SubjectCanonicalCategory>
}
