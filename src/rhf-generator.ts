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

import { z } from "zod";
import {
  type UnifiedFormConfig,
  type PageConfig,
  type FieldData,
  type FieldReference,
  type ResolvedField,
  type Category,
  resolvePageFields,
  groupFieldsByCategory,
  applyDynamicTitles,
  type FieldGroup
} from "./survey-generator.js";
import { evaluateExpression } from "./utils.js";

export interface RHFStep {
  id: number;
  title: string;
  description?: string;
  fields: ResolvedField[];
  showCategoryHeadings: boolean;
  layout?: "default" | "grid" | "vertical";
}

export interface RHFSchemaOutput {
  zodSchema: z.ZodTypeAny; // Can be ZodEffects
  baseSchema: z.ZodObject<any>;
  defaultValues: Record<string, any>;
  fields: ResolvedField[];
  groupedFields: FieldGroup[];
  steps: RHFStep[];
  displayName: string;
  categories: Category[];
  templateIcon?: string;
}

/**
 * Apply visibility-aware validation to a Zod schema
 */
function applyVisibilityValidation(
  baseObject: z.ZodObject<any>, 
  fields: ResolvedField[]
): z.ZodTypeAny {
  return baseObject.superRefine((data, ctx) => {
    fields.forEach((field) => {
      const isRequired = field.isRequired !== false && field.required !== false && field.type !== "html";
      if (!isRequired) return;

      // Determine Visibility
      let isVisible = field.visible !== false;
      if (isVisible && field.visibleIf) {
        isVisible = evaluateExpression(field.visibleIf, data);
      }

      if (isVisible) {
        const value = data[field.name];
        const isEmpty = 
          value === undefined || 
          value === null || 
          value === "" || 
          (Array.isArray(value) && value.length === 0);

        if (isEmpty) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "This field is required",
            path: [field.name],
          });
        }
      }
    });
  });
}

export function generateRHFSchema(config: UnifiedFormConfig): RHFSchemaOutput {
  // ... (existing logic for collecting fields/building shape)
  const pages = config.pages || [];
  const categories = config.categories || [];
  const fieldsMap = config.fields || {};

  if (pages.length === 0) {
    throw new Error("v2.0.0 templates must include a 'pages' configuration.");
  }

  // 1. Collect all fields from all pages
  const allFields: ResolvedField[] = [];
  
  for (const page of pages) {
    const pageFields = resolvePageFields(page, fieldsMap);
    allFields.push(...pageFields);
  }

  // Apply dynamic titles
  const mergedFields = allFields.map(applyDynamicTitles);

  // 2. Build Zod Shape & Default Values
  const shape: Record<string, z.ZodTypeAny> = {};
  const defaultValues: Record<string, any> = {};

  mergedFields.forEach((field) => {
    let schema: z.ZodTypeAny = z.string();

    // Track base type before validators/wrapping transform it via .refine()
    // (instanceof checks won't work after .refine() converts ZodString → ZodEffects)
    let baseType: "string" | "number" | "array" | "boolean" | "any" = "string";

    // --- Base Type Handling ---
    if (field.inputType === "number" || field.type === "number" || field.type === "slider" || field.type === "range") {
      schema = z.coerce.number();
      baseType = "number";
      defaultValues[field.name] = field.defaultValue !== undefined ? Number(field.defaultValue) : "";
    } else if (field.type === "checkbox") {
      schema = z.array(z.string());
      baseType = "array";
      defaultValues[field.name] = [];
    } else if (field.type === "file") {
      schema = z.array(z.any());
      baseType = "array";
      defaultValues[field.name] = [];
    } else if (field.type === "boolean") {
      schema = z.boolean();
      baseType = "boolean";
      defaultValues[field.name] = field.defaultValue ?? false;
    } else if (field.type === "html") {
      schema = z.any().optional();
      baseType = "any";
      defaultValues[field.name] = "";
    } else {
      if (Array.isArray(field.defaultValue)) {
        defaultValues[field.name] = field.defaultValue[0] || "";
      } else {
        defaultValues[field.name] = field.defaultValue ?? "";
      }
    }

    // --- Validation Constraints ---

    // Min/Max for Numbers
    if (baseType === "number" && schema instanceof z.ZodNumber) {
      let numSchema = schema;
      if (field.min !== undefined) numSchema = numSchema.min(Number(field.min), { message: `Minimum value is ${field.min}` });
      if (field.max !== undefined) numSchema = numSchema.max(Number(field.max), { message: `Maximum value is ${field.max}` });
      schema = numSchema;
    }

    const isRequired = field.isRequired !== false && field.required !== false && field.type !== "html";
    const isAlwaysVisible = field.visible !== false && !field.visibleIf;
    const isActuallyInput = field.type !== "html";

    // --- Required .min(1) for always-visible fields ---
    // Must be applied BEFORE validators (.refine) which change the schema type.
    if (isRequired && isAlwaysVisible && isActuallyInput) {
      if (baseType === "string" && schema instanceof z.ZodString) {
        schema = schema.min(1, { message: "This field is required" });
      } else if (baseType === "array" && schema instanceof z.ZodArray) {
        schema = schema.min(1, { message: "Please select at least one option" });
      }
    }

    // --- Enhancements: Validators ---
    // Applied BEFORE optional wrapping so instanceof checks still work on the
    // base type. The .refine() calls here will transform the schema to ZodEffects,
    // which is why we use baseType for subsequent decisions instead of instanceof.

    // Email
    const hasExplicitEmailValidator = field.validators?.some(v => v.type === "email");
    if ((field.inputType === "email" || field.name === "email") && baseType === "string" && schema instanceof z.ZodString && !hasExplicitEmailValidator) {
      schema = schema.refine(val => val === "" || z.string().email().safeParse(val).success, {
        message: "Invalid email address"
      });
    }

    // Legacy Validators (Regex / Numeric)
    if (field.validators) {
      field.validators.forEach((v) => {
        if (v.type === "regex" && v.regex) {
          try {
            const regex = new RegExp(v.regex);
            if (baseType === "string") {
              schema = schema.refine((val: any) => val === "" || regex.test(val), {
                message: v.text || "Invalid format"
              });
            }
          } catch (e) {
            console.warn(`Invalid regex pattern for field ${field.name}:`, v.regex);
          }
        }
        if (v.type === "email" && baseType === "string") {
          schema = schema.refine((val: any) => val === "" || z.string().email().safeParse(val).success, {
            message: v.text || "Invalid email"
          });
        }
        if (v.type === "numeric" && schema instanceof z.ZodNumber) {
          let numSchema = schema;
          if (v.minValue !== undefined) numSchema = numSchema.min(v.minValue, { message: v.text });
          if (v.maxValue !== undefined) numSchema = numSchema.max(v.maxValue, { message: v.text });
          schema = numSchema;
        }
      });
    }

    // --- Final Wrapper: Optional for conditional/hidden fields ---
    // Uses baseType instead of instanceof since validators may have transformed the schema.
    if (!(isRequired && isAlwaysVisible && isActuallyInput)) {
      if (baseType === "number") {
        schema = schema.optional().or(z.literal("")).or(z.null());
      } else if (baseType === "array") {
        schema = schema.optional();
      } else if (baseType === "boolean") {
        schema = schema.optional();
      } else if (baseType === "string") {
        schema = schema.optional().or(z.literal(""));
      }
    }

    shape[field.name] = schema;
  });

  // 3. Group Fields by Category
  const groupedFields = groupFieldsByCategory(mergedFields, categories);

  // 4. Build Steps (Dynamic Wizard)
  const steps: RHFStep[] = pages.map((page, idx) => {
    const pageFields = resolvePageFields(page, fieldsMap);

    return {
      id: idx,
      title: page.title || "",
      description: page.description,
      fields: pageFields,
      showCategoryHeadings: page.showCategoryHeadings ?? false,
      layout: page.layout
    };
  });

  // 5. Build Final Schema with Visibility-Aware Validation
  const baseObject = z.object(shape);
  const zodSchema = applyVisibilityValidation(baseObject, mergedFields);

  return {
    zodSchema,
    baseSchema: baseObject,
    defaultValues,
    fields: mergedFields,
    groupedFields,
    steps,
    displayName: config.displayName || "Application Form",
    categories,
    templateIcon: config.templateIcon
  };
}

/**
 * Get Zod schema for a specific step
 */
export function getStepSchema(step: RHFStep, fullSchema: any): z.ZodTypeAny {
  const stepFieldNames = step.fields.map(f => f.name);
  const stepShape: Record<string, z.ZodTypeAny> = {};
  
  // 1. Determine the base ZodObject
  let baseObj: z.ZodObject<any> | undefined;

  if (fullSchema instanceof z.ZodObject) {
    baseObj = fullSchema;
  } else if (fullSchema && typeof fullSchema === "object" && "baseSchema" in fullSchema) {
    baseObj = fullSchema.baseSchema as z.ZodObject<any>;
  } else if (fullSchema && "_def" in fullSchema && fullSchema._def.schema instanceof z.ZodObject) {
    // Basic Unwrap for ZodEffects
    baseObj = fullSchema._def.schema;
  }

  if (!baseObj) {
    console.warn("[RHF Generator] Could not extract ZodObject shape for step validation");
    return z.object({});
  }

  const shape = baseObj.shape;
  const stepFields: ResolvedField[] = [];
  
  stepFieldNames.forEach(name => {
    if (name in shape) {
      stepShape[name] = shape[name];
      // Keep track of which fields are in this step
      const fieldDef = step.fields.find(f => f.name === name);
      if (fieldDef) stepFields.push(fieldDef);
    }
  });
  
  const stepBaseObject = z.object(stepShape);
  return applyVisibilityValidation(stepBaseObject, stepFields);
}

/**
 * Extract default values for a specific step
 */
export function getStepDefaultValues(
  step: RHFStep, 
  allDefaults: Record<string, any>
): Record<string, any> {
  const stepDefaults: Record<string, any> = {};
  
  step.fields.forEach(field => {
    if (field.name in allDefaults) {
      stepDefaults[field.name] = allDefaults[field.name];
    }
  });
  
  return stepDefaults;
}
