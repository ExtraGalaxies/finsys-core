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
import FormField, {
  BasicFormField,
  FileFormField,
  FieldType,
} from "./form-field.js";
import type { FieldData } from "./survey-generator.js";

const basicField: FieldData = {
  name: "email",
  displayName: "Test",
  type: "text",
  inputType: "text",
  category: "1",
};

const fileField: FieldData = {
  name: "test",
  displayName: "Test",
  type: "file",
  inputType: "text",
  category: "1",
  ihs_column_names: ["idNumber", "companyName"],
};

describe("FormField", () => {
  it("creates basic field from object", () => {
    const formField = FormField.fromObject(basicField);
    const names = formField.getFieldNames();
    expect(names[0]).toBe("email");
  });

  it("creates file field from object", () => {
    const formField = FormField.fromObject(fileField);
    const names = formField.getFieldNames();
    expect(names[0]).toBe("idNumber");
    expect(names[1]).toBe("companyName");
  });

  it("gets displayName", () => {
    const formField = FormField.fromObject(basicField);
    expect(formField.displayName).toBe("Test");
  });

  it("gets name", () => {
    const formField = FormField.fromObject(basicField);
    expect(formField.name).toBe("email");
  });

  it("sets displayName", () => {
    const formField = FormField.fromObject({ ...basicField });
    formField.displayName = "New Display Name";
    expect(formField.displayName).toBe("New Display Name");
  });

  it("gets visible with true value", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      visible: true,
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.visible).toBe(true);
  });

  it("gets visible with undefined value defaults to true", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.visible).toBe(true);
  });

  it("gets visibleIf", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      visibleIf: '{test} == "test"',
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.visibleIf).toBe('{test} == "test"');
  });

  it("gets isRequired", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      isRequired: true,
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.isRequired).toBe(true);
  });

  it("gets type", () => {
    const formField = FormField.fromObject(basicField);
    expect(formField.type).toBe("text");
  });

  it("gets type for various field types", () => {
    const types = ["text", "file", "dropdown"];
    for (const type of types) {
      const fieldObject: FieldData = {
        name: "test",
        displayName: "Test Field",
        type: type,
        category: "1",
        ...(type === "dropdown"
          ? { choices: [{ text: "Option", value: "1" }] }
          : {}),
      };
      const formField = FormField.fromObject(fieldObject);
      expect(formField.type).toBe(type);
    }
  });

  it("gets inputType with defined inputType", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test Field",
      type: "text",
      inputType: "email",
      category: "1",
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.inputType).toBe("email");
  });

  it("gets inputType with undefined inputType returns empty string", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test Field",
      type: "text",
      category: "1",
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.inputType).toBe("");
  });

  it("gets and sets categoryId", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test Field",
      type: "text",
      category: "5",
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.categoryId).toBe("5");
    formField.categoryId = "3";
    expect(formField.categoryId).toBe("3");
  });

  it("gets and sets choices", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test",
      type: "dropdown",
      category: "1",
      choices: [
        { text: "Option 1", value: "1" },
        { text: "Option 2", value: "2" },
      ],
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.choices).toEqual([
      { text: "Option 1", value: "1" },
      { text: "Option 2", value: "2" },
    ]);
    formField.choices = [{ text: "New", value: "n" }];
    expect(formField.choices).toEqual([{ text: "New", value: "n" }]);
  });

  it("gets choices with undefined choices returns empty array", () => {
    const fieldObject: FieldData = {
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
    };
    const formField = FormField.fromObject(fieldObject);
    expect(formField.choices).toEqual([]);
  });

  it("gets startWithNewLine default true", () => {
    const formField = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
    });
    expect(formField.startWithNewLine).toBe(true);
  });

  it("gets startWithNewLine false", () => {
    const formField = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      startWithNewLine: false,
    });
    expect(formField.startWithNewLine).toBe(false);
  });

  it("gets requiredForEvaluation default true", () => {
    const formField = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
    });
    expect(formField.requiredForEvaluation).toBe(true);
  });

  it("gets requiredForEvaluation false", () => {
    const formField = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "boolean",
      category: "7",
      requiredForEvaluation: false,
    });
    expect(formField.requiredForEvaluation).toBe(false);
  });

  it("parses maxLength, min, max from strings", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      maxLength: "100",
      min: "10.5",
      max: "50.5",
    } as any);
    expect(field.maxLength).toBe(100);
    expect(field.min).toBe(10.5);
    expect(field.max).toBe(50.5);
  });

  it("gets maxLength as number", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      maxLength: 18,
    });
    expect(field.maxLength).toBe(18);
  });

  it("gets undefined for missing optional properties", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
    });
    expect(field.placeholder).toBeUndefined();
    expect(field.validators).toBeUndefined();
    expect(field.maxLength).toBeUndefined();
    expect(field.min).toBeUndefined();
    expect(field.max).toBeUndefined();
  });

  it("gets placeholder and validators", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      placeholder: "Enter something",
      validators: [{ type: "numeric", text: "Too high", maxValue: 50 }],
    });
    expect(field.placeholder).toBe("Enter something");
    expect(field.validators).toEqual([
      { type: "numeric", text: "Too high", maxValue: 50 },
    ]);
  });

  it("gets and sets defaultValue", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      defaultValue: "initial-value",
    });
    expect(field.defaultValue).toBe("initial-value");
    field.defaultValue = "new-value";
    expect(field.defaultValue).toBe("new-value");
    expect((field.toJSON() as any).defaultValue).toBe("new-value");
  });

  it("handles numeric defaultValue", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      defaultValue: 12345,
    });
    expect(field.defaultValue).toBe(12345);
  });
});

describe("FormField toJSON", () => {
  it("serializes basic field", () => {
    const formField = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      inputType: "text",
    });
    expect(formField).toBeInstanceOf(BasicFormField);
    expect(formField.toJSON()).toEqual({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      inputType: "text",
    });
  });

  it("serializes file field", () => {
    const formField = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "file",
      category: "1",
      inputType: "text",
      ihs_column_names: ["col1", "col2"],
    });
    expect(formField).toBeInstanceOf(FileFormField);
    expect(formField.toJSON()).toEqual({
      name: "test",
      displayName: "Test",
      type: "file",
      category: "1",
      inputType: "text",
      ihs_column_names: ["col1", "col2"],
    });
  });
});

describe("FormField validation", () => {
  it("throws when name is missing", () => {
    expect(() =>
      FormField.fromObject({
        displayName: "Test",
        type: "text",
        category: "1",
      } as any)
    ).toThrow(/name is required/);
  });

  it("throws when displayName is missing", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        type: "text",
        category: "1",
      } as any)
    ).toThrow(/missing displayName or category/);
  });

  it("throws when category is missing", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: "Test",
        type: "text",
      } as any)
    ).toThrow(/missing displayName or category/);
  });

  it("throws when both displayName and category are missing", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        type: "text",
      } as any)
    ).toThrow(/missing displayName or category/);
  });

  it("throws when displayName is empty string", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: "",
        type: "text",
        category: "1",
      })
    ).toThrow(/missing displayName or category/);
  });

  it("throws when displayName and category are null", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: null,
        type: "text",
        category: null,
      } as any)
    ).toThrow(/missing displayName or category/);
  });

  it("throws for invalid field type", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: "Test",
        type: "invalid",
        category: "1",
      } as any)
    ).toThrow();
  });

  it("throws for dropdown without choices", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: "Test",
        type: "dropdown",
        category: "1",
      })
    ).toThrow(/type dropdown, but does not have choices/);
  });

  it("allows choices on non-dropdown fields", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: "Test",
        type: "text",
        category: "1",
        choices: [{ text: "testChoice", value: "01" }],
      })
    ).not.toThrow();
  });

  it("allows unknown inputTypes", () => {
    expect(() =>
      FormField.fromObject({
        name: "test",
        displayName: "Test",
        type: "text",
        inputType: "invalid" as any,
        category: "1",
      })
    ).not.toThrow();
  });
});

describe("FormField runtime - all field types", () => {
  it("correctly identifies all supported field types", () => {
    const validTypes = [
      { input: "text", expected: FieldType.TEXT },
      { input: "file", expected: FieldType.FILE },
      { input: "dropdown", expected: FieldType.DROPDOWN },
      { input: "boolean", expected: FieldType.BOOLEAN },
      { input: "checkbox", expected: FieldType.CHECKBOX },
      { input: "radiogroup", expected: FieldType.RADIOGROUP },
      { input: "slider", expected: FieldType.SLIDER },
      { input: "html", expected: FieldType.HTML },
      { input: "tagbox", expected: FieldType.TAGBOX },
    ];

    for (const { input, expected } of validTypes) {
      const fieldData: any = {
        name: "test",
        displayName: "Test",
        type: input,
        category: "cat1",
      };
      if (input === "dropdown") {
        fieldData.choices = [{ text: "Yes", value: "yes" }];
      }

      const field = FormField.fromObject(fieldData);
      expect(field.type).toBe(expected);
    }
  });

  it("throws error for invalid or unknown field types", () => {
    const invalidInputs = ["invalid", "", "something_else", null, undefined];

    for (const input of invalidInputs) {
      expect(() => {
        FormField.fromObject({
          name: "test",
          displayName: "Test",
          type: input as any,
          category: "cat1",
        });
      }).toThrow();
    }
  });
});

describe("FileFormField", () => {
  it("returns empty when requiredForEvaluation is false", () => {
    const field = FormField.fromObject({
      name: "file_field",
      displayName: "File Field",
      type: "file",
      category: "cat1",
      requiredForEvaluation: false,
      ihs_column_names: ["col1", "col2"],
    });
    expect(field.getFieldNames()).toEqual([]);
  });

  it("returns ihs_column_names when requiredForEvaluation is true", () => {
    const field = FormField.fromObject({
      name: "file_field",
      displayName: "File Field",
      type: "file",
      category: "cat1",
      ihs_column_names: ["col1", "col2"],
    });
    expect(field.getFieldNames()).toEqual(["col1", "col2"]);
  });
});

describe("BasicFormField", () => {
  it("returns empty when requiredForEvaluation is false", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
      requiredForEvaluation: false,
    });
    expect(field.getFieldNames()).toEqual([]);
  });

  it("returns field name when requiredForEvaluation is true", () => {
    const field = FormField.fromObject({
      name: "test",
      displayName: "Test",
      type: "text",
      category: "1",
    });
    expect(field.getFieldNames()).toEqual(["test"]);
  });
});
