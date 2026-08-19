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
   * so the comparison was computing an answer nobody could read. If a future
   * consumer reintroduces ordering by this field, the same requirement
   * applies: every writer must use this SAME format, because two
   * same-format, same-offset timestamps order lexicographically exactly as
   * they order in time, and a writer emitting a different offset or
   * precision would silently break that ordering without either side
   * raising an error.
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
   * — a rejected value is treated as absent, falling through to a derived
   * period, so a producer bug is visible as a DIFFERENT period rather than
   * accepted verbatim into a column header or a provenance key.
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
