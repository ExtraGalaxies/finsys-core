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
