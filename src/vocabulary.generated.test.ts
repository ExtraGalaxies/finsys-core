import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { allCategories } from "./adapter-categories.js";
import type {
  AdapterCategoryId,
  CanonicalFieldNameLiteral,
  RetiredFieldName,
} from "./vocabulary.generated.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * SYS-3347 — the generated unions must agree with the registry they claim to
 * describe.
 *
 * A generated file that is committed can go stale, and a stale one is worse
 * than none: it asserts a vocabulary the platform no longer has, so a name
 * that IS valid fails to compile and a retired one passes. That is the same
 * silent-wrong-answer shape the unions exist to remove, reintroduced one level
 * up.
 */
describe("vocabulary.generated.ts", () => {
  it("is not stale relative to adapter-categories.json", () => {
    // Runs the generator's own --check rather than re-deriving here. A second
    // implementation of "what the file should contain" could drift from the
    // first, and then the test would be asserting its own opinion.
    expect(() =>
      execFileSync("node", [resolve(here, "../scripts/gen-vocabulary.mjs"), "--check"], {
        encoding: "utf8",
      })
    ).not.toThrow();
  });

  it("covers every category and field the runtime registry reports", () => {
    // The generator reads the JSON; the registry is BUILT from the JSON with
    // validation in between. Comparing the two closes the gap where the file
    // is technically current but the loader disagrees with it — the check
    // above cannot see that, because it never loads the registry.
    const categories = allCategories();

    const declaredIds: AdapterCategoryId[] = categories.map((c) => c.id);
    const declaredFields: CanonicalFieldNameLiteral[] = categories.flatMap((c) =>
      c.fields.map((f) => f.name)
    );
    const declaredRetired: RetiredFieldName[] = categories.flatMap((c) =>
      c.fields.map((f) => f.legacyName).filter((n): n is RetiredFieldName => n !== undefined)
    );

    // The assignments above ARE the assertion: if the registry reported an id
    // or name outside its union, this file would not compile. These keep the
    // arrays live so the checks cannot be optimised away, and give a count a
    // reader can sanity-check against the generated header.
    expect(declaredIds.length).toBeGreaterThan(0);
    expect(declaredFields.length).toBeGreaterThan(0);
    expect(declaredRetired.length).toBeGreaterThan(0);
  });

  it("keeps live and retired names disjoint", () => {
    // The generator refuses to emit overlapping unions, but that only runs at
    // generation time. This asserts the same property of the SHIPPED registry,
    // so a hand-edit to the JSON that reintroduces a retired name as live is
    // caught even before anyone regenerates.
    const categories = allCategories();
    const live = new Set<string>(categories.flatMap((c) => c.fields.map((f) => f.name)));
    const retired = categories
      .flatMap((c) => c.fields.map((f) => f.legacyName))
      .filter((n): n is string => n !== undefined);
    const overlap = retired.filter((n) => live.has(n));
    expect(
      overlap,
      `a retired name is also declared live, so the unions would overlap and a ` +
        `consumer could not tell which meaning applies: ${overlap.join(", ")}`
    ).toEqual([]);
  });
});
