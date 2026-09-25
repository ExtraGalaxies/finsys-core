import { describe, it, expect } from 'vitest'
import { buildCategoryRegistry, categorySchemaOf } from './adapter-categories.js'
import type { AdapterCategory } from './adapter-categories.js'
import { validateAdapterExtraction } from './canonical-validation.js'
import { buildFileFieldTablesFromView } from './ihs-processing.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'

/**
 * About a third of Malaysian management
 * accounts print no currency anywhere. On a Malaysian application whose
 * statement prints none — no heading, no prefix on any figure — the writer
 * stores MYR and records that it INFERRED it (`mgmtCurrencySource`), so a
 * reviewer can see the currency was not on the page. Everything a reviewer
 * reads about that decision, and every rule that keeps it honest, is here.
 *
 * All values invented.
 */

const MA = 'management-account' as AdapterCategory
const NOW = new Date('2026-09-24T00:00:00.000Z')

const fields = () => categorySchemaOf(MA).fields
const spec = (name: string) => {
  const f = fields().find((x) => x.name === name)
  if (!f) throw new Error(`no field ${name}`)
  return f
}

describe('the declaration', () => {
  it('mgmtCurrencySource is a string enum carrying its display labels, marked as the currency\'s source', () => {
    const f = spec('mgmtCurrencySource')
    expect(f.type).toBe('string')
    expect(f.kind).toBe('enum')
    expect(f.currencySource).toBe(true)
    expect(f.valueLabels).toEqual({
      printed: 'Printed on the statement',
      inferred: 'Inferred (MYR, Malaysian application; not printed)',
    })
  })

  it('it sits immediately after mgmtCurrency, so both UIs show it beside Currency', () => {
    const names = fields().map((f) => f.name as string)
    expect(names.indexOf('mgmtCurrencySource')).toBe(names.indexOf('mgmtCurrency') + 1)
  })
})

describe('the loader holds currencySource to its shape', () => {
  const raw = (fs: unknown[]) => ({
    schemaVersion: '1',
    categories: [{ id: 'x', displayName: 'X', description: 'x', canonicalTable: 'ihs_alt_data_x', fields: fs }],
  })
  const cur = { name: 'c', type: 'string', kind: 'currency', description: 'd' }
  const src = (more: Record<string, unknown> = {}) => ({ name: 's', type: 'string', kind: 'enum', currencySource: true, description: 'd', ...more })

  it('accepts one enum source beside a currency field', () => {
    const f = buildCategoryRegistry(raw([cur, src()]) as never).all[0]!.fields.find((x) => (x.name as string) === 's')!
    expect(f.currencySource).toBe(true)
  })

  it.each([
    ['a value other than true', [cur, src({ currencySource: 'yes' })], /currencySource/],
    ['a field that is not an enum', [cur, src({ kind: undefined })], /currencySource.*enum/],
    ['a category with no currency field', [src()], /currencySource.*currency field/],
    ['two sources', [cur, src(), src({ name: 's2' })], /more than one currencySource/],
  ])('refuses %s', (_, fs, message) => {
    expect(() => buildCategoryRegistry(raw(fs) as never)).toThrow(message)
  })
})

describe('the consistency rule: an inferred currency is the application jurisdiction\'s own', () => {
  const check = (periodValues: Record<string, unknown>, jurisdiction: string | null, top: Record<string, unknown> = {}) =>
    validateAdapterExtraction(
      MA,
      { instanceKey: 'managementAccount:d', values: top, periods: [{ position: 1, values: { mgmtTotalAssets: 1000, ...periodValues } }] },
      { jurisdiction, enumValues: { mgmtCurrencySource: ['printed', 'inferred'] }, now: NOW },
    )

  it('inferred MYR on a Malaysian application is accepted', () => {
    expect(check({ mgmtCurrency: 'MYR', mgmtCurrencySource: 'inferred' }, 'MY')).toEqual({ ok: true, violations: [] })
  })

  it.each([
    ['no jurisdiction', 'MYR', null],
    ['a lowercase (unproven) jurisdiction', 'MYR', 'my'],
    ['another jurisdiction', 'MYR', 'VN'],
    ['a currency other than the jurisdiction\'s own', 'USD', 'MY'],
    ['VND on a Malaysian application', 'VND', 'MY'],
  ])('inferred is refused under %s — value-free', (_, currency, jurisdiction) => {
    expect(check({ mgmtCurrency: currency, mgmtCurrencySource: 'inferred' }, jurisdiction).violations).toEqual([
      { field: 'mgmtCurrencySource', period: 0, rule: 'currency-source-mismatch' },
    ])
  })

  it('printed carries no jurisdiction rule: a printed USD on an application of no jurisdiction is fine', () => {
    expect(check({ mgmtCurrency: 'USD', mgmtCurrencySource: 'printed' }, null).ok).toBe(true)
  })

  it('a source with no currency to describe is refused, printed or inferred', () => {
    for (const source of ['printed', 'inferred']) {
      const r = check({ mgmtCurrencySource: source }, 'MY')
      expect(r.violations).toContainEqual({ field: 'mgmtCurrencySource', period: 0, rule: 'currency-source-mismatch' })
    }
  })

  it('a currency with no source is allowed (legacy rows, other writers)', () => {
    expect(check({ mgmtCurrency: 'MYR' }, null).ok).toBe(true)
  })

  it('a period inherits the top level\'s currency and source alike', () => {
    expect(check({}, 'MY', { mgmtCurrency: 'MYR', mgmtCurrencySource: 'inferred' }).ok).toBe(true)
    expect(check({}, null, { mgmtCurrency: 'MYR', mgmtCurrencySource: 'inferred' }).violations).toEqual([
      { field: 'mgmtCurrencySource', rule: 'currency-source-mismatch' },
    ])
  })

  it('a value outside the manifest labels is an enum violation, as for every enum', () => {
    expect(check({ mgmtCurrency: 'MYR', mgmtCurrencySource: 'guessed' }, 'MY').violations).toEqual([
      { field: 'mgmtCurrencySource', period: 0, rule: 'enum-not-member' },
    ])
  })
})

describe('the render: both UIs print the source beside Currency, in words', () => {
  const inst = (values: Record<string, unknown>, periodPosition: number): CanonicalInstance => ({
    instanceKey: 'managementAccount:doc',
    adapterId: 'fixture',
    adapterVersion: 1,
    periodPosition,
    fields: Object.fromEntries(
      Object.entries(values).map(([k, value]) => [k, { value: value as string, confidentiality: 'internal', origin: 'extraction', confidence: 1 }]),
    ),
  })
  const view: CanonicalView = {
    ihsId: 3728,
    categories: {
      [MA]: {
        cardinality: 'multi',
        instances: [
          inst({ mgmtCurrency: 'MYR', mgmtCurrencySource: 'inferred', mgmtTotalAssets: 1000 }, 1),
          inst({ mgmtCurrency: 'MYR', mgmtCurrencySource: 'printed', mgmtTotalAssets: 900 }, 2),
        ],
      },
    },
  }

  it('the table carries "Currency Source" right after "Currency", labelled, with the stored code as data', () => {
    const t = buildFileFieldTablesFromView(view)['management_accounts']!
    const names = t.items.map((i) => i.displayName)
    expect(names.indexOf('Currency Source')).toBe(names.indexOf('Currency') + 1)
    const row = t.items.find((i) => i.displayName === 'Currency Source')!
    expect(row.formattedData).toEqual({
      T1: 'Inferred (MYR, Malaysian application; not printed)',
      T2: 'Printed on the statement',
    })
    expect(row.data).toEqual({ T1: 'inferred', T2: 'printed' })
  })
})
