// Run under `node --disallow-code-generation-from-strings`, which makes `eval`
// and `new Function` throw exactly as a Content-Security-Policy without
// 'unsafe-eval' does in a browser. Imports the built package entry, then calls
// the runtime exports a browser page uses.
//
//   node --disallow-code-generation-from-strings \
//     scripts/check-no-code-generation.mjs dist/index.js
//
// Prints one line per check and exits 1 if any failed.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = resolve(process.argv[2] ?? "dist/index.js");
const results = [];
const check = (name, fn) => {
  try {
    const value = fn();
    results.push({ name, ok: value === true, detail: value === true ? "" : `returned ${JSON.stringify(value)}` });
  } catch (e) {
    results.push({ name, ok: false, detail: `threw ${e?.name}: ${e?.message}` });
  }
};

// Without this the run proves nothing: the flag must actually be on.
check("code generation is blocked", () => {
  try {
    new Function("return 1")();
    return "new Function ran";
  } catch {
    return true;
  }
});

let m;
try {
  m = await import(pathToFileURL(entry).href);
  results.push({ name: "import the package entry", ok: true, detail: "" });
} catch (e) {
  results.push({ name: "import the package entry", ok: false, detail: `threw ${e?.name}: ${e?.message}` });
}

if (m) {
  const config = {
    displayName: "Test Loan",
    categories: [{ id: "general", name: "General" }],
    fields: {
      employmentType: { type: "dropdown", displayName: "Employment", category: "general", choices: ["01", "02"] },
      employer: {
        type: "text",
        displayName: "Employer",
        category: "general",
        required: true,
        visibleIf: "{employmentType} anyof ['01']",
      },
      carPrice: { type: "text", inputType: "number", displayName: "Car Price", category: "general", min: 1000, max: 500000 },
    },
    pages: [{ id: "step1", title: "Step 1", fields: ["employmentType", "employer", "carPrice"] }],
  };
  const expr = "{employmentType} anyof ['01']";

  check("evaluateExpression, shown", () => m.evaluateExpression(expr, { employmentType: "01" }) === true);
  check("evaluateExpression, hidden", () => m.evaluateExpression(expr, { employmentType: "02" }) === false);
  check("generateRHFSchema", () => typeof m.generateRHFSchema(config).zodSchema.safeParse === "function");
  check("schema skips a hidden required field", () => {
    return m.generateRHFSchema(config).zodSchema.safeParse({ employmentType: "02", carPrice: 2000 }).success === true;
  });
  check("schema enforces a shown required field", () => {
    return m.generateRHFSchema(config).zodSchema.safeParse({ employmentType: "01", carPrice: 2000 }).success === false;
  });
  check("groupFieldsByCategory", () => {
    const r = m.generateRHFSchema(config);
    return m.groupFieldsByCategory(r.fields, config.categories).length > 0;
  });
  check("getDocumentTypeGroups", () => Array.isArray(m.getDocumentTypeGroups()) && m.getDocumentTypeGroups().length > 0);
  check("resolveDisplayCurrency", () => typeof m.resolveDisplayCurrency("myr", m.DEFAULT_JURISDICTION) === "string");
  check("formatDocumentSize", () => m.formatDocumentSize(2048) === "2.0 KB");
  check("isJurisdiction", () => m.isJurisdiction(m.DEFAULT_JURISDICTION) === true);
  check("getDocDisplayNames", () => Object.keys(m.getDocDisplayNames()).length > 0);
}

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
