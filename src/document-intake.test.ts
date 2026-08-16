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
import {
  categoryFieldsOf,
  categorySchemaOf,
  isAdapterCategory,
} from "./adapter-categories.js";
import { parseFileField } from "./ihs-processing.js";
import type { ParsedDocFile } from "./ihs-processing.js";

/**
 * SYS-3174 — the document-intake category, and the one field the file shape
 * was missing.
 *
 * WHY THIS EXISTS. Every extracted VALUE already carries provenance: which
 * adapter run produced it, when, from which document. A document POINTER
 * carries none — it is a bare string, or a JSON array of them, in a wide
 * column. This category is what gives a pointer the same standing, so that
 * "who uploaded this file, and when" is answerable from the canonical plane
 * rather than from nowhere.
 *
 * THE FIELD SET IS NOT A DESIGN DECISION TAKEN HERE. It was written down in
 * the harness before any of this was built, as the named contract this
 * release has to satisfy: documentType / pathInDms / uploadedAt / uploadedBy.
 * The assertion below is deliberately EXACT rather than a superset check —
 * a category that quietly grows a fifth field is a vocabulary change, and
 * vocabulary changes in this registry are the thing that has repeatedly cost
 * a major version. Adding one should have to come here and say so.
 *
 * WHAT THIS RELEASE DOES NOT DO. It ships no adapter, no manifest and no
 * storage path — those are the consuming side, and they cannot be written
 * until this vocabulary exists, because the category id is a closed generated
 * union and an unknown id is a compile error rather than a runtime miss.
 */
describe("document-intake category", () => {
  it("is a registered category", () => {
    expect(isAdapterCategory("document-intake")).toBe(true);
  });

  it("declares exactly the four fields the contract names", () => {
    expect([...categoryFieldsOf("document-intake")].sort()).toEqual([
      "documentType",
      "pathInDms",
      "uploadedAt",
      "uploadedBy",
    ]);
  });

  it("is canonical over its own table, in the IHS namespace", () => {
    expect(categorySchemaOf("document-intake").canonicalTable).toBe(
      "ihs_alt_data_document_intake",
    );
  });

  /**
   * All four resolve to SENSITIVE, because none of them declares otherwise.
   * Not an oversight — the conservative direction is the only safe one to
   * ship, since loosening a field later is additive while tightening one is a
   * behavior change for every consumer already reading it. If a caller turns
   * out to need `documentType` unredacted, that is a decision someone makes
   * with a reason, in a diff that says so.
   *
   * Asserted on the RESOLVED value rather than on the absence of a
   * declaration. The registry resolves `?? "sensitive"` at load, so a test
   * checking for `undefined` would be checking the raw JSON through a surface
   * that never returns it — green for the wrong reason, and blind to a future
   * field that declares "non-sensitive" outright.
   */
  it("resolves every field to sensitive — the protective default, none opted out", () => {
    const classes = categorySchemaOf("document-intake").fields.map(
      (f) => [f.name, f.confidentiality] as const,
    );
    expect(classes).toEqual([
      ["documentType", "sensitive"],
      ["pathInDms", "sensitive"],
      ["uploadedAt", "sensitive"],
      ["uploadedBy", "sensitive"],
    ]);
  });
});

/**
 * SYS-3174 — `uploadedBy` is the one genuine gap in the stored file shape.
 *
 * Everything else the category names already travels with each uploaded file
 * entry. `uploadedBy` does not: it appears nowhere in this package, and the
 * lender upload route writes it ad-hoc into ONE column's entries. Adding it
 * to the shared shape is what stops the next writer inventing a second
 * spelling of the same fact.
 *
 * These assert the PARSER preserves it, not merely that the type admits it.
 * A type-only change is invisible at runtime, and this shape is parsed out of
 * three different wire forms — so the round trip is the part that can break.
 */
describe("uploadedBy travels with a parsed file entry", () => {
  it("survives the already-parsed array form", () => {
    const entries = parseFileField([
      { path: "dms/a.pdf", fileName: "a.pdf", uploadedBy: "agent-7" },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.uploadedBy).toBe("agent-7");
  });

  it("survives the JSON-array-in-a-string form", () => {
    const entries = parseFileField(
      JSON.stringify([{ path: "dms/b.pdf", uploadedBy: "agent-9" }]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.uploadedBy).toBe("agent-9");
  });

  it("is absent, not empty, on an entry that never carried one", () => {
    const entries = parseFileField([{ path: "dms/c.pdf" }]);
    expect(entries[0]?.uploadedBy).toBeUndefined();
  });

  it("is exported, so a consumer can name the shape it already receives", () => {
    // Compile-level: the import above fails to build if the type is not
    // exported. This runtime assertion exists so the intent is greppable —
    // the whole point of the release is that finsys-api reuses this shape
    // rather than declaring a fourth private copy of it.
    const entry: ParsedDocFile = { path: "dms/d.pdf", uploadedBy: "agent-1" };
    expect(entry.uploadedBy).toBe("agent-1");
  });
});
