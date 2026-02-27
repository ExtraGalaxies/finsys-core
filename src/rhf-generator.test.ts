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

import { describe, it, expect } from 'vitest';
import { generateRHFSchema, getStepSchema, getStepDefaultValues } from './rhf-generator.js';
import { type UnifiedFormConfig, type ResolvedField } from './survey-generator.js';

describe('rhf-generator', () => {
  const mockConfig: UnifiedFormConfig = {
    displayName: 'Test Loan',
    categories: [{ id: 'general', name: 'General' }],
    fields: {
      carPrice: {
        type: 'text',
        inputType: 'number',
        displayName: 'Car Price',
        category: 'general',
        min: 1000,
        max: 500000
      },
      fullName: {
        type: 'text',
        displayName: 'Full Name',
        category: 'general',
        required: true,
        validators: [
          { type: 'regex', regex: '^[A-Za-z ]+$', text: 'Alpha only' }
        ]
      }
    },
    pages: [
      {
        id: 'step1',
        title: 'Step 1',
        fields: ['carPrice', 'fullName']
      }
    ]
  };

  it('should generate required schemas by default', () => {
    const { baseSchema } = generateRHFSchema(mockConfig);
    const shape = baseSchema.shape;

    // carPrice is required by default (even if not explicitly required: true in config)
    const result = shape.carPrice.safeParse(undefined);
    expect(result.success).toBe(false);
  });

  it('should generate required schemas when required is true', () => {
    const { baseSchema } = generateRHFSchema(mockConfig);
    const shape = baseSchema.shape;

    // fullName is required
    const result = shape.fullName.safeParse('');
    expect(result.success).toBe(false);
  });

  it('should apply numeric constraints (min/max) even to fields', () => {
    const { baseSchema } = generateRHFSchema(mockConfig);
    const shape = baseSchema.shape;

    // Below min (1000) should fail if provided
    const lowPrice = shape.carPrice.safeParse(500);
    expect(lowPrice.success).toBe(false);

    // Valid price should pass
    const validPrice = shape.carPrice.safeParse(5000);
    expect(validPrice.success).toBe(true);
  });

  it('should apply regex validation correctly', () => {
    const { baseSchema } = generateRHFSchema(mockConfig);
    const shape = baseSchema.shape;

    // Invalid format (numbers)
    const invalid = shape.fullName.safeParse('John123');
    expect(invalid.success).toBe(false);

    // Valid format
    const valid = shape.fullName.safeParse('John Doe');
    expect(valid.success).toBe(true);
  });

  it('should correctly build multi-step wizard categories', () => {
    const multiPageConfig: UnifiedFormConfig = {
      displayName: 'Multi Page Test',
      categories: [{ id: 'general', name: 'General' }],
      fields: {
        carPrice: {
          type: 'text',
          inputType: 'number',
          displayName: 'Car Price',
          category: 'general'
        },
        fullName: {
          type: 'text',
          displayName: 'Full Name',
          category: 'general',
          required: true
        }
      },
      pages: [
        { id: 'page1', title: 'First', fields: ['carPrice'] },
        { id: 'page2', title: 'Second', fields: ['fullName'] }
      ]
    };

    const { steps } = generateRHFSchema(multiPageConfig);
    
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('First');
    expect(steps[0].fields[0].name).toBe('carPrice');
    expect(steps[1].title).toBe('Second');
    expect(steps[1].fields[0].name).toBe('fullName');
  });

  it('should handle field references with overrides', () => {
    const configWithOverrides: UnifiedFormConfig = {
      displayName: 'Override Test',
      categories: [{ id: 'general', name: 'General' }],
      fields: {
        carPrice: {
          type: 'text',
          inputType: 'number',
          displayName: 'Car Price',
          category: 'general',
          min: 1000
        }
      },
      pages: [
        {
          id: 'page1',
          title: 'Test',
          fields: [
            { ref: 'carPrice', displayName: 'Vehicle Price (Override)', min: 5000 }
          ]
        }
      ]
    };

    const { fields } = generateRHFSchema(configWithOverrides);
    
    expect(fields[0].displayName).toBe('Vehicle Price (Override)');
    expect(fields[0].min).toBe(5000);
  });

  it('should normalize required and isRequired properties', () => {
    const { fields } = generateRHFSchema(mockConfig);
    
    // fullName has required: true, should also have isRequired: true
    const fullNameField = fields.find((f: ResolvedField) => f.name === 'fullName');
    expect(fullNameField?.required).toBe(true);
    expect(fullNameField?.isRequired).toBe(true);
    
    // carPrice is also required by default in the new logic
    const carPriceField = fields.find((f: ResolvedField) => f.name === 'carPrice');
    expect(carPriceField?.required).toBe(true);
    expect(carPriceField?.isRequired).toBe(true);
  });

  describe('Visibility-Aware Validation (superRefine)', () => {
    it('should NOT require a field if it is hidden via visibleIf', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Conditional Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          showField: { type: 'boolean', displayName: 'Show Secret', category: 'general' },
          secretField: { 
            type: 'text', 
            displayName: 'Secret', 
            category: 'general', 
            required: true, 
            visibleIf: '{showField} = true' 
          }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['showField', 'secretField'] }]
      };

      const { zodSchema } = generateRHFSchema(config);

      // Scenario A: showField is false, secretField is hidden. Validation should PASS even if empty.
      const passResult = zodSchema.safeParse({ showField: false, secretField: '' });
      expect(passResult.success).toBe(true);

      // Scenario B: showField is true, secretField is visible. Validation should FAIL if empty.
      const failResult = zodSchema.safeParse({ showField: true, secretField: '' });
      expect(failResult.success).toBe(false);
      if (!failResult.success) {
        expect(failResult.error.issues[0].message).toBe('This field is required');
      }
    });

    it('should NOT require a field if explicitly visible is false', () => {
        const config: UnifiedFormConfig = {
          displayName: 'Hidden Test',
          categories: [{ id: 'general', name: 'General' }],
          fields: {
            hiddenField: { type: 'text', displayName: 'Hidden', category: 'general', required: true, visible: false }
          },
          pages: [{ id: 'p1', title: 'P1', fields: ['hiddenField'] }]
        };
  
        const { zodSchema } = generateRHFSchema(config);
  
        // hiddenField is required but visible: false. Should pass.
        const result = zodSchema.safeParse({ hiddenField: '' });
        expect(result.success).toBe(true);
      });
  });

  describe('Validation Message Precedence', () => {
    it('should skip regex/email validation for empty strings to favor "required" message', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Precedence Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          email: {
            type: 'text',
            name: 'email',
            displayName: 'Email',
            category: 'general',
            required: true,
            validators: [{ type: 'email', text: 'Bad email' }]
          }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['email'] }]
      };

      const { zodSchema } = generateRHFSchema(config);

      // 1. Empty string -> should give "This field is required" (from baseSchema.min(1) or superRefine)
      // Actually, since it's required, we expect an error.
      const emptyResult = zodSchema.safeParse({ email: '' });
      expect(emptyResult.success).toBe(false);
      if (!emptyResult.success) {
        // ZodError structure check
        const issues = emptyResult.error.issues;
        expect(issues[0].message).toBe('This field is required');
      }

      // 2. Invalid format but not empty -> should give "Bad email"
      const invalidResult = zodSchema.safeParse({ email: 'not-an-email' });
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        const issues = invalidResult.error.issues;
        expect(issues[0].message).toBe('Bad email');
      }
    });
  });

  describe('Field type handling', () => {
    it('should handle file fields with array schema and empty array default', () => {
      const config: UnifiedFormConfig = {
        displayName: 'File Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          document: { type: 'file', displayName: 'Upload Document', category: 'general' }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['document'] }]
      };
      const { defaultValues, baseSchema } = generateRHFSchema(config);
      expect(defaultValues.document).toEqual([]);
      // File fields are required by default, so empty array fails base schema
      const emptyResult = baseSchema.shape.document.safeParse([]);
      expect(emptyResult.success).toBe(false);
      // With content, it passes
      const withFile = baseSchema.shape.document.safeParse([{ name: 'file.pdf' }]);
      expect(withFile.success).toBe(true);
    });

    it('should handle boolean fields with false default', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Boolean Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          agree: { type: 'boolean', displayName: 'Agree', category: 'general', required: false }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['agree'] }]
      };
      const { defaultValues } = generateRHFSchema(config);
      expect(defaultValues.agree).toBe(false);
    });

    it('should handle boolean fields with custom default', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Boolean Default Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          agree: { type: 'boolean', displayName: 'Agree', category: 'general', defaultValue: true }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['agree'] }]
      };
      const { defaultValues } = generateRHFSchema(config);
      expect(defaultValues.agree).toBe(true);
    });

    it('should handle checkbox fields with array schema and empty array default', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Checkbox Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          interests: {
            type: 'checkbox',
            displayName: 'Interests',
            category: 'general',
            choices: [
              { value: 'a', text: 'A' },
              { value: 'b', text: 'B' }
            ]
          }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['interests'] }]
      };
      const { defaultValues, baseSchema } = generateRHFSchema(config);
      expect(defaultValues.interests).toEqual([]);
      const result = baseSchema.shape.interests.safeParse(['a']);
      expect(result.success).toBe(true);
    });

    it('should handle html display fields as optional', () => {
      const config: UnifiedFormConfig = {
        displayName: 'HTML Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          notice: {
            type: 'html',
            displayName: 'Notice',
            category: 'general',
            html: '<p>Important notice</p>',
            required: true // even if required is true, html should be optional
          }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['notice'] }]
      };
      const { defaultValues, zodSchema } = generateRHFSchema(config);
      expect(defaultValues.notice).toBe('');
      // html fields should not cause validation failure
      const result = zodSchema.safeParse({ notice: '' });
      expect(result.success).toBe(true);
    });

    it('should set numeric field default to empty string when no defaultValue specified', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Numeric Default Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          amount: { type: 'text', inputType: 'number', displayName: 'Amount', category: 'general' }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['amount'] }]
      };
      const { defaultValues } = generateRHFSchema(config);
      // HTML number inputs return "" when empty; z.coerce.number() handles this correctly
      expect(defaultValues.amount).toBe("");
    });

    it('should set numeric field default to the provided value', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Numeric Default Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          amount: {
            type: 'text', inputType: 'number', displayName: 'Amount',
            category: 'general', defaultValue: 5000
          }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['amount'] }]
      };
      const { defaultValues } = generateRHFSchema(config);
      expect(defaultValues.amount).toBe(5000);
    });

    it('should handle explicitly optional fields', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Optional Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          nickname: { type: 'text', displayName: 'Nickname', category: 'general', required: false }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['nickname'] }]
      };
      const { baseSchema } = generateRHFSchema(config);
      // Optional text field should accept empty string
      const result = baseSchema.shape.nickname.safeParse('');
      expect(result.success).toBe(true);
    });

    it('should use first element when defaultValue is an array for text fields', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Array Default Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          country: {
            type: 'dropdown',
            displayName: 'Country',
            category: 'general',
            defaultValue: ['US', 'UK']
          }
        },
        pages: [{ id: 'p1', title: 'P1', fields: ['country'] }]
      };
      const { defaultValues } = generateRHFSchema(config);
      expect(defaultValues.country).toBe('US');
    });
  });

  describe('Validators on conditional fields', () => {
    it('should apply regex validators to fields with visibleIf', () => {
      const config: UnifiedFormConfig = {
        displayName: 'IC Validation Test',
        categories: [{ id: 'customer', name: 'Customer' }],
        fields: {
          idType: {
            type: 'dropdown',
            displayName: 'ID Type',
            category: 'customer',
            choices: [
              { value: 'MK', text: 'MyKad' },
              { value: 'MI', text: 'Military' }
            ]
          },
          idNumber_mk: {
            type: 'text',
            displayName: 'IC Number',
            category: 'customer',
            required: true,
            visibleIf: "{idType} == 'MK'",
            maxLength: 12,
            validators: [
              { type: 'regex', regex: '^\\d{12}$', text: 'Please enter exactly 12 digit numbers' }
            ]
          }
        },
        pages: [{ id: 'p1', title: 'Info', fields: ['idType', 'idNumber_mk'] }]
      };

      const { zodSchema } = generateRHFSchema(config);

      // When visible (idType=MK) and valid IC number -> pass
      const validResult = zodSchema.safeParse({ idType: 'MK', idNumber_mk: '700514065413' });
      expect(validResult.success).toBe(true);

      // When visible (idType=MK) and invalid IC number -> fail with regex message
      const invalidResult = zodSchema.safeParse({ idType: 'MK', idNumber_mk: 'abc123' });
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        const icIssue = invalidResult.error.issues.find(i => i.path.includes('idNumber_mk'));
        expect(icIssue?.message).toBe('Please enter exactly 12 digit numbers');
      }

      // When hidden (idType=MI) and empty -> pass (not validated)
      const hiddenResult = zodSchema.safeParse({ idType: 'MI', idNumber_mk: '' });
      expect(hiddenResult.success).toBe(true);
    });

    it('should apply email validators to fields with visibleIf', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Conditional Email Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          showEmail: { type: 'boolean', displayName: 'Show Email', category: 'general' },
          contactEmail: {
            type: 'text',
            inputType: 'email',
            displayName: 'Contact Email',
            category: 'general',
            required: true,
            visibleIf: '{showEmail} = true',
            validators: [{ type: 'email', text: 'Invalid email format' }]
          }
        },
        pages: [{ id: 'p1', title: 'Test', fields: ['showEmail', 'contactEmail'] }]
      };

      const { zodSchema } = generateRHFSchema(config);

      // Visible + invalid email -> fail
      const invalidResult = zodSchema.safeParse({ showEmail: true, contactEmail: 'not-email' });
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        const emailIssue = invalidResult.error.issues.find(i => i.path.includes('contactEmail'));
        expect(emailIssue?.message).toBe('Invalid email format');
      }

      // Visible + valid email -> pass
      const validResult = zodSchema.safeParse({ showEmail: true, contactEmail: 'test@example.com' });
      expect(validResult.success).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should throw when config has no pages', () => {
      const config: UnifiedFormConfig = {
        displayName: 'No Pages',
        categories: [{ id: 'general', name: 'General' }],
        fields: { name: { type: 'text' } },
        pages: []
      };
      expect(() => generateRHFSchema(config)).toThrow("v2.0.0 templates must include a 'pages' configuration.");
    });
  });

  describe('getStepSchema', () => {
    it('should extract schema for a specific step from ZodEffects', () => {
      const multiPageConfig: UnifiedFormConfig = {
        displayName: 'Step Schema Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          name: { type: 'text', displayName: 'Name', category: 'general' },
          age: { type: 'text', inputType: 'number', displayName: 'Age', category: 'general', min: 0 }
        },
        pages: [
          { id: 'p1', title: 'Personal', fields: ['name'] },
          { id: 'p2', title: 'Details', fields: ['age'] }
        ]
      };
      const result = generateRHFSchema(multiPageConfig);

      const step1Schema = getStepSchema(result.steps[0], result.zodSchema);
      // Step 1 only has "name"
      const step1Pass = step1Schema.safeParse({ name: 'John' });
      expect(step1Pass.success).toBe(true);

      // Step 1 should not care about "age"
      const step1NoAge = step1Schema.safeParse({ name: 'John' });
      expect(step1NoAge.success).toBe(true);
    });

    it('should accept baseSchema directly', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Step Schema Direct',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          name: { type: 'text', displayName: 'Name', category: 'general' }
        },
        pages: [{ id: 'p1', title: 'Test', fields: ['name'] }]
      };
      const result = generateRHFSchema(config);
      const stepSchema = getStepSchema(result.steps[0], result.baseSchema);
      const parsed = stepSchema.safeParse({ name: 'Alice' });
      expect(parsed.success).toBe(true);
    });

    it('should accept { baseSchema } wrapper object', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Step Schema Wrapper',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          name: { type: 'text', displayName: 'Name', category: 'general' }
        },
        pages: [{ id: 'p1', title: 'Test', fields: ['name'] }]
      };
      const result = generateRHFSchema(config);
      const stepSchema = getStepSchema(result.steps[0], { baseSchema: result.baseSchema });
      const parsed = stepSchema.safeParse({ name: 'Bob' });
      expect(parsed.success).toBe(true);
    });
  });

  describe('getStepDefaultValues', () => {
    it('should extract defaults for fields in a specific step', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Step Defaults Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          name: { type: 'text', displayName: 'Name', category: 'general', defaultValue: 'John' },
          age: { type: 'text', inputType: 'number', displayName: 'Age', category: 'general', defaultValue: 25 }
        },
        pages: [
          { id: 'p1', title: 'Personal', fields: ['name'] },
          { id: 'p2', title: 'Details', fields: ['age'] }
        ]
      };
      const result = generateRHFSchema(config);

      const step1Defaults = getStepDefaultValues(result.steps[0], result.defaultValues);
      expect(step1Defaults).toEqual({ name: 'John' });
      expect(step1Defaults).not.toHaveProperty('age');

      const step2Defaults = getStepDefaultValues(result.steps[1], result.defaultValues);
      expect(step2Defaults).toEqual({ age: 25 });
      expect(step2Defaults).not.toHaveProperty('name');
    });

    it('should return empty object for step with no matching defaults', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Empty Defaults Test',
        categories: [{ id: 'general', name: 'General' }],
        fields: {
          name: { type: 'text', displayName: 'Name', category: 'general' }
        },
        pages: [{ id: 'p1', title: 'Test', fields: ['name'] }]
      };
      const result = generateRHFSchema(config);
      // Pass empty allDefaults
      const stepDefaults = getStepDefaultValues(result.steps[0], {});
      expect(stepDefaults).toEqual({});
    });
  });

  describe('Dynamic titles', () => {
    it('should apply dynamic bank statement titles', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Bank Statement Test',
        categories: [{ id: 'docs', name: 'Documents' }],
        fields: {
          bank_statement_t1: { type: 'file', displayName: 'Statement', category: 'docs' },
          bank_statement_t2: { type: 'file', displayName: 'Statement', category: 'docs' }
        },
        pages: [{ id: 'p1', title: 'Docs', fields: ['bank_statement_t1', 'bank_statement_t2'] }]
      };
      const { fields, steps } = generateRHFSchema(config);

      // Both mergedFields and step fields should have dynamic titles
      expect(fields[0].displayName).toMatch(/^Bank Statement \(\w+\)$/);
      expect(fields[1].displayName).toMatch(/^Bank Statement \(\w+\)$/);
      expect(fields[0].displayName).not.toBe(fields[1].displayName);

      expect(steps[0].fields[0].displayName).toMatch(/^Bank Statement \(\w+\)$/);
    });

    it('should apply dynamic financials title', () => {
      const config: UnifiedFormConfig = {
        displayName: 'Financials Test',
        categories: [{ id: 'docs', name: 'Documents' }],
        fields: {
          financials: { type: 'file', displayName: 'Financial Statement', category: 'docs' }
        },
        pages: [{ id: 'p1', title: 'Docs', fields: ['financials'] }]
      };
      const { fields } = generateRHFSchema(config);
      const expectedYear = (new Date().getFullYear() - 1).toString();
      expect(fields[0].displayName).toBe(`Audited Financial Statement (${expectedYear})`);
    });
  });
});
