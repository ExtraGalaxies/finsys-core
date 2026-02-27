/**
 * Utility functions for @finsys/core
 */

export function getPastMonthLabel(monthsAgo: number): string {
  const date = new Date();
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

    // 2. Map SurveyJS operators to JS operators
    // Replace single '=' with '==' if it's not already '==' or '!=' or '>=' or '<='
    // Simplistic approach: look for '=' that are not preceded or followed by other operator chars
    jsExpression = jsExpression.replace(/(?<![<>!=])=(?![=])/g, '==');

    // 3. Execute with Function, binding 'data' as 'this'
    const func = new Function(`return ${jsExpression};`);
    return !!func.call(data || {});
  } catch (e) {
    // console.warn(`Failed to evaluate expression: "${expression}"`, e);
    return false;
  }
}
