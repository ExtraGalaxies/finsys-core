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
 * because defaulting an unrecognised jurisdiction to MY would route a foreign
 * form into Malaysian handling, which is the failure this whole axis exists
 * to prevent.
 */
export function resolveJurisdiction(value: string | null | undefined): Jurisdiction | null {
  if (value === null || value === undefined || value === '') return DEFAULT_JURISDICTION
  return isJurisdiction(value) ? value : null
}
