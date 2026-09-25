import { describe, it, expect } from 'vitest'
import { allCategories, buildCategoryRegistry, categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory, CanonicalFieldSpec } from './adapter-categories.js'
import {
  normalizeForWrite,
  prepareExtractionForWrite,
  validateAdapterExtraction,
  validateCanonicalFields,
  validateFieldValue,
} from './canonical-validation.js'
import type { Violation } from './canonical-validation.js'
import { buildFileFieldTablesFromInstances, buildFileFieldTablesFromView, instanceRowsFromView, INVALID_VALUE_TEXT } from './ihs-processing.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'

/**
 * Adversarial review: every input below was ACCEPTED by 36ccb84.
 * Each is now refused, by the rule named beside it.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
const SECRET = 'S3CRET-7d1e'
const rules = (vs: ReadonlyArray<Violation>) => vs.map((v) => v.rule)
const cbr = (fields: Record<string, unknown>) => rules(validateCanonicalFields(CBR, fields, { enumMembership: 'skip' }).violations)
const ma = (fields: Record<string, unknown>) => rules(validateCanonicalFields(MA, fields, { enumMembership: 'skip' }).violations)
const spec = (c: AdapterCategory, name: string): CanonicalFieldSpec => categorySchemaOf(c).fields.find((f) => f.name === name)!
const suit = (defendantAddress: unknown) => cbr({ suitsAsDefendant: [{ defendantAddress }] })

// ── B1: structure is keyed on the leading visible character ───────────

describe('B1 — a serialized structure is refused however it is spelled', () => {
  it.each([
    ['ZWSP-prefixed JSON', '\u200b[{"a":1}]', 'invisible-characters'],
    ['Python str(list)', "[{'name': 'ALI', 'designation': 'DIRECTOR'}]", 'serialized-structure'],
    ['a truncated array', '[{"name":"x"},{"name":"y"', 'serialized-structure'],
    ['a trailing comma', '[{"name":"x"},]', 'serialized-structure'],
    ['a JS object literal', '{name: "x"}', 'serialized-structure'],
    // Round 3: a leading bracket in a short field is structure only when it
    // parses as JSON, carries a JSON marker, or reads as a sequence.
    ['a bracketed sequence in a short field', '[1] Example Sdn Bhd', 'serialized-structure'],
    ['an unclosed leading bracket in a short field', '[Example Sdn Bhd', 'serialized-structure'],
    ['a JSON marker after a leading bracket', '[Example] {"a":1}', 'serialized-structure'],
    ['an empty object', '{}', 'serialized-structure'],
  ])('short field: %s', (_l, value, rule) => {
    expect(cbr({ subjectName: value })).toEqual([rule])
  })

  it.each([
    ['Python repr', "[{'address': '1 JALAN A'}]"],
    ['a truncated JSON array', '["1 JALAN A", "KL"'],
    ['an array of numbers', '[1, 2, 3]'],
    ['an empty array', '[]'],
    ['nested arrays', '[[1]]'],
    ['an object, any spelling', '{address: 1}'],
    ['an unterminated bracket', '[CANCELLED'],
  ])('long-text item: %s is refused', (_l, value) => {
    expect(suit(value)).toEqual(['serialized-structure'])
  })

  it.each([['[CANCELLED] Case withdrawn'], ['[REDACTED] 1 JALAN A, KUALA LUMPUR'], ['1 JALAN A [LOT 5]']])(
    'long-text item: a bracketed tag that is not a structure is allowed — %j',
    (value) => {
      expect(suit(value)).toEqual([])
    },
  )

  it('the same leading-character rule applies to string list items', () => {
    expect(ma({ mgmtTradeReceivablesItems: [{ term: "[{'a': 1}]" }] })).toEqual(['serialized-structure'])
  })
})

// ── B2: invisible and format characters ─────────────────────────────────

describe('B2 — invisible, format, private-use and unassigned characters are refused', () => {
  it.each([
    ['ZWSP U+200B', 'a\u200bb'], ['ZWNJ U+200C', 'a\u200cb'], ['ZWJ U+200D', 'a\u200db'], ['RLM U+200F', 'a\u200fb'],
    ['ALM U+061C', 'a\u061cb'], ['soft hyphen U+00AD', 'a\u00adb'], ['BOM mid-string U+FEFF', 'a\ufeffb'], ['word joiner U+2060', 'a\u2060b'],
    ['invisible times U+2062', 'a\u2062b'], ['interlinear anchor U+FFF9', 'a\ufff9b'], ['U+FFFB', 'a\ufffbb'],
    ['tag character U+E0041', 'a\u{E0041}b'], ['tag U+E0000', 'a\u{E0000}b'], ['noncharacter U+FFFE', 'a\ufffeb'],
    ['noncharacter U+FFFF', 'a\uffffb'], ['noncharacter U+FDD0', 'a\ufdd0b'], ['private use U+E000', 'a\ue000b'],
    ['supplementary private use', 'a\u{F0000}b'], ['Hangul filler U+3164', 'a\u3164b'], ['braille blank U+2800', 'a\u2800b'],
    ['halfwidth Hangul filler U+FFA0', 'a\uffa0b'], ['bidi override U+202E', 'a\u202eb'], ['bidi isolate U+2066', 'a\u2066b'],
  ])('%s', (_l, value) => {
    expect(cbr({ subjectName: value })).toEqual(['invisible-characters'])
  })

  it.each([['only ZWSP', '\u200b\u200b'], ['only U+3164', '\u3164'], ['only U+2800', '\u2800\u2800']])(
    'a value made only of invisible characters is refused: %s',
    (_l, value) => {
      expect(cbr({ subjectName: value })).toEqual(['invisible-characters'])
    },
  )

  it('blank means "no visible character", not merely whitespace', () => {
    expect(cbr({ subjectName: '\u00a0\u3000 \t' })).toEqual(['control-characters']) // tab in a short field
    // Second review: a non-ASCII space is refused as itself, wherever it is.
    expect(cbr({ subjectName: '\u00a0\u3000 ' })).toEqual(['non-ascii-space'])
    expect(cbr({ subjectName: '   ' })).toEqual(['blank-string'])
    // Punctuation is visible, but it is not a value (sys3728-airtight: placeholders).
    expect(cbr({ subjectName: '-' })).toEqual(['placeholder'])
    // A combining mark with no base: malformed text, not merely blank.
    expect(cbr({ subjectName: '\u0301' })).toEqual(['malformed-text'])
  })

  it('more than two stacked nonspacing marks is refused (second review tightened four to two); ordinary Thai and Vietnamese text is not', () => {
    expect(cbr({ subjectName: 'a\u0301\u0301\u0301\u0301\u0301' })).toEqual(['excessive-combining-marks'])
    expect(cbr({ subjectName: 'x\u0301\u0301\u0301' })).toEqual(['excessive-combining-marks'])
    expect(cbr({ subjectName: 'x\u0301\u0301' })).toEqual([])
    expect(cbr({ subjectName: 'บริษัท ตัวอย่าง จำกัด' })).toEqual([])
    expect(cbr({ subjectName: 'Công ty Ví dụ' })).toEqual([])
    expect(cbr({ subjectName: 'Cong\u0302\u0301 ty' })).toEqual([])
  })

  it('the same rules hold inside list items', () => {
    expect(ma({ mgmtTradeReceivablesItems: [{ term: 'a\u200bb' }] })).toEqual(['invisible-characters'])
    expect(ma({ mgmtTradeReceivablesItems: [{ term: '\u3164' }] })).toEqual(['invisible-characters'])
  })
})

// ── B3: validate what is stored ─────────────────────────────────────────

describe('B3 — the writer validates and persists the same plain-data snapshot', () => {
  const base = () => ({ instanceKey: 'k', values: { subjectName: 'Example Sdn Bhd' } as Record<string, unknown> })

  it('plain data round-trips to an identical snapshot', () => {
    const r = normalizeForWrite(base())
    expect(r).toEqual({ ok: true, snapshot: base() })
  })

  it('undefined members are dropped exactly as JSON drops them', () => {
    const r = normalizeForWrite({ ...base(), observedAt: undefined })
    expect(r.ok && r.snapshot).toEqual(base())
  })

  class Sneaky {
    toJSON() {
      return `[{"x":"${SECRET}"}]`
    }
  }

  it.each([
    ['a class instance with toJSON', () => ({ instanceKey: 'k', values: { subjectName: new Sneaky() } })],
    ['an array with its own toJSON', () => {
      const rows: unknown[] = [{ name: 'A' }]
      ;(rows as unknown as { toJSON: () => string }).toJSON = () => SECRET
      return { instanceKey: 'k', values: { directorsAndOfficers: rows } }
    }],
    ['a getter', () => {
      const values = {}
      Object.defineProperty(values, 'subjectName', { enumerable: true, get: () => `[${SECRET}]` })
      return { instanceKey: 'k', values }
    }],
    ['a sparse array', () => ({ instanceKey: 'k', values: { directorsAndOfficers: [{ name: 'A' }, , { name: 'B' }] } })],
    ['a Date', () => ({ instanceKey: 'k', values: {}, observedAt: new Date(0) })],
    ['a Map', () => ({ instanceKey: 'k', values: new Map() })],
    ['a function', () => ({ instanceKey: 'k', values: { subjectName: () => SECRET } })],
    ['a bigint', () => ({ instanceKey: 'k', values: { bureauScore: 1n } })],
    ['a symbol key', () => ({ instanceKey: 'k', values: { [Symbol('x')]: 1 } })],
    ['NaN (JSON would silently turn it into null)', () => ({ instanceKey: 'k', values: { bureauScore: Number.NaN } })],
    ['Infinity', () => ({ instanceKey: 'k', values: { securedOutstandingBalance: Number.POSITIVE_INFINITY } })],
    ['a cycle', () => {
      const values: Record<string, unknown> = {}
      values.self = values
      return { instanceKey: 'k', values }
    }],
    ['a non-plain prototype', () => ({ instanceKey: 'k', values: Object.create({ inherited: 1 }) })],
    ['an array with an extra own property', () => {
      const rows: unknown[] = [{ name: 'A' }]
      ;(rows as unknown as Record<string, unknown>).extra = SECRET
      return { instanceKey: 'k', values: { directorsAndOfficers: rows } }
    }],
    ['an Array subclass', () => {
      class Rows extends Array {}
      const rows = new Rows()
      rows.push({ name: 'A' })
      return { instanceKey: 'k', values: { directorsAndOfficers: rows } }
    }],
    ['nesting deeper than 32', () => {
      let deep: unknown = 'x'
      for (let i = 0; i < 40; i++) deep = [deep]
      return { instanceKey: 'k', values: { directorsAndOfficers: deep } }
    }],
  ])('refuses %s', (_l, make) => {
    const r = normalizeForWrite(make() as never)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations.map((v) => v.rule)).toEqual(['not-plain-data'])
      expect(JSON.stringify(r.violations)).not.toContain(SECRET)
    }
  })

  it('refuses when Object.prototype itself has been given a toJSON (prototype pollution)', () => {
    const proto = Object.prototype as unknown as { toJSON?: () => unknown }
    proto.toJSON = () => SECRET
    try {
      expect(normalizeForWrite(base()).ok).toBe(false)
    } finally {
      delete proto.toJSON
    }
  })

  it('prepareExtractionForWrite = snapshot then validate: it returns the SNAPSHOT to persist, only when valid', () => {
    const ok = prepareExtractionForWrite(CBR, base(), { enumMembership: 'skip' })
    expect(ok).toEqual({ ok: true, snapshot: base(), violations: [] })
    const bad = prepareExtractionForWrite(CBR, { instanceKey: 'k', values: { subjectName: new Sneaky() } } as never, { enumMembership: 'skip' })
    expect(bad.ok).toBe(false)
    expect('snapshot' in bad).toBe(false)
    // It validates the SNAPSHOT: a member JSON drops (undefined) is not there to refuse.
    expect(prepareExtractionForWrite(CBR, { ...base(), extra: undefined } as never, { enumMembership: 'skip' }).ok).toBe(true)
    const invalid = prepareExtractionForWrite(CBR, { instanceKey: 'k', values: { bureauScore: -1 } }, { enumMembership: 'skip' })
    expect(invalid).toEqual({ ok: false, violations: [{ field: 'bureauScore', rule: 'out-of-range' }] })
  })
})

// ── S1: numeric domains ────────────────────────────────────────────────

describe('S1 — numbers are held to their declared domain', () => {
  it.each([
    ['a negative count', 'bankingExistingFacilitiesCount', -5, 'out-of-range'],
    ['a fractional count', 'bankingExistingFacilitiesCount', 2.5, 'not-an-integer'],
    ['a count past 2^53', 'bankingExistingFacilitiesCount', 2 ** 53 + 2, 'not-an-integer'],
    ['a negative score', 'bureauScore', -999, 'out-of-range'],
    ['a fractional score with no declared range', 'bureauScore', 700.5, 'not-an-integer'],
    ['a score past 2^53', 'bureauScore', 2 ** 53 + 2, 'not-an-integer'],
    ['money of 1e308', 'securedOutstandingBalance', 1e308, 'unsafe-magnitude'],
    ['money of -1e16', 'securedOutstandingBalance', -1e16, 'unsafe-magnitude'],
    ['a ratio of 1e308', 'securedOutstandingToLimitRatio', 1e308, 'unsafe-magnitude'],
  ])('%s', (_l, field, value, rule) => {
    expect(cbr({ [field]: value })).toEqual([rule])
  })

  it('in-domain values pass, including a negative money amount and a ratio above 1 (declared)', () => {
    expect(cbr({ bankingExistingFacilitiesCount: 0, bureauScore: 712, securedOutstandingBalance: -1234.56, securedOutstandingToLimitRatio: 1.4 })).toEqual([])
    expect(cbr({ securedOutstandingBalance: 1e15 })).toEqual([])
  })

  it('a declared range is enforced (35 fields declare one)', () => {
    const t = 'telco-carrier' as AdapterCategory
    expect(rules(validateCanonicalFields(t, { onTimePaymentRatio24m: 1.2 }).violations)).toEqual(['out-of-range'])
    expect(rules(validateCanonicalFields(t, { onTimePaymentRatio24m: -0.1 }).violations)).toEqual(['out-of-range'])
    expect(rules(validateCanonicalFields(t, { onTimePaymentRatio24m: 0.97 }).violations)).toEqual([])
    const g = 'geolocation' as AdapterCategory
    // A score WITH a declared range is held to the range, not to integers.
    expect(rules(validateCanonicalFields(g, { addressMatchScore: 0.5 }).violations)).toEqual([])
    expect(rules(validateCanonicalFields(g, { addressMatchScore: 2 }).violations)).toEqual(['out-of-range'])
  })

  it('money list items are held to the same magnitude', () => {
    expect(ma({ mgmtTradeReceivablesItems: [{ amount: 1e308 }] })).toEqual(['unsafe-magnitude'])
  })
})

// ── S2: dates are calendar dates ───────────────────────────────────────

describe('S2 — a date must exist, and a start may not follow its end', () => {
  it.each([['9999-99-99'], ['2026-02-30'], ['2026-02-29'], ['2025-04-31'], ['0000-01-01'], ['2026-13-01'], ['2026-00-10']])(
    'mgmtPeriodEnd %s is not a date',
    (d) => {
      expect(ma({ mgmtPeriodEnd: d })).toEqual(['invalid-date'])
    },
  )

  it('a real date passes, a leap day included', () => {
    expect(ma({ mgmtPeriodEnd: '2024-02-29', mgmtPeriodStart: '2024-01-01' })).toEqual([])
  })

  it.each([['0000'], ['20255'], ['25']])('mgmtPeriodYear %s is not a year', (y) => {
    expect(ma({ mgmtPeriodYear: y })).toEqual(['invalid-date'])
  })

  it('a period start after its end is refused, on the fields and on periods[]', () => {
    expect(ma({ mgmtPeriodStart: '2025-12-31', mgmtPeriodEnd: '2025-01-01' })).toEqual(['date-order'])
    const r = validateAdapterExtraction(MA, { instanceKey: 'm', values: {}, periods: [{ position: 1, start: '2025-12-31', end: '2025-01-01', values: { mgmtStatementsRead: 'BS' } }] })
    expect(rules(r.violations)).toEqual(['date-order'])
  })

  it.each([['2026-09-23T24:00:00Z'], ['2026-02-30T10:00:00Z'], ['2026-09-23T10:60:00Z'], ['2026-09-23T10:00:61Z'], ['2026-09-23T10:00:00+15:00']])(
    'observedAt %s is not an instant',
    (observedAt) => {
      expect(rules(validateAdapterExtraction(CBR, { instanceKey: 'k', values: { section: 'pbi-1' }, observedAt }).violations)).toEqual(['invalid-observed-at'])
    },
  )

  it('a period position is at most the category\'s declared period count', () => {
    expect(categorySchemaOf(MA).maxPeriods).toBe(3)
    const p = (position: number) => rules(validateAdapterExtraction(MA, { instanceKey: 'm', values: {}, periods: [{ position, values: { mgmtStatementsRead: 'BS' } }] }).violations)
    expect(p(3)).toEqual([])
    expect(p(4)).toEqual(['invalid-period'])
    // A category that declares no count still caps positions at a small number.
    const fs = 'financial-statement' as AdapterCategory
    expect(rules(validateAdapterExtraction(fs, { instanceKey: 'f', values: {}, periods: [{ position: 101, values: { currency: 'MYR' } }] }).violations)).toEqual(['invalid-period'])
  })

  it('the loader refuses a bad format or order declaration', () => {
    const raw = (fields: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
      ({ schemaVersion: '1', categories: [{ id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', fields, ...extra }] }) as never
    expect(() => buildCategoryRegistry(raw([{ name: 'a', type: 'number', format: 'date', description: 'd' }]))).toThrow(/format.*string/)
    expect(() => buildCategoryRegistry(raw([{ name: 'a', type: 'string', format: 'time', description: 'd' }]))).toThrow(/format "time"/)
    expect(() => buildCategoryRegistry(raw([{ name: 'a', type: 'string', format: 'date', pattern: 'x', description: 'd' }]))).toThrow(/format.*pattern/)
    expect(() => buildCategoryRegistry(raw([{ name: 'a', type: 'string', format: 'date', notAfter: 'b', description: 'd' }]))).toThrow(/notAfter "b"/)
    expect(() => buildCategoryRegistry(raw([{ name: 'a', type: 'string', notAfter: 'b', description: 'd' }, { name: 'b', type: 'string', format: 'date', description: 'd' }]))).toThrow(/notAfter.*format "date"/)
    expect(() => buildCategoryRegistry(raw([{ name: 'a', type: 'string', description: 'd' }], { maxPeriods: 0 }))).toThrow(/maxPeriods/)
  })
})

// ── S3 / S4: the instance key ──────────────────────────────────────────

describe('S3/S4 — the instance key is visible text, trimmed, and never rendered when it is not', () => {
  const key = (instanceKey: unknown) => rules(validateAdapterExtraction(CBR, { instanceKey, values: { section: 'pbi-1' } }).violations)

  it.each([
    ['a tab', 'a\tb'], ['a newline', 'a\nb'], ['a lone surrogate', 'a\ud800b'], ['a ZWSP', 'a\u200bb'],
    ['leading whitespace', ' key'], ['trailing whitespace', 'key '], ['a Hangul filler', '\u3164'], ['a bidi override', 'k\u202e'],
  ])('refuses %s', (_l, instanceKey) => {
    expect(key(instanceKey)).toEqual(['invalid-instance-key'])
  })

  it('an ordinary key and the empty single-cardinality key pass', () => {
    expect(key(`experianReport:${'a'.repeat(64)}#pbi-2`)).toEqual([])
    expect(key('')).toEqual([])
  })

  it('observedAt is checked as a calendar instant (pins the check the regex alone cannot make)', () => {
    expect(rules(validateAdapterExtraction(CBR, { instanceKey: 'k', values: { section: 'pbi-1' }, observedAt: '2026-02-31T00:00:00Z' }).violations)).toEqual(['invalid-observed-at'])
    expect(validateAdapterExtraction(CBR, { instanceKey: 'k', values: { section: 'pbi-1' }, observedAt: '2026-09-23T10:00:00.123+08:00' }).ok).toBe(true)
  })
})

// ── S3 / S5: read side ─────────────────────────────────────────────────

describe('S3/S5 — read paths never pass a violating value through for a constrained category', () => {
  const h = (c: string) => c.repeat(64)
  const inst = (instanceKey: string, values: Record<string, unknown>, extra: Partial<CanonicalInstance> = {}): CanonicalInstance => ({
    instanceKey, adapterId: 'f', adapterVersion: 1,
    fields: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value: value as string, confidentiality: 'internal', origin: 'extraction' }])),
    ...extra,
  })
  const view = (instances: CanonicalInstance[]): CanonicalView => ({
    ihsId: 1,
    categories: {
      'document-intake': { cardinality: 'multi', instances: [inst('experianReports#1', { documentType: 'experianReports', pathInDms: `https://dms.example/x/${h('a')}`, uploadedAt: '2026-09-01T00:00:00.000Z' })] },
      [CBR]: { cardinality: 'multi', instances },
    },
  })

  it('instanceRowsFromView: a violating value is null and named in invalidFields; a valid row carries no flag', () => {
    const rows = instanceRowsFromView(view([
      inst(`experianReport:${h('a')}#ccris`, { section: 'ccris', subjectName: `[{"x":"${SECRET}"}]`, bureauScore: -5 }),
      inst(`experianReport:${h('a')}#pbi-1`, { section: 'pbi-1', subjectName: 'Person A', bureauScore: 700 }),
    ]), CBR)
    expect(rows[0]).toMatchObject({ subjectName: null, bureauScore: null, invalidFields: { subjectName: ['serialized-structure'], bureauScore: ['out-of-range'] } })
    expect(rows[1]).toMatchObject({ subjectName: 'Person A', bureauScore: 700 })
    expect(rows[1]!.invalidFields).toBeUndefined()
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  it('a table never renders an invalid instance key or source label', () => {
    const v = view([inst(`${SECRET}\u202e`, { section: 'ccris', bureauScore: 1 }, { sourceLabel: `${SECRET}\u200b` })])
    const t = buildFileFieldTablesFromView(v)['credit_bureau_reports']!
    expect(JSON.stringify(t)).not.toContain(SECRET)
    expect(t.items[0]!.timePeriods).toEqual([expect.stringMatching(/^T\d+$/)])
  })

  it('an unnamed subject with an invalid key and no period is labeled as invalid, not with the key', () => {
    // A non-integer coordinate gives the row no period, so its label would
    // fall back to the instance key.
    const v = view([inst(`${SECRET}\u200b`, { bureauScore: 1 }, { periodPosition: 2.5 })])
    const t = buildFileFieldTablesFromView(v)['credit_bureau_reports']!
    expect(t.items[0]!.timePeriods).toEqual([`${INVALID_VALUE_TEXT} 1`])
    expect(JSON.stringify(t)).not.toContain(SECRET)
  })

  it('the override path guards on its own, for rows that did not come through instanceRowsFromView', () => {
    const t = buildFileFieldTablesFromInstances(
      { g: [{ instanceKey: 'x', timePeriod: 'T1', subjectName: `[{"x":"${SECRET}"}]` }] },
      undefined,
      { g: { displayName: 'G', baseColumnNames: ['subjectName'], fieldSpecs: { subjectName: spec(CBR, 'subjectName') } } },
    )['g']!.items[0]!
    expect(t.data).toEqual({ T1: null })
    expect(t.invalid).toEqual({ T1: ['serialized-structure'] })
    expect(JSON.stringify(t)).not.toContain(SECRET)
  })

  it('invalidFields cannot collide with a field: no category declares a field of that name', () => {
    expect(allCategories().flatMap((c) => c.fields.map((f) => f.name as string))).not.toContain('invalidFields')
  })

  it('the read-side value in a table and in a row agree (both null for the same violation)', () => {
    const v = view([inst(`experianReport:${h('a')}#ccris`, { section: 'ccris', subjectName: 'Co', corporationName: 'a\u200bb' })])
    const row = instanceRowsFromView(v, CBR)[0]!
    const item = buildFileFieldTablesFromView(v)['credit_bureau_reports']!.items.find((i) => i.displayName === 'Corporation Name')!
    expect(row.corporationName).toBeNull()
    expect(Object.values(item.data)).toEqual([null])
    expect(Object.values(item.formattedData)).toEqual([INVALID_VALUE_TEXT])
  })
})

// ── S7: behavioral, not prose ──────────────────────────────────────────

describe('S7 — no string field accepts structure, including the three known debts', () => {
  it('every non-list string field of every category refuses a serialized array', () => {
    for (const c of allCategories()) {
      for (const f of c.fields.filter((x) => x.type === 'string')) {
        const r = rules(validateFieldValue(f, '[{"a":1}]', { enumMembership: 'skip' }))
        // A currency field refuses it as not-a-code first — a refusal either way.
        expect(r.length, `${c.id}.${f.name}`).toBe(1)
      }
    }
  })

  it('the three company-profile fields that hold JSON today are refused like any other — they are not exempt', () => {
    const cp = 'company-profile' as AdapterCategory
    for (const name of ['directors', 'shareholders', 'previousDirectors']) {
      expect(rules(validateFieldValue(spec(cp, name), '[{"officer-name":{"value":"A"}}]')), name).toEqual(['serialized-structure'])
    }
  })
})
