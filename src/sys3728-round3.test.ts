import { describe, it, expect } from 'vitest'
import { buildCategoryRegistry, categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory } from './adapter-categories.js'
import {
  isSerializedStructure,
  normalizePrintedText,
  parseListValue,
  prepareExtractionForWrite,
  validateAdapterExtraction,
  validateCanonicalFields,
  validateFieldValue,
} from './canonical-validation.js'
import type { Violation } from './canonical-validation.js'
import { minorUnitsOf, parseCurrencyHeading } from './currency.js'
import categoriesData from './data/adapter-categories.json' with { type: 'json' }

/**
 * Third adversarial review (at a991654). Each refusal below was
 * ACCEPTED there — stored different from what was validated, or not refused at
 * all — and each acceptance is a real-shaped value round 2 refused.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
/** The frozen clock every date bound here is measured against. */
const NOW = new Date('2026-09-24T10:00:00Z')
const rules = (vs: ReadonlyArray<Violation>) => vs.map((v) => v.rule)
const spec = (c: AdapterCategory, name: string) => categorySchemaOf(c).fields.find((f) => f.name === name)!
/** A principal subject that carries its identity, so only the rule under test can fire. */
const PRINCIPAL = { section: 'ccris', subjectRole: 'principal', subjectName: 'Example Sdn Bhd', subjectRegistrationNo: '201901000001' }
const cbrX = (values: Record<string, unknown>) =>
  validateAdapterExtraction(CBR, { instanceKey: 'k', values }, { enumMembership: 'skip', now: NOW })

// ── 3. Stored equals validated: precision and integer bounds ─────────

describe('finding 3 — a money value carries no more decimals than its currency, and a count fits its INT column', () => {
  it('money with three decimals is refused (excess-precision), never rounded — field and list item alike', () => {
    expect(rules(validateFieldValue(spec(CBR, 'securedOutstandingBalance'), 1234.567))).toEqual(['excess-precision'])
    expect(rules(validateFieldValue(spec(CBR, 'securedOutstandingBalance'), 1234.56))).toEqual([])
    const facility = JSON.stringify([{ accountNo: '1', balance: 0.001 }])
    expect(validateFieldValue(spec(CBR, 'outstandingCreditFacilities'), facility)).toEqual([
      { field: 'outstandingCreditFacilities', item: 0, key: 'balance', rule: 'excess-precision' },
    ])
  })

  it('a currency with no minor unit (VND) carries no decimals at all; MYR carries two', () => {
    expect(minorUnitsOf('VND')).toBe(0)
    expect(minorUnitsOf('MYR')).toBe(2)
    expect(minorUnitsOf('XXX')).toBe(2)
    const period = (currency: string, v: number) =>
      rules(
        validateAdapterExtraction(MA, {
          instanceKey: 'm',
          values: { companyName: 'Example' },
          periods: [{ position: 1, values: { mgmtCurrency: currency, mgmtTotalAssets: v } }],
        }, { now: NOW }).violations,
      )
    expect(period('VND', 1000.5)).toEqual(['excess-precision'])
    expect(period('VND', 1000)).toEqual([])
    expect(period('MYR', 1000.5)).toEqual([])
  })

  it('money magnitude stays inside DECIMAL(18,2): the 1e15 cap is below its 9,999,999,999,999,999.99', () => {
    expect(rules(validateFieldValue(spec(CBR, 'securedOutstandingBalance'), 1e15))).toEqual([])
    expect(rules(validateFieldValue(spec(CBR, 'securedOutstandingBalance'), 1e15 + 1))).toEqual(['unsafe-magnitude'])
    expect(1e15).toBeLessThan(9_999_999_999_999_999.99)
  })

  it('every count of the credit-bureau report is bounded by its INT column', () => {
    const counts = categorySchemaOf(CBR).fields.filter((f) => f.unit === 'count')
    expect(counts.length).toBe(21)
    for (const f of counts) {
      expect(f.range, f.name).toEqual([0, 2147483647])
      expect(rules(validateFieldValue(f, 2147483648)), f.name).toEqual(['out-of-range'])
      expect(rules(validateFieldValue(f, 2147483647)), f.name).toEqual([])
    }
  })
})

// ── 4. Line breaks ────────────────────────────────────────────────────

describe('finding 4 — a short value is one line; a long value keeps its lines as "\\n"', () => {
  it('normalizePrintedText collapses a line break in short text to one space', () => {
    expect(normalizePrintedText('SYNTHETIC TRADING\nSDN BHD')).toBe('SYNTHETIC TRADING SDN BHD')
    expect(normalizePrintedText('SYNTHETIC TRADING \r\n SDN BHD')).toBe('SYNTHETIC TRADING SDN BHD')
    expect(normalizePrintedText('A B')).toBe('A B')
    expect(normalizePrintedText('1 JALAN EXAMPLE\r\n50000 KUALA LUMPUR', { longText: true })).toBe('1 JALAN EXAMPLE\n50000 KUALA LUMPUR')
    expect(normalizePrintedText('A\rB', { longText: true })).toBe('A\nB')
  })

  it('the write snapshot stores the collapsed form of a short field, and accepts a CRLF address as long text', () => {
    const r = prepareExtractionForWrite(CBR, {
      instanceKey: 'k',
      values: {
        ...PRINCIPAL,
        subjectName: 'SYNTHETIC TRADING\nSDN BHD',
        suitsAsDefendant: JSON.stringify([{ caseNo: 'A-1', subjectAddress: '1 JALAN EXAMPLE\r\n50000 KUALA LUMPUR' }]),
      },
    }, { now: NOW, enumMembership: 'skip' })
    expect(r.ok, JSON.stringify(r.violations)).toBe(true)
    if (!r.ok) return
    expect(r.snapshot.values).toMatchObject({ subjectName: 'SYNTHETIC TRADING SDN BHD' })
    const rows = JSON.parse((r.snapshot.values as Record<string, string>).suitsAsDefendant!)
    expect(rows[0].subjectAddress).toBe('1 JALAN EXAMPLE\n50000 KUALA LUMPUR')
  })

  it('a reader still refuses a stored line break in a short field (it never came through the writer)', () => {
    expect(rules(validateCanonicalFields(CBR, { subjectName: 'A\nB' }, { enumMembership: 'skip' }).violations)).toEqual(['control-characters'])
  })
})

// ── 6. Empty rows, empty instances, a principal's identity ────────────

describe('finding 6 — nothing is stored that says nothing, and a principal says who it is', () => {
  it('a list row with no non-empty cell is refused (empty-row)', () => {
    expect(validateFieldValue(spec(CBR, 'directorsAndOfficers'), JSON.stringify([{ name: 'A' }, {}]))).toEqual([
      { field: 'directorsAndOfficers', item: 1, rule: 'empty-row' },
    ])
    expect(rules(validateFieldValue(spec(CBR, 'directorsAndOfficers'), JSON.stringify([{ name: null }])))).toEqual(['empty-row'])
  })

  it('an instance whose values are all absent is refused, and so is a period with none of its own', () => {
    expect(rules(cbrX({}).violations)).toEqual(['empty-instance'])
    expect(rules(cbrX({ subjectName: null }).violations)).toEqual(['empty-instance'])
    const ma = validateAdapterExtraction(MA, {
      instanceKey: 'm',
      values: {},
      periods: [{ position: 1, values: { mgmtStatementsRead: 'BS' } }, { position: 2, values: {} }],
    }, { now: NOW })
    expect(ma.violations).toEqual([{ field: '(values)', period: 1, envelope: true, rule: 'empty-instance' }])
  })

  it('the principal subject needs a name and an identifier (missing-identity); a party does not', () => {
    expect(rules(cbrX(PRINCIPAL).violations)).toEqual([])
    const { subjectName: _n, ...noName } = PRINCIPAL
    expect(cbrX(noName).violations).toEqual([{ field: 'subjectName', rule: 'missing-identity' }])
    const { subjectRegistrationNo: _r, ...noId } = PRINCIPAL
    expect(cbrX(noId).violations).toEqual([{ field: 'subjectNewIcNo', rule: 'missing-identity' }])
    expect(rules(cbrX({ ...noId, subjectIcPassportNo: 'A1234567' }).violations)).toEqual([])
    expect(rules(cbrX({ section: 'pbi-1', subjectRole: 'party', bureauScore: 700 }).violations)).toEqual([])
  })

  it('the requirement is declared in the registry, and the loader refuses a malformed one', () => {
    expect(categorySchemaOf(CBR).requiredAnyOf?.every((g) => g.identity && g.when?.field === 'subjectRole')).toBe(true)
    const base = categoriesData as { schemaVersion: string; categories: Array<Record<string, unknown>> }
    const withGroup = (group: unknown) => ({
      ...base,
      categories: base.categories.map((c) => (c.id === 'credit-bureau-report' ? { ...c, requiredAnyOf: [group] } : c)),
    })
    expect(() => buildCategoryRegistry(withGroup({ anyOf: ['noSuchField'] }) as never)).toThrow(/not a field/)
    expect(() => buildCategoryRegistry(withGroup({ anyOf: ['directorsAndOfficers'] }) as never)).toThrow(/is a list/)
    expect(() => buildCategoryRegistry(withGroup({ anyOf: ['subjectName'], when: { field: 'subjectRole' } }) as never)).toThrow(/when/)
    expect(() => buildCategoryRegistry(withGroup({ anyOf: ['subjectName'], extra: 1 }) as never)).toThrow(/unknown property/)
  })
})

// ── 7. Nesting depth ──────────────────────────────────────────────────

describe('finding 7 — list text nests at most four deep, checked before any parse', () => {
  it('a deeply nested list is malformed-list, with no RangeError however deep', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000)
    expect(parseListValue(deep)).toEqual({ rule: 'malformed-list' })
    expect(rules(validateFieldValue(spec(CBR, 'directorsAndOfficers'), deep))).toEqual(['malformed-list'])
    expect(parseListValue('[[[[[1]]]]]')).toEqual({ rule: 'malformed-list' })
    expect(parseListValue('[{"name":"[[[[[[x"}]')).toEqual({ rows: [{ name: '[[[[[[x' }] })
    // Unterminated text never loops past its end.
    expect(parseListValue('["abc')).toEqual({ rule: 'list-not-array' })
  })
})

// ── 8. A bracketed name is a name ─────────────────────────────────────

describe('finding 8 — structure detection refuses JSON, not a bracket', () => {
  it('"[ACME] SDN BHD" is accepted in a short field', () => {
    expect(rules(validateCanonicalFields(CBR, { subjectName: '[ACME] SDN BHD' }, { enumMembership: 'skip' }).violations)).toEqual([])
    expect(isSerializedStructure('[ACME] SDN BHD', false)).toBe(false)
  })

  it.each([
    ['a JSON array', '["ACME"]'],
    ['a JSON marker', '[ACME] "a":1'],
    ['a fullwidth marker', '[ACME] ＂a＂：1'],
    ['an object inside a sequence', '[ {"a":1} ]'],
    ['a truncated array', '[{"name":"x"'],
    ['a Python list', "['ACME']"],
    ['a JSON literal array', '[null, true]'],
  ])('%s in a short field is still structure', (_l, value) => {
    expect(isSerializedStructure(value, false)).toBe(true)
  })
})

// ── 2. The currency heading ───────────────────────────────────────────

describe('finding 2 — a statement heading names its currency and its scale', () => {
  it.each([
    ['RM', 'MYR', 1],
    ["RM'000", 'MYR', 1000],
    ["RM '000", 'MYR', 1000],
    ['RM’000', 'MYR', 1000],
    ['RM 000', 'MYR', 1000],
    ["(RM'000)", 'MYR', 1000],
    ['RM mil', 'MYR', 1000000],
    ['RM Million', 'MYR', 1000000],
    ["USD'000", 'USD', 1000],
  ] as const)('%j → %s ×%d', (printed, code, scale) => {
    expect(parseCurrencyHeading(printed)).toEqual({ ok: true, code, scale })
  })

  it.each(['RM k', 'RM m', "$'000", 'HK$', "RM'00", 'RM bn', '000'])('%j is refused, never guessed', (printed) => {
    expect(parseCurrencyHeading(printed).ok).toBe(false)
  })
})
