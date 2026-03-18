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

import type { FieldData, Category } from "./survey-generator.js";
import type { FormFieldTypeDefinitions, EditorValidator } from "./form-field.js";
import type { FormValidatorDefinitions } from "./form-field-validator.js";
import FormField from "./form-field.js";
import baseSpecsData from "./data/form-field-base-specs.json" with { type: "json" };
import typeDefsData from "./data/form-field-types.json" with { type: "json" };
import validatorDefsData from "./data/form-field-validators.json" with { type: "json" };

export const BASE_FIELD_SPECS: {
  schemaVersion: string;
  categories: Category[];
  fields: FieldData[];
} = baseSpecsData as any;

export const FIELD_TYPE_DEFINITIONS: FormFieldTypeDefinitions = typeDefsData as FormFieldTypeDefinitions;

export const DEFAULT_VALIDATOR_DEFINITIONS: FormValidatorDefinitions = {
  version: (validatorDefsData as any).version,
  options: (validatorDefsData as any).options as EditorValidator[],
};

export function getBaseFieldSpecs(): FieldData[] {
  return BASE_FIELD_SPECS.fields;
}

export function getBaseCategories(): Category[] {
  return BASE_FIELD_SPECS.categories;
}

let cachedFieldSpecMap: Map<string, FieldData> | null = null;

/**
 * Returns a cached Map of base field name → FieldData.
 * Keyed by each field's `name` property from the base specs.
 */
export function getBaseFieldSpecMap(): Map<string, FieldData> {
  if (cachedFieldSpecMap) {
    return cachedFieldSpecMap;
  }

  const map = new Map<string, FieldData>();
  for (const field of BASE_FIELD_SPECS.fields) {
    if (field.name) {
      map.set(field.name, field);
    }
  }

  cachedFieldSpecMap = map;
  return cachedFieldSpecMap;
}

let cachedFieldNames: string[] | null = null;

export function getBaseFieldNames(): string[] {
  if (cachedFieldNames) {
    return cachedFieldNames;
  }

  const fields = BASE_FIELD_SPECS.fields;
  const names: string[] = [];

  for (const field of fields) {
    try {
      const formField = FormField.fromObject(field);
      names.push(...formField.getFieldNames());
    } catch {
      // Skip fields that fail to parse
    }
  }

  cachedFieldNames = [...new Set(names)];
  return cachedFieldNames;
}
