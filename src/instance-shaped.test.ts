import { describe, it, expect } from 'vitest'
import {
  processIhsDetails,
  groupDetailsByCategory,
  processIhsDetailsFromView,
  documentCategoryIds,
  extractionCategoryOf,
  buildDocumentRowsFromView,
  documentHashOfKey,
  documentHashOfPath,
  legacyOrdinalOfKey,
  APPLICATION_RECORD_CURRENCY_FIELDS,
  registryMoneyLegacyNames,
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
    const ambiguousOutsideDocs = [...seen].filter(([k, keys]) => keys.length > 1 && !(docs as ReadonlySet<string>).has(k.split('|')[0]!))
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
    // 'default' rather than '': a vendor adapter's key on a single-cardinality
    // category. Cardinality deliberately OMITTED — the API omits it when no
    // manifest is reachable — so the fallback rule cannot lean on it.
    'applicant-identity': { instances: [inst('default', { personName: 'Gita Ismail', personIdNumber: '831218975125' })] },
    'applicant-contact': {
      cardinality: 'multi',
      instances: [inst('email', { contactValue: 'gita@example.test' }), inst('mobile', { contactValue: '+60175715073' })],
    },
    'company-profile': { cardinality: 'multi', instances: [inst('ssm:abc', { companyName: 'Granite Holdings' })] },
    // companyRegNo reverse-maps to a form-spec-VISIBLE category ("Company
    // Information"), so a broken exclusion set would inject it into the
    // compared output rather than hide in General.
    'company-registration': { cardinality: 'multi', instances: [inst('form9:def', { companyRegNo: '123456-X' })] },
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

  it('two producers on one key: emits both, the second under a name that says what it is — never throws, never overwrites', () => {
    const v = view({
      'applicant-identity': {
        cardinality: 'single',
        instances: [inst('', { personName: 'A' }, { adapterId: 'vendor-a' }), inst('', { personName: 'B' }, { adapterId: 'vendor-b' })],
      },
    })
    const details = processIhsDetailsFromView(v)
    // Both VISIBLE, same group, the second labeled by its producer — a
    // disagreement between producers is what a reviewer should see, not
    // something a render helper hides or dies on.
    expect(details.map((d) => [d.name, d.displayName, d.value, d.category])).toEqual([
      ['fullName', 'Full Name', 'A', 'Basic Information'],
      ['applicant-identity/personName@vendor-b', 'Full Name (vendor-b)', 'B', 'Basic Information'],
    ])
  })

  it('three producers sharing one (instanceKey, adapterId, field) each get a unique name — the disambiguated name is itself collision-checked', () => {
    // All three share instanceKey '' and adapterId 'vendor-a': the second
    // producer's disambiguated name (`…@vendor-a`) is never itself checked
    // against `seen`, so a naive fix (disambiguate once, don't loop) still
    // collides the second and third producers on the identical string.
    const v = view({
      'applicant-identity': {
        cardinality: 'single',
        instances: [
          inst('', { personName: 'A' }, { adapterId: 'vendor-a' }),
          inst('', { personName: 'B' }, { adapterId: 'vendor-a' }),
          inst('', { personName: 'C' }, { adapterId: 'vendor-a' }),
        ],
      },
    })
    const details = processIhsDetailsFromView(v)
    const names = details.map((d) => d.name)
    expect(new Set(names).size).toBe(details.length)
    expect(details.map((d) => d.value)).toEqual(['A', 'B', 'C'])
  })

  it('the fallback to a keyless entry is offered only where the map holds no keyed entry for the field', () => {
    // contactValue HAS keyed entries (email, mobile): an unknown key must NOT fall back to either.
    const v = view({ 'applicant-contact': { instances: [inst('fax', { contactValue: '+6031234' })] } })
    expect(processIhsDetailsFromView(v)[0]).toMatchObject({ name: 'applicant-contact/fax/contactValue', category: 'General' })
  })

  it('an instanceKey outside the keyed set, on a field that HAS keyed entries elsewhere, lands in General rather than falling back to the keyless entry', () => {
    // addressLine1/2/3 are the only (category, field) pairs the map holds
    // BOTH a keyless v1 key (`addressLine1`) and keyed ones (office /
    // permanent / residential) for. 'business' is none of those three, so
    // the keyed lookup misses — and because v1AddressHasKeyedEntries is true
    // for this field, the gate must NOT fall back to the keyless entry.
    const v = view({ 'applicant-address': { cardinality: 'multi', instances: [inst('business', { addressLine1: '123 Jalan Test' })] } })
    const [d] = processIhsDetailsFromView(v)
    expect(d).toMatchObject({ name: 'applicant-address/business/addressLine1', category: 'General' })
  })

  it('a category present with no `instances` does not throw — the API can serve that shape', () => {
    // Sibling functions (documentsOfType et al.) already guard `?.instances
    // ?? []`; the API can omit `instances` on a category the same way it
    // omits `cardinality`. Cast past the type (which declares it required)
    // to model the real, untyped payload.
    const v = {
      ihsId: 1,
      categories: {
        'applicant-identity': { instances: [inst('default', { personName: 'Gita Ismail' })] },
        'telco-carrier': { cardinality: 'multi' },
      },
    } as unknown as CanonicalView
    expect(() => processIhsDetailsFromView(v)).not.toThrow()
    const details = processIhsDetailsFromView(v)
    expect(details.some((d) => d.name === 'fullName')).toBe(true)
  })

  it('DECISION (SYS-3334 sweep): value === false is dropped on BOTH paths — inherited v1 behavior, not re-derived, awaiting a product call', () => {
    // v1's filter has the identical line (processIhsDetails, above). Now
    // that boolean-typed registry fields exist (telco-carrier.
    // handsetFinancingActive, social-media.verifiedBusinessAccount,
    // financial-statement.consolidated), this is no longer hypothetical: a
    // lender cannot distinguish "false" from "never asked" in either panel.
    // NOT fixed here — parity with the flat path is the contract, and the
    // flat path drops it too, so changing one side breaks the side-by-side
    // comparison the whole SYS-3334 release measures against. Whether
    // `false` should render is Kain's call, not this processor's.
    const flat = processIhsDetails({ handsetFinancingActive: false })
    expect(flat.some((d) => d.name === 'handsetFinancingActive')).toBe(false)

    const v = view({ 'telco-carrier': { cardinality: 'single', instances: [inst('default', { handsetFinancingActive: false })] } })
    expect(processIhsDetailsFromView(v).some((d) => d.name === 'handsetFinancingActive')).toBe(false)
  })
})

// ── Extraction status: the three decisions ─────────────────────────

describe('resolveExtractionStatusFromView — a re-derivation, with its decisions pinned', () => {
  it('DECISION 3: the denominator is the registry field set — pinned NEXT TO the flat path\'s, so neither drifts unseen', () => {
    // The registry side.
    expect(Object.fromEntries(getDocumentTypeGroups().map((g) => [g.documentType, categoryFieldsOf(extractionCategoryOf(g.documentType)!).length]))).toEqual({
      bankStatements: 8,
      financialStatements: 122,
      form9: 3,
      ssm: 16,
      ic: 9,
      epfStatements: 9,
      payslips: 15,
    })
    // The flat path's side, measured on a record with ONE file per type: the
    // wide table's slot width. Equal for six types. Financial statements: 13
    // on the first slot (and 0 on the second — v1's financial slots were
    // misaligned with its documents), so the only visible denominator change
    // on the flip is 13 → 122 there, and it is a correction.
    const oneOfEach = {
      bankStatements: '[{"path":"https://x/a"}]', financialStatements: '[{"path":"https://x/b"}]',
      form9: 'https://x/c', ssm: 'https://x/d', ic: 'https://x/e',
      epfStatements: '[{"path":"https://x/f"}]', payslips: '[{"path":"https://x/g"}]',
    }
    const flat = resolveExtractionStatus(oneOfEach)
    expect(Object.fromEntries(flat.documents.map((d) => [d.fileType, d.totalColumns]))).toEqual({
      bankStatements: 8, financialStatements: 13, form9: 3, ssm: 16, ic: 9, epfStatements: 9, payslips: 15,
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

  it('a positional job never lands on an extraction-only document — it was never in the pointer array', () => {
    const v = view({
      'document-intake': {
        cardinality: 'multi',
        instances: [inst('bankStatements#1', { documentType: 'bankStatements', pathInDms: `${DMS}${hashA}` })],
      },
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [inst(`bankStatement:${hashA}`, { closingBalance: 1 }), inst(`bankStatement:${hashB}`, { closingBalance: 2 })],
      },
    })
    const jobs = [
      { fileType: 'bankStatements', status: ExtractionJobStatus.Failed, errorMessage: 'for the intake doc' },
      { fileType: 'bankStatements', status: ExtractionJobStatus.Processing },
    ]
    const bank = resolveExtractionStatusFromView(v, jobs).documents.filter((d) => d.fileType === 'bankStatements')
    expect(bank.map((d) => [d.documentId, d.status, d.errorMessage ?? null, d.unlinked ?? false])).toEqual([
      [hashA, DocExtractionStatus.Extracted, 'for the intake doc', false], // failed job + data → Extracted with the message, as v1
      [hashB, DocExtractionStatus.Extracted, null, true], // job[1] NOT applied; extraction-only is observable
    ])
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

// ── SYS-3378: document rows from the view ──────────────────────────

describe('buildDocumentRowsFromView — the documents table, from intake instances', () => {
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const hashD = 'd'.repeat(64)
  const v = view({
    'document-intake': {
      cardinality: 'multi',
      instances: [
        inst('bankStatements#1', { documentType: 'bankStatements', pathInDms: `${DMS}${hashA}`, uploadedAt: '2026-08-01T00:00:00.000Z', uploadedBy: 'agent:7' }),
        inst('bankStatements#2', { documentType: 'bankStatements', pathInDms: `${DMS}${hashB}?sig=x` }, { observedAt: '2026-08-02T00:00:00.000Z' }),
        inst('ssm#3', { documentType: 'ssm', pathInDms: `${DMS}${'e'.repeat(64)}` }),
        // A type the table does not show: dropped, as v1 dropped pointer columns outside DOC_DISPLAY_NAMES.
        inst('invoices#4', { documentType: 'invoices', pathInDms: `${DMS}${'f'.repeat(64)}` }),
      ],
    },
    'finxtract-bank-statement': {
      cardinality: 'multi',
      // hashD: extracted, no intake row — a pre-writer upload. Still a document, still a row.
      instances: [inst(`bankStatement:${hashA}`, { closingBalance: 1 }), inst(`bankStatement:${hashD}`, { closingBalance: 2 })],
    },
  })

  it('emits rows in DOC_DISPLAY_NAMES order, intake first then extracted-only, with the hash as documentId', () => {
    const rows = buildDocumentRowsFromView(v)
    expect(rows.map((r) => [r.docType, r.index, r.documentId])).toEqual([
      ['bankStatements', 0, hashA],
      ['bankStatements', 1, hashB],
      ['bankStatements', 2, hashD],
      ['ssm', 0, 'e'.repeat(64)],
    ])
    expect(rows.some((r) => r.docType === 'invoices')).toBe(false)
  })

  it('takes uploadedAt from the instance (field, else observedAt), uploadedBy from the field, and metadata from the sibling map first', () => {
    const rows = buildDocumentRowsFromView(v, { [`${DMS}${hashA}`]: { fileName: 'jan.pdf', fileType: 'application/pdf', fileSize: 1234, createdAt: null } })
    expect(rows[0]).toMatchObject({ fileName: 'jan.pdf', fileType: 'PDF', fileSize: 1234, uploadedAt: '2026-08-01T00:00:00.000Z', uploadedBy: 'agent:7', displayName: 'jan.pdf' })
    expect(rows[1]).toMatchObject({ fileName: null, uploadedAt: '2026-08-02T00:00:00.000Z', displayName: 'Bank Statements 2', path: `${DMS}${hashB}?sig=x` })
    expect(rows[2]).toMatchObject({ path: null, uploadedAt: null, displayName: 'Bank Statements 3', capabilities: { download: true, viewJson: true, reExtract: true, reUpload: true } })
    expect(rows[3]).toMatchObject({ displayName: 'SSM Company Profile', capabilities: { viewJson: true } })
  })

  it('aligns with resolveExtractionStatusFromView by (docType, index) AND by documentId — one order, one function', () => {
    const rows = buildDocumentRowsFromView(v)
    const status = resolveExtractionStatusFromView(v).documents.filter((d) => d.fileType === 'bankStatements')
    expect(status.map((d) => d.documentId)).toEqual(rows.filter((r) => r.docType === 'bankStatements').map((r) => r.documentId))
    expect(status.map((d) => d.status)).toEqual([DocExtractionStatus.Extracted, DocExtractionStatus.Unknown, DocExtractionStatus.Extracted])
  })

  it('period is not carried by an upload: timePeriod ALL, periodLabel null — stated, not accidental', () => {
    for (const r of buildDocumentRowsFromView(v)) expect([r.timePeriod, r.periodLabel]).toEqual(['ALL', null])
  })
})

describe('documentHashOfKey / documentHashOfPath / legacyOrdinalOfKey', () => {
  it('strips the prefix and the period suffix; treats a bare key as its own identity; a legacy slot key has none', () => {
    expect(documentHashOfKey('bankStatement:abc')).toBe('abc')
    expect(documentHashOfKey('financialStatement:abc#T2')).toBe('abc')
    expect(documentHashOfKey('abc')).toBe('abc')
    expect(documentHashOfKey('a:b:c#T1')).toBe('b:c')
    expect(documentHashOfKey('legacy:T1')).toBeNull()
    expect(documentHashOfKey('bankStatement:')).toBeNull()
    expect(legacyOrdinalOfKey('legacy:T3')).toBe(3)
    expect(legacyOrdinalOfKey('bankStatement:abc')).toBeNull()
    expect(documentHashOfPath('https://x/y/HASH?sig=1')).toBe('HASH')
    expect(documentHashOfPath('https://x/y/HASH#frag')).toBe('HASH')
    expect(documentHashOfPath('https://x/y/')).toBeNull()
  })
})

describe('legacy slot rows — positional, as v1 was, and only where identity is absent', () => {
  // The sim carries 143 financial-statement and 33 bank-statement subjects
  // whose ONLY extraction rows are `legacy:T{n}` — no document behind them.
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  it('legacy:T{n} attaches to the n-th intake document when it has no hashed extraction; a hashed run supersedes it; overflow is an observable extraction-only document', () => {
    const v = view({
      'document-intake': {
        cardinality: 'multi',
        instances: [
          inst('financialStatements#1', { documentType: 'financialStatements', pathInDms: `${DMS}${hashA}` }),
          inst('financialStatements#2', { documentType: 'financialStatements', pathInDms: `${DMS}${hashB}` }),
        ],
      },
      'financial-statement': {
        cardinality: 'multi',
        instances: [
          inst(`financialStatement:${hashB}#T1`, { revenue: 9 }), // doc 2, by identity
          inst('legacy:T1', { revenue: 1 }), // doc 1 has no hashed rows → attaches
          inst('legacy:T2', { revenue: 2 }), // doc 2 has hashed rows → superseded duplicate, ignored
          inst('legacy:T3', { revenue: 3 }), // no third intake document → extraction-only, no identity
        ],
      },
    })
    const st = resolveExtractionStatusFromView(v).documents.filter((d) => d.fileType === 'financialStatements')
    expect(st.map((d) => [d.documentId ?? null, d.status, d.populatedColumns, d.unlinked ?? false])).toEqual([
      [hashA, DocExtractionStatus.Extracted, ['revenue'], false],
      [hashB, DocExtractionStatus.Extracted, ['revenue'], false],
      [null, DocExtractionStatus.Extracted, ['revenue'], true],
    ])
    const rows = buildDocumentRowsFromView(v).filter((r) => r.docType === 'financialStatements')
    expect(rows.map((r) => [r.index, r.documentId, r.displayName])).toEqual([
      [0, hashA, 'Financial Statements 1'],
      [1, hashB, 'Financial Statements 2'],
      [2, null, 'Financial Statements 3'],
    ])
    expect(rows[2]!.capabilities.download).toBe(false)
  })

  it('a legacy-only subject with no intake rows at all still renders and counts its slots', () => {
    const v = view({ 'finxtract-bank-statement': { cardinality: 'multi', instances: [inst('legacy:T1', { closingBalance: 5 })] } })
    const bank = resolveExtractionStatusFromView(v).documents.filter((d) => d.fileType === 'bankStatements')
    expect(bank.map((d) => [d.status, d.unlinked ?? false])).toEqual([[DocExtractionStatus.Extracted, true]])
    expect(buildDocumentRowsFromView(v).filter((r) => r.docType === 'bankStatements')).toHaveLength(1)
  })
})

// ── SYS-3259: currency is derived, and the residual is named ───────

describe('inferValueFormat currency — derived from the registry (SYS-3259)', () => {
  it('a registry money field renders as CURRENCY through its legacy name — the four-name set could not', () => {
    // monthlyNetIncome was never in the hand-written set and rendered as a string.
    const details = processIhsDetails({ monthlyNetIncome: '4200.00', monthlyGrossIncome: '6100.00' })
    expect(details.map((d) => [d.name, d.valueFormat])).toEqual([
      ['monthlyNetIncome', IhsValueFormat.CURRENCY],
      ['monthlyGrossIncome', IhsValueFormat.CURRENCY],
    ])
    expect(registryMoneyLegacyNames().size).toBeGreaterThan(400)
  })

  it('the residual set contains ONLY names the registry cannot answer', () => {
    // If a name here ever gains a registry entry, it must leave this set.
    for (const name of APPLICATION_RECORD_CURRENCY_FIELDS) {
      expect(registryMoneyLegacyNames().has(name), `${name} is now derivable — remove it from the residual`).toBe(false)
    }
    expect([...APPLICATION_RECORD_CURRENCY_FIELDS].sort()).toEqual(['approvedAmount', 'monthlyInstallment', 'totalFinancing'])
    expect(processIhsDetails({ totalFinancing: 50000 })[0]!.valueFormat).toBe(IhsValueFormat.CURRENCY)
  })
})
