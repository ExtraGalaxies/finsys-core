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
 * SYS-3542 (SYS-3463a) — the merge that builds a `SubjectCanonicalView` out
 * of several applications' `CanonicalView`s.
 *
 * WHY THIS IS A SEPARATE FILE FROM `canonical-view.ts`. That file's own doc
 * says what it is not: "a description of a payload, not a client... there is
 * no fetching here and no instance-selection rule — selection is one
 * decision that every consumer must make identically, so it belongs with the
 * code that reads the envelope rather than with the types that describe it."
 * This function IS an instance-selection rule (an ordering one), so it lives
 * here, alongside the types rather than inside them — one file declares the
 * subject-scoped shape, this one is the single place that builds it, and the
 * two cannot drift apart from each other the way a type re-declared in two
 * consumers would.
 *
 * THE ORDERING RULE, established once so every consumer sees the same
 * answer: within each merged category, instances are sorted LATEST-FIRST,
 * across every source record, regardless of the order records were passed
 * in. `CanonicalAddress`'s own doc already commits this package to "latest
 * by observedAt" as the resolution rule for an unaddressed field; this is
 * that rule applied at subject scope, where the same field can now be
 * attested by more than one APPLICATION rather than by more than one
 * instance within one application.
 *
 * A merge that instead preserved record-arrival order would produce a result
 * indistinguishable from a correct one on any single test that only checks
 * one feed order — every field present, every type correct, the wrong
 * instance sorted first. `subject-canonical-view.test.ts` proves the primary
 * key is `observedAt` (not array position) by feeding the same two records
 * in both orders and asserting the same instance sorts first either way, and
 * separately proves the secondary key is `sourceIhsId` (not array position
 * either) the same way.
 *
 * PARSING, NOT COMPARING THE RAW STRING (this is the SYS-3542 review's F1).
 * `CanonicalInstance.observedAt`'s own doc documents two ways a raw string
 * comparison silently misorders real inputs: a mixed UTC offset (`+08:00` —
 * this estate's own timezone — sorts as "later" than an earlier moment
 * written as `Z`) and mixed precision (a no-millis `Z` timestamp outsorts
 * every millisecond-precision one, because `'Z'` (0x5A) > `'.'` (0x2E)
 * byte-for-byte). Both are realistic here — this merge is the first place in
 * the package that compares `observedAt` values written by DIFFERENT
 * adapters across DIFFERENT applications, so the single-writer assumption a
 * same-format comparison depends on does not hold. `timeRank` below parses
 * with `Date.parse` instead: two timestamps naming the same instant sort
 * equal regardless of offset or precision, which is the guarantee a
 * "latest wins" rule actually needs.
 *
 * A VALUE THAT FAILS TO PARSE (`Date.parse` returns `NaN`) is treated
 * EXACTLY like an absent `observedAt` — ranked oldest, never thrown. This
 * matches the one house precedent for a malformed-but-typed value on this
 * same interface: `CanonicalInstance.legacySlot`'s own doc says a value
 * outside its shape contract "is treated as ABSENT... rather than trimming
 * or coercing it", specifically so a receiver stricter than its producer
 * does not silently re-enable a hazard the shape contract exists to close.
 * The alternative — throwing on a malformed timestamp — would let one
 * adapter's bad string take the whole subject merge down; per that same
 * precedent, that is the producer's failure to raise loudly at the point it
 * happened, not a reason for every consumer to gain a novel throw path.
 *
 * TIE-BREAK: `sourceIhsId` DESCENDING, as a recency proxy, when `observedAt`
 * ranks equal (a real tie, or absent/unparseable on both sides) — this is
 * the SYS-3542 review's F5, and it replaces an earlier "keep the
 * earlier-listed record" rule this function shipped with initially. That
 * earlier rule was ordering by ARRIVAL, which is exactly the defect this
 * file's own doc warns a test can fail to catch: on a category where NO
 * instance carries `observedAt` (routine for some alt-data adapters, which
 * this package documents `observedAt` as optional to allow for), the result
 * was purely the caller's array order, silently, no signal that anything had
 * gone unresolved. Ranking by `sourceIhsId` instead makes the merge ACTUALLY
 * order-independent rather than merely claiming to be — the same instance
 * sorts first regardless of which record a caller happened to list first —
 * and higher-`sourceIhsId`-wins is a defensible proxy for "which application
 * is newer" absent any better signal, since applications are id-ordered by
 * creation in every producer this package has observed. It is a proxy, not a
 * guarantee — an id sequence can be renumbered or imported out of order —
 * but it strictly dominates array position, which carries no temporal
 * meaning at all. On a genuine remaining tie (two instances belonging to the
 * SAME source application, both ranking equal on `observedAt`), the merge
 * falls back to their relative order within that application's own
 * `instances` array, because `Array.prototype.sort` has been a stable sort
 * since ES2019 (V8 7.0+, every runtime this package targets) and this
 * function never reorders a record's own instance list before sorting.
 *
 * ALIASING (SYS-3542 review's F7): a merged `SubjectInstance`'s `fields` is
 * a FRESH object (`{ ...instance.fields }`), not the source instance's own —
 * so replacing a field on a merged instance (`fields.someKey = redacted`,
 * this codebase's own idiom throughout, e.g. `ihs-processing.ts`'s
 * provenance building) never touches the `CanonicalView` the record came
 * from. What is NOT cloned is each field's `CanonicalFieldEnvelope` object
 * itself: `fields.someKey` after the merge is the SAME envelope reference
 * the source instance held. A caller that mutates an envelope IN PLACE
 * (`envelope.value = x`) still aliases the source — but no code in this
 * package does that; every existing consumer (`flatRecordFromView`,
 * `fieldProvenanceFromView`) builds a new value rather than assigning into
 * an envelope, and this merge is deliberately consistent with that idiom
 * rather than deep-cloning a wire payload nobody here mutates in place.
 *
 * PER-APPLICATION MEMBERS ARE STRIPPED, NOT JUST UN-TYPED (SYS-3542 review's
 * F12): `SubjectInstance` (`canonical-view.ts`) types `legacySlot` and
 * `periodPosition` out via `Omit`, for the same reason `SubjectCanonicalCategory`
 * omits `cardinality` — both describe exactly one application's v1
 * reconstruction and stop meaning anything merged across several. A type
 * that omits a member while the runtime object still carries it would be
 * worse than carrying it typed: the value would leak through every `as`,
 * every JSON round-trip, and every consumer that doesn't fully trust the
 * type — so this merge deletes both keys from each instance it builds, not
 * only from the type that describes the result.
 *
 * THE ERROR TYPE (SYS-3542 review's F11). Every throw below raises
 * `SubjectViewError`, not a bare `Error` — matching the one precedent this
 * package already ships for a typed, caller-branchable failure
 * (`AdapterError`, `adapter.ts`: a `readonly` discriminator set in the
 * constructor alongside the message). SYS-3545 (SYS-3463d) needs to turn
 * "zero released records for this digest" into a denial with a specific
 * reason rather than a 500; if the only way to tell that apart from, say,
 * "the caller passed contradictory subjectKinds" is regexing an English
 * sentence, the first rewording of that sentence breaks a bureau's
 * disclosure path silently, because a failed regex just falls through to
 * the generic handler. `code` is the contract; the message stays exactly as
 * worded (still asserted by this file's own tests) but is not one.
 *
 * BRANCH ON `error.code`, NOT `error instanceof SubjectViewError` alone — a
 * bundler that ends up with two copies of this package's module graph
 * produces two different `SubjectViewError` constructors, and `instanceof`
 * silently fails across that boundary while `.code` does not, because it is
 * a plain string comparison rather than a prototype-chain check.
 */
import type {
  CanonicalView,
  SubjectCanonicalCategory,
  SubjectCanonicalView,
  SubjectInstance,
} from './canonical-view.js'

/**
 * Discriminator for every way `subjectViewFromRecords` can refuse its input.
 * A `subjectViewFromRecords` caller — or a caller further downstream, like
 * the SYS-3545 denial path this was added for — branches on this, never on
 * the message text. See this file's own "THE ERROR TYPE" doc for why.
 *
 *   no-records                  — `records` was empty; there is no subject
 *                                  to describe.
 *   subject-kind-disagreement   — two records named different `subjectKind`s
 *                                  for what is asserted to be one subject.
 *   duplicate-source-ihs-id     — the same `ihsId` appeared in more than one
 *                                  record.
 *   overlay-projection-present  — a record's `CanonicalView` carried
 *                                  `overlay`; this function's input contract
 *                                  is facts-only views.
 */
export type SubjectViewErrorCode =
  | 'no-records'
  | 'subject-kind-disagreement'
  | 'duplicate-source-ihs-id'
  | 'overlay-projection-present'

/**
 * Typed error thrown by `subjectViewFromRecords` on every input it refuses.
 * The `code` discriminator lets a caller classify the failure (a genuinely
 * empty subject vs a caller bug upstream) without parsing the message —
 * see this file's own "THE ERROR TYPE" doc. Structure matches this
 * package's one existing precedent for a typed, caller-branchable error,
 * `AdapterError` (`adapter.ts`); the field is named `code` rather than
 * `AdapterError`'s `reason` because that is the name this error's own
 * reviewer specified, and because it is the more standard idiom for a
 * machine-checked discriminant (Node's own built-in errors use `.code`).
 */
export class SubjectViewError extends Error {
  public readonly code: SubjectViewErrorCode

  constructor(code: SubjectViewErrorCode, message: string) {
    super(message)
    this.name = 'SubjectViewError'
    this.code = code
  }
}

/**
 * One application's canonical view, tagged with the one subject-level fact
 * `CanonicalView` does not carry on its own (it describes one application,
 * not the subject behind it). `subjectViewFromRecords` reads `view.ihsId` as
 * the source identifier — there is no separate `sourceIhsId` field here,
 * because `CanonicalView` already carries it and a second field would be a
 * second place for the two to disagree.
 *
 * CALLER CONTRACT: `subjectKind` must be stamped from the SUBJECT's current
 * registry row, not from whatever the individual application recorded at
 * intake time (a per-application snapshot can be stale — an entity type
 * corrected after submission, for instance). `subjectViewFromRecords` can
 * only detect a MISMATCH across the records it is given; it has no way to
 * tell "every record agrees, and they are all stale" from "every record
 * agrees, and they are current" — that guarantee has to hold before this
 * function is ever called.
 */
export interface SubjectViewRecord {
  subjectKind: string
  view: CanonicalView
}

/**
 * `Date.parse` for a value with no parse; `NaN` and an absent `observedAt`
 * rank identically — see this file's own doc for why. A more negative
 * number ranks OLDER; `sortSubjectInstances` sorts descending by this value.
 */
function timeRank(observedAt: string | undefined): number {
  if (observedAt === undefined) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(observedAt)
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/**
 * Latest-`observedAt`-first, `sourceIhsId`-descending on a tie, stable
 * beyond that — see this file's own doc for the full justification of each
 * key. Mutates and returns `instances` in place; callers pass a list this
 * function already owns (built fresh in `subjectViewFromRecords`, never the
 * caller's own array).
 */
function sortSubjectInstances(instances: SubjectInstance[]): SubjectInstance[] {
  return instances.sort((a, b) => {
    const aRank = timeRank(a.observedAt)
    const bRank = timeRank(b.observedAt)
    if (aRank !== bRank) return bRank - aRank
    return b.source.sourceIhsId - a.source.sourceIhsId
  })
}

/**
 * Merge one subject's applications into the one subject-scoped view. See
 * this file's own doc for the ordering rule, the parsing rule, the
 * tie-break, and the aliasing contract.
 *
 * `subjectKind` DISAGREEMENT ACROSS RECORDS: every record here is asserted
 * by its caller to describe the SAME subject, so a differing `subjectKind`
 * is not a value to reconcile — a subject's kind does not change between
 * applications, so a mismatch means the caller mismatched something upstream
 * (joined the wrong applications to a subject, or the subject registry
 * itself is wrong). Silently picking one, or worse, invisibly overriding one
 * value with another, would hide exactly that bug — the same reasoning
 * `applyAggregation` already applies to a numeric operator fed a non-numeric
 * value in `adapter-aggregation.ts` ("the operator was misused ... and
 * silent coercion would mask the bug"). So this throws, naming every ihsId
 * and kind involved, rather than guessing.
 *
 * DUPLICATE `sourceIhsId` ACROSS RECORDS (SYS-3542 review's F3): also
 * throws, naming the repeated id. The per-source instance-key qualification
 * this function exists to provide (see `SubjectInstance`'s own doc,
 * `canonical-view.ts`) assumes `sourceIhsId` is unique per record — two
 * records for the SAME application would qualify their instances to the
 * SAME key, reproducing under a different name the exact collision the
 * qualification was built to prevent. A caller passing one application
 * twice is a bug this function CAN see, so it does not silently let the
 * second copy masquerade as a second application's data.
 *
 * OVERLAY PROJECTIONS ARE REJECTED (SYS-3542 review's F2, the most serious
 * finding on the first pass). `CanonicalView.overlay`'s presence is the
 * signal that this view's field `value`s "may be the calling lender's
 * staged edits rather than attested facts" (see that member's own doc). A
 * merge that silently dropped `overlay` while passing the staged `value`s
 * through would launder an uncommitted, lender-scoped edit into subject
 * data with the one marker that could have flagged it removed — in a
 * report-assembly path, in a bureau tenant. This function's contract is
 * facts-only inputs; a record carrying `overlay` is a caller passing the
 * wrong projection, and it throws rather than silently disclosing a staged
 * edit as fact.
 *
 * EMPTY `records`: also throws. There is no subject to describe and no
 * `subjectKind` to report — a caller reaching this function needs at least
 * one application to have already resolved which subject it is asking about.
 */
export function subjectViewFromRecords(records: readonly SubjectViewRecord[]): SubjectCanonicalView {
  if (records.length === 0) {
    throw new SubjectViewError(
      'no-records',
      'subjectViewFromRecords: at least one record is required — there is no subjectKind to report for zero applications.',
    )
  }

  const subjectKind = records[0]!.subjectKind
  const seenIhsIds = new Set<number>()
  for (const record of records) {
    if (record.subjectKind !== subjectKind) {
      throw new SubjectViewError(
        'subject-kind-disagreement',
        `subjectViewFromRecords: subjectKind disagreement across records for one subject — ` +
          `ihsId ${records[0]!.view.ihsId} says '${subjectKind}', ihsId ${record.view.ihsId} says ` +
          `'${record.subjectKind}'. Records for one subject must agree; this looks like records for ` +
          `two different subjects were merged, and guessing a winner would hide that.`,
      )
    }
    if (record.view.overlay !== undefined) {
      throw new SubjectViewError(
        'overlay-projection-present',
        `subjectViewFromRecords: ihsId ${record.view.ihsId} carries a lender-overlay projection ` +
          `(CanonicalView.overlay is present). This function's input contract is facts-only views; an ` +
          `overlay-projected view's field values may be a lender's staged, uncommitted edits rather than ` +
          `attested facts, and merging it in would disclose those edits as subject data with the one ` +
          `marker that could have flagged them removed. Read the caller's facts-only view for this ` +
          `application instead of its ?overlay=mine projection.`,
      )
    }
    if (seenIhsIds.has(record.view.ihsId)) {
      throw new SubjectViewError(
        'duplicate-source-ihs-id',
        `subjectViewFromRecords: ihsId ${record.view.ihsId} appears more than once in records. Every ` +
          `record must be a distinct application — the per-source instance-key qualification this ` +
          `function provides assumes sourceIhsId is unique, and a repeated id would qualify two ` +
          `unrelated instance sets to the same key, reproducing the collision the qualification exists ` +
          `to prevent.`,
      )
    }
    seenIhsIds.add(record.view.ihsId)
  }

  // Object.create(null): categoryId comes off a Record read from the wire,
  // and a plain `{}` accumulator lets a category literally named
  // "__proto__" read back Object.prototype instead of undefined, so
  // `??=` silently never assigns it (SYS-3542 review's F10). A null-
  // prototype object has no such accessor to intercept the assignment.
  const categories: Record<string, SubjectCanonicalCategory> = Object.create(null)

  for (const record of records) {
    const sourceIhsId = record.view.ihsId
    for (const [categoryId, category] of Object.entries(record.view.categories)) {
      const bucket = (categories[categoryId] ??= { instances: [] })
      for (const instance of category.instances) {
        // F12: legacySlot/periodPosition are deleted from the object, not
        // only from the type — see this file's own "PER-APPLICATION MEMBERS
        // ARE STRIPPED" doc for why a type-only omission would be worse than
        // carrying them typed.
        const { legacySlot: _legacySlot, periodPosition: _periodPosition, ...rest } = instance
        const subjectInstance: SubjectInstance = {
          ...rest,
          // F7/F10-style qualification (see this file's own doc and
          // `SubjectInstance`'s doc on `canonical-view.ts`): the RAW key is
          // per-application and routinely '', so it is qualified by source
          // before it can ever collide with another application's instance.
          instanceKey: `${sourceIhsId}#${instance.instanceKey}`,
          // A fresh object, not the source instance's own — see this file's
          // own "ALIASING" section for exactly what this does and does not
          // protect against.
          fields: { ...instance.fields },
          source: { sourceIhsId },
        }
        bucket.instances.push(subjectInstance)
      }
    }
  }

  for (const bucket of Object.values(categories)) {
    sortSubjectInstances(bucket.instances)
  }

  return { subjectKind, categories }
}
