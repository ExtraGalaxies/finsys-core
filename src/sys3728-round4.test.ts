import { describe, it, expect } from 'vitest'
import { categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory } from './adapter-categories.js'
import { RATIO_MAX_DECIMALS, validateAdapterExtraction, validateFieldValue } from './canonical-validation.js'
import type { Violation } from './canonical-validation.js'
import { parseCurrencyHeading } from './currency.js'

/**
 * Fourth adversarial review (at 7c30076). Each case below was
 * accepted by core there and failed, or was silently changed, in storage.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const NOW = new Date('2026-09-24T10:00:00Z')
const rules = (vs: ReadonlyArray<Violation>) => vs.map((v) => v.rule)
const spec = (name: string) => categorySchemaOf(CBR).fields.find((f) => f.name === name)!

describe('N1 — a ratio carries no more decimals than its column (DECIMAL(12,6))', () => {
  it('declares the bound', () => {
    expect(RATIO_MAX_DECIMALS).toBe(6)
  })

  it.each([
    [4e-7, ['excess-precision']],
    [0.14300000000000002, ['excess-precision']],
    [0.143, []],
    [0.000001, []],
    [99.999999, []],
  ] as const)('%d → %j', (value, expected) => {
    expect(rules(validateFieldValue(spec('securedOutstandingToLimitRatio'), value))).toEqual(expected)
  })
})

describe('N2 — a string never exceeds the column it is stored in', () => {
  it('section is at most 20 characters (varchar(20)): a longer pbi-n is refused by core, not by the database', () => {
    expect(rules(validateFieldValue(spec('section'), 'pbi-' + '9'.repeat(16)))).toEqual([])
    expect(rules(validateFieldValue(spec('section'), 'pbi-' + '9'.repeat(17)))).toEqual(['max-length'])
    const x = validateAdapterExtraction(
      CBR,
      { instanceKey: 'k', values: { section: 'pbi-' + '1'.repeat(30), subjectRole: 'party', subjectName: 'Example' } },
      { enumMembership: 'skip', now: NOW },
    )
    expect(rules(x.violations)).toContain('max-length')
  })
})

describe('N4 — the currency headings real statements print', () => {
  it.each([
    ["RM'm", 1000000],
    ['RM Mil.', 1000000],
    ["RM'000'000", 1000000],
    ["RM('000)", 1000],
    ['RM (000)', 1000],
    ['RM thousand', 1000],
    ['RM`000', 1000],
    ['Ringgit Malaysia', 1],
  ] as const)('%j → MYR ×%d', (printed, scale) => {
    expect(parseCurrencyHeading(printed)).toEqual({ ok: true, code: 'MYR', scale })
  })

  it.each(['RM k', 'RM m', 'RM bn', "RM'00", 'RM (00)', 'RM thousands of', "RM'000'00", 'RM Mil..'])(
    '%j is still refused, never guessed',
    (printed) => {
      expect(parseCurrencyHeading(printed).ok).toBe(false)
    },
  )
})
