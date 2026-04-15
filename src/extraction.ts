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
 * Document types that go through FinXtract extraction.
 * Values must match the `type` field on finsys-api File entity
 * and the config keys in finXtractApi.api.
 */
export enum ExtractionFileType {
  FinancialStatement = 'financialStatements',
  BankStatement = 'bankStatements',
  Epf = 'epfStatements',
  Payslip = 'payslips',
  Ssm = 'ssm',
  Form9 = 'form9',
  Ic = 'ic',
}
