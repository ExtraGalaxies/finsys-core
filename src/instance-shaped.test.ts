import { describe, it, expect } from 'vitest'
import {
  processIhsDetails,
  groupDetailsByCategory,
  processIhsDetailsFromView,
  documentCategoryIds,
  extractionCategoryOf,
} from './ihs-processing.js'
import { IhsValueFormat } from './ihs-types.js'
import {
  resolveExtractionStatus,
  resolveExtractionStatusFromView,
  DocExtractionStatus,
} from './extraction-status.js'
import { ExtractionJobStatus } from './extraction.js'
import { v1KeyForAddress, v1MigrationKeys, v1Addresses } from './v1-migration-map.js'
import { categoryFieldsOf } from './adapter-categories.js'
import { getDocumentTypeGroups } from './document-types.js'
import type { CanonicalView, CanonicalInstance } from './canonical-view.js'

/**
 * SYS-3334 — the instance-shaped path. Every assertion here pins a DECISION
 * made while re-deriving the flat functions for a CanonicalView, so that a
 * later change to any of them is a change somebody chose. The measurements
 * that motivated each decision were taken against the running sim on
 * 2026-08-18 (157 subjects, both paths on the same record) and are quoted
 * where they matter.
 */

// ── Fixture builders ────────────────────────────────────────────────

const inst = (
  instanceKey: string,
  fields: Record<string, unknown>,
  extra: Partial<CanonicalInstance> = {},
): CanonicalInstance => ({
  instanceKey,
  adapterId: 'fixture',
  adapterVersion: 1,
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, value]) => [k, { value: value as string, confidentiality: 'internal' }]),
  ),
  ...extra,
})

const view = (categories: Record<string, { cardinality?: 'single' | 'multi'; instances: CanonicalInstance[] }>): CanonicalView => ({
  ihsId: 1,
  categories,
})

const DMS = 'https://dms.example/dms-general-storage/'

// ── The bridge: canonical → legacy ──────────────────────────────────

describe('v1KeyForAddress — the reverse of the migration map', () => {
  it('splits a multi-instance field by instance key, and matches single-cardinality with or without the empty key', () => {
    expect(v1KeyForAddress('applicant-contact', 'contactValue', 'email')).toBe('email')
    expect(v1KeyForAddress('applicant-contact', 'contactValue', 'mobile')).toBe('mobilePhoneNo')
    expect(v1KeyForAddress('applicant-identity', 'personName')).toBe('fullName')
    expect(v1KeyForAddress('applicant-identity', 'personName', '')).toBe('fullName')
  })

  it('refuses a T-slot family rather than guessing which slot', () => {
    // bankBalanceT1..T6 all map here; there is no single answer, and "T1"
    // would label six documents' balances with one period.
    expect(v1KeyForAddress('finxtract-bank-statement', 'closingBalance')).toBeNull()
  })

  it('answers null for an address no v1 key ever held, and for a needs-decision key', () => {
    expect(v1KeyForAddress('no-such-category', 'x')).toBeNull()
    // phoneNumber is `needs-decision` in the map (its instance kind is
    // unknowable from the schema); it must not resolve to any address.
    expect(v1Addresses('phoneNumber')).toEqual([])
  })

  it('every ambiguity lives in a document category — the detail panel never meets one', () => {
    // If a non-document category ever had two v1 keys for one address, the
    // detail processor would silently drop both (null → canonical name →
    // General → filtered). Prove that cannot happen with today's map.
    const docs = documentCategoryIds()
    const seen = new Map<string, string[]>()
    for (const key of v1MigrationKeys()) {
      for (const a of v1Addresses(key)) {
        if (a.instanceKeyPrefix) continue
        const k = `${a.category}|${a.field}|${a.instanceKey ?? ''}`
        seen.set(k, [...(seen.get(k) ?? []), key])
      }
    }
    const ambiguousOutsideDocs = [...seen].filter(([k, keys]) => keys.length > 1 && !docs.has(k.split('|')[0]!))
    expect(ambiguousOutsideDocs).toEqual([])
  })
})

// ── Which categories are "document" categories ─────────────────────

describe('extractionCategoryOf / documentCategoryIds — derived, not listed', () => {
  it('names one extraction category per document type, through the map', () => {
    // Pinned so a registry or map edit that moves a document type is a
    // change somebody sees. Form 9 and SSM share the fan-out key
    // incorporatedDate (SYS-2722) and still resolve cleanly — the intersection
    // across a type's columns, not the union.
    expect(Object.fromEntries(getDocumentTypeGroups().map((g) => [g.documentType, extractionCategoryOf(g.documentType)]))).toEqual({
      bankStatements: 'finxtract-bank-statement',
      financialStatements: 'financial-statement',
      form9: 'company-registration',
      ssm: 'company-profile',
      ic: 'person-identity',
      epfStatements: 'epf-statement',
      payslips: 'payslip',
    })
  })

  it('the document categories are those seven plus document-intake, and nothing else', () => {
    expect([...documentCategoryIds()].sort()).toEqual(
      ['company-profile', 'company-registration', 'document-intake', 'epf-statement', 'financial-statement', 'finxtract-bank-statement', 'payslip', 'person-identity'].sort(),
    )
  })
})

// ── The detail panel: parity with v1 ────────────────────────────────

describe('processIhsDetailsFromView — the panel v1 rendered, from a v2 view', () => {
  const v1 = {
    fullName: 'Gita Ismail',
    idNumber: '831218975125',
    email: 'gita@example.test',
    mobilePhoneNo: '+60175715073',
    // A document-extracted column: rendered by the file-field tables, never here.
    ssmCompanyName: 'Granite Holdings',
    // A wide column with no form spec: v1 put it in General, and the panel dropped it.
    arpu: 93.46,
    // Excluded outright by both paths.
    id: 9019,
    updatedAt: '2026-08-18T00:00:00.000Z',
  }
  const v2 = view({
    'applicant-identity': { cardinality: 'single', instances: [inst('', { personName: 'Gita Ismail', personIdNumber: '831218975125' })] },
    'applicant-contact': {
      cardinality: 'multi',
      instances: [inst('email', { contactValue: 'gita@example.test' }), inst('mobile', { contactValue: '+60175715073' })],
    },
    'company-profile': { cardinality: 'multi', instances: [inst('ssm:abc', { companyName: 'Granite Holdings' })] },
    'telco-carrier': { cardinality: 'single', instances: [inst('default', { arpu: 93.46 })] },
  })

  it('groups identically to the flat path on the same subject', () => {
    expect(groupDetailsByCategory(processIhsDetailsFromView(v2))).toEqual(groupDetailsByCategory(processIhsDetails(v1)))
  })

  it('emits legacy names and labels where the map has them, and canonical names into General where it does not', () => {
    const details = processIhsDetailsFromView(v2)
    const byName = Object.fromEntries(details.map((d) => [d.name, d]))
    expect(byName.fullName).toMatchObject({ displayName: 'Full Name', category: 'Basic Information', valueFormat: IhsValueFormat.STRING })
    expect(byName.email).toBeDefined()
    expect(byName.mobilePhoneNo).toBeDefined()
    // arpu HAS a v1 key (the wide table carried alt-data), so it keeps that name — and lands in General, as in v1.
    expect(byName.arpu).toMatchObject({ category: 'General' })
    // The document category is excluded entirely.
    expect(details.some((d) => d.name === 'ssmCompanyName' || d.name.includes('companyName'))).toBe(false)
  })

  it('a canonical-only field with no legacy key gets a collision-proof canonical name and lands in General', () => {
    const v = view({ 'applicant-employment': { cardinality: 'multi', instances: [inst('primary', { someBrandNewField: 'x' })] } })
    const [d] = processIhsDetailsFromView(v)
    expect(d).toMatchObject({ name: 'applicant-employment/primary/someBrandNewField', category: 'General' })
    expect(groupDetailsByCategory([d!])).toEqual([])
  })

  it('applies exactly the flat path\'s value filter', () => {
    const v = view({
      'applicant-identity': {
        cardinality: 'single',
        instances: [inst('', { personName: '', personIdNumber: 'Not Specified' })],
      },
    })
    expect(processIhsDetailsFromView(v)).toEqual([])
  })

  it('refuses two instances that resolve to one legacy name rather than overwriting', () => {
    const v = view({
      'applicant-identity': { cardinality: 'single', instances: [inst('', { personName: 'A' }), inst('', { personName: 'B' })] },
    })
    expect(() => processIhsDetailsFromView(v)).toThrow(/two instances of applicant-identity both resolve to detail "fullName"/)
  })
})

// ── Extraction status: the three decisions ─────────────────────────

describe('resolveExtractionStatusFromView — a re-derivation, with its decisions pinned', () => {
  it('DECISION 3: the denominator is the registry field set, and these are the numbers', () => {
    // v1's totalColumns was the wide table's slot width — equal to the
    // registry for four types, narrower for three. Change a number here only
    // on purpose.
    expect(Object.fromEntries(getDocumentTypeGroups().map((g) => [g.documentType, categoryFieldsOf(extractionCategoryOf(g.documentType)! as never).length]))).toEqual({
      bankStatements: 8,
      financialStatements: 122, // v1 slot: 116 mapped (and, per slot, 13 — v1's financial slots were misaligned)
      form9: 3, // v1: 2
      ssm: 16, // v1: 15
      ic: 9,
      epfStatements: 9,
      payslips: 15,
    })
    const v = view({ 'document-intake': { cardinality: 'multi', instances: [] } })
    const r = resolveExtractionStatusFromView(v)
    for (const d of r.documents) expect(d.status).toBe(DocExtractionStatus.NotUploaded)
    expect(r.documents.find((d) => d.fileType === 'bankStatements')!.totalColumns).toBe(8)
    expect(r.documents.find((d) => d.fileType === 'financialStatements')!.totalColumns).toBe(122)
  })

  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const hashC = 'c'.repeat(64)

  it('DECISION 1+2: uploaded = intake ∪ extracted; per-document status by hash, a document is its instances', () => {
    const v = view({
      'document-intake': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatements#1`, { documentType: 'bankStatements', pathInDms: `${DMS}${hashA}` }),
          inst(`bankStatements#2`, { documentType: 'bankStatements', pathInDms: `${DMS}${hashB}` }), // uploaded, never extracted
          inst(`financialStatements#3`, { documentType: 'financialStatements', pathInDms: `${DMS}${hashC}?sig=x` }),
        ],
      },
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatement:${hashA}`, { closingBalance: 100, accountNumber: 'Not Specified' }),
          // Extracted with NO intake row — a pre-writer upload. Still a document.
          inst(`bankStatement:${'d'.repeat(64)}`, { closingBalance: 5 }),
        ],
      },
      'financial-statement': {
        cardinality: 'multi',
        // Two periods of ONE document: one row, populated = union.
        instances: [
          inst(`financialStatement:${hashC}#T1`, { revenue: 10 }),
          inst(`financialStatement:${hashC}#T2`, { financialYearEnd: '2024-12-31' }),
        ],
      },
    })
    const r = resolveExtractionStatusFromView(v)
    const bank = r.documents.filter((d) => d.fileType === 'bankStatements')
    expect(bank.map((d) => [d.status, d.populatedColumns])).toEqual([
      [DocExtractionStatus.Extracted, ['closingBalance']], // accountNumber 'Not Specified' is not populated
      [DocExtractionStatus.Unknown, []], // uploaded, no extraction, no job records → Unknown (as v1)
      [DocExtractionStatus.Extracted, ['closingBalance']], // the pre-writer document
    ])
    const fin = r.documents.filter((d) => d.fileType === 'financialStatements')
    expect(fin).toHaveLength(1)
    expect(fin[0]!.status).toBe(DocExtractionStatus.Extracted)
    expect(fin[0]!.populatedColumns.sort()).toEqual(['financialYearEnd', 'revenue'])
    expect(r.summary).toMatchObject({ extracted: 3, pending: 1 })
  })

  it('job records apply by fileType and order, exactly as the flat path', () => {
    const v = view({
      'document-intake': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatements#1`, { documentType: 'bankStatements', pathInDms: `${DMS}${hashA}` }),
          inst(`bankStatements#2`, { documentType: 'bankStatements', pathInDms: `${DMS}${hashB}` }),
        ],
      },
      'finxtract-bank-statement': { cardinality: 'multi', instances: [] },
    })
    const jobs = [
      { fileType: 'bankStatements', status: ExtractionJobStatus.Processing },
      { fileType: 'bankStatements', status: ExtractionJobStatus.Failed, errorMessage: 'boom' },
    ]
    const bank = resolveExtractionStatusFromView(v, jobs).documents.filter((d) => d.fileType === 'bankStatements')
    expect(bank.map((d) => [d.status, d.errorMessage ?? null])).toEqual([
      [DocExtractionStatus.Processing, null],
      [DocExtractionStatus.Failed, 'boom'],
    ])
    // With job records present but none matching, an un-extracted upload is Uploaded, not Unknown.
    const none = resolveExtractionStatusFromView(v, []).documents.filter((d) => d.fileType === 'bankStatements')
    expect(none.every((d) => d.status === DocExtractionStatus.Uploaded)).toBe(true)
  })

  it('a document not-uploaded reports 0 populated — the flat path could count another source\'s columns', () => {
    // v1 said form9 "NotUploaded 3/3" when SSM or the applicant form had
    // filled companyName/companyRegNo/incorporatedDate; the wide column does
    // not know its writer. The instance does.
    const v = view({
      'company-profile': { cardinality: 'multi', instances: [inst('ssm:x', { companyName: 'Acme', companyRegNo: '1' })] },
    })
    const form9 = resolveExtractionStatusFromView(v).documents.find((d) => d.fileType === 'form9')!
    expect(form9).toMatchObject({ status: DocExtractionStatus.NotUploaded, populatedColumns: [], totalColumns: 3 })
    // and the flat path's behavior, for the record — the same wide columns read as populated:
    const flat = resolveExtractionStatus({ ssm: 'x.pdf', companyName: 'Acme', companyRegNo: '1' })
    expect(flat.documents.find((d) => d.fileType === 'form9')!.status).toBe(DocExtractionStatus.NotUploaded)
  })
})
