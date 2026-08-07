# Adding a jurisdiction

What it actually takes to make the platform serve a new country, in the order
you have to do it, with the parts that are genuinely additive separated from
the parts that are not.

Written from doing it twice: **Vietnam** (SYS-2870/2876, the first, which was
mostly discovery) and **Thailand** (SYS-3258, the second, which was the test of
whether the first had left an axis or a special case). Thailand cost two edits
in this package and both were named by failing tests rather than found by hand.
That is the bar to hold.

> **Two jurisdictions cannot tell you whether an axis is additive**, because
> the second one is always the case somebody special-cased. Only the third
> proves anything. If you are adding the third or later and find yourself
> editing more than the config listed in Phase 1, that is a finding — write it
> down rather than working around it.

---

## Phase 0 — decide what "supported" means for this country

Answer these before writing code, because they change the size of the job by an
order of magnitude:

| Question | If no | If yes |
|---|---|---|
| Does it need **document extraction**? | Phases 1–3 only. A program can have forms that collect nothing but scalars. | Add Phase 4 (a document spec, an extractor endpoint, possibly a language slot). |
| Do its documents come in **more than one language**? | Nothing extra. | You need a `document_language_options` slot — see the note in Phase 4, and read SYS-3277 before assuming it is blocked. |
| Does it have **its own scoring model**? | Nothing extra. | That is the evaluation engine, out of scope here. |
| Is the currency **zero-decimal** (VND, JPY, KRW)? | Nothing extra — `Intl` knows. | Still nothing extra, but check the display audit in Phase 3. |

**A jurisdiction with no document extraction is a legitimate, complete
jurisdiction.** Forms need not carry file fields at all. Do not treat the
document axis as a prerequisite; it is one optional capability among several.

---

## Phase 1 — the registry (`@finsys/core`)

This is the additive part, and it should stay that way.

1. **`src/jurisdiction.ts`** — add the code to `JURISDICTION` and its display
   currency to `JURISDICTION_DISPLAY_CURRENCY`. These are two entries in two
   frozen objects.
2. **`schema/unified-form.schema.json`** — add the code to the `jurisdiction`
   enum. This is a **deliberate second source of truth**: FinHub validates form
   configs through the schema and never through `FormSpec`, so it *can* drift.
   `adapter-category-drift.test.ts` is why it cannot drift silently — it will
   fail and name the missing code.
3. Release core, then bump consumers. See "Release order" below — it is not
   arbitrary.

**What you must NOT need to touch:** `resolveJurisdiction`,
`checkJurisdictionCompatibility`, `resolveDisplayCurrency`, `formatMoney`, or
any consumer's filtering logic. All of them read the registry. If a new
jurisdiction requires editing one of them, the abstraction has sprung a leak
and that is the bug to fix, not the country to special-case.

### The rules the registry already enforces, so you do not re-derive them

- **Absence resolves to Malaysia** (`DEFAULT_JURISDICTION`), because every row
  predating jurisdictions is Malaysian. An **empty string is not absence** — it
  is `NO_JURISDICTION_BASIS`, meaning "no basis to name one", and it yields no
  currency rather than MYR.
- **An unrecognized code is compatible with nothing**, including an identical
  unrecognized code on the other side. Two sides both saying `"VM"` is the same
  typo twice, not agreement.
- **Fail closed.** An unregistered jurisdiction gets no extractor, no currency
  and no Malaysia fallback.

---

## Phase 2 — the operator path (`finhub-adonisjs`)

Usually **zero code**. The admin program form reads `JURISDICTION_CODES` from
core, so the new option appears with the core bump (SYS-3271 exists precisely
so the set an operator can choose cannot drift from the set the gate enforces).

What to check rather than assume:

- The jurisdiction **badge renders the country in words**, not the code. A
  borrower cannot be expected to read `TH`. If the word is missing, that is a
  translation table somewhere that did not get the memo.
- A program's jurisdiction is **fixed after creation** (SYS-3273). Adding a
  country does not change that.

---

## Phase 3 — currency, in every front end

This is the part that gets forgotten, because nothing fails — it just renders
the wrong word next to a number, and the number is right.

**The rule: a currency belongs to the value, never to the field definition, and
never to a label.**

- Never write a currency into a label, placeholder or validator message. A
  field that holds money declares `kind: "money"`; the *denomination* comes
  from the program's jurisdiction at render time or from the value's own
  provenance envelope. (SYS-3249, SYS-3289.)
- Use `formatMoney(value, { currency, jurisdiction })` from this package. Do
  not hand-roll `toLocaleString` — VND is zero-decimal, and a hardcoded
  `minimumFractionDigits: 2` invents two decimal places of precision the
  document never had.
- `jurisdiction` is a **required** key. Pass `NO_JURISDICTION_BASIS` when there
  genuinely is no basis; the result then carries no currency, which is honest
  where a guess is not.

Surfaces to audit when adding a country — grep each for a hardcoded `RM`,
`MYR`, or `Intl.NumberFormat`:

| Repo | Where |
|---|---|
| `finhub-adonisjs` | IHS list + detail, applications list, client dashboard, consent events, the **form renderer** (`FieldRenderer`) |
| `finsys-client` | IHS list + detail, evaluation views, analytics charts, file exports, **and the text fed to the AI analyst** |
| `lead-gen-ui` | any amount shown on a landing form |

The AI-analyst path is the one that bites: a hardcoded `RM` there does not
merely display wrong, it makes the model *reason* in the wrong currency.

**Billing is a separate domain and is not jurisdiction-aware.** FinHub bills
domestic clients in MYR and everyone else in USD, from `BillingModel.currency`.
A borrower's jurisdiction has no bearing on what FinHub charges. Never wire the
two together. The company dashboard's USD base is a deliberate exchange-rate
conversion so totals across countries are addable — that is correct, not a bug.

---

## Phase 4 — document extraction (only if Phase 0 said yes)

Skip this entirely for a jurisdiction whose forms collect no documents.

1. **A financial-statement spec.** Use `makeSingleInstanceFinancialSpec` in
   finsys-api — a country is a config object (adapter id, field mapping,
   provenance source, label prefix, tangible-assets key), not a file of logic.
   Copying the previous country's file is how "additive" quietly becomes
   surgery.
2. **Register it** so `financialStatementSpecFor(jurisdiction)` resolves. An
   unregistered jurisdiction must fail closed — no endpoint, no row, no
   Malaysia fallback.
3. **An extractor endpoint** on the FinXtract side, plus the stub's equivalent
   in finsim so the sim can dispatch to it.
4. **A CI-visible unit suite for the spec.** Vietnam had 192 lines; Thailand
   initially had none, and a review that corrupted every field of the TH spec
   still passed 3142/3142. A config object with no test is asserted by nothing.

### The language slot, and what SYS-3277 actually says

`document_language_options` is tagged on **`financials_vn` only**, and
`document-types.test.ts` asserts every other field leaves it `undefined` —
absence of the tag is what hides the language selector in the UI.

That is a **leak guard on one document slot**, not a gate on onboarding a
country. Read it precisely:

- It does not block adding a jurisdiction. Thailand was added and works.
- It does not block that jurisdiction having documents — Thailand's spec exists.
- It blocks *offering a language chooser* on a slot that has not been given
  one, which is the intended behavior.

If a new country's documents genuinely arrive in two languages, the work is to
add its slot and widen that test — a change to two files, with the test telling
you the second one. **Do not repeat "SYS-3277 blocks new jurisdictions"; it
does not.** It was written up that way once and the framing was wrong.

---

## Phase 5 — prove it in the sim

A jurisdiction nobody exercised end to end is a configuration, not a feature.

1. **`e2e/tests/85_sys_3258_multinational.spec.ts`** — the three-country spec.
   Add the new lane. Its assertions are **exact-set**, not "contains", so
   adding a country without updating it fails loudly rather than passing
   vacuously.
2. **`demo/tarpon`** — the two-tab walkthrough. A new jurisdiction is a third
   program, a third form, and one more submission beat. Everything else is
   driven off the state file.
3. **Assert the currency the borrower is ASKED for**, not just what is stored.
   The demo asserts the financing label names this jurisdiction's currency
   **and no other** — two-sided, because the bug being guarded against rendered
   a perfectly well-formed `(RM)` and a one-sided check passes against it.
4. **Write the expected values out**, do not import them. A test that reads the
   currency map from the same module the app reads it from cannot fail when the
   map is wrong — only when the plumbing between them breaks.
5. **Mutation-test the new lane.** Point the new country at the wrong currency
   and confirm the assertion fires; create its program without a jurisdiction
   and confirm the seed refuses. A green lane that has never been shown to go
   red is decoration.

---

## Release order — this is not arbitrary

1. `@finsys/core` — publish the registry.
2. `finsys-api` — the stamping and extraction side, **to prod**, before any UI
   claims the country works.
3. `finhub-adonisjs` — trunk-to-prod, so merging *is* releasing. Its renderer
   must be live **before** any form-spec template stops naming a currency,
   because the renderer's legacy fallback is what keeps stored `(RM)` labels
   rendering correctly. Reverse the order and Malaysian sliders lose their
   currency entirely — a wrong currency traded for none.
4. `finsys-client` — a **release train**. Merged is not released; old builds
   keep hitting new backends indefinitely. Anything it needs from finsys-api
   must be in prod before the signed build broadcasts.

---

## The failure modes this document exists to prevent

- **Silent MYR.** Something renders an amount with no jurisdiction in hand and
  gets Malaysia by default. Correct for a legacy record, a fabrication
  anywhere else.
- **Currency as prose.** A label that says `(RM)` is Malaysian by typography and
  no code can correct it.
- **The second-country illusion.** With two jurisdictions, "filters correctly"
  and "shows the one that isn't Malaysia" are the same rule. Only a third
  distinguishes them.
- **Config with no test.** Registry entries and spec config objects are data;
  nothing else fails when they are wrong.
- **Plumbing mistaken for product.** VN and TH support one document type
  against Malaysia's eight. The platform is multi-national; say so precisely
  rather than letting a green demo imply parity.
