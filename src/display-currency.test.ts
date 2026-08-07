import { describe, it, expect } from 'vitest'
import { resolveDisplayCurrency, JURISDICTION_DISPLAY_CURRENCY, formatMoney } from './index.js'

/**
 * SYS-3284/SYS-3285. The rule these pin is a precedence, not a lookup:
 * the value's own currency wins, then the jurisdiction's display default,
 * then nothing. "Nothing" is a real answer — a bare grouped number is honest
 * where a guess is not, and guessing is precisely the bug being fixed.
 */
describe('resolveDisplayCurrency', () => {
  it('falls back to the jurisdiction default when the value carries none', () => {
    expect(resolveDisplayCurrency(null, 'MY')).toBe('MYR')
    expect(resolveDisplayCurrency(null, 'VN')).toBe('VND')
    expect(resolveDisplayCurrency(null, 'TH')).toBe('THB')
  })

  it('absent jurisdiction means Malaysia, as everywhere else on this axis', () => {
    expect(resolveDisplayCurrency(null, null)).toBe('MYR')
    expect(resolveDisplayCurrency(undefined, undefined)).toBe('MYR')
  })

  it("the VALUE's own currency always wins over the jurisdiction default", () => {
    // The whole point of SYS-3249: one document can report several currencies.
    // A USD figure on a Vietnamese record must render as USD, not VND.
    expect(resolveDisplayCurrency('USD', 'VN')).toBe('USD')
    expect(resolveDisplayCurrency('VND', 'MY')).toBe('VND')
  })

  it('normalizes a recorded currency, because extraction output is untidy', () => {
    expect(resolveDisplayCurrency('  usd ', 'VN')).toBe('USD')
  })

  it('an unresolvable jurisdiction yields NO currency, not Malaysia', () => {
    // Defaulting here would be the same class of error as the hardcoded 'MYR'
    // this replaces — a confident wrong label instead of an honest blank.
    expect(resolveDisplayCurrency(null, 'ZZ')).toBeUndefined()
    expect(resolveDisplayCurrency(null, '')).toBeUndefined()
  })

  it('every jurisdiction the registry declares has a display currency', () => {
    // Adding a country to JURISDICTION without one would silently drop its
    // amounts back to bare numbers.
    for (const code of Object.values({ MY: 'MY', VN: 'VN', TH: 'TH' })) {
      expect(resolveDisplayCurrency(null, code)).toBeTruthy()
    }
    expect(Object.keys(JURISDICTION_DISPLAY_CURRENCY).sort()).toEqual(['MY', 'TH', 'VN'])
  })
})

describe('formatMoney', () => {
  it('labels a Vietnamese amount VND, not MYR', () => {
    const out = formatMoney(1234567, { jurisdiction: 'VN' })
    expect(out).toContain('VND')
    expect(out).not.toContain('MYR')
    expect(out).not.toContain('RM')
  })

  it('labels a Malaysian amount MYR', () => {
    expect(formatMoney(1000, { jurisdiction: 'MY' })).toContain('MYR')
  })

  it('renders a bare grouped number when nothing names a currency', () => {
    const out = formatMoney(1234567, { jurisdiction: 'ZZ' })
    expect(out).toContain('1,234,567')
    expect(out).not.toMatch(/[A-Z]{3}/)
  })

  it('uses the code, never a bare symbol', () => {
    // Under en-US, USD would render as "$" — the one glyph four other
    // currencies also use. On a cross-jurisdiction credit artifact that is
    // the worst possible default.
    expect(formatMoney(10, { currency: 'USD' })).toContain('USD')
    expect(formatMoney(10, { currency: 'USD' })).not.toBe('$10.00')
  })
})
