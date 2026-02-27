# @extragalaxies/finsys-core

Borrower-side utilities for FinSys integration - form generation and validation for loan applications.

## Features

- **Unified Form Configuration**: Single JSON file format for defining form fields and page layouts
- **React Hook Form Generator**: Generate Zod schemas, default values, and step configurations
- **SurveyJS Generator**: Generate SurveyJS-compatible JSON from form configurations
- **Schema Validation**: Validate form configurations against JSON schema

## Installation

### In the lead-gen-ui monorepo

Already configured as a workspace dependency.

### In another local project (npm link)

```bash
# Step 1: In this package directory, create global link
cd packages/finsys-core
npm run link:setup

# Step 2: In your other project, link to the package
cd /path/to/your/other/project
npm link @extragalaxies/finsys-core
```

## Usage

### React Hook Form (RHF) Generator

```typescript
import { generateRHFSchema } from '@extragalaxies/finsys-core';
import formConfig from './config/form-config.json';

const { zodSchema, defaultValues, steps, groupedFields } = generateRHFSchema(formConfig);
```

### SurveyJS Generator

```typescript
import { generateSurveyJson } from '@extragalaxies/finsys-core';
import formConfig from './config/form-config.json';

const surveyJson = generateSurveyJson(formConfig);
```

### Form Config Validation

```typescript
import { validateFormConfig } from '@extragalaxies/finsys-core';
import formConfig from './config/form-config.json';

const result = validateFormConfig(formConfig);
if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

## Form Configuration Schema

The unified form configuration uses the following structure:

```json
{
  "$schema": "../../packages/finsys-core/dist/schema/unified-form.schema.json",
  "schemaVersion": "2.0",
  "displayName": "My Loan Application",
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
      "category": "contact"
    }
  },
  "pages": [
    {
      "id": "step1",
      "title": "Your Information",
      "fields": ["fullName", "email"]
    }
  ]
}
```

## Peer Dependencies

- `survey-core` - Required only if using the SurveyJS generator

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

## License

UNLICENSED - Internal use only
