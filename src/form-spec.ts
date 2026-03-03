import { FormFieldCategory } from "./form-field-category.js";
import FormField from "./form-field.js";
import type { FieldData, PageConfig, UnifiedFormConfig } from "./survey-generator.js";
import { validateFormConfig } from "./validator.js";
import semver from "semver";

export class FormSpec {
  private _categories: FormFieldCategory[] = [];
  private _fields: FormField[] = [];
  private _displayName: string;
  private _templateIcon?: string;
  private _schemaVersion: string;
  private _pages: PageConfig[] = [];

  constructor(
    displayName: string,
    categories: FormFieldCategory[],
    fields: FormField[],
    pages: PageConfig[] = [],
    templateIcon?: string,
    schemaVersion: string = FormSpec.MAX_PARSER_SCHEMA_VERSION
  ) {
    this._displayName = displayName;
    this._templateIcon = templateIcon;
    this._categories = categories;
    this._fields = fields;
    this._pages = pages;
    this._schemaVersion = schemaVersion;
  }

  static readonly MIN_PARSER_SCHEMA_VERSION = 'v1.0.0';
  static readonly MAX_PARSER_SCHEMA_VERSION = 'v2.0.0';

  get fieldNames(): string[] {
    let names: string[] = [];

    this.fields.forEach((field) => {
      names = names.concat(field.getFieldNames());
    });

    return names;
  }

  get schemaVersion(): string {
    return this._schemaVersion;
  }

  get requiresUpgrade(): boolean {
    return semver.lt(this._schemaVersion, FormSpec.MAX_PARSER_SCHEMA_VERSION);
  }

  upgradeToV2(): void {
    this._schemaVersion = FormSpec.MAX_PARSER_SCHEMA_VERSION;
  }

  get displayName(): string {
    return this._displayName;
  }

  set displayName(newDisplayName: string) {
    this._displayName = newDisplayName;
  }

  get templateIcon(): string | undefined {
    return this._templateIcon;
  }

  set templateIcon(value: string | undefined) {
    this._templateIcon = value;
  }

  get categories(): FormFieldCategory[] {
    return this._categories;
  }

  set categories(categories: FormFieldCategory[]) {
    this._categories = categories;
  }

  get fields(): FormField[] {
    return this._fields;
  }

  set fields(fields: FormField[]) {
    this._fields = fields;
  }

  get pages(): PageConfig[] {
    return this._pages;
  }

  set pages(value: PageConfig[]) {
    this._pages = value;
  }

  addField(field: FormField): void {
    this._fields.push(field);
  }

  updateField(field: FormField): void {
    const index = this._fields.findIndex((f) => f.name === field.name);
    if (index !== -1) {
      this._fields[index] = field;
    } else {
      throw new Error(
        `${field.name} not found. Form Spec of ${this._displayName} cannot update ${field.name}`
      );
    }
  }

  removeField(fieldName: string): void {
    const fieldIndex = this._fields.findIndex((f) => f.name === fieldName);
    if (fieldIndex !== -1) {
      this._fields.splice(fieldIndex, 1);

      this._pages.forEach((page) => {
        page.fields = page.fields.filter((fieldRef) => {
          let refName: string | undefined;
          if (typeof fieldRef === 'string') {
            refName = fieldRef;
          } else if ('ref' in fieldRef) {
            refName = fieldRef.ref;
          } else if ('definition' in fieldRef) {
            refName = fieldRef.definition.name;
          }
          return refName !== fieldName;
        });
      });
    }
  }

  getFieldsByCategory(categoryName: string): FormField[] {
    const foundCategory = this.categories.find((category) => category.name === categoryName);

    if (!foundCategory) {
      return [];
    }

    return this._fields.filter((field) => field.categoryId === foundCategory.id);
  }

  validate(): { valid: boolean; errors?: any[] } {
    const config = this.toJSON() as UnifiedFormConfig;
    const result = validateFormConfig(config);
    const errors: any[] = [];

    if (result.errors) {
      result.errors.forEach((err: any) => {
        let path = err.instancePath || err.dataPath || '';
        path = path.replace(/^\//, '').replace(/\//g, '.');
        const prefix = path ? `${path}: ` : '';
        errors.push({
          message: `${prefix}${err.message}`,
          path: path,
        });
      });
    }

    if (!this._displayName || this._displayName.trim() === '') {
      errors.push({
        message: 'displayName: Form display name is required',
        path: 'displayName',
      });
    }

    const categoryIds = new Set(this._categories.map((c) => String(c.id)));
    this._fields.forEach((field) => {
      if (field.categoryId && !categoryIds.has(String(field.categoryId))) {
        errors.push({
          message: `fields.${field.name}.category: references non-existent category '${field.categoryId}'`,
          path: `fields.${field.name}.category`,
        });
      }
    });

    const fieldNames = new Set(this._fields.map((f) => f.name));
    this._pages.forEach((page, pageIndex) => {
      page.fields.forEach((fieldRef, fieldIndex) => {
        let refName: string | undefined;
        if (typeof fieldRef === 'string') {
          refName = fieldRef;
        } else if (fieldRef && (fieldRef as any).ref) {
          refName = (fieldRef as any).ref;
        } else if (fieldRef && (fieldRef as any).definition) {
          refName = (fieldRef as any).definition.name;
        }

        if (refName && !fieldNames.has(refName)) {
          errors.push({
            message: `pages.${pageIndex}.fields.${fieldIndex}: references non-existent field '${refName}'`,
            path: `pages.${pageIndex}.fields.${fieldIndex}`,
          });
        }
      });
    });

    return {
      valid: result.valid && errors.length === (result.errors?.length || 0),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private cleanObject(obj: any): any {
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

  toJSON(): object {
    const fieldsMap: Record<string, any> = {};
    this._fields.forEach((field) => {
      fieldsMap[field.name] = field.toJSON();
      delete fieldsMap[field.name].name;
    });

    return this.cleanObject({
      $schema:
        '../../../node_modules/@finsys/core/dist/schema/unified-form.schema.json',
      schemaVersion: this._schemaVersion,
      displayName: this._displayName,
      templateIcon: this._templateIcon,
      categories: this._categories,
      fields: fieldsMap,
      pages: this._pages,
    });
  }

  static fromJSON(jsonString: string): FormSpec {
    let jsonData: any;
    try {
      jsonData = JSON.parse(jsonString);
    } catch (error) {
      console.error(`Error parsing JSON for Loantype with string: ${jsonString}`);
      throw error;
    }

    if (!jsonData.schemaVersion) {
      throw new Error('Invalid JSON: schemaVersion is missing or invalid');
    }

    if (semver.lt(jsonData.schemaVersion, FormSpec.MIN_PARSER_SCHEMA_VERSION)) {
      throw new Error(
        `This form spec file is using an outdated schema version ${jsonData.schemaVersion}. Minimum supported version is ${FormSpec.MIN_PARSER_SCHEMA_VERSION}`
      );
    }

    if (!jsonData.displayName) {
      throw new Error('Invalid JSON: displayName is missing or invalid');
    }

    if (!jsonData.categories) {
      throw new Error('Invalid JSON: categories is missing or invalid');
    }

    if (!jsonData.fields) {
      throw new Error('Invalid JSON: fields is missing or invalid');
    }

    if (!jsonData.pages || jsonData.pages.length === 0) {
      if (semver.satisfies(jsonData.schemaVersion, '>=2.0.0')) {
        console.warn(
          `v2.0.0 template ${jsonData.displayName} is missing pages. Generating default pages.`
        );
      }
    }

    let fieldObjects: FieldData[] = [];
    if (Array.isArray(jsonData.fields)) {
      fieldObjects = jsonData.fields;
    } else if (typeof jsonData.fields === 'object' && jsonData.fields !== null) {
      fieldObjects = Object.entries(jsonData.fields).map(([name, data]: [string, any]) => {
        return {
          name,
          ...data,
        };
      });
    }

    fieldObjects.forEach((f: any) => {
      if (f.categoryId && !f.category) {
        f.category = String(f.categoryId);
      } else if (f.category) {
        f.category = String(f.category);
      }
    });

    const categories = (jsonData.categories || []).map((cat: any) => {
      return new FormFieldCategory(String(cat.id), cat.name);
    });

    const fields: FormField[] = fieldObjects.map((fieldObject) => {
      return FormField.fromObject(fieldObject);
    });

    let pages = jsonData.pages || [];
    if (pages.length === 0) {
      const categoriesMap: Record<string, string[]> = {};
      fields.forEach((f) => {
        const catId = f.categoryId;
        if (!categoriesMap[catId]) {
          categoriesMap[catId] = [];
        }
        categoriesMap[catId].push(f.name);
      });

      pages = categories
        .map((cat: FormFieldCategory) => ({
          id: `page-${cat.id}`,
          title: cat.name,
          fields: categoriesMap[cat.id] || [],
        }))
        .filter((p: PageConfig) => p.fields.length > 0);
    }

    return new FormSpec(
      jsonData.displayName,
      categories,
      fields,
      pages,
      jsonData.templateIcon,
      jsonData.schemaVersion
    );
  }
}
