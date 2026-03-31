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
 * NOTE: This is a simplified evaluator that replaces {key} with data[key] access.
 * It does not support complex SurveyJS functions like age() or complicated nested paths unless handled by JS.
 */
export function evaluateExpression(expression: string, data: any): boolean {
  if (!expression) return true;
  
  try {
    // 1. Replace {variable} with this['variable'] safely
    let jsExpression = expression.replace(/\{([^}]+)\}/g, (_, key) => {
      // Clean key if needed (trim)
      return `this['${key.trim()}']`;
    });

    // 2. Map SurveyJS comparison operators to JS operators FIRST
    //    (before array operator transforms inject JS code containing '=' assignments)
    // Replace single '=' with '==' if it's not already '==' or '!=' or '>=' or '<='
    jsExpression = jsExpression.replace(/(?<![<>!=])=(?![=])/g, '==');

    // 3. Map SurveyJS array operators to JS equivalents
    //    These run AFTER the '=' transform so their generated JS won't be mangled.

    //    "anyof" → value is one of the items in the array
    //    e.g. this['employmentType'] anyof ['01','08','09']
    //      → (['01','08','09']).includes(this['employmentType'])
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+anyof\s+(\[[^\]]+\])/gi,
      (_, ref, arr) => `(${arr}).includes(${ref})`
    );

    //    "allof" → value (expected to be an array) contains all items
    //    e.g. this['skills'] allof ['a','b']
    //      → ['a','b'].every(item => (this['skills'] || []).includes(item))
    //    Arrow functions inherit `this` from enclosing scope (the new Function call),
    //    so this works correctly with Function.call(data).
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+allof\s+(\[[^\]]+\])/gi,
      (_, ref, arr) => `${arr}.every(item => (${ref} || []).includes(item))`
    );

    //    "contains" → string/array contains value
    //    e.g. this['roles'] contains 'admin'
    //    Uses || [] fallback to handle both string and array values correctly.
    //    (|| '' would stringify arrays causing false positives)
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+contains\s+'([^']+)'/gi,
      (_, ref, val) => `(${ref} || []).includes('${val}')`
    );

    //    "notcontains" → string/array does not contain value
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+notcontains\s+'([^']+)'/gi,
      (_, ref, val) => `!(${ref} || []).includes('${val}')`
    );

    // 4. Execute with Function, binding 'data' as 'this'
    const func = new Function(`return ${jsExpression};`);
    return !!func.call(data || {});
  } catch (e) {
    // console.warn(`Failed to evaluate expression: "${expression}"`, e);
    return false;
  }
}
