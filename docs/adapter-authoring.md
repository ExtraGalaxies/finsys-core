# Authoring a FinSys Source Adapter

This guide is for partner engineering teams building a Source Adapter against the `@finsys/core` contract. It walks from "what is an adapter" through to "how do I package and deliver one." When you finish reading, you should have everything you need to scaffold a working adapter against fake data and hand the result back to FinHero for integration.

Cross-references:

- [Category Reference](./category-reference.md) — the canonical field set per category
- [Manifest Reference](./manifest-reference.md) — every field in `manifest.json`
- [Security Model](./security-model.md) — sandboxing, secrets, network posture

---

## What an adapter is

A Source Adapter is a small, narrowly-scoped module that takes a raw, partner-shaped payload (whatever your API returns) and produces one or more **canonical instances** — typed records that FinSys's eval engine, report renderer, and downstream consumers know how to read without knowing anything about your specific data shape.

Think of it as the translator that sits between your data and FinSys's vocabulary.

```
┌──────────────────┐   raw partner payload   ┌──────────────────┐   canonical instances   ┌────────────────┐
│   Partner API    │  ─────────────────────► │  YOUR ADAPTER    │ ──────────────────────► │  FinSys eval   │
│  (telco data)    │  (free-form, your shape)│  (this guide)    │  (alt_data_telco rows)  │  + CRA report  │
└──────────────────┘                         └──────────────────┘                         └────────────────┘
```

Two things matter:

1. **You own the input side.** Whatever shape your API or feed produces, your adapter handles it. FinHero doesn't dictate your data layout.
2. **The output side is shared vocabulary.** Every adapter for the same *category* (e.g., `telco-carrier`) produces the same canonical field set. That's what lets FinSys's eval engine read from "any telco adapter" without code changes per vendor.

The "category" is the boundary. Vendor identity stays on your side; FinSys's evaluators read the canonical fields.

---

## The category model

`@finsys/core` declares a small, slow-growing set of categories. Each category has a fixed canonical field set — types, units, descriptions — published in `src/data/adapter-categories.json` and consumable via the package's TypeScript API.

Today's catalogue (v2.6.0):

- **`telco-carrier`** — payment punctuality, account tenure, suspensions, late days, handset financing, ARPU
- **`payment-network`** — monthly volume (T3 + T12), ARPU stability, dispute rate, customer concentration, active tenure
- **`bank-statement`** — month, closing balance, total credits/debits, largest single credit, bounced count

See [Category Reference](./category-reference.md) for the full field list per category with types, units, and ranges.

**If your data doesn't fit an existing category**, talk to FinHero — categories are versioned minor releases of `@finsys/core`, so a new category is a coordinated change (manifest schema enum + TS union + data file + drift-guard test all updated together). New categories are welcome; we just want to design the canonical field set deliberately, not per-vendor.

---

## Two adapter flavours

You can author your adapter in two shapes, depending on how much logic you need.

### Declarative (JSON-only)

For straightforward field mappings — "field X in my payload maps to canonical field Y, optionally with a simple transform" — write a `manifest.json` and nothing else.

```json
{
  "manifestVersion": 1,
  "id": "yourcompany-telco-v1",
  "displayName": "YourCompany Telco Carrier v1",
  "category": "telco-carrier",
  "version": 1,
  "produces": ["telcoOnTimePaymentRatio24m", "telcoTenureMonths"],
  "implementation": {
    "type": "declarative",
    "fieldMap": [
      { "source": "$.bill.onTimePct24m", "canonical": "telcoOnTimePaymentRatio24m", "transform": "pct_to_ratio01" },
      { "source": "$.account.tenureMonths", "canonical": "telcoTenureMonths" }
    ]
  }
}
```

- `source` is a limited JSONPath into your raw payload (dotted access + array index, no wildcards or filters).
- `canonical` must be a field declared by the chosen `category`.
- `transform` is optional: `identity` (default), `pct_to_ratio01`, `to_boolean`, `to_integer`.

Declarative adapters cover ~70% of vendor integrations. If your payload is a single nested object that maps field-for-field to the canonical set, this is all you need.

### TypeScript (JS module)

When you need real logic — computing a derived value from raw transactions, splitting a payload into multiple instances, calling a sub-API for enrichment — write a TS/JS module.

`manifest.json`:

```json
{
  "manifestVersion": 1,
  "id": "yourcompany-payments-v1",
  "displayName": "YourCompany Payments v1",
  "category": "payment-network",
  "version": 1,
  "produces": ["paymentsMonthlyVolumeMyrT3", "paymentsArpuStability12m"],
  "implementation": {
    "type": "typescript",
    "entryPoint": "extract.js"
  }
}
```

`extract.js`:

```js
async function extract(raw) {
  // Your logic — read raw, compute canonical values.
  const monthlies = raw.monthlyVolumes ?? []
  const last3 = monthlies.slice(0, 3)
  const t3 = last3.reduce((acc, m) => acc + m.volumeMyr, 0) / last3.length

  return [{
    instanceKey: '',                       // empty for single-instance adapters
    values: {
      paymentsMonthlyVolumeMyrT3: t3,
      paymentsArpuStability12m: computeStability(monthlies),
    },
  }]
}

export default {
  id: 'yourcompany-payments-v1',
  category: 'payment-network',
  version: 1,
  produces: ['paymentsMonthlyVolumeMyrT3', 'paymentsArpuStability12m'],
  extract,
}
```

- The module's default export (or a named `adapter` export) implements `SourceAdapter`.
- `extract()` is async. Network calls are allowed but discouraged inside extract — see [Security Model](./security-model.md).
- The `id` and `category` exported from the module **must** match the `manifest.json`. The host runtime cross-checks at registration.

You can also write `extract.ts` and bundle it to `extract.js` as part of your build. The runtime imports the JS form.

---

## Multi-instance: when one applicant has many of something

Many real data shapes produce more than one record per applicant. Six monthly bank statements. Three telco lines on a business account. A dozen monthly payment-volume snapshots. The framework models this as a first-class concept:

```js
return [
  { instanceKey: '2026-04', values: { bankStatementMonth: '2026-04', ... } },
  { instanceKey: '2026-03', values: { bankStatementMonth: '2026-03', ... } },
  { instanceKey: '2026-02', values: { bankStatementMonth: '2026-02', ... } },
  // ...
]
```

- **`instanceKey`** — a string that uniquely identifies this instance within the (applicant, adapter) tuple. Use whatever's natural: a statement month (`YYYY-MM`), a phone number, a vendor account id. The host treats this as opaque.
- For single-instance categories, pass `instanceKey: ''` (empty string) and return an array of length 1.
- Re-running an adapter for the same applicant **replaces the previous run's instances** — the host deletes prior rows for `(ihs_id, adapter_id)` and inserts the fresh set. So an adapter that produced 6 statement instances on run 1 and 4 on run 2 will leave exactly 4 in the canonical table.

### How the eval engine collapses multi-instance

FinSys's eval policies declare an **aggregation operator** per multi-instance field they consume. Operators (published in `@finsys/core`):

| Operator | Behaviour |
|---|---|
| `sum` | Sum of numeric values across instances |
| `mean` | Arithmetic mean of numeric values |
| `latest` | Value of the instance with the most-recent `observedAt` |
| `max` | Maximum of numeric values |
| `count` | Count of non-null values across instances |

Empty / all-null lists return `null` (except `count`, which returns `0`).

Your adapter doesn't apply these operators — the eval engine does, per policy. Your job is to produce the instances; the consumer decides how to collapse them.

---

## The `produces` list

Every manifest declares the canonical fields the adapter promises to populate. The host validates this list against the category's field set at registration: if you claim to produce `telcoArpuMyr` but `telcoArpuMyr` isn't a field of `telco-carrier`, registration fails.

You can produce a subset — not every adapter has every field. Missing values are stored as `null` and the eval engine treats them as "no signal" (component scores zero on a `pass_through` reference).

---

## Errors

When extraction can't complete, throw an `AdapterError` from `@finsys/core` with a `reason` discriminator:

```js
import { AdapterError } from '@finsys/core'

async function extract(raw) {
  if (!raw?.bill) {
    throw new AdapterError(
      'payload_invalid',
      'partner payload missing required `bill` block',
    )
  }
  // ...
}
```

Reasons:

| Reason | Meaning |
|---|---|
| `payload_invalid` | Raw payload didn't match expected source shape. Permanent — re-running won't help. |
| `partner_transient` | Upstream partner returned a transient failure (timeout, 503). Re-run may succeed. |
| `partner_permanent` | Upstream partner returned a permanent failure (404, deleted account). Won't succeed on retry. |
| `mapping_failed` | Adapter logic error — a field couldn't be mapped, a calculation produced NaN, etc. |

The host runtime catches `AdapterError` AND unknown throws (treats unknown as `mapping_failed`). Either way, the failure is logged on the `adapter_runs` table with the reason and message — no canonical rows are written for that run.

---

## Adapter directory layout

Each adapter lives in its own directory:

```
adapters/
├── yourcompany-telco-v1/
│   ├── manifest.json          (always required)
│   ├── extract.js             (only for typescript flavour)
│   ├── package.json           (only if extract.js has dependencies)
│   └── README.md              (recommended — explains your data shape)
└── yourcompany-payments-v1/
    └── manifest.json          (declarative — no entry point needed)
```

- **Directory name** should match the `id` in `manifest.json`. The host uses directory names for discovery.
- **`manifest.json`** is always required. The schema is in [`@finsys/core/schema/adapter-manifest`](./manifest-reference.md).
- **`extract.js`** is required for typescript-flavour adapters. Must be valid ES modules.
- **`package.json`** is optional. If your `extract.js` imports anything beyond `@finsys/core`, declare it as a dependency.

`entryPoint` in the manifest is resolved **relative to the adapter directory** — it cannot use absolute paths or `..` segments (rejected by the schema AND a runtime check).

---

## Versioning

Two version numbers matter:

1. **`manifestVersion: 1`** — the framework's manifest format version. Constant in v2.6.0; bumps only when `@finsys/core` makes a breaking change to the manifest schema.

2. **`version: N`** — your adapter's version (a positive integer). Bump when:
   - Your raw payload shape changes (you started consuming a new endpoint, the partner changed their API)
   - Your field-mapping logic changes (you fixed a bug, redefined what counts as "on-time")
   - Your output semantics change in any way (the same input now produces different canonical values)

   Don't bump for: comment changes, internal refactors that preserve identical outputs, typo fixes that don't affect mapping.

The `version` is stamped onto every canonical row in the `adapter_runs` provenance table, so historical data stays interpretable even after your adapter evolves. FinSys's CRA report renderer uses it to show "rows produced by v3 of this adapter look like this; rows from v1 used a different mapping for field X."

---

## Local testing with FinSim

`finsim` is FinHero's local-stack harness. It includes an in-memory adapter host you can run against fake data without booting any FinSys service. This is the recommended way to validate your adapter before delivering it.

```bash
# Clone finsim and finsys-core alongside your adapter
git clone https://github.com/ExtraGalaxies/finsim ../finsim

# Drop your adapter into finsim/adapters/yourcompany-telco-v1/
cp -r ./yourcompany-telco-v1 ../finsim/adapters/

# Run finsim's adapter-host smoke test against your adapter
cd ../finsim/sim
npm install
npx tsx tests/adapter-host-smoke.ts
```

The reference adapters under `finsim/adapters/` (`telco-fake-v1`, `payment-network-fake-v1`, `bank-statement-multi-v1`) are open-source examples — fork from whichever matches your category as a starting point.

For an end-to-end test that runs your adapter through aggregation + eval engine + provenance, see `finsim/sim/tests/adapter-framework-demo.ts`.

---

## What you deliver to FinHero

A directory matching the layout above, packaged as a zip or tarball, plus:

1. **Sample raw payloads** — at least three realistic examples (good case, edge case, error case). FinHero uses these for regression fixtures.
2. **A README** in the adapter directory explaining your data shape, what the values mean, and any partner-side constraints (rate limits, auth, freshness windows).
3. **Version bump policy** — who at your end is empowered to bump `version` and ship a new adapter build, and how that gets communicated to FinHero.

FinHero handles the operational side: discovery, deployment, secrets management, monitoring. You produce the adapter; we run it.

---

## What's NOT in this release

A few production-side pieces are still being designed; flagging them so you know what's TBD:

- **Production deployment handshake** — the exact mechanism for how your adapter binary gets into FinSys's runtime (private npm package, signed zip drop, OCI bundle, etc.) is still being decided as part of SYS-2444. The contract you build against today is stable; the delivery channel may evolve. Expect a follow-up doc covering this when SYS-2444 lands.
- **Sandboxing model** — adapters today run in-process inside the FinSys runtime. A sandbox / capabilities model (network whitelist, FS access policy, secrets injection) is on the roadmap for hardening once we have multiple third-party adapters. See [Security Model](./security-model.md) for current expectations.
- **Live observability** — per-adapter latency, error rate, and dispute counts will be surfaced on the FinHero operator console. Not yet wired through; your adapter doesn't need to emit any telemetry itself today.

---

## Contract evolution policy

The contract is published under SemVer at `@finsys/core`. As of this writing (v2.6.0):

- **New categories** — minor version bump. Existing adapters keep working unchanged. The new category becomes selectable by future adapters.
- **New canonical fields within a category** — minor version bump. Existing adapters either don't produce the new field (stored as `null`) or you bump your adapter's `version` and add it.
- **New aggregation operators** — minor version bump. Existing policies unchanged; new policies can opt in.
- **Removal or rename of a category, field, or operator** — major version bump (v3.0.0). FinHero will coordinate with every active partner before doing this.
- **Manifest schema changes** — bumped via `manifestVersion`. Existing adapters keep working under their declared version. v2.6.0 ships manifestVersion 1.

In practice: build to today's contract. Expect additive changes you can adopt at your own pace; breaking changes will be telegraphed well in advance.

---

## Getting help

- **Issues with the contract itself, JSON-schema, or category fields**: open an issue on [`ExtraGalaxies/finsys-core`](https://github.com/ExtraGalaxies/finsys-core/issues).
- **Integration-specific questions** (your partner-side data shape, your deployment timeline, contractual specifics): contact your FinHero technical liaison directly.
- **Reference implementations**: see `finsim/adapters/*` in [`ExtraGalaxies/finsim`](https://github.com/ExtraGalaxies/finsim).
