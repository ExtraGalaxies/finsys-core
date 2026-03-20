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

/**
 * Regression tests for SYS-2085 / SYS-528:
 * - ssm_business_information file field with SSM IHS column names
 * - ic_front file field with NRIC IHS column names
 *
 * These tests guard against regressions in field specs that feed into
 * downstream form rendering, IHS extraction, and evaluation pipelines.
 */

import { describe, it, expect } from "vitest";
import {
  BASE_FIELD_SPECS,
  getBaseFieldSpecs,
  getBaseFieldNames,
  getBaseFieldSpecMap,
} from "./catalogs.js";
import FormField, { FileFormField, FieldType } from "./form-field.js";
import type { FieldData } from "./survey-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findField(name: string): FieldData | undefined {
  return BASE_FIELD_SPECS.fields.find((f) => f.name === name);
}

// ---------------------------------------------------------------------------
// SSM field: ssm_business_information
// ---------------------------------------------------------------------------

describe("ssm_business_information field spec (SYS-2085)", () => {
  const SSM_FIELD_NAME = "ssm_business_information";

  const SSM_IHS_COLUMNS = [
    "ssmCompanyName",
    "ssmCompanyRegNo",
    "ssmIncorporatedDate",
    "businessCommencementDate",
    "businessNature",
    "companyStatus",
    "shareholders",
    "directors",
    "previousDirectors",
    "totalShareIssued",
    "companyLastOldName",
    "companyNameDateOfChange",
    "businessOrigin",
    "registeredAddress",
  ];

  it("exists in BASE_FIELD_SPECS", () => {
    const field = findField(SSM_FIELD_NAME);
    expect(field, `Field '${SSM_FIELD_NAME}' must exist in form-field-base-specs`).toBeDefined();
  });

  it("has type 'file'", () => {
    const field = findField(SSM_FIELD_NAME)!;
    expect(field.type).toBe("file");
  });

  it("has displayName 'SSM Company Profile'", () => {
    const field = findField(SSM_FIELD_NAME)!;
    expect(field.displayName).toBe("SSM Company Profile");
  });

  it("has category '13'", () => {
    const field = findField(SSM_FIELD_NAME)!;
    expect(String(field.category)).toBe("13");
  });

  it("ihs_column_names contains exactly the expected columns (no extra, no missing)", () => {
    const field = findField(SSM_FIELD_NAME)!;
    const actual = [...(field.ihs_column_names as string[])].sort();
    const expected = [...SSM_IHS_COLUMNS].sort();
    expect(actual).toEqual(expected);
  });

  it("has enableIf condition referencing formOfDisclosure", () => {
    const field = findField(SSM_FIELD_NAME)!;
    expect(field.enableIf).toBeDefined();
    expect(field.enableIf).toContain("formOfDisclosure");
  });

  it("parses to a FileFormField instance", () => {
    const field = findField(SSM_FIELD_NAME)!;
    const formField = FormField.fromObject(field);
    expect(formField).toBeInstanceOf(FileFormField);
    expect(formField.type).toBe(FieldType.FILE);
  });

  it("getFieldNames() returns all SSM ihs_column_names", () => {
    const field = findField(SSM_FIELD_NAME)!;
    const formField = FormField.fromObject(field);
    const names = formField.getFieldNames();
    for (const col of SSM_IHS_COLUMNS) {
      expect(names.includes(col), `getFieldNames() must include '${col}'`).toBe(true);
    }
  });

  it("getFieldNames() returns empty when requiredForEvaluation is false", () => {
    const field = findField(SSM_FIELD_NAME)!;
    const formField = FormField.fromObject({
      ...field,
      requiredForEvaluation: false,
    });
    expect(formField.getFieldNames()).toEqual([]);
  });

  it("serializes and deserializes without data loss (round-trip)", () => {
    const field = findField(SSM_FIELD_NAME)!;
    const formField = FormField.fromObject(field);
    const json = formField.toJSON() as any;

    expect(json.name).toBe(SSM_FIELD_NAME);
    expect(json.type).toBe("file");
    expect(json.displayName).toBe("SSM Company Profile");
    expect(json.ihs_column_names).toEqual(field.ihs_column_names);

    // Re-parse the serialized JSON — must produce an identical FormField
    const reparsed = FormField.fromObject(json);
    expect(reparsed.getFieldNames()).toEqual(formField.getFieldNames());
  });
});

// ---------------------------------------------------------------------------
// NRIC/IC field: ic_front
// ---------------------------------------------------------------------------

describe("ic_front field spec (SYS-2085)", () => {
  const IC_FIELD_NAME = "ic_front";

  const IC_IHS_COLUMNS = [
    "icNumber",
    "icName",
    "icAddress",
    "icGender",
    "icReligion",
    "icDateOfBirth",
    "icPlaceOfBirth",
    "icNationality",
    "icRace",
  ];

  it("exists in BASE_FIELD_SPECS", () => {
    const field = findField(IC_FIELD_NAME);
    expect(field, `Field '${IC_FIELD_NAME}' must exist in form-field-base-specs`).toBeDefined();
  });

  it("has type 'file'", () => {
    const field = findField(IC_FIELD_NAME)!;
    expect(field.type).toBe("file");
  });

  it("has displayName 'Identification Card (Front)'", () => {
    const field = findField(IC_FIELD_NAME)!;
    expect(field.displayName).toBe("Identification Card (Front)");
  });

  it("has category '13'", () => {
    const field = findField(IC_FIELD_NAME)!;
    expect(String(field.category)).toBe("13");
  });

  it("ihs_column_names contains exactly the expected columns (no extra, no missing)", () => {
    const field = findField(IC_FIELD_NAME)!;
    const actual = [...(field.ihs_column_names as string[])].sort();
    const expected = [...IC_IHS_COLUMNS].sort();
    expect(actual).toEqual(expected);
  });

  it("has enableIf condition referencing formOfDisclosure", () => {
    const field = findField(IC_FIELD_NAME)!;
    expect(field.enableIf).toBeDefined();
    expect(field.enableIf).toContain("formOfDisclosure");
  });

  it("parses to a FileFormField instance", () => {
    const field = findField(IC_FIELD_NAME)!;
    const formField = FormField.fromObject(field);
    expect(formField).toBeInstanceOf(FileFormField);
    expect(formField.type).toBe(FieldType.FILE);
  });

  it("getFieldNames() returns all NRIC ihs_column_names", () => {
    const field = findField(IC_FIELD_NAME)!;
    const formField = FormField.fromObject(field);
    const names = formField.getFieldNames();
    for (const col of IC_IHS_COLUMNS) {
      expect(names.includes(col), `getFieldNames() must include '${col}'`).toBe(true);
    }
  });

  it("getFieldNames() returns empty when requiredForEvaluation is false", () => {
    const field = findField(IC_FIELD_NAME)!;
    const formField = FormField.fromObject({
      ...field,
      requiredForEvaluation: false,
    });
    expect(formField.getFieldNames()).toEqual([]);
  });

  it("serializes and deserializes without data loss (round-trip)", () => {
    const field = findField(IC_FIELD_NAME)!;
    const formField = FormField.fromObject(field);
    const json = formField.toJSON() as any;

    expect(json.name).toBe(IC_FIELD_NAME);
    expect(json.type).toBe("file");
    expect(json.displayName).toBe("Identification Card (Front)");
    expect(json.ihs_column_names).toEqual(field.ihs_column_names);

    const reparsed = FormField.fromObject(json);
    expect(reparsed.getFieldNames()).toEqual(formField.getFieldNames());
  });
});

// ---------------------------------------------------------------------------
// Catalog integration: getBaseFieldNames / getBaseFieldSpecMap
// ---------------------------------------------------------------------------

describe("getBaseFieldNames includes new SSM/NRIC columns (SYS-2085)", () => {
  const NEW_COLUMNS = [
    "businessCommencementDate",
    "shareholders",
    "directors",
    "previousDirectors",
    "icName",
    "icNumber",
    "icAddress",
    "icGender",
    "icReligion",
    "icDateOfBirth",
    "icPlaceOfBirth",
    "icNationality",
    "icRace",
  ];

  it("returns all new SSM IHS column names", () => {
    const names = getBaseFieldNames();
    for (const col of NEW_COLUMNS) {
      expect(names.includes(col), `getBaseFieldNames() must include '${col}'`).toBe(true);
    }
  });

  it("returns unique field names (no duplicates)", () => {
    const names = getBaseFieldNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("getBaseFieldSpecMap includes new SSM/NRIC fields (SYS-2085)", () => {
  it("contains ssm_business_information", () => {
    const map = getBaseFieldSpecMap();
    expect(map.has("ssm_business_information")).toBe(true);
    expect(map.get("ssm_business_information")!.type).toBe("file");
  });

  it("contains ic_front", () => {
    const map = getBaseFieldSpecMap();
    expect(map.has("ic_front")).toBe(true);
    expect(map.get("ic_front")!.type).toBe("file");
  });
});

describe("getBaseFieldSpecs includes new SSM/NRIC fields (SYS-2085)", () => {
  it("contains both new file fields", () => {
    const fields = getBaseFieldSpecs();
    const names = fields.map((f) => f.name);
    expect(names).toContain("ssm_business_information");
    expect(names).toContain("ic_front");
  });
});

// ---------------------------------------------------------------------------
// Edge cases and spec integrity
// ---------------------------------------------------------------------------

describe("SYS-2085 field spec integrity edge cases", () => {
  it("ssm_business_information does not have empty ihs_column_names", () => {
    const field = findField("ssm_business_information")!;
    expect((field.ihs_column_names as string[]).length).toBeGreaterThan(0);
  });

  it("ic_front does not have empty ihs_column_names", () => {
    const field = findField("ic_front")!;
    expect((field.ihs_column_names as string[]).length).toBeGreaterThan(0);
  });

  it("all ihs_column_names in ssm_business_information are non-empty strings", () => {
    const field = findField("ssm_business_information")!;
    for (const col of field.ihs_column_names as string[]) {
      expect(typeof col).toBe("string");
      expect(col.length).toBeGreaterThan(0);
    }
  });

  it("all ihs_column_names in ic_front are non-empty strings", () => {
    const field = findField("ic_front")!;
    for (const col of field.ihs_column_names as string[]) {
      expect(typeof col).toBe("string");
      expect(col.length).toBeGreaterThan(0);
    }
  });

  it("no duplicate ihs_column_names in ssm_business_information", () => {
    const field = findField("ssm_business_information")!;
    const cols = field.ihs_column_names as string[];
    expect(new Set(cols).size).toBe(cols.length);
  });

  it("no duplicate ihs_column_names in ic_front", () => {
    const field = findField("ic_front")!;
    const cols = field.ihs_column_names as string[];
    expect(new Set(cols).size).toBe(cols.length);
  });

  it("new file fields with no ihs_column_names would return empty getFieldNames", () => {
    const emptyFileField = FormField.fromObject({
      name: "test_file",
      displayName: "Test File",
      type: "file",
      category: "13",
      ihs_column_names: [],
    });
    expect(emptyFileField.getFieldNames()).toEqual([]);
  });

  it("FileFormField correctly stores and retrieves ihs_column_names on construction", () => {
    const cols = ["col1", "col2", "col3"];
    const field = new FileFormField("my_file", "My File", "file", "13", cols);
    expect(field.getFieldNames()).toEqual(cols);
  });

  it("ssm_business_information field name is valid (no spaces, no special chars beyond underscore)", () => {
    const field = findField("ssm_business_information")!;
    expect(field.name).toMatch(/^[a-z_]+$/);
  });

  it("ic_front field name is valid (no spaces, no special chars beyond underscore)", () => {
    const field = findField("ic_front")!;
    expect(field.name).toMatch(/^[a-z_]+$/);
  });
});
