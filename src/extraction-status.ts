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

// ── Helpers ────────────────────────────────────────────────

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (value === 'Not Specified') return false
  return true
}

function hasUploadedFile(fields: FieldData[], ihsRecord: Record<string, unknown>): boolean {
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
  const specs = getBaseFieldSpecs()
  const fileFields = specs.filter((f) => f.type === 'file' && f.ihs_column_names?.length)
  const grouped = groupFieldsByPattern(fileFields)
  const groupDisplayNames = getGroupDisplayNames()

  const documents: DocExtractionResult[] = []

  for (const fileType of Object.values(ExtractionFileType)) {
    const groupName = FILE_TYPE_TO_GROUP[fileType]
    const fields = grouped[groupName] ?? []
    const displayName = groupDisplayNames[groupName] ?? fileType

    const uploaded = fields.length > 0 && hasUploadedFile(fields, ihsRecord)
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

  const summary = {
    total: documents.length,
    extracted: documents.filter((d) => d.status === DocExtractionStatus.Extracted).length,
    failed: documents.filter((d) => d.status === DocExtractionStatus.Failed).length,
    pending: documents.filter((d) =>
      [
        DocExtractionStatus.Queued,
        DocExtractionStatus.Processing,
        DocExtractionStatus.Uploaded,
        DocExtractionStatus.Unknown,
      ].includes(d.status)
    ).length,
    notUploaded: documents.filter((d) => d.status === DocExtractionStatus.NotUploaded).length,
  }

  return { documents, summary }
}
