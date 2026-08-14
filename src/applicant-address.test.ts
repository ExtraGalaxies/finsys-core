import { describe, it, expect } from "vitest";
import {
  ADAPTER_CATEGORY_IDS,
  categoriesAttestingFact,
  categorySchemaOf,
} from "./adapter-categories.js";

/**
 * SYS-3336 — applicant-address.
 *
 * The wide `ihs` table spends a whole column family on each of three
 * addresses (permanent, residential, office) and cannot hold a fourth. Every
 * assertion here exists to stop that limit being re-encoded into the canonical
 * model, where it would be permanent: a wrong field name is repairable, an
 * address nobody could record is not.
 */
describe("applicant-address (SYS-3336)", () => {
  it("is registered, with its own canonical table", () => {
    expect(ADAPTER_CATEGORY_IDS).toContain("applicant-address");
    expect(categorySchemaOf("applicant-address").canonicalTable).toBe(
      "ihs_alt_data_applicant_address",
    );
  });

  it("declares one address, not three prefixed ones", () => {
    // The whole point. permanentaddressLine1 / residentialaddressLine1 /
    // officeaddressLine1 collapse to ONE addressLine1, told apart by the
    // instance key. A field named for its block would mean a fourth address
    // needed a schema change, which is the state this replaces.
    const names = categorySchemaOf("applicant-address")
      .fields.map((f) => f.name)
      .sort();
    expect(names).toEqual([
      "addressCity",
      "addressCountry",
      "addressLine1",
      "addressLine2",
      "addressLine3",
      "addressPostcode",
      "addressStateCode",
      "occupancyMonths",
      "occupancyYears",
    ]);
    expect(names.filter((n) => /permanent|residential|office/i.test(n))).toEqual([]);
  });

  /**
   * person-identity attests personAddress — one free-text blob, the address as
   * printed on a MyKad. This category attests a STRUCTURED address, across up
   * to three instances, none of which is obviously the one the document names.
   *
   * Co-attesting would require both an address normalizer and a decision about
   * which instance corresponds to the document, and neither exists. Declaring
   * the fact anyway would put every applicant into the disagreement surface
   * with a conflict that is an artifact of shape, not of what they said.
   *
   * SYS-3336's own text says ic ships icAddress with no fact. That was true
   * when the ticket was written and stopped being true with SYS-3333, which
   * gave personAddress one — so the decision recorded here is the live one.
   */
  it("does NOT co-attest the document's address blob", () => {
    for (const f of categorySchemaOf("applicant-address").fields) {
      expect(f.fact).toBeUndefined();
    }
    // The document side keeps it, and there are TWO of them — an EPF statement
    // carries an address as well as an IC does. Both attest the same free-text
    // blob as each other, which is why they legitimately share the fact and
    // this category does not.
    // Copied before sorting: categoriesAttestingFact returns a FROZEN array,
    // and sorting it in place throws rather than quietly reordering shared
    // registry state — which is the right call, and worth not fighting.
    expect([...categoriesAttestingFact("personAddress")].sort()).toEqual([
      "epf-statement",
      "person-identity",
    ]);
    expect(categoriesAttestingFact("personAddress")).not.toContain("applicant-address");
  });

  it("keeps the residency duration as two figures, each with its own unit", () => {
    // The form collects years and months as separate inputs and form intake
    // has no transform slot, so folding them into one number here would invent
    // a value the applicant never gave. Both units must therefore exist.
    const by = new Map(categorySchemaOf("applicant-address").fields.map((f) => [f.name, f] as const));
    expect(by.get("occupancyYears")?.unit).toBe("years");
    expect(by.get("occupancyMonths")?.unit).toBe("months");
  });

  it("keeps the postcode a string, so a leading zero survives", () => {
    expect(by("addressPostcode").type).toBe("string");
  });

  it("declares no enum kind — the state choice set is per form", () => {
    // kind "enum" promises a CLOSED label set and the host makes every
    // producing adapter enumerate it. A form-intake adapter spanning 60
    // heterogeneous form configs cannot; the host refused two adapters over
    // exactly this under SYS-3338.
    expect(by("addressStateCode").kind).toBeUndefined();
  });

  it("resolves every field to sensitive, because none opts out", () => {
    for (const f of categorySchemaOf("applicant-address").fields) {
      expect(f.confidentiality).toBe("sensitive");
    }
  });
});

function by(name: string) {
  const f = categorySchemaOf("applicant-address").fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}
