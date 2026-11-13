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

// evaluateExpression no longer compiles JavaScript. These tests hold the
// eval-free evaluator to the behaviour of the implementation it replaced.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateExpression } from './utils.js';

/**
 * The implementation that shipped through 9.10.0, kept verbatim as the oracle.
 * It is the only `new Function` left in the package and it lives in a test.
 */
function legacyEvaluateExpression(expression: string, data: any): boolean {
  if (!expression) return true;

  try {
    let jsExpression = expression.replace(/\{([^}]+)\}/g, (_, key) => {
      return `this['${key.trim()}']`;
    });
    jsExpression = jsExpression.replace(/(?<![<>!=])=(?![=])/g, '==');
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+anyof\s+(\[[^\]]+\])/gi,
      (_, ref, arr) => `(${arr}).includes(${ref})`
    );
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+allof\s+(\[[^\]]+\])/gi,
      (_, ref, arr) => `${arr}.every(item => (${ref} || []).includes(item))`
    );
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+contains\s+'([^']+)'/gi,
      (_, ref, val) => `(${ref} || []).includes('${val}')`
    );
    jsExpression = jsExpression.replace(
      /(this\['[^']+'\])\s+notcontains\s+'([^']+)'/gi,
      (_, ref, val) => `!(${ref} || []).includes('${val}')`
    );
    const func = new Function(`return ${jsExpression};`);
    return !!func.call(data || {});
  } catch (e) {
    return false;
  }
}

/** Every distinct visibleIf expression known to be in use in form configs and docs. */
const INVENTORY = [
  "{employmentType} anyof ['01', '02', '07', '08', '09', '10' ]",
  "{employmentType} anyof ['01', '08', '09']",
  "{employmentType} anyof ['01', '07', '08', '09', '10']",
  '{residenceAddress} == false',
  "{idType} == 'MI'",
  "{idType} == 'MK'",
  "{businessType} = 'other'",
  '{employmentType} = "employed"',
  '{showField} = true',
  '{showEmail} = true',
  '{test} == "test"',
  '{totalFinancing} > 50000',
  '{age} >= 21',
  "{color} = 'red'",
  // In use, but never supported by this evaluator: a JavaScript syntax error,
  // so always false.
  '{financingTenure} notempty',
  '{name} notempty',
];

/** One shape per operator and per piece of syntax JavaScript used to give for free. */
const TARGETED = [
  // comparison and equality
  '{a} = 5', '{a} == 5', '{a} != 5', '{a} === 5', '{a} !== 5', "{a} === '5'", "{a} !== '5'",
  '{a} < 5', '{a} > 5', '{a} <= 5', '{a} >= 5', '{a}=5', '{a}>=5', '{ a } = 5', '{a}',
  "{a} == '5'", '{a} == true', '{a} == false', '{a} == null', '{a} != null', '{a} == undefined',
  '{a} == {b}', '{a} != {b}', '{a} === {b}', '{a} > {b}', '{a} < {b}', "{a} = ''", '{a} == 0',
  // numbers
  '{a} == 08', '{a} == 010', '{a} == 01', '{a} == 1e2', '{a} == .5', '{a} < 5.', '{a} == 0.5', '{a} > -1',
  // strings
  "{a} == 'it\\'s'", '{a} == "say \\"hi\\""', "{a} == 'a\\u0062'", "{a} == '\\x62'", "{a} == 'a\\nb'",
  "{a} == 'a\\\nb'",
  // logic, negation, grouping
  '{a} && {b}', '{a} || {b}', '!{a}', '!!{a}', '!({a} == 1)', '({a})', '(({a}) > 1)', '{a} > 1 > 0',
  '{a} > 1 && {b} < 5 || {c} == 2', '{a} > 1 || {b} < 5 && {c} == 2', '({a} == 1 || {b} == 2) && {c}',
  '{a} == 1 && {b} == 2 && {c} == 3', '{a} == 1 || {b} == 2 || {c} == 3',
  // operator words need whitespace on both sides
  "{a}anyof ['a']", "{a} anyof['a']", "{a}allof ['a']", "{a} allof['a']", "{a}contains 'x'", "{a} contains'x'",
  "{a}notcontains 'x'", "{a} notcontains'x'", "{a}ANYOF ['a']", "{a}\tanyof\t['a']", "{a}\nanyof\n['a']",
  "{a}\ncontains\n'x'", "{a} anyof  ['a']",
  // escapes in a contains operand: only an escaped single quote is rejected
  "{a} contains 'it\\'s'", "{a} notcontains 'it\\'s'", "{a} contains 'a\\\\'", "{a} contains 'a\\nb'",
  "{a} contains '\\x61'", "{a} contains '\\u0061'", "{a} contains \"it's\"", "{a} contains 'say \"hi\"'",
  "{a} contains 'it\\'s' || {b} == 1",
  // legacy octal escapes in strings, as sloppy-mode JavaScript decodes them
  "{a} == '\\0'", "{a} == '\\01'", "{a} == '\\1'", "{a} == '\\7'", "{a} == '\\101'", "{a} == '\\08'",
  "{a} == '\\18'", "{a} == '\\8'", "{a} == '\\9'", "{a} == '\\377'", "{a} == '\\400'", "{a} == '\\477'",
  "{a} == '\\1011'", "{a} == '\\00'", "{a} == '\\000'", "{a} == '\\0000'", "{a} == \"\\101\"", "{a} == '\\78'",
  // leading-zero numbers: legacy octal only when every digit is 0-7 and nothing follows
  '{a} == 07.5', '{a} == 07e1', '{a} == 07.', '{a} == 00.5', '{a} == 01e1', '{a} == 08.5', '{a} == 09e1',
  '{a} == 08.', '{a} == 0189.5', '{a} == 0178', '{a} == 0e1', '{a} == 00', '{a} == 007', '{a} == 0.5e1',
  // arithmetic
  '{a} + {b} > 10', '{a} + {b}', '{a} - {b}', '{a} * 2 == {b}', '{a} / 2 > 1', '{a} % 2 == 0',
  '-{a} < 0', '+{a} > 0', '{a} - -1 > 0', "{a} + 'x' == 'x'",
  // array literals
  '[1] == {a}', '{a} == [1]', '[{a}, {b}]', '[]', '[1, 2,]',
  // literals on their own
  'true', 'false', 'null', 'undefined', '1', '0', "''", "'x'",
  // anyof / allof / contains / notcontains
  "{a} anyof ['a', 'b']", "{a} anyof [1, 2]", "{a} anyof [ ]", '{a} anyof []',
  "{a} allof ['a', 'b']", "{a} allof [1]", '{a} allof [ ]', '{a} allof []',
  "{a} contains 'x'", "{a} contains 'a'", "{a} contains '01'", "{a} notcontains 'x'", "{a} notcontains 'a'",
  "{a} ANYOF ['a']", "{a} AllOf ['a']", "{a} Contains 'x'", "{a} NOTCONTAINS 'x'",
  "{a} contains ''", '{a} contains "x"', '{a} contains {b}', '{a} contains 1', '{a} anyof {b}', "{a} anyof 'a'",
  "!{a} anyof ['a']", "!{a} contains 'a'", "{a} notcontains 'x' == false", "{a} contains 'x' == true",
  "{a} contains 'x' && {b} anyof ['1', '2']", "{a} contains 'x' || {b} notcontains 'y'",
  "{a} == 1 || {b} contains 'x'", "{a} == 2 && {b} contains 'x'",
  "{a} anyof ['a'] || {b} allof ['b']", "({a} anyof ['a']) && ({b} == 1)",
  "'a' anyof ['a']", "({a}) anyof ['a']", "{a} anyof ['a'] anyof ['b']",
  // malformed or unsupported: always false, in both
  '{{invalid', 'not a valid expression !!!', '{a', '{', '}', '{}x', '{a} <> 1', '{a} and {b}', '{a} or {b}',
  'not {a}', '{a} empty', '{a} notempty', '{a} = = 1', '{a} ==', '== 1', ')(', '(', '[', '{a} {b}', '{a} 1',
  "{a} anyof ['a'", "{a} == 'unterminated", '{a} --1', '{a} ++ 1', '{a} === = 1', '{a} => 1', '{a} +== 1',
  '{a} == 0x10', '{a} == 5abc', 'x == 1', ';', '{a};;', '{a} ;', '{a}; ;',
];

/**
 * JavaScript the old evaluator ran by accident. Each is now a parse error and
 * so `false`; the differential test does not cover them because they are the
 * point of the change.
 */
const NO_LONGER_EVALUATED = [
  '{a} & {b}', '{a} | {b}', '{a} ? 1 : 2', '{a} ?? 1', '{a} ** 2', '{a} in {b}', 'typeof {a}',
  '{a} // c', '/* c */ {a}', '{a}.length > 0', "{a}.includes('x')", 'this.a == 1', 'globalThis', 'window',
  'process', 'NaN', 'Infinity', '{a} == 1; {b}',
  // array holes, the comma operator and numeric separators
  "{a} anyof [,'a']", "{a} allof [,'a']", '{a} == [1,,2]', "[,'a']", '[1,,2]', '{a}, {b}', '({a}, {b})',
  '{a} == 1, {b} == 1', '{a} == 1_000', '1_000 == {a}', '{a} == 1_000.5',
];

const EXPRESSIONS = [...INVENTORY, ...TARGETED];

/** Missing, nullish, empty, falsy, numeric-looking, array and object values. */
const VALUES: unknown[] = [
  undefined, null, '', '0', '1', '01', '08', '09', '10', '5', 5, 0, 1, 8, 10, 21, 100000, 50001, -1, 0.5, 100, 'x', 'a', 'a\nb', "it's", 'say "hi"', 'b',
  true, false, 'true', 'false', 'active', 'inactive', 'employed', 'other', 'red', 'test', 'MK', 'MI', 'super-admin', 'admin', 'abc',
  [], [''], ['a'], ['b'], ['a', 'b'], ['a', 'b', 'c'], ['ab'], ['x'], ['01'], ['01', '08'], ['js', 'ts'], ['js', 'ts', 'python'], [1], [1, 2], [5], [true],
  7.5, 70, 8.5, 90, 189.5, 1000,
  '\u0001', 'A', '\u00008', '\u0000', '\u00ff', ' 0', '\u00018', '\u00078', '\u000f', 'A1', 'it\'s', 'a\\',
  {}, { a: 1 }, NaN,
];

function fieldsOf(expression: string): string[] {
  const found = new Set<string>();
  for (const m of expression.matchAll(/\{([^}]+)\}/g)) found.add(m[1].trim());
  return [...found];
}

/** Every combination for one or two fields, a deterministic spread for more. */
function datasetsFor(fields: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{}];
  const n = VALUES.length;
  if (fields.length === 1) {
    for (const v of VALUES) out.push({ [fields[0]]: v });
  } else if (fields.length === 2) {
    for (const v of VALUES) for (const w of VALUES) out.push({ [fields[0]]: v, [fields[1]]: w });
  } else if (fields.length > 2) {
    for (let i = 0; i < n * 4; i++) {
      const d: Record<string, unknown> = {};
      fields.forEach((f, j) => { d[f] = VALUES[(i * (j + 1) + j * 7) % n]; });
      out.push(d);
    }
  }
  return out;
}

describe('evaluateExpression: differential against the implementation it replaced', () => {
  for (const expression of EXPRESSIONS) {
    it(`matches the old evaluator: ${JSON.stringify(expression)}`, () => {
      const mismatches: string[] = [];
      for (const data of datasetsFor(fieldsOf(expression))) {
        const expected = legacyEvaluateExpression(expression, data);
        const actual = evaluateExpression(expression, data);
        if (actual !== expected) {
          mismatches.push(`${JSON.stringify(data)} -> expected ${expected}, got ${actual}`);
          if (mismatches.length >= 5) break;
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('matches for null, undefined and primitive data', () => {
    for (const expression of EXPRESSIONS) {
      for (const data of [null, undefined, 0, '', false, {}, []]) {
        expect(evaluateExpression(expression, data), `${expression} on ${JSON.stringify(data)}`)
          .toBe(legacyEvaluateExpression(expression, data));
      }
    }
  });
});

describe('evaluateExpression: pinned semantics (independent of the oracle)', () => {
  it('treats empty and non-string expressions', () => {
    expect(evaluateExpression('', {})).toBe(true);
    expect(evaluateExpression(null as any, {})).toBe(true);
    expect(evaluateExpression(5 as any, {})).toBe(false);
    expect(evaluateExpression({} as any, {})).toBe(false);
  });

  it('uses LOOSE equality for = and ==', () => {
    expect(evaluateExpression('{a} = 5', { a: '5' })).toBe(true);
    expect(evaluateExpression('{a} == 5', { a: '5' })).toBe(true);
    expect(evaluateExpression('{a} == false', { a: '' })).toBe(true);
    expect(evaluateExpression('{a} == false', { a: 0 })).toBe(true);
    expect(evaluateExpression('{a} == null', {})).toBe(true);
    expect(evaluateExpression('{a} != 5', { a: '5' })).toBe(false);
  });

  it('keeps === and !== strict', () => {
    expect(evaluateExpression('{a} === 5', { a: '5' })).toBe(false);
    expect(evaluateExpression('{a} !== 5', { a: '5' })).toBe(true);
  });

  it('anyof uses strict membership, allof and contains accept strings and arrays', () => {
    expect(evaluateExpression("{a} anyof ['1']", { a: 1 })).toBe(false);
    expect(evaluateExpression("{a} anyof ['1']", { a: '1' })).toBe(true);
    expect(evaluateExpression("{a} allof ['a', 'b']", { a: ['b', 'a', 'c'] })).toBe(true);
    expect(evaluateExpression("{a} allof ['a', 'z']", { a: ['a'] })).toBe(false);
    expect(evaluateExpression("{a} contains 'bc'", { a: 'abcd' })).toBe(true);
    expect(evaluateExpression("{a} contains 'bc'", { a: ['abcd'] })).toBe(false);
    expect(evaluateExpression("{a} notcontains 'bc'", {})).toBe(true);
  });

  it('a throwing operand makes the whole expression false, but short-circuit skips it', () => {
    expect(evaluateExpression("{n} contains 'x'", { n: 5 })).toBe(false);
    expect(evaluateExpression("{n} notcontains 'x'", { n: 5 })).toBe(false);
    expect(evaluateExpression("{ok} == 1 || {n} contains 'x'", { ok: 1, n: 5 })).toBe(true);
    expect(evaluateExpression("{ok} == 2 && {n} contains 'x'", { ok: 1, n: 5 })).toBe(false);
  });

  it('follows JavaScript precedence', () => {
    expect(evaluateExpression('{a} == 1 || {b} == 1 && {c} == 1', { a: 1 })).toBe(true);
    expect(evaluateExpression('({a} == 1 || {b} == 1) && {c} == 1', { a: 1 })).toBe(false);
    expect(evaluateExpression('{a} + 1 * 2 == 5', { a: 3 })).toBe(true);
    expect(evaluateExpression('!{a} == 1', { a: 0 })).toBe(true);
    expect(evaluateExpression('-{a} < 0', { a: 3 })).toBe(true);
  });

  it('reads leading-zero integers as legacy octal, as sloppy JavaScript did', () => {
    expect(evaluateExpression('{a} == 010', { a: 8 })).toBe(true);
    expect(evaluateExpression('{a} == 08', { a: 8 })).toBe(true);
    expect(evaluateExpression('{a} == 01', { a: '01' })).toBe(true);
  });

  it('does not support the SurveyJS words the old evaluator never honoured', () => {
    expect(evaluateExpression('{a} notempty', { a: 'x' })).toBe(false);
    expect(evaluateExpression('{a} empty', {})).toBe(false);
    expect(evaluateExpression('{a} == 1 and {b} == 2', { a: 1, b: 2 })).toBe(false);
    expect(evaluateExpression('{a} == 1 or {b} == 2', { a: 1, b: 2 })).toBe(false);
    expect(evaluateExpression('{a} <> 2', { a: 1 })).toBe(false);
  });
});

describe('evaluateExpression: intentional differences from the old evaluator', () => {
  // The old code rewrote the whole string before parsing it, so text inside a
  // string literal was rewritten too. These all read the literal as written.
  it('does not rewrite `=` or `{..}` inside string literals', () => {
    expect(evaluateExpression("{a} = 'x=y'", { a: 'x=y' })).toBe(true);
    expect(legacyEvaluateExpression("{a} = 'x=y'", { a: 'x=y' })).toBe(false);
    expect(evaluateExpression("{a} == '{b}'", { a: '{b}', b: 1 })).toBe(true);
    expect(legacyEvaluateExpression("{a} == '{b}'", { a: '{b}', b: 1 })).toBe(false);
  });

  it('accepts {field} references inside anyof and allof arrays', () => {
    // The old `[^\]]+` pattern ended the array at the `]` of the rewritten reference.
    expect(evaluateExpression("{a} anyof ['x', {b}]", { a: 'y', b: 'y' })).toBe(true);
    expect(legacyEvaluateExpression("{a} anyof ['x', {b}]", { a: 'y', b: 'y' })).toBe(false);
    expect(evaluateExpression("{a} allof ['x', {b}]", { a: ['x', 'y'], b: 'y' })).toBe(true);
    expect(legacyEvaluateExpression("{a} allof ['x', {b}]", { a: ['x', 'y'], b: 'y' })).toBe(false);
  });

  it('accepts a `]` inside an array literal string', () => {
    expect(evaluateExpression("{a} anyof ['x]y']", { a: 'x]y' })).toBe(true);
    expect(legacyEvaluateExpression("{a} anyof ['x]y']", { a: 'x]y' })).toBe(false);
  });

  it('reads only own properties of the data object', () => {
    expect(evaluateExpression('{constructor} == null', {})).toBe(true);
    expect(evaluateExpression('{toString} == null', {})).toBe(true);
    expect(evaluateExpression('{__proto__} == null', {})).toBe(true);
    expect(evaluateExpression('{constructor} == 1', { constructor: 1 })).toBe(true);
  });

  it('no longer evaluates array holes, the comma operator or numeric separators', () => {
    const cases: [string, Record<string, unknown>][] = [
      ["{a} anyof [,'a']", { a: 'a' }],
      ['{a} == [1,,2]', { a: '1,,2' }],
      ['{a}, {b}', { a: 0, b: 1 }],
      ['{a} == 1_000', { a: 1000 }],
    ];
    for (const [expression, data] of cases) {
      expect(legacyEvaluateExpression(expression, data), expression).toBe(true);
      expect(evaluateExpression(expression, data), expression).toBe(false);
    }
  });

  it('rejects every JavaScript construct outside the documented grammar', () => {
    for (const expression of NO_LONGER_EVALUATED) {
      for (const data of [{}, { a: 1, b: 1 }, { a: 'x', b: ['x'] }, { a: 'a', b: 1 }, { a: 1000, b: 1 }, { a: [1, 2], b: 1 }]) {
        expect(evaluateExpression(expression, data), expression).toBe(false);
      }
    }
  });

  it('does not evaluate arbitrary JavaScript', () => {
    // Each of these was `true` or ran code under the old evaluator.
    expect(legacyEvaluateExpression('{a}.length > 0', { a: 'abc' })).toBe(true);
    expect(evaluateExpression('{a}.length > 0', { a: 'abc' })).toBe(false);
    expect(evaluateExpression("{a}.includes('x')", { a: 'x' })).toBe(false);
    expect(evaluateExpression('this.a == 1', { a: 1 })).toBe(false);
    expect(evaluateExpression('{a} ? 1 : 0', { a: 1 })).toBe(false);
    expect(evaluateExpression('typeof {a} == "string"', { a: 'x' })).toBe(false);
    expect(evaluateExpression('{a} ?? 1', {})).toBe(false);
    expect(evaluateExpression('{a} | 1', { a: 0 })).toBe(false);
    expect(evaluateExpression('{}', {})).toBe(false);
    expect(legacyEvaluateExpression('{}', {})).toBe(true); // an empty object literal
  });

  it('cannot run code or reach globals', () => {
    const g = globalThis as any;
    delete g.__evalProbe;
    expect(evaluateExpression('(() => { globalThis.__evalProbe = 1; return true })()', {})).toBe(false);
    expect(evaluateExpression('{a} == 1 || globalThis.__evalProbe = 1', { a: 0 })).toBe(false);
    expect(evaluateExpression("{a}.constructor.constructor('globalThis.__evalProbe = 1')()", { a: 'x' })).toBe(false);
    expect(evaluateExpression('{a} == 1; globalThis.__evalProbe = 1', { a: 1 })).toBe(false);
    expect(evaluateExpression('{a} == 1;', { a: 1 })).toBe(true); // a trailing semicolon stays harmless
    expect(evaluateExpression('process.exit(1)', {})).toBe(false);
    expect(g.__evalProbe).toBeUndefined();
  });

  it('does not throw on pathological input, however deep', () => {
    expect(evaluateExpression('('.repeat(50000) + '{a}' + ')'.repeat(50000), { a: 1 })).toBeTypeOf('boolean');
    expect(evaluateExpression('['.repeat(50000), {})).toBe(false);
    expect(evaluateExpression('!'.repeat(50000) + '{a}', { a: 1 })).toBeTypeOf('boolean');
    expect(evaluateExpression('{a} == 1 && '.repeat(5000) + '{a} == 1', { a: 1 })).toBe(true);
  });
});

describe('evaluateExpression: no dynamic code evaluation in the module source', () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

  for (const file of ['./utils.ts', './expression.ts']) {
    it(`${file} never calls eval or the Function constructor`, () => {
      const source = read(file);
      expect(source).not.toMatch(/\bnew\s+Function\b/);
      expect(source).not.toMatch(/\bFunction\s*\(/);
      expect(source).not.toMatch(/\beval\s*\(/);
      expect(source).not.toMatch(/\bsetTimeout\s*\(\s*['"`]/);
      expect(source).not.toMatch(/\bimport\s*\(/);
    });
  }

  it('no package source file, in any subfolder, uses dynamic code evaluation', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => !f.endsWith('.test.ts') && /\.(ts|js|mjs|cjs|json)$/.test(f));
    expect(files).toContain('utils.ts');
    expect(files.some((f) => f.includes('schema'))).toBe(true);
    const offenders = files.filter((f) =>
      /\bnew\s+Function\b|\bFunction\s*\(|\beval\s*\(/.test(readFileSync(dir + f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
