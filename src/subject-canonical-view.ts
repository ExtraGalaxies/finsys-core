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
 * of several furnished records' `CanonicalView`s.
 *
 * SYS-3554 GAVE THIS FUNCTION A FURNISHER AXIS, and it is the reason most of
 * the paragraphs below were rewritten rather than extended. A bureau
 * aggregates from MANY furnishers, each running their own finsys-api
 * instance; this function was built when there was one, and it used that one
 * instance's auto-increment primary key (`ihsId`) as a global identity, as an
 * instance-key qualifier, and as a recency proxy. All three break on the
 * second furnisher, and two of the three break SILENTLY: lender A's
 * application 7 and lender B's application 7 are the same number, so their
 * documents merged under one qualified key (one lender's financial statement
 * landing in another's place inside a credit report) and the recency proxy
 * ranked by whoever had the higher sequence numbers. Identity here is now the
 * pair `(furnisherId, recordRef)`, carried STRUCTURALLY on every instance and
 * never encoded into a string — see `SubjectSource` (`canonical-view.ts`) for
 * why no delimiter would have been safe.
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
 * separately proves the secondary key is the SOURCE pair (not array position
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
 * WHAT HAPPENS WHEN `observedAt` CANNOT SEPARATE TWO INSTANCES (SYS-3554,
 * replacing the SYS-3542 review's F5 tie-break). This function has shipped
 * three answers and the first two were both wrong in the same direction —
 * they invented an ordering and told nobody.
 *
 * The FIRST was "keep the earlier-listed record", which is ordering by
 * ARRIVAL: on a category where NO instance carries `observedAt` (routine for
 * some alt-data adapters, which this package documents `observedAt` as
 * optional to allow for) the result was purely the caller's array order.
 *
 * The SECOND was `sourceIhsId` DESCENDING as a recency proxy, and its own
 * docblock stated the assumption that killed it: higher-id-wins is defensible
 * "since applications are id-ordered by creation in every producer this
 * package has observed" — SINGULAR producer. `sourceIhsId` was one
 * finsys-api instance's auto-increment primary key. A bureau aggregates from
 * MANY furnishers, each with their own sequence, so across furnishers the
 * proxy is not weak, it is meaningless: it systematically prefers whoever has
 * the higher sequence numbers. Lender B's application 500 is not newer than
 * lender A's 12000.
 *
 * THE THIRD, AND THE CURRENT ONE: the merge stops inventing an ordering it
 * cannot justify, and reports the question instead. Two decisions, and they
 * are separate:
 *
 *   1. ORDER: `compareSources` below, an ASCENDING lexicographic comparison
 *      of `furnisherId` then `recordRef`, compared FIELD BY FIELD. Its only
 *      job is to be a deterministic TOTAL order so that the merge stays
 *      genuinely order-independent — the same instance sorts first regardless
 *      of which record a caller listed first — and it carries NO temporal
 *      meaning whatsoever. That is a downgrade from F5's claim and a
 *      deliberate one: F5's key also carried no temporal meaning across
 *      furnishers, it merely looked as though it did. There is no honest
 *      replacement proxy to reach for, because the one per-record axis a
 *      furnisher could have ordered by is `recordRef`, which `SubjectSource`
 *      makes OPAQUE by contract precisely so that nobody reasons from it.
 *
 *   2. DISCLOSURE: `contestedLead` on the merged category
 *      (`canonical-view.ts`), present iff the instances tied at rank 0 span
 *      more than one source. That is the part that matters — an arbitrary
 *      order is only dangerous when a consumer cannot tell it is arbitrary,
 *      and `SubjectCanonicalCategory.instances[0]` is documented as the
 *      instance `CanonicalAddress`'s "latest wins" rule would pick. Per
 *      SYS-3464's principle, two records that can disagree about a disputed
 *      value are worse than one incomplete record, and the disagreement is
 *      itself the finding. The per-field resolution that would legitimately
 *      settle a contested lead is SYS-3464's job, not this merge's.
 *
 * WITHIN ONE SOURCE nothing changed and nothing needed to: `compareSources`
 * returns 0 for two instances of the same record, so they keep their relative
 * order within that record's own `instances` array — which IS meaningful,
 * being one producer's own ordering of its own instances — because
 * `Array.prototype.sort` has been a stable sort since ES2019 (V8 7.0+, every
 * runtime this package targets) and this function never reorders a record's
 * own instance list before sorting. A same-source tie is likewise NOT
 * `contestedLead`: one furnisher listing its own instances in its own order
 * is not a disagreement between sources.
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
 * `source` IS THE THIRD CASE, and it behaves like the envelope rather than
 * like `fields` (SYS-3554): every instance a record contributes shares ONE
 * `SubjectSource` object, and it is the caller's own — the object passed
 * in on `SubjectViewRecord.source`, not a copy. Same idiom, same caveat:
 * mutating it in place reaches every merged instance AND the caller's input,
 * and nothing in this package does that. Sharing is deliberate rather than
 * incidental — re-deriving a source per instance would be the only place
 * a record's furnisher axis could drift WITHIN one record — and it is
 * safe to depend on by VALUE but not by IDENTITY: `sameSubjectSource` compares
 * the two members, so a consumer that builds its own `SubjectSource` to
 * compare against never behaves differently from one holding a reference to
 * this one. The same object is what `contestedLead.sources` lists.
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
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * PER-FIELD RECENCY (SYS-3464), AND WHY IT IS BUREAU-SIDE ONLY. The sort
 * above orders ROWS. A consumer that then spreads `instances[0].fields` flat
 * has performed latest-ROW-wins, and at subject scope that ERASES: a fresher
 * PARTIAL row from one source blanks every field of that category another
 * source supplied, and nothing errors. `ihs_field_attestation`'s own docblock
 * states the same consequence at application scope — an attestation written
 * as an ordinary canonical row with a fresh `observedAt` "would become latest
 * and blank every OTHER field of that category". s.29 RACUN requires
 * Complete and Not misleading; a subject file that silently drops a field
 * nobody retracted fails both. `fieldsByInstanceKey` is the fix:
 * `buildFieldSelections` below resolves each field independently, so a field
 * survives on the newest instance that actually carried it.
 *
 * THE ROW-LATEST CONTRACT IS UNCHANGED FOR APPLICATION SCOPE, deliberately.
 * `CanonicalView` describes ONE application, where one document produces one
 * coherent row and the newest document supersedes the older wholesale — that
 * is correct, every v1 consumer holds it through Phases 4 and 5, and nothing
 * in this ticket touches it. The bureau CONVERTS the row shape at the
 * boundary; it does not inherit it as its read semantics. Per-field selection
 * therefore exists ONLY on the subject-scoped shape this file builds, and
 * `flatRecordFromView` / `fieldProvenanceFromView` (`ihs-processing.ts`,
 * application scope) are untouched by it.
 *
 * FILTER ORDERING — A CALLER CONTRACT THIS FUNCTION CANNOT ENFORCE, stated
 * here so that getting it wrong requires contradicting a written rule.
 *
 *   Every row-level filter must run BEFORE `subjectViewFromRecords`, never
 *   after it. Concretely: the SYS-3448 quarantine gate (is this contributed
 *   row released, or is it quarantined / superseded / retired?) and the
 *   SYS-3462 disclosure class (may THIS subscriber, for THIS purpose, see
 *   this row?) both decide row by row, and `records` must already contain
 *   only the rows that survived both.
 *
 * WHY THE ORDER IS THE WHOLE OF IT. Filtering AFTER the pick lets a newer
 * restricted or quarantined row shadow a readable older one: the newer row
 * wins the field here, the filter then removes it downstream, and the older
 * row's value — which the subscriber was entitled to see — does not come
 * back, because the selection that would have chosen it has already been
 * computed and thrown away. The field is silently ABSENT. For quarantine
 * that is statutorily wrong (data the licensee holds and may disclose is
 * missing from the file); for disclosure it fails CLOSED, which sounds safe
 * and is not, because a missing field and a withheld field are indistinguish-
 * able to the reader. Nothing errors in either case.
 *
 * SYS-3464 makes the invariant STRICTER, not merely inherited: it now binds
 * per FIELD. Under row-latest a late filter dropped one row's worth of
 * fields; under per-field selection a single removed row can change the
 * winner of any subset of the fields in its category, so a post-hoc filter
 * cannot be repaired by re-reading the remaining instances — the whole
 * selection has to be recomputed from the filtered record set, which means
 * calling this function again with the correct input.
 *
 * THIS FUNCTION CANNOT CHECK ANY OF IT, and says so rather than implying a
 * guard it does not have. Quarantine state and disclosure class live in
 * finsys-api's own store; neither is on `CanonicalView`, neither is on
 * `SubjectViewRecord`, and this package has no reader for either. A record
 * that should have been filtered is indistinguishable here from one that was
 * correctly released. The enforcement point is the bureau's assembly path in
 * finsys-api (the portal's BFF and sole enforcement point); this is the
 * contract that path owes, written next to the code that depends on it.
 */
import type {
  CanonicalFieldEnvelope,
  CanonicalView,
  SubjectCanonicalCategory,
  SubjectCanonicalView,
  SubjectFieldSelection,
  SubjectInstance,
  SubjectSource,
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
 *   missing-source-identity     — a record's `source` did not carry a
 *                                  non-empty `furnisherId` AND `recordRef`
 *                                  (SYS-3554).
 *   duplicate-source-record     — the same `(furnisherId, recordRef)` PAIR
 *                                  appeared in more than one record
 *                                  (SYS-3554; renamed from
 *                                  `duplicate-source-ihs-id`, which named a
 *                                  key that no longer exists — and whose
 *                                  meaning was the defect: two DIFFERENT
 *                                  furnishers sharing a record ref used to
 *                                  raise it and must not).
 *   overlay-projection-present  — a record's `CanonicalView` carried
 *                                  `overlay`; this function's input contract
 *                                  is facts-only views.
 */
export type SubjectViewErrorCode =
  | 'no-records'
  | 'subject-kind-disagreement'
  | 'missing-source-identity'
  | 'duplicate-source-record'
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
 * One furnished record's canonical view, tagged with the two facts
 * `CanonicalView` does not carry on its own (it describes one application, in
 * one producer's world, and knows nothing about the subject behind it or the
 * bureau in front of it).
 *
 * WHY `source` IS SUPPLIED HERE RATHER THAN READ OFF `view.ihsId` (SYS-3554).
 * Until this ticket that is exactly what this function did, on the argument —
 * stated in this doc's previous revision — that "`CanonicalView` already
 * carries it and a second field would be a second place for the two to
 * disagree." That argument is now inverted, and the inversion is the point:
 * `view` IS PAYLOAD. It is a document the bureau pulled from a furnisher, and
 * a furnisher must not be able to say who it is. Furnisher identity derives
 * from the CREDENTIALED CHANNEL — every pull is bureau-initiated against one
 * furnisher's endpoint with that furnisher's credential, so the caller
 * already knows the answer at the moment of authentication, before it has
 * read a byte of the payload. Reading identity out of the payload instead
 * would let any furnisher claim to be another one, and would re-collapse the
 * bureau onto a single id space the moment two furnishers numbered a record
 * the same. `view.ihsId` is now provenance only; this function does not read
 * it for identity, for keying, or for ordering.
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
  /**
   * SYS-3554 — the pair that identifies this contributed observation, stamped
   * by the caller from the credentialed pull channel. REQUIRED: there is no
   * default and no fallback to `view.ihsId`, deliberately, because a
   * `furnisherId` this function could invent would be one every furnisher
   * shared, which is the defect it exists to close.
   */
  source: SubjectSource
  view: CanonicalView
}

/**
 * The ONE way to ask whether two instances came from the same furnished
 * record. Both members are compared as whole strings, independently — this
 * function exists so that no consumer has to build
 * `` `${furnisherId}#${recordRef}` `` to get a comparable value, because both
 * halves are opaque and any join of them is ambiguous (see `SubjectSource`'s
 * own doc). For a keyed lookup rather than a scan, nest the maps
 * (`Map<furnisherId, Map<recordRef, …>>`) rather than flattening the pair
 * into one key.
 */
export function sameSubjectSource(a: SubjectSource, b: SubjectSource): boolean {
  return a.furnisherId === b.furnisherId && a.recordRef === b.recordRef
}

/**
 * A source rendered for a HUMAN reading an error message — never for keying,
 * comparing, or storing, and it is deliberately not a round-trippable
 * encoding: it quotes each half separately so that an operator can see where
 * one ends and the other begins, which a joined key could not show them. Every
 * throw below names the pair rather than the `ihsId` the messages used to
 * name, because a foreign tenant's application id identifies nothing to the
 * bureau operator reading the log.
 *
 * Tolerates a malformed source, because `missing-source-identity`'s own
 * message calls it: an error path that threw while describing the thing it was
 * refusing would replace a precise refusal with a TypeError.
 */
function describeSource(source: SubjectSource | undefined): string {
  const furnisherId = source?.furnisherId
  const recordRef = source?.recordRef
  return `furnisher ${JSON.stringify(furnisherId ?? null)} record ${JSON.stringify(recordRef ?? null)}`
}

/**
 * A deterministic TOTAL order over sources, and nothing more — read
 * `subjectViewFromRecords`'s own doc, section "WHAT HAPPENS WHEN `observedAt`
 * CANNOT SEPARATE TWO INSTANCES", before giving this any other meaning. It is
 * not a recency proxy, it is not a priority, and a caller must never render
 * it as one; its entire job is to make the sort order-independent so that the
 * same instance leads regardless of which record the caller listed first.
 *
 * Compared FIELD BY FIELD rather than on a joined string, for the reason
 * `SubjectSource` gives: `('a', 'b#c')` and `('a#b', 'c')` are different
 * sources that any `#`-join maps to one value, so a joined comparison would
 * call them equal — and equal sources are exactly what the duplicate check
 * below rejects and what `contestedLead` is defined not to fire on.
 */
function compareSources(a: SubjectSource, b: SubjectSource): number {
  if (a.furnisherId !== b.furnisherId) return a.furnisherId < b.furnisherId ? -1 : 1
  if (a.recordRef !== b.recordRef) return a.recordRef < b.recordRef ? -1 : 1
  return 0
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
 * Latest-`observedAt`-first, then a deterministic-but-meaningless source
 * order, stable beyond that — see this file's own doc for the full
 * justification of each key, and in particular for why the second key is NOT
 * a recency signal. Mutates and returns `instances` in place; callers pass a
 * list this function already owns (built fresh in `subjectViewFromRecords`,
 * never the caller's own array).
 */
function sortSubjectInstances(instances: SubjectInstance[]): SubjectInstance[] {
  return instances.sort((a, b) => {
    const aRank = timeRank(a.observedAt)
    const bRank = timeRank(b.observedAt)
    if (aRank !== bRank) return bRank - aRank
    return compareSources(a.source, b.source)
  })
}

/**
 * The disclosure half of the tie rule: given a category's ALREADY-SORTED
 * instances, report the distinct sources tied at the top when there is more
 * than one of them, and `undefined` otherwise. See
 * `SubjectCanonicalCategory.contestedLead` (`canonical-view.ts`) for why an
 * unresolved lead is surfaced rather than silently resolved.
 *
 * "Tied at the top" is measured on `observedAt` RANK, the only evidential key
 * — so a category where nothing carries `observedAt` at all has every
 * instance tied, which is precisely the case the old `sourceIhsId` tie-break
 * was invented for and precisely the case it answered wrongly across
 * furnishers.
 */
function contestedLeadOf(instances: readonly SubjectInstance[]): { sources: SubjectSource[] } | undefined {
  const lead = instances[0]
  if (lead === undefined) return undefined
  const leadRank = timeRank(lead.observedAt)
  const sources: SubjectSource[] = []
  for (const instance of instances) {
    if (timeRank(instance.observedAt) !== leadRank) break
    if (!sources.some((seen) => sameSubjectSource(seen, instance.source))) sources.push(instance.source)
  }
  return sources.length > 1 ? { sources } : undefined
}

/**
 * One field's winner while it is still being decided. Not exported and not the
 * wire shape: `rank` is a parsed number that must never reach a consumer (it
 * would be a second, subtly different encoding of `observedAt`), and
 * `tiedSources` / `disputed` are the two halves of a `contested` decision that
 * cannot be made until every instance has been seen.
 */
interface FieldSelectionInProgress {
  envelope: CanonicalFieldEnvelope
  source: SubjectSource
  instanceKey: string
  observedAt: string | undefined
  /** `timeRank` of the winning observation — the rank a later instance must EQUAL to be a tie. */
  rank: number
  /** Distinct sources observed at that same rank, in `instances` order, winner first. */
  tiedSources: SubjectSource[]
  /** Set once any tied observation carries a different `envelope.value` than the winner's. */
  disputed: boolean
}

/**
 * SYS-3464 — the per-field selection, filled into `into` (the category's own
 * `fieldsByInstanceKey`). Read `SubjectFieldSelection` and
 * `SubjectCanonicalCategory.fieldsByInstanceKey` (`canonical-view.ts`) for what
 * this member means and why it is keyed on `instanceKey`; this doc is the HOW.
 *
 * REQUIRES `instances` ALREADY SORTED latest-first by `sortSubjectInstances`,
 * exactly as `contestedLeadOf` does, and for the same reason: sorted input
 * turns "the most recent observation of this field" into "the FIRST instance
 * that carries it", which is one linear pass instead of a scan per field. It
 * also makes the tie test cheap — because rank descends, the only instances
 * that can tie a claimed field are the ones immediately following it at the
 * same rank, so an instance whose rank differs is strictly older for that
 * field and is skipped without comparison.
 *
 * WHY THE CLAIM IS PER (instanceKey, fieldName) AND NOT PER FIELD NAME ALONE:
 * see the "chimera" paragraph on `fieldsByInstanceKey`. Two instance keys are
 * two different things, and fusing their fields fabricates a row nobody
 * attested.
 *
 * `Object.is` RATHER THAN `===` on the value comparison, because the two
 * differ on exactly the inputs a numeric canonical field can produce: `-0`
 * and `0` are `===` but are not the same attested figure, and two `NaN`s are
 * not `===` but are the same (useless) reading, which would otherwise report
 * a source as disagreeing with ITSELF on a re-observation. Only `value` is
 * compared, never the whole envelope: two sources that agree on the figure
 * and differ on `confidence` are not in disagreement about the fact, and
 * reporting them as contested is the "always on, so ignored" failure
 * `contestedLead`'s own doc warns about.
 */
function buildFieldSelections(
  instances: readonly SubjectInstance[],
  into: Record<string, Record<string, SubjectFieldSelection>>,
): void {
  // Object.create(null) at BOTH levels, and not for symmetry: an instanceKey
  // and a field name are each producer-supplied text off the wire, so either
  // one spelled '__proto__' would read back Object.prototype from a plain
  // `{}` accumulator — the "have I claimed this field yet?" test below would
  // answer for a field nobody furnished, and the real observation would be
  // dropped with no error. Same hazard as the categoryId one above.
  const inProgress: Record<string, Record<string, FieldSelectionInProgress>> = Object.create(null)

  for (const instance of instances) {
    const rank = timeRank(instance.observedAt)
    const { fields, instanceKey, observedAt, source } = instance
    const claimedForKey = (inProgress[instanceKey] ??= Object.create(null))
    // `Object.keys` and an index rather than `Object.entries`, which allocates
    // a two-element array per field on a path that runs once per field of
    // every instance of every category of every record.
    for (const fieldName of Object.keys(fields)) {
      const claimed = claimedForKey[fieldName]
      if (claimed === undefined) {
        claimedForKey[fieldName] = {
          envelope: fields[fieldName]!,
          source,
          instanceKey,
          observedAt,
          rank,
          tiedSources: [source],
          disputed: false,
        }
        continue
      }
      // Strictly older for THIS field — superseded, and it is superseded per
      // field rather than per row, which is the whole ticket.
      if (claimed.rank !== rank) continue
      if (!claimed.tiedSources.some((seen) => sameSubjectSource(seen, source))) {
        claimed.tiedSources.push(source)
      }
      if (!Object.is(claimed.envelope.value, fields[fieldName]!.value)) claimed.disputed = true
    }
  }

  for (const instanceKey of Object.keys(inProgress)) {
    const claimedForKey = inProgress[instanceKey]!
    const emitted: Record<string, SubjectFieldSelection> = Object.create(null)
    for (const fieldName of Object.keys(claimedForKey)) {
      const claimed = claimedForKey[fieldName]!
      const selection: SubjectFieldSelection = {
        envelope: claimed.envelope,
        source: claimed.source,
        instanceKey: claimed.instanceKey,
      }
      // Assigned only when there IS one, same rule as `contestedLead` and for
      // the same reason: an always-present `observedAt: undefined` serializes
      // as an explicit null in some encoders, and a null timestamp reads as a
      // value rather than as an absence.
      if (claimed.observedAt !== undefined) selection.observedAt = claimed.observedAt
      // BOTH conditions, and neither alone: more than one source ties, AND
      // they do not agree. See `SubjectFieldSelection.contested` for why the
      // predicate is narrower than `contestedLead`'s.
      if (claimed.disputed && claimed.tiedSources.length > 1) {
        selection.contested = { sources: claimed.tiedSources }
      }
      emitted[fieldName] = selection
    }
    into[instanceKey] = emitted
  }
}

/**
 * Merge one subject's contributed records into the one subject-scoped view. See
 * this file's own doc for the ordering rule, the parsing rule, the
 * tie-break, the aliasing contract, and — SYS-3464 — per-field recency plus
 * the filter-ordering contract a caller owes this function.
 *
 * IT RETURNS TWO ANSWERS, NOT ONE, AND THEY ARE FOR DIFFERENT QUESTIONS.
 * `instances` is the ledger, ordered latest-row-first. `fieldsByInstanceKey`
 * is the per-field selection, and it is what a consumer reads to get a FIELD's
 * value; spreading `instances[0].fields` flat is latest-ROW-wins and erases
 * every field the newest partial row did not mention (SYS-3464).
 *
 * `subjectKind` DISAGREEMENT ACROSS RECORDS: every record here is asserted
 * by its caller to describe the SAME subject, so a differing `subjectKind`
 * is not a value to reconcile — a subject's kind does not change between
 * contributed records, so a mismatch means the caller mismatched something
 * upstream (joined the wrong records to a subject, or the subject registry
 * itself is wrong). Silently picking one, or worse, invisibly overriding one
 * value with another, would hide exactly that bug — the same reasoning
 * `applyAggregation` already applies to a numeric operator fed a non-numeric
 * value in `adapter-aggregation.ts` ("the operator was misused ... and
 * silent zero-coercion would mask the bug"). So this throws, naming every
 * SOURCE PAIR and kind involved — see `describeSource`, which quotes each
 * half separately precisely so a message can never be parsed back into a
 * pair — rather than guessing.
 *
 * A DUPLICATE SOURCE **PAIR** ACROSS RECORDS (SYS-3542 review's F3, rescoped
 * by SYS-3554): throws, naming the repeated pair. Uniqueness at subject scope
 * is the tuple `(furnisherId, recordRef, instanceKey)`, so two records
 * carrying the SAME pair are two copies of one furnished record and their
 * instances would be indistinguishable from each other in any correctly-keyed
 * lookup — a caller bug this function can see, and it does not let the second
 * copy masquerade as a second observation.
 *
 * WHAT IT MUST NOT DO, AND USED TO (SYS-3554, consequence 1): two DIFFERENT
 * furnishers using the SAME `recordRef` are not a duplicate. They are the
 * ordinary case — a bureau aggregating many finsys-api instances, each with
 * its own auto-increment sequence, so lender A's application 7 and lender B's
 * application 7 are the same number and mean nothing to each other. The
 * previous check keyed on that bare foreign sequence, so those two records
 * raised `duplicate-source-ihs-id` and the subject failed EVERY inquiry. Both
 * halves are compared, and they are compared separately: a check that keyed
 * on a `#`-joined pair would call `('a', 'b#c')` and `('a#b', 'c')` duplicates
 * of each other, reintroducing the same false collision one level up.
 *
 * AN ABSENT OR EMPTY HALF OF THE PAIR (SYS-3554): also throws
 * (`missing-source-identity`), rather than defaulting. An empty `furnisherId`
 * is every furnisher at once — it is the pre-SYS-3554 world spelled with a
 * different character — and an empty `recordRef` collides with every other
 * ref-less record from the same furnisher. Both would fail CLOSED-looking
 * (one subject, plausibly merged) while being the exact conflation this
 * function was rewritten to make impossible, so neither is accepted as a
 * value.
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
  // NESTED, never a joined key: `Map<furnisherId, Set<recordRef>>` compares
  // each half of the pair as a whole string, so no `recordRef` containing the
  // delimiter of the day can be mistaken for part of another furnisher's id.
  // A `Map` rather than an object because a furnisher id is caller-supplied
  // text like any other, and '__proto__' is exactly as legal a string here as
  // it is for a category id below (SYS-3542 review's F10, same hazard).
  const seenRefsByFurnisher = new Map<string, Set<string>>()
  for (const record of records) {
    if (record.subjectKind !== subjectKind) {
      throw new SubjectViewError(
        'subject-kind-disagreement',
        `subjectViewFromRecords: subjectKind disagreement across records for one subject — ` +
          `${describeSource(records[0]!.source)} says '${subjectKind}', ${describeSource(record.source)} ` +
          `says '${record.subjectKind}'. Records for one subject must agree; this looks like records for ` +
          `two different subjects were merged, and guessing a winner would hide that.`,
      )
    }
    if (record.view.overlay !== undefined) {
      throw new SubjectViewError(
        'overlay-projection-present',
        `subjectViewFromRecords: ${describeSource(record.source)} carries a lender-overlay projection ` +
          `(CanonicalView.overlay is present). This function's input contract is facts-only views; an ` +
          `overlay-projected view's field values may be a lender's staged, uncommitted edits rather than ` +
          `attested facts, and merging it in would disclose those edits as subject data with the one ` +
          `marker that could have flagged them removed. Read the facts-only view for this record ` +
          `instead of its ?overlay=mine projection.`,
      )
    }
    // Read through an `as` rather than a destructure of the typed member: this
    // guard exists for the JavaScript caller the type cannot reach (finsys-api
    // assembles these from a database row), and a purely type-level read would
    // make the check look present while being unable to fail.
    const source = record.source as Partial<SubjectSource> | undefined
    const furnisherId = source?.furnisherId
    const recordRef = source?.recordRef
    if (typeof furnisherId !== 'string' || furnisherId === '' || typeof recordRef !== 'string' || recordRef === '') {
      throw new SubjectViewError(
        'missing-source-identity',
        `subjectViewFromRecords: a record carried no usable source identity ` +
          `(${describeSource(record.source)}). Both halves of the pair are required and neither may be ` +
          `empty: furnisherId is minted by the bureau and stamped from the credentialed pull channel, ` +
          `and recordRef is the furnisher's own opaque reference to the record. An empty furnisherId is ` +
          `every furnisher at once, and an empty recordRef collides with every other ref-less record ` +
          `from the same furnisher — both silently reconflate the id spaces this pair exists to keep ` +
          `apart.`,
      )
    }
    const seenRefs = seenRefsByFurnisher.get(furnisherId)
    if (seenRefs !== undefined && seenRefs.has(recordRef)) {
      throw new SubjectViewError(
        'duplicate-source-record',
        `subjectViewFromRecords: ${describeSource(record.source)} appears more than once in records. ` +
          `Every record must be a distinct furnished observation — identity at subject scope is the ` +
          `pair (furnisherId, recordRef), and two records carrying the same pair are two copies of one ` +
          `record whose instances no correctly-keyed lookup could tell apart. Two DIFFERENT furnishers ` +
          `sharing a recordRef is NOT this error: each furnisher's refs are local to that furnisher, and ` +
          `treating them as one keyspace is the SYS-3554 defect.`,
      )
    }
    if (seenRefs === undefined) seenRefsByFurnisher.set(furnisherId, new Set([recordRef]))
    else seenRefs.add(recordRef)
  }

  // Object.create(null): categoryId comes off a Record read from the wire,
  // and a plain `{}` accumulator lets a category literally named
  // "__proto__" read back Object.prototype instead of undefined, so
  // `??=` silently never assigns it (SYS-3542 review's F10). A null-
  // prototype object has no such accessor to intercept the assignment.
  const categories: Record<string, SubjectCanonicalCategory> = Object.create(null)

  for (const record of records) {
    // Read ONCE per record and shared by reference across every instance it
    // contributes. Re-deriving it per instance would be the only place a
    // furnisher axis could drift within one record, and sharing the object is
    // consistent with the ALIASING contract above: nothing in this package
    // mutates a source in place, and `sameSubjectSource` compares by value
    // rather than by identity, so a consumer that builds its own never
    // behaves differently from one that reads this.
    const source = record.source
    for (const [categoryId, category] of Object.entries(record.view.categories)) {
      // `fieldsByInstanceKey` is created empty HERE and filled by
      // `buildFieldSelections` below rather than being replaced wholesale, so
      // there is no sentinel object and no window in which the member is
      // absent. Null-prototype for the reason its own doc gives.
      const bucket = (categories[categoryId] ??= {
        instances: [],
        fieldsByInstanceKey: Object.create(null),
      })
      for (const instance of category.instances) {
        // F12: legacySlot/periodPosition are deleted from the object, not
        // only from the type — see this file's own "PER-APPLICATION MEMBERS
        // ARE STRIPPED" doc for why a type-only omission would be worse than
        // carrying them typed.
        const { legacySlot: _legacySlot, periodPosition: _periodPosition, ...rest } = instance
        const subjectInstance: SubjectInstance = {
          // `instanceKey` is NOT rewritten (SYS-3554) — it passes through RAW,
          // `''` included. Uniqueness is the tuple (furnisherId, recordRef,
          // instanceKey), carried structurally in `source` below; the
          // `${sourceIhsId}#${rawKey}` qualification this line used to perform
          // is gone rather than re-delimited, because both halves of the pair
          // are opaque strings and no delimiter is absent from both. See
          // `SubjectInstance`'s own doc (`canonical-view.ts`).
          ...rest,
          // A fresh object, not the source instance's own — see this file's
          // own "ALIASING" section for exactly what this does and does not
          // protect against.
          fields: { ...instance.fields },
          source,
        }
        bucket.instances.push(subjectInstance)
      }
    }
  }

  for (const bucket of Object.values(categories)) {
    sortSubjectInstances(bucket.instances)
    // Assigned only when there IS one: an always-present `contestedLead:
    // undefined` would serialize into the wire payload as an explicit null in
    // some encoders and read as "contested, sources unknown".
    const contestedLead = contestedLeadOf(bucket.instances)
    if (contestedLead !== undefined) bucket.contestedLead = contestedLead
    // AFTER the sort, and it depends on it — see `buildFieldSelections`'s own
    // doc. The row order above decides which instance LEADS; this decides what
    // each FIELD's value is, and at subject scope those are different answers.
    buildFieldSelections(bucket.instances, bucket.fieldsByInstanceKey)
  }

  return { subjectKind, categories }
}
