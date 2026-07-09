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
 * Four distinct properties, because real consumer code depends on each
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

export interface DocumentTypeGroup {
  /** Wire/dispatch value, e.g. "bankStatements". */
  readonly documentType: string
  /** Render/table grouping key, e.g. "ssm_documents". Distinct from documentType -- see module doc. */
  readonly documentGroup: string
  /** Human-friendly label, e.g. "Bank Statements". */
  readonly label: string
  /** Reserved for a future borrower-client payload-routing consolidation; undefined until every entry in the group declares one. */
  readonly wireFormat?: WireFormat
  /** The catalog's own `type: 'file'` entries belonging to this group, in catalog order. */
  readonly fields: readonly FieldData[]
}

interface TaggedFieldData extends FieldData {
  document_type?: string
  document_group?: string
  document_group_label?: string
  wire_format?: WireFormat
}

let cached: readonly DocumentTypeGroup[] | null = null

function buildDocumentTypeGroups(): readonly DocumentTypeGroup[] {
  const fileFields = getBaseFieldSpecs().filter(
    (f): f is TaggedFieldData => f.type === 'file' && !!f.name,
  )

  const order: string[] = []
  const byDocumentType = new Map<
    string,
    { documentGroup: string; label: string; wireFormat: WireFormat | undefined; fields: FieldData[] }
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
