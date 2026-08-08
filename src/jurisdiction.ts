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
 * SYS-3263: the jurisdiction registry, in the package that every app shares.
 *
 * WHY IT LIVES HERE AND NOT IN finsys-api
 *
 * finsys-api has carried `JURISDICTION` since SYS-2872, and that is where it
 * was needed first — extraction routing and spec dispatch. But finsys-api
 * predates this package: @finsys/core came later, to bridge contracts across
 * the apps that sit on it. A jurisdiction is now something a FORM declares
 * (below), something a PROGRAM declares, and something FinHub and
 * finsys-client both have to render. That makes it a shared contract, and a
 * shared contract stranded in one consumer is how two copies start.
 *
 * The definitive corrective example is one repo over: `IhsFieldProvenance` is
 * declared BOTH here and in finsys-api, with nothing detecting drift between
 * them. This registry is deliberately not going the same way.
 *
 * SO: finsys-api's copy must import from here rather than keep its own. That
 * de-duplication is SYS-3258's, not this ticket's — but it is the reason this
 * file exists here rather than being copied. Until it lands the two sets
 * agree by inspection, which is exactly the fragile state that ends the
 * moment somebody adds Thailand to one of them.
 *
 * A jurisdiction is a Program-level FIXED property: it determines which
 * document types exist, which extraction specs apply, and which regulations
 * govern. It is a different axis from document language (per-file, chooses an
 * extraction endpoint) and from display language (per-user i18n).
 */
export const JURISDICTION = {
  MALAYSIA: 'MY',
  VIETNAM: 'VN',
  THAILAND: 'TH',
} as const

export type Jurisdiction = (typeof JURISDICTION)[keyof typeof JURISDICTION]

/**
 * The platform was Malaysia-only before SYS-2872, so an absent jurisdiction
 * always means Malaysia — on a program, on an IHS row, and now on a form
 * spec. Readers must treat absence as MY rather than expecting a backfill:
 * every form authored before this shipped has no declaration and none will
 * be added retroactively.
 */
export const DEFAULT_JURISDICTION: Jurisdiction = JURISDICTION.MALAYSIA

/** Every declarable jurisdiction code, for validation and iteration. */
export const JURISDICTION_CODES: ReadonlyArray<Jurisdiction> = Object.freeze(
  Object.values(JURISDICTION) as Jurisdiction[]
)

/**
 * Narrows an arbitrary value to a declarable jurisdiction code.
 *
 * Deliberately strict about case: "my" is not accepted as Malaysia. A form
 * spec is authored data, and silently normalising it would let two spellings
 * of the same jurisdiction coexist — which reads as agreement until something
 * compares them literally.
 */
export function isJurisdiction(value: unknown): value is Jurisdiction {
  return typeof value === 'string' && (JURISDICTION_CODES as readonly string[]).includes(value)
}

/**
 * Resolves a possibly-absent declaration to the jurisdiction that actually
 * applies. Absent means Malaysia; a present-but-unknown value is NOT silently
 * defaulted — callers that accept unvalidated input should reject it instead,
 * because defaulting an unrecognized jurisdiction to MY would route a foreign
 * form into Malaysian handling, which is the failure this whole axis exists
 * to prevent.
 */
export function resolveJurisdiction(value: string | null | undefined): Jurisdiction | null {
  // ABSENT is null/undefined only. An EMPTY STRING is deliberately NOT absent.
  //
  // finsys-api treats '' as unresolvable and fails closed — financialStatementSpecFor
  // throws a ValidationError, and extractionApiService refuses the route. If this
  // helper returned Malaysia for '', then SYS-3258 swapping finsys-api onto it would
  // silently turn "refuse extraction" into "extract as Malaysian", which is a change
  // in failure mode disguised as a de-duplication. Program.jurisdiction is a plain
  // varchar(8), so '' is reachable.
  if (value === null || value === undefined) return DEFAULT_JURISDICTION
  return isJurisdiction(value) ? value : null
}

/**
 * SYS-3266: why a form and a program are not compatible.
 *
 * An enum rather than a string union — the set will grow (a form declaring a
 * jurisdiction the deployment has retired is the obvious next member), and a
 * consumer switching on it should get an exhaustiveness error rather than a
 * silently-unhandled string.
 */
export enum IncompatibilityReason {
  /** Both resolved, and they are different jurisdictions. */
  Mismatch = 'mismatch',
  /** The FORM declares something that is not a jurisdiction we recognize. */
  UnresolvableForm = 'unresolvable_form',
  /** The PROGRAM declares something that is not a jurisdiction we recognize. */
  UnresolvableProgram = 'unresolvable_program',
}

/**
 * The outcome of comparing a form's jurisdiction with a program's.
 *
 * Deliberately not a boolean. Every caller that refuses a pairing has to tell
 * somebody WHICH pairing and WHY — "this form is declared MY, that program is
 * VN" — and a bare boolean makes each of them re-derive that from inputs they
 * then have to keep in scope. Returning the resolved values means the message
 * is built from what the decision was actually made on, not from a caller's
 * second look at the same data.
 */
export type JurisdictionCompatibility =
  | { readonly compatible: true; readonly jurisdiction: Jurisdiction }
  | {
      readonly compatible: false
      readonly reason: IncompatibilityReason
      /** Resolved where possible; the raw declaration where it could not be. */
      readonly form: Jurisdiction | string | null | undefined
      readonly program: Jurisdiction | string | null | undefined
    }

/**
 * SYS-3266: is this form usable to submit to this program?
 *
 * THE ONE PREDICATE. Kain's rule is symmetric, so this is called from three
 * places rather than reimplemented in each: filtering forms for a chosen
 * program, filtering programs for a chosen form, and refusing a mismatch at
 * submit. The first two are the reason nobody reaches the third.
 *
 * Consumed by FinHub (the manager tier, SYS-3265) and @finsys/borrower-client
 * (the SDK tier, SYS-3269). Raw HTTP callers are unguarded by design.
 *
 * ABSENCE resolves to Malaysia on both sides, via `resolveJurisdiction`, so
 * there is ONE definition of "absent" rather than a fourth — SYS-3263's review
 * found three implementations of that question disagreeing on null and ''.
 * Note that an empty string is NOT absent: finsys-api fails closed on it, and
 * a form or program carrying '' is unresolvable, not Malaysian.
 *
 * AN UNRECOGNIZED VALUE IS COMPATIBLE WITH NOTHING — including an identical
 * unrecognized value on the other side. Two forms both declaring "VM" are not
 * evidence of agreement, they are evidence of the same typo twice, and
 * treating them as a match would let a pair of mistakes authorise each other.
 */
export function checkJurisdictionCompatibility(
  formJurisdiction: string | null | undefined,
  programJurisdiction: string | null | undefined
): JurisdictionCompatibility {
  const form = resolveJurisdiction(formJurisdiction)
  const program = resolveJurisdiction(programJurisdiction)

  if (form === null) {
    return {
      compatible: false,
      reason: IncompatibilityReason.UnresolvableForm,
      form: formJurisdiction,
      program: program ?? programJurisdiction,
    }
  }
  if (program === null) {
    return {
      compatible: false,
      reason: IncompatibilityReason.UnresolvableProgram,
      form,
      program: programJurisdiction,
    }
  }
  if (form !== program) {
    return { compatible: false, reason: IncompatibilityReason.Mismatch, form, program }
  }
  return { compatible: true, jurisdiction: form }
}

/**
 * A message a consumer can show without re-deriving the decision.
 *
 * Kept beside the predicate so every tier phrases a refusal identically —
 * FinHub, the SDK and any future caller. A user hitting the same wall in two
 * products should not have to work out that it is the same wall.
 */
export function describeIncompatibility(result: JurisdictionCompatibility): string | null {
  if (result.compatible) return null
  const shown = (v: unknown) =>
    v === null || v === undefined || v === '' ? '(not set)' : `'${String(v)}'`
  switch (result.reason) {
    case IncompatibilityReason.Mismatch:
      return `This form is for ${shown(result.form)} but the selected program is ${shown(result.program)}.`
    case IncompatibilityReason.UnresolvableForm:
      return `This form declares ${shown(result.form)}, which is not a jurisdiction this deployment recognizes.`
    case IncompatibilityReason.UnresolvableProgram:
      return `The selected program declares ${shown(result.program)}, which is not a jurisdiction this deployment recognizes.`
  }
}

/**
 * SYS-3284/SYS-3285: the currency a jurisdiction's amounts are DISPLAYED in
 * when the value itself does not say.
 *
 * READ THIS BEFORE USING IT — it is narrower than it looks.
 *
 * SYS-3249 established that a currency belongs to the OBSERVATION, not to a
 * field, a table or a country: one document can legitimately report several
 * currencies, so nothing may stamp a currency across a record. That still
 * holds and this does not weaken it.
 *
 * What this map is: a DISPLAY DEFAULT for the case where a value carries no
 * recorded currency of its own. Today that is every value, because
 * `IhsFieldProvenance.currency` has no producer yet — so FinHub and
 * finsys-client were left choosing between printing a hardcoded "RM" (wrong
 * outside Malaysia) and printing a bare number (ambiguous everywhere). This
 * gives them a third option that is right in the common case and overridable
 * in the uncommon one.
 *
 * What it is NOT: a fact about the record. It must never be written to a
 * row, returned from an API as the record's currency, or used to decide
 * anything but rendering. The moment a value carries its own currency, that
 * wins — see `resolveDisplayCurrency`.
 *
 * A jurisdiction whose amounts are commonly reported in a currency other than
 * its own is exactly why the override exists rather than why this map should
 * grow conditionals.
 */
export const JURISDICTION_DISPLAY_CURRENCY: Readonly<Record<Jurisdiction, string>> = Object.freeze({
  [JURISDICTION.MALAYSIA]: 'MYR',
  [JURISDICTION.VIETNAM]: 'VND',
  [JURISDICTION.THAILAND]: 'THB',
})

/**
 * Whether a jurisdiction's national identity number ENCODES THE HOLDER'S BIRTH
 * DATE in a position software can read.
 *
 * This exists because a Malaysia-specific parsing rule was running on every
 * application regardless of jurisdiction: the first six digits of an NRIC are
 * the birth date as YYMMDD, and that is true of no other national id we
 * accept. Measured against real id shapes (SYS-3257):
 *
 *   MY NRIC   900115085432   -> 1990-01-15     correct
 *   VN CCCD   001201123456   -> 2000-12-01     plausible and WRONG
 *   TH natID  1103701234567  -> "Invalid date"
 *   TH natID  5501200098765  -> 2055-01-20     a birth date thirty years hence
 *
 * A Vietnamese CCCD leads with a province code, a gender/century digit and a
 * two-digit birth YEAR — not a date. A Thai national id encodes no birth date
 * anywhere: digit 1 is person type, 2–5 province and district, the rest
 * sequence and a check digit. So the failure was silent in both directions —
 * sometimes an unparseable string written to a date column, sometimes a
 * believable date that is simply false.
 *
 * A registry entry rather than an equality check at the call site, so a fourth
 * jurisdiction is a line here instead of an edit to whatever function happens
 * to parse ids that week.
 */
export const JURISDICTION_NATIONAL_ID_ENCODES_BIRTH_DATE: Readonly<Record<Jurisdiction, boolean>> =
  Object.freeze({
    [JURISDICTION.MALAYSIA]: true,
    [JURISDICTION.VIETNAM]: false,
    [JURISDICTION.THAILAND]: false,
  })

/**
 * Whether a birth date may be derived from a national id under this
 * jurisdiction.
 *
 * ABSENCE RESOLVES TO MALAYSIA, deliberately, via `resolveJurisdiction` — the
 * same platform rule the rest of this module follows. That is load-bearing
 * here rather than merely consistent: rows created without a resolved program
 * carry `jurisdiction = null`, and every one of them is Malaysian. A literal
 * `=== 'MY'` check at the call site would silently stop deriving for all of
 * them, turning a fix for Vietnam into a regression for Malaysia.
 *
 * An UNRESOLVABLE jurisdiction returns false. Deriving on a code we do not
 * recognise is exactly the guess this replaces.
 */
export function nationalIdEncodesBirthDate(jurisdiction: string | null | undefined): boolean {
  const resolved = resolveJurisdiction(jurisdiction)
  if (resolved === null) return false
  return JURISDICTION_NATIONAL_ID_ENCODES_BIRTH_DATE[resolved]
}

/**
 * The currency to render a value in: the value's own if it has one, otherwise
 * the jurisdiction's display default, otherwise nothing.
 *
 * Returning `undefined` is a real answer and callers must handle it — it means
 * "no basis to name a currency", and printing a bare number is then correct.
 * Substituting a guess here is how a Vietnamese figure ends up labelled MYR,
 * which is the bug this exists to fix.
 *
 * @param valueCurrency ISO 4217 recorded on the observation, when one exists.
 * @param jurisdiction  the record's jurisdiction; absence resolves to Malaysia
 *                      the same way it does everywhere else on this axis.
 */
/**
 * What a caller passes as `jurisdiction` when it has NO BASIS to name one.
 *
 * There are two different "I don't have a jurisdiction", and collapsing them
 * is a real bug:
 *
 *   - A RECORD whose jurisdiction column is null. The platform rule says
 *     Malaysia, and that rule is right — the column predates jurisdictions
 *     and every such row is Malaysian. Pass `null`.
 *
 *   - A CALL SITE with no record at all: a form with no program selected, a
 *     total spanning several countries, a page that simply was not given one.
 *     Malaysia is not a default here, it is a fabrication. Pass this.
 *
 * Both consumers of the 5.4.0 money helpers invented this concept privately
 * before it existed — one made the parameter required with a warning comment,
 * the other defined its own empty-string sentinel — which is what naming it
 * here is a response to. Two independent workarounds for one missing idea.
 *
 * It is the empty string because `resolveJurisdiction('')` already fails
 * closed; this gives that behavior a name and a contract instead of leaving
 * it an implementation detail two repos happened to discover.
 */
export const NO_JURISDICTION_BASIS = ''

export function resolveDisplayCurrency(
  valueCurrency: string | null | undefined,
  jurisdiction: string | null | undefined
): string | undefined {
  const own = valueCurrency?.trim().toUpperCase()
  if (own) return own

  const resolved = resolveJurisdiction(jurisdiction)
  // An unresolvable jurisdiction gets NO currency rather than Malaysia's.
  // Defaulting it would be the same class of error as the hardcoded 'MYR'
  // this replaces, just harder to see.
  if (resolved === null) return undefined
  return JURISDICTION_DISPLAY_CURRENCY[resolved]
}
