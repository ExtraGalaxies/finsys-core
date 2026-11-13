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

import { evaluateParsed } from "./expression.js";

/**
 * Utility functions for @finsys/core
 */

export function getPastMonthLabel(monthsAgo: number): string {
  const date = new Date();
  date.setDate(1); // Avoid day-of-month rollover (e.g. Mar 31 → "February" would roll to March)
  date.setMonth(date.getMonth() - monthsAgo);
  return date.toLocaleString('default', { month: 'long' });
}

export function getPastYearLabel(yearsAgo: number): string {
  const date = new Date();
  return (date.getFullYear() - yearsAgo).toString();
}

/**
 * Evaluate a SurveyJS-style expression against a data object.
 * e.g. "{totalFinancing} > 50000"
 *
 * Supports `{field}` references, `= == != === !==`, `< > <= >=`, `+ - * / %`,
 * `! && ||`, parentheses, number/string/boolean/null literals, array literals,
 * and the `anyof`, `allof`, `contains` and `notcontains` operators. A lone `=`
 * is LOOSE equality (`==`). See ./expression.ts for the exact grammar.
 *
 * Evaluation is eval-free (tokenizer + parser + tree walk), so it is safe under
 * a CSP without `'unsafe-eval'`, and an expression cannot reach anything but
 * the `{field}` values of `data`. An empty expression is visible (`true`); an
 * expression that is malformed, uses unsupported syntax, or throws while
 * evaluating is `false`.
 */
export function evaluateExpression(expression: string, data: any): boolean {
  if (!expression) return true;
  if (typeof expression !== 'string') return false;

  try {
    return !!evaluateParsed(expression, data);
  } catch {
    return false;
  }
}
