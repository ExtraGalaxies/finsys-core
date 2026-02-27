import { describe, it, expect } from 'vitest';
import {
  generateSurveyJson,
  resolvePageFields,
  getCategoryName,
  groupFieldsByCategory,
  applyDynamicTitles,
  type UnifiedFormConfig,
  type Category,
  type ResolvedField
} from './survey-generator.js';

// ---- Shared fixtures ----

const categories: Category[] = [
  { id: 'personal', name: 'Personal Info' },
  { id: 'financial', name: 'Financial Details' }
];

const baseConfig: UnifiedFormConfig = {
  displayName: 'Test Loan Application',
  categories,
  fields: {
    fullName: {
      type: 'text',
      displayName: 'Full Name',
      category: 'personal',
      required: true
    },
    email: {
      type: 'text',
      inputType: 'email',
      displayName: 'Email Address',
      category: 'personal',
      required: true
    },
    loanAmount: {
      type: 'number',
      displayName: 'Loan Amount',
      category: 'financial',
      min: 1000,
      max: 500000,
      required: true
    },
    termsAccepted: {
      type: 'boolean',
      displayName: 'Accept Terms',
      category: 'personal',
      required: false
    }
  },
  pages: [
    {
      id: 'page1',
      title: 'Application',
      showTOC: true,
      showProgressBar: true,
      showCategoryHeadings: true,
      fields: ['fullName', 'email', 'loanAmount', 'termsAccepted']
    }
  ]
};

// ---- generateSurveyJson ----

describe('generateSurveyJson', () => {
  it('should return empty object if config has no pages', () => {
    const result = generateSurveyJson({ ...baseConfig, pages: [] });
    expect(result).toEqual({});
  });

  it('should return empty object if config.pages is undefined', () => {
    const { pages, ...noPagesConfig } = baseConfig;
    const result = generateSurveyJson(noPagesConfig as UnifiedFormConfig);
    expect(result).toEqual({});
  });

  it('should return empty object if only page is "success-message"', () => {
    const result = generateSurveyJson({
      ...baseConfig,
      pages: [{ id: 'success-message', title: 'Done', fields: [] }]
    });
    expect(result).toEqual({});
  });

  it('should generate valid SurveyJS JSON from a config', () => {
    const result = generateSurveyJson(baseConfig);
    expect(result).toHaveProperty('title', 'Test Loan Application');
    expect(result).toHaveProperty('pages');
    expect(Array.isArray((result as any).pages)).toBe(true);
  });

  it('should use displayName as title or fall back to default', () => {
    const noNameConfig = { ...baseConfig, displayName: undefined };
    const result = generateSurveyJson(noNameConfig);
    expect((result as any).title).toBe('Flexible Financing Program');
  });

  it('should group fields by category into separate pages', () => {
    const result = generateSurveyJson(baseConfig) as any;
    expect(result.pages.length).toBe(2); // personal + financial
    expect(result.pages[0].title).toBe('Personal Info');
    expect(result.pages[1].title).toBe('Financial Details');
  });

  it('should hide category headings when showCategoryHeadings is false', () => {
    const config: UnifiedFormConfig = {
      ...baseConfig,
      pages: [{
        id: 'page1',
        title: 'Test',
        showCategoryHeadings: false,
        fields: ['fullName']
      }]
    };
    const result = generateSurveyJson(config) as any;
    expect(result.pages[0].title).toBe('');
  });

  it('should set showTOC from page config', () => {
    const result = generateSurveyJson(baseConfig) as any;
    expect(result.showTOC).toBe(true);
  });

  it('should set showProgressBar to "off" when disabled', () => {
    const config: UnifiedFormConfig = {
      ...baseConfig,
      pages: [{ id: 'page1', title: 'Test', showProgressBar: false, fields: ['fullName'] }]
    };
    const result = generateSurveyJson(config) as any;
    expect(result.showProgressBar).toBe('off');
  });

  it('should set storeDataAsText=false for file fields', () => {
    const config: UnifiedFormConfig = {
      ...baseConfig,
      fields: {
        ...baseConfig.fields,
        upload: { type: 'file', displayName: 'Upload', category: 'personal' }
      },
      pages: [{ id: 'page1', title: 'Test', fields: ['upload'] }]
    };
    const result = generateSurveyJson(config) as any;
    const fileElement = result.pages[0].elements[0].elements.find(
      (e: any) => e.name === 'upload'
    );
    expect(fileElement.storeDataAsText).toBe(false);
  });

  it('should set isRequired based on field config', () => {
    const result = generateSurveyJson(baseConfig) as any;
    const personalElements = result.pages[0].elements[0].elements;
    const fullNameEl = personalElements.find((e: any) => e.name === 'fullName');
    const termsEl = personalElements.find((e: any) => e.name === 'termsAccepted');
    expect(fullNameEl.isRequired).toBe(true);
    expect(termsEl.isRequired).toBe(false);
  });

  it('should apply maxLength when specified', () => {
    const config: UnifiedFormConfig = {
      ...baseConfig,
      fields: {
        name: { type: 'text', displayName: 'Name', category: 'personal', maxLength: 50 }
      },
      pages: [{ id: 'page1', title: 'Test', fields: ['name'] }]
    };
    const result = generateSurveyJson(config) as any;
    const el = result.pages[0].elements[0].elements[0];
    expect(el.maxLength).toBe(50);
  });
});

// ---- resolvePageFields ----

describe('resolvePageFields', () => {
  it('should resolve simple string field references', () => {
    const page = { id: 'p1', title: 'Test', fields: ['fullName', 'email'] as any[] };
    const resolved = resolvePageFields(page, baseConfig.fields);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].name).toBe('fullName');
    expect(resolved[1].name).toBe('email');
  });

  it('should resolve ref-with-overrides', () => {
    const page = {
      id: 'p1',
      title: 'Test',
      fields: [
        { ref: 'fullName', displayName: 'Your Name', required: false }
      ] as any[]
    };
    const resolved = resolvePageFields(page, baseConfig.fields);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].displayName).toBe('Your Name');
    expect(resolved[0].required).toBe(false);
    expect(resolved[0].isRequired).toBe(false);
  });

  it('should resolve inline definitions', () => {
    const page = {
      id: 'p1',
      title: 'Test',
      fields: [
        { definition: { name: 'customField', type: 'text', displayName: 'Custom' } }
      ] as any[]
    };
    const resolved = resolvePageFields(page, baseConfig.fields);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].name).toBe('customField');
    expect(resolved[0].type).toBe('text');
  });

  it('should filter out unresolvable references', () => {
    const page = {
      id: 'p1',
      title: 'Test',
      fields: ['fullName', 'nonExistent', 'email'] as any[]
    };
    const resolved = resolvePageFields(page, baseConfig.fields);
    expect(resolved).toHaveLength(2);
    expect(resolved.map(f => f.name)).toEqual(['fullName', 'email']);
  });

  it('should normalize required/isRequired on resolved fields', () => {
    const page = { id: 'p1', title: 'Test', fields: ['fullName'] as any[] };
    const resolved = resolvePageFields(page, baseConfig.fields);
    // fullName has required: true, normalizeField should set both
    expect(resolved[0].required).toBe(true);
    expect(resolved[0].isRequired).toBe(true);
  });

  it('should apply dynamic titles for bank_statement fields', () => {
    const fields = {
      bank_statement_t1: { type: 'file', displayName: 'Bank Statement', category: 'financial' }
    };
    const page = { id: 'p1', title: 'Test', fields: ['bank_statement_t1'] as any[] };
    const resolved = resolvePageFields(page, fields);
    expect(resolved[0].displayName).toContain('Bank Statement (');
  });

  it('should apply dynamic titles for financials field', () => {
    const fields = {
      financials: { type: 'file', displayName: 'Financial Statement', category: 'financial' }
    };
    const page = { id: 'p1', title: 'Test', fields: ['financials'] as any[] };
    const resolved = resolvePageFields(page, fields);
    expect(resolved[0].displayName).toContain('Audited Financial Statement (');
  });
});

// ---- getCategoryName ----

describe('getCategoryName', () => {
  it('should return category name when ID matches', () => {
    expect(getCategoryName('personal', categories)).toBe('Personal Info');
    expect(getCategoryName('financial', categories)).toBe('Financial Details');
  });

  it('should return "Other" for undefined categoryId', () => {
    expect(getCategoryName(undefined, categories)).toBe('Other');
  });

  it('should return "Other" for unrecognized categoryId', () => {
    expect(getCategoryName('nonexistent', categories)).toBe('Other');
  });

  it('should return "Other" for empty categories array', () => {
    expect(getCategoryName('personal', [])).toBe('Other');
  });
});

// ---- groupFieldsByCategory ----

describe('groupFieldsByCategory', () => {
  const makeField = (name: string, category: string): ResolvedField => ({
    name,
    type: 'text',
    category,
    required: true,
    isRequired: true
  });

  it('should group fields by category in order', () => {
    const fields = [
      makeField('a', 'personal'),
      makeField('b', 'personal'),
      makeField('c', 'financial'),
      makeField('d', 'financial')
    ];
    const groups = groupFieldsByCategory(fields, categories);
    expect(groups).toHaveLength(2);
    expect(groups[0].category).toBe('personal');
    expect(groups[0].categoryName).toBe('Personal Info');
    expect(groups[0].fields).toHaveLength(2);
    expect(groups[1].category).toBe('financial');
    expect(groups[1].fields).toHaveLength(2);
  });

  it('should create separate groups for interleaved categories', () => {
    const fields = [
      makeField('a', 'personal'),
      makeField('b', 'financial'),
      makeField('c', 'personal')
    ];
    const groups = groupFieldsByCategory(fields, categories);
    // Categories alternate, so 3 groups: personal, financial, personal
    expect(groups).toHaveLength(3);
    expect(groups[0].category).toBe('personal');
    expect(groups[1].category).toBe('financial');
    expect(groups[2].category).toBe('personal');
  });

  it('should return empty array for empty fields', () => {
    const groups = groupFieldsByCategory([], categories);
    expect(groups).toEqual([]);
  });

  it('should use "Other" for fields with no matching category', () => {
    const fields = [makeField('a', 'unknown')];
    const groups = groupFieldsByCategory(fields, categories);
    expect(groups[0].categoryName).toBe('Other');
  });

  it('should handle fields with undefined category', () => {
    const field = makeField('a', '');
    field.category = undefined;
    const groups = groupFieldsByCategory([field], categories);
    expect(groups[0].category).toBe('');
    expect(groups[0].categoryName).toBe('Other');
  });
});

// ---- applyDynamicTitles ----

describe('applyDynamicTitles', () => {
  const makeField = (name: string, displayName?: string): ResolvedField => ({
    name,
    type: 'file',
    displayName,
    required: true,
    isRequired: true
  });

  it('should transform bank_statement_t1 with month label', () => {
    const result = applyDynamicTitles(makeField('bank_statement_t1', 'Bank Statement'));
    expect(result.displayName).toMatch(/^Bank Statement \(\w+\)$/);
  });

  it('should transform bank_statement_t3 with 3-month-ago label', () => {
    const result = applyDynamicTitles(makeField('bank_statement_t3'));
    expect(result.displayName).toMatch(/^Bank Statement \(\w+\)$/);
  });

  it('should transform financials field with year label', () => {
    const result = applyDynamicTitles(makeField('financials', 'Financial Statement'));
    const expectedYear = (new Date().getFullYear() - 1).toString();
    expect(result.displayName).toBe(`Audited Financial Statement (${expectedYear})`);
  });

  it('should not modify regular fields', () => {
    const field = makeField('fullName', 'Full Name');
    const result = applyDynamicTitles(field);
    expect(result.displayName).toBe('Full Name');
  });

  it('should not modify fields with similar but non-matching names', () => {
    const field = makeField('bank_statement', 'Statement');
    const result = applyDynamicTitles(field);
    expect(result.displayName).toBe('Statement');
  });
});
