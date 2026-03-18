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

import type { FieldData, Choice, Validator } from "./survey-generator.js";

export enum FieldType {
  FILE = 'file',
  TEXT = 'text',
  DROPDOWN = 'dropdown',
  BOOLEAN = 'boolean',
  CHECKBOX = 'checkbox',
  RADIOGROUP = 'radiogroup',
  SLIDER = 'slider',
  HTML = 'html',
  TAGBOX = 'tagbox',
  NUMBER = 'number',
  EMAIL = 'email',
  COMMENT = 'comment',
  RANGE = 'range',
  UNKNOWN = 'unknown',
}

export interface FormFieldType {
  name: string;
  displayName: string;
}

export interface FormFieldInputType {
  name: string;
  displayName: string;
}

export interface FormFieldTypeDefinitions {
  version: number;
  types: FormFieldType[];
  input_types: FormFieldInputType[];
}

export interface DropdownOption {
  id: number;
  name: string;
  displayName: string;
  choices: Choice[];
}

export interface EditorValidator {
  id: number;
  displayName: string;
  class: string;
  description: string;
  isRequired: boolean;
  validators: Validator[];
}

function toFieldType(value: string): FieldType {
  const typeMap: Record<string, FieldType> = {
    [FieldType.FILE]: FieldType.FILE,
    [FieldType.TEXT]: FieldType.TEXT,
    [FieldType.DROPDOWN]: FieldType.DROPDOWN,
    [FieldType.BOOLEAN]: FieldType.BOOLEAN,
    [FieldType.CHECKBOX]: FieldType.CHECKBOX,
    [FieldType.RADIOGROUP]: FieldType.RADIOGROUP,
    [FieldType.SLIDER]: FieldType.SLIDER,
    [FieldType.HTML]: FieldType.HTML,
    [FieldType.TAGBOX]: FieldType.TAGBOX,
    [FieldType.NUMBER]: FieldType.NUMBER,
    [FieldType.EMAIL]: FieldType.EMAIL,
    [FieldType.COMMENT]: FieldType.COMMENT,
    [FieldType.RANGE]: FieldType.RANGE,
  };
  return typeMap[value] || FieldType.UNKNOWN;
}

export default abstract class FormField {
  fieldObject: FieldData;

  constructor(name: string, displayName: string, type: string, category: string) {
    this.fieldObject = {
      name,
      displayName,
      type,
      category,
    };
  }

  static fromObject(fieldObject: FieldData): FormField {
    if (!fieldObject.name) {
      throw new Error('Field name is required');
    }

    if (!fieldObject.displayName || !fieldObject.category) {
      throw new Error(
        `Invalid field object: '${fieldObject.name}' field missing displayName or category`
      );
    }

    const identifiedType = toFieldType(fieldObject.type as string);
    if (identifiedType === FieldType.UNKNOWN) {
      throw new Error(
        `'${fieldObject.name}' field has unsupported or missing type: ${fieldObject.type}`
      );
    }

    if (
      fieldObject.choices &&
      !['dropdown', 'checkbox', 'radiogroup', 'tagbox'].includes(fieldObject.type as string)
    ) {
      // Logic remained as is
    }

    if (fieldObject.type === 'dropdown' && !fieldObject.choices) {
      throw new Error(
        `Invalid field object: '${fieldObject.name}' field has type dropdown, but does not have choices`
      );
    }

    let field: FormField;
    if (fieldObject.type === 'file') {
      field = new FileFormField(
        fieldObject.name,
        fieldObject.displayName || fieldObject.name,
        fieldObject.type,
        String(fieldObject.category),
        fieldObject.ihs_column_names || []
      );
    } else {
      field = new BasicFormField(
        fieldObject.name,
        fieldObject.displayName || fieldObject.name,
        fieldObject.type || 'text',
        String(fieldObject.category)
      );
    }

    field.fieldObject = { ...fieldObject };
    field.fieldObject.category = String(field.fieldObject.category);

    // Remove legacy categoryId property
    delete (field.fieldObject as any).categoryId;

    return field;
  }

  abstract getFieldNames(): string[];

  protected cleanObject(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    let target = obj;
    if (typeof obj.toJSON === 'function' && obj !== this) {
      target = obj.toJSON();
    }

    if (Array.isArray(target)) {
      return target.map((v: any) => (typeof v === 'object' ? this.cleanObject(v) : v));
    }

    if (typeof target !== 'object') return target;

    const cleaned: any = {};
    Object.keys(target).forEach((key) => {
      const value = target[key];
      if (value !== null && value !== undefined && value !== '') {
        if (typeof value === 'object') {
          cleaned[key] = this.cleanObject(value);
        } else {
          cleaned[key] = value;
        }
      }
    });
    return cleaned;
  }

  toJSON() {
    return this.cleanObject({ ...this.fieldObject });
  }

  get displayName(): string {
    return this.fieldObject.displayName || this.fieldObject.name || '';
  }

  set displayName(newDisplayName: string) {
    this.fieldObject.displayName = newDisplayName;
  }

  get name(): string {
    return this.fieldObject.name || '';
  }

  get type(): FieldType {
    return toFieldType(this.fieldObject.type as string);
  }

  get inputType(): string {
    return this.fieldObject.inputType ?? '';
  }

  get categoryId(): string {
    return String(this.fieldObject.category || '');
  }

  set categoryId(categoryId: string) {
    this.fieldObject.category = categoryId;
  }

  get defaultValue(): any {
    return this.fieldObject.defaultValue;
  }

  set defaultValue(value: any) {
    this.fieldObject.defaultValue = value;
  }

  get placeholder(): string | undefined {
    return this.fieldObject.placeholder;
  }

  get validators(): Validator[] | undefined {
    return this.fieldObject.validators as Validator[];
  }

  get choices(): Choice[] {
    return (this.fieldObject.choices as Choice[]) ?? [];
  }

  set choices(choices: Choice[]) {
    this.fieldObject.choices = choices;
  }

  get visible(): boolean {
    return this.fieldObject.visible ?? true;
  }

  get visibleIf(): string | undefined {
    return this.fieldObject.visibleIf;
  }

  get isRequired(): boolean {
    return this.fieldObject.required ?? this.fieldObject.isRequired ?? true;
  }

  get startWithNewLine(): boolean {
    return this.fieldObject.startWithNewLine ?? true;
  }

  get requiredForEvaluation(): boolean {
    return this.fieldObject.requiredForEvaluation ?? true;
  }

  get maxLength(): number | undefined {
    return typeof this.fieldObject.maxLength === 'string'
      ? Number.parseInt(this.fieldObject.maxLength)
      : this.fieldObject.maxLength;
  }

  get min(): number | undefined {
    return typeof this.fieldObject.min === 'string'
      ? Number.parseFloat(this.fieldObject.min)
      : this.fieldObject.min;
  }

  get max(): number | undefined {
    return typeof this.fieldObject.max === 'string'
      ? Number.parseFloat(this.fieldObject.max)
      : this.fieldObject.max;
  }
}

export class BasicFormField extends FormField {
  constructor(name: string, displayName: string, type: string, category: string) {
    super(name, displayName, type, category);
  }

  getFieldNames(): string[] {
    if (this.fieldObject.requiredForEvaluation === false) {
      return [];
    }

    return [this.fieldObject.name!];
  }
}

export class FileFormField extends FormField {
  constructor(
    name: string,
    displayName: string,
    type: string,
    category: string,
    ihs_column_names: string[]
  ) {
    super(name, displayName, type, category);
    this.fieldObject.ihs_column_names = ihs_column_names;
  }

  getFieldNames(): string[] {
    if (this.fieldObject.requiredForEvaluation === false) {
      return [];
    }

    return this.fieldObject.ihs_column_names || [];
  }
}
