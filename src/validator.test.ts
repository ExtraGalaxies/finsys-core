import { describe, it, expect } from 'vitest';
import { validateFormConfig, validateFormSpec, validatePagesConfig } from './validator.js';

describe('validateFormConfig', () => {
  const validConfig = {
    categories: [{ id: 'general', name: 'General' }],
    fields: {
      fullName: {
        type: 'text',
        displayName: 'Full Name',
        category: 'general'
      }
    },
    pages: [
      {
        id: 'page1',
        fields: ['fullName']
      }
    ]
  };

  it('should validate a correct form config', () => {
    const result = validateFormConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('should reject config missing required "categories"', () => {
    const result = validateFormConfig({
      fields: { name: { type: 'text' } },
      pages: [{ id: 'p1', fields: ['name'] }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some(e => e.instancePath === '' || e.params?.missingProperty === 'categories')).toBe(true);
  });

  it('should reject config missing required "fields"', () => {
    const result = validateFormConfig({
      categories: [{ id: 'general', name: 'General' }],
      pages: [{ id: 'p1', fields: [] }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('should reject config missing required "pages"', () => {
    const result = validateFormConfig({
      categories: [{ id: 'general', name: 'General' }],
      fields: { name: { type: 'text' } }
    });
    expect(result.valid).toBe(false);
  });

  it('should accept config with optional properties', () => {
    const result = validateFormConfig({
      ...validConfig,
      $schema: './schema/unified-form.schema.json',
      schemaVersion: 'v2.0.0',
      displayName: 'Test Form',
      templateIcon: 'loan-icon'
    });
    expect(result.valid).toBe(true);
  });

  it('should validate field types against allowed enum', () => {
    const result = validateFormConfig({
      categories: [{ id: 'general', name: 'General' }],
      fields: {
        name: { type: 'invalid_type' }
      },
      pages: [{ id: 'p1', fields: ['name'] }]
    });
    expect(result.valid).toBe(false);
  });

  it('should accept complex field definitions', () => {
    const result = validateFormConfig({
      categories: [{ id: 'general', name: 'General' }],
      fields: {
        amount: {
          type: 'number',
          displayName: 'Loan Amount',
          min: 1000,
          max: 500000,
          required: true,
          visibleIf: '{employmentType} = "employed"',
          validators: [
            { type: 'numeric', minValue: 1000, maxValue: 500000, text: 'Must be between 1000 and 500000' }
          ]
        }
      },
      pages: [{ id: 'p1', fields: ['amount'] }]
    });
    expect(result.valid).toBe(true);
  });

  it('should reject a completely invalid input', () => {
    const result = validateFormConfig('not an object');
    expect(result.valid).toBe(false);
  });

  it('should reject null input', () => {
    const result = validateFormConfig(null);
    expect(result.valid).toBe(false);
  });

  it('should provide errors array on validation failure', () => {
    const result = validateFormConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});

describe('deprecated aliases', () => {
  const validConfig = {
    categories: [{ id: 'general', name: 'General' }],
    fields: { name: { type: 'text' } },
    pages: [{ id: 'p1', fields: ['name'] }]
  };

  it('validateFormSpec should delegate to validateFormConfig', () => {
    const result = validateFormSpec(validConfig);
    expect(result.valid).toBe(true);
  });

  it('validatePagesConfig should delegate to validateFormConfig', () => {
    const result = validatePagesConfig(validConfig);
    expect(result.valid).toBe(true);
  });

  it('deprecated aliases should return same errors as validateFormConfig', () => {
    const invalid = {};
    const base = validateFormConfig(invalid);
    const spec = validateFormSpec(invalid);
    const pages = validatePagesConfig(invalid);

    expect(spec.valid).toBe(base.valid);
    expect(pages.valid).toBe(base.valid);
  });
});
