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
 * SYS-3728: the currencies a canonical `kind: "currency"` field may hold, and
 * the ONE place a printed currency becomes a code.
 *
 * A stored currency is an ISO 4217 code, never the printed form. "RM", "RM."
 * and "MYR" are one currency printed three ways; storing them as printed makes
 * every reader re-parse symbols, and a reader that re-parses "$" has to guess
 * which of four currencies it meant. So the writer normalizes, once, here, and
 * the validator refuses anything that is not a code in the allowed set.
 */

import { JURISDICTION_DISPLAY_CURRENCY } from './jurisdiction.js'

/**
 * The allowed set. Two sources, stated so it is not mistaken for one:
 *   - every jurisdiction's display currency in the jurisdiction registry
 *     (`JURISDICTION_DISPLAY_CURRENCY`: MYR, VND, THB) — derived, so a new
 *     jurisdiction's currency joins without an edit here;
 *   - four currencies a South-East Asian statement can be reported in without
 *     being that jurisdiction's own (USD, SGD, PHP, IDR), declared here by
 *     decision rather than derived from any registry.
 */
export const CURRENCY_CODES: ReadonlyArray<string> = Object.freeze(
  [...new Set([...Object.values(JURISDICTION_DISPLAY_CURRENCY), 'USD', 'SGD', 'PHP', 'IDR'])].sort()
)

/**
 * Printed form → code. Matched after trimming and collapsing inner
 * whitespace, and case-insensitively (symbols are unaffected by case).
 * Deliberately closed: a form not listed is REFUSED, not guessed.
 */
export const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  RM: 'MYR',
  'RM.': 'MYR',
  MYR: 'MYR',
  'RINGGIT MALAYSIA': 'MYR',
  '₫': 'VND',
  'VNĐ': 'VND',
  VND: 'VND',
  '฿': 'THB',
  THB: 'THB',
  '₱': 'PHP',
  PHP: 'PHP',
  S$: 'SGD',
  SGD: 'SGD',
  RP: 'IDR',
  IDR: 'IDR',
  US$: 'USD',
  USD: 'USD',
})

/**
 * Printed forms that name MORE THAN ONE currency. "$" is the US, Singapore,
 * Hong Kong, Australian … dollar; picking one is a guess about money, so it is
 * refused and the writer must find the currency some other way.
 */
export const AMBIGUOUS_CURRENCY_FORMS: ReadonlyArray<string> = Object.freeze(['$'])

export type CurrencyNormalization =
  | { ok: true; code: string }
  | { ok: false; reason: 'not-a-string' | 'ambiguous' | 'unrecognized' }

/** Is this an allowed ISO 4217 code, exactly as it must be stored? */
export function isAllowedCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODES.includes(value)
}

/**
 * A printed currency as its code — or why it has none. Never returns a code
 * for an ambiguous or unlisted form.
 */
export function normalizeCurrency(printed: unknown): CurrencyNormalization {
  if (typeof printed !== 'string') return { ok: false, reason: 'not-a-string' }
  const form = printed.trim().replace(/\s+/g, ' ').toUpperCase()
  if (AMBIGUOUS_CURRENCY_FORMS.includes(form)) return { ok: false, reason: 'ambiguous' }
  const code = Object.prototype.hasOwnProperty.call(CURRENCY_ALIASES, form) ? CURRENCY_ALIASES[form] : undefined
  if (code === undefined || !isAllowedCurrency(code)) return { ok: false, reason: 'unrecognized' }
  return { ok: true, code }
}

/**
 * SYS-3728 round 3: the ISO 4217 minor units of every allowed currency — how
 * many decimals an amount in it can carry. VND has none (ISO 4217 lists the
 * dong with 0 minor units); every other allowed currency has two.
 *
 * A money value with more decimals than its currency's minor units is REFUSED
 * (`excess-precision`), never rounded: rounding is a decision about money, and
 * the storage column (DECIMAL(18,2)) would otherwise make it silently.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  IDR: 2,
  MYR: 2,
  PHP: 2,
  SGD: 2,
  THB: 2,
  USD: 2,
  VND: 0,
})

/**
 * The most decimals any money value may carry whatever its currency — the
 * storage scale (DECIMAL(18,2)). Also the bound for an amount whose currency
 * is absent or not allowed: that amount is refused on its own account
 * (`currency-missing` / `currency-not-allowed`), and this keeps it from being
 * rounded as well.
 */
export const MONEY_MAX_DECIMALS = 2

/** The decimals an amount in `currency` may carry: its ISO 4217 minor units, else `MONEY_MAX_DECIMALS`. */
export function minorUnitsOf(currency: unknown): number {
  return typeof currency === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_UNITS, currency)
    ? CURRENCY_MINOR_UNITS[currency]!
    : MONEY_MAX_DECIMALS
}

export type CurrencyHeading =
  | { ok: true; code: string; scale: 1 | 1000 | 1000000 }
  | { ok: false; reason: 'not-a-string' | 'ambiguous' | 'unrecognized' }

/** An apostrophe as statements print it: straight, curly, modifier letter, or a backtick. */
const APOS = "['’‘ʼ`]"

/**
 * The scale words a statement's currency heading may carry, after the
 * currency. Closed: anything else ("m" with no apostrophe, "k", "bn") is
 * refused, because a wrong scale is every figure wrong by a factor of a
 * thousand.
 *
 *   thousands  "'000" (any apostrophe, or a space, or none), "('000)",
 *              "(000)", "thousand"
 *   millions   "mil", "mil.", "million", "'m", "'000'000"
 */
const HEADING_SCALES: ReadonlyArray<readonly [RegExp, 1000 | 1000000]> = [
  [new RegExp(`^${APOS}?\\s?000$`, 'u'), 1000],
  [new RegExp(`^\\(\\s?${APOS}?000\\s?\\)$`, 'u'), 1000],
  [/^thousand$/iu, 1000],
  [/^(?:mil\.?|million)$/iu, 1000000],
  [new RegExp(`^${APOS}\\s?m$`, 'iu'), 1000000],
  [new RegExp(`^${APOS}?000${APOS}000$`, 'u'), 1000000],
]

/**
 * A statement's printed currency heading as `{ code, scale }` — "RM" and
 * "Ringgit Malaysia" → MYR ×1; "RM'000", "RM '000", "RM’000", "RM`000",
 * "RM 000", "(RM'000)", "RM('000)", "RM (000)", "RM thousand" → MYR ×1000;
 * "RM mil", "RM Mil.", "RM million", "RM'm", "RM'000'000" → MYR ×1,000,000
 * (SYS-3728 round 4: the headings real statements print); likewise for every
 * form `normalizeCurrency`
 * knows. The currency form is matched by `normalizeCurrency` itself, so the
 * two can never disagree about what "RM" is. Anything not recognized is
 * refused, never guessed.
 */
export function parseCurrencyHeading(printed: unknown): CurrencyHeading {
  if (typeof printed !== 'string') return { ok: false, reason: 'not-a-string' }
  let text = printed.trim().replace(/\s+/g, ' ')
  const bracketed = /^\((.*)\)$/u.exec(text)
  if (bracketed) text = bracketed[1]!.trim()
  const plain = normalizeCurrency(text)
  if (plain.ok) return { ok: true, code: plain.code, scale: 1 }
  // The currency form is the longest leading run that normalizes; the rest must be a scale word.
  for (let cut = text.length - 1; cut > 0; cut--) {
    const head = normalizeCurrency(text.slice(0, cut))
    if (!head.ok) continue
    const rest = text.slice(cut).trim()
    const scale = HEADING_SCALES.find(([re]) => re.test(rest))?.[1]
    return scale === undefined ? { ok: false, reason: 'unrecognized' } : { ok: true, code: head.code, scale }
  }
  return plain
}
