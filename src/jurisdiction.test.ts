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

import { describe, it, expect } from 'vitest'
import {
  JURISDICTION,
  DEFAULT_JURISDICTION,
  JURISDICTION_CODES,
  isJurisdiction,
  resolveJurisdiction,
  checkJurisdictionCompatibility,
  describeIncompatibility,
  IncompatibilityReason,
} from './jurisdiction.js'
import { FormSpec } from './form-spec.js'
import { FormFieldCategory } from './form-field-category.js'
import unifiedFormSchema from './schema/unified-form.schema.json' with { type: 'json' }

describe('jurisdiction registry', () => {
  it('absent means Malaysia — every pre-SYS-3263 form keeps its meaning', () => {
    // Not a convenience default. No form authored before this shipped
    // declares a jurisdiction and none is being backfilled, so a reader that
    // treats undefined as "no jurisdiction" would refuse all of them.
    expect(DEFAULT_JURISDICTION).toBe(JURISDICTION.MALAYSIA)
    expect(resolveJurisdiction(undefined)).toBe('MY')
    // null IS absent: it is what a JSONB column and a React "not set" write,
    // and it is the shape SYS-2872's precedent is phrased in for
    // Program.jurisdiction and Ihs.jurisdiction.
    expect(resolveJurisdiction(null)).toBe('MY')
  })

  it('an EMPTY STRING is not absent — it is unresolvable', () => {
    // Deliberately different from null. finsys-api fails CLOSED on '' —
    // financialStatementSpecFor throws, extractionApiService refuses the
    // route — and Program.jurisdiction is a plain varchar, so '' is
    // reachable. If this returned Malaysia, SYS-3258 swapping finsys-api
    // onto this helper would silently turn "refuse extraction" into
    // "extract as Malaysian".
    expect(resolveJurisdiction('')).toBeNull()
  })

  it('an UNRECOGNIZED jurisdiction resolves to null, never to the default', () => {
    // The distinction that matters: absent is "Malaysia", unknown is an
    // ERROR. Defaulting an unrecognized value to MY would route a foreign
    // form into Malaysian handling — the exact failure this axis exists to
    // prevent — and it would do so silently.
    expect(resolveJurisdiction('VM')).toBeNull()
    expect(resolveJurisdiction('XX')).toBeNull()
    expect(resolveJurisdiction('Malaysia')).toBeNull()
  })

  it('is case-strict — "my" is not Malaysia', () => {
    // Normalising case would let two spellings of one jurisdiction coexist,
    // which reads as agreement until something compares them literally.
    expect(isJurisdiction('MY')).toBe(true)
    expect(isJurisdiction('my')).toBe(false)
    expect(isJurisdiction('My')).toBe(false)
  })

  it('exposes every declarable code, and no code is three uppercase letters', () => {
    // A guard against the shape confusion that bit the canonical field specs:
    // a currency code is three uppercase letters, a jurisdiction is two.
    expect([...JURISDICTION_CODES].sort()).toEqual(['MY', 'VN'])
    for (const c of JURISDICTION_CODES) expect(c).toMatch(/^[A-Z]{2}$/)
  })
})

describe('the schema enum does not drift from the registry', () => {
  it('unified-form.schema.json enumerates exactly JURISDICTION_CODES', () => {
    // This repo already killed this exact pattern once. adapter-category-drift
    // deleted a category enum from a JSON schema because the id set lived in
    // three places that had to agree, and asserts a reintroduced enum should
    // "fail loudly if one appears".
    //
    // This one is kept deliberately: FinHub validates form configs ONLY through
    // this schema — it never constructs a FormSpec, so FormSpec.validate()'s
    // guard is invisible to it, and without the enum an unknown jurisdiction
    // reaches FinHub storage unchecked. The cost of that choice is a second
    // source of truth, so this test IS the mitigation. Adding Thailand without
    // it means the registry accepts TH while ajv rejects it with "must be equal
    // to one of the allowed values" — naming neither Thailand nor which file
    // to edit.
    const enumerated = (unifiedFormSchema as { properties: Record<string, { enum?: string[] }> })
      .properties.jurisdiction?.enum
    expect(enumerated, 'the schema must enumerate jurisdictions').toBeDefined()
    expect([...(enumerated ?? [])].sort()).toEqual([...JURISDICTION_CODES].sort())
  })
})

describe('FormSpec declares a single jurisdiction', () => {
  const spec = (jurisdiction?: 'MY' | 'VN') =>
    new FormSpec(
      'Fixture Form',
      [new FormFieldCategory('1', 'General')],
      [],
      [{ id: 'page-1', title: 'General', fields: [] }],
      undefined,
      FormSpec.MAX_PARSER_SCHEMA_VERSION,
      jurisdiction
    )

  it('a form that declares nothing is effectively Malaysian', () => {
    const s = spec()
    expect(s.jurisdiction).toBeUndefined()
    expect(s.effectiveJurisdiction).toBe('MY')
  })

  it('a declared jurisdiction survives a JSON round trip', () => {
    // toJSON runs through cleanObject, which strips undefined — so this also
    // pins that a DECLARED value is not dropped on the way out.
    const round = FormSpec.fromJSON(JSON.stringify(spec('VN').toJSON()))
    expect(round.jurisdiction).toBe('VN')
    expect(round.effectiveJurisdiction).toBe('VN')
  })

  it('an undeclared jurisdiction is omitted from JSON, not written as null', () => {
    expect(JSON.stringify(spec().toJSON())).not.toContain('jurisdiction')
  })

  it('validate() refuses a present-but-unknown jurisdiction, and names the alternatives', () => {
    const s = spec()
    // Cast: the type already forbids this, so the runtime guard is the only
    // thing standing between a typo in authored JSON and a form that fails
    // every compatibility check for a reason nobody can see.
    ;(s as unknown as { _jurisdiction: string })._jurisdiction = 'VM'
    const result = s.validate()
    expect(result.valid).toBe(false)
    const msg = (result.errors ?? []).map((e: { message: string }) => e.message).join(' | ')
    expect(msg).toContain('unknown jurisdiction')
    expect(msg).toContain('VM')
    expect(msg).toContain(JURISDICTION_CODES.join(', '))
  })

  it('the values that are neither absent nor valid all fail the same way', () => {
    // The three shapes that had three different answers before review:
    //   ''    — an empty select, and what finsys-api fails CLOSED on
    //   null  — what a JSONB column and a React "not set" actually write,
    //           and the shape SYS-2872's own precedent is phrased in
    //   'my'  — a miscased declaration
    // Each was previously handed back by effectiveJurisdiction typed as a
    // Jurisdiction, and null skipped validate() entirely.
    for (const bad of ['', 'my', 'VM'] as unknown[]) {
      const s = spec()
      ;(s as unknown as { _jurisdiction: unknown })._jurisdiction = bad
      expect(s.effectiveJurisdiction, `effectiveJurisdiction for ${JSON.stringify(bad)}`).toBeNull()
      expect(s.validate().valid, `validate() for ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('absence — and only absence — resolves to Malaysia', () => {
    for (const absent of [undefined, null] as unknown[]) {
      const s = spec()
      ;(s as unknown as { _jurisdiction: unknown })._jurisdiction = absent
      expect(s.effectiveJurisdiction).toBe('MY')
      expect(s.validate().valid).toBe(true)
    }
  })

  it('validate() ACCEPTS both an absent and a legitimate jurisdiction — the guard is not refusing everything', () => {
    // The positive control. Without it the rejection above would pass just as
    // happily against a validate() that failed unconditionally.
    expect(spec().validate().valid).toBe(true)
    expect(spec('MY').validate().valid).toBe(true)
    expect(spec('VN').validate().valid).toBe(true)
  })
})

// ── SYS-3266: the one predicate every tier shares ────────────────────
describe('checkJurisdictionCompatibility', () => {
  it('matching jurisdictions are compatible, and it says which', () => {
    for (const j of JURISDICTION_CODES) {
      const r = checkJurisdictionCompatibility(j, j)
      expect(r.compatible, `${j} vs ${j}`).toBe(true)
      if (r.compatible) expect(r.jurisdiction).toBe(j)
    }
  })

  it('a mismatch is refused, and reports BOTH sides', () => {
    // The reason this returns a result rather than a boolean: every caller
    // that refuses has to say which pairing and why, and re-deriving that
    // from the inputs is how two tiers end up phrasing it differently.
    const r = checkJurisdictionCompatibility('MY', 'VN')
    expect(r.compatible).toBe(false)
    if (!r.compatible) {
      expect(r.reason).toBe(IncompatibilityReason.Mismatch)
      expect(r.form).toBe('MY')
      expect(r.program).toBe('VN')
    }
    expect(describeIncompatibility(r)).toContain("'MY'")
    expect(describeIncompatibility(r)).toContain("'VN'")
  })

  it('absence on either side means Malaysia — so legacy pairings still work', () => {
    // Every form authored before SYS-3263 declares nothing, and every
    // pre-SYS-2872 program is null. If absence did not resolve to Malaysia,
    // this predicate would refuse all existing production traffic on the day
    // it shipped.
    expect(checkJurisdictionCompatibility(undefined, undefined).compatible).toBe(true)
    expect(checkJurisdictionCompatibility(null, null).compatible).toBe(true)
    expect(checkJurisdictionCompatibility(undefined, 'MY').compatible).toBe(true)
    expect(checkJurisdictionCompatibility('MY', null).compatible).toBe(true)
    // ...but absence does NOT make a non-Malaysian program compatible.
    expect(checkJurisdictionCompatibility(undefined, 'VN').compatible).toBe(false)
  })

  it('an empty string is unresolvable, not absent — on either side', () => {
    const f = checkJurisdictionCompatibility('', 'MY')
    expect(f.compatible).toBe(false)
    if (!f.compatible) expect(f.reason).toBe(IncompatibilityReason.UnresolvableForm)
    const p = checkJurisdictionCompatibility('MY', '')
    expect(p.compatible).toBe(false)
    if (!p.compatible) expect(p.reason).toBe(IncompatibilityReason.UnresolvableProgram)
  })

  it('the SAME unrecognized value on both sides is NOT a match', () => {
    // The case worth being deliberate about. Two sides both declaring "VM"
    // is not agreement — it is the same typo twice, and letting a pair of
    // mistakes authorise each other is exactly the silent-pass this whole
    // axis exists to prevent.
    const r = checkJurisdictionCompatibility('VM', 'VM')
    expect(r.compatible).toBe(false)
    if (!r.compatible) expect(r.reason).toBe(IncompatibilityReason.UnresolvableForm)
  })

  it('is case-strict on both sides', () => {
    expect(checkJurisdictionCompatibility('my', 'MY').compatible).toBe(false)
    expect(checkJurisdictionCompatibility('MY', 'my').compatible).toBe(false)
  })

  it('describeIncompatibility returns null for a compatible pairing, and never leaks a raw enum', () => {
    expect(describeIncompatibility(checkJurisdictionCompatibility('MY', 'MY'))).toBeNull()
    for (const [f, p] of [['MY', 'VN'], ['', 'MY'], ['MY', ''], ['VM', 'VM']] as [string, string][]) {
      const msg = describeIncompatibility(checkJurisdictionCompatibility(f, p))
      expect(msg, `${f} vs ${p}`).toBeTruthy()
      // A user-facing string, not a debug dump: no enum values, no underscores.
      expect(msg!).not.toMatch(/unresolvable_|mismatch/)
    }
  })
})
