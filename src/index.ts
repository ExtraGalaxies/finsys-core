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
 * @finsys/core
 * Convert unified form configurations into Zod schemas, React Hook Form defaults, and SurveyJS JSON
 */

// Functions
export {
  generateSurveyJson,
  resolvePageFields,
  getCategoryName,
  groupFieldsByCategory,
  applyDynamicTitles
} from "./survey-generator.js";

export { getPastMonthLabel, getPastYearLabel, evaluateExpression } from "./utils.js";

export { 
  generateRHFSchema,
  getStepSchema,
  getStepDefaultValues
} from "./rhf-generator.js";

export { validateFormConfig, validateFormSpec, validatePagesConfig } from "./validator.js";

// Unified Form Config types
export type {
  Category,
  Choice,
  Validator,
  FieldData,
  FieldReference,
  PageConfig,
  UnifiedFormConfig,
  ResolvedField,
  FieldGroup,
} from "./survey-generator.js";

// Output types (SurveyJS JSON compatible)
export type { SurveyElementJSON, SurveyPageJSON, SurveyJSON } from "./survey-generator.js";

// RHF Generator types
export type { RHFStep, RHFSchemaOutput } from "./rhf-generator.js";

// Re-export survey-core types for convenience
export type { IQuestion, IPage, ISurvey, IPanel, IElement } from "./survey-generator.js";
