/*
 * IHS data processing types.
 * Used by finsys-client and finhub-adonisjs to render application details.
 */

export enum IhsValueFormat {
  STRING = 'string',
  CURRENCY = 'currency',
  NUMBER = 'number',
  PERCENTAGE = 'percentage',
  DATE = 'date',
  TABLE = 'table',
}

export interface IhsFieldDetail {
  name: string
  displayName: string
  category: string
  value: unknown
  valueFormat: IhsValueFormat
}

export interface IhsDetailCategory {
  category: string
  items: { name: string; displayName: string; value: unknown; valueFormat: IhsValueFormat }[]
}

export enum FileFieldTableType {
  TIME_SERIES = 'timeSeries',
  KEY_VALUE = 'keyValue',
}

/**
 * Per-field extraction provenance (SYS-2737/SYS-2741). The single canonical
 * envelope — finsys-api writes it (ihs_field_metadata), finsys-core surfaces it
 * onto detail cells, both consumers render it. Vocabulary mirrors adapter_runs
 * (SYS-2441) so FinXtract + adapter provenance converge at SYS-2499 Phase 5.
 *
 *   source      — who produced the value, e.g. "finxtract:ssm"
 *   confidence  — normalized 0..1; null when derived/computed (no score)
 *   observedAt  — ISO wall-clock of the extraction run
 *   sourceRunId — the extraction run/job id that wrote it
 *   origin      — "extracted" (a real {value,confidence} leaf) vs "derived"
 *                 (computed / no-confidence path). A "derived" field must render
 *                 as "no confidence available", never a fabricated low score.
 */
export interface IhsFieldProvenance {
  source: string
  confidence: number | null
  observedAt: string
  sourceRunId: string | null
  origin: 'extracted' | 'derived'
}

export interface FileFieldTableItem {
  displayName: string
  timePeriods: string[]
  data: Record<string, unknown>
  formattedData: Record<string, string>
  type: FileFieldTableType
  isNumeric: boolean
  /**
   * SYS-2741: per-cell extraction provenance, keyed exactly like `data` (period
   * key for TIME_SERIES, `'value'` for KEY_VALUE). `confidence` carries only
   * scored (origin 'extracted') cells so a numeric dot never renders for a
   * derived value; `provenance` carries the full envelope for every known cell.
   */
  confidence?: Record<string, number>
  provenance?: Record<string, IhsFieldProvenance>
}

export interface FileFieldTableData {
  name: string
  displayName: string
  type: FileFieldTableType
  items: FileFieldTableItem[]
  hasData: boolean
}
