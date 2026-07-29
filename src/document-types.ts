/*
 * Document type registry.
 *
 * Single source of truth for "which FinXtract document types exist,"
 * derived directly from the field-spec catalog (form-field-base-specs.json)
 * instead of hand-synchronized code. This replaces four previously-separate
 * structures that had to be edited together by hand:
 *   - extraction.ts's closed ExtractionFileType enum
 *   - extraction-status.ts's FILE_TYPE_TO_GROUP map
 *   - ihs-processing.ts's FIELD_GROUP_PREFIXES + GROUP_DISPLAY_NAMES
 *
 * Adding a new document type (e.g. invoices) is now a data-only edit to
 * form-field-base-specs.json -- tag its `type: 'file'` entries with
 * document_type/document_group/document_group_label/wire_format, no
 * TypeScript union to edit, no exhaustive map to keep in sync by hand.
 *
 * Six distinct properties, because real consumer code depends on each
 * independently (confirmed by direct trace, not assumed):
 *   - document_type: the wire/dispatch value (e.g. "bankStatements") --
 *     what File.type, processIhsUpdate's switch, and ocrValidator's
 *     allowlist key on.
 *   - document_group: the render/table grouping key (e.g. "ssm_documents")
 *     -- what buildFileFieldTables's output is keyed by. finsys-client's
 *     ihs_controller.ts specifically special-cases the literal string
 *     "ssm_documents" (skips it in favor of a dedicated partial), so this
 *     must stay a distinct, stable value from document_type, not merged.
 *   - document_group_label: human-friendly table/status display label.
 *   - wire_format: reserved for a future @finsys/borrower-client
 *     consolidation of its own payload-transfer.ts registry (not consumed
 *     by anything in this package yet) -- 'path_array' | 'url_string' |
 *     'path_only', mirroring the shapes borrower-client already uses.
 *   - document_slot: which UPLOAD position this field represents (1st
 *     document, 2nd, etc.) -- known at upload time, before extraction
 *     ever runs. Distinct from a "time period slot" (which final
 *     displayed period the EXTRACTED DATA populates): for bank
 *     statements/EPF/payslips these are always 1:1 (one document, one
 *     period), but for financial statements one document can supply TWO
 *     periods' worth of data (audited financials show two comparative
 *     years per document) -- that reconciliation is genuinely
 *     extraction-time behavior, not catalog data, and is NOT captured
 *     by document_slot. document_slot is exactly what
 *     @finsys/borrower-client's payload-transfer.ts currently has to
 *     regex-capture out of the field name (e.g. `bank_statement_t(\d+)`)
 *     -- reserved here for that future consolidation, not consumed by
 *     anything in this package yet. `financials` (slot 1) and
 *     `financials_fincap_t1` (also slot 1) are NOT a duplicate-slot bug:
 *     they're alternate catalog entries for different form variants
 *     (confirmed by direct read -- both share document_group "financials"
 *     but represent mutually exclusive form paths, never populated
 *     together on one IHS), so both correctly describe "the first
 *     physical document uploaded" for their respective variant.
 *   - time_period_unit: what unit document_slot's number measures for
 *     this field -- 'month' | 'year'. Confirmed by the actual catalog
 *     data, not assumed: bank statements and payslips are monthly,
 *     financial statements and EPF statements are annual (EPF's own
 *     column names literally contain "Year", e.g. epfStatementYearT1).
 *
 * Mirrors the AdapterCategory pattern (SYS-2500): runtime lookup/grouping
 * derived from JSON data, no compile-time exhaustiveness. Same trade-off
 * applies -- no autocomplete on a document-type string; a wrong one is
 * caught by isDocumentType/assertDocumentType at the trust boundary
 * instead of by the compiler.
 */

import { getBaseFieldSpecs } from './catalogs.js'
import type { FieldData } from './survey-generator.js'

export type WireFormat = 'path_array' | 'url_string' | 'path_only'
export type TimePeriodUnit = 'month' | 'year'

export interface DocumentTypeGroup {
  /** Wire/dispatch value, e.g. "bankStatements". */
  readonly documentType: string
  /** Render/table grouping key, e.g. "ssm_documents". Distinct from documentType -- see module doc. */
  readonly documentGroup: string
  /** Human-friendly label, e.g. "Bank Statements". */
  readonly label: string
  /** Reserved for a future borrower-client payload-routing consolidation. Taken from the group's first entry; not enforced consistent across entries (all groups agree today, but a future mixed-format group would silently inherit the first entry's value). */
  readonly wireFormat?: WireFormat
  /**
   * The catalog's own `type: 'file'` entries belonging to this group, in
   * catalog order. Each entry may carry its own document_slot/
   * time_period_unit -- see TaggedFieldData and the module doc.
   */
  readonly fields: readonly TaggedFieldData[]
}

export interface TaggedFieldData extends FieldData {
  document_type?: string
  document_group?: string
  document_group_label?: string
  wire_format?: WireFormat
  /** Which upload position this field represents (1st document, 2nd, etc). See module doc for why this is distinct from a "time period". */
  document_slot?: number
  /** What unit document_slot's number measures for this field. */
  time_period_unit?: TimePeriodUnit
  /**
   * SYS-2873: languages this upload slot's per-file document-language
   * selector offers (e.g. ["vi", "en"]). Presence of the tag is what makes
   * a renderer show the selector at all — entries without it (every
   * Malaysia slot) render no language UI. The uploader's per-file choice
   * travels with each uploaded file entry (ParsedDocFile.documentLanguage)
   * and selects the extraction endpoint upstream. This tag is UX metadata:
   * the server-side endpoint registry stays authoritative for which
   * languages are actually callable.
   */
  document_language_options?: readonly string[]
}

let cached: readonly DocumentTypeGroup[] | null = null

function buildDocumentTypeGroups(): readonly DocumentTypeGroup[] {
  const fileFields = getBaseFieldSpecs().filter(
    (f): f is TaggedFieldData => f.type === 'file' && !!f.name,
  )

  const order: string[] = []
  const byDocumentType = new Map<
    string,
    {
      documentGroup: string
      label: string
      wireFormat: WireFormat | undefined
      fields: TaggedFieldData[]
    }
  >()

  for (const f of fileFields) {
    // Untagged entries (none exist today, but future-proofed): fall back
    // to the entry's own name/displayName as a single-entry group.
    const documentType = f.document_type ?? f.name!
    const documentGroup = f.document_group ?? documentType
    const label = f.document_group_label ?? f.displayName ?? documentType

    if (!byDocumentType.has(documentType)) {
      order.push(documentType)
      byDocumentType.set(documentType, {
        documentGroup,
        label,
        wireFormat: f.wire_format,
        fields: [],
      })
    }
    byDocumentType.get(documentType)!.fields.push(f)
  }

  return order.map((documentType) => {
    const entry = byDocumentType.get(documentType)!
    return {
      documentType,
      documentGroup: entry.documentGroup,
      label: entry.label,
      wireFormat: entry.wireFormat,
      fields: entry.fields,
    }
  })
}

/** Every registered document type, in catalog declaration order. */
export function getDocumentTypeGroups(): readonly DocumentTypeGroup[] {
  if (!cached) cached = buildDocumentTypeGroups()
  return cached
}

/** True if `id` is a registered document type (the wire/dispatch value). */
export function isDocumentType(id: string): boolean {
  return getDocumentTypeGroups().some((g) => g.documentType === id)
}

/** Returns `id` if it's a registered document type, otherwise throws. */
export function assertDocumentType(id: string): string {
  if (!isDocumentType(id)) {
    const known = getDocumentTypeGroups().map((g) => g.documentType)
    throw new Error(`Unknown document type: "${id}". Available: ${known.join(', ')}`)
  }
  return id
}
