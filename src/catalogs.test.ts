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
import { generateRHFSchema } from "./rhf-generator.js";
import {
  BASE_FIELD_SPECS,
  FIELD_TYPE_DEFINITIONS,
  DEFAULT_VALIDATOR_DEFINITIONS,
  getBaseFieldSpecs,
  getBaseCategories,
  getBaseFieldNames,
  getBaseFieldSpecMap,
} from "./catalogs.js";

describe("BASE_FIELD_SPECS", () => {
  it("has schemaVersion, categories, and fields", () => {
    expect(BASE_FIELD_SPECS.schemaVersion).toBeDefined();
    expect(Array.isArray(BASE_FIELD_SPECS.categories)).toBe(true);
    expect(Array.isArray(BASE_FIELD_SPECS.fields)).toBe(true);
    expect(BASE_FIELD_SPECS.categories.length).toBeGreaterThan(0);
    expect(BASE_FIELD_SPECS.fields.length).toBeGreaterThan(0);
  });
});

describe("FIELD_TYPE_DEFINITIONS", () => {
  it("has version, types, and input_types", () => {
    expect(FIELD_TYPE_DEFINITIONS.version).toBeDefined();
    expect(Array.isArray(FIELD_TYPE_DEFINITIONS.types)).toBe(true);
    expect(Array.isArray(FIELD_TYPE_DEFINITIONS.input_types)).toBe(true);
    expect(FIELD_TYPE_DEFINITIONS.types.length).toBeGreaterThan(0);
    expect(FIELD_TYPE_DEFINITIONS.input_types.length).toBeGreaterThan(0);
  });
});

describe("DEFAULT_VALIDATOR_DEFINITIONS", () => {
  it("has version and options", () => {
    expect(DEFAULT_VALIDATOR_DEFINITIONS.version).toBeDefined();
    expect(Array.isArray(DEFAULT_VALIDATOR_DEFINITIONS.options)).toBe(true);
    expect(DEFAULT_VALIDATOR_DEFINITIONS.options.length).toBeGreaterThan(0);
  });
});

describe("getBaseFieldSpecs", () => {
  it("returns field array", () => {
    const fields = getBaseFieldSpecs();
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields[0].name).toBeDefined();
    expect(fields[0].type).toBeDefined();
  });
});

describe("getBaseCategories", () => {
  it("returns category array", () => {
    const categories = getBaseCategories();
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);
    expect(categories[0].id).toBeDefined();
    expect(categories[0].name).toBeDefined();
  });
});

describe("getBaseFieldNames", () => {
  it("returns unique field names", () => {
    const names = getBaseFieldNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    // Should be unique
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("getBaseFieldSpecMap", () => {
  it("returns a Map keyed by field name", () => {
    const map = getBaseFieldSpecMap();
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBeGreaterThan(0);

    for (const [key, field] of map) {
      expect(field.name).toBe(key);
    }
  });

  it("returns the same cached instance on subsequent calls", () => {
    const map1 = getBaseFieldSpecMap();
    const map2 = getBaseFieldSpecMap();
    expect(map1).toBe(map2);
  });
});

describe("Base Specs Zod Validation", () => {
  it("all field definitions should be valid for RHF schema generation", () => {
    const fields = BASE_FIELD_SPECS.fields;
    const categories = BASE_FIELD_SPECS.categories;
    const failedFields: { name: string; error: string }[] = [];

    fields.forEach((field: any) => {
      try {
        const config = {
          schemaVersion: "v2.0.0",
          displayName: "Test",
          categories: categories,
          fields: {
            [field.name]: field,
          },
          pages: [
            {
              id: "test-page",
              fields: [field.name],
            },
          ],
        };

        const { zodSchema, defaultValues } = generateRHFSchema(config as any);
        const result = zodSchema.safeParse(defaultValues);

        if (!result.success) {
          const hasRequirementError = result.error.issues.some(
            (i: any) => i.message === "This field is required" || i.code === "too_small"
          );
          const isRequired = field.isRequired !== false && field.required !== false;

          if (!(isRequired && hasRequirementError && !field.defaultValue)) {
            failedFields.push({
              name: field.name,
              error: `Validation failed: ${JSON.stringify(result.error.issues)}`,
            });
          }
        }
      } catch (error: any) {
        failedFields.push({
          name: field.name,
          error: `Exception: ${error.message}`,
        });
      }
    });

    if (failedFields.length > 0) {
      const errorMsg = failedFields.map((f) => `[${f.name}]: ${f.error}`).join("\n");
      expect.unreachable(
        `Found ${failedFields.length} invalid field definitions:\n${errorMsg.substring(0, 2000)}`
      );
    }
  });
});

describe("Field Types Zod Validation", () => {
  it("all supported type combinations should be valid for RHF schema generation", () => {
    const types = FIELD_TYPE_DEFINITIONS.types;
    const inputTypes = FIELD_TYPE_DEFINITIONS.input_types;
    const failedCombinations: { type: string; inputType?: string; error: string }[] = [];

    for (const typeObj of types) {
      const baseType = typeObj.name;
      const targetInputTypes = baseType === "text" ? inputTypes : [{ name: undefined as any }];

      for (const inputTypeObj of targetInputTypes) {
        const inputType = inputTypeObj.name;

        try {
          const field: any = {
            name: "testField",
            displayName: "Test Field",
            category: "1",
            type: baseType,
          };
          if (inputType) field.inputType = inputType;

          const config = {
            schemaVersion: "v2.0.0",
            displayName: "Test",
            categories: [{ id: "1", name: "Test" }],
            fields: { [field.name]: field },
            pages: [{ id: "test-page", fields: [field.name] }],
          };

          const { zodSchema, defaultValues } = generateRHFSchema(config as any);
          const result = zodSchema.safeParse(defaultValues);

          if (!result.success) {
            const errors = result.error.issues.filter(
              (i: any) => i.message !== "This field is required" && i.code !== "too_small"
            );
            if (errors.length > 0) {
              failedCombinations.push({
                type: baseType,
                inputType,
                error: `Validation failed: ${JSON.stringify(errors)}`,
              });
            }
          }
        } catch (error: any) {
          failedCombinations.push({
            type: baseType,
            inputType,
            error: `Exception: ${error.message}`,
          });
        }
      }
    }

    if (failedCombinations.length > 0) {
      const errorMsg = failedCombinations
        .map((c) => `[${c.type}${c.inputType ? "/" + c.inputType : ""}]: ${c.error}`)
        .join("\n");
      expect.unreachable(`Found ${failedCombinations.length} invalid type combinations:\n${errorMsg}`);
    }
  });
});

describe("Field Validators Zod Validation", () => {
  it("all shared validator definitions should be valid for RHF schema generation", () => {
    const options = DEFAULT_VALIDATOR_DEFINITIONS.options;
    const failedValidators: { name: string; error: string }[] = [];

    options.forEach((option: any) => {
      try {
        const field: any = {
          name: "testField",
          displayName: "Test Field",
          category: "1",
          type: "text",
          validators: option.validators || [],
        };

        if (option.validators?.some((v: any) => v.type === "numeric")) {
          field.type = "number";
          field.inputType = "number";
        }

        const config = {
          schemaVersion: "v2.0.0",
          displayName: "Test",
          categories: [{ id: "1", name: "Test" }],
          fields: { [field.name]: field },
          pages: [{ id: "test-page", fields: [field.name] }],
        };

        const { zodSchema, defaultValues } = generateRHFSchema(config as any);
        const result = zodSchema.safeParse(defaultValues);

        if (!result.success) {
          const errors = result.error.issues.filter(
            (i: any) => i.message !== "This field is required"
          );
          if (errors.length > 0) {
            failedValidators.push({
              name: option.displayName,
              error: `Validation failed: ${JSON.stringify(errors)}`,
            });
          }
        }
      } catch (error: any) {
        failedValidators.push({
          name: option.displayName,
          error: `Exception: ${error.message}`,
        });
      }
    });

    if (failedValidators.length > 0) {
      const errorMsg = failedValidators.map((f) => `[${f.name}]: ${f.error}`).join("\n");
      expect.unreachable(
        `Found ${failedValidators.length} invalid validator definitions:\n${errorMsg.substring(0, 2000)}`
      );
    }
  });
});
