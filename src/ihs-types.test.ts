import { describe, expect, it } from 'vitest'
import { isValidIhsFieldOrigin } from './ihs-types.js'

describe('isValidIhsFieldOrigin', () => {
  it('returns true for every canonical origin value', () => {
    expect(isValidIhsFieldOrigin('extracted')).toBe(true)
    expect(isValidIhsFieldOrigin('derived')).toBe(true)
    expect(isValidIhsFieldOrigin('manual')).toBe(true)
  })

  it('returns false for unknown strings and non-strings', () => {
    expect(isValidIhsFieldOrigin('')).toBe(false)
    expect(isValidIhsFieldOrigin('EXTRACTED')).toBe(false)
    expect(isValidIhsFieldOrigin('computed')).toBe(false)
    expect(isValidIhsFieldOrigin(undefined)).toBe(false)
    expect(isValidIhsFieldOrigin(null)).toBe(false)
    expect(isValidIhsFieldOrigin(42)).toBe(false)
    expect(isValidIhsFieldOrigin({})).toBe(false)
  })
})
