# Security Model

What partner adapter authors should assume about how their code runs inside FinSys, what's expected of them, and what's not yet finalised.

This document reflects the v2.6.0 contract state. The production deployment model (covered by SYS-2444) is still being designed; sections marked **TBD** will be expanded when that work lands. None of the TBD pieces affect the adapter contract itself — your adapter code stays the same; only the surrounding operational posture matures.

---

## Today's posture

### Execution context

- Adapters run **in-process** inside the FinSys host today. There's no per-adapter container or sandbox yet.
- The host is a Node.js process; your adapter is `import()`-ed dynamically at registration time.
- Network egress and filesystem access are inherited from the host process — anything the host can do, your adapter can do.

This is fine for the small set of trusted, FinHero-authored adapters that ship in v2.6.0. **It's the explicit shape that needs to change before unrelated third-party adapters share a process.** Sandboxing roadmap is below.

### Path-traversal protection

The manifest's `entryPoint` field rejects:

- Absolute paths (anything starting with `/`)
- Path-traversal segments (anything containing `..`)

Enforced at two layers:

1. JSON-schema regex at manifest validation (registration-time).
2. Runtime check in the host after `path.resolve()` — `entryPath` must remain inside the adapter directory.

The double-layer is deliberate. A future schema bug or bypass shouldn't expose arbitrary-file-load.

### Secrets

**Adapters MUST NOT embed credentials in the manifest, the entry-point module, or the package**. Specifically:

- No API keys, OAuth tokens, partner certificates, or shared secrets in `manifest.json` (notes field, anywhere)
- No hardcoded credentials in `extract.js`
- No `.env` files in the adapter directory

If your adapter needs to authenticate to your partner-side API, that authentication should happen **before** the host calls `extract()` — the raw payload handed in is already-authenticated data. The orchestration layer that fetches partner data is FinHero's responsibility, not the adapter's.

If your adapter shape requires the adapter itself to call partner APIs (rare; preferred is a separate fetcher), credentials reach `extract()` via the `raw` payload's metadata — never hardcoded.

### Data handling

- Adapters receive partner payloads in memory and produce canonical instances in memory. No persistence is done by the adapter.
- The host persists canonical rows to FinSys's data store. Your adapter never touches the database directly.
- Raw payloads are captured by the host into the `raw_payloads` table for provenance and replay. **Assume the raw payload is durably stored**; if your partner has data-retention obligations on the source side, raise them with FinHero ahead of integration so the storage policy can match.

### Telemetry

Today: the host wraps `extract()` invocations in a span and records success/failure on `adapter_runs`. **Your adapter should not emit its own telemetry** (no third-party tracers, no analytics packages, no log shippers). If extraction-side observability matters to you, surface it via the `AdapterError` reason and the host will route it appropriately.

### Failure isolation

- Adapter failures (thrown errors, unhandled rejections, timeouts) are caught by the host. The host records the failure on `adapter_runs` and continues processing.
- A failing adapter does NOT prevent other adapters from running on the same applicant.
- A failing adapter does NOT block IHS workflow progression — downstream consumers see the canonical fields as `null` for that adapter and the eval engine treats them as no-signal.

What this means for you: **don't try to recover by spawning child processes, retrying inside extract, or holding state across calls**. Throw the appropriate `AdapterError` and let the host decide the retry policy.

---

## What you SHOULD do

✅ Validate the raw payload at the top of `extract()`. Throw `AdapterError('payload_invalid', ...)` on shape mismatch — surfaces faster than a downstream computation NaN.

✅ Make `extract()` pure where possible: same input → same canonical output. Deterministic adapters are easier to debug and replay.

✅ Use the typed `AdapterError` discriminators (`payload_invalid`, `partner_transient`, `partner_permanent`, `mapping_failed`). They drive host-side retry policy.

✅ Keep dependencies minimal. Every npm package you add to your adapter's `package.json` is a package the host has to install and audit. If you can solve it in a few lines of vanilla JS, do.

✅ Pin versions on what you DO depend on. The host installs your `package.json` as-is.

✅ Bump your adapter `version` on any output-affecting change. Provenance depends on it.

✅ Document your raw payload shape in the adapter's README so FinHero can prepare test fixtures.

---

## What you MUST NOT do

❌ **Don't embed credentials.** See above.

❌ **Don't read or write files outside your adapter directory.** The host runs from a different working directory; relative paths are unreliable, and absolute paths bypass the sandboxing roadmap.

❌ **Don't open network sockets from inside `extract()`.** Partner-side data fetching happens upstream of your adapter. If your adapter needs network access, raise it with FinHero so we can plan around the egress posture.

❌ **Don't spawn child processes.** Same reason as network.

❌ **Don't depend on `process.env`** for behaviour switching. Adapter behaviour should be determined by the manifest + raw payload, not by host environment. (Reading `NODE_ENV` is harmless; reading custom env vars to gate logic isn't.)

❌ **Don't mutate `raw` or any shared state.** Treat the raw payload as immutable.

❌ **Don't catch + swallow errors silently.** If extraction can't complete, throw. The host's failure-isolation only works if failures are visible.

❌ **Don't add randomness to extract.** Deterministic same-in / same-out is what makes replay possible.

---

## Coming soon (TBD — SYS-2444 and beyond)

The pieces below are NOT in v2.6.0 but are on the near-term roadmap. They will be added without breaking the v2.6.0 adapter contract — your adapter code stays the same, the host's posture around it tightens.

### Sandboxing

The current "in-process" execution model is fine for FinHero-authored adapters. Once we have multiple third-party adapters in the same FinSys process, we'll add a capabilities-style sandbox: per-adapter allow-lists for filesystem read, network egress, env access, etc. This is being designed as part of SYS-2444.

**What you can do today to be ready**: stay within the "what you MUST NOT do" list above. Adapters that follow those rules will need zero changes when the sandbox lands.

### Capabilities declaration

A future manifest field (`capabilities: { network: [...], fs: [...] }` or similar) will let adapters declare what they need, and the host will enforce it. If your adapter genuinely needs (say) outbound HTTP to a specific partner endpoint, you'll declare it and the operator console will surface the capability for approval.

### Signed manifests

Manifests and entry points will be cryptographically signed by the deploying party. The host will verify the signature at registration. This makes "who shipped this adapter" non-repudiable and lets us roll back compromised adapters fast.

### Secrets injection

A FinHero-side secrets-broker will inject partner-specific credentials into the raw payload pipeline (upstream of `extract()`). Your adapter will receive the credentialed payload but won't see or store the credentials. The exact injection shape is part of SYS-2444 design.

### Per-adapter resource limits

CPU time, memory, max payload size — soft limits enforced by the host. Today: best-effort and untimed. Soon: enforced limits with sensible defaults (e.g., 30s wall clock, 256MB heap, 10MB payload). Your adapter should already be fast and memory-light; the limits will codify what's already implicit.

### Audit log surface

Operator console will have an "Adapter runs" view showing every invocation, its outcome, the IHS it ran on, latency, and the produced canonical rows. The data model (`adapter_runs` + `raw_payloads` tables) is in place; the UI is on the roadmap.

---

## Reporting security issues

If you find a security issue in `@finsys/core`, the manifest schema, the host runtime, or any reference adapter: **don't open a public GitHub issue**. Email `security@finhero.asia` directly. We will acknowledge within one business day.

If you find a security issue in your own adapter post-delivery: contact your FinHero technical liaison immediately. We have an emergency disable-adapter path that takes effect within minutes.
