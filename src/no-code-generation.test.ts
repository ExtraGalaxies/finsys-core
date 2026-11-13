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

// Importing the built package, and calling the runtime exports a browser page
// uses, must not run `eval` or `new Function`. `--disallow-code-generation-
// from-strings` makes both throw, as a Content-Security-Policy without
// 'unsafe-eval' does. `validateFormConfig` is deliberately not called: it
// compiles a schema at runtime and does need code generation.
//
// This runs against the built `dist/`, so run `npm run build` first. CI builds
// before it tests; without a build this skips locally and fails under CI.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const probe = `${root}scripts/check-no-code-generation.mjs`;

describe('the built package under --disallow-code-generation-from-strings', () => {
  for (const entry of ['dist/index.js', 'dist/index.cjs']) {
    const built = existsSync(`${root}${entry}`);
    if (!built && process.env.CI) {
      it(`${entry} exists`, () => {
        throw new Error(`${entry} is missing: run \`npm run build\` before the tests`);
      });
      continue;
    }

    it.skipIf(!built)(`${entry} imports and runs without code generation`, () => {
      const run = spawnSync(
        process.execPath,
        ['--disallow-code-generation-from-strings', probe, `${root}${entry}`],
        { cwd: root, encoding: 'utf8' }
      );
      // The probe prints one `ok` or `FAIL` line per check; show them all.
      const report = `${run.stdout}${run.stderr}`.split('\n').filter((l) => /^(ok|FAIL)\s/.test(l)).join('\n');
      expect(report).toContain('ok   code generation is blocked');
      expect(report).not.toContain('FAIL');
      expect(run.status, report).toBe(0);
    });
  }
});
