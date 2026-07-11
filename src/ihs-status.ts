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
 * IHS application status — canonical source of truth, mirroring finsys-api's
 * `IHS_STATUS` enum and `allowedIhsStatus` list in src/utils/appHelper.ts.
 *
 * finsys-api originates these values (it writes them to the `ihs.status`
 * column). Consumer apps (finhub-adonisjs, finsys-client) read them off the
 * wire and use them for validation and display.
 *
 * Lender rejection is not represented by a distinct status: when a lender
 * rejects an application, finsys-api transitions the record back to
 * `APPLICATION_FINALIZED` from `LENDER_EVALUATION`.
 *
 * `EditingApplication` (SYS-2806) is a lender-scoped detour off
 * `LenderEvaluation` for manually editing extracted field values — not
 * reachable from `ApplicationFinalized`. A lender toggles into it and back
 * out to `LenderEvaluation`; it never appears on a record no lender has
 * claimed. See finsys-api's `updateIhsStatusByLender` for the transition
 * guard.
 */
export enum IhsStatus {
  CreatingApplication = 'CREATING_APPLICATION',
  ApplicationFinalized = 'APPLICATION_FINALIZED',
  LenderEvaluation = 'LENDER_EVALUATION',
  EditingApplication = 'EDITING_APPLICATION',
  Approved = 'APPROVED',
  LouDelivered = 'LOU_DELIVERED',
  AwaitingDisbursement = 'AWAITING_DISBURSEMENT',
  Disbursement = 'DISBURSEMENT',
  Declined = 'DECLINED',
  Expired = 'EXPIRED',
  Canceled = 'CANCELED',
}

/**
 * All valid IHS status values, in display order (earliest lifecycle stage
 * first, terminal states last).
 */
export const IHS_VALID_STATUSES: readonly IhsStatus[] = [
  IhsStatus.CreatingApplication,
  IhsStatus.ApplicationFinalized,
  IhsStatus.LenderEvaluation,
  IhsStatus.EditingApplication,
  IhsStatus.Approved,
  IhsStatus.LouDelivered,
  IhsStatus.AwaitingDisbursement,
  IhsStatus.Disbursement,
  IhsStatus.Declined,
  IhsStatus.Expired,
  IhsStatus.Canceled,
] as const

/**
 * Terminal statuses — the application lifecycle has completed and no further
 * transitions are expected. Useful for suppressing action UI (e.g. re-extract,
 * status update controls) on the application detail view.
 */
export const IHS_TERMINAL_STATUSES: readonly IhsStatus[] = [
  IhsStatus.Disbursement,
  IhsStatus.Declined,
  IhsStatus.Expired,
  IhsStatus.Canceled,
] as const

/**
 * Failure statuses — a subset of terminal statuses that represent an
 * unsuccessful outcome. Useful for badge colour / messaging.
 */
export const IHS_FAILURE_STATUSES: readonly IhsStatus[] = [
  IhsStatus.Declined,
  IhsStatus.Expired,
  IhsStatus.Canceled,
] as const

/**
 * Type guard: narrows an unknown value to `IhsStatus` iff it is one of the
 * canonical status strings.
 */
export function isValidIhsStatus(status: unknown): status is IhsStatus {
  return (
    typeof status === 'string' &&
    (IHS_VALID_STATUSES as readonly string[]).includes(status)
  )
}

/**
 * Type guard: terminal (no further transitions expected).
 */
export function isTerminalIhsStatus(status: unknown): status is IhsStatus {
  return (
    typeof status === 'string' &&
    (IHS_TERMINAL_STATUSES as readonly string[]).includes(status)
  )
}

/**
 * Type guard: terminal and unsuccessful.
 */
export function isFailureIhsStatus(status: unknown): status is IhsStatus {
  return (
    typeof status === 'string' &&
    (IHS_FAILURE_STATUSES as readonly string[]).includes(status)
  )
}
