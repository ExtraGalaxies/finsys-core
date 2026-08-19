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
    expect(v1KeysByDisposition('mapped').length).toBe(667);
    expect(v1KeysByDisposition('needs-decision').length).toBe(11);
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
});
