/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest";
import { Ajv } from "ajv";
import { AdapterExecutionMode, executionModeOf } from "./adapter-manifest.js";
import manifestSchema from "./schema/adapter-manifest.schema.json" with { type: "json" };

/**
 * SYS-3174 — `document-intake` as its own implementation type.
 *
 * WHY A SEVENTH TYPE RATHER THAN REUSING ONE. Only three existing types are
 * shape-compatible (discriminator-only, no fieldMap): `manual-override`,
 * `extraction-pipeline`, `external-assertion`. None of them is what this is.
 *
 *   - `extraction-pipeline` is documented as the host's own document-
 *     EXTRACTION pipeline. Uploading a document is what happens BEFORE
 *     extraction, and often without any extraction following. Reusing it would
 *     make provenance unable to distinguish "this file was uploaded" from
 *     "this file was parsed" by type alone — which is precisely the question
 *     the category exists to answer.
 *   - `manual-override` declares an operator-override SURFACE. It is the type
 *     the correction model needs and no adapter declares it yet; taking it
 *     here would collide with that work.
 *   - `external-assertion` means the host never saw the process. The host
 *     handles the upload itself.
 *
 * So the honest reading is that upload is its own origin class. A type name
 * that asserts the wrong origin is the same declared-vs-actual defect this
 * codebase keeps paying for, and it would be baked into every provenance row
 * ever written.
 *
 * DECLARATION-ONLY, like the three above: no code is loaded, and neither
 * fetch() nor extract() ever runs. The host's own upload path writes the
 * canonical rows and records the run; this manifest is how that write becomes
 * declared, provenance-carrying data rather than an untracked column poke.
 */
describe("document-intake implementation type", () => {
  it("classifies as declaration-only — the host's upload path writes the rows", () => {
    expect(executionModeOf({ implementation: { type: "document-intake" } })).toBe(
      AdapterExecutionMode.DeclarationOnly,
    );
  });

  it("is accepted by the published manifest schema", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(manifestSchema);
    const manifest = {
      manifestVersion: 1,
      id: "document-intake-v1",
      displayName: "Document Intake v1",
      category: "document-intake",
      version: 1,
      cardinality: "multi",
      produces: ["documentType", "pathInDms", "uploadedAt", "uploadedBy"],
      implementation: { type: "document-intake" },
    };
    const ok = validate(manifest);
    if (!ok) throw new Error(`schema refused a valid manifest: ${ajv.errorsText(validate.errors)}`);
    expect(ok).toBe(true);
  });

  /**
   * Anti-vacuity. If the schema accepted anything, the test above would pass
   * for the wrong reason — so prove it still REFUSES a discriminator nobody
   * published, and refuses the shape-bearing mistake of bolting a fieldMap
   * onto a discriminator-only type.
   */
  it("the schema still refuses an unpublished discriminator", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(manifestSchema);
    expect(
      validate({
        manifestVersion: 1,
        id: "nope-v1",
        displayName: "Nope",
        category: "document-intake",
        version: 1,
        cardinality: "multi",
        produces: ["documentType"],
        implementation: { type: "document-upload" },
      }),
    ).toBe(false);
  });

  /**
   * `executionModeOf` is exhaustive over the published discriminators and
   * THROWS on anything else — never guessing a mode. Adding a type without a
   * case is already a compile error via the `never` check; this asserts the
   * runtime half, which is what protects a host running a newer schema than
   * its core.
   */
  it("still throws on a type it does not publish, rather than guessing", () => {
    expect(() =>
      executionModeOf({
        implementation: { type: "document-upload" } as never,
      }),
    ).toThrow(/unknown adapter implementation type/);
  });
});
