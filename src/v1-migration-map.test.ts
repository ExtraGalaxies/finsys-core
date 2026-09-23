/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * SYS-3414 — the closure proof for the v1 migration map.
 *
 * The map was generated, and a generator that emits confident nonsense is the
 * thing this file exists to catch. Two rounds of exactly that happened while
 * it was being built: 20 addresses naming fields no category declares, then
 * 38 addresses that resolved against the WRONG category because the field
 * name was declared by several and the fallback took whichever came first.
 *
 * The generator's own gate cannot be the proof, for the ordinary reason: it
 * runs where the generator runs, once, on a laptop. This runs in core's suite
 * against the registry as it is TODAY, so renaming a canonical field turns
 * the map red instead of leaving a dangling address behind — the map and the
 * vocabulary cannot drift apart silently.
 *
 * WHAT THIS FILE CANNOT PROVE, so nobody reads more into a green run than is
 * there: that the 662 keys ARE the v1 response. Core has never seen that
 * response. Set-equality against a live one belongs in finsim, where a real
 * stack can be asked; this proves internal closure and shape only.
 */
import { describe, expect, it } from 'vitest';

import {
  ADAPTER_CATEGORY_IDS,
  categoryFieldsOf,
  isAdapterCategory,
} from './adapter-categories.js';
import { getDocumentTypeGroups } from './document-types.js';
import {
  V1_MIGRATION_MAP_VERSION,
  v1Addresses,
  v1MigrationEntry,
  v1MigrationKeys,
  v1KeysByDisposition,
  type V1Disposition,
} from './v1-migration-map.js';

const DISPOSITIONS: readonly V1Disposition[] = [
  'mapped',
  'mapped-fanout',
  'mapped-pending-build',
  'relocated',
  'structural',
  'retired',
  'vocabulary-gap',
  'needs-decision',
  // SYS-3604 — v1 serves it, the v2 successor deliberately refuses it, and
  // there is no other destination. Listed here as well as in the source's own
  // set deliberately: this copy is an INDEPENDENT assertion, so a disposition
  // added to the source without thought lands here as a failure.
  'withheld',
];

/** Dispositions that assert a destination exists. Everything else must not carry one. */
const ADDRESSED = new Set<V1Disposition>(['mapped', 'mapped-fanout', 'mapped-pending-build']);

describe('v1 migration map', () => {
  it('publishes a version and a non-trivial key set', () => {
    expect(V1_MIGRATION_MAP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(v1MigrationKeys().length).toBeGreaterThan(600);
  });

  it('every address resolves against the live category registry', () => {
    // THE POINT OF THE WHOLE FILE. Reported as a list, not a bail-on-first:
    // a rename breaks addresses in bulk, and one failure at a time turns one
    // fix into twenty runs.
    const broken: string[] = [];
    for (const key of v1MigrationKeys()) {
      for (const a of v1Addresses(key)) {
        if (!isAdapterCategory(a.category)) {
          broken.push(`${key} -> no such category "${a.category}"`);
          continue;
        }
        const fields = categoryFieldsOf(a.category as (typeof ADAPTER_CATEGORY_IDS)[number]);
        if (!fields.includes(a.field as (typeof fields)[number])) {
          broken.push(`${key} -> ${a.category} declares no field "${a.field}"`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('carries an address exactly when its disposition claims one', () => {
    // Guards both directions. A `retired` key that quietly kept an address
    // reads as a destination; a `mapped` key with none is a rename table
    // entry with the rename missing.
    const wrong: string[] = [];
    for (const key of v1MigrationKeys()) {
      const e = v1MigrationEntry(key)!;
      const n = v1Addresses(key).length;
      if (ADDRESSED.has(e.disposition) && n === 0) wrong.push(`${key} (${e.disposition}) has no address`);
      if (!ADDRESSED.has(e.disposition) && n > 0) wrong.push(`${key} (${e.disposition}) carries an address`);
    }
    expect(wrong).toEqual([]);
  });

  it('a fanout carries at least two DISTINCT attestors', () => {
    // A fanout with one address is a `mapped` entry mislabeled; a fanout
    // whose addresses share a category is one attestor counted twice, and
    // either way a consumer reading "two sources disagree" is being misled.
    const fanouts = v1KeysByDisposition('mapped-fanout');
    expect(fanouts.length).toBeGreaterThan(0);
    for (const key of fanouts) {
      const addrs = v1Addresses(key);
      expect(addrs.length, key).toBeGreaterThanOrEqual(2);
      expect(new Set(addrs.map((a) => a.category)).size, key).toBe(addrs.length);
    }
  });

  it('uses only declared dispositions, and every one of them', () => {
    // The second half matters more than it looks: a disposition nobody uses
    // is a category the generator forgot to emit, and it fails silently
    // because an absent bucket looks exactly like an empty one.
    for (const key of v1MigrationKeys()) {
      expect(DISPOSITIONS, key).toContain(v1MigrationEntry(key)!.disposition);
    }
    for (const d of DISPOSITIONS) {
      expect(v1KeysByDisposition(d).length, `no key is ${d}`).toBeGreaterThan(0);
    }
  });

  it('says WHY for every key it cannot simply redirect', () => {
    // A bare "retired" is the shape that loses data: `city` is retired as a
    // key and live as data under `permanentcity`. The note is the deliverable
    // for these, not a courtesy.
    for (const d of ['retired', 'vocabulary-gap', 'needs-decision'] as const) {
      for (const key of v1KeysByDisposition(d)) {
        const e = v1MigrationEntry(key)!;
        expect((e.note ?? e.reason ?? '').length, `${key} (${d}) has no reason`).toBeGreaterThan(40);
      }
    }
  });

  it('relocated keys name the surface that serves them', () => {
    for (const key of v1KeysByDisposition('relocated')) {
      expect(v1MigrationEntry(key)!.surface, key).toBeTruthy();
    }
  });

  it('an address never carries both an instance key and an instance prefix', () => {
    // They mean different things — one instance, versus collect all of them —
    // and an address carrying both leaves the consumer to pick. Picking
    // `instanceKey` on a fan-out silently reads one file of N.
    for (const key of v1MigrationKeys()) {
      for (const a of v1Addresses(key)) {
        expect(
          a.instanceKey === undefined || a.instanceKeyPrefix === undefined,
          `${key} -> ${a.category}.${a.field} carries both`,
        ).toBe(true);
      }
    }
  });

  it('SYS-3334 round 2 — the six VN prior-year comparative keys are needs-decision, not mapped (the map correction)', () => {
    // netProfitPriorYearT1..T3 / totalEquityPriorYearT1..T3 used to resolve
    // through the SAME wide-column-feeder address as their current-year
    // siblings (netProfitT{n} / totalEquityT{n}): financialStatementSpecVN.ts
    // writes the comparative on the SAME row as the current-year value, the
    // registry declares no PriorYear field, and the T-suffix-stripping the
    // generator uses to find a feeder collapses "PriorYearT1" and "T1" to
    // the same base — so a forward walk through the map returned the
    // CURRENT-year value under the PRIOR-year name. Pinned here so a future
    // map regen cannot silently put them back without this test noticing.
    for (const base of ['netProfitPriorYear', 'totalEquityPriorYear']) {
      for (const n of [1, 2, 3]) {
        const key = `${base}T${n}`;
        expect(v1MigrationEntry(key)!.disposition, key).toBe('needs-decision');
        expect(v1Addresses(key), key).toEqual([]);
      }
    }
    // The six moved OUT of `mapped` and INTO `needs-decision` — nowhere else.
    // 671 since SYS-3570: the four `tangibleAssets*` keys moved the other way,
    // out of `vocabulary-gap` and into `mapped`, once financial-statement
    // declared the field their reason said they needed. `needs-decision` is
    // UNCHANGED at 11 — deliberately, because `currentAssetCash*` sits there
    // and did not ride along (SYS-3574 owns that call). 673 since SYS-3705:
    // two NEW keys (the experianReports / managementAccounts pointers), not
    // moved ones — every other disposition's count is untouched.
    expect(v1KeysByDisposition('mapped').length).toBe(673);
    expect(v1KeysByDisposition('needs-decision').length).toBe(11);
  });

  it('SYS-3570 — the four tangibleAssets keys address the declared field, and currentAssetCash is NOT dragged along with them', () => {
    // The gap was silent in the direction that matters: finsys-api's
    // computeMetrics writes `metrics.tangibleAssets` for every period (from
    // the extraction's own total-tangible-assets line, falling back to
    // totalAssets - intangibles), but the v2 read enumerates from core's
    // category registry rather than from row keys — a column core does not
    // declare cannot appear on the wire. So every eval model addressing
    // `tangibleAssets@financialStatement/...` scored WITHOUT it and reported
    // no error, including the shipped default SME template.
    for (const key of ['tangibleAssets', 'tangibleAssetsT1', 'tangibleAssetsT2', 'tangibleAssetsT3']) {
      expect(v1MigrationEntry(key)!.disposition, key).toBe('mapped');
      expect(v1Addresses(key), key).toEqual([{ category: 'financial-statement', field: 'tangibleAssets' }]);
    }

    // The negative half, and the reason it is in the SAME test rather than a
    // neighbouring one: these two keys arrived at the same sweep together and
    // read as one job. They are not. `currentAssetCash` is `needs-decision`,
    // NOT `vocabulary-gap` — the category already declares six overlapping
    // cash fields, and which of them the extractor populates is the
    // financial-statement owner's call (SYS-3574), not a name lookup. A
    // future edit that "finishes the pair" by giving it an address makes this
    // red, which is the point.
    for (const key of ['currentAssetCashT1', 'currentAssetCashT2', 'currentAssetCashT3']) {
      expect(v1MigrationEntry(key)!.disposition, key).toBe('needs-decision');
      expect(v1Addresses(key), key).toEqual([]);
    }
  });

  it('SYS-3517 — every per-category instance sidecar v1 serves has a disposition, icInstances included', () => {
    // `icInstances` was ABSENT from the map while five sibling sidecars were
    // present, so a consumer porting off v1 had no answer for exactly one
    // category. The cause is the one this file's generator docstring already
    // names for `consents`: THE KEY LIST IS A UNION OF LIVE RECORDS, and
    // finsys-api emits this key CONDITIONALLY —
    // `if (canonicalRows.ic?.length) data.icInstances = ...`
    // (ihsService.ts) — where the other five are assigned unconditionally,
    // as `[]` when empty. No sampled record had an IC extraction row, so no
    // measurement could ever have contained the key, and nothing could
    // report it missing. Checked 2026-08-22: of the seven conditionally
    // assigned keys in that serializer, this was the only one the union
    // missed.
    for (const key of [
      'financialStatementInstances',
      'bankStatementInstances',
      'epfStatementInstances',
      'payslipInstances',
      'invoiceInstances',
      'icInstances',
    ]) {
      expect(v1MigrationEntry(key), key).not.toBeNull();
      expect(v1MigrationEntry(key)!.disposition, key).toBe('structural');
    }
  });

  it('v1Addresses returns every attestor, not just the first', () => {
    // Proves the accessor a consumer will actually loop over, on the one
    // shape where taking [0] silently drops half the answer.
    const fanouts = v1KeysByDisposition('mapped-fanout');
    // Guard the index rather than assert it away: with no fanout key this
    // would throw a TypeError that reads like a bug in the accessor.
    expect(fanouts.length, 'no fanout key to exercise').toBeGreaterThan(0);
    const key = fanouts[0]!;
    expect(v1Addresses(key).length).toBe(v1MigrationEntry(key)!.addresses!.length);
    expect(v1Addresses('a-key-that-does-not-exist')).toEqual([]);
    expect(v1MigrationEntry('a-key-that-does-not-exist')).toBeNull();
  });

  // ── SYS-3604 ──────────────────────────────────────────────────────────
  it('never promises a surface for a key that surface refuses to serve', () => {
    // `surface` is a PROMISE about where to go and get the value, and it is
    // not decorative: flatRecordFromView quotes it back to the caller in its
    // `unplaced` reason. Six keys promised GET /lender/applications/:ihsId
    // while applicationRecordService had deliberately removed them in review
    // — so the map told consumers to fetch from an endpoint that refuses.
    //
    // The generator now reads the endpoint's own source and emits `withheld`
    // instead. This pins the OUTCOME, so the six cannot quietly drift back to
    // a claim if that check is ever bypassed or hand-edited.
    const WITHHELD_BY_APPLICATION_RECORD = [
      'lenderId',
      'assignedFromUserId',
      'assignedToUserId',
      'createdBy',
      'updatedBy',
      'finxtractConfigId',
    ]

    for (const key of WITHHELD_BY_APPLICATION_RECORD) {
      const entry = v1MigrationEntry(key)
      expect(entry, `${key} should still be in the map`).toBeDefined()
      expect(entry!.disposition, `${key} is not relocated — nothing serves it`).toBe('withheld')
      expect(entry!.surface, `${key} must promise no surface`).toBeUndefined()
      // Withheld without a reason is the same defect one step on: it reads as
      // answered and is not.
      expect(entry!.reason, `${key} must say WHY`).toBeTruthy()
    }
  })

  it('every withheld key says why, and no relocated key is left without a surface', () => {
    // The pair of invariants that make `withheld` honest rather than a place
    // to hide keys nobody wants to think about.
    let withheld = 0
    for (const key of v1MigrationKeys()) {
      const e = v1MigrationEntry(key)!
      if (e.disposition === 'withheld') {
        withheld++
        expect(e.reason, `${key}: withheld must carry a reason`).toBeTruthy()
        expect(e.surface, `${key}: withheld must NOT name a surface`).toBeUndefined()
      }
      if (e.disposition === 'relocated') {
        expect(e.surface, `${key}: relocated must name its surface`).toBeTruthy()
      }
    }
    // Premise guard: if this ever reads zero the assertions above are vacuous.
    expect(withheld, 'no withheld keys — this test proves nothing').toBeGreaterThan(0)
  })

  it('every document type core registers has a pointer disposition, so a new type cannot ship without one (SYS-3705)', () => {
    // finsim's spec 131 found this from the outside: finsys-api began serving
    // `experianReports` and `managementAccounts` in its v1 response and the map
    // had no answer for either. The set is DERIVED from the doc-type registry,
    // never listed here, so the next document type fails this test the day it
    // is registered, not the day a harness samples a record that carries it.
    const types = getDocumentTypeGroups().map((g) => g.documentType);
    // Premise guard: an empty registry would pass vacuously.
    expect(types.length, 'no document types registered — this test proves nothing').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const docType of types) {
      const e = v1MigrationEntry(docType);
      const ok =
        e !== null &&
        e.disposition === 'mapped' &&
        e.address?.category === 'document-intake' &&
        e.address.field === 'pathInDms' &&
        e.address.instanceKeyPrefix === docType &&
        e.address.instanceKey === undefined;
      if (!ok) missing.push(docType);
    }
    expect(
      missing,
      'document type(s) with no document-intake pointer disposition in the v1 migration map',
    ).toEqual([]);
  });

});
