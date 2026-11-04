/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * SYS-3995 — the categories a receivable listing is taken in on: the invoice,
 * its buyer and its seller.
 *
 * The central claim under test: core declares the invoice (MyInvois status,
 * UUID, validation time, cancellation, amounts, currency, dates, settlement
 * status, platform invoice id), the buyer (master-data id, TIN) and the seller
 * (TIN, SSM registration number), validated airtight at write like every
 * sensitive category, with names a bureau report's typed values can reuse.
 *
 * Every date bound is measured against a frozen clock, never the day the suite
 * runs on.
 */
import { describe, expect, it } from 'vitest'
import {
  allCategories,
  buildCategoryRegistry,
  categoryForField,
  categorySchemaOf,
  egressClassOf,
  type AdapterCategory,
  type CanonicalFieldSpec,
} from './adapter-categories.js'
import {
  prepareExtractionForWrite,
  validateAdapterExtraction,
  validateCanonicalFields,
  validateFieldValue,
  type ValidationOptions,
  type Violation,
} from './canonical-validation.js'
import { InvoiceSettlementStatus, MyInvoisStatus } from './invoice-listing.js'
import * as publicApi from './index.js'
import categoriesData from './data/adapter-categories.json' with { type: 'json' }

const INVOICE = 'invoice' as AdapterCategory
const BUYER = 'invoice-buyer' as AdapterCategory
const SELLER = 'invoice-seller' as AdapterCategory

/** The frozen clock. */
const NOW = new Date('2026-09-24T10:00:00Z')
const rules = (vs: ReadonlyArray<Violation>) => vs.map((v) => v.rule)
const fieldRules = (c: AdapterCategory, fields: Record<string, unknown>, opts: ValidationOptions = {}) =>
  rules(validateCanonicalFields(c, fields, { now: NOW, ...opts }).violations)
const extractionRules = (c: AdapterCategory, extraction: { instanceKey: string; values: Record<string, unknown> }) =>
  rules(validateAdapterExtraction(c, extraction, { now: NOW }).violations)
const spec = (c: AdapterCategory, name: string): CanonicalFieldSpec => categorySchemaOf(c).fields.find((f) => f.name === name)!

const validInvoice = (): Record<string, unknown> => ({
  platformInvoiceId: 'inv-0847',
  invoiceNumber: 'IV-2026-0847',
  issueDate: '2026-08-14',
  dueDate: '2026-09-13',
  paymentTermsDays: 30,
  invoiceCurrency: 'MYR',
  taxExclusiveAmount: 90000,
  taxAmount: 7200,
  taxInclusiveAmount: 97200,
  amountAfterCreditNotes: 94800,
  outstandingAmount: 94800,
  allocatedReceiptsAmount: 0,
  contraAmount: 0,
  settlementStatus: 'open',
  myInvoisStatus: 'valid',
  myInvoisUuid: 'F9C2K7M4Q8W3R6T1Y5U2I9O0P4',
  myInvoisValidatedAt: '2026-08-14T15:42:00+08:00',
  cancelled: false,
})

describe('SYS-3995 the three categories are declared', () => {
  it('invoice, invoice-buyer and invoice-seller are in the registry, contributable, each with its own table', () => {
    const tables = new Set<string>()
    for (const id of [INVOICE, BUYER, SELLER]) {
      const c = categorySchemaOf(id)
      expect(c.egressClass, id).toBe('contributable')
      expect(egressClassOf(id), id).toBe('contributable')
      expect(c.canonicalTable, id).toMatch(/^ihs_alt_data_[a-z_]+$/)
      tables.add(c.canonicalTable)
    }
    expect(tables.size).toBe(3)
  })

  it('golden: the exact fields, types and kinds each category declares', () => {
    const shape = (id: AdapterCategory) =>
      categorySchemaOf(id).fields.map((f) => `${f.name}:${f.type}${f.kind ? ':' + f.kind : ''}${f.format ? ':' + f.format : ''}`)
    expect(shape(INVOICE)).toEqual([
      'platformInvoiceId:string',
      'invoiceNumber:string',
      'issueDate:string:date',
      'dueDate:string:date',
      'paymentTermsDays:number',
      'invoiceCurrency:string:currency',
      'taxExclusiveAmount:number:money',
      'taxAmount:number:money',
      'taxType:string',
      'taxInclusiveAmount:number:money',
      'amountAfterCreditNotes:number:money',
      'outstandingAmount:number:money',
      'allocatedReceiptsAmount:number:money',
      'contraAmount:number:money',
      'settlementStatus:string',
      'myInvoisStatus:string',
      'myInvoisUuid:string',
      'myInvoisValidatedAt:string:datetime',
      'cancelled:boolean',
    ])
    expect(shape(BUYER)).toEqual(['buyerMasterDataId:string', 'buyerTin:string'])
    expect(shape(SELLER)).toEqual(['sellerTin:string', 'sellerSsmNumber:string'])
  })

  it('paymentTermsDays is declared in days', () => {
    expect(spec(INVOICE, 'paymentTermsDays').unit).toBe('days')
  })

  it('every field is sensitive (the default): none opts out', () => {
    for (const id of [INVOICE, BUYER, SELLER]) {
      for (const f of categorySchemaOf(id).fields) expect(f.confidentiality, `${id}.${f.name}`).toBe('sensitive')
    }
  })

  it('no new name restates a quantity trade-credit already names, and each is owned by exactly one category', () => {
    const trade = new Set(categorySchemaOf('trade-credit' as AdapterCategory).fields.map((f) => f.name as string))
    for (const id of [INVOICE, BUYER, SELLER]) {
      for (const f of categorySchemaOf(id).fields) {
        expect(trade.has(f.name), f.name).toBe(false)
        expect(categoryForField(f.name), f.name).toBe(id)
      }
    }
    // The names core already owns keep their category.
    expect(categoryForField('arDaysSalesOutstanding')).toBe('trade-credit')
    expect(categoryForField('cashConversionCycleDays')).toBe('trade-credit')
  })

  it('no name encodes a denomination, and the buyer and seller names carry their role', () => {
    for (const id of [INVOICE, BUYER, SELLER]) {
      for (const f of categorySchemaOf(id).fields) expect(f.name, f.name).not.toMatch(/(Myr|Usd|Sen)$/)
    }
    for (const f of categorySchemaOf(BUYER).fields) expect(f.name).toMatch(/^buyer/)
    for (const f of categorySchemaOf(SELLER).fields) expect(f.name).toMatch(/^seller/)
  })

  it('the registry still builds from the shipped data, and the data lists the three ids once', () => {
    expect(() => buildCategoryRegistry(categoriesData as never)).not.toThrow()
    const ids = allCategories().map((c) => c.id as string)
    for (const id of [INVOICE, BUYER, SELLER]) expect(ids.filter((x) => x === id)).toHaveLength(1)
  })
})

describe('SYS-3995 closed sets are the exported enums, exactly', () => {
  const alternatives = (pattern: string) => pattern.split('|').sort()

  it('myInvoisStatus accepts exactly the MyInvoisStatus members', () => {
    expect(Object.values(MyInvoisStatus).sort()).toEqual(['not_submitted', 'pending', 'rejected', 'valid'])
    expect(alternatives(spec(INVOICE, 'myInvoisStatus').pattern!)).toEqual(Object.values(MyInvoisStatus).sort())
    for (const v of Object.values(MyInvoisStatus)) expect(fieldRules(INVOICE, { myInvoisStatus: v }), v).toEqual([])
    for (const bad of ['Valid', 'VALID', 'submitted', 'valid ', 'not-submitted', 'valid|pending', 'invalid', 'cancelled']) {
      expect(fieldRules(INVOICE, { myInvoisStatus: bad }).length, bad).toBeGreaterThan(0)
    }
  })

  it('settlementStatus accepts exactly the InvoiceSettlementStatus members', () => {
    expect(Object.values(InvoiceSettlementStatus).sort()).toEqual(['open', 'paid', 'part_paid'])
    expect(alternatives(spec(INVOICE, 'settlementStatus').pattern!)).toEqual(Object.values(InvoiceSettlementStatus).sort())
    for (const v of Object.values(InvoiceSettlementStatus)) expect(fieldRules(INVOICE, { settlementStatus: v }), v).toEqual([])
    for (const bad of ['Open', 'partial', 'part paid', 'closed', 'open|paid', 'openx', 'xopen']) {
      expect(fieldRules(INVOICE, { settlementStatus: bad }), bad).toEqual(['pattern-mismatch'])
    }
  })

  it('the enums are on the public API', () => {
    expect(publicApi.MyInvoisStatus).toBe(MyInvoisStatus)
    expect(publicApi.InvoiceSettlementStatus).toBe(InvoiceSettlementStatus)
  })
})

describe('SYS-3995 a real record validates; every defect is refused', () => {
  it('a complete, well-formed invoice is accepted, on both validators', () => {
    expect(fieldRules(INVOICE, validInvoice())).toEqual([])
    expect(extractionRules(INVOICE, { instanceKey: 'inv-0847', values: validInvoice() })).toEqual([])
    const prepared = prepareExtractionForWrite(INVOICE, { instanceKey: 'inv-0847', values: validInvoice() }, { now: NOW })
    expect(prepared.ok).toBe(true)
  })

  it('a buyer and a seller are accepted', () => {
    expect(fieldRules(BUYER, { buyerMasterDataId: 'contact-9912', buyerTin: 'C2584563200' })).toEqual([])
    expect(fieldRules(SELLER, { sellerTin: 'C1234567890', sellerSsmNumber: '202101023456' })).toEqual([])
  })

  it('fail closed on an unknown field, in every category, without echoing the name', () => {
    for (const id of [INVOICE, BUYER, SELLER]) {
      const r = validateCanonicalFields(id, { smuggled: 'x' }, { now: NOW })
      expect(rules(r.violations), id).toEqual(['unknown-field'])
      expect(JSON.stringify(r.violations)).not.toContain('smuggled')
    }
    // The bare names the brief's mapping used are NOT fields: they are role-prefixed.
    expect(fieldRules(BUYER, { tin: 'C2584563200' })).toEqual(['unknown-field'])
    expect(fieldRules(SELLER, { ssmNumber: '202101023456' })).toEqual(['unknown-field'])
  })

  it('refuses a wrong type on every field', () => {
    const wrong: Record<string, unknown> = {
      platformInvoiceId: 7,
      invoiceNumber: 7,
      issueDate: 20260814,
      dueDate: 20260913,
      paymentTermsDays: '30',
      invoiceCurrency: 7,
      taxExclusiveAmount: '90000',
      taxAmount: '7200',
      taxType: 7,
      taxInclusiveAmount: '97200',
      amountAfterCreditNotes: '1',
      outstandingAmount: '1',
      allocatedReceiptsAmount: '1',
      contraAmount: '1',
      settlementStatus: 1,
      myInvoisStatus: 1,
      myInvoisUuid: 1,
      myInvoisValidatedAt: 1,
      cancelled: 'false',
    }
    for (const [name, value] of Object.entries(wrong)) {
      expect(fieldRules(INVOICE, { [name]: value }), name).toEqual(['type-mismatch'])
    }
    for (const [c, name] of [[BUYER, 'buyerMasterDataId'], [BUYER, 'buyerTin'], [SELLER, 'sellerTin'], [SELLER, 'sellerSsmNumber']] as const) {
      expect(fieldRules(c, { [name]: 7 }), name).toEqual(['type-mismatch'])
    }
    // A boolean is not a truthy string, and a number is not text.
    expect(fieldRules(INVOICE, { cancelled: 0 })).toEqual(['type-mismatch'])
    expect(fieldRules(INVOICE, { cancelled: 'N' })).toEqual(['type-mismatch'])
  })

  it('dates: a real calendar day, never in the future for an issue date, a due date may lie ahead', () => {
    expect(fieldRules(INVOICE, { issueDate: '2026-02-30' })).toEqual(['invalid-date'])
    expect(fieldRules(INVOICE, { issueDate: '2026-8-14' })).toEqual(['invalid-date'])
    expect(fieldRules(INVOICE, { issueDate: '14/08/2026' })).toEqual(['invalid-date'])
    expect(fieldRules(INVOICE, { issueDate: '2026-08-14T00:00:00Z' })).toEqual(['invalid-date'])
    expect(fieldRules(INVOICE, { issueDate: '1899-12-31' })).toEqual(['implausible-date'])
    expect(fieldRules(INVOICE, { issueDate: '2026-09-26' })).toEqual(['implausible-date'])
    expect(fieldRules(INVOICE, { dueDate: '2026-12-31' })).toEqual([])
    expect(fieldRules(INVOICE, { dueDate: '2099-01-01' })).toEqual(['implausible-date'])
  })

  it('an issue date after its due date is refused as date-order, and equal dates are fine', () => {
    expect(fieldRules(INVOICE, { issueDate: '2026-09-14', dueDate: '2026-09-13' })).toEqual(['date-order'])
    expect(fieldRules(INVOICE, { issueDate: '2026-09-13', dueDate: '2026-09-13' })).toEqual([])
  })

  it('paymentTermsDays is bounded', () => {
    expect(fieldRules(INVOICE, { paymentTermsDays: 0 })).toEqual([])
    expect(fieldRules(INVOICE, { paymentTermsDays: 3650 })).toEqual([])
    expect(fieldRules(INVOICE, { paymentTermsDays: -1 })).toEqual(['out-of-range'])
    expect(fieldRules(INVOICE, { paymentTermsDays: 3651 })).toEqual(['out-of-range'])
    expect(rules(validateFieldValue(spec(INVOICE, 'paymentTermsDays'), Number.NaN))).toEqual(['non-finite-number'])
    expect(rules(validateFieldValue(spec(INVOICE, 'paymentTermsDays'), Infinity))).toEqual(['non-finite-number'])
  })

  it('money: at most two decimals, a finite number of safe magnitude, never text', () => {
    for (const name of ['taxExclusiveAmount', 'taxAmount', 'taxInclusiveAmount', 'amountAfterCreditNotes', 'outstandingAmount', 'allocatedReceiptsAmount', 'contraAmount']) {
      expect(fieldRules(INVOICE, { [name]: 12.34 }), name).toEqual([])
      expect(fieldRules(INVOICE, { [name]: 12.345 }), name).toEqual(['excess-precision'])
      expect(fieldRules(INVOICE, { [name]: 1e16 }), name).toEqual(['unsafe-magnitude'])
      expect(rules(validateFieldValue(spec(INVOICE, name), Number.NaN)), name).toEqual(['non-finite-number'])
    }
  })

  it('money without a currency is refused; a currency the registry does not allow is refused; a stated currency settles it', () => {
    const { invoiceCurrency: _omit, ...noCurrency } = validInvoice()
    expect(extractionRules(INVOICE, { instanceKey: 'inv-0847', values: noCurrency })).toEqual(['currency-missing'])
    expect(fieldRules(INVOICE, { invoiceCurrency: 'XXX' })).toEqual(['currency-not-allowed'])
    expect(fieldRules(INVOICE, { invoiceCurrency: 'myr' })).toEqual(['currency-not-allowed'])
    expect(extractionRules(INVOICE, { instanceKey: 'inv-0847', values: { ...validInvoice(), invoiceCurrency: 'USD' } })).toEqual([])
    // An amount in a currency with no minor unit cannot carry decimals.
    expect(extractionRules(INVOICE, { instanceKey: 'inv-0847', values: { ...validInvoice(), invoiceCurrency: 'VND', taxAmount: 7200.5 } })).toContain('excess-precision')
  })

  it('myInvoisValidatedAt is an ISO 8601 instant with an offset, a real moment, not in the future', () => {
    const at = (v: unknown) => fieldRules(INVOICE, { myInvoisValidatedAt: v })
    expect(at('2026-08-14T15:42:00+08:00')).toEqual([])
    expect(at('2026-08-14T07:42:00Z')).toEqual([])
    expect(at('2026-08-14T07:42:00.123Z')).toEqual([])
    expect(at('2026-08-14T07:42Z')).toEqual([])
    expect(at('2026-08-14')).toEqual(['invalid-date'])
    expect(at('2026-08-14T15:42:00')).toEqual(['invalid-date'])
    expect(at('2026-08-14 15:42:00+08:00')).toEqual(['invalid-date'])
    expect(at('2026-08-14T25:00:00Z')).toEqual(['invalid-date'])
    expect(at('2026-08-14T23:60:00Z')).toEqual(['invalid-date'])
    expect(at('2026-02-30T10:00:00Z')).toEqual(['invalid-date'])
    expect(at('2026-08-14T10:00:00+15:00')).toEqual(['invalid-date'])
    // The ceiling is the clock's UTC day plus one (2026-09-25): that whole day is allowed, the next is not.
    expect(at('2026-09-25T23:59:59Z')).toEqual([])
    expect(at('1900-01-01T00:00:00Z')).toEqual([])
    expect(at('1899-12-31T23:59:59Z')).toEqual(['implausible-date'])
    expect(at('2026-09-26T00:00:00Z')).toEqual(['implausible-date'])
    expect(at('2099-01-01T00:00:00Z')).toEqual(['implausible-date'])
  })

  it('strings: text rules still apply (blank, placeholder, untrimmed, structure, length)', () => {
    expect(fieldRules(INVOICE, { invoiceNumber: '' })).toEqual(['blank-string'])
    expect(fieldRules(INVOICE, { invoiceNumber: 'N/A' })).toEqual(['placeholder'])
    expect(fieldRules(INVOICE, { invoiceNumber: ' IV-1' })).toEqual(['untrimmed'])
    expect(fieldRules(INVOICE, { invoiceNumber: '{"a":1}' })).toEqual(['serialized-structure'])
    expect(fieldRules(INVOICE, { platformInvoiceId: 'x'.repeat(129) })).toEqual(['max-length'])
    expect(fieldRules(INVOICE, { myInvoisUuid: 'x'.repeat(65) })).toEqual(['max-length'])
    expect(fieldRules(INVOICE, { invoiceNumber: 'x'.repeat(129) })).toEqual(['max-length'])
    expect(fieldRules(INVOICE, { taxType: 'x'.repeat(33) })).toEqual(['max-length'])
    expect(fieldRules(INVOICE, { taxType: 'x'.repeat(32) })).toEqual([])
    expect(fieldRules(BUYER, { buyerTin: 'x'.repeat(21) })).toEqual(['max-length'])
    expect(fieldRules(SELLER, { sellerTin: 'x'.repeat(21) })).toEqual(['max-length'])
    expect(fieldRules(SELLER, { sellerTin: 'x'.repeat(20) })).toEqual([])
    expect(fieldRules(BUYER, { buyerMasterDataId: 'x'.repeat(129) })).toEqual(['max-length'])
    expect(fieldRules(SELLER, { sellerTin: 'C12​3' })).toEqual(['invisible-characters'])
    expect(fieldRules(SELLER, { sellerSsmNumber: 'x'.repeat(31) })).toEqual(['max-length'])
  })

  it('identity: an instance with none of its identifying fields is refused', () => {
    expect(extractionRules(INVOICE, { instanceKey: 'k', values: { invoiceNumber: 'IV-1' } })).toEqual(['missing-identity'])
    expect(extractionRules(INVOICE, { instanceKey: 'k', values: { platformInvoiceId: 'inv-1' } })).toEqual([])
    expect(extractionRules(INVOICE, { instanceKey: 'k', values: { myInvoisUuid: 'F9C2K7M4Q8W3R6T1Y5U2I9O0P4' } })).toEqual([])
    // Every field of a buyer or a seller identifies it, so an instance with none is empty.
    expect(extractionRules(BUYER, { instanceKey: 'k', values: {} })).toEqual(['empty-instance'])
    expect(extractionRules(BUYER, { instanceKey: 'k', values: { buyerTin: 'C2584563200' } })).toEqual([])
    expect(extractionRules(SELLER, { instanceKey: 'k', values: {} })).toEqual(['empty-instance'])
    expect(extractionRules(SELLER, { instanceKey: 'k', values: { sellerSsmNumber: '202101023456' } })).toEqual([])
  })

  it('a buyer with no TIN is still a valid record (the listing gate refuses it, not the write)', () => {
    expect(extractionRules(BUYER, { instanceKey: 'k', values: { buyerMasterDataId: 'contact-9912' } })).toEqual([])
  })
})

describe('SYS-3995 the datetime format is a loader-checked, string-only declaration', () => {
  const raw = (fields: Array<Record<string, unknown>>) => ({
    schemaVersion: '1.0.0',
    categories: [{ id: 'x-cat', displayName: 'X', description: 'd', canonicalTable: 'ihs_alt_data_x', egressClass: 'contributable', fields }],
  })

  it('accepts format "datetime" on a string, and mayBeFuture beside it', () => {
    expect(() => buildCategoryRegistry(raw([{ name: 'xWhen', type: 'string', format: 'datetime', description: 'd' }]) as never)).not.toThrow()
    expect(() => buildCategoryRegistry(raw([{ name: 'xWhen', type: 'string', format: 'datetime', mayBeFuture: true, description: 'd' }]) as never)).not.toThrow()
  })

  it('refuses it on a non-string, beside a pattern, and an unknown format name', () => {
    expect(() => buildCategoryRegistry(raw([{ name: 'xWhen', type: 'number', format: 'datetime', description: 'd' }]) as never)).toThrow(/format.*string/)
    expect(() => buildCategoryRegistry(raw([{ name: 'xWhen', type: 'string', format: 'datetime', pattern: '.+', description: 'd' }]) as never)).toThrow(/format AND a pattern/)
    expect(() => buildCategoryRegistry(raw([{ name: 'xWhen', type: 'string', format: 'timestamp', description: 'd' }]) as never)).toThrow(/format "timestamp"/)
  })

  it('a datetime cannot stand in for a date in notAfter or periodFields', () => {
    expect(() =>
      buildCategoryRegistry(
        raw([
          { name: 'xA', type: 'string', format: 'datetime', notAfter: 'xB', description: 'd' },
          { name: 'xB', type: 'string', format: 'datetime', description: 'd' },
        ]) as never,
      ),
    ).toThrow(/notAfter/)
  })
})

describe('SYS-3995 cost: validation time per record', () => {
  it('a full invoice validates in well under a millisecond on average (reported, loosely bounded)', () => {
    const v = validInvoice()
    const runs = 2000
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) validateAdapterExtraction(INVOICE, { instanceKey: 'inv-0847', values: v }, { now: NOW })
    const perRecordMs = (performance.now() - t0) / runs
    expect(perRecordMs).toBeLessThan(5)
  })
})
