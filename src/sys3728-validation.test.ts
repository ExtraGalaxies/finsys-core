import { describe, it, expect } from 'vitest'
import { allCategories, buildCategoryRegistry, categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory, CanonicalFieldSpec } from './adapter-categories.js'
import {
  validateAdapterExtraction,
  validateCanonicalFields,
  validateFieldValue,
  STRING_MAX_LENGTH_DEFAULT,
  LIST_MAX_ITEMS_DEFAULT,
} from './canonical-validation.js'
import type { Violation } from './canonical-validation.js'
import { CURRENCY_CODES, normalizeCurrency, isAllowedCurrency } from './currency.js'
import { JURISDICTION_DISPLAY_CURRENCY } from './jurisdiction.js'

/**
 * SYS-3728 — the canonical write contract.
 *
 * The defect this exists for passed every check because the DECLARATION was
 * wrong: a JSON array is a perfectly valid string, so a field declared
 * `string` accepted a table. This file pins the rules that make a declaration
 * enforceable, and proves each one refuses what it claims to — while never
 * echoing the value it refused.
 */

const CBR = 'credit-bureau-report' as AdapterCategory
const MA = 'management-account' as AdapterCategory
const SECRET = 'S3CRET-VALUE-9f2c'

const rules = (vs: ReadonlyArray<Violation>) => vs.map((v) => v.rule)
const check = (category: AdapterCategory, fields: Record<string, unknown>, opts?: Parameters<typeof validateCanonicalFields>[2]) =>
  validateCanonicalFields(category, fields, { enumMembership: 'skip', ...opts })
const spec = (c: AdapterCategory, name: string): CanonicalFieldSpec => categorySchemaOf(c).fields.find((f) => f.name === name)!

/** Every violation list must be free of the value it describes. */
function noValues(vs: ReadonlyArray<Violation>): void {
  expect(JSON.stringify(vs)).not.toContain(SECRET)
}

const MA_ROW = { code: '1000-000', term: 'TRADE DEBTORS', amount: -1719587.11 }

// ── 1. The registry ────────────────────────────────────────────────────

describe('SYS-3728 — every field has an enforceable declaration', () => {
  const fields = allCategories().flatMap((c) => c.fields.map((f) => ({ c: c.id, f })))

  it('every string field, and every string list item, has an effective maxLength', () => {
    for (const { c, f } of fields) {
      if (f.type === 'string') expect(Number.isInteger(f.maxLength) && f.maxLength! >= 1, `${c}.${f.name}`).toBe(true)
      else expect(f.maxLength, `${c}.${f.name}`).toBeUndefined()
      for (const i of f.items ?? []) {
        if (i.type === 'string') expect(Number.isInteger(i.maxLength) && i.maxLength! >= 1, `${f.name}.${i.name}`).toBe(true)
        else expect(i.maxLength, `${f.name}.${i.name}`).toBeUndefined()
      }
    }
  })

  it('every list declares items and an effective maxItems; nothing else does', () => {
    for (const { f } of fields) {
      expect(f.items !== undefined, f.name).toBe(f.type === 'list')
      expect(f.maxItems !== undefined, f.name).toBe(f.type === 'list')
      if (f.type === 'list') expect(f.items!.length).toBeGreaterThan(0)
    }
  })

  it('the defaults are the declared defaults', () => {
    expect(STRING_MAX_LENGTH_DEFAULT).toBe(256)
    expect(LIST_MAX_ITEMS_DEFAULT).toBe(500)
    expect(spec(CBR, 'subjectName').maxLength).toBe(256)
    expect(spec(CBR, 'outstandingCreditFacilities').maxItems).toBe(500)
  })

  it('only these fields declare longer text, each for a stated reason', () => {
    const long = fields.filter(({ f }) => f.type === 'string' && f.maxLength! > STRING_MAX_LENGTH_DEFAULT).map(({ c, f }) => `${c}.${f.name}`)
    expect(long).toEqual([])
    const longItems = fields.flatMap(({ f }) =>
      (f.items ?? []).filter((i) => i.type === 'string' && i.maxLength! > STRING_MAX_LENGTH_DEFAULT).map((i) => `${f.name}.${i.name}=${i.maxLength}`),
    )
    expect(longItems.sort()).toEqual([
      'bankruptcyActions.creditors=1024', 'bankruptcyActions.defendantAddress=1024', 'bankruptcyActions.solicitorAddress=1024',
      'creditApplications.address=1024', 'limitedDetailSuitsAsDefendant.defendantAddress=1024',
      'limitedDetailSuitsAsDefendant.plaintiffAddress=1024', 'limitedDetailSuitsAsDefendant.solicitorAddress=1024',
      'limitedDetailSuitsAsDefendant.subjectAddress=1024', 'nonBankLenderFacilities.address=1024',
      'outstandingCreditFacilities.collateralDetail=1024', 'shareholdingInterests.activity=1024', 'shareholdingInterests.remark=1024',
      'specialAttentionAccounts.address=1024', 'suitsAsDefendant.defendantAddress=1024', 'suitsAsDefendant.plaintiffAddress=1024',
      'suitsAsDefendant.solicitorAddress=1024', 'suitsAsDefendant.subjectAddress=1024', 'suitsAsPlaintiff.defendantAddress=1024',
      'suitsAsPlaintiff.plaintiffAddress=1024', 'suitsAsPlaintiff.solicitorAddress=1024', 'suitsAsPlaintiff.subjectAddress=1024',
      'tradeCreditReferences.remark=1024', 'windingUpActionsAsDefendant.defendantAddress=1024',
      'windingUpActionsAsDefendant.plaintiffAddress=1024', 'windingUpActionsAsDefendant.solicitorAddress=1024',
      'windingUpActionsAsDefendant.subjectAddress=1024', 'windingUpActionsAsPetitioner.defendantAddress=1024',
      'windingUpActionsAsPetitioner.plaintiffAddress=1024', 'windingUpActionsAsPetitioner.solicitorAddress=1024',
      'windingUpActionsAsPetitioner.subjectAddress=1024',
    ])
  })

  // SYS-3728 (second review): identifier fields now carry an ASCII identifier
  // charset, and the two NEW-IC fields (plus the bankruptcy new-IC column) the
  // Malaysian NRIC shape under MY. This REVERSES the earlier pin of "no
  // jurisdiction pattern shipped": the operator's standard is that identifier
  // slots accept nothing but identifiers. The mappers normalize to these forms
  // and OMIT a value that cannot meet them, so a pattern here never refuses a
  // whole report for one unreadable id.
  const IDENT = '[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*'
  const REG = `${IDENT}(?: \\(${IDENT}\\))?`
  const NRIC = { MY: '\\d{6}-?\\d{2}-?\\d{4}' }

  it('patterns are declared ONLY on identifiers and on values the writer computes', () => {
    const withPattern = fields.filter(({ f }) => f.pattern !== undefined).map(({ c, f }) => `${c}.${f.name}=${f.pattern === IDENT ? 'IDENT' : f.pattern === REG ? 'REG' : f.pattern}`)
    expect(withPattern).toEqual([
      'credit-bureau-report.section=ccris|iriss|pbi-[1-9]\\d*',
      'credit-bureau-report.reportOrderId=IDENT',
      'credit-bureau-report.subjectRegistrationNo=REG',
      'credit-bureau-report.subjectProvidedRegistrationNo=REG',
      'credit-bureau-report.subjectIcPassportNo=IDENT',
      'credit-bureau-report.subjectNewIcNo=IDENT',
      'credit-bureau-report.subjectProvidedIcPassportNo=IDENT',
      'credit-bureau-report.subjectProvidedNewIcNo=IDENT',
      'management-account.mgmtStatementsRead=BS|PL|BS,PL',
    ])
    const itemPatterns = fields.flatMap(({ f }) => (f.items ?? []).filter((i) => i.pattern !== undefined).map((i) => `${f.name}.${i.name}=${i.pattern === IDENT ? 'IDENT' : i.pattern === REG ? 'REG' : i.pattern}`))
    expect(itemPatterns.sort()).toEqual([
      'bankruptcyActionCreditors.creditorsIcPpLocalNoRegNo=REG', 'bankruptcyActions.icPpNo=IDENT', 'bankruptcyActions.newIcNo=IDENT',
      'limitedDetailSuitsAsDefendant.icPpNoNewIcNo=IDENT', 'limitedDetailSuitsAsDefendant.localNo=IDENT',
      'shareholdingInterests.registrationNo=REG', 'suitsAsDefendant.icPpNoNewIcNo=IDENT', 'suitsAsDefendant.localNo=IDENT',
      'suitsAsPlaintiff.icPpNoNewIcNo=IDENT', 'suitsAsPlaintiff.localNo=IDENT', 'tradeCreditReferences.subjectId=REG',
      'windingUpActionsAsDefendant.icPpNoNewIcNo=IDENT', 'windingUpActionsAsDefendant.localNo=IDENT',
      'windingUpActionsAsPetitioner.icPpNoNewIcNo=IDENT', 'windingUpActionsAsPetitioner.localNo=IDENT',
    ])
    const withFormat = fields.filter(({ f }) => f.format !== undefined).map(({ c, f }) => `${c}.${f.name}=${f.format}${f.mayBeFuture ? '+future' : ''}`)
    expect(withFormat).toEqual([
      'credit-bureau-report.reportOrderDate=date', 'credit-bureau-report.corporationIncorporationDate=date',
      'management-account.mgmtPeriodEnd=date+future', 'management-account.mgmtPeriodStart=date', 'management-account.mgmtPeriodYear=year+future',
    ])
    expect(spec(MA, 'mgmtPeriodStart').notAfter).toBe('mgmtPeriodEnd')
    expect(categorySchemaOf(MA).periodFields).toEqual({ start: 'mgmtPeriodStart', end: 'mgmtPeriodEnd', year: 'mgmtPeriodYear' })
  })

  it('the NRIC shape is shipped ONLY for fields that are Malaysian new-IC numbers by definition', () => {
    const scalar = fields.filter(({ f }) => f.jurisdictionPatterns !== undefined).map(({ c, f }) => `${c}.${f.name}`)
    expect(scalar).toEqual(['credit-bureau-report.subjectNewIcNo', 'credit-bureau-report.subjectProvidedNewIcNo'])
    const items = fields.flatMap(({ f }) => (f.items ?? []).filter((i) => i.jurisdictionPatterns !== undefined).map((i) => `${f.name}.${i.name}`))
    expect(items).toEqual(['bankruptcyActions.newIcNo'])
    for (const name of ['subjectNewIcNo', 'subjectProvidedNewIcNo']) expect(spec(CBR, name).jurisdictionPatterns).toEqual(NRIC)
    // A field that may hold a passport number, or a registration number of a
    // party that may be foreign, a sole proprietorship or an LLP, is
    // jurisdiction-free: charset only.
    for (const name of ['subjectIcPassportNo', 'subjectProvidedIcPassportNo', 'subjectRegistrationNo', 'subjectProvidedRegistrationNo']) {
      expect(spec(CBR, name).jurisdictionPatterns, name).toBeUndefined()
    }
  })

  it('never Malaysia by default: with no proven jurisdiction only the charset applies', () => {
    const v = (j: string | null | undefined) => rules(validateCanonicalFields(CBR, { subjectNewIcNo: '1234' }, { jurisdiction: j }).violations)
    expect(v('MY')).toEqual(['pattern-mismatch'])
    for (const j of [undefined, null, '', 'my', 'XX', 'VN']) expect(v(j), String(j)).toEqual([])
  })

  it('currency-bearing fields are kind "currency", one per category at most', () => {
    const cur = fields.filter(({ f }) => f.kind === 'currency').map(({ c, f }) => `${c}.${f.name}`)
    expect(cur).toEqual(['financial-statement.currency', 'management-account.mgmtCurrency'])
    expect(spec(MA, 'mgmtCurrency').description).toMatch(/ISO 4217 code; normalized from the printed form/)
  })

  it('no non-list field describes itself as JSON — except three known, pinned company-profile debts', () => {
    // Any wording that says the value is a structure: JSON (not a .json file name), serialized, encoded, array of, list of.
    const jsonish = /(?<!\.)\bJSON\b|\bserialized\b|\bencoded (list|array|object)\b|\barray of\b|\b(a|the) list of\b/i
    const offenders = fields.filter(({ f }) => f.type !== 'list' && jsonish.test(f.description)).map(({ c, f }) => `${c}.${f.name}`)
    // These hold raw extraction nodes serialized as JSON; they violate
    // serialized-structure on every live row and need their own conversion.
    // The list may shrink, never grow.
    expect(offenders).toEqual(['company-profile.directors', 'company-profile.shareholders', 'company-profile.previousDirectors'])
  })
})

describe('SYS-3728 — the loader refuses a bad constraint', () => {
  type Raw = Parameters<typeof buildCategoryRegistry>[0]
  const raw = (field: Record<string, unknown>, more: Array<Record<string, unknown>> = []): Raw =>
    ({
      schemaVersion: '1.0.0',
      categories: [{ id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', egressClass: 'contributable', fields: [{ name: 'f', description: 'd', ...field }, ...more] }],
    }) as unknown as Raw

  it('accepts well-formed constraints', () => {
    const reg = buildCategoryRegistry(raw({ type: 'string', maxLength: 64, pattern: '\\d+', jurisdictionPatterns: { MY: '\\d{12}' } }))
    expect(reg.all[0]!.fields[0]).toMatchObject({ maxLength: 64, pattern: '\\d+', jurisdictionPatterns: { MY: '\\d{12}' } })
  })

  it.each([
    ['maxLength on a number', { type: 'number', maxLength: 5 }, /maxLength.*only a string/],
    ['maxLength 0', { type: 'string', maxLength: 0 }, /maxLength/],
    ['a fractional maxLength', { type: 'string', maxLength: 1.5 }, /maxLength/],
    ['a maxLength past the storage ceiling', { type: 'string', maxLength: 70000 }, /maxLength/],
    ['a pattern on a number', { type: 'number', pattern: '\\d' }, /pattern.*only a string/],
    ['a pattern that does not compile', { type: 'string', pattern: '(' }, /pattern.*compile/],
    ['a jurisdiction pattern for an unknown jurisdiction', { type: 'string', jurisdictionPatterns: { XX: '\\d' } }, /jurisdiction "XX"/],
    ['a lowercase jurisdiction', { type: 'string', jurisdictionPatterns: { my: '\\d' } }, /jurisdiction "my"/],
    ['a jurisdiction pattern that does not compile', { type: 'string', jurisdictionPatterns: { MY: '[' } }, /compile/],
    ['maxItems on a string', { type: 'string', maxItems: 3 }, /maxItems.*only a list/],
    ['maxItems 0', { type: 'list', maxItems: 0, items: [{ name: 'a', displayName: 'A', type: 'string' }] }, /maxItems/],
    ['an item maxLength on a number item', { type: 'list', items: [{ name: 'a', displayName: 'A', type: 'number', maxLength: 3 }] }, /item "a".*maxLength/],
    ['an item pattern that does not compile', { type: 'list', items: [{ name: 'a', displayName: 'A', type: 'string', pattern: '(' }] }, /item "a".*compile/],
    ['currency on a number', { type: 'number', kind: 'currency' }, /currency.*string/],
    ['currency with its own pattern', { type: 'string', kind: 'currency', pattern: '[A-Z]{3}' }, /currency.*pattern/],
  ])('refuses %s', (_l, field, message) => {
    expect(() => buildCategoryRegistry(raw(field))).toThrow(message)
  })

  it('a boolean field accepts only a boolean', () => {
    const b = buildCategoryRegistry(raw({ type: 'boolean' })).all[0]!.fields[0]!
    expect(rules(validateFieldValue(b, true))).toEqual([])
    expect(rules(validateFieldValue(b, 'true'))).toEqual(['type-mismatch'])
    expect(rules(validateFieldValue(b, 1))).toEqual(['type-mismatch'])
  })

  it('refuses a shared fact whose attestations disagree on length or pattern — one fact valid from one source and invalid from another', () => {
    const two = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      ({
        schemaVersion: '1.0.0',
        categories: [
          { id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', egressClass: 'contributable', fields: [{ name: 'companyName', type: 'string', fact: 'companyName', description: 'd', ...a }] },
          { id: 'y', displayName: 'Y', description: 'y', canonicalTable: 'ihs_alt_data_y', egressClass: 'contributable', fields: [{ name: 'companyName', type: 'string', fact: 'companyName', description: 'd', ...b }] },
        ],
      }) as unknown as Raw
    expect(() => buildCategoryRegistry(two({}, {}))).not.toThrow()
    expect(() => buildCategoryRegistry(two({ maxLength: 100 }, {}))).toThrow(/length \/ pattern/)
    expect(() => buildCategoryRegistry(two({ pattern: 'a' }, { pattern: 'b' }))).toThrow(/length \/ pattern/)
  })

  it('refuses two currency fields in one category — which one denominates the money would be a guess', () => {
    expect(() =>
      buildCategoryRegistry(raw({ type: 'string', kind: 'currency' }, [{ name: 'g', description: 'd', type: 'string', kind: 'currency' }])),
    ).toThrow(/more than one currency field/)
  })
})

// ── 2. The validator, rule by rule ─────────────────────────────────────

describe('SYS-3728 — validateCanonicalFields: scalar rules', () => {
  it('a clean instance of each category passes', () => {
    expect(check(CBR, { section: 'pbi-2', subjectRole: 'party', subjectName: 'Example Sdn Bhd', bureauScore: 700, securedOutstandingBalance: 1000.5 })).toEqual({ ok: true, violations: [] })
    expect(check(MA, { companyName: 'Example Sdn Bhd', mgmtCurrency: 'MYR', mgmtPeriodEnd: '2025-12-31', mgmtPeriodYear: '2025', mgmtStatementsRead: 'BS,PL', mgmtTotalAssets: 950000 })).toEqual({ ok: true, violations: [] })
  })

  it('absent values (null / undefined) are not violations', () => {
    expect(check(CBR, { subjectName: null, bureauScore: undefined }).ok).toBe(true)
  })

  it('unknown-field', () => {
    const r = check(CBR, { [SECRET]: SECRET })
    expect(rules(r.violations)).toEqual(['unknown-field'])
    // The field NAME is attacker-controlled too: it is not echoed either.
    noValues(r.violations)
  })

  it.each([
    ['a string in a number field', 'bureauScore', '700'],
    ['a boolean in a number field', 'bureauScore', true],
    ['a number in a string field', 'subjectName', 5],
    ['an object in a string field', 'subjectName', { a: 1 }],
    ['a number in a list field', 'directorsAndOfficers', 5],
  ])('type-mismatch: %s', (_l, field, value) => {
    expect(rules(check(CBR, { [field]: value }).violations)).toEqual(['type-mismatch'])
  })

  it.each([
    ['RM 1,000'], ['₫1.000'], ['$5'], ['1,000 CR'], ['฿20'], ['1000'],
  ])('money accepts only a finite number — "%s" is a type-mismatch', (printed) => {
    const r = check(CBR, { securedOutstandingBalance: printed })
    expect(rules(r.violations)).toEqual(['type-mismatch'])
  })

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])('non-finite-number: %s', (n) => {
    // One value: named for what it is.
    expect(rules(validateFieldValue(spec(CBR, 'bureauScore'), n))).toEqual(['non-finite-number'])
    expect(rules(validateFieldValue(spec(CBR, 'securedOutstandingBalance'), n))).toEqual(['non-finite-number'])
    // Inside an object: JSON would store it as null, so the object is not plain data.
    expect(rules(check(CBR, { bureauScore: n }).violations)).toEqual(['not-plain-data'])
  })

  it.each([
    ['a JSON array', `[{"x":"${SECRET}"}]`],
    ['an empty JSON array', '[]'],
    ['a JSON object', `{"x":"${SECRET}"}`],
  ])('serialized-structure: %s in a string field', (_l, value) => {
    const r = check(CBR, { subjectName: value })
    expect(rules(r.violations)).toEqual(['serialized-structure'])
    noValues(r.violations)
  })

  it('round 3: a short field may open with a bracketed name; a parseable or marked one is still structure', () => {
    expect(rules(check(CBR, { subjectName: '[Example] Sdn Bhd' }).violations)).toEqual([])
    expect(rules(check(CBR, { subjectName: '[{"a":1}]' }).violations)).toEqual(['serialized-structure'])
  })

  it.each([
    ['NUL', 'a\u0000b'], ['a newline in a short field', 'a\nb'], ['a tab in a short field', 'a\tb'], ['carriage return', 'a\rb'],
    ['DEL', 'a\u007fb'], ['a C1 control', 'a\u0085b'], ['a line separator', 'a\u2028b'],
  ])('control-characters: %s', (_l, value) => {
    expect(rules(check(CBR, { subjectName: value }).violations)).toEqual(['control-characters'])
  })

  it('malformed-text: a lone surrogate', () => {
    expect(rules(check(CBR, { subjectName: 'a\ud800b' }).violations)).toEqual(['malformed-text'])
  })

  it.each([[''], ['   ']])('blank-string: %j (absent is omitted, never blank)', (value) => {
    expect(rules(check(CBR, { subjectName: value }).violations)).toEqual(['blank-string'])
  })

  it('max-length: 256 passes, 257 does not', () => {
    expect(check(CBR, { subjectName: 'x'.repeat(256) }).ok).toBe(true)
    expect(rules(check(CBR, { subjectName: 'x'.repeat(257) }).violations)).toEqual(['max-length'])
  })

  it.each([
    ['section', 'pbi-0'], ['section', 'CCRIS'],
  ])('pattern-mismatch: %s = %j', (field, value) => {
    expect(rules(check(CBR, { [field]: value }).violations)).toEqual(['pattern-mismatch'])
  })

  it.each([
    ['mgmtStatementsRead', 'PL,BS,XX'], ['mgmtStatementsRead', 'BS,PL,'],
  ])('pattern-mismatch: %s = %j (a pattern is a FULL match)', (field, value) => {
    expect(rules(check(MA, { [field]: value }).violations)).toEqual(['pattern-mismatch'])
  })

  it.each([
    ['mgmtPeriodEnd', '31/12/2025'], ['mgmtPeriodEnd', '2025-12-31T00:00:00Z'], ['mgmtPeriodYear', '25'],
  ])('invalid-date: %s = %j (a format is a full, calendar-checked match)', (field, value) => {
    expect(rules(check(MA, { [field]: value }).violations)).toEqual(['invalid-date'])
  })

  it('enum: a label outside the manifest set, a missing label set, and the explicit skip', () => {
    const labels = { subjectRole: ['principal', 'party'] }
    expect(validateCanonicalFields(CBR, { subjectRole: 'party' }, { enumValues: labels }).ok).toBe(true)
    expect(rules(validateCanonicalFields(CBR, { subjectRole: 'boss' }, { enumValues: labels }).violations)).toEqual(['enum-not-member'])
    expect(rules(validateCanonicalFields(CBR, { subjectRole: 'party' }).violations)).toEqual(['enum-labels-missing'])
    expect(validateCanonicalFields(CBR, { subjectRole: 'party' }, { enumMembership: 'skip' }).ok).toBe(true)
    // Skipping membership does not skip the string rules.
    expect(rules(validateCanonicalFields(CBR, { subjectRole: '[1]' }, { enumMembership: 'skip' }).violations)).toEqual(['serialized-structure'])
  })

  it.each([['RM'], ['myr'], ["RM'000"], ['EUR']])('currency-not-allowed: %j is not a stored ISO code', (value) => {
    expect(rules(check(MA, { mgmtCurrency: value }).violations)).toEqual(['currency-not-allowed'])
  })

  it('a currency that is not even text of a code is refused before membership: "$" is a placeholder, " MYR" untrimmed', () => {
    expect(rules(check(MA, { mgmtCurrency: '$' }).violations)).toEqual(['placeholder'])
    expect(rules(check(MA, { mgmtCurrency: ' MYR' }).violations)).toEqual(['untrimmed'])
    expect(rules(check(CBR, { section: 'ccris ' }).violations)).toEqual(['untrimmed'])
  })
})

describe('SYS-3728 — validateCanonicalFields: list rules', () => {
  const ma = (value: unknown) => check(MA, { mgmtTradeReceivablesItems: value })

  it('a list may be an array or a JSON string of one', () => {
    expect(ma([MA_ROW]).ok).toBe(true)
    expect(ma(JSON.stringify([MA_ROW])).ok).toBe(true)
    expect(ma('[]').ok).toBe(true)
  })

  it.each([['a JSON object', '{"a":1}'], ['text', 'nope'], ['malformed JSON', '[{'], ['a boolean', true]])('list-not-array: %s', (_l, value) => {
    const r = ma(value)
    expect(rules(r.violations)).toEqual([typeof value === 'string' ? 'list-not-array' : 'type-mismatch'])
  })

  it.each([['a number', [1]], ['an array', [[1]]], ['null', [null]], ['a string', [SECRET]]])('list-item-not-object: %s', (_l, rows) => {
    const r = ma(rows)
    expect(r.violations).toEqual([{ field: 'mgmtTradeReceivablesItems', item: 0, rule: 'list-item-not-object' }])
    noValues(r.violations)
  })

  it('undeclared-item-key — and the key itself is never echoed', () => {
    const r = ma([{ ...MA_ROW, [SECRET]: SECRET }])
    expect(r.violations).toEqual([{ field: 'mgmtTradeReceivablesItems', item: 0, rule: 'undeclared-item-key' }])
    noValues(r.violations)
  })

  it('a kebab-case key is its camelCase item; both spellings at once is duplicate-item-key', () => {
    expect(check(CBR, { directorsAndOfficers: [{ name: 'A', 'appointment-date': '2020-01-01' }] }).ok).toBe(true)
    expect(check(CBR, { directorsAndOfficers: [{ 'appointment-date': '2020-01-01', appointmentDate: '2020-02-01' }] }).violations).toEqual([
      { field: 'directorsAndOfficers', item: 0, key: 'appointmentDate', rule: 'duplicate-item-key' },
    ])
  })

  it('item rules: type, non-finite, money strings, length, control characters, nested structure, blank', () => {
    const at = (row: Record<string, unknown>) => ma([row]).violations
    expect(at({ amount: '1,000' })).toEqual([{ field: 'mgmtTradeReceivablesItems', item: 0, key: 'amount', rule: 'type-mismatch' }])
    expect(at({ amount: 'RM 5' })[0]!.rule).toBe('type-mismatch')
    expect(at({ amount: Number.NaN })[0]!.rule).toBe('not-plain-data')
    expect(at({ amount: true })[0]!.rule).toBe('type-mismatch')
    expect(at({ term: 'x'.repeat(257) })[0]!.rule).toBe('max-length')
    expect(at({ term: 'a\u0000' })[0]!.rule).toBe('control-characters')
    expect(at({ term: '[{"a":1}]' })[0]!.rule).toBe('serialized-structure')
    expect(at({ term: { a: 1 } })[0]!.rule).toBe('type-mismatch')
    expect(at({ term: ' ' })[0]!.rule).toBe('blank-string')
  })

  it('a long-text item allows a newline and a tab, and still refuses every other control character', () => {
    const suit = (address: string) => check(CBR, { suitsAsDefendant: [{ defendantAddress: address }] })
    expect(suit('1 JALAN A,\n\tKUALA LUMPUR').ok).toBe(true)
    expect(rules(suit('a\rb').violations)).toEqual(['control-characters'])
    expect(rules(suit('a\u0000b').violations)).toEqual(['control-characters'])
    expect(suit('x'.repeat(1024)).ok).toBe(true)
    expect(rules(suit('x'.repeat(1025)).violations)).toEqual(['max-length'])
  })

  it('max-items: 500 passes, 501 does not', () => {
    expect(ma(Array.from({ length: 500 }, () => MA_ROW)).ok).toBe(true)
    expect(rules(ma(Array.from({ length: 501 }, () => MA_ROW)).violations)).toEqual(['max-items'])
  })

  it('a stored string that is not JSON never has its content echoed', () => {
    noValues(ma(`not json ${SECRET}`).violations)
    noValues(check(CBR, { subjectName: `${SECRET}\u0000` }).violations)
  })
})

describe('SYS-3728 — jurisdiction patterns apply only under their own jurisdiction', () => {
  // No shipped field has a provable identifier format, so the mechanism is
  // exercised on a fixture registry.
  const reg = buildCategoryRegistry({
    schemaVersion: '1.0.0',
    categories: [{
      id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', egressClass: 'contributable',
      fields: [{ name: 'nationalId', type: 'string', description: 'd', jurisdictionPatterns: { MY: '\\d{6}-?\\d{2}-?\\d{4}' } }],
    }],
  } as unknown as Parameters<typeof buildCategoryRegistry>[0])
  const id = reg.all[0]!.fields[0]!
  const v = (value: string, jurisdiction?: string | null) => rules(validateFieldValue(id, value, { jurisdiction }))

  it('a well-formed MY IC passes under MY, dashed or not', () => {
    expect(v('900115-08-5432', 'MY')).toEqual([])
    expect(v('900115085432', 'MY')).toEqual([])
  })

  it('a malformed MY IC under MY is rejected', () => {
    expect(v('90011508543', 'MY')).toEqual(['pattern-mismatch'])
    expect(v('900115-08-5432X', 'MY')).toEqual(['pattern-mismatch'])
  })

  it('under VN, an MY-shaped rule is not applied — nor under an unknown, lowercase or absent jurisdiction; never defaulted to MY', () => {
    expect(v('not-an-ic', 'VN')).toEqual([])
    expect(v('not-an-ic', 'XX')).toEqual([])
    expect(v('not-an-ic', 'my')).toEqual([])
    expect(v('not-an-ic', null)).toEqual([])
    expect(v('not-an-ic')).toEqual([])
  })

  it('a jurisdiction naming an Object.prototype member is not a jurisdiction (no pattern is looked up for it)', () => {
    expect(v('not-an-ic', 'constructor')).toEqual([])
    expect(v('not-an-ic', 'toString')).toEqual([])
    expect(v('not-an-ic', '__proto__')).toEqual([])
  })

  it('jurisdiction-independent rules still apply everywhere', () => {
    expect(v('[1]', 'VN')).toEqual(['serialized-structure'])
  })
})

// ── 3. The envelope ────────────────────────────────────────────────────

describe('SYS-3728 — validateAdapterExtraction: the envelope the writer passes', () => {
  const ok = { instanceKey: `experianReport:${'a'.repeat(64)}#ccris`, values: { section: 'ccris', subjectName: 'Example Sdn Bhd' } }
  const x = (e: Record<string, unknown>, category = CBR) => validateAdapterExtraction(category, e as never, { enumMembership: 'skip' })

  it('a clean extraction passes, periods included', () => {
    expect(x(ok)).toEqual({ ok: true, violations: [] })
    expect(x({ instanceKey: 'managementAccount:b', values: {}, observedAt: '2026-09-23T10:00:00.000Z', periods: [
      { position: 1, end: '2025-12-31', values: { mgmtCurrency: 'MYR', mgmtTotalAssets: 1 }, confidence: { mgmtTotalAssets: 0.9 } },
      { position: 2, values: { mgmtCurrency: 'MYR', mgmtTotalAssets: 2 } },
    ] }, MA)).toEqual({ ok: true, violations: [] })
  })

  it('the single-cardinality convention: an empty instance key is allowed', () => {
    expect(x({ ...ok, instanceKey: '' }).ok).toBe(true)
  })

  it.each([
    ['too long for its column', 'k'.repeat(201)], ['a control character', 'a\u0000'], ['serialized structure', '["a"]'], ['not a string', 5],
  ])('invalid-instance-key: %s', (_l, instanceKey) => {
    expect(x({ ...ok, instanceKey }).violations).toEqual([{ field: 'instanceKey', envelope: true, rule: 'invalid-instance-key' }])
  })

  it.each([['yesterday'], ['2026-09-23'], [12345]])('invalid-observed-at: %j', (observedAt) => {
    expect(rules(x({ ...ok, observedAt }).violations)).toEqual(['invalid-observed-at'])
  })

  it('confidence: keys must be category fields, values a fraction or null', () => {
    expect(x({ ...ok, confidence: { subjectName: null, bureauScore: 0.5 } }).ok).toBe(true)
    expect(x({ ...ok, confidence: { nope: 0.5 } }).violations).toEqual([{ field: 'confidence', envelope: true, rule: 'unknown-field' }])
    expect(rules(x({ ...ok, confidence: { subjectName: 1.5 } }).violations)).toEqual(['invalid-confidence'])
    expect(rules(x({ ...ok, confidence: { subjectName: '0.5' } }).violations)).toEqual(['invalid-confidence'])
  })

  it('periods: position a positive integer, unique; start/end ISO dates; values validated with the period index', () => {
    const p = (periods: unknown) => x({ instanceKey: 'm', values: { companyName: 'Example Sdn Bhd' }, periods }, MA).violations
    expect(rules(p([{ position: 0, values: { mgmtStatementsRead: 'BS' } }]))).toEqual(['invalid-period'])
    expect(rules(p([{ position: 1.5, values: { mgmtStatementsRead: 'BS' } }]))).toEqual(['invalid-period'])
    expect(rules(p([{ position: 1, values: { mgmtStatementsRead: 'BS' } }, { position: 1, values: { mgmtStatementsRead: 'BS' } }]))).toEqual(['duplicate-period'])
    expect(rules(p([{ position: 1, end: '31/12/2025', values: { mgmtStatementsRead: 'BS' } }]))).toEqual(['invalid-period'])
    expect(rules(p('nope'))).toEqual(['invalid-period'])
    expect(p([{ position: 1, values: { mgmtTotalAssets: 'RM 1' } }])).toEqual([{ field: 'mgmtTotalAssets', period: 0, rule: 'type-mismatch' }])
  })

  it('an undeclared envelope key is refused, and not echoed', () => {
    const r = x({ ...ok, [SECRET]: 1 })
    expect(r.violations).toEqual([{ field: '(envelope)', envelope: true, rule: 'unknown-field' }])
    noValues(r.violations)
  })
})

// ── 4. Currency ───────────────────────────────────────────────────────

describe('SYS-3728 — normalizeCurrency: printed form to ISO 4217, never a guess', () => {
  it('the allowed set includes every jurisdiction display currency, plus the four declared ones', () => {
    for (const c of Object.values(JURISDICTION_DISPLAY_CURRENCY)) expect(CURRENCY_CODES).toContain(c)
    expect([...CURRENCY_CODES]).toEqual(['IDR', 'MYR', 'PHP', 'SGD', 'THB', 'USD', 'VND'])
  })

  it.each([
    ['RM', 'MYR'], ['RM.', 'MYR'], ['MYR', 'MYR'], [' rm ', 'MYR'], ['₫', 'VND'], ['VNĐ', 'VND'], ['vnd', 'VND'],
    ['฿', 'THB'], ['THB', 'THB'], ['₱', 'PHP'], ['S$', 'SGD'], ['Rp', 'IDR'], ['US$', 'USD'], ['USD', 'USD'],
  ])('%j → %s', (printed, code) => {
    expect(normalizeCurrency(printed)).toEqual({ ok: true, code })
    expect(isAllowedCurrency(code)).toBe(true)
  })

  it('bare "$" is ambiguous and refused', () => {
    expect(normalizeCurrency('$')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(normalizeCurrency(' $ ')).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it.each([["RM'000"], ['EUR'], ['Ringgit'], [''], ['$$'], ['R M']])('%j is unrecognized', (printed) => {
    expect(normalizeCurrency(printed)).toEqual({ ok: false, reason: 'unrecognized' })
  })

  it('a non-string is refused', () => {
    expect(normalizeCurrency(5)).toEqual({ ok: false, reason: 'not-a-string' })
    expect(normalizeCurrency(null)).toEqual({ ok: false, reason: 'not-a-string' })
  })

  it('every alias target is itself an allowed code', () => {
    for (const printed of ['RM', '₫', '฿', '₱', 'S$', 'Rp', 'US$']) {
      const r = normalizeCurrency(printed)
      expect(r.ok && isAllowedCurrency(r.code)).toBe(true)
    }
  })
})

// ── 5. The read side ───────────────────────────────────────────────────

import { buildFileFieldTablesFromView, INVALID_VALUE_TEXT } from './ihs-processing.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'

describe('SYS-3728 — a table never renders a value that breaks the contract', () => {
  const h = (c: string) => c.repeat(64)
  const inst = (instanceKey: string, values: Record<string, unknown>, extra: Partial<CanonicalInstance> = {}): CanonicalInstance => ({
    instanceKey, adapterId: 'fixture', adapterVersion: 1,
    fields: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value: value as string, confidentiality: 'internal', origin: 'extraction' }])),
    ...extra,
  })
  const view = (cbr: Array<Record<string, unknown>>, ma: Record<string, unknown> = { mgmtTotalAssets: 950000 }): CanonicalView => ({
    ihsId: 1,
    categories: {
      'document-intake': { cardinality: 'multi', instances: [
        inst('experianReports#1', { documentType: 'experianReports', pathInDms: `https://dms.example/x/${h('a')}`, uploadedAt: '2026-09-01T00:00:00.000Z' }),
        inst('managementAccounts#1', { documentType: 'managementAccounts', pathInDms: `https://dms.example/x/${h('b')}`, uploadedAt: '2026-09-01T00:00:00.000Z' }),
      ] },
      [CBR]: { cardinality: 'multi', instances: cbr.map((v) => inst(`experianReport:${h('a')}#${v.section}`, v)) },
      [MA]: { cardinality: 'multi', instances: [inst(`managementAccount:${h('b')}`, ma, { periodPosition: 1 })] },
    },
  })
  const tables = (v: CanonicalView) => buildFileFieldTablesFromView(v)
  const itemOf = (v: CanonicalView, group: string, name: string) => tables(v)[group]!.items.find((i) => i.displayName === name)!

  it('a scalar that breaks a rule: data null, "(invalid value)", the rules named, the value nowhere', () => {
    const v = view([{ section: 'ccris', subjectRole: 'principal', subjectName: 'Co', corporationName: `[{"x":"${SECRET}"}]`, bureauScore: 712 }])
    const it0 = itemOf(v, 'credit_bureau_reports', 'Corporation Name')
    expect(it0.data).toEqual({ 'Co (principal)': null })
    expect(it0.formattedData).toEqual({ 'Co (principal)': INVALID_VALUE_TEXT })
    expect(it0.invalid).toEqual({ 'Co (principal)': ['serialized-structure'] })
    expect(JSON.stringify(tables(v))).not.toContain(SECRET)
    // A valid neighbor is untouched and carries no flag.
    expect(itemOf(v, 'credit_bureau_reports', 'Bureau Score')).toMatchObject({ data: { 'Co (principal)': 712 } })
    expect(itemOf(v, 'credit_bureau_reports', 'Bureau Score').invalid).toBeUndefined()
  })

  it('a column made ONLY of invalid values still appears, flagged — an invalid value is not an absent one', () => {
    const v = view([{ section: 'ccris', subjectRole: 'principal', subjectName: 'Co', corporationName: 'a\u0000b' }])
    expect(itemOf(v, 'credit_bureau_reports', 'Corporation Name').invalid).toEqual({ 'Co (principal)': ['control-characters'] })
  })

  it('a label field that breaks a rule is never used as a column label', () => {
    const v = view([{ section: 'ccris', subjectRole: 'principal', subjectName: `${SECRET}\u202e`, bureauScore: 1 }])
    const labels = itemOf(v, 'credit_bureau_reports', 'Bureau Score').timePeriods
    expect(labels).toEqual(['T1 \u00b7 ccris'])
    expect(JSON.stringify(tables(v))).not.toContain(SECRET)
  })

  it('a number field holding printed money is invalid, not coerced', () => {
    const v = view([{ section: 'ccris', subjectRole: 'principal', subjectName: 'Co', securedOutstandingBalance: 'RM 1,000' }])
    expect(itemOf(v, 'credit_bureau_reports', 'Secured Outstanding Balance').invalid).toEqual({ 'Co (principal)': ['type-mismatch'] })
  })

  it("money renders in the document's OWN valid currency code, via Intl", () => {
    const v = view([], { mgmtCurrency: 'MYR', mgmtTotalAssets: 950000, mgmtTradeReceivablesItems: JSON.stringify([MA_ROW]) })
    expect(itemOf(v, 'management_accounts', 'Total Assets').formattedData).toEqual({ T1: 'MYR\u00a0950,000.00' })
    expect(itemOf(v, 'management_accounts', 'Trade Receivables (Lines)').list!['T1']!.rows[0]!.amount).toBe('-MYR\u00a01,719,587.11')
    const vnd = view([], { mgmtCurrency: 'VND', mgmtTotalAssets: 950000 })
    expect(itemOf(vnd, 'management_accounts', 'Total Assets').formattedData).toEqual({ T1: 'VND\u00a0950,000' })
  })

  it('a printed currency is invalid, and never re-parsed into a symbol: money stays a plain number', () => {
    const v = view([], { mgmtCurrency: 'RM', mgmtTotalAssets: 950000 })
    expect(itemOf(v, 'management_accounts', 'Currency').invalid).toEqual({ T1: ['currency-not-allowed'] })
    expect(itemOf(v, 'management_accounts', 'Total Assets').formattedData).toEqual({ T1: '950,000' })
  })

  it('no currency field, no currency: money is a plain number — never the jurisdiction default', () => {
    const v = view([{ section: 'ccris', subjectRole: 'principal', subjectName: 'Co', securedOutstandingBalance: 1000 }])
    expect(itemOf(v, 'credit_bureau_reports', 'Secured Outstanding Balance').formattedData).toEqual({ 'Co (principal)': '1,000' })
  })
})
