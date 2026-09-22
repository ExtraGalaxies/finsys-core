import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  buildDocumentRowsFromView,
  buildFileFieldTables,
  buildFileFieldTablesFromView,
  documentsOfType,
  extractionCategoryOf,
  fieldProvenanceFromView,
  flatRecordFromView,
  instanceRowsFromView,
  processIhsDetails,
  processIhsDetailsFromView,
} from './ihs-processing.js'
import { resolveExtractionStatus, resolveExtractionStatusFromView } from './extraction-status.js'
import { ExtractionJobStatus } from './extraction.js'
import { assertAdapterCategory, categorySchemaOf } from './adapter-categories.js'
import type { CanonicalInstance, CanonicalView } from './canonical-view.js'

/**
 * SYS-3705 — the byte-identity proof.
 *
 * SYS-3705 changes how a document type resolves its extraction category, and
 * how a category's fields become instance rows and table columns, so that a
 * category with NO v1 lineage renders at all. The hard requirement is that
 * every category that DOES have v1 lineage renders exactly as before.
 *
 * The digests below were computed by this test against the code as it stood
 * BEFORE the change (v9.3.0, 0618e34), and never regenerated since. Every
 * output the change could reach is serialized with JSON.stringify and hashed,
 * one SHA-256 per output, so equality is byte equality and a failure names
 * the output that moved. (A digest rather than a stored golden because the
 * serialized fixture is ~0.5 MB. To see the actual diff, check out 0618e34,
 * dump `everyOutput()` to a file on both sides, and diff them.) The lists below are closed on purpose: they
 * name the categories and document types that existed then, so the fixture
 * is a function of that moment and not of whatever the registry holds today.
 *
 * Do NOT update the snapshot to make this pass. A diff here means a
 * v1-lineage category now renders differently, which is the one thing
 * SYS-3705 promised it would not do.
 */

/** Every document type registered at 9.3.0, in catalog order. */
const V1_DOCUMENT_TYPES = ['bankStatements', 'financialStatements', 'form9', 'ssm', 'ic', 'epfStatements', 'payslips'] as const

/** Every category registered at 9.3.0. */
const V1_CATEGORIES = [
  'telco-carrier', 'payment-network', 'bank-statement', 'social-media', 'trade-credit', 'geolocation',
  'person-identity', 'finxtract-bank-statement', 'epf-statement', 'payslip', 'financial-statement',
  'company-registration', 'company-profile', 'applicant-identity', 'applicant-demographics', 'applicant-contact',
  'applicant-address', 'applicant-employment', 'applicant-income', 'subject-company', 'applicant-collateral',
  'applicant-obligations', 'related-person', 'document-intake',
] as const

/** Captured at 0618e34 (v9.3.0), before any SYS-3705 production change. */
const GOLDEN_DIGESTS_AT_9_3_0: Record<string, string> = {
  extractionCategoryOf: 'f63e14699827da940b6e20040c6fd779fae659069da2bbaa4a25ff05365c4503',
  documentsOfType: '9ed395a03fc5817cf391cbe14da4a574316c44d8f91a8f5ddb9bb44eafeb15d8',
  instanceRowsFromView: '2236112c5fd1a1235413193c011334b87b3ebd0a8b81d161a5d0da36f24459e7',
  buildFileFieldTablesFromView: 'f5f1364bf36a1b8e080f096642e171a277dfc1108c260e56cc6e918411fae37b',
  fieldProvenanceFromView: '122d789b64c6a92400edd25a426cd2967dfc8b838a473a87bc84c971adc1894e',
  buildDocumentRowsFromView: 'bb87cff9d8a3d6393e5efa571c95909d957edc5440549373f03d54829d3e144b',
  resolveExtractionStatusFromView: '9b464524a4fb80d2922bfd1af70f698029aea8abe97a7287b795a61c6a713fa6',
  processIhsDetailsFromView: '78578bd72cf9d753c8c6d4f1c2e4a4422c49cc9e2485d47947e954885a17ab6a',
  flatRecordFromView: '1bef304ec2ef1be12507bb05aff881b8b10cd78171aa379c2e1131c4bfd2d0bb',
  buildFileFieldTables: '5b515d79c13b24566722eeff902cee39489b0fefe40085b39476ca35dd6fe119',
  processIhsDetails: 'a9f5f604269bf82750b5ccd54a23c73cb1210ee070f2dc8f9a17b785f80cc8a2',
  resolveExtractionStatus: '50bc7ed584e0e0b315d23a58eee5fab4f29b4d4f2486ead3e436dbf4bd4cd1e0',
}

const NEW_DOCUMENT_TYPES = ['experianReports', 'managementAccounts']
const NEW_GROUPS = ['credit_bureau_reports', 'management_accounts']
const keepV1Groups = <T,>(tables: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(tables).filter(([g]) => !NEW_GROUPS.includes(g)))

const DMS = 'https://dms.example/dms-general-storage/'
const OBSERVED = '2026-06-01T08:00:00.000Z' // fixed; nothing below compares it to a clock

const h = (c: string): string => c.repeat(64)

/** A deterministic value for every field of a category, varied by `seed` so instances differ. */
function valuesFor(category: string, seed: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  categorySchemaOf(assertAdapterCategory(category)).fields.forEach((spec, i) => {
    const name = spec.name as string
    if (spec.type === 'number') out[name] = 1000 + seed * 100 + i * 7.5
    else if (spec.type === 'boolean') out[name] = (seed + i) % 2 === 0
    else out[name] = `${name}-${seed}`
  })
  // A field no category declares: every path must skip it.
  out['notARegistryField'] = `stray-${seed}`
  return out
}

let run = 0
function inst(instanceKey: string, fields: Record<string, unknown>, extra: Partial<CanonicalInstance> = {}): CanonicalInstance {
  run++
  return {
    instanceKey,
    adapterId: 'fixture',
    adapterVersion: 1,
    runId: run,
    observedAt: OBSERVED,
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, value], i) => [
        k,
        {
          value: value as string,
          confidentiality: 'internal',
          // Vary the envelope so provenance and confidence dots are exercised.
          ...(i % 3 === 0 ? { confidence: 0.9 - (i % 5) / 100, origin: 'extraction' } : {}),
          ...(i % 3 === 1 ? { origin: 'form-intake' } : {}),
        },
      ]),
    ),
    ...extra,
  }
}

function intake(key: string, documentType: string, hash: string, uploadedAt: string): CanonicalInstance {
  return inst(key, { documentType, pathInDms: `${DMS}${hash}`, uploadedAt, uploadedBy: 'borrower' })
}

function fixtureView(): CanonicalView {
  run = 0
  return {
    ihsId: 3705,
    categories: {
      'document-intake': {
        cardinality: 'multi',
        instances: [
          intake('bankStatements#1', 'bankStatements', h('a'), '2026-01-02'),
          intake('bankStatements#2', 'bankStatements', h('b'), '2026-01-03'),
          intake('bankStatements#3', 'bankStatements', h('c'), '2026-01-04'),
          intake('financialStatements#1', 'financialStatements', h('d'), '2026-01-05'),
          intake('form9#1', 'form9', h('e'), '2026-01-06'),
          intake('ssm#1', 'ssm', h('f'), '2026-01-07'),
          intake('ic#1', 'ic', h('0'), '2026-01-08'),
          intake('epfStatements#1', 'epfStatements', h('1'), '2026-01-09'),
          intake('epfStatements#2', 'epfStatements', h('2'), '2026-01-10'),
          intake('payslips#1', 'payslips', h('3'), '2026-01-11'),
          intake('invoices#1', 'invoices', h('4'), '2026-01-12'),
        ],
      },
      'finxtract-bank-statement': {
        cardinality: 'multi',
        instances: [
          inst(`bankStatement:${h('b')}`, valuesFor('finxtract-bank-statement', 2), { legacySlot: 'T2' }),
          inst(`bankStatement:${h('a')}`, valuesFor('finxtract-bank-statement', 1), { sourceLabel: 'Wire Bank' }),
          inst(`bankStatement:${h('9')}`, valuesFor('finxtract-bank-statement', 9)), // extraction-only
          inst('legacy:T3', valuesFor('finxtract-bank-statement', 3)),
          inst('legacy:T5', valuesFor('finxtract-bank-statement', 5)),
        ],
      },
      'financial-statement': {
        cardinality: 'multi',
        instances: [
          inst(`financialStatement:${h('d')}#T1`, valuesFor('financial-statement', 1), { periodPosition: 1, legacySlot: 'T1' }),
          inst(`financialStatement:${h('d')}#T2`, valuesFor('financial-statement', 2), { periodPosition: 2 }),
          inst(`financialStatement:${h('8')}#T1`, valuesFor('financial-statement', 3)),
          inst('legacy:T4', valuesFor('financial-statement', 4)),
        ],
      },
      'company-registration': { cardinality: 'single', instances: [inst(`form9:${h('e')}`, valuesFor('company-registration', 1))] },
      'company-profile': { cardinality: 'single', instances: [inst('', valuesFor('company-profile', 1))] },
      'person-identity': { cardinality: 'single', instances: [inst(`ic:${h('0')}`, valuesFor('person-identity', 1))] },
      'epf-statement': {
        cardinality: 'multi',
        instances: [
          inst(`epfStatement:${h('2')}`, valuesFor('epf-statement', 2)),
          inst(`epfStatement:${h('1')}`, valuesFor('epf-statement', 1)),
        ],
      },
      payslip: { cardinality: 'multi', instances: [inst(`payslip:${h('3')}`, valuesFor('payslip', 1))] },
      'telco-carrier': { cardinality: 'single', instances: [inst('default', valuesFor('telco-carrier', 1))] },
      'applicant-identity': { cardinality: 'single', instances: [inst('', valuesFor('applicant-identity', 1))] },
      'applicant-contact': {
        cardinality: 'multi',
        instances: [inst('email', { contactValue: 'a@example.test' }), inst('mobile', { contactValue: '+60100000000' })],
      },
      'geolocation': {
        cardinality: 'multi',
        instances: [inst('summary', valuesFor('geolocation', 1)), inst('pt:2026-06-01T08', valuesFor('geolocation', 2))],
      },
    },
  }
}

/** The v1 flat record the same fixture flattens to — the input the v1-flat functions read. */
function flatFixture(): Record<string, unknown> {
  return {
    ...flatRecordFromView(fixtureView()).record,
    bankStatements: JSON.stringify([{ path: `${DMS}${h('a')}` }, { path: `${DMS}${h('b')}` }]),
    financialStatements: JSON.stringify([{ path: `${DMS}${h('d')}` }]),
    form9: `${DMS}${h('e')}`,
    ssm: `${DMS}${h('f')}`,
  }
}

/**
 * The same fixture with the two SYS-3705 categories populated beside the v1
 * ones — a credit-bureau report (principal + one party) and a two-period
 * management account, both joined to intake rows. Their presence must not
 * move a single byte of any v1 output: a lineage-free category that leaked
 * into a shared structure (the provenance map, the detail panel, the flat
 * record, another group's table) would show up here and nowhere else.
 */
function fixtureViewWithNewCategories(): CanonicalView {
  const v = fixtureView()
  v.categories['document-intake']!.instances.push(
    intake('experianReports#1', 'experianReports', h('5'), '2026-01-13'),
    intake('managementAccounts#1', 'managementAccounts', h('6'), '2026-01-14'),
  )
  v.categories['credit-bureau-report'] = {
    cardinality: 'multi',
    instances: [
      inst(`experianReport:${h('5')}#ccris`, { ...valuesFor('credit-bureau-report', 1), section: 'ccris' }),
      inst(`experianReport:${h('5')}#pbi-1`, { ...valuesFor('credit-bureau-report', 2), section: 'pbi-1' }),
    ],
  }
  v.categories['management-account'] = {
    cardinality: 'multi',
    instances: [
      // companyName is a shared fact with Form 9 / SSM / audited statements:
      // the strongest candidate for a cross-category collision.
      inst(`managementAccount:${h('6')}#T1`, valuesFor('management-account', 1), { periodPosition: 1 }),
      inst(`managementAccount:${h('6')}#T2`, valuesFor('management-account', 2), { periodPosition: 2 }),
    ],
  }
  return v
}

function everyOutput(v: CanonicalView = fixtureView()): Record<string, unknown> {
  const intakeRows = v.categories['document-intake']!.instances
  const jobs = [
    { fileType: 'bankStatements', status: ExtractionJobStatus.Succeeded },
    { fileType: 'financialStatements', status: ExtractionJobStatus.Failed, errorMessage: 'boom' },
    { fileType: 'form9', status: ExtractionJobStatus.Processing },
  ]
  const keepV1Types = <T extends { fileType: string }>(docs: T[]): T[] =>
    docs.filter((d) => (V1_DOCUMENT_TYPES as readonly string[]).includes(d.fileType))
  const flat = flatFixture()

  const out = {
    extractionCategoryOf: Object.fromEntries(V1_DOCUMENT_TYPES.map((t) => [t, extractionCategoryOf(t)])),
    documentsOfType: Object.fromEntries(V1_DOCUMENT_TYPES.map((t) => [t, documentsOfType(v, intakeRows, t)])),
    instanceRowsFromView: Object.fromEntries(
      V1_CATEGORIES.map((c) => [
        c,
        // The intake rows of the new document types are new rows, not moved ones.
        instanceRowsFromView(v, assertAdapterCategory(c)).filter(
          (r) => !NEW_DOCUMENT_TYPES.some((t) => r.instanceKey.startsWith(`${t}#`)),
        ),
      ]),
    ),
    buildFileFieldTablesFromView: keepV1Groups(buildFileFieldTablesFromView(v)),
    fieldProvenanceFromView: fieldProvenanceFromView(v),
    buildDocumentRowsFromView: buildDocumentRowsFromView(v).filter((r) => !NEW_DOCUMENT_TYPES.includes(r.docType)),
    // The new document types add NotUploaded rows of their own; the rows for
    // the v1 types are what must not move.
    resolveExtractionStatusFromView: keepV1Types(resolveExtractionStatusFromView(v, jobs).documents),
    processIhsDetailsFromView: processIhsDetailsFromView(v),
    flatRecordFromView: flatRecordFromView(v),
    // The v1 flat functions: the new catalog entries must not reach them.
    buildFileFieldTables: buildFileFieldTables(flat),
    processIhsDetails: processIhsDetails(flat),
    resolveExtractionStatus: keepV1Types(resolveExtractionStatus(flat, jobs).documents),
  }
  return out
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** One digest per output, so a failure names WHICH output moved. */
function digests(): Record<string, string> {
  return Object.fromEntries(Object.entries(everyOutput()).map(([k, v]) => [k, sha256(JSON.stringify(v))]))
}

describe('SYS-3705 — every v1-lineage category renders byte-identically to 9.3.0', () => {
  it('the fixture exercises every path it claims to (a non-vacuous golden)', () => {
    const v = fixtureView()
    const tables = buildFileFieldTablesFromView(v)
    // Seven document groups render a table, from all four instance-key shapes.
    expect(Object.keys(tables).sort()).toEqual(
      ['bank_statements', 'epf_statements', 'financials', 'form9', 'ic_documents', 'payslip_statements', 'ssm_documents'],
    )
    expect(Object.keys(fieldProvenanceFromView(v).provenance).length).toBeGreaterThan(50)
    expect(processIhsDetailsFromView(v).length).toBeGreaterThan(5)
    expect(Object.keys(flatRecordFromView(v).record).length).toBeGreaterThan(100)
  })

  it('the new categories, populated beside the v1 ones, move none of the v1 outputs', () => {
    const v = fixtureViewWithNewCategories()
    // Non-vacuous: the new categories DID render, so the filters above are
    // hiding real output, not an empty set.
    const tables = buildFileFieldTablesFromView(v)
    expect(Object.keys(tables)).toEqual(expect.arrayContaining(NEW_GROUPS))
    expect(buildDocumentRowsFromView(v).filter((r) => NEW_DOCUMENT_TYPES.includes(r.docType))).toHaveLength(2)
    const withNew = Object.fromEntries(Object.entries(everyOutput(v)).map(([k, o]) => [k, sha256(JSON.stringify(o))]))
    expect(withNew).toEqual(GOLDEN_DIGESTS_AT_9_3_0)
  })

  it('matches the digests captured before the change, byte for byte', () => {
    // Diagnostics for a red run: SYS3705_DUMP=<path> writes the full outputs
    // so the same dump taken at 0618e34 can be diffed against it.
    if (process.env.SYS3705_DUMP) writeFileSync(process.env.SYS3705_DUMP, JSON.stringify(everyOutput(), null, 1) + '\n')
    expect(digests()).toEqual(GOLDEN_DIGESTS_AT_9_3_0)
  })
})
