#!/usr/bin/env node
/**
 * SYS-3347 — generate the vocabulary literal unions from the registry.
 *
 *   node scripts/gen-vocabulary.mjs           # write src/vocabulary.generated.ts
 *   node scripts/gen-vocabulary.mjs --check   # exit 1 if that file is stale
 *
 * ── Why generated, and why COMMITTED ────────────────────────────────────────
 *
 * `adapter-categories.json` is authoritative; nothing here is authored by
 * hand. But the output is committed rather than built on the fly, because the
 * union DIFF is the review artifact. A PR that retires a field name should
 * show the name leaving `CanonicalFieldName` and arriving in
 * `RetiredFieldName`, in the diff, where a reviewer sees it — not as an
 * invisible consequence of a JSON edit discovered later by a consumer's
 * failing build.
 *
 * `--check` is what stops the committed copy drifting from the JSON. It runs
 * in the test suite, so a JSON edit without a regenerate fails here rather
 * than shipping a union that disagrees with the data it claims to describe.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, "../src/data/adapter-categories.json");
const OUT = resolve(here, "../src/vocabulary.generated.ts");

/** Sorted + deduped, so the output is a function of the data and not of key order. */
const uniqSorted = (xs) => [...new Set(xs)].sort();

function build() {
  const raw = JSON.parse(readFileSync(DATA, "utf8"));
  const categories = Array.isArray(raw) ? raw : raw.categories;

  const categoryIds = uniqSorted(categories.map((c) => c.id));
  const canonical = uniqSorted(categories.flatMap((c) => c.fields.map((f) => f.name)));
  const retired = uniqSorted(
    categories.flatMap((c) => c.fields.map((f) => f.legacyName).filter(Boolean))
  );

  // A name cannot be both live and retired — core's own registry loader
  // already refuses that, but the unions would silently overlap rather than
  // error, so it is asserted here too. Two spellings of one guarantee is
  // cheaper than one guarantee nobody can see.
  const overlap = canonical.filter((n) => retired.includes(n));
  if (overlap.length > 0) {
    throw new Error(
      `a name is declared both live and retired, so the unions would overlap: ${overlap.join(", ")}`
    );
  }

  const union = (names) =>
    names.length === 0 ? "never" : names.map((n) => `\n  | ${JSON.stringify(n)}`).join("");

  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Regenerate with \`npm run gen:vocabulary\`; \`npm run gen:vocabulary -- --check\`
 * fails if this file has drifted from src/data/adapter-categories.json, and
 * runs in the test suite.
 *
 * Source of truth is the JSON. This exists so that a name the platform has
 * retired is a COMPILE error at every consumer rather than a permissive
 * runtime miss — the registry's own lookups fail open by design, which is
 * exactly why a rename previously had to be found by hand.
 *
 * ${categoryIds.length} categories · ${canonical.length} canonical fields · ${retired.length} retired names
 */

/** Every category id the registry declares. */
export type AdapterCategoryId =${union(categoryIds)};

/** Every canonical field name any category declares. */
export type CanonicalFieldNameLiteral =${union(canonical)};

/**
 * Every retired name that still resolves through the compatibility layer.
 *
 * Typing a parameter \`CanonicalFieldNameLiteral | RetiredFieldName\` accepts
 * both spellings while making a name that is NEITHER a compile error, rather
 * than a runtime null nobody checks.
 */
export type RetiredFieldName =${union(retired)};
`;
}

const generated = build();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`${OUT} is missing — run: npm run gen:vocabulary`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      `src/vocabulary.generated.ts is STALE relative to src/data/adapter-categories.json.\n` +
        `Run: npm run gen:vocabulary — and commit the result, so the union change is visible in the diff.`
    );
    process.exit(1);
  }
  console.log("vocabulary.generated.ts is up to date");
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${OUT}`);
}
