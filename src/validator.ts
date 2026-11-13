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
// Interop for ajv-formats
const addFormatsFn = (addFormats as any).default || addFormats;

const SCHEMA_KEY = "unified-form.schema.json";

let cachedAjv: any;

/**
 * Ajv compiles schemas into JavaScript with the Function constructor, and registering a
 * schema compiles the meta-schema. Building the instance at module load would
 * run that for every page that merely imports this package, so it happens on
 * the first `validateFormConfig` call instead.
 */
function getAjv(): any {
  if (!cachedAjv) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormatsFn(ajv);
    ajv.addSchema(unifiedFormSchema, SCHEMA_KEY);
    cachedAjv = ajv;
  }
  return cachedAjv;
}

export interface ValidationResult {
  valid: boolean;
  errors?: ErrorObject[];
  message?: string;
}

/**
 * Validates a unified form-config.json object against its schema.
 *
 * The first call builds an Ajv instance, which generates code with the
 * Function constructor: a browser page that calls this needs `'unsafe-eval'` in its
 * Content-Security-Policy. Importing the package, and every other export, does
 * not.
 */
export function validateFormConfig(data: unknown): ValidationResult {
  const validate = getAjv().getSchema(SCHEMA_KEY);
  if (!validate) {
    return { valid: false, message: "Could not load unified form schema" };
  }

  const valid = validate(data);
  return {
    valid: !!valid,
    errors: validate.errors || undefined,
  };
}

