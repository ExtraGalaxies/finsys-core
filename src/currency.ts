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
