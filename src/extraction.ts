/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Status of a document extraction job.
 * Used by finsys-api (writes) and finhub/finsys-client (reads/displays).
 */
export enum ExtractionJobStatus {
  Queued = 'queued',
  Processing = 'processing',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

/**
 * Document types that go through FinXtract extraction. Values must match
 * the `type` field on finsys-api's File entity and the config keys in
 * finXtractApi.api.
 *
 * Was a closed enum (FinancialStatement/BankStatement/Epf/Payslip/Ssm/
 * Form9/Ic) requiring a core release to add a new document type, even
 * though nothing outside finsys-api's own request validation actually
 * needed it to be a closed set (confirmed: zero external consumers
 * import a specific member by name). Now an open string, matching the
 * AdapterCategory precedent (SYS-2500) -- the authoritative set of valid
 * values lives in document-types.ts, derived from the field-spec catalog.
 * Use isDocumentType()/assertDocumentType() from document-types.ts for
 * the runtime validation that used to be the enum's job.
 */
export type ExtractionFileType = string
