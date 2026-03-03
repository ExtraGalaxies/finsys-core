import type { Validator } from "./survey-generator.js";
import type { EditorValidator } from "./form-field.js";

export interface FormValidatorDefinitions {
  options: EditorValidator[];
  version: number;
}

export class FormFieldValidator implements EditorValidator {
  id: number;
  displayName: string;
  class: string;
  description: string;
  isRequired: boolean;
  validators: Validator[];

  constructor(validatorData: EditorValidator) {
    this.id = validatorData.id;
    this.displayName = validatorData.displayName;
    this.class = validatorData.class;
    this.description = validatorData.description;
    this.isRequired = validatorData.isRequired;
    this.validators = validatorData.validators;
  }

  validate(value: any): boolean {
    for (const validator of this.validators) {
      switch (validator.type) {
        case 'numeric':
          if (!this.validateNumeric(value, validator.minValue, validator.maxValue)) {
            return false;
          }
          break;
        case 'text':
          if (!this.validateText(value, validator.minLength, validator.maxLength)) {
            return false;
          }
          break;
      }
    }
    return true;
  }

  private validateNumeric(value: number, min?: number, max?: number): boolean {
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
  }

  private validateText(value: string, minLength?: number, maxLength?: number): boolean {
    if (minLength !== undefined && value.length < minLength) return false;
    if (maxLength !== undefined && value.length > maxLength) return false;
    return true;
  }
}
