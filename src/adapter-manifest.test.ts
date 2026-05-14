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

  it("rejects an unknown category", () => {
    const m = validDeclarative() as unknown as Record<string, unknown>;
    m.category = "fortune-teller";
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
});
