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

// Form domain classes
export { FormSpec } from "./form-spec.js";
export { default as FormField, BasicFormField, FileFormField, FieldType } from "./form-field.js";
export type { FormFieldType, FormFieldInputType, FormFieldTypeDefinitions, DropdownOption, EditorValidator } from "./form-field.js";
export { FormFieldCategory } from "./form-field-category.js";
export { FormFieldValidator } from "./form-field-validator.js";
export type { FormValidatorDefinitions } from "./form-field-validator.js";

// Catalogs
export {
  BASE_FIELD_SPECS,
  DEFAULT_VALIDATOR_DEFINITIONS,
  FIELD_TYPE_DEFINITIONS,
  getBaseFieldSpecs,
  getBaseCategories,
  getBaseFieldNames,
  getBaseFieldSpecMap,
} from "./catalogs.js";

// IHS data processing
export {
  getDisplayNames,
  getDisplayName,
  getGroupDisplayNames,
  extractTimePeriods,
  groupColumnsByTimePeriod,
  groupColumnsByInstance,
  groupFieldsByPattern,
  buildFileFieldTables,
  buildFileFieldTablesFromInstances,
  processIhsDetails,
  groupDetailsByCategory,
  buildDocumentRows,
  parseFileField,
  getDocDisplayNames,
  getExtractableDocTypes,
  getReuploadableDocTypes,
  formatDocumentType,
  formatDocumentSize,
  formatDocumentUploaded,
} from './ihs-processing.js'

export { IhsValueFormat, FileFieldTableType, isValidIhsFieldOrigin, IHS_FIELD_ORIGINS } from './ihs-types.js'
export type { IhsFieldOrigin } from './ihs-types.js'

// Roles
export { Role } from './roles.js'

// Extraction
export { ExtractionJobStatus } from './extraction.js'
export type { ExtractionFileType } from './extraction.js'
export {
  getDocumentTypeGroups,
  isDocumentType,
  assertDocumentType,
} from './document-types.js'
export type { DocumentTypeGroup, WireFormat, TaggedFieldData, TimePeriodUnit } from './document-types.js'

// IHS status (canonical enum, mirrors finsys-api)
export {
  IhsStatus,
  IHS_VALID_STATUSES,
  IHS_TERMINAL_STATUSES,
  IHS_FAILURE_STATUSES,
  isValidIhsStatus,
  isTerminalIhsStatus,
  isFailureIhsStatus,
} from './ihs-status.js'

// Extraction status
export {
  resolveExtractionStatus,
  DocExtractionStatus,
} from './extraction-status.js'

export type {
  ExtractionJobRecord,
  DocExtractionResult,
  ExtractionStatusResult,
} from './extraction-status.js'

export type {
  IhsFieldDetail,
  IhsDetailCategory,
  FileFieldTableData,
  FileFieldTableItem,
  IhsFieldProvenance,
  DocumentRow,
  DocumentRowCapabilities,
  DocumentFileMetadata,
  InstanceRow,
} from './ihs-types.js'

export type { CategorySpec } from './ihs-processing.js'

// ── Source Adapter framework (SYS-2440) ──────────────────────────────
// The contract for ingesting unstructured / partner-specific data
// sources and producing canonical credit signals. Vendor-specific
// adapter implementations live OUTSIDE this open-source package, in
// private extension directories loaded by the host app at runtime.
// finsys-core publishes the contract + the category catalogue.

export type {
  RawPayload,
  CanonicalFieldValue,
  CanonicalFieldValues,
  AdapterExtraction,
  PeriodValues,
  SourceAdapter,
  AdapterErrorReason,
  ApplicantIdentity,
} from './adapter.js'

export { AdapterError } from './adapter.js'

export type { AggregationOp, InstanceValue } from './adapter-aggregation.js'
export { applyAggregation, ALL_AGGREGATION_OPS } from './adapter-aggregation.js'

export type {
  AdapterCategory,
  CanonicalFieldName,
  CanonicalFieldSpec,
  CategorySchema,
} from './adapter-categories.js'

// NB: `buildCategoryRegistry` + the `CategoryRegistry` shape are
// intentionally NOT re-exported here. They're the internal loader (and
// its return type, which carries mutable Maps that `ReadonlyMap` only
// guards at compile time). Keeping them out of the package's public API
// avoids exposing a corruptible view of the shared singleton registry.
// They remain module-exported for finsys-core's own tests. Promote to a
// public, defensively-immutable API only when a consumer (e.g. host-side
// category merging in a future phase) actually needs it.
export {
  ADAPTER_CATEGORY_IDS,
  categorySchemaOf,
  categoryFieldsOf,
  allCategories,
  categoryForField,
  factOf,
  categoriesAttestingFact,
  isAdapterCategory,
  assertAdapterCategory,
} from './adapter-categories.js'

export type {
  AdapterManifest,
  DeclarativeImplementation,
  TypescriptImplementation,
  FormIntakeImplementation,
  FormIntakeFieldMapEntry,
  ManualOverrideImplementation,
  ExtractionPipelineImplementation,
  FieldAuthorization,
  FieldMapEntry,
  PeriodDeclaration,
} from './adapter-manifest.js'
