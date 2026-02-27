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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPastMonthLabel, getPastYearLabel, evaluateExpression } from './utils.js';

describe('getPastMonthLabel', () => {
  it('should return a month name string', () => {
    const label = getPastMonthLabel(1);
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('should return a different month for different offsets', () => {
    const month1 = getPastMonthLabel(1);
    const month2 = getPastMonthLabel(2);
    // These could theoretically collide if run at exact month boundary, but
    // for offsets 1 and 2 they should always differ
    expect(month1).not.toBe(month2);
  });

  it('should handle offset of 0 (current month)', () => {
    const label = getPastMonthLabel(0);
    const expected = new Date().toLocaleString('default', { month: 'long' });
    expect(label).toBe(expected);
  });

  it('should wrap around years correctly (e.g., 12 months ago)', () => {
    const label = getPastMonthLabel(12);
    // 12 months ago should be the same month name as now
    const expected = new Date().toLocaleString('default', { month: 'long' });
    expect(label).toBe(expected);
  });
});

describe('getPastYearLabel', () => {
  it('should return the current year for offset 0', () => {
    const label = getPastYearLabel(0);
    expect(label).toBe(new Date().getFullYear().toString());
  });

  it('should return last year for offset 1', () => {
    const label = getPastYearLabel(1);
    expect(label).toBe((new Date().getFullYear() - 1).toString());
  });

  it('should return a year string for any offset', () => {
    const label = getPastYearLabel(5);
    expect(label).toBe((new Date().getFullYear() - 5).toString());
  });
});

describe('evaluateExpression', () => {
  it('should return true for empty/falsy expression', () => {
    expect(evaluateExpression('', {})).toBe(true);
    expect(evaluateExpression(null as any, {})).toBe(true);
    expect(evaluateExpression(undefined as any, {})).toBe(true);
  });

  describe('variable substitution', () => {
    it('should resolve {variable} references from data', () => {
      expect(evaluateExpression('{age} > 18', { age: 25 })).toBe(true);
      expect(evaluateExpression('{age} > 18', { age: 10 })).toBe(false);
    });

    it('should handle string comparisons', () => {
      expect(evaluateExpression("{status} == 'active'", { status: 'active' })).toBe(true);
      expect(evaluateExpression("{status} == 'active'", { status: 'inactive' })).toBe(false);
    });

    it('should handle undefined variables gracefully', () => {
      // Undefined variables should not throw, expression evaluates to false
      expect(evaluateExpression('{missing} > 0', {})).toBe(false);
    });
  });

  describe('SurveyJS operator mapping', () => {
    it('should convert single = to == for equality checks', () => {
      expect(evaluateExpression('{value} = 5', { value: 5 })).toBe(true);
      expect(evaluateExpression('{value} = 5', { value: 10 })).toBe(false);
    });

    it('should preserve != operator', () => {
      expect(evaluateExpression('{value} != 5', { value: 10 })).toBe(true);
      expect(evaluateExpression('{value} != 5', { value: 5 })).toBe(false);
    });

    it('should preserve >= operator', () => {
      expect(evaluateExpression('{value} >= 10', { value: 10 })).toBe(true);
      expect(evaluateExpression('{value} >= 10', { value: 5 })).toBe(false);
    });

    it('should preserve <= operator', () => {
      expect(evaluateExpression('{value} <= 10', { value: 10 })).toBe(true);
      expect(evaluateExpression('{value} <= 10', { value: 15 })).toBe(false);
    });

    it('should preserve == operator', () => {
      expect(evaluateExpression('{value} == 10', { value: 10 })).toBe(true);
    });
  });

  describe('boolean expressions', () => {
    it('should evaluate boolean true/false values', () => {
      expect(evaluateExpression('{flag} = true', { flag: true })).toBe(true);
      expect(evaluateExpression('{flag} = true', { flag: false })).toBe(false);
    });

    it('should handle truthy/falsy coercion', () => {
      expect(evaluateExpression('{value} > 0', { value: 1 })).toBe(true);
      expect(evaluateExpression('{value} > 0', { value: 0 })).toBe(false);
    });
  });

  describe('comparison operators', () => {
    it('should handle > operator', () => {
      expect(evaluateExpression('{totalFinancing} > 50000', { totalFinancing: 100000 })).toBe(true);
      expect(evaluateExpression('{totalFinancing} > 50000', { totalFinancing: 30000 })).toBe(false);
    });

    it('should handle < operator', () => {
      expect(evaluateExpression('{amount} < 100', { amount: 50 })).toBe(true);
      expect(evaluateExpression('{amount} < 100', { amount: 200 })).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle null data', () => {
      // Should not throw, returns false
      expect(evaluateExpression('{x} > 0', null)).toBe(false);
    });

    it('should handle malformed expressions gracefully', () => {
      expect(evaluateExpression('{{invalid', {})).toBe(false);
      expect(evaluateExpression('not a valid expression !!!', {})).toBe(false);
    });

    it('should handle keys with spaces', () => {
      expect(evaluateExpression('{my field} = 5', { 'my field': 5 })).toBe(true);
    });
  });
});
