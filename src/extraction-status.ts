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
