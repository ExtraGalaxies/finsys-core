import { describe, expect, it } from 'vitest'

import type { CanonicalInstance, CanonicalView } from './canonical-view.js'
import { buildDocumentRows, flatRecordFromView, parseFileField } from './ihs-processing.js'
import v1MigrationMap from './data/v1-migration-map.json' with { type: 'json' }

/**
 * SYS-3596 — the v1-compat bridge collapsed N documents to one.
 *
 * v1 held a JSON array in one wide column. v2 keys one `document-intake`
 * instance per file (`<docType>#<sha256>`). `valueAtInstanceKeyPrefix` resolved
 * the v1 key by taking the FIRST matching instance and returning its single
 * `pathInDms`, so six bank statements came back as one bare URL string.
 *
 * It survived review because its docblock called first-in-order "the stated
 * parity choice", on the premise that "v1 held ONE value per pointer column".
 * The migration map's own entry for each of these keys says the opposite —
 * "SHAPE CHANGE, not a rename" — seventeen times over.
 */

const doc = (key: string, path: string, extra: Partial<CanonicalInstance> = {}): CanonicalInstance => ({
  instanceKey: key,
  adapterId: 'document-intake',
  adapterVersion: 1,
  fields: { pathInDms: { value: path, confidentiality: 'internal' } },
  ...extra,
})

const viewWith = (instances: CanonicalInstance[]): CanonicalView =>
  ({
    ihsId: 5069,
    categories: { 'document-intake': { cardinality: 'multi', instances } },
  }) as unknown as CanonicalView

/** Six bank statements, deliberately NOT in period order, to pin ordering. */
const SIX = [
  doc('bankStatements#aaa1', 'https://dms/ac469bf0', { periodPosition: 1 }),
  doc('bankStatements#aaa3', 'https://dms/33333333', { periodPosition: 3 }),
  doc('bankStatements#aaa2', 'https://dms/568dce53', { periodPosition: 2 }),
  doc('bankStatements#aaa6', 'https://dms/66666666', { periodPosition: 6 }),
  doc('bankStatements#aaa4', 'https://dms/44444444', { periodPosition: 4 }),
  doc('bankStatements#aaa5', 'https://dms/55555555', { periodPosition: 5 }),
]

describe('SYS-3596 — document-intake keys aggregate rather than collapse', () => {
  it('the migration map declares this SHAPE CHANGE on every affected key — the premise the old docblock denied', () => {
    // The guard that makes the rest of this file non-vacuous: if these
    // entries ever stop saying "SHAPE CHANGE", the collapse might be correct
    // again and these tests would be asserting the wrong contract.
    const entries = (v1MigrationMap as { entries?: Record<string, unknown> }).entries ?? v1MigrationMap
    const prefixed = Object.entries(entries as Record<string, { address?: { instanceKeyPrefix?: string } }>).filter(
      ([, v]) => v?.address?.instanceKeyPrefix !== undefined,
    )
    expect(prefixed.length).toBeGreaterThanOrEqual(17)
    for (const [key, entry] of prefixed) {
      expect(JSON.stringify(entry), `${key} should declare the shape change`).toContain('SHAPE CHANGE')
    }
  })

  it('returns ALL six documents, not the first — the defect itself', () => {
    const value = flatRecordFromView(viewWith(SIX)).record.bankStatements
    expect(Array.isArray(value), `expected an array, got ${typeof value}`).toBe(true)
    expect((value as unknown[]).length).toBe(6)
  })

  it('orders by periodPosition, not by view order', () => {
    const value = flatRecordFromView(viewWith(SIX)).record.bankStatements as Array<{ path: string }>
    expect(value.map((e) => e.path)).toEqual([
      'https://dms/ac469bf0',
      'https://dms/568dce53',
      'https://dms/33333333',
      'https://dms/44444444',
      'https://dms/55555555',
      'https://dms/66666666',
    ])
  })

  it('emits {path} OBJECTS, never bare strings — bare strings break the consumer worse than the collapse did', () => {
    // parseFileField returns an already-parsed array as-is, so an array of
    // bare strings reaches buildDocumentRows with `file.path === undefined`
    // on every entry: six rows, none downloadable. That fix would LOOK right
    // (it is an array!) while being worse than the bug.
    const value = flatRecordFromView(viewWith(SIX)).record.bankStatements as unknown[]
    for (const entry of value) {
      expect(typeof entry, 'each entry must be an object carrying at least `path`').toBe('object')
      expect((entry as { path?: unknown }).path).toBeTypeOf('string')
    }
  })

  it('does NOT fabricate month/year — the canonical plane does not carry the statement period', () => {
    // periodPosition is a 1-based ORDINAL ("orders periods WITHIN one
    // application's own v1 reconstruction"), not a calendar date. v1 carried
    // real {month, year}. Inventing month = periodPosition would render a
    // confident T1..T6 that no data supports — the same reason
    // ihsCanonicalReadService omits confidence rather than guessing it.
    const value = flatRecordFromView(viewWith(SIX)).record.bankStatements as Array<Record<string, unknown>>
    for (const entry of value) {
      expect(entry.month, 'month must be absent, not fabricated from periodPosition').toBeUndefined()
      expect(entry.year, 'year must be absent, not fabricated from periodPosition').toBeUndefined()
    }
  })

  it('a single document still aggregates to a one-entry array, not a bare string', () => {
    const value = flatRecordFromView(viewWith([SIX[0]])).record.bankStatements
    expect(Array.isArray(value)).toBe(true)
    expect((value as unknown[]).length).toBe(1)
  })

  it('keeps the L-3 `#` boundary — bankStatements must not swallow a longer sibling doc type', () => {
    const mixed = [
      doc('bankStatements#aaa1', 'https://dms/mine', { periodPosition: 1 }),
      doc('bankStatementsExtraordinary#bbb1', 'https://dms/not-mine', { periodPosition: 1 }),
    ]
    const value = flatRecordFromView(viewWith(mixed)).record.bankStatements as Array<{ path: string }>
    expect(value.map((e) => e.path)).toEqual(['https://dms/mine'])
  })

  it('the consumer recovers: buildDocumentRows renders six rows, each downloadable', () => {
    // The whole point. Under the collapse this produced ONE row; the other
    // five documents were not listed, not downloadable, and — since
    // bankStatements is re-uploadable — not replaceable either.
    const flat = flatRecordFromView(viewWith(SIX)).record as unknown as Record<string, unknown>
    expect(parseFileField(flat.bankStatements)).toHaveLength(6)

    const rows = buildDocumentRows(flat).filter((r) => r.path !== null)
    expect(rows.length).toBeGreaterThanOrEqual(6)
  })
})
