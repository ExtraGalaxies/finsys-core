/*
 * Extraction status resolution.
 *
 * Determines per-document extraction status from IHS record data
 * and optional extraction job records. Pure synchronous function —
 * no HTTP, no async, trivially testable.
 */

import { ExtractionFileType, ExtractionJobStatus } from './extraction.js'
import { getBaseFieldSpecs } from './catalogs.js'
import { getGroupDisplayNames, groupFieldsByPattern } from './ihs-processing.js'
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

// ── Map ExtractionFileType to field group names used by groupFieldsByPattern ──

const FILE_TYPE_TO_GROUP: Record<ExtractionFileType, string> = {
  [ExtractionFileType.BankStatement]: 'bank_statements',
  [ExtractionFileType.FinancialStatement]: 'financials',
  [ExtractionFileType.Epf]: 'epf_statements',
  [ExtractionFileType.Payslip]: 'payslip_statements',
  [ExtractionFileType.Ssm]: 'ssm_documents',
  [ExtractionFileType.Form9]: 'form9',
  [ExtractionFileType.Ic]: 'ic_documents',
}

// ── Static field metadata (derived once at module load) ────

const _specs = getBaseFieldSpecs()
const _fileFields = _specs.filter((f) => f.type === 'file' && f.ihs_column_names?.length)
const _grouped = groupFieldsByPattern(_fileFields)
const _groupDisplayNames = getGroupDisplayNames()

// ── Helpers ────────────────────────────────────────────────

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (value === 'Not Specified') return false
  return true
}

function hasUploadedFile(
  fields: FieldData[],
  ihsRecord: Record<string, unknown>,
  aggregateKey: string
): boolean {
  // Check the aggregate key first (e.g. ihsRecord['bankStatements']).
  // IHS records store multi-file uploads as a JSON array under the ExtractionFileType value,
  // not under individual field spec names like 'bank_statement_t1'.
  if (isPopulated(ihsRecord[aggregateKey])) return true

  // Fall back to individual field names for single-file types (ssm, form9, ic)
  return fields.some((field) => {
    if (!field.name) return false
    return isPopulated(ihsRecord[field.name])
  })
}

function getExtractionColumns(fields: FieldData[]): string[] {
  const columns: string[] = []
  for (const field of fields) {
    if (field.ihs_column_names) {
      columns.push(...field.ihs_column_names)
    }
  }
  return columns
}

function getPopulatedColumns(
  columns: string[],
  ihsRecord: Record<string, unknown>
): string[] {
  return columns.filter((col) => isPopulated(ihsRecord[col]))
}

// ── Main function ──────────────────────────────────────────

/**
 * Determines per-document extraction status from IHS record data.
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

  for (const fileType of Object.values(ExtractionFileType)) {
    const groupName = FILE_TYPE_TO_GROUP[fileType]
    const fields = _grouped[groupName] ?? []
    const displayName = _groupDisplayNames[groupName] ?? fileType

    const uploaded = fields.length > 0 && hasUploadedFile(fields, ihsRecord, fileType)
    const allColumns = getExtractionColumns(fields)
    const populated = getPopulatedColumns(allColumns, ihsRecord)
    const hasExtractedData = populated.length > 0

    let status: DocExtractionStatus
    let errorMessage: string | null | undefined

    if (!uploaded) {
      status = DocExtractionStatus.NotUploaded
    } else if (jobRecords) {
      const job = jobRecords.find((j) => j.fileType === fileType)

      if (job) {
        // Queued/Processing: show in-progress state even if stale extracted data exists.
        // Contrast with Failed, where existing data is preserved as the best-available result.
        if (job.status === ExtractionJobStatus.Queued) {
          status = DocExtractionStatus.Queued
        } else if (job.status === ExtractionJobStatus.Processing) {
          status = DocExtractionStatus.Processing
        } else if (job.status === ExtractionJobStatus.Failed) {
          if (hasExtractedData) {
            status = DocExtractionStatus.Extracted
            errorMessage = job.errorMessage
          } else {
            status = DocExtractionStatus.Failed
            errorMessage = job.errorMessage
          }
        } else if (job.status === ExtractionJobStatus.Succeeded || hasExtractedData) {
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

    documents.push({
      fileType,
      status,
      displayName,
      populatedColumns: populated,
      totalColumns: allColumns.length,
      errorMessage,
    })
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
