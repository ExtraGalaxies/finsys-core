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
 * Survey Generator - Converts unified form configurations into SurveyJS-compatible JSON
 *
 * This module converts a unified form-config.json into SurveyJS-compatible JSON,
 * resolving field references, applying dynamic titles, and grouping by category.
 */

// Re-export survey-core types for consumers
export type { IQuestion, IPage, ISurvey, IPanel, IElement } from "survey-core";
import { getPastMonthLabel, getPastYearLabel } from "./utils.js";

// ============ Unified Form Config Types ============

export interface Category {
  id: string;
  name: string;
}

export interface Choice {
  value: string;
  text: string;
}

export interface Validator {
  type: "regex" | "email" | "numeric" | "text" | "expression" | "answercount" | "custom";
  text?: string;
  regex?: string;
  minValue?: number;
  maxValue?: number;
  minLength?: number;
  maxLength?: number;
  minCount?: number;
  maxCount?: number;
  expression?: string;
  validator?: string; // For custom validator name
}

/**
 * FieldData - Field definition in the unified form config
 */
export interface FieldData {
  name?: string;  // Optional in fields{} (key is name), required in arrays
  displayName?: string;
  type: string;
  inputType?: "text" | "number" | "tel" | "date" | "email" | "password" | "url";
  category?: string;  // Category ID (strictly string)
  maxLength?: number | string;
  min?: number | string;
  max?: number | string;
  step?: number;
  html?: string;
  choices?: Choice[];
  validators?: Validator[];
  visible?: boolean;
  visibleIf?: string;
  required?: boolean;
  isRequired?: boolean;  // SurveyJS compat alias
  placeholder?: string;
  defaultValue?: string | number | boolean | string[];
  readOnly?: boolean;
  startWithNewLine?: boolean;
  enableIf?: string;
  titleLocation?: "default" | "top" | "bottom" | "left" | "hidden";
  // FinSys-specific fields
  ihs_column_names?: string[];
  requiredForEvaluation?: boolean;
  [key: string]: unknown;
}

/**
 * FieldReference - How fields are referenced in pages
 */
export type FieldReference = 
  | string  // Simple field name reference
  | { ref: string; [key: string]: unknown }  // Reference with overrides
  | { definition: FieldData & { name: string } };  // Inline definition

export interface PageConfig {
  id: string;
  title?: string;
  description?: string;
  showTOC?: boolean;
  showProgressBar?: boolean;
  showCategoryHeadings?: boolean;
  layout?: "default" | "grid" | "vertical";
  fields: FieldReference[];
}

/**
 * UnifiedFormConfig - The main configuration type for the unified form format
 */
export interface UnifiedFormConfig {
  $schema?: string;
  schemaVersion?: string;
  displayName?: string;
  templateIcon?: string;  // Icon identifier for form template editors
  categories: Category[];
  fields: Record<string, FieldData>;
  pages?: PageConfig[];  // Optional when used in editor-only mode (no rendered form)
}


// ============ Output Types (SurveyJS JSON compatible) ============

export interface SurveyElementJSON {
  type: string;
  name: string;
  title?: string;
  isRequired?: boolean;
  maxLength?: number;
  storeDataAsText?: boolean;
  category?: string;
  [key: string]: unknown;
}

export interface SurveyPageJSON {
  name: string;
  title: string;
  elements: Array<{
    type: string;
    name: string;
    elements: SurveyElementJSON[];
  }>;
}

export interface SurveyJSON {
  title: string;
  logoPosition?: string;
  pages: SurveyPageJSON[];
  showQuestionNumbers?: string;
  questionErrorLocation?: string;
  completedHtml?: string;
  showTOC?: boolean;
  completeText?: string;
  showPreviewBeforeComplete?: string;
  showProgressBar?: string;
  widthMode?: string;
  width?: string;
}

// ============ Helper Types ============

export interface ResolvedField extends FieldData {
  name: string;
}

/**
 * Normalize a field to ensure backward compatibility
 * - Sets both `required` and `isRequired` to the same value
 */
function normalizeField(field: ResolvedField): ResolvedField {
  // Spec: Fields are required by default unless explicitly false
  const isRequired = field.isRequired !== false && field.required !== false;
  return {
    ...field,
    required: isRequired,
    isRequired: isRequired
  };
}

/**
 * Resolve a field reference to a full field definition
 */
function resolveFieldReference(
  ref: FieldReference, 
  fields: Record<string, FieldData>
): ResolvedField | null {
  if (typeof ref === "string") {
    // Simple string reference
    const fieldDef = fields[ref];
    if (!fieldDef) {
      console.warn(`Field "${ref}" not found in fields definition`);
      return null;
    }
    return normalizeField({ name: ref, ...fieldDef });
  }
  
  if ("definition" in ref) {
    // Inline definition
    return normalizeField(ref.definition as ResolvedField);
  }
  
  if ("ref" in ref) {
    // Reference with overrides
    const fieldDef = fields[ref.ref];
    if (!fieldDef) {
      console.warn(`Field "${ref.ref}" not found in fields definition`);
      return null;
    }
    const { ref: fieldName, ...overrides } = ref;
    return normalizeField({ name: fieldName, ...fieldDef, ...overrides });
  }
  
  return null;
}

/**
 * Apply dynamic title logic (e.g., bank statements with dynamic month labels,
 * financial statements with dynamic year labels)
 */
export function applyDynamicTitles(field: ResolvedField): ResolvedField {
  const bankStatementMatch = field.name.match(/^bank_statement_t(\d+)$/);
  if (bankStatementMatch) {
    const monthsAgo = parseInt(bankStatementMatch[1], 10);
    return {
      ...field,
      displayName: `Bank Statement (${getPastMonthLabel(monthsAgo)})`
    };
  }
  if (field.name === "financials") {
    return {
      ...field,
      displayName: `Audited Financial Statement (${getPastYearLabel(1)})`
    };
  }
  return field;
}

/**
 * Generate SurveyJS JSON from unified form config
 */
export function generateSurveyJson(config: UnifiedFormConfig): SurveyJSON | Record<string, never> {
  if (!config.pages || config.pages.length === 0) return {};
  
  const firstPage = config.pages.find(p => p.id !== "success-message");
  if (!firstPage) return {};

  const categories = config.categories || [];
  const categoryMap: Record<string, string> = categories.reduce((acc, cat) => {
    acc[cat.id] = cat.name;
    return acc;
  }, {} as Record<string, string>);

  // Process all fields from the first page
  const processedFields = firstPage.fields
    .map(ref => resolveFieldReference(ref, config.fields))
    .filter((f): f is ResolvedField => f !== null)
    .map(f => applyDynamicTitles(f))
    .map(f => mapFieldToSurveyJS(f));

  // Group by Category
  const grouped = processedFields.reduce((acc: Record<string, SurveyElementJSON[]>, field) => {
    const catName = categoryMap[field.category as string] || "Default";
    if (!acc[catName]) acc[catName] = [];
    acc[catName].push(field);
    return acc;
  }, {} as Record<string, SurveyElementJSON[]>);

  // Build Pages (One Page per Category for Wizard effect)
  const pages: SurveyPageJSON[] = Object.entries(grouped).map(([categoryName, elements]) => ({
    name: categoryName.toLowerCase().replace(/\s+/g, "-"),
    title: firstPage.showCategoryHeadings === false ? "" : categoryName,
    elements: [
      {
        type: "panel",
        name: `${categoryName.toLowerCase().replace(/\s+/g, "-")}-panel`,
        elements: elements,
      },
    ],
  }));

  return {
    title: config.displayName || "Flexible Financing Program",
    logoPosition: "right",
    pages,
    showQuestionNumbers: "off",
    questionErrorLocation: "bottom",
    completedHtml: "<h3>Thank you for completing the form</h3>",
    showTOC: firstPage.showTOC ?? true,
    completeText: "Submit",
    showPreviewBeforeComplete: "showAllQuestions",
    showProgressBar: firstPage.showProgressBar === false ? "off" : "top",
    widthMode: "responsive",
    width: "100%",
  };
}

/**
 * Map a field definition to SurveyJS element format
 */
function mapFieldToSurveyJS(field: ResolvedField): SurveyElementJSON {
  const element: SurveyElementJSON = {
    type: field.type,
    name: field.name,
    ...(field.displayName && { title: field.displayName }),
    isRequired: field.isRequired ?? field.required ?? false,
    ...(field.maxLength && { maxLength: Number(field.maxLength) }),
  };

  if (field.type === "file") {
    element.storeDataAsText = false;
  }

  // Copy other properties
  const excludeKeys = ["displayName", "required", "category"];
  Object.keys(field).forEach((key) => {
    if (!(key in element) && !excludeKeys.includes(key) && field[key] !== undefined) {
      element[key] = field[key];
    }
  });

  // Store category for grouping
  element.category = field.category ?? "";

  return element;
}

/**
 * Resolve all fields from a page to full field definitions
 */
export function resolvePageFields(
  page: PageConfig,
  fields: Record<string, FieldData>
): ResolvedField[] {
  return page.fields
    .map(ref => resolveFieldReference(ref, fields))
    .filter((f): f is ResolvedField => f !== null)
    .map(f => applyDynamicTitles(f));
}

/**
 * Get category name from category ID (supports string or number IDs)
 */
export function getCategoryName(
  categoryId: string | undefined,
  categories: Category[]
): string {
  if (categoryId === undefined) return "Other";
  const cat = categories.find(c => c.id === categoryId);
  return cat?.name || "Other";
}

/**
 * Group fields by their category, maintaining order and creating section breaks
 */
export interface FieldGroup {
  category: string;
  categoryName: string;
  fields: ResolvedField[];
}

export function groupFieldsByCategory(
  fields: ResolvedField[],
  categories: Category[]
): FieldGroup[] {
  const groups: FieldGroup[] = [];
  let currentGroup: FieldGroup | null = null;

  for (const field of fields) {
    const category = field.category ?? "";
    
    if (!currentGroup || currentGroup.category !== category) {
      currentGroup = {
        category,
        categoryName: getCategoryName(category, categories),
        fields: []
      };
      groups.push(currentGroup);
    }
    
    currentGroup.fields.push(field);
  }

  return groups;
}
