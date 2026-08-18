/*
 * Extraction status resolution.
 *
 * Determines per-document extraction status from IHS record data
 * and optional extraction job records. Pure synchronous function —
 * no HTTP, no async, trivially testable.
 *
 * For multi-file document types (bank statements, financial statements,
 * EPF, payslips), produces one result per time period (T1, T2, …).
 * For single-file types (SSM, Form 9, IC), produces one result.
 */

import { ExtractionFileType, ExtractionJobStatus } from './extraction.js'
import { getDocumentTypeGroups } from './document-types.js'
import type { FieldData } from './survey-generator.js'
import { categoryFieldsOf, type AdapterCategory } from './adapter-categories.js'
import { extractionCategoryOf, documentsOfType } from './ihs-processing.js'
import type { CanonicalView, CanonicalInstance } from './canonical-view.js'

// ── Types ──────────────────────────────────────────────────

export enum DocExtractionStatus {
  NotUploaded = 'not_uploaded',
  Uploaded = 'uploaded',
  Queued = 'queued',
  Processing = 'processing',
  Extracted = 'extracted',
  Failed = 'failed',
  Unknown = 'unknown',
}

export interface ExtractionJobRecord {
  fileType: string
  status: string
  errorMessage?: string | null
}

export interface DocExtractionResult {
  fileType: ExtractionFileType
  status: DocExtractionStatus
  displayName: string
  populatedColumns: string[]
  totalColumns: number
  errorMessage?: string | null
  /**
   * SYS-3378: the document's DMS content hash — present on the instance-shaped
   * path, absent on the flat one. The join key to `DocumentRow.documentId`, so
   * a consumer can overlay status by identity rather than by (fileType, index).
   */
  documentId?: string
  /**
   * SYS-3334: set only on the instance-shaped path, for a document known from
   * its extraction instances alone — no intake row names it. Either an upload
   * that predates the intake writer, or a join miss between an intake path and
   * an extraction key. Kept observable so a join regression cannot masquerade
   * as a pre-writer upload.
   */
  unlinked?: true
}

export interface ExtractionStatusResult {
  documents: DocExtractionResult[]
  summary: {
    total: number
    extracted: number
    failed: number
    pending: number
    notUploaded: number
  }
}

// ── Helpers ────────────────────────────────────────────────

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (value === 'Not Specified') return false
  return true
}

function countUploadedFiles(ihsRecord: Record<string, unknown>, aggregateKey: string): number {
  const raw = ihsRecord[aggregateKey]
  if (!raw) return 0

  // JSON array string (multi-file types like bankStatements)
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.length
    } catch {
      // Plain URL string (single-file type) — count as 1
      return 1
    }
  }

  if (Array.isArray(raw)) return raw.length

  // Single object or URL string
  return 1
}

function hasUploadedFile(
  fields: FieldData[],
  ihsRecord: Record<string, unknown>,
  aggregateKey: string
): boolean {
  if (countUploadedFiles(ihsRecord, aggregateKey) > 0) return true

  // Fall back to individual field names for single-file types (ssm, form9, ic)
  return fields.some((field) => {
    if (!field.name) return false
    return isPopulated(ihsRecord[field.name])
  })
}

function getPopulatedColumns(
  columns: string[],
  ihsRecord: Record<string, unknown>
): string[] {
  return columns.filter((col) => isPopulated(ihsRecord[col]))
}

/**
 * Resolve status for a single document (one field / one time period).
 */
function resolveDocStatus(
  columns: string[],
  ihsRecord: Record<string, unknown>,
  uploaded: boolean,
  jobRecord: ExtractionJobRecord | undefined,
  hasJobRecords: boolean
): { status: DocExtractionStatus; errorMessage?: string | null } {
  const populated = getPopulatedColumns(columns, ihsRecord)
  const hasExtractedData = populated.length > 0

  let status: DocExtractionStatus
  let errorMessage: string | null | undefined

  if (!uploaded) {
    status = DocExtractionStatus.NotUploaded
  } else if (hasJobRecords) {
    if (jobRecord) {
      if (jobRecord.status === ExtractionJobStatus.Queued) {
        status = DocExtractionStatus.Queued
      } else if (jobRecord.status === ExtractionJobStatus.Processing) {
        status = DocExtractionStatus.Processing
      } else if (jobRecord.status === ExtractionJobStatus.Failed) {
        if (hasExtractedData) {
          status = DocExtractionStatus.Extracted
          errorMessage = jobRecord.errorMessage
        } else {
          status = DocExtractionStatus.Failed
          errorMessage = jobRecord.errorMessage
        }
      } else if (jobRecord.status === ExtractionJobStatus.Succeeded || hasExtractedData) {
        status = DocExtractionStatus.Extracted
      } else {
        status = DocExtractionStatus.Uploaded
      }
    } else if (hasExtractedData) {
      status = DocExtractionStatus.Extracted
    } else {
      status = DocExtractionStatus.Uploaded
    }
  } else if (hasExtractedData) {
    status = DocExtractionStatus.Extracted
  } else {
    status = DocExtractionStatus.Unknown
  }

  return { status, errorMessage }
}

// ── Main function ──────────────────────────────────────────

/**
 * Determines per-document extraction status from IHS record data.
 *
 * For multi-file document types (bank statements, financial statements, EPF,
 * payslips) the result contains one entry per uploaded file, indexed in the
 * same order as the files appear in the IHS record's aggregate array.
 * For single-file types (SSM, Form 9, IC) there is one entry.
 *
 * @param ihsRecord - The IHS application record (any shape satisfying Record<string, unknown>)
 * @param jobRecords - Extraction job records for this IHS. Pass the array (even if empty)
 *   when job records were fetched. Omit or pass undefined when job records are unavailable;
 *   this produces `Unknown` status for uploaded-but-unextracted documents rather than `Uploaded`.
 */
export function resolveExtractionStatus(
  ihsRecord: Record<string, unknown>,
  jobRecords?: ExtractionJobRecord[]
): ExtractionStatusResult {
  const documents: DocExtractionResult[] = []
  const hasJobRecords = jobRecords !== undefined

  for (const group of getDocumentTypeGroups()) {
    const fileType = group.documentType
    const fields = group.fields
    const displayName = group.label

    const uploadedCount = countUploadedFiles(ihsRecord, fileType)
    const isUploaded = uploadedCount > 0 || fields.some((f) => f.name && isPopulated(ihsRecord[f.name]))

    // For multi-file types, match job records by fileType (there can be multiple)
    const matchingJobs = jobRecords?.filter((j) => j.fileType === fileType) ?? []

    if (fields.length <= 1) {
      // Single-file type (ssm, form9, ic): one result
      const field = fields[0]
      const columns = field?.ihs_column_names ?? []
      const populated = getPopulatedColumns(columns, ihsRecord)
      const { status, errorMessage } = resolveDocStatus(
        columns, ihsRecord, isUploaded, matchingJobs[0], hasJobRecords
      )

      documents.push({
        fileType,
        status,
        displayName,
        populatedColumns: populated,
        totalColumns: columns.length,
        errorMessage,
      })
    } else {
      // Multi-file type (bank statements T1-T6, etc.): one result per uploaded file.
      // Fields are sorted by name (bank_statement_t1, t2, …) so idx aligns with
      // the file array order in the IHS record.
      const count = Math.max(uploadedCount, 1)
      for (let idx = 0; idx < count; idx++) {
        const field = fields[idx]
        const columns = field?.ihs_column_names ?? []
        const populated = getPopulatedColumns(columns, ihsRecord)
        const fileUploaded = idx < uploadedCount
        const { status, errorMessage } = resolveDocStatus(
          columns, ihsRecord, fileUploaded, matchingJobs[idx], hasJobRecords
        )

        documents.push({
          fileType,
          status,
          displayName,
          populatedColumns: populated,
          totalColumns: columns.length,
          errorMessage,
        })
      }
    }
  }

  const summary = documents.reduce(
    (acc, d) => {
      if (d.status === DocExtractionStatus.Extracted) acc.extracted++
      else if (d.status === DocExtractionStatus.Failed) acc.failed++
      else if (d.status === DocExtractionStatus.NotUploaded) acc.notUploaded++
      else acc.pending++
      return acc
    },
    { total: documents.length, extracted: 0, failed: 0, pending: 0, notUploaded: 0 }
  )

  return { documents, summary }
}

// ── Instance-shaped resolution (SYS-3334) ──────────────────────────

/**
 * `resolveExtractionStatus` for a v2 `CanonicalView`. Same result type, same
 * status vocabulary, same job-record semantics — but this is a RE-DERIVATION,
 * not a port, and three things were decided rather than translated. Each is
 * pinned by a test in extraction-status.test.ts that fails if it drifts.
 *
 * 1. UPLOADED means "a document of this type is attested". v1 counted the
 *    entries of the pointer column (`bankStatements` JSON array). v2 counts
 *    the documents known to the view: `document-intake` instances of that
 *    `documentType`, UNIONED with the extraction category's instances (an
 *    extracted document was necessarily uploaded — this covers uploads that
 *    predate the intake writer). Measured against v1 on 189 sim subjects ×
 *    7 types: 1321 of 1323 agree; the two that do not are one pre-writer
 *    upload (v2 now says uploaded, via the union) and one replaced file,
 *    where the append-only intake keeps the superseded write. That last one
 *    is a real semantic difference — attested writes vs current pointer —
 *    and it is stated here rather than papered over.
 *
 * 2. PER-DOCUMENT STATUS is joined by identity, not by position. v1 aligned
 *    upload index i with T-slot column family i and job record i. v2 joins an
 *    intake instance to its extraction instances by the document's DMS hash —
 *    intake's `pathInDms` tail IS the extraction key's hash
 *    (`bankStatement:<hash>`, `financialStatement:<hash>#T2` — period rows of
 *    one document are grouped). A document with no extraction instance is
 *    uploaded-but-not-extracted — exactly the case the panel exists to show.
 *    Measured: 520 of 670 intake instances join; the 150 that do not are that
 *    case. Job records still carry only fileType and order, so they are
 *    aligned positionally — but ONLY to the intake-ordered prefix, never to an
 *    extraction-only document that was never in the pointer array. One shift
 *    remains and is stated: intake is append-only, so a REPLACED file keeps
 *    its superseded row, and a positional job after that point lands one
 *    document later than v1 would have put it. Measured 1 of 1323 documents.
 *
 * 3. THE DENOMINATOR is the registry's field set for the extraction category
 *    — what the adapter DECLARES it produces — not the form spec's column
 *    list for a T-slot. v1's `totalColumns` was that slot's width: equal to
 *    the registry for bank (8), payslip (15), EPF (9), IC (9), SSM (16) and
 *    Form 9 (3) — and, for financial statements, 13 on the first slot then 0
 *    on the second, because v1's financial slots were misaligned with its
 *    documents. So the ONLY user-visible denominator change is financial
 *    statements: 13 → 122 on the first document and 0 → 122 on the rest, and
 *    that is a correction. The test pins BOTH sides — the flat path's numbers
 *    next to the registry's — so a drift on either is a decision.
 *
 * `populatedColumns` are CANONICAL field names now (`closingBalance`, not
 * `bankBalanceT1`). Same information, right vocabulary; consumers rendering
 * the names see that change.
 */
export function resolveExtractionStatusFromView(
  view: CanonicalView,
  jobRecords?: ExtractionJobRecord[]
): ExtractionStatusResult {
  const documents: DocExtractionResult[] = []
  const hasJobRecords = jobRecords !== undefined
  const intake = view.categories['document-intake']?.instances ?? []

  for (const group of getDocumentTypeGroups()) {
    const fileType = group.documentType
    const displayName = group.label
    const category = extractionCategoryOf(fileType)
    const declared = category ? categoryFieldsOf(category as AdapterCategory) : []
    const extracted = category ? (view.categories[category]?.instances ?? []) : []
    const matchingJobs = jobRecords?.filter((j) => j.fileType === fileType) ?? []

    // The documents of this type, in the ONE order both instance-shaped
    // functions use (see documentsOfType): intake first, then extracted
    // documents intake does not know. A document is the group of its
    // extraction instances (`#T1`, `#T2` period rows), extracted if any of
    // them carries data.
    const uploads = documentsOfType(view, intake, fileType)

    if (uploads.length === 0) {
      // Not uploaded: v1 emitted one NotUploaded row per type (single-file
      // types always; multi-file types via max(count, 1)). Same here.
      const { status, errorMessage } = classify(false, false, matchingJobs[0], hasJobRecords)
      documents.push({ fileType, status, displayName, populatedColumns: [], totalColumns: declared.length, errorMessage })
      continue
    }

    uploads.forEach((u, idx) => {
      const populated = populatedFields(u.extraction, declared)
      // A positional job record is only meaningful against the intake-ordered
      // prefix — the same order the pointer array had. An extraction-only
      // document was never in that array, so no job may be aligned to it;
      // `classify` without a job degrades to Uploaded/Extracted correctly.
      const job = u.origin === 'intake' ? matchingJobs[idx] : undefined
      const { status, errorMessage } = classify(true, populated.length > 0, job, hasJobRecords)
      documents.push({
        fileType, status, displayName, populatedColumns: populated, totalColumns: declared.length, errorMessage,
        ...(u.hash !== null ? { documentId: u.hash } : {}),
        ...(u.origin === 'extraction-only' ? { unlinked: true } : {}),
      })
    })
  }

  return { documents, summary: summarize(documents) }
}

/** The status decision, shared with the flat resolver's rules exactly. */
function classify(
  uploaded: boolean,
  hasExtractedData: boolean,
  jobRecord: ExtractionJobRecord | undefined,
  hasJobRecords: boolean
): { status: DocExtractionStatus; errorMessage?: string | null } {
  if (!uploaded) return { status: DocExtractionStatus.NotUploaded }
  if (hasJobRecords) {
    if (jobRecord) {
      if (jobRecord.status === ExtractionJobStatus.Queued) return { status: DocExtractionStatus.Queued }
      if (jobRecord.status === ExtractionJobStatus.Processing) return { status: DocExtractionStatus.Processing }
      if (jobRecord.status === ExtractionJobStatus.Failed) {
        return hasExtractedData
          ? { status: DocExtractionStatus.Extracted, errorMessage: jobRecord.errorMessage }
          : { status: DocExtractionStatus.Failed, errorMessage: jobRecord.errorMessage }
      }
      if (jobRecord.status === ExtractionJobStatus.Succeeded || hasExtractedData) return { status: DocExtractionStatus.Extracted }
      return { status: DocExtractionStatus.Uploaded }
    }
    return { status: hasExtractedData ? DocExtractionStatus.Extracted : DocExtractionStatus.Uploaded }
  }
  return { status: hasExtractedData ? DocExtractionStatus.Extracted : DocExtractionStatus.Unknown }
}

function summarize(documents: DocExtractionResult[]): ExtractionStatusResult['summary'] {
  return documents.reduce(
    (acc, d) => {
      if (d.status === DocExtractionStatus.Extracted) acc.extracted++
      else if (d.status === DocExtractionStatus.Failed) acc.failed++
      else if (d.status === DocExtractionStatus.NotUploaded) acc.notUploaded++
      else acc.pending++
      return acc
    },
    { total: documents.length, extracted: 0, failed: 0, pending: 0, notUploaded: 0 }
  )
}

/**
 * Declared fields populated on ANY of the document's instances, in registry
 * order — the union across periods, so a two-period statement counts a field
 * once however many periods carry it (v1 counted a T-slot column once too).
 */
function populatedFields(instances: ReadonlyArray<CanonicalInstance>, declared: ReadonlyArray<string>): string[] {
  return declared.filter((f) => instances.some((inst) => {
    const env = inst.fields[f]
    return env !== undefined && isPopulated(env.value)
  }))
}


