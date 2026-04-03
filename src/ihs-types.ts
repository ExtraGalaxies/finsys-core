/*
 * IHS data processing types.
 * Used by finsys-client and finhub-adonisjs to render application details.
 */

export type IhsValueFormat = 'string' | 'currency' | 'number' | 'percentage' | 'date' | 'table'

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

export type FileFieldTableType = 'timeSeries' | 'keyValue'

export interface FileFieldTableItem {
  displayName: string
  timePeriods: string[]
  data: Record<string, unknown>
  formattedData: Record<string, string>
  type: FileFieldTableType
  isNumeric: boolean
}

export interface FileFieldTableData {
  name: string
  displayName: string
  type: FileFieldTableType
  items: FileFieldTableItem[]
  hasData: boolean
}
