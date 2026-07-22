# Manifest Reference

Every Source Adapter ships a `manifest.json` alongside its implementation. The manifest is the contract between the adapter and the FinSys host: it declares the adapter's identity, what category it implements, what canonical fields it produces, and how to load its code.

The authoritative source for this reference is the JSON-schema at [`src/schema/adapter-manifest.schema.json`](../src/schema/adapter-manifest.schema.json), published via the package export `@finsys/core/schema/adapter-manifest`. Point your IDE at it for autocomplete + validation while you author.

```json
{
  "$schema": "https://finhero.asia/schemas/finsys-core/adapter-manifest.schema.json"
}
```

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | const `1` | Yes | Manifest format version. Constant in v2.6.0; only bumps when the framework makes a breaking change to the manifest schema. |
| `id` | string | Yes | Globally unique adapter id. Pattern: `^[a-z][a-z0-9-]*-v[0-9]+$`. Convention: `<vendor>-<category-short>-v<n>`. |
| `displayName` | string | Yes | Human-readable label for operator UIs. 1–200 characters. |
| `category` | string | Yes | Generic category id. Must be one declared by `@finsys/core` — see [Category Reference](./category-reference.md). |
| `version` | integer | Yes | Adapter version. Bump on any change to payload shape, mapping logic, or output semantics. |
| `produces` | string[] | Yes | Canonical field names this adapter promises to produce. Subset of the category's field set. |
| `implementation` | object | Yes | Either declarative (JSON-only) or typescript (module). See [Implementation Block](#implementation-block). |
| `notes` | string | No | Free-form notes; not consumed by the runtime. Useful for describing your data shape. ≤2000 chars. |

## `id` conventions

Required pattern: starts with a lowercase letter, lowercase alphanumeric and hyphens, ends with `-v<integer>`.

Convention (not enforced): `<vendor>-<category-short>-v<n>`.

| Good | Why |
|---|---|
| `example-telco-v1` | vendor + category-short + version |
| `ipay88-payments-v3` | clear vendor identity, third major iteration |
| `acme-bank-v1` | bank statement adapter from Acme |

Bad:

| Bad | Why |
|---|---|
| `telco-v1` | no vendor identity |
| `MyAdapter-v1` | uppercase letters reject |
| `acme-bank` | missing version suffix |
| `acme-bank-v1.5` | only integer versions allowed |

The `id` must match the directory name AND the `id` exported from the TypeScript module (for TypeScript-flavour adapters). The host cross-checks at registration.

## `version` semantics

A positive integer. Bumped when:

- Your raw payload shape changes (you started consuming a new endpoint, the partner changed their API)
- Your field-mapping logic changes (you fixed a bug, redefined what counts as "on-time")
- Your output semantics change in any way

Not bumped for: comment changes, internal refactors that preserve identical outputs, typo fixes that don't affect mapping.

The version is stamped on every canonical row's `adapter_runs` provenance — so historical data stays interpretable after your adapter evolves.

## `produces`

The canonical field names you promise to populate. Each must:

- Be present in the field set of your declared `category` (validated at registration)
- Match exactly — case-sensitive, no aliases

You can produce a subset. Fields you don't list are stored as `null` for rows from this adapter.

## Implementation block

The `implementation` object is one of two shapes.

### `type: "declarative"`

For straightforward JSONPath-to-canonical mappings with optional simple transforms.

```json
{
  "implementation": {
    "type": "declarative",
    "fieldMap": [
      { "source": "$.bill.onTimePct24m", "canonical": "telcoOnTimePaymentRatio24m", "transform": "pct_to_ratio01" },
      { "source": "$.account.tenureMonths", "canonical": "telcoTenureMonths" }
    ]
  }
}
```

`fieldMap` is an array of mapping objects. Each:

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | Yes | JSONPath into the raw payload, starting with `$`. Limited subset: dotted access (`$.foo.bar`) and array index (`$.foo[0]`). No wildcards, filters, or recursive descent. |
| `canonical` | string | Yes | Canonical field name. Must be in the category's field set AND in this manifest's `produces`. |
| `transform` | string | No | One of `identity` (default), `pct_to_ratio01`, `to_boolean`, `to_integer`. |

**Transforms**:

- `identity` — value passed through unchanged.
- `pct_to_ratio01` — numeric percentage (e.g., 96) divided by 100 and clamped to [0, 1]. Use for fields declared as `ratio` (0..1) when your source emits percentage points.
- `to_boolean` — coerces to boolean: truthy non-zero numbers and non-empty strings → `true`; `null`, `undefined`, `0`, `""`, `false` → `false`. Use for boolean canonical fields.
- `to_integer` — `Math.trunc()` of a number, or `null` if non-numeric.

Declarative adapters can only produce one canonical instance per applicant. For multi-instance, use TypeScript.

### `type: "typescript"`

For real logic — derived calculations, multi-instance output, payload validation.

```json
{
  "implementation": {
    "type": "typescript",
    "entryPoint": "extract.js"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `entryPoint` | string | Yes | Relative path (from the adapter dir) to the module exporting the extract function. Must end in `.ts`, `.js`, `.mjs`, or `.cjs`. Must NOT start with `/`. Must NOT contain `..` segments. |

The entry-point module must default-export (or export as `adapter`) an object implementing the `SourceAdapter` interface:

```ts
import type { SourceAdapter } from '@finsys/core'

const adapter: SourceAdapter = {
  id: 'yourcompany-telco-v1',
  category: 'telco-carrier',
  version: 1,
  produces: ['telcoOnTimePaymentRatio24m', 'telcoTenureMonths'],
  async extract(raw) {
    // your logic here — return AdapterExtraction[]
    return [
      {
        instanceKey: '',
        values: { telcoOnTimePaymentRatio24m: 0.96, telcoTenureMonths: 36 },
      },
    ]
  },
}

export default adapter
```

The exported `id`, `category`, `version`, and `produces` MUST match `manifest.json`. The host cross-checks at registration and refuses adapters with mismatched identity.

## `AdapterExtraction` shape

What `extract()` returns:

```ts
interface AdapterExtraction {
  instanceKey: string             // '' for single-instance adapters
  values: Record<string, CanonicalFieldValue>
  observedAt?: string             // ISO-8601 UTC string; defaults to now
}

type CanonicalFieldValue = number | boolean | string | null
```

- `instanceKey` — unique within `(applicant, adapter)`. Use whatever's natural for your category (e.g., statement month for bank statements, MSISDN for telco lines).
- `values` — keyed by canonical field name. Fields you list in `produces` but don't include here are stored as `null`.
- `observedAt` — optional UTC timestamp. The `latest` aggregation operator uses this. Defaults to the host's clock at extract time.

## Validation

The manifest is validated against the JSON-schema at registration. Common failures:

| Error | Cause | Fix |
|---|---|---|
| `must match pattern` on `id` | Uppercase letters, missing version suffix, etc. | Use `lower-case-with-hyphens-vN` |
| `must be equal to one of the allowed values` on `category` | Misspelled or non-existent category | Check [Category Reference](./category-reference.md) |
| `must have required property X` | Missing top-level field | Add the field |
| `must not contain "../"` (or similar) on `entryPoint` | Path-traversal in entryPoint | Keep entry point inside the adapter directory |
| Adapter `produces` claims field not in category | Typo or wrong category | Check the category's field set |

For TypeScript adapters, two more checks at runtime:

| Error | Cause | Fix |
|---|---|---|
| `cannot import entryPoint` | Module fails to load (syntax error, missing dep) | Run `node --check extract.js` locally first |
| `exports id=X/Y but manifest says A/B` | TS module's identity doesn't match manifest | Sync the two |

## Reference manifests

Live examples in [`ExtraGalaxies/finsim/adapters/`](https://github.com/ExtraGalaxies/finsim/tree/main/adapters):

- [`telco-fake-v1/manifest.json`](https://github.com/ExtraGalaxies/finsim/blob/main/adapters/telco-fake-v1/manifest.json) — declarative
- [`payment-network-fake-v1/manifest.json`](https://github.com/ExtraGalaxies/finsim/blob/main/adapters/payment-network-fake-v1/manifest.json) — typescript, single-instance
- [`bank-statement-multi-v1/manifest.json`](https://github.com/ExtraGalaxies/finsim/blob/main/adapters/bank-statement-multi-v1/manifest.json) — typescript, multi-instance

These are fixtures (named `*-fake-v1`) but the manifest shapes are production-correct.
