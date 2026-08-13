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

import { describe, it, expect } from "vitest";
import { Ajv } from "ajv";
import schema from "./schema/adapter-manifest.schema.json" with { type: "json" };
import {
  AdapterExecutionMode,
  executionModeOf,
  type AdapterManifest,
} from "./adapter-manifest.js";
import { categoryFieldsOf } from "./adapter-categories.js";

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

/**
 * SYS-3043: compile-time exhaustiveness helper for the "maximal manifest"
 * anti-drift canaries below. Every key of T becomes required (`-?` strips
 * optionality) — assigning a canary fixture (typed narrowly via `satisfies
 * AdapterManifest`, which preserves the fixture's own literal key set
 * rather than widening to `AdapterManifest`) to this type fails to
 * compile if the fixture is missing ANY key AdapterManifest declares,
 * required or optional.
 *
 * This closes the canary's own drift risk: previously, a NEW optional
 * field added to AdapterManifest without also being added to a maximal
 * fixture left both canaries green — nothing forced the fixture to grow
 * with the type, so the "anti-drift" test could itself silently stop
 * covering the newest surface. Now the fixture and the type are
 * compile-time locked together: omit a key here and the build breaks
 * where the fixture is declared, not at some future host's registration
 * time.
 */
type AllKeysRequired<T> = { [K in keyof T]-?: T[K] };

/**
 * Build a minimal valid declarative manifest. Tests mutate copies for
 * negative cases.
 */
function validDeclarative(): AdapterManifest {
  return {
    manifestVersion: 1,
    id: "example-telco-v1",
    displayName: "Example Telco Adapter v1",
    category: "telco-carrier",
    version: 1,
    cardinality: "single",
    produces: ["onTimePaymentRatio24m", "tenureMonths"],
    implementation: {
      type: "declarative",
      fieldMap: [
        {
          source: "$.bill.payment_24m_pct",
          canonical: "onTimePaymentRatio24m",
          transform: "pct_to_ratio01",
        },
        {
          source: "$.account.tenure_months",
          canonical: "tenureMonths",
        },
      ],
    },
  };
}

/**
 * Build a minimal valid TypeScript manifest.
 */
function validTypescript(): AdapterManifest {
  return {
    manifestVersion: 1,
    id: "example-payments-v1",
    displayName: "Example Payments Adapter v1",
    category: "payment-network",
    version: 1,
    cardinality: "single",
    produces: ["monthlyVolume3m"],
    implementation: {
      type: "typescript",
      entryPoint: "extract.ts",
    },
  };
}

describe("Adapter manifest JSON-schema validation", () => {
  it("accepts a valid declarative manifest", () => {
    expect(validate(validDeclarative())).toBe(true);
  });

  it("accepts a valid TypeScript manifest", () => {
    expect(validate(validTypescript())).toBe(true);
  });

  it("rejects manifestVersion other than 1", () => {
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.manifestVersion = 2;
    expect(validate(m)).toBe(false);
  });

  it("rejects an id that doesn't end with -v<n>", () => {
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.id = "example-telco";
    expect(validate(m)).toBe(false);
  });

  it("accepts any non-empty category string — membership is a runtime check (SYS-2500), not the schema's job", () => {
    // Pre-SYS-2500 the schema pinned `category` to an enum. It now
    // validates STRUCTURE only; whether the category actually exists is
    // enforced against the registry via assertAdapterCategory() at
    // registration time (see adapter-categories.test.ts). This keeps
    // "add a category = data-file edit, no schema change" honest.
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.category = "fortune-teller";
    expect(validate(m)).toBe(true);
  });

  it("rejects an empty category string", () => {
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.category = "";
    expect(validate(m)).toBe(false);
  });

  it("rejects an empty produces list", () => {
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.produces = [];
    expect(validate(m)).toBe(false);
  });

  it("rejects a fieldMap source that isn't a JSONPath ($-rooted)", () => {
    const m = validDeclarative();
    if (m.implementation.type === "declarative") {
      const bad = {
        ...m,
        implementation: {
          ...m.implementation,
          fieldMap: [{ source: "bill.payment", canonical: "onTimePaymentRatio24m" }],
        },
      };
      expect(validate(bad)).toBe(false);
    }
  });

  it("rejects an unknown transform value", () => {
    const m = validDeclarative();
    if (m.implementation.type === "declarative") {
      const bad = {
        ...m,
        implementation: {
          ...m.implementation,
          fieldMap: [
            {
              source: "$.x",
              canonical: "tenureMonths",
              transform: "rot13",
            },
          ],
        },
      };
      expect(validate(bad)).toBe(false);
    }
  });

  it("rejects an absolute entryPoint path on TS adapter", () => {
    const m = validTypescript();
    if (m.implementation.type === "typescript") {
      const bad = {
        ...m,
        implementation: { ...m.implementation, entryPoint: "/etc/passwd.ts" },
      };
      expect(validate(bad)).toBe(false);
    }
  });

  it("rejects entryPoint with .. path segments (traversal)", () => {
    const m = validTypescript();
    if (m.implementation.type === "typescript") {
      const cases = [
        "../etc/passwd.js",
        "../../something.ts",
        "subdir/../../escape.js",
        "foo/../../bar.mjs",
        "..",
        "..foo.js", // ok — `..foo` is a normal segment; this MUST pass
      ];
      const expectValid = (ep: string) => ep === "..foo.js";
      for (const ep of cases) {
        const candidate = {
          ...m,
          implementation: { ...m.implementation, entryPoint: ep },
        };
        const got = validate(candidate);
        expect(got, `entryPoint=${JSON.stringify(ep)}`).toBe(expectValid(ep));
      }
    }
  });

  it("rejects unknown top-level properties", () => {
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.unexpectedField = "boom";
    expect(validate(m)).toBe(false);
  });

  // SYS-2460 — fetch contract additions to the manifest schema.
  it("accepts a manifest with partner-specific requiredIdentityFields", () => {
    const m = {
      ...validTypescript(),
      requiredIdentityFields: ["msisdn", "accountRef"],
    };
    expect(validate(m)).toBe(true);
  });

  it("accepts an adapter with no requiredIdentityFields (omitted)", () => {
    // Manifests that don't declare fetch() omit the field entirely;
    // the host treats fetch() as absent and passes empty raw to extract.
    const m = validTypescript();
    expect(validate(m)).toBe(true);
  });

  it("accepts an empty requiredIdentityFields array", () => {
    const m = { ...validTypescript(), requiredIdentityFields: [] };
    expect(validate(m)).toBe(true);
  });

  it("rejects requiredIdentityFields containing an empty string", () => {
    const m = { ...validTypescript(), requiredIdentityFields: [""] };
    expect(validate(m)).toBe(false);
  });

  it("rejects requiredIdentityFields with duplicate entries", () => {
    const m = {
      ...validTypescript(),
      requiredIdentityFields: ["msisdn", "msisdn"],
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects requiredIdentityFields with non-string entries", () => {
    const m = {
      ...validTypescript(),
      requiredIdentityFields: ["msisdn", 42 as unknown as string],
    };
    expect(validate(m)).toBe(false);
  });

  // The next three tests cover constraints added in the second pass on
  // the SYS-2460 schema after the frontier code review flagged the
  // core-field + length-bound gaps.
  it("rejects requiredIdentityFields naming a core field ('ic')", () => {
    // 'ic' can legitimately be empty for non-MY scope per ApplicantIdentity's
    // doc contract. If a partner declared it required the host would
    // skip every applicant — silent footgun. Schema rejects upfront.
    const m = { ...validTypescript(), requiredIdentityFields: ["ic"] };
    expect(validate(m)).toBe(false);
  });

  it("rejects requiredIdentityFields naming any of the three core fields", () => {
    for (const core of ["ihsId", "ic", "fullName"]) {
      const m = { ...validTypescript(), requiredIdentityFields: [core, "msisdn"] };
      expect(validate(m)).toBe(false);
    }
  });

  it("rejects requiredIdentityFields with an item longer than 100 chars", () => {
    const m = {
      ...validTypescript(),
      requiredIdentityFields: ["x".repeat(101)],
    };
    expect(validate(m)).toBe(false);
  });
});

/**
 * SYS-2501 — the two data-only implementation flavours. Both are
 * manifest-shape-only: no code is loaded; the discriminator tells the
 * host which of its own surfaces (form submission handler / operator
 * override endpoints) acts as the runtime.
 */
describe("SYS-2501: form-intake + manual-override implementation types", () => {
  function validFormIntake(): AdapterManifest {
    return {
      manifestVersion: 1,
      id: "sme-loan-form-intake-v1",
      displayName: "SME Loan Form Intake v1",
      category: "form-intake-sme",
      version: 1,
      cardinality: "single",
      produces: ["monthlyIncome", "employerName"],
      implementation: {
        type: "form-intake",
        fieldMap: [
          { formFieldId: "monthly_income", canonical: "monthlyIncome" },
          { formFieldId: "employer_name", canonical: "employerName" },
        ],
      },
    };
  }

  function validManualOverride(): AdapterManifest {
    return {
      manifestVersion: 1,
      id: "operator-override-bank-v1",
      displayName: "Operator Override — Bank Statement v1",
      category: "bank-statement",
      version: 1,
      cardinality: "single",
      produces: ["closingBalance"],
      implementation: { type: "manual-override" },
    };
  }

  it("accepts a valid form-intake manifest", () => {
    expect(validate(validFormIntake())).toBe(true);
  });

  it("accepts a valid manual-override manifest", () => {
    expect(validate(validManualOverride())).toBe(true);
  });

  it("rejects a form-intake manifest with an empty fieldMap", () => {
    const m = { ...validFormIntake(), implementation: { type: "form-intake", fieldMap: [] } };
    expect(validate(m)).toBe(false);
  });

  it("rejects a form-intake fieldMap entry missing formFieldId", () => {
    const m = {
      ...validFormIntake(),
      implementation: {
        type: "form-intake",
        fieldMap: [{ canonical: "monthlyIncome" }],
      },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects a form-intake fieldMap entry with a declarative-style transform (no transform slot)", () => {
    const m = {
      ...validFormIntake(),
      implementation: {
        type: "form-intake",
        fieldMap: [
          { formFieldId: "monthly_income", canonical: "monthlyIncome", transform: "to_integer" },
        ],
      },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects a manual-override implementation carrying any extra property", () => {
    // `produces` IS the override surface — a second list could only
    // duplicate or contradict it, so the shape forbids one existing.
    const m = {
      ...validManualOverride(),
      implementation: { type: "manual-override", overridableFields: ["closingBalance"] },
    };
    expect(validate(m)).toBe(false);
  });

  it("existing declarative + typescript manifests are unaffected", () => {
    expect(validate(validDeclarative())).toBe(true);
    expect(validate(validTypescript())).toBe(true);
  });
});

/**
 * SYS-2998 — extraction-pipeline implementation type. Declaration-only:
 * the host application's own document-extraction pipeline IS the
 * implementation, so like manual-override the shape is empty beyond the
 * discriminator.
 */
describe("SYS-2998: extraction-pipeline implementation type", () => {
  function validExtractionPipeline(): AdapterManifest {
    return {
      manifestVersion: 1,
      id: "finxtract-bank-statement-v1",
      displayName: "FinXtract Bank Statement v1",
      category: "bank-statement",
      version: 1,
      produces: ["bankName", "bankBalance", "totalCredits", "totalDebits"],
      cardinality: "multi",
      implementation: { type: "extraction-pipeline" },
    };
  }

  it("accepts a valid extraction-pipeline manifest", () => {
    expect(validate(validExtractionPipeline())).toBe(true);
  });

  it("accepts extraction-pipeline with fieldAuthorizations (the SYS-2503 gating plane)", () => {
    const m = {
      ...validExtractionPipeline(),
      fieldAuthorizations: { bankBalance: { lenderRoles: ["Lender Agent"] } },
    };
    expect(validate(m)).toBe(true);
  });

  it("rejects an extraction-pipeline implementation carrying any extra property", () => {
    // The pipeline's produced fields are declared by `produces` — the
    // implementation block carries no configuration by design.
    const m = {
      ...validExtractionPipeline(),
      implementation: { type: "extraction-pipeline", entryPoint: "./extract.js" },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects an extraction-pipeline manifest with a declarative fieldMap", () => {
    const m = {
      ...validExtractionPipeline(),
      implementation: {
        type: "extraction-pipeline",
        fieldMap: [{ source: "$.a", canonical: "bankBalance" }],
      },
    };
    expect(validate(m)).toBe(false);
  });
});

/**
 * SYS-3036 — `external-assertion` implementation type. Declaration-only,
 * same empty-beyond-the-discriminator shape as `manual-override` and
 * `extraction-pipeline`: no code, no fetch(), no extract(). Ownership of
 * this discriminator moved here from a host-local schema patch — these
 * tests lock the shape so any host can delete its own copy and validate
 * against this schema unmodified, with zero behavior change.
 */
describe("SYS-3036: external-assertion implementation type", () => {
  function validExternalAssertion(): AdapterManifest {
    return {
      manifestVersion: 1,
      id: "example-telco-assertion-v1",
      displayName: "Example Telco External-Assertion Adapter v1",
      category: "telco-carrier",
      version: 1,
      cardinality: "single",
      produces: ["onTimePaymentRatio24m"],
      implementation: { type: "external-assertion" },
    };
  }

  it("accepts a valid external-assertion manifest", () => {
    expect(validate(validExternalAssertion())).toBe(true);
  });

  it("rejects an external-assertion implementation carrying any extra property", () => {
    // No config slot by design — the discriminator alone carries the
    // meaning, same posture as manual-override/extraction-pipeline.
    const m = {
      ...validExternalAssertion(),
      implementation: { type: "external-assertion", pushEndpoint: "https://example.test" },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects an external-assertion manifest carrying a typescript entryPoint (the contradiction ajv must refuse)", () => {
    const m = {
      ...validExternalAssertion(),
      implementation: { type: "external-assertion", entryPoint: "extract.ts" },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects an external-assertion manifest carrying a declarative fieldMap", () => {
    const m = {
      ...validExternalAssertion(),
      implementation: {
        type: "external-assertion",
        fieldMap: [{ source: "$.a", canonical: "onTimePaymentRatio24m" }],
      },
    };
    expect(validate(m)).toBe(false);
  });

  it("accepts external-assertion with fieldAuthorizations (the SYS-2503 gating plane still applies)", () => {
    const m = {
      ...validExternalAssertion(),
      fieldAuthorizations: { onTimePaymentRatio24m: { lenderRoles: ["Lender Agent"] } },
    };
    expect(validate(m)).toBe(true);
  });

  it("existing declarative + typescript + extraction-pipeline manifests are unaffected", () => {
    expect(validate(validDeclarative())).toBe(true);
    expect(validate(validTypescript())).toBe(true);
  });

  it("a maximal manifest carrying EVERY optional AdapterManifest surface validates with external-assertion (the anti-drift canary, external-assertion flavor)", () => {
    // Same fixture shape as the typescript-flavored canary below, but
    // exercising the external-assertion branch specifically — the axis
    // this ticket adds. Keeping both green is what proves a future host
    // can delete its local schema patch with zero behavior change.
    const maximal = {
      manifestVersion: 1,
      id: "example-maximal-assertion-v1",
      displayName: "Example Maximal External-Assertion Adapter v1",
      category: "telco-carrier",
      version: 2,
      produces: ["paymentReliabilityTier", "tenureMonths"],
      cardinality: "multi",
      singletonFields: ["paymentReliabilityTier"],
      requiredIdentityFields: ["phoneNumber"],
      fieldAuthorizations: {
        paymentReliabilityTier: { lenderRoles: ["LENDER_AGENT"] },
      },
      periods: [{ name: "Snapshot month", description: "Monthly refresh window." }],
      enumValues: { paymentReliabilityTier: ["1", "2", "3", "4"] },
      notes: "Exists to keep the schema and the type in lockstep.",
      implementation: { type: "external-assertion" },
    } satisfies AdapterManifest;
    // SYS-3043: same compile-time closure as the typescript-flavor canary
    // above — see AllKeysRequired's doc comment.
    const _antiDriftStructuralCheck: AllKeysRequired<AdapterManifest> = maximal;
    const ok = validate(maximal);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("external-assertion is a compile-time-legal AdapterManifest implementation (type-level lockstep)", () => {
    const manifest: AdapterManifest = validExternalAssertion();
    expect(manifest.implementation.type).toBe("external-assertion");
  });
});

/**
 * SYS-3036 — `AdapterExecutionMode` + `executionModeOf()`. Published so
 * every host classifies `implementation.type` identically instead of
 * re-deriving its own switch (which is exactly how the host-local
 * `external-assertion` extension diverged from core in the first place).
 */
describe("SYS-3036: executionModeOf classification", () => {
  it("classifies declarative and typescript as Runnable", () => {
    expect(executionModeOf({ implementation: { type: "declarative", fieldMap: [] } })).toBe(
      AdapterExecutionMode.Runnable,
    );
    expect(
      executionModeOf({ implementation: { type: "typescript", entryPoint: "extract.ts" } }),
    ).toBe(AdapterExecutionMode.Runnable);
  });

  it("classifies form-intake, manual-override, and extraction-pipeline as DeclarationOnly", () => {
    expect(executionModeOf({ implementation: { type: "form-intake", fieldMap: [] } })).toBe(
      AdapterExecutionMode.DeclarationOnly,
    );
    expect(executionModeOf({ implementation: { type: "manual-override" } })).toBe(
      AdapterExecutionMode.DeclarationOnly,
    );
    expect(executionModeOf({ implementation: { type: "extraction-pipeline" } })).toBe(
      AdapterExecutionMode.DeclarationOnly,
    );
  });

  it("classifies external-assertion as ExternallyAsserted", () => {
    expect(executionModeOf({ implementation: { type: "external-assertion" } })).toBe(
      AdapterExecutionMode.ExternallyAsserted,
    );
  });

  it("throws loudly on an unrecognized implementation type rather than guessing a mode", () => {
    const bogus = { implementation: { type: "quantum-flux" } } as unknown as Pick<
      AdapterManifest,
      "implementation"
    >;
    expect(() => executionModeOf(bogus)).toThrow(/unknown adapter implementation type/);
  });

  it("pins the enum's literal string values — these are the wire contract, not just symbols", () => {
    // executionModeOf's callers (host logs, list()-style diagnostics)
    // serialize this value. Comparing against AdapterExecutionMode.X
    // elsewhere in this file only proves internal self-consistency; an
    // edit to the enum's RHS would stay green there while silently
    // changing what ships on the wire. Pin the literals directly.
    expect(AdapterExecutionMode.Runnable).toBe("runnable");
    expect(AdapterExecutionMode.DeclarationOnly).toBe("declaration-only");
    expect(AdapterExecutionMode.ExternallyAsserted).toBe("externally-asserted");
  });
});

/**
 * SYS-2502 — explicit cardinality + per-applicant singleton fields.
 * Both OPTIONAL: absence must keep every pre-existing manifest valid
 * (backward compat is the ticket's stated done-condition).
 */
describe("SYS-2502: cardinality + singletonFields", () => {
  it("accepts cardinality 'single' and 'multi'", () => {
    for (const cardinality of ["single", "multi"] as const) {
      const m = { ...validTypescript(), cardinality };
      expect(validate(m)).toBe(true);
    }
  });

  it("rejects any other cardinality value", () => {
    const m = { ...validTypescript(), cardinality: "unbounded" };
    expect(validate(m)).toBe(false);
  });

  it("SYS-3171: a manifest with NO cardinality is now REJECTED", () => {
    // Was valid until 5.0.0, with the host inferring from the instanceKey
    // convention ("" -> single, non-empty -> multi). Inference is exactly
    // the problem: it cannot tell a declared-single adapter emitting a
    // multi-keyed instance from a legitimately multi one, so the host stored
    // the mismatch silently instead of rejecting it. Declaring it is what
    // makes rejection possible at persistence time.
    const m = { ...validTypescript() } as Record<string, unknown>;
    delete m.cardinality;
    expect(validate(m)).toBe(false);
  });

  it("accepts singletonFields on a multi-cardinality manifest", () => {
    const m = {
      ...validTypescript(),
      cardinality: "multi",
      singletonFields: ["monthlyVolume3m"],
    };
    expect(validate(m)).toBe(true);
  });

  it("rejects a singletonFields entry that is an empty string", () => {
    const m = { ...validTypescript(), singletonFields: [""] };
    expect(validate(m)).toBe(false);
  });

  it("rejects duplicate singletonFields entries", () => {
    const m = { ...validTypescript(), singletonFields: ["a", "a"] };
    expect(validate(m)).toBe(false);
  });
});

/**
 * SYS-2503 — declarative per-field authorization gating. The schema
 * validates SHAPE; the "keys ⊆ produces" rule and the actual read-time
 * enforcement are host-side (finsys-api), mirroring how produces ⊆
 * category-fields is handled.
 */
describe("SYS-2503: fieldAuthorizations", () => {
  it("accepts gating by lenderRoles only", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        monthlyVolume3m: { lenderRoles: ["LENDER_AGENT"] },
      },
    };
    expect(validate(m)).toBe(true);
  });

  it("accepts gating by programIds only", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        monthlyVolume3m: { programIds: ["prog-sme-1"] },
      },
    };
    expect(validate(m)).toBe(true);
  });

  it("accepts gating by both dimensions on one field", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        monthlyVolume3m: {
          lenderRoles: ["LENDER_AGENT", "LENDER_ADMIN"],
          programIds: ["prog-sme-1"],
        },
      },
    };
    expect(validate(m)).toBe(true);
  });

  it("a manifest with NO fieldAuthorizations stays valid (gating is opt-in — backward compat)", () => {
    const m = validTypescript();
    expect("fieldAuthorizations" in m).toBe(false);
    expect(validate(m)).toBe(true);
  });

  it("rejects an empty fieldAuthorizations object", () => {
    const m = { ...validTypescript(), fieldAuthorizations: {} };
    expect(validate(m)).toBe(false);
  });

  it("rejects an entry declaring NO dimension (would be a no-op gate)", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: { monthlyVolume3m: {} },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects an empty dimension list (deny-all is expressed by not producing the field)", () => {
    for (const entry of [{ lenderRoles: [] }, { programIds: [] }]) {
      const m = {
        ...validTypescript(),
        fieldAuthorizations: { monthlyVolume3m: entry },
      };
      expect(validate(m)).toBe(false);
    }
  });

  it("rejects an unknown dimension key on an entry", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        monthlyVolume3m: { lenderIds: ["456"] },
      },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects empty-string values inside a dimension list", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: { monthlyVolume3m: { lenderRoles: [""] } },
    };
    expect(validate(m)).toBe(false);
  });
});

/**
 * SYS-3002 — period declarations on the manifest. The array order IS
 * the contract: element 1 (index 0) is period1 — numbering is 1-BASED,
 * there is no period0. Absence means the single-period convention, so
 * every pre-existing manifest stays valid.
 */
describe("SYS-3002: periods declaration", () => {
  /**
   * The motivating consumer, financial-statement-shaped: one document
   * carries period1 (its current fiscal year, the FIRST declared
   * entry) plus period2 (its prior comparative year, the SECOND).
   */
  function validWithTwoPeriods(): AdapterManifest {
    return {
      manifestVersion: 1,
      id: "finxtract-financial-statement-v1",
      displayName: "FinXtract Financial Statement v1",
      category: "financial-statement",
      version: 1,
      produces: ["revenue", "netProfit"],
      cardinality: "multi",
      implementation: { type: "extraction-pipeline" },
      periods: [
        {
          name: "Current fiscal year",
          description: "The statement's own reporting year.",
        },
        {
          name: "Prior comparative year",
          description: "The prior-year comparative column the statement restates.",
        },
      ],
    };
  }

  it("accepts a financial-statement-shaped manifest with 2 declared periods (period1 = first entry, 1-based)", () => {
    expect(validate(validWithTwoPeriods())).toBe(true);
  });

  it("accepts a single declared period", () => {
    const m = {
      ...validWithTwoPeriods(),
      periods: [{ name: "Current fiscal year" }],
    };
    expect(validate(m)).toBe(true);
  });

  it("accepts a period entry without a description (name alone suffices)", () => {
    const m = {
      ...validWithTwoPeriods(),
      periods: [{ name: "Current fiscal year" }, { name: "Prior comparative year" }],
    };
    expect(validate(m)).toBe(true);
  });

  it("a manifest with NO periods stays valid (single-period convention — backward compat)", () => {
    const m = validTypescript();
    expect("periods" in m).toBe(false);
    expect(validate(m)).toBe(true);
  });

  it("rejects an empty periods array (absence, not [], expresses the single-period convention)", () => {
    const m = { ...validWithTwoPeriods(), periods: [] };
    expect(validate(m)).toBe(false);
  });

  it("rejects a period entry without a name", () => {
    const m = {
      ...validWithTwoPeriods(),
      periods: [{ description: "nameless" }],
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects a period entry with an empty name", () => {
    const m = { ...validWithTwoPeriods(), periods: [{ name: "" }] };
    expect(validate(m)).toBe(false);
  });

  it("rejects a period entry carrying extra properties (no dates in the DECLARATION — dates are extraction-time metadata, never identity)", () => {
    const m = {
      ...validWithTwoPeriods(),
      periods: [{ name: "Current fiscal year", start: "2025-01-01" }],
    };
    expect(validate(m)).toBe(false);
  });

  it("periods may be declared on any implementation type (contract-level axis, not implementation-level)", () => {
    const m = {
      ...validTypescript(),
      periods: [{ name: "Current fiscal year" }, { name: "Prior comparative year" }],
    };
    expect(validate(m)).toBe(true);
  });
});

/**
 * SYS-3003 — the finxtract-financial-statement category is registered
 * now, so the "financial-statement-shaped" fixture above stops being
 * hypothetical: an extraction-pipeline manifest for the real category
 * must pass the schema AND stay inside the category's canonical
 * vocabulary.
 */
describe("SYS-3003: financial-statement manifest fixture against the real category", () => {
  function financialStatementManifest(): AdapterManifest {
    return {
      manifestVersion: 1,
      id: "finxtract-financial-statement-v1",
      displayName: "FinXtract Financial Statement v1",
      category: "financial-statement",
      version: 1,
      produces: [
        "companyName",
        "financialYearEnd",
        "revenue",
        "netProfit",
        "totalEquity",
        "totalAssets",
        "totalLiabilities",
      ],
      cardinality: "multi",
      implementation: { type: "extraction-pipeline" },
      periods: [{ name: "Current fiscal year" }, { name: "Prior comparative year" }],
    };
  }

  it("validates through the real Ajv path", () => {
    expect(validate(financialStatementManifest())).toBe(true);
  });

  it("its produces list is a subset of the category's canonical fields", () => {
    const canonical = new Set(categoryFieldsOf("financial-statement"));
    for (const f of financialStatementManifest().produces) {
      expect(canonical.has(f), `"${f}" is not a canonical field`).toBe(true);
    }
  });
});

// ── enumValues: vendor value sets for enum-kind fields ─────────────────

describe("enumValues declaration surface", () => {
  it("a manifest carries vendor-specific value sets for its enum-kind fields", () => {
    // The category says fieldX IS an enum; the manifest says which
    // labels THIS vendor emits. This test locks the type surface — the
    // semantic rules (keys ⊆ produces, enum-kind fields require an
    // entry, normalized unique labels) are host-validated at
    // registration, same as every other membership rule.
    const manifest: AdapterManifest = {
      manifestVersion: 1,
      id: "example-telco-tiers-v1",
      displayName: "Example Telco Tier Adapter v1",
      category: "telco-carrier",
      version: 1,
      cardinality: "single",
      produces: ["paymentReliabilityTier", "distressTier"],
      enumValues: {
        paymentReliabilityTier: ["excellent", "good", "fair", "poor"],
        distressTier: ["none", "moderate", "severe"],
      },
      implementation: {
        type: "typescript",
        entryPoint: "extract.ts",
      },
    };
    expect(manifest.enumValues?.paymentReliabilityTier).toHaveLength(4);
    expect(manifest.enumValues?.distressTier).toContain("severe");
  });

  it("enumValues is optional — adapters with no enum fields never declare it", () => {
    const manifest = validDeclarative();
    expect(manifest.enumValues).toBeUndefined();
  });
});

// ── enumValues: schema lockstep with the AdapterManifest type ──────────

describe("enumValues JSON-schema validation", () => {
  function tierManifest(enumValues: unknown): unknown {
    return {
      manifestVersion: 1,
      id: "example-telco-tiers-v1",
      displayName: "Example Telco Tier Adapter v1",
      category: "telco-carrier",
      version: 1,
      cardinality: "single",
      produces: ["paymentReliabilityTier"],
      enumValues,
      implementation: { type: "typescript", entryPoint: "extract.ts" },
    };
  }

  it("accepts a manifest declaring vendor value sets (the SYS-3016 type/schema lockstep)", () => {
    // This exact shape was TYPE-legal but SCHEMA-refused before the
    // lockstep fix — additionalProperties: false silently rejected every
    // enumValues manifest at host registration. Keep this green.
    const ok = validate(tierManifest({ paymentReliabilityTier: ["1", "2", "3", "4"] }));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects an empty value set", () => {
    expect(validate(tierManifest({ paymentReliabilityTier: [] }))).toBe(false);
  });

  it("rejects duplicate labels in a set", () => {
    expect(validate(tierManifest({ paymentReliabilityTier: ["1", "1"] }))).toBe(false);
  });

  it("rejects non-normalized labels (leading/trailing whitespace, empty)", () => {
    expect(validate(tierManifest({ paymentReliabilityTier: [" 1"] }))).toBe(false);
    expect(validate(tierManifest({ paymentReliabilityTier: ["1 "] }))).toBe(false);
    expect(validate(tierManifest({ paymentReliabilityTier: [""] }))).toBe(false);
  });

  it("rejects an all-whitespace label (SYS-3043: ^\\S(.*\\S)?$ fails on the very first character regardless of what follows)", () => {
    expect(validate(tierManifest({ paymentReliabilityTier: [" "] }))).toBe(false);
    expect(validate(tierManifest({ paymentReliabilityTier: ["   "] }))).toBe(false);
    expect(validate(tierManifest({ paymentReliabilityTier: ["\t"] }))).toBe(false);
  });

  it("accepts labels with interior spaces (normalization constrains only the edges)", () => {
    expect(validate(tierManifest({ handsetRiskTier: ["no arrears", "in arrears"] }))).toBe(
      true,
    );
  });

  it("SYS-3043: case-varying labels are NOT deduplicated — documents the current non-goal", () => {
    // `uniqueItems` is exact-string (ajv's default), so two labels that
    // differ only by case are legally "unique" per the schema, even
    // though they may be the same vendor label with an inconsistent
    // typo. This is deliberate (see the enumValues doc comment in
    // adapter-manifest.ts and this schema field's description): the
    // host never folds case or reconciles near-miss spelling — a
    // vendor's exact label IS its identity. This test exists so a
    // future change to `uniqueItems`/a case-folding step is a
    // conscious, visible decision (this test goes red) rather than a
    // silent behavior change.
    expect(validate(tierManifest({ paymentReliabilityTier: ["High", "high"] }))).toBe(true);
  });

  it("a maximal manifest carrying EVERY optional AdapterManifest surface validates — the anti-drift canary", () => {
    // If a field is added to the AdapterManifest TYPE without a schema
    // update, extending this fixture (which every type addition should)
    // turns the drift into a red test instead of a silent registration
    // refusal in every host.
    const maximal = {
      manifestVersion: 1,
      id: "example-maximal-v1",
      displayName: "Example Maximal Adapter v1",
      category: "telco-carrier",
      version: 2,
      produces: ["paymentReliabilityTier", "tenureMonths"],
      cardinality: "multi",
      singletonFields: ["paymentReliabilityTier"],
      requiredIdentityFields: ["phoneNumber"],
      fieldAuthorizations: {
        paymentReliabilityTier: { lenderRoles: ["LENDER_AGENT"] },
      },
      periods: [{ name: "Snapshot month", description: "Monthly refresh window." }],
      enumValues: { paymentReliabilityTier: ["1", "2", "3", "4"] },
      notes: "Exists to keep the schema and the type in lockstep.",
      implementation: { type: "typescript", entryPoint: "extract.ts" },
    } satisfies AdapterManifest;
    // SYS-3043: compile-time closure of the anti-drift canary itself — see
    // AllKeysRequired's doc comment. If AdapterManifest gains a new key
    // that this fixture doesn't populate, the line below fails to
    // compile.
    const _antiDriftStructuralCheck: AllKeysRequired<AdapterManifest> = maximal;
    const ok = validate(maximal);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});
