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
  buildFileFieldTables,
  instanceRowsFromView,
  buildFileFieldTablesFromView,
  fieldProvenanceFromView,
  flatRecordFromView,
} from './ihs-processing.js'
import type { ApplicationRecordLike } from './ihs-processing.js'
import { IhsValueFormat, FileFieldTableType } from './ihs-types.js'
import {
  resolveExtractionStatus,
  resolveExtractionStatusFromView,
  DocExtractionStatus,
} from './extraction-status.js'
import { ExtractionJobStatus } from './extraction.js'
import { v1KeyForAddress, v1MigrationKeys, v1Addresses, v1LegacyBaseNameOf } from './v1-migration-map.js'
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

// ── The other bridge: canonical → legacy BASE name (T-suffix stripped) ──

describe('v1LegacyBaseNameOf — the T-slot base-name bridge (SYS-3334)', () => {
  it('strips the T-suffix shared by every T-slot in a family — the answer v1KeyForAddress refuses to guess', () => {
    expect(v1LegacyBaseNameOf('finxtract-bank-statement', 'closingBalance')).toBe('bankBalance')
    expect(v1LegacyBaseNameOf('financial-statement', 'revenue')).toBe('revenue')
    expect(v1LegacyBaseNameOf('payslip', 'basicPay')).toBe('payslipBasicPay')
    expect(v1LegacyBaseNameOf('telco-carrier', 'arpu')).toBe('arpu')
    // Three T-slot keys (netProfitT1..T3) share this address and all strip
    // to 'netProfit' — the ordinary case legacyBaseNameIndex's conflict
    // check exists to verify still holds.
    //
    // UPDATED (SYS-3334 round 2, the map correction): this comment used to
    // say the `…PriorYearT{n}` siblings strip to the same base AND attest
    // this SAME address — that was the bug (see the "map correction"
    // describe below). They are `needs-decision` now and carry no address at
    // all, so they no longer contribute to this answer; the value below is
    // unchanged only because the three plain T-slots were always sufficient
    // to determine it on their own.
    expect(v1LegacyBaseNameOf('financial-statement', 'netProfit')).toBe('netProfit')
  })

  it('answers null for a canonical-only field the wide table never had', () => {
    // Declared in the registry, no v1 lineage at all — newer than the wide
    // table (`consolidated`, added to the registry after the wide table's
    // field set was frozen) or never wide-columned (`localNo`).
    expect(v1LegacyBaseNameOf('financial-statement', 'consolidated')).toBeNull()
    expect(v1LegacyBaseNameOf('financial-statement', 'localNo')).toBeNull()
    expect(v1LegacyBaseNameOf('no-such-category', 'x')).toBeNull()
  })

  it('does NOT throw on a multi-key address discriminated by INSTANCE rather than by T-suffix', () => {
    // document-intake/pathInDms has ~20 distinct legacy keys (bankStatements,
    // consentForm, coreIncomeDoc, …), each carrying an instanceKeyPrefix, not
    // a T-suffix; applicant-contact/contactValue has four (email/mobile/
    // office/emergency), each carrying an instanceKey. Both are excluded by
    // legacyBaseNameIndex rather than collapsed into a false conflict — see
    // its doc comment for why stripping T-suffixes from THESE would be wrong.
    expect(v1LegacyBaseNameOf('document-intake', 'pathInDms')).toBeNull()
    expect(v1LegacyBaseNameOf('applicant-contact', 'contactValue')).toBeNull()
  })
})

// ── F1 (CRITICAL, round 2): mapped-fanout admitted into legacyBaseNameIndex ──

describe('F1 — a mapped-fanout address resolves through v1LegacyBaseNameOf instead of vanishing', () => {
  it('incorporatedDate (mapped-fanout: company-profile + company-registration) resolves on BOTH attestors (mutation: exclude mapped-fanout from legacyBaseNameIndex -> null)', () => {
    expect(v1LegacyBaseNameOf('company-profile', 'companyIncorporationDate')).toBe('incorporatedDate')
    expect(v1LegacyBaseNameOf('company-registration', 'companyIncorporationDate')).toBe('incorporatedDate')
  })

  it('the SSM group renders "Incorporated Date" through the view path — the value the bug dropped', () => {
    const v2 = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [inst('ssm:x', { companyName: 'Granite Holdings', companyIncorporationDate: '2019-03-01' })],
      },
    })
    const table = buildFileFieldTablesFromView(v2)['ssm_documents']!
    const item = table.items.find((i) => i.displayName === 'Incorporated Date')
    expect(item).toBeDefined()
    expect(item!.data['T1']).toBe('2019-03-01')
  })

  it('the Form 9 group renders the SAME "Incorporated Date" column — the other fanout attestor', () => {
    const v2 = view({
      'company-registration': {
        cardinality: 'multi',
        instances: [inst('form9:x', { companyIncorporationDate: '2019-03-01' })],
      },
    })
    const table = buildFileFieldTablesFromView(v2)['form9']!
    const item = table.items.find((i) => i.displayName === 'Incorporated Date')
    expect(item).toBeDefined()
    expect(item!.data['T1']).toBe('2019-03-01')
  })

  it('names the parity delta: derives the unreachable financials set from the catalog + map at runtime — exactly {currentAssetCash, tangibleAssets}', () => {
    // "Derives", not "lists": if a third catalog base name ever loses its
    // address (or one of these two gains one), this recomputes from the
    // live catalog + map rather than comparing against a hand-written list,
    // so it fails the moment the set changes rather than silently agreeing
    // with a stale expectation.
    const group = getDocumentTypeGroups().find((g) => g.documentType === 'financialStatements')!
    const category = extractionCategoryOf(group.documentType)!

    const catalogBaseNames = new Set<string>()
    for (const field of group.fields) {
      for (const col of field.ihs_column_names ?? []) {
        catalogBaseNames.add(col.replace(/T\d+$/, ''))
      }
    }

    const reachable = new Set<string>()
    for (const field of categoryFieldsOf(category)) {
      const base = v1LegacyBaseNameOf(category, field)
      if (base !== null) reachable.add(base)
    }

    const unreachable = [...catalogBaseNames].filter((b) => !reachable.has(b)).sort()
    expect(unreachable).toEqual(['currentAssetCash', 'tangibleAssets'])
  })

  it('M3 (round 4): the SAME derivation, over EVERY document-type group, not just financials — a base column losing its address in ANY group goes red, not only in the one this suite happened to pick', () => {
    const unreachableByGroup: Record<string, string[]> = {}
    for (const group of getDocumentTypeGroups()) {
      const category = extractionCategoryOf(group.documentType)

      const catalogBaseNames = new Set<string>()
      for (const field of group.fields) {
        for (const col of field.ihs_column_names ?? []) {
          catalogBaseNames.add(col.replace(/T\d+$/, ''))
        }
      }

      const reachable = new Set<string>()
      if (category !== null) {
        for (const field of categoryFieldsOf(category)) {
          const base = v1LegacyBaseNameOf(category, field)
          if (base !== null) reachable.add(base)
        }
      }

      unreachableByGroup[group.documentGroup] = [...catalogBaseNames].filter((b) => !reachable.has(b)).sort()
    }

    expect(unreachableByGroup).toEqual({
      bank_statements: [],
      financials: ['currentAssetCash', 'tangibleAssets'],
      form9: [],
      ssm_documents: [],
      ic_documents: [],
      epf_statements: [],
      payslip_statements: [],
    })
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
        // SYS-3376: `invoices` is a host pointer slot (finsys-api's
        // IHS_DOCUMENT_POINTER_FIELDS, extraction: true) that the catalog did
        // not name, so an uploaded invoice rendered in NEITHER product. It is a
        // row now, in catalog order (after payslips, before ssm).
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
      ['invoices', 0, 'f'.repeat(64)],
      ['ssm', 0, 'e'.repeat(64)],
    ])
    const invoice = rows.find((r) => r.docType === 'invoices')!
    expect(invoice.label).toBe('Invoices')
    expect(invoice.capabilities.reExtract).toBe(true)
  })

  it('takes uploadedAt from the instance (field, else observedAt), uploadedBy from the field, and metadata from the sibling map first', () => {
    const rows = buildDocumentRowsFromView(v, { [`${DMS}${hashA}`]: { fileName: 'jan.pdf', fileType: 'application/pdf', fileSize: 1234, createdAt: null } })
    expect(rows[0]).toMatchObject({ fileName: 'jan.pdf', fileType: 'PDF', fileSize: 1234, uploadedAt: '2026-08-01T00:00:00.000Z', uploadedBy: 'agent:7', displayName: 'jan.pdf' })
    expect(rows[1]).toMatchObject({ fileName: null, uploadedAt: '2026-08-02T00:00:00.000Z', displayName: 'Bank Statements 2', path: `${DMS}${hashB}?sig=x` })
    expect(rows[2]).toMatchObject({ path: null, uploadedAt: null, displayName: 'Bank Statements 3', capabilities: { download: true, viewJson: true, reExtract: true, reUpload: true } })
    // rows[3] is the invoice since SYS-3376; SSM is the last row.
    expect(rows[3]).toMatchObject({ displayName: 'Invoices', capabilities: { viewJson: true, reUpload: false } })
    expect(rows[4]).toMatchObject({ displayName: 'SSM Company Profile', capabilities: { viewJson: true } })
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

// ── F4 (round 2): legacySlot — the wire's own v1 slot beats every derived rule ──

describe('timePeriodOf cascade — instance.legacySlot outranks the #T{n} suffix and the position fallback (SYS-3334 F4, round 2)', () => {
  it('rule 1: legacySlot wins verbatim over the position fallback (mutation: drop rule 1 -> T1)', () => {
    // Positioned FIRST (and thus rule-4-fallback would say T1), but the wire
    // says T3 — the actual v1 slot the source row stored, not a re-derivation.
    const v2 = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [inst('ssm:x', { companyName: 'Granite Holdings' }, { legacySlot: 'T3' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'company-profile')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.timePeriod).toBe('T3')
  })

  it('rule 1 beats rule 2: a #T2 hash-suffixed key with legacySlot T3 renders T3 — the wire\'s own slot beats the key\'s (mutation: drop rule 1 -> T2)', () => {
    const hash = 'd'.repeat(64)
    const v2 = view({
      'financial-statement': {
        cardinality: 'multi',
        instances: [inst(`financialStatement:${hash}#T2`, { netProfit: 1000 }, { legacySlot: 'T3' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'financial-statement')
    expect(rows[0]!.timePeriod).toBe('T3')
  })

  it('sourceLabel: the wire\'s own per-instance label wins over the registry-derived bank name (mutation: drop the wire check -> CIMB)', () => {
    const hash = 'e'.repeat(64)
    const v2 = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [inst(`bankStatement:${hash}`, { issuingBankName: 'CIMB' }, { sourceLabel: 'Maybank (wire)' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'finxtract-bank-statement')
    expect(rows[0]!.sourceLabel).toBe('Maybank (wire)')
  })

  it('sourceLabel: the registry fallback still applies when the wire carries none', () => {
    const hash = 'f'.repeat(64)
    const v2 = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [inst(`bankStatement:${hash}`, { issuingBankName: 'CIMB' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'finxtract-bank-statement')
    expect(rows[0]!.sourceLabel).toBe('CIMB')
  })

  it('M4 (round 4): an out-of-shape legacySlot is REJECTED, not consumed verbatim — falls through to the position rule instead (mutation: drop the LEGACY_SLOT_SHAPE check -> the junk value renders as the header)', () => {
    const v2 = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [inst(`bankStatement:${'1'.repeat(64)}`, { closingBalance: 5000 }, { legacySlot: '2026-06' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'finxtract-bank-statement')
    // Rejected: '2026-06' does not match /^T[1-9]\d*$/, so rule 1 does not
    // fire — falls through to rule 4 (position fallback), the only instance
    // of its category -> 'T1'. NOT the junk string in the header.
    expect(rows[0]!.timePeriod).toBe('T1')
  })

  it('M4 (round 4): a trailing space is REJECTED, not trimmed (mutation: trim before validating -> "T5 " would trim-and-pass as "T5")', () => {
    const v2 = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        // 'T5 ' would trim to a VALID shape ('T5') if this were trim-then-
        // validate — a visibly different header from the position fallback
        // ('T1', the only instance), so accept-after-trim and reject-outright
        // cannot be confused with each other here.
        instances: [inst(`bankStatement:${'2'.repeat(64)}`, { closingBalance: 5000 }, { legacySlot: 'T5 ' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'finxtract-bank-statement')
    expect(rows[0]!.timePeriod).toBe('T1')
  })

  it('M4 (round 4): the rejection is visible even when it disagrees with the position fallback (proves rejection, not coincidence)', () => {
    // Two instances: the first (position 0, would fall back to 'T1') has an
    // out-of-shape legacySlot; the second (position 1) is clean. If the
    // out-of-shape value were accepted verbatim, the first row's header
    // would read 'T01' — not a valid T-slot shape at all. Rejecting it
    // falls through to position 0 -> 'T1', same as if legacySlot were absent.
    const v2 = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatement:${'3'.repeat(64)}`, { closingBalance: 1000 }, { legacySlot: 'T01' }),
          inst(`bankStatement:${'4'.repeat(64)}`, { closingBalance: 2000 }),
        ],
      },
    })
    const rows = instanceRowsFromView(v2, 'finxtract-bank-statement')
    expect(rows.map((r) => r.timePeriod)).toEqual(['T1', 'T2'])
  })
})

// ── F6 (round 2): instanceKey '' with no period never renders a blank header ──

describe('F6 — a single-cardinality instanceKey \'\' with no period gets a real label, never \'\'', () => {
  it('the ONLY instance of its category renders T1 — a single-cardinality category\'s one instance IS slot 1 (mutation: remove the guard -> \'\')', () => {
    const v2 = view({
      'applicant-identity': { instances: [inst('', { personName: 'Solo Row' })] },
    })
    const rows = instanceRowsFromView(v2, 'applicant-identity')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.timePeriod).toBe('T1')
  })

  it('TWO instances sharing instanceKey \'\' (a data anomaly — neither IS "the" one instance) label by array position, never blank (mutation: remove the guard -> \'\',\'\')', () => {
    const v2 = view({
      'applicant-identity': {
        instances: [inst('', { personName: 'Row A' }), inst('', { personName: 'Row B' })],
      },
    })
    const rows = instanceRowsFromView(v2, 'applicant-identity')
    expect(rows.map((r) => r.timePeriod)).toEqual(['#1', '#2'])
  })
})

// ── SYS-3334: buildFileFieldTablesFromView — the fourth flat function's instance-shaped sibling ──

describe('buildFileFieldTablesFromView — buildFileFieldTables\'s last instance-shaped sibling', () => {
  const hash1 = 'a'.repeat(64)
  const hash2 = 'b'.repeat(64)

  it('(a) two bank-statement instances, SPARSELY populated (M2, round 4 — 3 of 8 base columns, not all 8): view items are a SUBSET of flat items, values equal by position on the ones both sides have', () => {
    // M2 (round 4): the PREVIOUS version of this fixture populated all 8
    // base columns on both instances, which is the only reason it could
    // assert full item-LIST equality between the two paths — `buildInstanceTable`
    // DROPS a base column with no value in ANY instance
    // (`if (!hasAny) continue`), while v1's TIME_SERIES branch has no such
    // guard and renders one item per CATALOG base column regardless of
    // data. With everything populated, that difference never had a chance
    // to fire, so the equality the old comment stated was a fixture
    // artifact, not a real invariant. Sparsened to 3 of 8 so it does.
    //
    // v1 and v2 built from the SAME numbers on the 3 populated columns, so
    // any divergence there is either a stated structural difference (below)
    // or a real bug.
    const v1 = {
      bankNameT1: 'Maybank', bankNameT2: 'Maybank',
      statementDateT1: '2026-06-30', statementDateT2: '2026-07-31',
      bankBalanceT1: 12000, bankBalanceT2: 14100,
    }
    const v2 = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatement:${hash1}`, {
            issuingBankName: 'Maybank', statementDate: '2026-06-30', closingBalance: 12000,
          }),
          inst(`bankStatement:${hash2}`, {
            issuingBankName: 'Maybank', statementDate: '2026-07-31', closingBalance: 14100,
          }),
        ],
      },
    })

    const flatTable = buildFileFieldTables(v1)['bank_statements']!
    const viewTable = buildFileFieldTablesFromView(v2)['bank_statements']!

    // Table-level shape is identical.
    expect([viewTable.name, viewTable.displayName, viewTable.type, viewTable.hasData]).toEqual([
      flatTable.name, flatTable.displayName, flatTable.type, flatTable.hasData,
    ])

    // ITEM COUNT is NOT equal — the point of this test (see the STATED
    // DIFFERENCE below). v1 renders all 8 catalog base columns; v2 renders
    // only the 3 that came back.
    expect(flatTable.items).toHaveLength(8)
    expect(viewTable.items).toHaveLength(3)

    // What IS true: view items are a SUBSET of flat items, by displayName.
    const flatNames = new Set(flatTable.items.map((i) => i.displayName))
    const viewNames = viewTable.items.map((i) => i.displayName)
    expect(viewNames.every((n) => flatNames.has(n))).toBe(true)
    expect(viewNames).toHaveLength(3) // no duplicate displayName on the view side either

    // Per-item VALUES: on the columns BOTH sides have, v2's two real columns
    // hold the exact numbers v1's T1/T2 hold — matched by displayName (not
    // by array index, which the two sides no longer share), read by
    // POSITION (index 0/1 into each side's own label list) because the
    // LABELS themselves are the stated difference below.
    const viewLabels = viewTable.items[0]!.timePeriods
    for (const displayName of viewNames) {
      const flatItem = flatTable.items.find((i) => i.displayName === displayName)!
      const viewItem = viewTable.items.find((i) => i.displayName === displayName)!
      expect([viewItem.data[viewLabels[0]!], viewItem.data[viewLabels[1]!]]).toEqual([flatItem.data['T1'], flatItem.data['T2']])
      expect([viewItem.formattedData[viewLabels[0]!], viewItem.formattedData[viewLabels[1]!]]).toEqual([
        flatItem.formattedData['T1'], flatItem.formattedData['T2'],
      ])
    }

    // STATED DIFFERENCES (cannot be equal by construction):
    //
    // 1. ITEM COUNT / "a shorter table means no data" (M2, round 4 — this
    //    difference used to go unstated because the old fixture's full
    //    population hid it). A partial extraction renders only the fields
    //    that came back on the view path; v1 rendered every catalog column,
    //    with blank cells for the ones that had not. Consumers must not
    //    read a SHORTER view table as MISSING data — it means the same
    //    thing v1's blank cells meant, minus the placeholder rows.
    //    Inherited from `buildFileFieldTablesFromInstances`, unchanged by
    //    this candidate; named here, not introduced here.
    //
    // 2. timePeriods COUNT. v1's is the catalog's full declared T1..T6 (`extractTimePeriods`
    //    reads column NAMES from the catalog — bank_statement_t1..t6 are all
    //    declared — not which slots the applicant actually has data for), so it is
    //    always 6 regardless of how many documents exist. v2's is only the periods
    //    with a REAL instance — 2 here. Neither is wrong: v1's is "every slot this
    //    category could ever have"; v2's is "every document this applicant actually
    //    uploaded" — the whole point of the unbounded instance path replacing the
    //    fixed T{n} slots.
    expect(flatTable.items[0]!.timePeriods).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
    expect(viewLabels).toHaveLength(2)
    expect(flatTable.items[0]!.data['T3']).toBeNull() // v1 pre-declares the slot, empty
    expect(Object.prototype.hasOwnProperty.call(viewTable.items[0]!.data, 'T3')).toBe(false) // v2 has no such document at all
    //
    // 3. LABEL FORMAT. v1's period labels are the bare slot name ('T1'). v2's
    //    carry the bank name too ('T1 · Maybank') whenever `issuingBankName` is
    //    present — `finxtract-bank-statement` is the one category the registry
    //    gives an "obvious label field" (SOURCE_LABEL_LEGACY_NAME), because
    //    different statements CAN be different banks. This is deliberate, not
    //    an artifact of the T1..T6 count difference above.
    expect(viewLabels).toEqual(['T1 · Maybank', 'T2 · Maybank'])
    //
    // Neither table carries confidence/provenance here — no envelope in this
    // fixture asserts a `confidence` or `origin` (see test (f) for when one does).
    expect(viewTable.items.every((i) => i.confidence === undefined && i.provenance === undefined)).toBe(true)
    expect(flatTable.items.every((i) => i.confidence === undefined && i.provenance === undefined)).toBe(true)
  })

  it('(b) financial-statement #T1/#T2 instances (one document, two periods) resolve via the hash-suffix rule — bare labels, no sourceLabel for this category', () => {
    const hash = 'c'.repeat(64)
    const v2 = view({
      'financial-statement': {
        cardinality: 'multi',
        instances: [
          inst(`financialStatement:${hash}#T1`, { netProfit: 40000 }),
          inst(`financialStatement:${hash}#T2`, { netProfit: 31000 }),
        ],
      },
    })
    const rows = instanceRowsFromView(v2, 'financial-statement')
    expect(rows.map((r) => [r.instanceKey, r.timePeriod, r.sourceLabel, r['netProfit']])).toEqual([
      [`financialStatement:${hash}#T1`, 'T1', null, 40000],
      [`financialStatement:${hash}#T2`, 'T2', null, 31000],
    ])

    const table = buildFileFieldTablesFromView(v2)['financials']!
    const item = table.items.find((i) => i.displayName === 'Net Profit')!
    expect(item.timePeriods).toEqual(['T1', 'T2'])
    expect([item.data['T1'], item.data['T2']]).toEqual([40000, 31000])
  })

  it('(c) a legacy:T{n} row still renders — rule 2 (legacyOrdinalOfKey), not the position fallback', () => {
    const v2 = view({
      'finxtract-bank-statement': { cardinality: 'multi', instances: [inst('legacy:T1', { closingBalance: 5000 })] },
    })
    expect(instanceRowsFromView(v2, 'finxtract-bank-statement')).toEqual([
      { instanceKey: 'legacy:T1', timePeriod: 'T1', sourceLabel: null, bankBalance: 5000 },
    ])
    const table = buildFileFieldTablesFromView(v2)['bank_statements']!
    const item = table.items.find((i) => i.displayName === 'Bank Balance')!
    expect(item.data['T1']).toBe(5000)
  })

  it('(d) an SSM (company-profile) single instance — position-based T1 fallback, one column per field', () => {
    const v2 = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [inst('ssm:x', { companyName: 'Granite Holdings', companyRegNo: '123456-X' })],
      },
    })
    expect(instanceRowsFromView(v2, 'company-profile')).toEqual([
      { instanceKey: 'ssm:x', timePeriod: 'T1', sourceLabel: null, ssmCompanyName: 'Granite Holdings', ssmCompanyRegNo: '123456-X' },
    ])

    const table = buildFileFieldTablesFromView(v2)['ssm_documents']!
    expect(table.hasData).toBe(true)
    // STATED DIFFERENCE: v1's buildFileFieldTables gives this group
    // FileFieldTableType.KEY_VALUE (SSM's catalog columns carry no T-suffix
    // at all, so `extractTimePeriods` finds none), with each item's single
    // cell keyed 'value'. `buildInstanceTable` ALWAYS produces TIME_SERIES —
    // by its own doc comment, unconditionally — so SSM's single instance
    // renders as a ONE-COLUMN TIME_SERIES table ('T1') instead: the same
    // "one value per field" information, under a different type enum and a
    // different cell key. Not something this ticket changes —
    // `buildFileFieldTablesFromInstances`/`buildInstanceTable` behavior is
    // explicitly out of scope (see the brief).
    expect(table.type).toBe(FileFieldTableType.TIME_SERIES)
    const nameItem = table.items.find((i) => i.displayName === 'Company Name (SSM)')!
    expect(nameItem.data['T1']).toBe('Granite Holdings')
    expect(nameItem.formattedData['T1']).toBe('Granite Holdings')
  })

  it('(e) a view with none of the document categories → {}', () => {
    const v2 = view({ 'telco-carrier': { cardinality: 'single', instances: [inst('default', { arpu: 93.46 })] } })
    expect(buildFileFieldTablesFromView(v2)).toEqual({})
  })

  it('(f) provenance from envelopes lands as confidence on the cells — no v1 sidecar supplied', () => {
    const hash = 'e'.repeat(64)
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          {
            instanceKey: `bankStatement:${hash}`,
            adapterId: 'finxtract-vendor',
            adapterVersion: 3,
            observedAt: '2026-08-10T00:00:00.000Z',
            runId: 77,
            fields: {
              closingBalance: { value: 9000, confidence: 0.92, origin: 'extraction', confidentiality: 'internal' },
            },
          },
        ],
      },
    })
    const table = buildFileFieldTablesFromView(v2)['bank_statements']!
    const item = table.items.find((i) => i.displayName === 'Bank Balance')!
    expect(item.data['T1']).toBe(9000)
    expect(item.confidence).toEqual({ T1: 0.92 })
    expect(item.provenance).toEqual({
      T1: {
        source: 'finxtract-vendor',
        confidence: 0.92,
        observedAt: '2026-08-10T00:00:00.000Z',
        sourceRunId: '77',
        origin: 'extracted', // v2's 'extraction' -> v1's 'extracted' (legacyOriginOf)
      },
    })

    // A caller-supplied fieldProvenance entry overrides the synthesized one.
    const overridden = buildFileFieldTablesFromView(v2, {
      bankBalanceT1: { source: 'override', confidence: 0.1, observedAt: '2020-01-01T00:00:00.000Z', sourceRunId: null, origin: 'manual' },
    })['bank_statements']!
    expect(overridden.items.find((i) => i.displayName === 'Bank Balance')!.provenance).toEqual({
      T1: { source: 'override', confidence: 0.1, observedAt: '2020-01-01T00:00:00.000Z', sourceRunId: null, origin: 'manual' },
    })
  })

  it('a field envelope with neither confidence nor origin synthesizes NO provenance entry — never fabricates one', () => {
    const v2 = view({
      'finxtract-bank-statement': { cardinality: 'multi', instances: [inst(`bankStatement:${hash1}`, { closingBalance: 100 })] },
    })
    const item = buildFileFieldTablesFromView(v2)['bank_statements']!.items.find((i) => i.displayName === 'Bank Balance')!
    expect(item.confidence).toBeUndefined()
    expect(item.provenance).toBeUndefined()
  })

  it('(g) F5: column order follows the numeric period, not the extraction array — intake [cimb,maybank], extraction [maybank,cimb] (mutation: remove the sort -> descending)', () => {
    // Maybank is uploaded SECOND (intake index 1) but appears FIRST in the
    // extraction category's own instances array; CIMB is the reverse. Without
    // the F5 sort, the row built from the extraction array's own order would
    // render Maybank (T2) before CIMB (T1) — descending. The DMS path's last
    // segment is the hash (documentHashOfPath), matching the pattern the
    // resolveExtractionStatusFromView/buildDocumentRowsFromView describes use.
    const maybankHash = '3'.repeat(64)
    const cimbHash = '4'.repeat(64)
    const v2: CanonicalView = view({
      'document-intake': {
        cardinality: 'multi',
        instances: [
          inst('bankStatements#1', { documentType: 'bankStatements', pathInDms: `${DMS}${cimbHash}` }),
          inst('bankStatements#2', { documentType: 'bankStatements', pathInDms: `${DMS}${maybankHash}` }),
        ],
      },
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatement:${maybankHash}`, { issuingBankName: 'Maybank', closingBalance: 5000 }),
          inst(`bankStatement:${cimbHash}`, { issuingBankName: 'CIMB', closingBalance: 7000 }),
        ],
      },
    })
    const table = buildFileFieldTablesFromView(v2)['bank_statements']!
    const item = table.items.find((i) => i.displayName === 'Bank Balance')!
    expect(item.timePeriods).toEqual(['T1 · CIMB', 'T2 · Maybank'])
    expect([item.data['T1 · CIMB'], item.data['T2 · Maybank']]).toEqual([7000, 5000])
  })
})

// ── F3 (HIGH, round 2): fieldProvenanceFromView — collisions keep the NEWER run ──

describe('fieldProvenanceFromView — hoisted provenance synthesis, collision-aware (SYS-3334 F3, round 2)', () => {
  it('(a) a same-hash re-extraction collision is DROPPED from provenance and COUNTED in collided (H2, round 4 — corrected from "keeps the NEWER run": see the H2 test below for why keeping either side\'s number is wrong) (mutation: keep the resolved winner\'s entry instead of dropping it -> red)', () => {
    // The review's own fixture: 12000@0.55/run 11, then 13500@0.98/run 22 —
    // same document (same hash -> same instanceKey -> same slot), a
    // re-extraction landing on the SAME (base, period) key. F3 (round 2)
    // still detects this collision exactly as before; H2 (round 4) changed
    // what happens to it — see the H2 test below, and the
    // `fieldProvenanceFromView` doc, for why dropping (not resolving to a
    // winner) is the honest behavior.
    const hash = 'f'.repeat(64)
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          {
            instanceKey: `bankStatement:${hash}`,
            adapterId: 'finxtract-vendor',
            adapterVersion: 1,
            observedAt: '2026-08-10T00:00:00.000Z',
            runId: 11,
            fields: { closingBalance: { value: 12000, confidence: 0.55, origin: 'extraction', confidentiality: 'internal' } },
          },
          {
            instanceKey: `bankStatement:${hash}`,
            adapterId: 'finxtract-vendor',
            adapterVersion: 2,
            observedAt: '2026-08-15T00:00:00.000Z',
            runId: 22,
            fields: { closingBalance: { value: 13500, confidence: 0.98, origin: 'extraction', confidentiality: 'internal' } },
          },
        ],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(v2)
    expect(provenance['bankBalanceT1']).toBeUndefined()
    expect(collided).toEqual(['bankBalanceT1'])
  })

  it('M1 (round 4): a rescued period (F6) reaches provenance too — the SAME resolved row, not a second timePeriodOf call (mutation: recompute the period via a bare timePeriodOf call instead of row.timePeriod -> red)', () => {
    // A sole bank instance with instanceKey '' has no period of its own on
    // the wire; F6 rescues it to 'T1' inside instanceRowPairsFromView (the
    // same way any lone document position-falls-back to T1). Before M1,
    // this function recomputed the period with a bare timePeriodOf call,
    // which does not see F6's rescue, so it got null and this column's
    // confidence could never reach the provenance map even though
    // instanceRowsFromView's own T1 column existed right next to it.
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        instances: [{
          instanceKey: '',
          adapterId: 'finxtract-vendor',
          adapterVersion: 1,
          observedAt: '2026-08-10T00:00:00.000Z',
          runId: 1,
          fields: { closingBalance: { value: 9500, confidence: 0.93, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
    })
    // The row itself: F6 rescued instanceKey '' -> 'T1' (the sole instance).
    expect(instanceRowsFromView(v2, 'finxtract-bank-statement')[0]!.timePeriod).toBe('T1')

    const { provenance } = fieldProvenanceFromView(v2)
    expect(provenance['bankBalanceT1']).toMatchObject({ confidence: 0.93 })
  })

  it('H1 (HIGH, round 4): buildInstanceTable reads ONLY the legacy-base+period key — ssm/form9/ic lost 100% of their provenance through the exact-key-only path (mutation: emit only the exact key -> red)', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [{
          instanceKey: 'ssm:x',
          adapterId: 'finxtract-ssm',
          adapterVersion: 1,
          observedAt: '2026-08-01T00:00:00.000Z',
          runId: 9,
          fields: { companyName: { value: 'Granite Holdings', confidence: 0.91, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
    })

    // Through the FULL view path: the SSM table's item now carries the
    // confidence. Before H1's fix, buildInstanceTable's unconditional
    // `${baseName}${row.timePeriod}` lookup ('ssmCompanyNameT1') never
    // found anything, because fieldProvenanceFromView only ever emitted the
    // bare exact key ('ssmCompanyName' — which IS this field's legacy base
    // too, since SSM's columns carry no T-suffix at all).
    const table = buildFileFieldTablesFromView(v2)['ssm_documents']!
    const item = table.items.find((i) => i.displayName === 'Company Name (SSM)')!
    expect(item.confidence).toEqual({ T1: 0.91 })

    // Both names point at the SAME cell now — the exact key (what a v1
    // sidecar / the detail panel keys on) and the legacy-base+period key
    // (what buildInstanceTable actually reads) — so a caller reading either
    // convention finds the entry.
    const { provenance } = fieldProvenanceFromView(v2)
    expect(provenance['ssmCompanyName']).toMatchObject({ confidence: 0.91 })
    expect(provenance['ssmCompanyNameT1']).toMatchObject({ confidence: 0.91 })

    // A caller-supplied sidecar keyed by the bare (v1 KEY_VALUE) convention
    // does not blank the cell: buildFileFieldTablesFromView merges it OVER
    // the synthesized map by key, so the synthesized 'ssmCompanyNameT1'
    // twin buildInstanceTable actually reads survives untouched.
    const overridden = buildFileFieldTablesFromView(v2, {
      ssmCompanyName: {
        source: 'override', confidence: 0.5, observedAt: '2020-01-01T00:00:00.000Z', sourceRunId: null, origin: 'manual',
      },
    })['ssm_documents']!
    const overriddenItem = overridden.items.find((i) => i.displayName === 'Company Name (SSM)')!
    expect(overriddenItem.confidence).toEqual({ T1: 0.91 }) // unaffected: the caller only replaced the OTHER name
  })

  it('H2 (HIGH, round 4): a collided key is DROPPED from provenance, not resolved to the winner — rendering the winner\'s confidence on the loser\'s column was wrong-but-plausible (mutation: keep the winning entry under the collided key -> red)', () => {
    // The migration window's own collision shape (F3's doc): one instance
    // carries the real v1 slot verbatim (legacySlot 'T1', identity-less
    // instanceKey ''), its sibling has no legacySlot and falls through to
    // the SAME slot via the position fallback (it is the ONLY instance with
    // a real hash identity, so it lands at position 0 -> 'T1' too).
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          {
            instanceKey: '',
            adapterId: 'finxtract-vendor',
            adapterVersion: 1,
            observedAt: '2026-08-01T00:00:00.000Z',
            runId: 1,
            legacySlot: 'T1',
            fields: { closingBalance: { value: 9000, confidence: 0.99, origin: 'extraction', confidentiality: 'internal' } },
          },
          {
            instanceKey: `bankStatement:${'c'.repeat(64)}`,
            adapterId: 'finxtract-vendor',
            adapterVersion: 1,
            observedAt: '2026-08-02T00:00:00.000Z',
            runId: 2,
            fields: { closingBalance: { value: 4100, confidence: 0.10, origin: 'extraction', confidentiality: 'internal' } },
          },
        ],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(v2)
    expect(collided).toEqual(['bankBalanceT1'])
    expect(provenance['bankBalanceT1']).toBeUndefined() // dropped, not resolved to either side's number

    // Rendered through the table: NEITHER column carries a confidence dot —
    // absent is honest; the winner's 0.99 on the loser's real-0.10 column
    // would not be.
    const table = buildFileFieldTablesFromView(v2)['bank_statements']!
    const item = table.items.find((i) => i.displayName === 'Bank Balance')!
    expect(item.confidence).toBeUndefined()
  })

  it('H-1 (round 5): a mapped-fanout key\'s two DIFFERENT attestors are NOT a collision — SSM alone renders a dot; SSM + Form 9 render the SAME dot on BOTH tables, not neither (mutation: drop the fanout distinction so any second write to the key collides -> both dots vanish when Form 9 joins)', () => {
    const ssmOnly: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [{
          instanceKey: 'ssm:x',
          adapterId: 'finxtract-ssm',
          adapterVersion: 1,
          observedAt: '2026-08-01T00:00:00.000Z',
          runId: 9,
          fields: { companyIncorporationDate: { value: '2019-03-01', confidence: 0.88, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
    })
    const ssmTable = buildFileFieldTablesFromView(ssmOnly)['ssm_documents']!
    expect(ssmTable.items.find((i) => i.displayName === 'Incorporated Date')!.confidence).toEqual({ T1: 0.88 })

    const both: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [{
          instanceKey: 'ssm:x',
          adapterId: 'finxtract-ssm',
          adapterVersion: 1,
          observedAt: '2026-08-01T00:00:00.000Z',
          runId: 9,
          fields: { companyIncorporationDate: { value: '2019-03-01', confidence: 0.88, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
      'company-registration': {
        cardinality: 'multi',
        instances: [{
          instanceKey: 'form9:x',
          adapterId: 'finxtract-form9',
          adapterVersion: 1,
          observedAt: '2026-08-01T00:00:00.000Z',
          runId: 9,
          fields: { companyIncorporationDate: { value: '2019-03-01', confidence: 0.88, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(both)
    expect(collided).not.toContain('incorporatedDate')
    expect(collided).not.toContain('incorporatedDateT1')
    expect(provenance['incorporatedDateT1']).toMatchObject({ confidence: 0.88 })

    const ssmTableBoth = buildFileFieldTablesFromView(both)['ssm_documents']!
    const form9TableBoth = buildFileFieldTablesFromView(both)['form9']!
    expect(ssmTableBoth.items.find((i) => i.displayName === 'Incorporated Date')!.confidence).toEqual({ T1: 0.88 })
    expect(form9TableBoth.items.find((i) => i.displayName === 'Incorporated Date')!.confidence).toEqual({ T1: 0.88 })
  })

  it('instanceRowsFromView copies the period COORDINATE onto the row (periodPosition) and omits it when the wire has none (mutation: drop the spread -> the year-2 current-year row loses the coordinate that selects it)', () => {
    const v: CanonicalView = view({
      'financial-statement': {
        cardinality: 'multi',
        instances: [
          { instanceKey: 'financialStatement:h1#T1', adapterId: 'fs', adapterVersion: 1, legacySlot: 'T1', periodPosition: 1, fields: { revenue: { value: 100, confidentiality: 'internal' } } },
          // A year-2 document's own current-year column: position 1, NO legacy slot (v1 discarded it).
          { instanceKey: 'financialStatement:h2', adapterId: 'fs', adapterVersion: 1, periodPosition: 1, fields: { revenue: { value: 200, confidentiality: 'internal' } } },
          { instanceKey: 'financialStatement:h2#T3', adapterId: 'fs', adapterVersion: 1, legacySlot: 'T3', periodPosition: 2, fields: { revenue: { value: 150, confidentiality: 'internal' } } },
        ],
      },
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [{ instanceKey: 'bankStatement:b1', adapterId: 'bank', adapterVersion: 1, legacySlot: 'T1', fields: { closingBalance: { value: 5, confidentiality: 'internal' } } }],
      },
    })
    const fs = instanceRowsFromView(v, 'financial-statement')
    const byKey = new Map(fs.map((r) => [r.instanceKey, r]))
    expect(byKey.get('financialStatement:h1#T1')).toMatchObject({ timePeriod: 'T1', periodPosition: 1 })
    expect(byKey.get('financialStatement:h2#T3')).toMatchObject({ timePeriod: 'T3', periodPosition: 2 })
    // The discarded coordinate: no slot, but the coordinate survives — this is the row the
    // finsys-client resolver picks for "the true current year", not the T2 overlap.
    const discarded = byKey.get('financialStatement:h2')!
    expect(discarded.periodPosition).toBe(1)
    expect(discarded.timePeriod === 'T1' || discarded.timePeriod === 'T2' || discarded.timePeriod === null || typeof discarded.timePeriod === 'string').toBe(true)
    // No coordinate on the wire → no key on the row (not null, not 0).
    const bank = instanceRowsFromView(v, 'finxtract-bank-statement')[0]!
    expect('periodPosition' in bank).toBe(false)
  })

  it('H-1r5: fanout attestors that DISAGREE are a collision after all — no dot on either table, key in collided (mutation: drop the value-agreement gate -> Form 9\'s row renders SSM\'s 0.91 / run 11 under Form 9\'s own date)', () => {
    // SSM says 2011-01-01 @ 0.91 (run 11); Form 9 says 2019-03-01 @ 0.60
    // (run 22). Both tables render their OWN value, but the provenance map
    // is keyed by the v1 column, so a single surviving entry would pair
    // Form 9's date with SSM's confidence, source and run — a wrong dot.
    const disagree: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [{
          instanceKey: 'ssm:x', adapterId: 'ssm-extract', adapterVersion: 1, observedAt: '2026-08-01T00:00:00.000Z', runId: 11,
          fields: { companyIncorporationDate: { value: '2011-01-01', confidence: 0.91, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
      'company-registration': {
        cardinality: 'multi',
        instances: [{
          instanceKey: 'form9:x', adapterId: 'form9-extract', adapterVersion: 1, observedAt: '2026-08-02T00:00:00.000Z', runId: 22,
          fields: { companyIncorporationDate: { value: '2019-03-01', confidence: 0.60, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(disagree)
    expect(collided).toContain('incorporatedDate')
    expect(collided).toContain('incorporatedDateT1')
    expect(provenance['incorporatedDate']).toBeUndefined()
    expect(provenance['incorporatedDateT1']).toBeUndefined()

    const tables = buildFileFieldTablesFromView(disagree)
    const ssmItem = tables['ssm_documents']!.items.find((i) => i.displayName === 'Incorporated Date')!
    const form9Item = tables['form9']!.items.find((i) => i.displayName === 'Incorporated Date')!
    // Each table keeps its OWN value…
    expect(ssmItem.data).toEqual({ T1: '2011-01-01' })
    expect(form9Item.data).toEqual({ T1: '2019-03-01' })
    // …and NEITHER carries a confidence — absent is honest; SSM\'s 0.91 on
    // Form 9\'s date would be a fabricated dot.
    expect(ssmItem.confidence).toBeUndefined()
    expect(form9Item.confidence).toBeUndefined()
  })

  it('H-1 (round 5): two instances of the SAME fanout-attestor category still collide on the shared key — the fanout exception is per ADDRESS, not per key (mutation: treat every second write to a fanout key as a co-attestation regardless of address -> collided stays empty)', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [
          {
            instanceKey: 'ssm:a',
            adapterId: 'finxtract-ssm',
            adapterVersion: 1,
            observedAt: '2026-08-01T00:00:00.000Z',
            runId: 1,
            legacySlot: 'T1',
            fields: { companyIncorporationDate: { value: '2019-03-01', confidence: 0.7, origin: 'extraction', confidentiality: 'internal' } },
          },
          {
            instanceKey: 'ssm:b',
            adapterId: 'finxtract-ssm',
            adapterVersion: 1,
            observedAt: '2026-08-02T00:00:00.000Z',
            runId: 2,
            legacySlot: 'T1',
            fields: { companyIncorporationDate: { value: '2019-04-01', confidence: 0.6, origin: 'extraction', confidentiality: 'internal' } },
          },
        ],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(v2)
    expect(collided).toContain('incorporatedDateT1')
    expect(provenance['incorporatedDateT1']).toBeUndefined()
  })

  it('(b) a scalar applicant-identity/fullName field resolves via the EXACT v1 key, origin translated', () => {
    const v2: CanonicalView = view({
      'applicant-identity': {
        instances: [{
          instanceKey: '',
          adapterId: 'applicant-identity-form-v1',
          adapterVersion: 1,
          observedAt: '2026-08-01T00:00:00.000Z',
          runId: 5,
          fields: { personName: { value: 'Aiman Rosli', origin: 'extraction', confidence: 0.9, confidentiality: 'sensitive' } },
        }],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(v2)
    expect(Object.keys(provenance)).toEqual(['fullName'])
    expect(provenance['fullName']!.origin).toBe('extracted')
    expect(collided).toEqual([])
  })

  it('(c) an overlaid field (origin manual, originalValue) carries originalValue through', () => {
    const v2: CanonicalView = view({
      'applicant-identity': {
        instances: [{
          instanceKey: '',
          adapterId: 'lender-overlay',
          adapterVersion: 1,
          fields: {
            personName: { value: 'Aiman A. Rosli', origin: 'manual', originalValue: 'Aiman Rosli', confidentiality: 'sensitive' },
          },
        }],
      },
    })
    const { provenance } = fieldProvenanceFromView(v2)
    expect(provenance['fullName']!.origin).toBe('manual')
    expect(provenance['fullName']!.originalValue).toBe('Aiman Rosli')
  })

  it('(d) an envelope asserting none of confidence/origin/originalValue synthesizes NO entry', () => {
    const v2 = view({ 'applicant-identity': { instances: [inst('', { personName: 'Aiman Rosli' })] } })
    const { provenance, collided } = fieldProvenanceFromView(v2)
    expect(provenance).toEqual({})
    expect(collided).toEqual([])
  })

  it('L1 (round 4): an originalValue-ONLY envelope does NOT synthesize an entry — originalValue alone never justifies one, only confidence/origin do (mutation: also treat originalValue as sufficient -> a fabricated origin: "derived" entry reappears)', () => {
    // Realistic producers always pair originalValue with origin: 'manual'
    // (CanonicalFieldEnvelope's own doc), but this function must not RELY
    // on that pairing holding — an envelope that (legitimately or not)
    // carries only originalValue asserted NOTHING about confidence or
    // origin, and synthesizing `{ origin: legacyOriginOf(undefined) }` =
    // `{ origin: 'derived' }` for it would fabricate exactly the shape this
    // function's own doc says it never emits.
    const v2: CanonicalView = view({
      'applicant-identity': {
        instances: [{
          instanceKey: '',
          adapterId: 'lender-overlay',
          adapterVersion: 1,
          fields: {
            personName: { value: 'Aiman A. Rosli', originalValue: 'Aiman Rosli', confidentiality: 'sensitive' },
          },
        }],
      },
    })
    const { provenance, collided } = fieldProvenanceFromView(v2)
    expect(provenance).toEqual({})
    expect(collided).toEqual([])
  })

  it('(e) test (f) of the buildFileFieldTablesFromView describe now goes THROUGH this function (mutation: break legacyOriginOf -> both red)', () => {
    // Not a new fixture — proves the SAME instance test (f) (above) exercises
    // now resolves identically through fieldProvenanceFromView directly, so
    // one mutation to the shared legacyOriginOf dependency fails BOTH tests.
    const hash = 'e'.repeat(64)
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [{
          instanceKey: `bankStatement:${hash}`,
          adapterId: 'finxtract-vendor',
          adapterVersion: 3,
          observedAt: '2026-08-10T00:00:00.000Z',
          runId: 77,
          fields: { closingBalance: { value: 9000, confidence: 0.92, origin: 'extraction', confidentiality: 'internal' } },
        }],
      },
    })
    const { provenance } = fieldProvenanceFromView(v2)
    expect(provenance['bankBalanceT1']).toEqual({
      source: 'finxtract-vendor',
      confidence: 0.92,
      observedAt: '2026-08-10T00:00:00.000Z',
      sourceRunId: '77',
      origin: 'extracted',
    })
  })
})

// ── flatRecordFromView — the migration map run FORWARD (SYS-3334) ──────

describe('flatRecordFromView — the v1 flat record\'s shape, re-derived from a CanonicalView (SYS-3334)', () => {
  const hash1 = '1'.repeat(64)
  const hash2 = '2'.repeat(64)

  // Source of truth: a v1-shaped flat record literal, and the equivalent
  // CanonicalView + ApplicationRecordLike built from the SAME numbers.
  const v1 = {
    fullName: 'Aiman Rosli',
    idNumber: '900101015678',
    age: 30,
    arpu: 93.46,
    email: 'aiman@example.test',
    mobilePhoneNo: '+60123456789',
    bankBalanceT1: 12000,
    bankBalanceT2: 14100,
    bankStatements: `${DMS}${hash1}`,
  }

  const v2 = view({
    'applicant-identity': { instances: [inst('default', { personName: v1.fullName, personIdNumber: v1.idNumber })] },
    'applicant-demographics': { instances: [inst('default', { statedAge: v1.age })] },
    'telco-carrier': { cardinality: 'single', instances: [inst('default', { arpu: v1.arpu })] },
    'applicant-contact': {
      cardinality: 'multi',
      instances: [inst('email', { contactValue: v1.email }), inst('mobile', { contactValue: v1.mobilePhoneNo })],
    },
    'finxtract-bank-statement': {
      cardinality: 'multi',
      instances: [
        inst(`bankStatement:${hash1}`, { closingBalance: v1.bankBalanceT1 }, { legacySlot: 'T1' }),
        inst(`bankStatement:${hash2}`, { closingBalance: v1.bankBalanceT2 }, { legacySlot: 'T2' }),
      ],
    },
    'document-intake': {
      cardinality: 'multi',
      instances: [inst('bankStatements#1', { pathInDms: v1.bankStatements })],
    },
  })

  const record: ApplicationRecordLike = {
    applicationId: 555,
    status: 'Approved',
    statusDescription: 'Fully approved',
    parties: { jurisdiction: 'MY' },
    facility: { totalFinancing: 50000 },
    system: { programId: 42 },
  }

  it('(g) every mapped scalar in the fixture round-trips (mutation: valueAtPlainAddress reads withField[1] instead of [0] -> throws on a single-instance category)', () => {
    const { record: out } = flatRecordFromView(v2, record)
    expect(out['fullName']).toBe(v1.fullName)
    expect(out['idNumber']).toBe(v1.idNumber)
    expect(out['age']).toBe(v1.age)
    expect(out['arpu']).toBe(v1.arpu)
  })

  it('(h) T-slot family: bankBalanceT1/T2 resolve via the row lookup; a PriorYear sibling stays needs-decision, never a T-slot placement (mutation: T_SLOT_KEY_SUFFIX loosened to /T\\d+$/ so it would also swallow a stray key -> still passes, so instead mutate the tSlot template to `T${tSlotMatch[1]}!` -> bankBalanceT1/T2 both undefined)', () => {
    const { record: out, unplaced } = flatRecordFromView(v2, record)
    expect(out['bankBalanceT1']).toBe(v1.bankBalanceT1)
    expect(out['bankBalanceT2']).toBe(v1.bankBalanceT2)
    expect(unplaced.find((u) => u.key === 'netProfitPriorYearT1')).toMatchObject({ disposition: 'needs-decision' })
    expect('netProfitPriorYearT1' in out).toBe(false)
  })

  it('(i) instanceKey-keyed (email/mobile) and instanceKeyPrefix-keyed (a document-intake pointer) resolve (mutation: valueAtInstanceKey compares instanceKey with !== instead of === -> email/mobile swap to undefined)', () => {
    const { record: out } = flatRecordFromView(v2, record)
    expect(out['email']).toBe(v1.email)
    expect(out['mobilePhoneNo']).toBe(v1.mobilePhoneNo)
    expect(out['bankStatements']).toBe(v1.bankStatements)
  })

  it('(j) mapped-fanout incorporatedDate: two agreeing attestors place cleanly; disagreeing attestors place the FIRST address (map order) and flag ambiguous (mutation: disagree check compares foundValues[0] against itself -> ambiguous never populates)', () => {
    const agree = view({
      'company-profile': { cardinality: 'multi', instances: [inst('ssm:x', { companyIncorporationDate: '2019-03-01' })] },
      'company-registration': { cardinality: 'multi', instances: [inst('form9:x', { companyIncorporationDate: '2019-03-01' })] },
    })
    const a = flatRecordFromView(agree)
    expect(a.record['incorporatedDate']).toBe('2019-03-01')
    expect(a.ambiguous).not.toContain('incorporatedDate')

    const disagree = view({
      'company-profile': { cardinality: 'multi', instances: [inst('ssm:x', { companyIncorporationDate: '2019-03-01' })] },
      'company-registration': { cardinality: 'multi', instances: [inst('form9:x', { companyIncorporationDate: '2020-07-15' })] },
    })
    const d = flatRecordFromView(disagree)
    // company-profile is FIRST in the map's own `addresses` order for incorporatedDate.
    expect(d.record['incorporatedDate']).toBe('2019-03-01')
    expect(d.ambiguous).toContain('incorporatedDate')
  })

  it('(k) relocated keys resolve from record.parties/facility/system plus the three top-level specials; an omitted record leaves them unplaced, the reason naming the surface (M-3, round 5 — see the dedicated M-3 describe below for the mutation pin)', () => {
    const { record: out } = flatRecordFromView(v2, record)
    expect(out['programId']).toBe(42)
    expect(out['totalFinancing']).toBe(50000)
    expect(out['jurisdiction']).toBe('MY')
    expect(out['status']).toBe('Approved')

    const { record: noRecordOut, unplaced } = flatRecordFromView(v2)
    for (const key of ['programId', 'totalFinancing', 'jurisdiction', 'status']) {
      expect(key in noRecordOut).toBe(false)
      expect(unplaced.find((u) => u.key === key)).toMatchObject({
        disposition: 'relocated',
        reason: 'relocated (surface: GET /lender/applications/:ihsId): not on the application record',
      })
    }
  })

  it('(l) retired/needs-decision/vocabulary-gap keys land in unplaced and never in record — a completeness pin so no disposition falls through silently (mutation: default branch skips the unplaced.push -> the completeness sum falls short by 3+)', () => {
    const { record: out, unplaced } = flatRecordFromView(v2, record)
    expect(unplaced.find((u) => u.key === 'ssmIncorporatedDate')).toMatchObject({ disposition: 'retired' })
    expect(unplaced.find((u) => u.key === 'phoneNumber')).toMatchObject({ disposition: 'needs-decision' })
    expect(unplaced.find((u) => u.key === 'companyBackground')).toMatchObject({ disposition: 'vocabulary-gap' })
    expect('ssmIncorporatedDate' in out).toBe(false)
    expect('phoneNumber' in out).toBe(false)
    expect('companyBackground' in out).toBe(false)

    // Every key the map holds ends up EITHER placed or accounted for in
    // unplaced — never neither, never both.
    expect(unplaced.length + Object.keys(out).length).toBe(v1MigrationKeys().length)
  })

  it('(m) instances.bankStatementInstances deep-equals instanceRowsFromView(view, finxtract-bank-statement) verbatim (mutation: swap the category to epf-statement -> empty array, no longer equal)', () => {
    const { instances } = flatRecordFromView(v2, record)
    expect(instances.bankStatementInstances).toEqual(instanceRowsFromView(v2, 'finxtract-bank-statement'))
  })

  it('(n) an EMPTY view with no record: record {}, unplaced holds every key, nothing throws (mutation: relocated branch reads record.applicationId without the optional chain -> throws on undefined record)', () => {
    const empty = view({})
    expect(() => flatRecordFromView(empty)).not.toThrow()
    const { record: out, unplaced } = flatRecordFromView(empty)
    expect(out).toEqual({})
    expect(unplaced.length).toBe(v1MigrationKeys().length)
  })
})

// ── H-2 (round 5): relocated buckets walked by PRESENCE, not nullishness ──

describe('flatRecordFromView — relocated buckets are walked by PRESENCE, not nullishness (H-2, round 5)', () => {
  const empty = view({})

  it('a null in the FIRST bucket does not fall through to a later bucket that also carries the key (mutation: restore the `??` chain -> reads "X" from facility instead of null from parties)', () => {
    const record: ApplicationRecordLike = {
      parties: { jurisdiction: null },
      facility: { jurisdiction: 'X' },
    }
    const { record: out } = flatRecordFromView(empty, record)
    expect('jurisdiction' in out).toBe(true)
    expect(out['jurisdiction']).toBeNull()
  })

  it('a null in the ONLY bucket that carries the key places null, not unplaced (mutation: restore the `??` chain -> "facility.totalFinancing: null" goes unplaced instead of placed as null)', () => {
    const record: ApplicationRecordLike = { facility: { totalFinancing: null } }
    const { record: out, unplaced } = flatRecordFromView(empty, record)
    expect('totalFinancing' in out).toBe(true)
    expect(out['totalFinancing']).toBeNull()
    expect(unplaced.find((u) => u.key === 'totalFinancing')).toBeUndefined()
  })

  it('a null in the LAST bucket still places null — already true before this fix, pinned so it stays true', () => {
    const record: ApplicationRecordLike = { system: { programId: null } }
    const { record: out } = flatRecordFromView(empty, record)
    expect('programId' in out).toBe(true)
    expect(out['programId']).toBeNull()
  })
})

// ── M-1 (round 5): valueAtPlainAddress reads the SAME period-sorted order ──

describe('flatRecordFromView — valueAtPlainAddress reads F5\'s period-sorted order, not raw view order (M-1, round 5)', () => {
  it('extraction order [B(T2), A(T1)] used to place the raw-first instance\'s value; now agrees with the table\'s own T1 cell (mutation: read view.categories[...].instances directly instead of rowPairsFor\'s order -> "B-CORP", disagreeing with the table)', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [
          inst('ssm:b', { companyName: 'B-CORP' }, { legacySlot: 'T2' }),
          inst('ssm:a', { companyName: 'A-CORP' }, { legacySlot: 'T1' }),
        ],
      },
    })

    // The rendered table's T1 cell — what a reviewer actually sees.
    const table = buildFileFieldTablesFromView(v2)['ssm_documents']!
    const item = table.items.find((i) => i.displayName === 'Company Name (SSM)')!
    expect(item.data['T1']).toBe('A-CORP')

    // The flat scalar must agree with it, not with raw extraction-array order.
    const { record: out } = flatRecordFromView(v2)
    expect(out['ssmCompanyName']).toBe('A-CORP')
  })
})

// ── M-2 (round 5): a T-slot key names a SLOT, not an INSTANCE ──────────

describe('flatRecordFromView — two rows sharing a T-slot place the first AND flag ambiguous (M-2, round 5)', () => {
  it('the scalar keeps the OLD rule (place the first); the NEW behavior is that the pick is now reported, not hidden (mutation: drop the `withSlot.length > 1` multiple flag -> ambiguous never fires even though two rows share T1)', () => {
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          inst('bankStatement:aaa', { closingBalance: 9000 }, { legacySlot: 'T1' }),
          inst('bankStatement:bbb', { closingBalance: 9500 }, { legacySlot: 'T1' }),
        ],
      },
    })
    const { record: out, ambiguous } = flatRecordFromView(v2)
    expect(out['bankBalanceT1']).toBe(9000) // first row — the rule is unchanged
    expect(ambiguous).toContain('bankBalanceT1')

    // The rendered table still shows BOTH columns under the same T1 header —
    // the divergence this finding names: a slot can hold two rows, a flat
    // scalar can only ever hold one.
    const table = buildFileFieldTablesFromView(v2)['bank_statements']!
    const item = table.items.find((i) => i.displayName === 'Bank Balance')!
    expect(Object.keys(item.data).length).toBe(2)
  })
})

// ── L-1 (round 5): ambiguous fires on DISAGREEMENT, not on mere count ──

describe('flatRecordFromView — ambiguous fires only when candidate values DIFFER (L-1, round 5)', () => {
  it('two SSM uploads with identical companyName are NOT ambiguous (mutation: revert to `multiple: withField.length > 1` -> flags ambiguous on agreement)', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [
          inst('ssm:a', { companyName: 'Granite Holdings' }, { legacySlot: 'T1' }),
          inst('ssm:b', { companyName: 'Granite Holdings' }, { legacySlot: 'T2' }),
        ],
      },
    })
    const { record: out, ambiguous } = flatRecordFromView(v2)
    expect(out['ssmCompanyName']).toBe('Granite Holdings')
    expect(ambiguous).not.toContain('ssmCompanyName')
  })

  it('two SSM uploads that genuinely disagree ARE ambiguous — the rule still catches a real disagreement', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [
          inst('ssm:a', { companyName: 'Granite Holdings' }, { legacySlot: 'T1' }),
          inst('ssm:b', { companyName: 'Different Sdn Bhd' }, { legacySlot: 'T2' }),
        ],
      },
    })
    const { ambiguous } = flatRecordFromView(v2)
    expect(ambiguous).toContain('ssmCompanyName')
  })
})

// ── L-2 (round 5): the plain-address pick skips a sentinel a LATER instance ──
// resolves — the same rule processIhsDetailsFromView applies before a
// reviewer ever sees a value.

describe('flatRecordFromView — valueAtPlainAddress prefers the first NON-SENTINEL value (L-2, round 5)', () => {
  it('an earlier blank instance does not win over a later instance\'s real value (mutation: drop the sentinel-skip and always take values[0] -> places "" instead of the real name)', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [
          inst('ssm:a', { companyName: '' }, { legacySlot: 'T1' }),
          inst('ssm:b', { companyName: 'Granite Holdings' }, { legacySlot: 'T2' }),
        ],
      },
    })
    const { record: out } = flatRecordFromView(v2)
    expect(out['ssmCompanyName']).toBe('Granite Holdings')
  })

  it('when EVERY instance carries only a sentinel, the first is placed anyway (v1 held it too)', () => {
    const v2: CanonicalView = view({
      'company-profile': {
        cardinality: 'multi',
        instances: [
          inst('ssm:a', { companyName: 'Not Specified' }, { legacySlot: 'T1' }),
          inst('ssm:b', { companyName: '' }, { legacySlot: 'T2' }),
        ],
      },
    })
    const { record: out } = flatRecordFromView(v2)
    expect(out['ssmCompanyName']).toBe('Not Specified')
  })
})

// ── L-3 (round 5): instanceKeyPrefix requires an exact key or a `#` boundary ──

describe('flatRecordFromView — valueAtInstanceKeyPrefix does not let a longer sibling prefix steal the match (L-3, round 5)', () => {
  it('bankStatementsExtraordinary#1 ahead of bankStatements#1 in view order does not win the "bankStatements" lookup (mutation: revert to bare `i.instanceKey.startsWith(prefix)` -> the Extraordinary row wins because it is listed first)', () => {
    const v2: CanonicalView = view({
      'document-intake': {
        cardinality: 'multi',
        instances: [
          inst('bankStatementsExtraordinary#1', { pathInDms: `${DMS}wrong.pdf` }),
          inst('bankStatements#1', { pathInDms: `${DMS}right.pdf` }),
        ],
      },
    })
    const { record: out } = flatRecordFromView(v2)
    expect(out['bankStatements']).toBe(`${DMS}right.pdf`)
  })
})

// ── L-5 (round 5): the T-slot unplaced reason names WHICH of three causes ──

describe('flatRecordFromView — the T-slot unplaced reason distinguishes its causes (L-5, round 5)', () => {
  // Third cause ("no legacy base name") is UNREACHABLE via v1MigrationKeys()
  // today — every T-slot `mapped` key's own address always contributes its
  // base to v1LegacyBaseNameOf's index (see valueAtTSlot's doc), so only the
  // two reachable causes below are exercised through the public entry point.

  it('cause 2: no row at all for the requested slot (empty category) -> "no T{n} row"', () => {
    const empty = view({})
    const { unplaced } = flatRecordFromView(empty)
    expect(unplaced.find((u) => u.key === 'bankBalanceT1')).toMatchObject({
      disposition: 'mapped',
      reason: 'no T1 row',
    })
  })

  it('cause 3: a row exists at the slot but never carried this base field -> "T{n} row lacks <base>" (mutation: make the "row lacks the field" branch reuse cause 2\'s "no T{n} row" string -> this assertion fails while cause 2\'s stays green)', () => {
    // The row exists (T1, via legacySlot) but only carries `openingBalance` —
    // never `closingBalance`, the field bankBalanceT1 addresses.
    const v2: CanonicalView = view({
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [inst('bankStatement:aaa', { openingBalance: 1000 }, { legacySlot: 'T1' })],
      },
    })
    const { unplaced } = flatRecordFromView(v2)
    expect(unplaced.find((u) => u.key === 'bankBalanceT1')).toMatchObject({
      disposition: 'mapped',
      reason: 'T1 row lacks bankBalance',
    })
  })
})

// ── L-6 (round 5): a Date relocated value normalizes to its ISO string ──

describe('flatRecordFromView — a Date on a relocated value normalizes to its ISO string (L-6, round 5)', () => {
  const empty = view({})

  it('an ORM row\'s Date object becomes the ISO string v1 served, on any relocated key (mutation: drop the `instanceof Date` check -> a live Date object leaks into `record`)', () => {
    const when = new Date('2026-08-01T12:34:56.000Z')
    const record: ApplicationRecordLike = { system: { createdAt: when, updatedAt: when } }
    const { record: out } = flatRecordFromView(empty, record)
    expect(out['createdAt']).toBe('2026-08-01T12:34:56.000Z')
    expect(out['updatedAt']).toBe('2026-08-01T12:34:56.000Z')
    expect(typeof out['createdAt']).toBe('string')
  })

  it('a plain string value is left untouched — this is a shape fix, not a re-parse of every relocated value', () => {
    const record: ApplicationRecordLike = { system: { createdAt: '2026-08-01T12:34:56.000Z' } }
    const { record: out } = flatRecordFromView(empty, record)
    expect(out['createdAt']).toBe('2026-08-01T12:34:56.000Z')
  })
})

// ── M-3 (round 5): the relocated unplaced reason names the SURFACE ──────

describe('flatRecordFromView — the relocated unplaced reason names the surface (M-3, round 5)', () => {
  const empty = view({})

  it('a key relocated to the application record vs a key relocated to the consent engine report DIFFERENT surfaces, not the same bare string (mutation: drop the surface interpolation -> both reasons collapse back to the old bare string)', () => {
    const { unplaced } = flatRecordFromView(empty)
    const programId = unplaced.find((u) => u.key === 'programId')!
    expect(programId.reason).toBe('relocated (surface: GET /lender/applications/:ihsId): not on the application record')

    // consentCrossSelling is one of the three relocated keys whose surface
    // is the consent engine, not the application record's own GET route.
    const consent = unplaced.find((u) => u.key === 'consentCrossSelling')!
    expect(consent.reason).toBe('relocated (surface: the consent engine): not on the application record')
  })
})
