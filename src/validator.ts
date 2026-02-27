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

import AjvModule, { ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import unifiedFormSchema from "./schema/unified-form.schema.json" with { type: "json" };

// Interop for Ajv which can be exported differently in ESM/CJS
const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });

// Interop for ajv-formats
const addFormatsFn = (addFormats as any).default || addFormats;
addFormatsFn(ajv);

// Register the unified schema
ajv.addSchema(unifiedFormSchema, "unified-form.schema.json");

export interface ValidationResult {
  valid: boolean;
  errors?: ErrorObject[];
  message?: string;
}

/**
 * Validates a unified form-config.json object against its schema
 */
export function validateFormConfig(data: unknown): ValidationResult {
  const validate = ajv.getSchema("unified-form.schema.json");
  if (!validate) {
    return { valid: false, message: "Could not load unified form schema" };
  }

  const valid = validate(data);
  return {
    valid: !!valid,
    errors: validate.errors || undefined,
  };
}

// Legacy exports - these now just call validateFormConfig
/** @deprecated Use validateFormConfig instead */
export function validateFormSpec(data: unknown): ValidationResult {
  return validateFormConfig(data);
}

/** @deprecated Use validateFormConfig instead */
export function validatePagesConfig(data: unknown): ValidationResult {
  return validateFormConfig(data);
}
