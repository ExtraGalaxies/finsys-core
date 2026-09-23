import { describe, expect, it } from 'vitest'

import type { CanonicalInstance, CanonicalView } from './canonical-view.js'
import { flatRecordFromView } from './ihs-processing.js'
import { v1MigrationEntry, v1MigrationKeys } from './v1-migration-map.js'

/**
 * Contract invariants between the v1 migration map and the bridge that serves
 * it. Deliberately NOT scenario tests.
 *
 * Three core defects were found by inspection rather than by any suite —
 * SYS-3596 (17 document keys collapsed N instances to one), SYS-3602
 * (`icInstances` dropped entirely) and SYS-3604 (six keys promised a surface
 * that refuses them). None was reachable by an end-to-end run, and no amount of
 * harness coverage would have caught them, because all three live in code paths
 * NOTHING CURRENTLY EXERCISES. They are Phase 6 time bombs precisely because
 * they are unreached today.
 *
 * A harness tests what the system DOES. These assert what it PROMISES. That is
 * a different instrument, it belongs in the package that owns the contract, and
 * it runs in milliseconds without a container.
 */

const doc = (key: string, path: string, periodPosition?: number): CanonicalInstance =>
  ({
    instanceKey: key,
    adapterId: 'document-intake',
    adapterVersion: 1,
    ...(periodPosition === undefined ? {} : { periodPosition }),
    fields: { pathInDms: { value: path, confidentiality: 'internal' } },
  }) as unknown as CanonicalInstance

describe('v1 contract invariants — the map versus what the bridge actually serves', () => {
  it('every instanceKeyPrefix key returns an ARRAY when instances exist (SYS-3596 class)', () => {
    // v1 held a JSON array in one wide column; v2 keys one instance per file.
    // The bridge used to return the FIRST instance's bare path, so N documents
    // became one string. Fixed for all 17 in 9.2.0 — this stops any one of them
    // regressing, and covers the 14 the original report never observed. 19
    // since SYS-3705 gave experianReports and managementAccounts their entries.
    const prefixKeys = v1MigrationKeys().filter(
      (k) => v1MigrationEntry(k)?.address?.instanceKeyPrefix !== undefined,
    )
    expect(prefixKeys.length, 'premise: the map should declare 19 of these').toBe(19)

    for (const key of prefixKeys) {
      const prefix = v1MigrationEntry(key)!.address!.instanceKeyPrefix!
      const view = {
        ihsId: 1,
        categories: {
          'document-intake': {
            cardinality: 'multi',
            instances: [doc(`${prefix}#a`, '/one', 1), doc(`${prefix}#b`, '/two', 2)],
          },
        },
      } as unknown as CanonicalView

      const value = flatRecordFromView(view).record[key]
      expect(Array.isArray(value), `${key}: v1 held an array; the bridge must not collapse it`).toBe(
        true,
      )
      expect((value as unknown[]).length, `${key}: both documents must survive`).toBe(2)
    }
  })

  it.skip('every structural sidecar the map says v2 exposes is actually emitted (SYS-3602 — icInstances)', () => {
    // SKIPPED, with the reason named rather than the assertion softened.
    //
    // Five structural entries claim "v2 exposes these as <category> instances".
    // Four are emitted by flatRecordFromView's `instances` member. icInstances
    // is not — it is absent from the object AND from the TS interface, so a
    // consumer cannot reach it even by accident, while the docblock above it
    // counts "seven entries" where the map has eight.
    //
    // NOT fixed here on purpose. v1's icInstances emission is field-
    // authorization gated (finsys-api, SYS-2503/3179), so a reconstruction has
    // to inherit that gating or it re-opens a leak. That is a decision for
    // SYS-3602, not a one-liner to slip into a map fix.
    //
    // Flips to live when SYS-3602 ships.
    const declared = v1MigrationKeys().filter((k) => {
      const e = v1MigrationEntry(k)
      return e?.disposition === 'structural' && /v2 exposes these as .* instances/.test(e.note ?? '')
    })
    expect(declared.length, 'premise: five entries make this claim').toBe(5)

    const emitted = Object.keys(
      flatRecordFromView({ ihsId: 1, categories: {} } as unknown as CanonicalView).instances,
    )
    for (const key of declared) {
      expect(emitted, `${key}: the map says v2 exposes it; the bridge must emit it`).toContain(key)
    }
  })

  it('the structural claim and the emitted set disagree by EXACTLY the known gap', () => {
    // The live half of the test above. Pins the size of the gap so it cannot
    // grow quietly while SYS-3602 is open — a second dropped sidecar would fail
    // here even though the assertion above is skipped.
    const declared = v1MigrationKeys().filter((k) => {
      const e = v1MigrationEntry(k)
      return e?.disposition === 'structural' && /v2 exposes these as .* instances/.test(e.note ?? '')
    })
    const emitted = Object.keys(
      flatRecordFromView({ ihsId: 1, categories: {} } as unknown as CanonicalView).instances,
    )
    const missing = declared.filter((k) => !emitted.includes(k))
    expect(missing, 'only icInstances may be missing — see SYS-3602').toEqual(['icInstances'])
  })
})
