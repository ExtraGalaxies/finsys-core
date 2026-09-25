import { describe, it, expect } from 'vitest'
import { buildCategoryRegistry, categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory, CanonicalFieldSpec } from './adapter-categories.js'
import {
  isSerializedStructure,
  normalizePrintedText,
  prepareExtractionForWrite,
  validateAdapterExtraction,
  validateCanonicalFields,
  validateFieldValue,
  LIST_TEXT_MAX_LENGTH,
} from './canonical-validation.js'
import type { ValidationOptions, Violation } from './canonical-validation.js'

/**
 * Second adversarial review (at 000ab42). Every refused input below
 * was ACCEPTED there; every accepted one is real-shaped data the tightened
 * rules must not refuse. The operator's standard, verbatim: "this data is
 * highly sensitive. you can't just spew anything into these slots. the
 * validation must be air tight" — and "also consider jurisdiction and currency
 * symbols".
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
/** The frozen clock every date bound here is measured against. */
const NOW = new Date('2026-09-24T10:00:00Z')
const rules = (vs: ReadonlyArray<Violation>) => vs.map((v) => v.rule)
const cbr = (fields: Record<string, unknown>, opts: ValidationOptions = {}) =>
  rules(validateCanonicalFields(CBR, fields, { enumMembership: 'skip', now: NOW, ...opts }).violations)
const ma = (fields: Record<string, unknown>, opts: ValidationOptions = {}) =>
  rules(validateCanonicalFields(MA, fields, { enumMembership: 'skip', now: NOW, ...opts }).violations)
const spec = (c: AdapterCategory, name: string): CanonicalFieldSpec => categorySchemaOf(c).fields.find((f) => f.name === name)!
const item = (c: AdapterCategory, list: string, name: string) => spec(c, list).items!.find((i) => i.name === name)!

// ── 1. Every exported validator judges a plain-data snapshot ──────────

describe('finding 1 — no exported validator judges an object that can answer twice', () => {
  const flipping = () => {
    let reads = 0
    return {
      get subjectName() {
        reads++
        return reads === 1 ? 'Example Sdn Bhd' : '[{"a":1}]'
      },
    }
  }

  it('validateCanonicalFields: a getter is not plain data', () => {
    expect(cbr(flipping())).toEqual(['not-plain-data'])
  })

  it('validateCanonicalFields: a toJSON is not plain data', () => {
    const fields = { subjectName: 'Example Sdn Bhd', toJSON: () => ({ subjectName: '[{"a":1}]' }) }
    expect(cbr(fields)).toEqual(['not-plain-data'])
  })

  it('validateAdapterExtraction: a getter or a toJSON anywhere in the extraction is not plain data', () => {
    expect(rules(validateAdapterExtraction(CBR, { instanceKey: 'k', values: flipping() }).violations)).toEqual(['not-plain-data'])
    const values = { subjectName: 'Example Sdn Bhd', toJSON: () => ({}) }
    expect(rules(validateAdapterExtraction(CBR, { instanceKey: 'k', values }).violations)).toEqual(['not-plain-data'])
  })

  it('validateFieldValue: a list whose array carries a toJSON is not plain data', () => {
    const rows = Object.assign([{ name: 'Ali' }], { toJSON: () => '[{"a":1}]' })
    expect(rules(validateFieldValue(spec(CBR, 'directorsAndOfficers'), rows))).toEqual(['not-plain-data'])
  })
})

// ── 2. Structure detection ────────────────────────────────────────────

describe('finding 2 — structure is found behind marks, quotes and lookalike brackets', () => {
  it.each([
    ['a leading combining mark before an array', '\u0301[{"a":1}]', 'malformed-text'],
    ['a leading combining mark before an object', '\u0301{"a":1}', 'malformed-text'],
    ['a double-encoded JSON array', JSON.stringify('[{"a":1}]'), 'serialized-structure'],
    ['a double-encoded JSON object', JSON.stringify('{"a":1}'), 'serialized-structure'],
    ['a triple-encoded JSON array', JSON.stringify(JSON.stringify('[{"a":1}]')), 'serialized-structure'],
    ['fullwidth brackets', '\uff3b\uff5b"a":1\uff5d\uff3d', 'serialized-structure'],
    ['a fullwidth brace', '\uff5b"a":1\uff5d', 'serialized-structure'],
    ['a small-form brace', '\ufe5b"a":1\ufe5c', 'serialized-structure'],
  ])('%s is refused', (_l, value, rule) => {
    expect(cbr({ subjectName: value })).toEqual([rule])
  })

  it('the structure rule stands on its own: it looks past marks and invisibles itself, not only because the text rules ran first', () => {
    expect(isSerializedStructure('\u0301[{"a":1}]', false)).toBe(true)
    expect(isSerializedStructure('\u200b\u034f{"a":1}', true)).toBe(true)
    expect(isSerializedStructure('\u0301 \uff3b1, 2\uff3d', true)).toBe(true)
    expect(isSerializedStructure('\u0301Example', false)).toBe(false)
  })

  it('a quoted value that is not structure is not mistaken for it', () => {
    expect(cbr({ subjectName: '"Example" Trading' })).toEqual([])
  })

  it('long text: a fullwidth-bracketed sequence is refused like an ASCII one; a tag is still allowed', () => {
    const suit = (defendantAddress: string) => cbr({ suitsAsDefendant: [{ defendantAddress }] })
    expect(suit('\uff3b1, 2\uff3d')).toEqual(['serialized-structure'])
    expect(suit('[CANCELLED] Case withdrawn')).toEqual([])
  })
})

// ── 3. Invisible, lookalike and non-canonical text ────────────────────

describe('finding 3 — every default-ignorable code point is refused', () => {
  it.each([
    ['combining grapheme joiner U+034F', 'a\u034fb'],
    ['variation selector-16 U+FE0F', 'a\ufe0fb'],
    ['variation selector-1 U+FE00', 'a\ufe00b'],
    ['variation selector-17 U+E0100', 'a\u{E0100}b'],
    ['variation selector-256 U+E01EF', 'a\u{E01EF}b'],
    ['Mongolian free variation selector U+180B', 'a\u180bb'],
    ['Mongolian FVS U+180F', 'a\u180fb'],
    ['Khmer inherent vowel U+17B4', 'a\u17b4b'],
    ['Khmer inherent vowel U+17B5', 'a\u17b5b'],
    ['Hangul choseong filler U+115F', 'a\u115fb'],
    ['Hangul jungseong filler U+1160', 'a\u1160b'],
  ])('%s', (_l, value) => {
    expect(cbr({ subjectName: value })).toEqual(['invisible-characters'])
  })
})

describe('finding 3 — spacing, trimming and normalization', () => {
  it.each([
    ['no-break space U+00A0', 'ALI\u00a0BIN ABU'],
    ['em space U+2003', 'ALI\u2003BIN ABU'],
    ['en quad U+2000', 'ALI\u2000BIN ABU'],
    ['hair space U+200A', 'ALI\u200aBIN ABU'],
    ['narrow no-break space U+202F', 'ALI\u202fBIN ABU'],
    ['medium mathematical space U+205F', 'ALI\u205fBIN ABU'],
    ['ideographic space U+3000', '陈\u3000大文'],
    ['Ogham space mark U+1680', 'ALI\u1680ABU'],
  ])('a non-ASCII space inside a value is refused: %s', (_l, value) => {
    expect(cbr({ subjectName: value })).toEqual(['non-ascii-space'])
  })

  it.each([
    ['a leading space', ' ALI BIN ABU'],
    ['a trailing space', 'ALI BIN ABU '],
    ['a trailing newline in long text', '1 JALAN A\n'],
  ])('%s is refused — a writer stores the trimmed text', (_l, value) => {
    const field = value.includes('\n') ? { suitsAsDefendant: [{ defendantAddress: value }] } : { subjectName: value }
    expect(cbr(field)).toEqual(['untrimmed'])
  })

  it('NFD text is accepted and STORED as NFC — the snapshot is what is validated and persisted', () => {
    const nfd = 'Nguye\u0302\u0303n Thi\u0323 Minh Khai'
    expect(nfd).not.toBe(nfd.normalize('NFC'))
    expect(cbr({ subjectName: nfd })).toEqual([])
    const r = prepareExtractionForWrite(CBR, { instanceKey: 'k', values: { subjectName: nfd } }, { now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.snapshot.values as Record<string, string>).subjectName).toBe(nfd.normalize('NFC'))
  })

  it('NFC reaches inside a JSON-string list too', () => {
    const r = prepareExtractionForWrite(
      CBR,
      { instanceKey: 'k', values: { directorsAndOfficers: JSON.stringify([{ name: 'Tra\u0302\u0300n' }]) } },
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.snapshot.values as Record<string, string>).directorsAndOfficers).toBe('[{"name":"Trần"}]')
  })

  it('NFC reaches a list whose JSON spells the marks as \\u escapes (ASCII text)', () => {
    const r = prepareExtractionForWrite(
      CBR,
      { instanceKey: 'k', values: { directorsAndOfficers: '[{"name":"Tra\\u0302\\u0300n"}]' } },
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.snapshot.values as Record<string, string>).directorsAndOfficers).toBe('[{"name":"Tr\u1ea7n"}]')
  })

  it('more than two stacked nonspacing marks on one base is refused', () => {
    expect(cbr({ subjectName: 'x\u0301\u0301\u0301' })).toEqual(['excessive-combining-marks'])
    expect(cbr({ subjectName: 'x\u0301\u0301' })).toEqual([])
  })
})

// ── 4a. Identifiers and placeholders ──────────────────────────────────

describe('finding 4a — identifiers are ASCII, and Malaysian ones are shaped as Malaysian', () => {
  it.each([
    ['fullwidth digits', '\uff18\uff19\uff10\uff11\uff10\uff11-\uff11\uff14-\uff15\uff16\uff17\uff18'],
    ['Arabic-Indic digits', '\u0668\u0669\u0660\u0661\u0660\u0661-\u0661\u0664-\u0665\u0666\u0667\u0668'],
    ['a space inside', '890101 14 5678'],
    ['a lookalike hyphen U+2010', '890101\u201014\u20105678'],
  ])('an identifier with %s is refused in every jurisdiction', (_l, value) => {
    expect(cbr({ subjectNewIcNo: value })).toEqual(['pattern-mismatch'])
    expect(cbr({ subjectIcPassportNo: value })).toEqual(['pattern-mismatch'])
  })

  it('a new IC number is held to the NRIC shape under MY — and only under MY', () => {
    expect(cbr({ subjectNewIcNo: '890101-14-5678' }, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ subjectNewIcNo: '890101145678' }, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ subjectNewIcNo: '89010114567' }, { jurisdiction: 'MY' })).toEqual(['pattern-mismatch'])
    expect(cbr({ subjectNewIcNo: 'A1234567' }, { jurisdiction: 'MY' })).toEqual(['pattern-mismatch'])
    // Never Malaysia by default: an unproven jurisdiction gets the charset alone.
    expect(cbr({ subjectNewIcNo: '89010114567' })).toEqual([])
    expect(cbr({ subjectNewIcNo: '89010114567' }, { jurisdiction: null })).toEqual([])
    expect(cbr({ subjectNewIcNo: '89010114567' }, { jurisdiction: 'my' })).toEqual([])
  })

  it('the same NRIC rule holds on the bankruptcy new-IC column', () => {
    const b = (newIcNo: string, opts?: ValidationOptions) => cbr({ bankruptcyActions: [{ newIcNo }] }, opts)
    expect(b('890101-14-5678', { jurisdiction: 'MY' })).toEqual([])
    expect(b('8901011-4567', { jurisdiction: 'MY' })).toEqual(['pattern-mismatch'])
  })

  it('a field that can hold a passport number carries no NRIC pattern', () => {
    for (const name of ['subjectIcPassportNo', 'subjectProvidedIcPassportNo']) {
      expect(spec(CBR, name).jurisdictionPatterns, name).toBeUndefined()
    }
    expect(cbr({ subjectIcPassportNo: 'K12345678' }, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ subjectIcPassportNo: 'A1234567' }, { jurisdiction: 'MY' })).toEqual([])
  })

  it('a registration number accepts the "new (old)" print form and nothing looser', () => {
    expect(cbr({ subjectRegistrationNo: '201901012345 (1234567-A)' }, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ subjectRegistrationNo: '201901012345' })).toEqual([])
    expect(cbr({ subjectRegistrationNo: 'LLP0012345-LGN' })).toEqual([])
    expect(cbr({ subjectRegistrationNo: '201901012345 (1234567-A) x' })).toEqual(['pattern-mismatch'])
    expect(cbr({ subjectRegistrationNo: '2019 0101 2345' })).toEqual(['pattern-mismatch'])
  })
})

describe('finding 4a — a placeholder is not a value, in any string field', () => {
  it.each(['-', '–', '—', '.', '--', '...', '-/-', 'N/A', 'n/a', 'NA', 'n.a.', 'nil', 'NIL', 'null', 'NULL', 'None', 'see attached', 'SEE ATTACHED', '*', '?'])(
    '%j is refused',
    (value) => {
      expect(cbr({ subjectName: value })).toEqual(['placeholder'])
      expect(cbr({ creditApplications: [{ facility: value }] })).toEqual(['placeholder'])
      expect(ma({ mgmtTradeReceivablesItems: [{ term: value }] })).toEqual(['placeholder'])
    },
  )

  it('normalizePrintedText: the one reader-side rule — trimmed, NFC, ASCII-spaced, and absent for a placeholder', () => {
    expect(normalizePrintedText('  ALI\u00a0BIN\u3000ABU ')).toBe('ALI BIN ABU')
    expect(normalizePrintedText('Tra\u0302\u0300n')).toBe('Trần')
    expect(normalizePrintedText(' N/A ')).toBeUndefined()
    expect(normalizePrintedText('—')).toBeUndefined()
    expect(normalizePrintedText('   ')).toBeUndefined()
    expect(normalizePrintedText(42)).toBeUndefined()
  })
})

// ── 4b. Money in list rows ────────────────────────────────────────────

describe('finding 4b — money columns are numbers', () => {
  const money: Array<[string, string]> = [
    ['shareholdingInterests', 'paidUpCapital'],
    ['creditApplications', 'totalOutstandingBalanceRm'],
    ['creditApplications', 'limitRm'],
    ['specialAttentionAccounts', 'totalOutstandingBalanceRm'],
    ['specialAttentionAccounts', 'limitRm'],
    ['suitsAsDefendant', 'amountClaimed'],
    ['limitedDetailSuitsAsDefendant', 'amountClaimed'],
    ['suitsAsPlaintiff', 'amountClaimed'],
    ['windingUpActionsAsDefendant', 'amountClaimed'],
    ['windingUpActionsAsPetitioner', 'amountClaimed'],
    ['bankruptcyActions', 'amountClaimed'],
    ['tradeCreditReferences', 'amountDue'],
    ['nonBankLenderFacilities', 'limitRm'],
    ['nonBankLenderFacilities', 'instalmentAmountRm'],
    ['nonBankLenderFacilities', 'totalOutstandingBalanceRm'],
    ['outstandingCreditFacilities', 'accountLimit'],
    ['outstandingCreditFacilities', 'balance'],
    ['outstandingCreditFacilities', 'instalment'],
  ]

  it.each(money)('%s.%s is declared number / money', (list, name) => {
    expect(item(CBR, list, name)).toMatchObject({ type: 'number', kind: 'money' })
  })

  it.each(['RM 5,000,000.00', '5,000,000', 'MYR 5000', '$5000', 'USD 5000'])('a printed amount %j in a money column is refused', (value) => {
    expect(cbr({ creditApplications: [{ limitRm: value }] })).toEqual(['type-mismatch'])
  })

  it('a parsed amount passes, and is held to the magnitude bound', () => {
    expect(cbr({ creditApplications: [{ limitRm: 5_000_000 }] })).toEqual([])
    expect(cbr({ creditApplications: [{ limitRm: 1e16 }] })).toEqual(['unsafe-magnitude'])
  })
})

// ── 4c. Dates ─────────────────────────────────────────────────────────

describe('finding 4c — every date is ISO, real, and plausible against an injected clock', () => {
  it('the date-bearing fields and columns declare format "date"', () => {
    for (const name of ['reportOrderDate', 'corporationIncorporationDate']) expect(spec(CBR, name).format, name).toBe('date')
    for (const [list, name] of [
      ['outstandingCreditFacilities', 'approvalDate'],
      ['outstandingCreditFacilities', 'balanceUpdated'],
      ['creditApplications', 'date'],
      ['directorsAndOfficers', 'appointmentDate'],
      ['suitsAsDefendant', 'hearingDate'],
      ['bankruptcyActions', 'dischargeDate'],
      ['nonBankLenderFacilities', 'aprvDate'],
    ] as const) {
      expect(item(CBR, list, name).format, `${list}.${name}`).toBe('date')
    }
  })

  it.each([
    ['DD/MM/YYYY as printed', '01/01/2026', 'invalid-date'],
    ['a date that does not exist', '2026-02-31', 'invalid-date'],
    ['a date and time', '2026-01-01 09:00:00', 'invalid-date'],
    ['before 1900', '1899-12-31', 'implausible-date'],
    ['after tomorrow (UTC) on the frozen clock', '2026-09-26', 'implausible-date'],
  ])('%s is refused', (_l, value, rule) => {
    expect(cbr({ reportOrderDate: value })).toEqual([rule])
    expect(cbr({ outstandingCreditFacilities: [{ approvalDate: value }] })).toEqual([rule])
  })

  it('today and tomorrow (the time-zone day) pass; the bound follows the clock', () => {
    expect(cbr({ reportOrderDate: '2026-09-24' })).toEqual([])
    expect(cbr({ reportOrderDate: '2026-09-25' })).toEqual([])
    expect(cbr({ reportOrderDate: '2026-09-26' }, { now: new Date('2026-09-25T00:00:00Z') })).toEqual([])
  })

  it('a date that may lie ahead (a hearing, an expiry) is bounded by the horizon instead', () => {
    expect(cbr({ suitsAsDefendant: [{ hearingDate: '2030-01-15' }] })).toEqual([])
    expect(cbr({ suitsAsDefendant: [{ hearingDate: '2037-01-15' }] })).toEqual(['implausible-date'])
    expect(cbr({ suitsAsDefendant: [{ suitDate: '2030-01-15' }] })).toEqual(['implausible-date'])
  })

  it('a year is bounded the same way', () => {
    expect(ma({ mgmtPeriodYear: '1899' })).toEqual(['implausible-date'])
    expect(ma({ mgmtPeriodYear: '2026' })).toEqual([])
    expect(ma({ mgmtPeriodYear: '2040' })).toEqual(['implausible-date'])
  })
})

// ── 4d. Numbers ───────────────────────────────────────────────────────

describe('finding 4d — every bureau number has a declared domain', () => {
  it('bureauScore is 0..1000', () => {
    expect(spec(CBR, 'bureauScore').range).toEqual([0, 1000])
    expect(cbr({ bureauScore: 1001 })).toEqual(['out-of-range'])
    expect(cbr({ bureauScore: -1 })).toEqual(['out-of-range'])
    expect(cbr({ bureauScore: 712 })).toEqual([])
  })

  it('an outstanding-to-limit ratio is never negative and may exceed 1', () => {
    for (const name of ['securedOutstandingToLimitRatio', 'unsecuredOutstandingToLimitRatio']) {
      expect(spec(CBR, name).range, name).toEqual([0, 100])
      expect(cbr({ [name]: -0.01 })).toEqual(['out-of-range'])
      expect(cbr({ [name]: 100.01 })).toEqual(['out-of-range'])
      expect(cbr({ [name]: 1.4 })).toEqual([])
    }
  })
})

// ── 5. A list as JSON text ────────────────────────────────────────────

describe('finding 5 — a JSON-string list is bounded, unambiguous, and stored re-serialized', () => {
  it('text longer than the list ceiling is refused before it is parsed', () => {
    const huge = JSON.stringify([{ name: 'A'.repeat(200) }]).padEnd(LIST_TEXT_MAX_LENGTH + 1, ' ')
    expect(cbr({ directorsAndOfficers: huge })).toEqual(['max-length'])
  })

  it('a row object with a duplicated key is refused — two readers could read two values', () => {
    expect(cbr({ directorsAndOfficers: '[{"name":"x","name":"A"}]' })).toEqual(['duplicate-item-key'])
    expect(cbr({ directorsAndOfficers: '[{"name":"A","designation":"DIRECTOR"}]' })).toEqual([])
  })

  it('the snapshot stores the canonical re-serialization, never the caller\'s text', () => {
    const r = prepareExtractionForWrite(
      CBR,
      { instanceKey: 'k', values: { directorsAndOfficers: '[ {"name" : "A"} ]' } },
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.snapshot.values as Record<string, string>).directorsAndOfficers).toBe('[{"name":"A"}]')
  })
})

// ── 6. Management-account consistency ─────────────────────────────────

describe('finding 6 — a management account agrees with itself', () => {
  const extraction = (periods: Array<Record<string, unknown>>, values: Record<string, unknown> = {}) =>
    rules(validateAdapterExtraction(MA, { instanceKey: 'managementAccount:d', values, periods }, { enumMembership: 'skip', now: NOW }).violations)
  const p = (position: number, values: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ position, values, ...more })

  it('periods that disagree on currency are refused', () => {
    expect(extraction([p(1, { mgmtCurrency: 'MYR' }), p(2, { mgmtCurrency: 'USD' })])).toEqual(['currency-mismatch'])
    expect(extraction([p(1, { mgmtCurrency: 'MYR' })], { mgmtCurrency: 'SGD' })).toEqual(['currency-mismatch'])
    expect(extraction([p(1, { mgmtCurrency: 'MYR' }), p(2, { mgmtCurrency: 'MYR' })])).toEqual([])
  })

  it('money with no currency is refused — a scalar total or a list amount alike', () => {
    expect(extraction([p(1, { mgmtTotalAssets: 1000 })])).toEqual(['currency-missing'])
    expect(extraction([p(1, { mgmtCashAtBankItems: [{ term: 'CASH', amount: 10 }] })])).toEqual(['currency-missing'])
    expect(extraction([p(1, { mgmtTotalAssets: 1000, mgmtCurrency: 'MYR' })])).toEqual([])
    expect(extraction([p(1, { mgmtTotalAssets: 1000 })], { mgmtCurrency: 'MYR' })).toEqual([])
    // An amount printed but unreadable is not money; no currency is owed for it.
    expect(extraction([p(1, { mgmtCashAtBankItems: [{ term: 'CASH', amountAsPrinted: 'illegible' }] })])).toEqual([])
  })

  it('an envelope start / end that disagrees with the period\'s own fields is refused', () => {
    const v = { mgmtCurrency: 'MYR', mgmtPeriodStart: '2025-01-01', mgmtPeriodEnd: '2025-12-31' }
    expect(extraction([p(1, v, { start: '2025-01-01', end: '2025-12-31' })])).toEqual([])
    expect(extraction([p(1, v, { start: '2025-02-01' })])).toEqual(['period-mismatch'])
    expect(extraction([p(1, v, { end: '2025-11-30' })])).toEqual(['period-mismatch'])
  })

  it('a year that is not the year of the period end is refused', () => {
    expect(extraction([p(1, { mgmtCurrency: 'MYR', mgmtPeriodEnd: '2025-12-31', mgmtPeriodYear: '2025' })])).toEqual([])
    expect(extraction([p(1, { mgmtCurrency: 'MYR', mgmtPeriodEnd: '2025-12-31', mgmtPeriodYear: '2024' })])).toEqual(['period-mismatch'])
  })

  it('envelope period dates are bounded too', () => {
    expect(extraction([p(1, { mgmtCurrency: 'MYR' }, { end: '1800-12-31' })])).toEqual(['implausible-date'])
  })
})

// ── 7. Enum membership and instance keys ──────────────────────────────

describe('finding 7 — enum membership is exact, instance keys are not paths', () => {
  it('a manifest label set that is a string is not a label set', () => {
    const enumValues = { amlCftScreening: 'NOT MATCHED' as unknown as string[] }
    const r = validateCanonicalFields(CBR, { amlCftScreening: 'MATCHED' }, { enumValues, now: NOW })
    expect(rules(r.violations)).toEqual(['enum-labels-missing'])
  })

  it.each(['experianReport:abc/def#ccris', 'a\\b', '..', 'experianReport:..#ccris'])('instance key %j is refused', (instanceKey) => {
    expect(rules(validateAdapterExtraction(CBR, { instanceKey, values: { section: 'pbi-1' } }, { now: NOW }).violations)).toEqual(['invalid-instance-key'])
  })

  it('the keys writers actually mint still pass', () => {
    for (const instanceKey of [`experianReport:${'a'.repeat(64)}#pbi-12`, 'managementAccount:file-17', 'legacy:T1', 'line-mobile-1', '']) {
      expect(rules(validateAdapterExtraction(CBR, { instanceKey, values: { section: 'pbi-1' } }, { now: NOW }).violations), instanceKey).toEqual([])
    }
  })
})

// ── The positive corpus: an airtight validator that refuses real subjects fails too ──

describe('positive corpus — real-shaped (synthetic) Malaysian and regional data is accepted', () => {
  const names = [
    'MUHAMMAD HAFIZ BIN ABDUL RAHMAN',
    'Siti Nur Aisyah binti Mohd Yusof',
    "NUR 'AIN BINTI ZAKARIA",
    "D'ARCY ANAK JOHN",
    'TAN AH KOW',
    'Lim Mei-Ling',
    '陈大文',
    'LEE CHONG WEI @ LEE ZHONG WEI',
    'RAJESH A/L KRISHNAN',
    'KAVITHA A/P SUBRAMANIAM',
    'Muthusamy s/o Ramasamy',
    'Dr. Ahmad Faizal bin Hj. Othman',
    'Nguyễn Thị Minh Khai',
    'Trần Văn Đức',
    'สมชาย ใจดี',
    'กี่ มั่นคง',
    'முருகன் சுப்பிரமணியம்',
    'ஸ்ரீ லக்ஷ்மி',
  ]
  const companies = [
    'Example Trading Sdn. Bhd.',
    'EXAMPLE HOLDINGS BERHAD',
    'Contoh Maju (M) Sdn Bhd',
    'A & B Enterprise',
    'Kedai Runcit Ah Seng & Anak-Anak',
    'Syarikat Contoh (1995) Sdn. Bhd.',
    'Example (Malaysia) Sdn. Bhd. - Cawangan Pulau Pinang',
    '#1 Laundry Services',
  ]

  it.each([...names, ...companies])('%s', (name) => {
    expect(cbr({ subjectName: name }, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ directorsAndOfficers: [{ name, designation: 'DIRECTOR', appointmentDate: '2019-03-01' }] }, { jurisdiction: 'MY' })).toEqual([])
    expect(ma({ companyName: name })).toEqual([])
  })

  it('valid identifiers of every shape the reports print pass under MY', () => {
    const ok = {
      subjectNewIcNo: '890101-14-5678',
      subjectProvidedNewIcNo: '890101145678',
      subjectIcPassportNo: 'A1234567',
      subjectProvidedIcPassportNo: 'K12345678',
      subjectRegistrationNo: '201901012345 (1234567-A)',
      subjectProvidedRegistrationNo: '201901012345',
      reportOrderId: '111111111',
    }
    expect(cbr(ok, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ subjectRegistrationNo: '1234567-A' }, { jurisdiction: 'MY' })).toEqual([])
    expect(cbr({ subjectRegistrationNo: 'JM0123456-X' }, { jurisdiction: 'MY' })).toEqual([])
  })

  it('a whole realistic extraction passes the writer contract', () => {
    const r = prepareExtractionForWrite(
      CBR,
      {
        instanceKey: `experianReport:${'f'.repeat(64)}#ccris`,
        values: {
          section: 'ccris',
          subjectRole: 'principal',
          subjectName: 'Contoh Maju (M) Sdn Bhd',
          subjectRegistrationNo: '201901012345 (1234567-A)',
          reportOrderDate: '2026-09-01',
          bureauScore: 712,
          securedOutstandingToLimitRatio: 0.74,
          outstandingCreditFacilities: JSON.stringify([
            { accountNo: '1', approvalDate: '2019-03-01', accountLimit: 5_000_000, balance: 1_234_567.89, conduct12m: '0 0 0 0 0 0 0 0 0 0 0 0' },
          ]),
          suitsAsDefendant: JSON.stringify([{ caseNo: 'WA-22NCC-123-04/2021', amountClaimed: 150000, hearingDate: '2027-02-01' }]),
        },
      },
      { jurisdiction: 'MY', enumMembership: 'skip', now: NOW },
    )
    expect(r.violations).toEqual([])
  })
})

// ── The loader refuses a bad new declaration ──────────────────────────

describe('the loader refuses a malformed format, mayBeFuture or periodFields', () => {
  type Raw = Parameters<typeof buildCategoryRegistry>[0]
  const raw = (fields: Array<Record<string, unknown>>, more: Record<string, unknown> = {}): Raw =>
    ({
      schemaVersion: '1.0.0',
      categories: [{ id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', egressClass: 'contributable', ...more, fields: fields.map((f) => ({ description: 'd', ...f })) }],
    }) as unknown as Raw
  const list = (item: Record<string, unknown>) => [{ name: 'l', type: 'list', items: [{ name: 'c', displayName: 'C', ...item }] }]

  it('accepts the declarations the shipped registry uses', () => {
    const reg = buildCategoryRegistry(raw([
      { name: 's', type: 'string', format: 'date' },
      { name: 'e', type: 'string', format: 'date', mayBeFuture: true },
      { name: 'y', type: 'string', format: 'year' },
      { name: 'l', type: 'list', items: [{ name: 'c', displayName: 'C', type: 'string', format: 'date', mayBeFuture: true }, { name: 'n', displayName: 'N', type: 'string', pattern: '\\d+', jurisdictionPatterns: { MY: '\\d{12}' } }] },
    ], { periodFields: { start: 's', end: 'e', year: 'y' } }))
    expect(reg.all[0]!.periodFields).toEqual({ start: 's', end: 'e', year: 'y' })
    expect(reg.all[0]!.fields[3]!.items![0]).toMatchObject({ format: 'date', mayBeFuture: true })
  })

  it.each([
    ['mayBeFuture without a format', raw([{ name: 'f', type: 'string', mayBeFuture: true }]), /mayBeFuture without a format/],
    ['mayBeFuture not true', raw([{ name: 'f', type: 'string', format: 'date', mayBeFuture: 'yes' }]), /mayBeFuture/],
    ['an item format on a number', raw(list({ type: 'number', format: 'date' })), /only a string has one/],
    ['an item format beside a pattern', raw(list({ type: 'string', format: 'date', pattern: '\\d+' })), /format AND a pattern/],
    ['an item jurisdiction pattern for an unknown jurisdiction', raw(list({ type: 'string', jurisdictionPatterns: { ZZ: '\\d' } })), /jurisdiction registry/],
    ['periodFields naming no field', raw([{ name: 's', type: 'string', format: 'date' }], { periodFields: { start: 'nope' } }), /not a field this category declares/],
    ['periodFields with the wrong format', raw([{ name: 's', type: 'string', format: 'year' }], { periodFields: { start: 's' } }), /must be format "date"/],
    ['periodFields with an unknown role', raw([{ name: 's', type: 'string', format: 'date' }], { periodFields: { middle: 's' } }), /unknown property/],
    ['empty periodFields', raw([{ name: 's', type: 'string', format: 'date' }], { periodFields: {} }), /names no field/],
  ])('%s', (_l, data, message) => {
    expect(() => buildCategoryRegistry(data)).toThrow(message)
  })
})
