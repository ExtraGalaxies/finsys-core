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

export { validateFormConfig } from "./validator.js";

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

// Form domain classes
export { FormSpec } from "./form-spec.js";

// SYS-3263: the jurisdiction registry. Shared contract — finsys-api's own
// copy (src/domain/constants/jurisdiction.ts, SYS-2872) should import from
// here rather than keep its own; that de-duplication is SYS-3258's.
export {
  JURISDICTION,
  DEFAULT_JURISDICTION,
  JURISDICTION_CODES,
  isJurisdiction,
  resolveJurisdiction,
  checkJurisdictionCompatibility,
  describeIncompatibility,
  IncompatibilityReason,
  type Jurisdiction,
  type JurisdictionCompatibility,
} from "./jurisdiction.js";
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
  // SYS-3334: the instance-shaped path — same output types, fed by a CanonicalView
  processIhsDetailsFromView,
  documentCategoryIds,
  extractionCategoryOf,
  buildDocumentRowsFromView,
  documentsOfType,
  documentHashOfKey,
  documentHashOfPath,
  legacyOrdinalOfKey,
  // SYS-3334: buildFileFieldTables's instance-shaped sibling — the fourth
  // and last flat file-field function to get one.
  instanceRowsFromView,
  buildFileFieldTablesFromView,
  // SYS-3334 F3 (round 2 review): the provenance synthesis hoisted out of
  // buildFileFieldTablesFromView — collision-aware, and usable on its own.
  fieldProvenanceFromView,
  // SYS-3334: the v1-shape bridge — the migration map run FORWARD (v1 key ->
  // address -> value), so a consumer walking every flat key (an evaluation
  // data factory, MatchingUtil, jurisdictionOf, the SSM panel) reads a
  // CanonicalView through one map instead of each growing its own reverse walk.
  flatRecordFromView,
  APPLICATION_RECORD_CURRENCY_FIELDS,
  registryMoneyLegacyNames,
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
export {
  JURISDICTION_DISPLAY_CURRENCY,
  JURISDICTION_NATIONAL_ID_ENCODES_BIRTH_DATE,
  NO_JURISDICTION_BASIS,
  nationalIdEncodesBirthDate,
  resolveDisplayCurrency,
} from './jurisdiction.js'
export { formatMoney } from './ihs-processing.js'
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
  resolveExtractionStatusFromView,
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
  // SYS-3334 F3 (round 2 review): IhsFieldProvenance + the overlay-replaced
  // value, for fieldProvenanceFromView's return shape.
  IhsFieldProvenanceWithOriginal,
  DocumentRow,
  DocumentRowCapabilities,
  DocumentFileMetadata,
  InstanceRow,
} from './ihs-types.js'

export type { CategorySpec } from './ihs-processing.js'

// SYS-3174: the shape of one entry inside a document-pointer field. Exported
// so the host can name what it is attesting as `document-intake` rows rather
// than declaring a private copy of it.
export type { ParsedDocFile } from './ihs-processing.js'

// SYS-3334: the v1-shape bridge's own types — the record half of the v2 read
// pair (structural, so core need not import the SDK) and its return shape.
export type { ApplicationRecordLike, FlatRecordFromView } from './ihs-processing.js'
// SYS-3438: `ViewDocument` (documentsOfType's return type) was declared and
// documented as exported in 8.1.0 and never added here — TS2459 for consumers.
export type { ViewDocument } from './ihs-processing.js'

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
  resolveCanonicalFieldName,
  resolveCanonicalCategoryId,
  isLegacyCategoryId,
  isFieldSensitive,
  sensitiveFieldsOf,
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
  ExternalAssertionImplementation,
  FieldAuthorization,
  FieldMapEntry,
  PeriodDeclaration,
} from './adapter-manifest.js'

// SYS-3036: execution-mode classification, published so every host
// classifies manifests identically instead of re-deriving the switch.
export { AdapterExecutionMode, executionModeOf } from './adapter-manifest.js'

// SYS-3414: where every v1 flat-IHS key goes in v2 — including the ones with
// no destination, which is the half a rename table omits and the half that
// loses data. A migration instrument, not a runtime shim.
export type {
  V1Disposition,
  V1ResolutionSource,
  V1Address,
  V1MigrationEntry,
} from './v1-migration-map.js';

export {
  V1_MIGRATION_MAP_VERSION,
  v1MigrationKeys,
  v1MigrationEntry,
  v1Addresses,
  v1KeysByDisposition,
  v1KeyForAddress,
  v1AddressHasKeyedEntries,
  v1LegacyBaseNameOf,
} from './v1-migration-map.js';

// SYS-3334: the v2 canonical envelope. Owned here rather than in the lender
// SDK, because it is the wire shape of a published API and every consumer
// needs it — finhub through its own gateway, FHD's portal later, not only
// external lenders holding @finsys/lender-client (which re-exports these).
export type {
  CanonicalFieldEnvelope,
  // SYS-3421: declared in 8.1.0's first candidate but left out of this list —
  // finsys-api's resolver found it (TS2305) and had to mirror the interface
  // locally. Every member of the envelope is exported, or the wire shape is
  // not owned here at all.
  CanonicalAttestation,
  CanonicalInstance,
  CanonicalCategory,
  CanonicalView,
  CanonicalAddress,
} from './canonical-view.js';
