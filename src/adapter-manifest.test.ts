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
import type { AdapterManifest } from "./adapter-manifest.js";

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

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
    produces: ["telcoOnTimePaymentRatio24m", "telcoTenureMonths"],
    implementation: {
      type: "declarative",
      fieldMap: [
        {
          source: "$.bill.payment_24m_pct",
          canonical: "telcoOnTimePaymentRatio24m",
          transform: "pct_to_ratio01",
        },
        {
          source: "$.account.tenure_months",
          canonical: "telcoTenureMonths",
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
    produces: ["paymentsMonthlyVolumeMyrT3"],
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
          fieldMap: [{ source: "bill.payment", canonical: "telcoOnTimePaymentRatio24m" }],
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
              canonical: "telcoTenureMonths",
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
      produces: ["bankClosingBalanceMyr"],
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
      implementation: { type: "manual-override", overridableFields: ["bankClosingBalanceMyr"] },
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
      category: "finxtract-bank-statement",
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

  it("a manifest with NO cardinality stays valid (backward compat — host infers from the instanceKey convention)", () => {
    const m = validTypescript();
    expect("cardinality" in m).toBe(false);
    expect(validate(m)).toBe(true);
  });

  it("accepts singletonFields on a multi-cardinality manifest", () => {
    const m = {
      ...validTypescript(),
      cardinality: "multi",
      singletonFields: ["paymentsMonthlyVolumeMyrT3"],
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
        paymentsMonthlyVolumeMyrT3: { lenderRoles: ["LENDER_AGENT"] },
      },
    };
    expect(validate(m)).toBe(true);
  });

  it("accepts gating by programIds only", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        paymentsMonthlyVolumeMyrT3: { programIds: ["prog-sme-1"] },
      },
    };
    expect(validate(m)).toBe(true);
  });

  it("accepts gating by both dimensions on one field", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        paymentsMonthlyVolumeMyrT3: {
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
      fieldAuthorizations: { paymentsMonthlyVolumeMyrT3: {} },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects an empty dimension list (deny-all is expressed by not producing the field)", () => {
    for (const entry of [{ lenderRoles: [] }, { programIds: [] }]) {
      const m = {
        ...validTypescript(),
        fieldAuthorizations: { paymentsMonthlyVolumeMyrT3: entry },
      };
      expect(validate(m)).toBe(false);
    }
  });

  it("rejects an unknown dimension key on an entry", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: {
        paymentsMonthlyVolumeMyrT3: { lenderIds: ["456"] },
      },
    };
    expect(validate(m)).toBe(false);
  });

  it("rejects empty-string values inside a dimension list", () => {
    const m = {
      ...validTypescript(),
      fieldAuthorizations: { paymentsMonthlyVolumeMyrT3: { lenderRoles: [""] } },
    };
    expect(validate(m)).toBe(false);
  });
});
