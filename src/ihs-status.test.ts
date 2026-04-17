import { describe, expect, it } from 'vitest'
import {
  IhsStatus,
  IHS_VALID_STATUSES,
  IHS_TERMINAL_STATUSES,
  IHS_FAILURE_STATUSES,
  isValidIhsStatus,
  isTerminalIhsStatus,
  isFailureIhsStatus,
} from './ihs-status.js'

describe('IhsStatus', () => {
  it('enum values match finsys-api IHS_STATUS string values', () => {
    expect(IhsStatus.CreatingApplication).toBe('CREATING_APPLICATION')
    expect(IhsStatus.ApplicationFinalized).toBe('APPLICATION_FINALIZED')
    expect(IhsStatus.LenderEvaluation).toBe('LENDER_EVALUATION')
    expect(IhsStatus.Approved).toBe('APPROVED')
    expect(IhsStatus.LouDelivered).toBe('LOU_DELIVERED')
    expect(IhsStatus.AwaitingDisbursement).toBe('AWAITING_DISBURSEMENT')
    expect(IhsStatus.Disbursement).toBe('DISBURSEMENT')
    expect(IhsStatus.Declined).toBe('DECLINED')
    expect(IhsStatus.Expired).toBe('EXPIRED')
    expect(IhsStatus.Canceled).toBe('CANCELED')
  })

  it('IHS_VALID_STATUSES has exactly 10 entries matching finsys-api allowedIhsStatus', () => {
    expect(IHS_VALID_STATUSES).toHaveLength(10)
    expect(IHS_VALID_STATUSES).toEqual([
      'CREATING_APPLICATION',
      'APPLICATION_FINALIZED',
      'LENDER_EVALUATION',
      'APPROVED',
      'LOU_DELIVERED',
      'AWAITING_DISBURSEMENT',
      'DISBURSEMENT',
      'DECLINED',
      'EXPIRED',
      'CANCELED',
    ])
  })

  it('REJECTED is NOT a valid status — lender rejection transitions back to APPLICATION_FINALIZED', () => {
    expect(isValidIhsStatus('REJECTED')).toBe(false)
    expect((IHS_VALID_STATUSES as readonly string[]).includes('REJECTED')).toBe(false)
  })
})

describe('isValidIhsStatus', () => {
  it('returns true for every canonical status', () => {
    for (const status of IHS_VALID_STATUSES) {
      expect(isValidIhsStatus(status)).toBe(true)
    }
  })

  it('returns false for unknown strings and non-strings', () => {
    expect(isValidIhsStatus('')).toBe(false)
    expect(isValidIhsStatus('creating_application')).toBe(false)
    expect(isValidIhsStatus('SUBMITTED')).toBe(false)
    expect(isValidIhsStatus(undefined)).toBe(false)
    expect(isValidIhsStatus(null)).toBe(false)
    expect(isValidIhsStatus(42)).toBe(false)
    expect(isValidIhsStatus({})).toBe(false)
  })
})

describe('isTerminalIhsStatus', () => {
  it('returns true for disbursement and the failure statuses', () => {
    expect(isTerminalIhsStatus(IhsStatus.Disbursement)).toBe(true)
    expect(isTerminalIhsStatus(IhsStatus.Declined)).toBe(true)
    expect(isTerminalIhsStatus(IhsStatus.Expired)).toBe(true)
    expect(isTerminalIhsStatus(IhsStatus.Canceled)).toBe(true)
  })

  it('returns false for in-progress statuses', () => {
    expect(isTerminalIhsStatus(IhsStatus.CreatingApplication)).toBe(false)
    expect(isTerminalIhsStatus(IhsStatus.ApplicationFinalized)).toBe(false)
    expect(isTerminalIhsStatus(IhsStatus.LenderEvaluation)).toBe(false)
    expect(isTerminalIhsStatus(IhsStatus.Approved)).toBe(false)
    expect(isTerminalIhsStatus(IhsStatus.LouDelivered)).toBe(false)
    expect(isTerminalIhsStatus(IhsStatus.AwaitingDisbursement)).toBe(false)
  })

  it('IHS_TERMINAL_STATUSES is a subset of IHS_VALID_STATUSES', () => {
    for (const status of IHS_TERMINAL_STATUSES) {
      expect((IHS_VALID_STATUSES as readonly string[]).includes(status)).toBe(true)
    }
  })
})

describe('isFailureIhsStatus', () => {
  it('returns true for declined/expired/canceled and false for disbursement', () => {
    expect(isFailureIhsStatus(IhsStatus.Declined)).toBe(true)
    expect(isFailureIhsStatus(IhsStatus.Expired)).toBe(true)
    expect(isFailureIhsStatus(IhsStatus.Canceled)).toBe(true)
    expect(isFailureIhsStatus(IhsStatus.Disbursement)).toBe(false)
  })

  it('IHS_FAILURE_STATUSES is a subset of IHS_TERMINAL_STATUSES', () => {
    for (const status of IHS_FAILURE_STATUSES) {
      expect((IHS_TERMINAL_STATUSES as readonly string[]).includes(status)).toBe(true)
    }
  })
})
