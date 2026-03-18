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
import { FormSpec } from "./form-spec.js";
import { FormFieldCategory } from "./form-field-category.js";
import FormField from "./form-field.js";

describe("FormSpec", () => {
  it("manages display name", () => {
    const spec = new FormSpec("Spec", [], [], []);
    expect(spec.displayName).toBe("Spec");
    spec.displayName = "New Spec";
    expect(spec.displayName).toBe("New Spec");
  });

  it("manages template icon", () => {
    const spec = new FormSpec("Spec", [], [], []);
    expect(spec.templateIcon).toBeUndefined();
    spec.templateIcon = "icon";
    expect(spec.templateIcon).toBe("icon");
  });

  it("manages categories", () => {
    const spec = new FormSpec("Spec", [], [], []);
    spec.categories = [new FormFieldCategory("c1", "C1")];
    expect(spec.categories.length).toBe(1);
  });

  it("manages fields", () => {
    const spec = new FormSpec("Spec", [], [], []);
    spec.fields = [
      FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "c1" }),
    ];
    expect(spec.fields.length).toBe(1);
  });

  it("manages pages", () => {
    const spec = new FormSpec("Spec", [], [], []);
    spec.pages = [{ id: "p1", title: "P1", fields: ["f1"] }];
    expect(spec.pages.length).toBe(1);
  });

  it("adds field", () => {
    const cat1 = new FormFieldCategory("cat1", "Category 1");
    const field1 = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "cat1" });
    const spec = new FormSpec("Spec", [cat1], [field1], []);

    const field2 = FormField.fromObject({ name: "f2", displayName: "F2", type: "text", category: "cat1" });
    spec.addField(field2);
    expect(spec.fields.length).toBe(2);
  });

  it("updates existing field", () => {
    const field1 = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "cat1" });
    const spec = new FormSpec("Spec", [], [field1], []);

    spec.updateField(
      FormField.fromObject({ name: "f1", displayName: "F1 Updated", type: "text", category: "cat1" })
    );
    expect(spec.fields[0].displayName).toBe("F1 Updated");
  });

  it("throws when updating non-existent field", () => {
    const spec = new FormSpec("Spec", [], [], []);
    expect(() =>
      spec.updateField(
        FormField.fromObject({ name: "missing", displayName: "Err", type: "text", category: "cat1" })
      )
    ).toThrow(/not found/);
  });

  it("removes field", () => {
    const field1 = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "cat1" });
    const field2 = FormField.fromObject({ name: "f2", displayName: "F2", type: "text", category: "cat1" });
    const spec = new FormSpec("Spec", [], [field1, field2], []);

    spec.removeField("f1");
    expect(spec.fields.length).toBe(1);
    spec.removeField("f2");
    expect(spec.fields.length).toBe(0);
  });

  it("removes field from pages", () => {
    const field1 = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "cat1" });
    const pages = [
      {
        id: "p1",
        title: "P1",
        fields: ["f1", { ref: "f1" }, { definition: { name: "f1" } } as any, "f2"],
      },
    ];
    const spec = new FormSpec("Spec", [], [field1], pages);

    spec.removeField("f1");
    expect(spec.pages[0].fields).toEqual(["f2"]);
  });

  it("gets fields by category", () => {
    const cat1 = new FormFieldCategory("cat1", "Category 1");
    const field1 = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "cat1" });
    const field2 = FormField.fromObject({ name: "f2", displayName: "F2", type: "text", category: "cat1" });
    const spec = new FormSpec("Spec", [cat1], [field1, field2], []);

    expect(spec.getFieldsByCategory("Category 1").length).toBe(2);
    expect(spec.getFieldsByCategory("Missing").length).toBe(0);
  });

  it("gets fieldNames", () => {
    const field1 = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "cat1" });
    const field2 = FormField.fromObject({ name: "f2", displayName: "F2", type: "text", category: "cat1" });
    const spec = new FormSpec("Spec", [], [field1, field2], []);

    expect(spec.fieldNames).toEqual(["f1", "f2"]);
  });
});

describe("FormSpec schema version", () => {
  it("detects requiresUpgrade", () => {
    const spec = new FormSpec("Spec", [], [], [], undefined, "v1.0.0");
    expect(spec.requiresUpgrade).toBe(true);
  });

  it("upgrades to v2", () => {
    const spec = new FormSpec("Spec", [], [], [], undefined, "v1.0.0");
    spec.upgradeToV2();
    expect(spec.schemaVersion).toBe("v2.0.0");
    expect(spec.requiresUpgrade).toBe(false);
  });
});

describe("FormSpec toJSON", () => {
  it("serializes correctly", () => {
    const field = FormField.fromObject({ name: "f1", displayName: "F1", type: "text", category: "c1" });
    const spec = new FormSpec("Valid", [], [field], []);
    const json = spec.toJSON() as any;

    expect(json.displayName).toBe("Valid");
    expect(json.$schema).toBeDefined();
    expect(json.fields.f1).toBeDefined();
    expect(json.fields.f1.name).toBeUndefined();
  });

  it("cleans null and empty optional fields", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fieldObj: any = {
      name: "age",
      displayName: "Age",
      type: "number",
      category: "personal",
      visibleIf: null,
      min: "",
      max: undefined,
    };
    const fields = [FormField.fromObject(fieldObj)];
    const pages = [{ id: "p1", title: "P1", fields: ["age"] }];

    const spec = new FormSpec("Form", categories, fields, pages);
    const json = spec.toJSON() as any;
    const ageField = json.fields.age;

    expect(ageField.visibleIf).toBeUndefined();
    expect(ageField.min).toBeUndefined();
    expect(ageField.max).toBeUndefined();
  });

  it("persists defaultValue", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fields = [
      FormField.fromObject({
        name: "amount",
        displayName: "Loan Amount",
        type: "number",
        category: "personal",
        defaultValue: "5000",
      }),
    ];
    const pages = [{ id: "p1", title: "P1", fields: ["amount"] }];

    const spec = new FormSpec("Form", categories, fields, pages);
    const json = spec.toJSON() as any;
    expect(json.fields.amount.defaultValue).toBe("5000");
  });
});

describe("FormSpec validate", () => {
  it("valid form spec passes", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fields = [
      FormField.fromObject({ name: "full_name", displayName: "Full Name", type: "text", category: "personal" }),
    ];
    const pages = [{ id: "page1", title: "Step 1", fields: ["full_name"] }];

    const spec = new FormSpec("Valid Form", categories, fields, pages);
    const result = spec.validate();
    expect(result.valid).toBe(true);
  });

  it("missing display name fails", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fields = [
      FormField.fromObject({ name: "full_name", displayName: "Full Name", type: "text", category: "personal" }),
    ];
    const pages = [{ id: "p1", title: "P1", fields: ["full_name"] }];

    const spec = new FormSpec("", categories, fields, pages);
    const result = spec.validate();
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toMatch(/displayName: Form display name is required/);
  });

  it("invalid schema version fails", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fields = [
      FormField.fromObject({ name: "full_name", displayName: "Full Name", type: "text", category: "personal" }),
    ];
    const pages = [{ id: "p1", title: "P1", fields: ["full_name"] }];

    const spec = new FormSpec("Form", categories, fields, pages, "icon", "invalid-version");
    const result = spec.validate();
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toMatch(/schemaVersion: must match pattern/);
  });

  it("orphaned category fails", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fields = [
      FormField.fromObject({
        name: "full_name",
        displayName: "Full Name",
        type: "text",
        category: "non-existent-category",
      }),
    ];
    const pages = [{ id: "p1", title: "P1", fields: ["full_name"] }];

    const spec = new FormSpec("Form", categories, fields, pages);
    const result = spec.validate();
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toMatch(/references non-existent category/);
  });

  it("page referencing non-existent field fails", () => {
    const categories = [new FormFieldCategory("personal", "Personal Information")];
    const fields = [
      FormField.fromObject({ name: "full_name", displayName: "Full Name", type: "text", category: "personal" }),
    ];
    const pages = [{ id: "page1", title: "Step 1", fields: ["missing_field"] }];

    const spec = new FormSpec("Form", categories, fields, pages);
    const result = spec.validate();
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toMatch(/references non-existent field/);
  });
});

describe("FormSpec fromJSON", () => {
  it("throws for missing schemaVersion", () => {
    expect(() => FormSpec.fromJSON(JSON.stringify({ displayName: "Err" }))).toThrow(
      /schemaVersion is missing/
    );
  });

  it("throws for outdated version", () => {
    expect(() =>
      FormSpec.fromJSON(JSON.stringify({ schemaVersion: "v0.9.0", displayName: "Err" }))
    ).toThrow(/outdated schema version/);
  });

  it("throws for missing displayName", () => {
    expect(() => FormSpec.fromJSON(JSON.stringify({ schemaVersion: "v1.0.0" }))).toThrow(
      /displayName is missing/
    );
  });

  it("throws for missing categories", () => {
    expect(() =>
      FormSpec.fromJSON(JSON.stringify({ schemaVersion: "v1.0.0", displayName: "D" }))
    ).toThrow(/categories is missing/);
  });

  it("throws for missing fields", () => {
    expect(() =>
      FormSpec.fromJSON(
        JSON.stringify({ schemaVersion: "v1.0.0", displayName: "D", categories: [] })
      )
    ).toThrow(/fields is missing/);
  });

  it("throws for invalid JSON", () => {
    expect(() => FormSpec.fromJSON("invalid")).toThrow();
  });

  it("parses legacy fields array with categoryId", () => {
    const legacyJson = {
      schemaVersion: "v1.0.0",
      displayName: "Legacy",
      categories: [{ id: 1, name: "C1" }],
      fields: [{ name: "f1", displayName: "F1", type: "text", categoryId: 1 }],
    };
    const spec = FormSpec.fromJSON(JSON.stringify(legacyJson));
    expect(spec.fields.length).toBe(1);
    expect(spec.pages.length).toBe(1);
  });

  it("parses v2 object fields format", () => {
    const v2Json = {
      schemaVersion: "v2.0.0",
      displayName: "v2",
      categories: [{ id: "c1", name: "C1" }],
      fields: { f1: { displayName: "F1", type: "text", category: "c1" } },
      pages: [{ id: "p1", fields: ["f1"] }],
    };
    const spec = FormSpec.fromJSON(JSON.stringify(v2Json));
    expect(spec.fields.length).toBe(1);
    expect(spec.fields[0].name).toBe("f1");
  });

  it("generates default pages when missing", () => {
    const v2NoPages = {
      schemaVersion: "v2.0.0",
      displayName: "v2",
      categories: [{ id: "c1", name: "C1" }],
      fields: { f1: { displayName: "F1", type: "text", category: "c1" } },
    };
    const spec = FormSpec.fromJSON(JSON.stringify(v2NoPages));
    expect(spec.pages.length).toBe(1);
  });

  it("throws error when displayName is missing from JSON", () => {
    const formSpecFile = {
      schemaVersion: "v2.0.0",
      categories: [{ id: "1", name: "Basic Information" }],
      fields: {
        dateOfBirth: {
          displayName: "Date of Birth",
          type: "text",
          inputType: "date",
          category: "2",
          visible: false,
        },
      },
      pages: [{ id: "page-1", fields: ["dateOfBirth"] }],
    };
    expect(() => FormSpec.fromJSON(JSON.stringify(formSpecFile))).toThrow(
      "Invalid JSON: displayName is missing or invalid"
    );
  });

  it("throws error when categories are missing from JSON", () => {
    const formSpecFile = {
      schemaVersion: "v2.0.0",
      displayName: "test",
      fields: {
        dateOfBirth: {
          displayName: "Date of Birth",
          type: "text",
          inputType: "date",
          category: "2",
          visible: false,
        },
      },
      pages: [{ id: "page-1", fields: ["dateOfBirth"] }],
    };
    expect(() => FormSpec.fromJSON(JSON.stringify(formSpecFile))).toThrow(
      "Invalid JSON: categories is missing or invalid"
    );
  });

  it("throws error when fields are missing from JSON", () => {
    const formSpecFile = {
      schemaVersion: "v2.0.0",
      displayName: "test",
      categories: [{ id: "1", name: "Basic Information" }],
      pages: [{ id: "page-1", fields: ["dateOfBirth"] }],
    };
    expect(() => FormSpec.fromJSON(JSON.stringify(formSpecFile))).toThrow(
      "Invalid JSON: fields is missing or invalid"
    );
  });
});

describe("FormFieldCategory", () => {
  it("manages id, name, and toJSON", () => {
    const category = new FormFieldCategory("cat1", "Category 1");
    expect(category.id).toBe("cat1");
    expect(category.name).toBe("Category 1");

    category.name = "Updated Category";
    expect(category.name).toBe("Updated Category");

    expect(category.toJSON()).toEqual({
      id: "cat1",
      name: "Updated Category",
    });
  });

  it("converts numeric id to string", () => {
    const category = new FormFieldCategory(42, "Test");
    expect(category.id).toBe("42");
  });
});
