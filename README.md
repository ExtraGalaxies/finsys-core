# @finsys/core

Convert unified form configurations into Zod schemas, React Hook Form defaults, and SurveyJS JSON.

## Features

- **Unified Form Configuration** — Single JSON format for defining form fields and multi-step page layouts
- **React Hook Form Generator** — Generate Zod schemas, default values, and step configurations from a form config
- **SurveyJS Generator** — Generate SurveyJS-compatible JSON from the same config
- **Schema Validation** — Validate form configurations against a strict JSON Schema (AJV)
- **Visibility-Aware Validation** — Conditional fields are only validated when visible (`visibleIf` expressions)
- **TypeScript-First** — Full type exports for all config types and generator outputs

## Installation

```bash
npm install @finsys/core
```

If you use the SurveyJS generator, install the peer dependency:

```bash
npm install survey-core
```

## Quick Start

### React Hook Form

```typescript
import { generateRHFSchema } from '@finsys/core';
import formConfig from './form-config.json';

const { zodSchema, defaultValues, steps, groupedFields } = generateRHFSchema(formConfig);

// Use with React Hook Form + zodResolver
// zodSchema     — Zod schema for the entire form
// defaultValues — Default values for all fields
// steps         — Array of step metadata (title, description, field names)
// groupedFields — Fields grouped by category per step
```

### SurveyJS

```typescript
import { generateSurveyJson } from '@finsys/core';
import formConfig from './form-config.json';

const surveyJson = generateSurveyJson(formConfig);
// Pass surveyJson to SurveyJS Model
```

### Config Validation

```typescript
import { validateFormConfig } from '@finsys/core';
import formConfig from './form-config.json';

const result = validateFormConfig(formConfig);
if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

### Expression Evaluation

```typescript
import { evaluateExpression } from '@finsys/core';

// Evaluate SurveyJS-style visibility expressions
const visible = evaluateExpression('{totalFinancing} > 50000', { totalFinancing: 75000 });
// true
```

## Form Configuration Schema

A form config JSON has three required top-level keys: `categories`, `fields`, and `pages`.

```json
{
  "$schema": "node_modules/@finsys/core/dist/schema/unified-form.schema.json",
  "schemaVersion": "2.0",
  "displayName": "My Application Form",
  "categories": [
    { "id": "contact", "name": "Contact Information" },
    { "id": "business", "name": "Business Details" }
  ],
  "fields": {
    "fullName": {
      "type": "text",
      "displayName": "Full Name",
      "category": "contact",
      "required": true
    },
    "email": {
      "type": "text",
      "inputType": "email",
      "displayName": "Email Address",
      "category": "contact",
      "validators": [{ "type": "email", "text": "Please enter a valid email" }]
    },
    "companyName": {
      "type": "text",
      "displayName": "Company Name",
      "category": "business"
    }
  },
  "pages": [
    {
      "id": "step1",
      "title": "Your Information",
      "fields": ["fullName", "email"]
    },
    {
      "id": "step2",
      "title": "Business Details",
      "fields": [
        "companyName",
        { "ref": "email", "displayName": "Business Email", "readOnly": true }
      ]
    }
  ]
}
```

### Field References

Pages reference fields in three ways:

| Format | Example | Description |
|--------|---------|-------------|
| String | `"fullName"` | Simple reference to a field in `fields` |
| Ref with overrides | `{ "ref": "email", "displayName": "Work Email" }` | Reference with per-page property overrides |
| Inline definition | `{ "definition": { "name": "note", "type": "html", "html": "..." } }` | Page-specific field not in master `fields` |

### Supported Field Types

`text`, `number`, `email`, `file`, `dropdown`, `checkbox`, `boolean`, `comment`, `radiogroup`, `range`, `html`, `slider`

### Validator Types

`regex`, `email`, `numeric`, `text`, `expression`, `answercount`, `custom`

## API Reference

### `generateRHFSchema(config: UnifiedFormConfig): RHFSchemaOutput`

Converts a form config into Zod schemas and React Hook Form metadata.

Returns `{ zodSchema, baseSchema, defaultValues, fields, groupedFields, steps, displayName, categories, templateIcon }`

### `getStepSchema(step: RHFStep, fullSchema: ZodObject): ZodTypeAny`

Extracts the Zod schema for a specific form step.

### `getStepDefaultValues(step: RHFStep, allDefaults: Record<string, any>): Record<string, any>`

Extracts default values for a specific form step.

### `generateSurveyJson(config: UnifiedFormConfig): SurveyJSON`

Converts a form config into SurveyJS-compatible JSON. Requires `survey-core` peer dependency.

### `validateFormConfig(data: unknown): ValidationResult`

Validates a form config object against the unified form JSON schema. Returns `{ valid, errors, message? }`.

### `evaluateExpression(expression: string, data: any): boolean`

Evaluates a SurveyJS-style expression (e.g., `{fieldName} > 100`) against a data object.

### `resolvePageFields(page: PageConfig, fields: Record<string, FieldData>): ResolvedField[]`

Resolves all field references in a page to full field definitions.

### `groupFieldsByCategory(fields: ResolvedField[], categories: Category[]): FieldGroup[]`

Groups resolved fields by their category, maintaining order.

### `applyDynamicTitles(field: ResolvedField): ResolvedField`

Applies dynamic display names for known naming patterns (e.g., `bank_statement_t1` gets a month label).

### Utility Functions

- `getPastMonthLabel(monthsAgo: number): string` — Returns the month name N months ago
- `getPastYearLabel(yearsAgo: number): string` — Returns the year N years ago
- `getCategoryName(categoryId: string | undefined, categories: Category[]): string` — Looks up category display name

## Exported Types

```typescript
// Config types
UnifiedFormConfig, FieldData, FieldReference, PageConfig, Category, Choice, Validator

// Output types
ResolvedField, FieldGroup, RHFStep, RHFSchemaOutput
SurveyElementJSON, SurveyPageJSON, SurveyJSON

// Re-exported from survey-core
IQuestion, IPage, ISurvey, IPanel, IElement
```

## Development

```bash
npm install
npm run build    # Compile TypeScript + copy schema
npm run dev      # Watch mode
npm test         # Run tests (Vitest)
npm run lint     # Type-check without emitting
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE)
