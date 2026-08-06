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
