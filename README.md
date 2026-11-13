# @finsys/core

The shared contract layer for the FinSys ecosystem. Two distinct surfaces:

1. **Unified form configuration** — generate Zod schemas, React Hook Form defaults, and SurveyJS JSON from a single JSON form spec.
2. **Source Adapter Framework** — vendor-agnostic contract for ingesting alternative-data sources (telco, payments, bank statements, social-media presence, etc.) into FinSys's canonical credit-signal vocabulary. Categories are a runtime registry loaded from a single data file (see [Category Reference](./docs/category-reference.md)).

## Building a Source Adapter?

Partner-facing integration documentation lives in [`docs/`](./docs/):

- 📖 [**Adapter Authoring Guide**](./docs/adapter-authoring.md) — start here. Walks from "what's an adapter" through "how do I package and deliver one."
- 📋 [Category Reference](./docs/category-reference.md) — canonical field set per category.
- 📋 [Manifest Reference](./docs/manifest-reference.md) — every field in `manifest.json`.
- 🔒 [Security Model](./docs/security-model.md) — sandboxing, secrets, network posture.

## Features (form-config surface)

- **Unified Form Configuration** — Single JSON format for defining form fields and multi-step page layouts
- **React Hook Form Generator** — Generate Zod schemas, default values, and step configurations from a form config
- **SurveyJS Generator** — Generate SurveyJS-compatible JSON from the same config
- **Schema Validation** — Validate form configurations against a strict JSON Schema (AJV)
- **Visibility-Aware Validation** — Conditional fields are only validated when visible (`visibleIf` expressions)
- **TypeScript-First** — Full type exports for all config types and generator outputs

## Prerequisites

This project targets Node 24.16.0 (see [`.nvmrc`](./.nvmrc)) and npm ≥ 12.0.1. After `nvm use`, upgrade npm with `npm install -g npm@12.0.1`.

## Installation

```bash
npm install @finsys/core
```

`generateSurveyJson` emits plain JSON and does not import SurveyJS; if you
render that JSON with SurveyJS, `survey-core` is your app's dependency, not
this package's. (Before 8.0.0 this package declared it as an optional peer and
re-exported five of its types from the root entry — which made the root
declaration file fail to typecheck for any consumer without it. See the
CHANGELOG.)

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

Converts a form config into SurveyJS-compatible JSON. Plain data — no SurveyJS import; render it with `survey-core` in your own app.

### `validateFormConfig(data: unknown): ValidationResult`

Validates a form config object against the unified form JSON schema. Returns `{ valid, errors, message? }`.

### `evaluateExpression(expression: string, data: any): boolean`

Evaluates a SurveyJS-style expression (e.g., `{fieldName} > 100`) against a data object. An empty expression is `true`; a malformed or unsupported one is `false`.

Supported: `{field}` references; `=` / `==` (both loose, JavaScript `==`), `!=`, `===`, `!==`; `<`, `>`, `<=`, `>=`; `+ - * / %`; `!`, `&&`, `||`; parentheses; number, `'string'`, `"string"`, `true`, `false`, `null`, `undefined` and `[array]` literals; and `{field} anyof [...]`, `{field} allof [...]`, `{field} contains '...'`, `{field} notcontains '...'` (the operator words are case-insensitive). The SurveyJS words `and`, `or`, `not`, `empty`, `notempty` and the operator `<>` are not supported and make the expression `false`.

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
```

SurveyJS's own types (`IQuestion`, `IPage`, `ISurvey`, `IPanel`, `IElement`)
were re-exported from here up to 7.x; import them from `survey-core` directly.

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

## Security

### Expression Evaluation

`evaluateExpression()` parses and evaluates the expression itself (a tokenizer, a recursive-descent parser and a tree walk). It never builds JavaScript source, and it does not call `eval` or the `Function` constructor, so a page that uses it needs no `'unsafe-eval'` in its Content-Security-Policy. An expression can read only the `{field}` values of the data object it is given; it cannot call functions, reach globals or assign. Anything outside the grammar in the `evaluateExpression` section above evaluates to `false`.

## Disclaimer

This library provides form configuration utilities and does not constitute financial, legal, or investment advice. It does not perform financial calculations, risk assessments, or lending decisions. The creators and contributors accept no liability for decisions made using forms generated by this library. See the [LICENSE](./LICENSE) file for warranty and liability terms.

### Responsibility for regulated use

This is open-source software, and some of its modules can be used to build credit reporting functions. The modules do not guarantee compliance with any law, regulation, license condition or standard, and using them does not make a deployment compliant. Their developer, Sisters Inspire Sdn Bhd ("SI"), is not responsible for whether they are used compliantly; that responsibility belongs to whoever deploys and operates them.

- **Built to requirements, not a compliance determination.** SI builds features to requirements set by the compliance and operations functions of the organizations that license the software. Implementing a requirement does not mean it satisfies any law, regulation, license condition or standard. No feature, default, validation, document or test is legal or compliance advice.
- **The operator decides and is accountable.** The organization that deploys the software (the "operator") alone decides whether, when and how to use it in a credit reporting function, and is responsible for its compliance with the law that applies to it. That includes launching and deploying the software; setting and changing its configuration; turning features on or off; retention and deletion settings; access control; and monitoring and incident response.
- **SI does not launch, deploy or configure operator environments.** SI engineering does not release into an operator's environment, change its configuration, or turn features on or off there. Any help SI gives is advisory; the operator makes the change under its own change control and stays responsible for it.
- **Defaults and examples are starting points.** Default settings, sample configuration, seed data and documentation examples are engineering choices, not compliance settings. The operator reviews and sets every value before use.
- **Test environments show capability, not compliance.** Simulated environments and test suites show that a feature works as built. They do not show that any deployment complies with anything.
- **Warranty and liability** are as stated in the [LICENSE](./LICENSE) (Apache-2.0, sections 7 and 8).

## License

[Apache-2.0](./LICENSE)
