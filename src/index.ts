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
