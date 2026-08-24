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
 * SYS-3542 (SYS-3463a). No fixture below mixes a fixed timestamp with a
 * clock-relative assertion — every `observedAt` is a literal ISO string
 * compared only against another literal in the same fixture, and nothing
 * here reads the wall clock (`subjectViewFromRecords` itself never touches
 * `Date`). There is therefore nothing to freeze.
 */
import { describe, expect, it } from 'vitest'

import type { CanonicalFieldEnvelope, CanonicalInstance, CanonicalView } from './canonical-view.js'
import {
  SubjectViewError,
  subjectViewFromRecords,
  type SubjectViewErrorCode,
  type SubjectViewRecord,
} from './subject-canonical-view.js'

/**
 * F11 (review): a caller branches on `.code`, not on the message. Every
 * throw test below asserts BOTH — the message stays covered (it is good
 * prose and the review asked to keep it asserted), but the code is the one
 * that must survive a rewording, so it gets its own dedicated check here
 * rather than living only inside a regex that could pass for the wrong
 * reason if the message changed shape.
 */
function expectSubjectViewErrorCode(fn: () => unknown, code: SubjectViewErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught, 'expected a throw').toBeInstanceOf(SubjectViewError)
  expect((caught as SubjectViewError).code).toBe(code)
}

function envelope(value: string): CanonicalFieldEnvelope {
  return { value, confidentiality: 'internal' }
}

function instance(partial: Partial<CanonicalInstance> & { instanceKey: string }): CanonicalInstance {
  return {
    adapterId: 'test-adapter',
    adapterVersion: 1,
    fields: {},
    ...partial,
  }
}

function record(ihsId: number, subjectKind: string, view: Omit<CanonicalView, 'ihsId'>): SubjectViewRecord {
  return { subjectKind, view: { ihsId, ...view } }
}

describe('subjectViewFromRecords — the flat-field latest-by-observedAt rule', () => {
  /**
   * THE ORDER-INDEPENDENCE PROOF the task calls for. Two applications each
   * contribute one instance to 'applicant-identity' with a conflicting value
   * for 'employerName', at distinct observedAt timestamps. Fed in EITHER
   * order, the merge must sort the later-observed instance first — a merge
   * that instead trusted array position would pass one of these two cases
   * and fail the other, which is exactly the defect this proves absent.
   */
  it('sorts the later-observedAt instance first, regardless of record feed order', () => {
    // ihsIds are deliberately the REVERSE of the expected observedAt
    // ordering (earlier's ihsId 1058 > later's ihsId 1042): the secondary
    // sourceIhsId tie-break (F5) would pick the WRONG instance if it fired
    // here, so this only passes when the observedAt comparison itself is
    // doing the work — a mutation that disables it cannot hide behind a
    // fixture where sourceIhsId happens to agree with the right answer.
    const earlier = record(1058, 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-01-01T00:00:00.000Z',
              fields: { employerName: envelope('Old Employer Sdn Bhd') },
            }),
          ],
        },
      },
    })
    const later = record(1042, 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-06-01T00:00:00.000Z',
              fields: { employerName: envelope('New Employer Sdn Bhd') },
            }),
          ],
        },
      },
    })

    const feedForward = subjectViewFromRecords([earlier, later])
    const feedReverse = subjectViewFromRecords([later, earlier])

    for (const [label, merged] of [
      ['earlier-first', feedForward],
      ['later-first', feedReverse],
    ] as const) {
      const [first, second] = merged.categories['applicant-identity']!.instances
      expect(first!.fields.employerName!.value, `${label}: instances[0]`).toBe('New Employer Sdn Bhd')
      expect(second!.fields.employerName!.value, `${label}: instances[1]`).toBe('Old Employer Sdn Bhd')
    }
  })

  it('sorts an instance with a real observedAt ahead of one with none', () => {
    const withTimestamp = record(1, 'individual', {
      categories: {
        c: {
          instances: [instance({ instanceKey: '', observedAt: '2026-01-01T00:00:00.000Z' })],
        },
      },
    })
    const withoutTimestamp = record(2, 'individual', {
      categories: {
        c: { instances: [instance({ instanceKey: '' })] },
      },
    })

    for (const [label, merged] of [
      ['timestamped-first', subjectViewFromRecords([withTimestamp, withoutTimestamp])],
      ['timestamped-second', subjectViewFromRecords([withoutTimestamp, withTimestamp])],
    ] as const) {
      const [first] = merged.categories.c!.instances
      expect(first!.source.sourceIhsId, label).toBe(1)
    }
  })

  /**
   * F5 (review): the tie-break is `sourceIhsId` DESCENDING, not "whichever
   * record was listed first" — the earlier implementation's rule. Proven
   * here by checking BOTH feed orders land on the SAME winner (the higher
   * ihsId), which the old array-position rule could not do: it produced
   * [1,2] forward and [2,1] reverse, a different "winner" for each order.
   */
  it('breaks a tie (equal or both-absent observedAt) by ranking the higher sourceIhsId first, regardless of feed order', () => {
    const a = record(1, 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })
    const b = record(2, 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })

    const forward = subjectViewFromRecords([a, b])
    expect(forward.categories.c!.instances.map((i) => i.source.sourceIhsId)).toEqual([2, 1])

    const reverse = subjectViewFromRecords([b, a])
    expect(reverse.categories.c!.instances.map((i) => i.source.sourceIhsId)).toEqual([2, 1])
  })

  /**
   * The case F4/F5 exist for: a category where NO instance carries
   * `observedAt` at all. Before F5's fix, this fell back to record-arrival
   * order — order-DEPENDENT despite the CHANGELOG's original "regardless of
   * feed order" claim. The secondary key on `sourceIhsId` makes the result
   * genuinely the same regardless of feed order even here.
   */
  it('is order-independent even when NOTHING in the category carries observedAt', () => {
    const a = record(10, 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })
    const b = record(20, 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })

    const forwardWinner = subjectViewFromRecords([a, b]).categories.c!.instances[0]!.source.sourceIhsId
    const reverseWinner = subjectViewFromRecords([b, a]).categories.c!.instances[0]!.source.sourceIhsId
    expect(forwardWinner).toBe(20)
    expect(reverseWinner).toBe(20)
  })

  /**
   * F1 (review, HIGH): a raw string comparison of `observedAt` misorders
   * two REAL failure modes this package's own docs name. Both are proven
   * here by execution, not asserted by description.
   */
  describe('parses observedAt rather than comparing it as a string (F1)', () => {
    it('orders correctly across a mixed UTC offset — +08:00 (this estate\'s own timezone) vs Z', () => {
      // 09:00 +08:00 is 01:00Z — an HOUR EARLIER than 08:00Z. A raw string
      // comparison ranks '+08:00' > 'Z' as VERY FIRST characters after the
      // shared date/hour prefix diverge, i.e. it would call this one later.
      // ihsIds are deliberately the REVERSE of the correct answer (the loser
      // gets the HIGHER id) so the F5 secondary key cannot mask a broken
      // primary comparison here.
      const trueEarlierButStringLater = record(2, 'individual', {
        categories: {
          c: {
            instances: [
              instance({
                instanceKey: '',
                observedAt: '2026-06-01T09:00:00.000+08:00',
                fields: { f: envelope('offset') },
              }),
            ],
          },
        },
      })
      const trueLaterButStringEarlier = record(1, 'individual', {
        categories: {
          c: {
            instances: [
              instance({
                instanceKey: '',
                observedAt: '2026-06-01T08:00:00.000Z',
                fields: { f: envelope('utc') },
              }),
            ],
          },
        },
      })

      const merged = subjectViewFromRecords([trueEarlierButStringLater, trueLaterButStringEarlier])
      expect(merged.categories.c!.instances[0]!.fields.f!.value).toBe('utc')
    })

    it('orders correctly across mixed precision — no-millis Z vs millisecond-precision Z', () => {
      // 'Z' (0x5A) > '.' (0x2E) byte-for-byte, so a raw string comparison
      // ranks the earlier, no-millis timestamp as the LATER one. ihsIds
      // again reversed from the correct answer, same reason as above.
      const earlierNoMillis = record(2, 'individual', {
        categories: {
          c: { instances: [instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00Z', fields: { f: envelope('no-millis') } })] },
        },
      })
      const laterWithMillis = record(1, 'individual', {
        categories: {
          c: {
            instances: [
              instance({
                instanceKey: '',
                observedAt: '2026-06-01T00:00:01.000Z',
                fields: { f: envelope('with-millis') },
              }),
            ],
          },
        },
      })

      const merged = subjectViewFromRecords([earlierNoMillis, laterWithMillis])
      expect(merged.categories.c!.instances[0]!.fields.f!.value).toBe('with-millis')
    })

    it('treats an unparseable observedAt exactly like an absent one — ranked oldest, never throws', () => {
      // ihsIds reversed from the correct answer again, same reason.
      const malformed = record(2, 'individual', {
        categories: {
          c: { instances: [instance({ instanceKey: '', observedAt: 'not-a-timestamp' })] },
        },
      })
      const real = record(1, 'individual', {
        categories: {
          c: { instances: [instance({ instanceKey: '', observedAt: '2026-01-01T00:00:00.000Z' })] },
        },
      })

      expect(() => subjectViewFromRecords([malformed, real])).not.toThrow()
      const merged = subjectViewFromRecords([malformed, real])
      expect(merged.categories.c!.instances[0]!.source.sourceIhsId).toBe(1)
    })
  })
})

describe('subjectViewFromRecords — per-source instance-key qualification', () => {
  /**
   * The collision this whole design exists to prevent: two applications,
   * each with a single-cardinality category, both key their one instance
   * ''. Unqualified, a keyed lookup over the merged instances (or a naive
   * dedup by instanceKey) would see one key twice and silently drop one
   * application's data. Qualification must make the two keys distinct AND
   * both instances must survive the merge.
   */
  it('gives two applications sharing the raw key "" two distinct, both-surviving instances', () => {
    const first = record(1042, 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [instance({ instanceKey: '', fields: { nric: envelope('A') } })],
        },
      },
    })
    const second = record(1058, 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [instance({ instanceKey: '', fields: { nric: envelope('B') } })],
        },
      },
    })

    const merged = subjectViewFromRecords([first, second])
    const keys = merged.categories['applicant-identity']!.instances.map((i) => i.instanceKey).sort()
    expect(keys).toEqual(['1042#', '1058#'])

    const values = merged.categories['applicant-identity']!.instances
      .map((i) => i.fields.nric!.value)
      .sort()
    expect(values).toEqual(['A', 'B'])
  })

  it('qualifies a non-empty raw key the same way', () => {
    const merged = subjectViewFromRecords([
      record(7, 'company', {
        categories: { docs: { instances: [instance({ instanceKey: 'bankStatements#1' })] } },
      }),
    ])
    expect(merged.categories.docs!.instances[0]!.instanceKey).toBe('7#bankStatements#1')
  })
})

describe('subjectViewFromRecords — cardinality is omitted, not carried through', () => {
  it('does not copy a "single"-cardinality flag onto the merged category', () => {
    const merged = subjectViewFromRecords([
      record(1, 'individual', {
        categories: { c: { cardinality: 'single', instances: [instance({ instanceKey: '' })] } },
      }),
    ])
    expect('cardinality' in merged.categories.c!).toBe(false)
  })
})

describe('subjectViewFromRecords — subjectKind', () => {
  it('carries the (agreeing) subjectKind through', () => {
    const merged = subjectViewFromRecords([
      record(1, 'individual', { categories: {} }),
      record(2, 'individual', { categories: {} }),
    ])
    expect(merged.subjectKind).toBe('individual')
  })

  it('throws on subjectKind disagreement across records for one subject, naming both ihsIds', () => {
    const call = () =>
      subjectViewFromRecords([
        record(1, 'individual', { categories: {} }),
        record(2, 'company', { categories: {} }),
      ])
    expect(call).toThrowError(/subjectKind disagreement.*ihsId 1.*individual.*ihsId 2.*company/s)
    expectSubjectViewErrorCode(call, 'subject-kind-disagreement')
  })

  it('throws on an empty record list rather than fabricate a subjectKind', () => {
    const call = () => subjectViewFromRecords([])
    expect(call).toThrowError(/at least one record is required/)
    expectSubjectViewErrorCode(call, 'no-records')
  })
})

describe('subjectViewFromRecords — overlay projections are rejected (F2)', () => {
  /**
   * The most serious finding on the first pass: a view read under
   * `?overlay=mine` carries staged, uncommitted lender edits as `value`,
   * with `overlay`'s PRESENCE the only signal that these are not facts. A
   * merge that dropped `overlay` while keeping the staged values would
   * disclose them as subject-attested data. Proven here that the guard
   * actually looks at the field the real hazard depends on.
   */
  it('throws when a record carries CanonicalView.overlay, naming the ihsId', () => {
    const overlaid = record(1042, 'individual', {
      categories: {
        c: {
          instances: [
            instance({
              instanceKey: '',
              fields: { f: { value: 99999, confidentiality: 'internal', origin: 'manual', originalValue: 3000 } },
            }),
          ],
        },
      },
      overlay: { lenderId: 77, applied: 1, updatedAt: null, unprojected: [] },
    })

    const call = () => subjectViewFromRecords([overlaid])
    expect(call).toThrowError(/ihsId 1042.*overlay/s)
    expectSubjectViewErrorCode(call, 'overlay-projection-present')
  })

  it('does not throw on a facts-only view (overlay absent)', () => {
    const facts = record(1042, 'individual', { categories: {} })
    expect(() => subjectViewFromRecords([facts])).not.toThrow()
  })
})

describe('subjectViewFromRecords — duplicate sourceIhsId is rejected (F3)', () => {
  /**
   * The exact defect the qualification exists to prevent, reproduced under
   * a different name: two records for the SAME application both qualify
   * their '' key to '1042#', which is a real, undetected collision that a
   * distinct-ihsId test (the "per-source instance-key qualification" suite
   * above) cannot see.
   */
  it('throws on two records naming the same ihsId, rather than silently colliding', () => {
    const first = record(1042, 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('A') } })] } },
    })
    const duplicate = record(1042, 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('B') } })] } },
    })

    const call = () => subjectViewFromRecords([first, duplicate])
    expect(call).toThrowError(/ihsId 1042.*more than once/s)
    expectSubjectViewErrorCode(call, 'duplicate-source-ihs-id')
  })
})

describe('subjectViewFromRecords — aliasing (F7)', () => {
  it('gives a merged instance a fresh fields object, so reassigning a field there does not touch the source view', () => {
    const source = record(1, 'individual', {
      categories: {
        c: { instances: [instance({ instanceKey: '', fields: { f: envelope('original') } })] },
      },
    })

    const merged = subjectViewFromRecords([source])
    const mergedInstance = merged.categories.c!.instances[0]!
    const sourceInstance = source.view.categories.c!.instances[0]!

    expect(mergedInstance.fields).not.toBe(sourceInstance.fields)

    // The idiom this package's own consumers use — replace, don't mutate.
    mergedInstance.fields = { ...mergedInstance.fields, f: envelope('redacted') }
    expect(sourceInstance.fields.f!.value).toBe('original')
  })

  it('documents (does not hide) that a field ENVELOPE is still the same reference as the source', () => {
    const source = record(1, 'individual', {
      categories: {
        c: { instances: [instance({ instanceKey: '', fields: { f: envelope('original') } })] },
      },
    })

    const merged = subjectViewFromRecords([source])
    const mergedEnvelope = merged.categories.c!.instances[0]!.fields.f!
    const sourceEnvelope = source.view.categories.c!.instances[0]!.fields.f!
    expect(mergedEnvelope).toBe(sourceEnvelope)
  })
})

describe('subjectViewFromRecords — a hostile category id does not vanish (F10)', () => {
  it('keeps a "__proto__"-named category distinct from Object.prototype', () => {
    // Built by parsing an actual JSON STRING, deliberately, not by writing
    // `{ __proto__: x }` as object-literal syntax (which the language
    // special-cases to set the new object's PROTOTYPE rather than create an
    // own property named "__proto__" — so a JSON.stringify of that literal
    // would already have LOST the property before this test even started)
    // and not by bracket-assigning `obj['__proto__'] = x` either (same
    // special case, via the accessor Object.prototype defines for legacy
    // compat). JSON.parse's own algorithm builds properties directly,
    // bypassing that accessor — which is exactly how a real wire payload
    // would arrive, and exactly why this guard exists.
    const categories = JSON.parse(
      `{"__proto__":${JSON.stringify({ instances: [instance({ instanceKey: '', fields: { f: envelope('x') } })] })}}`,
    ) as CanonicalView['categories']
    expect(Object.prototype.hasOwnProperty.call(categories, '__proto__')).toBe(true)

    const merged = subjectViewFromRecords([record(1, 'individual', { categories })])

    expect(Object.prototype.hasOwnProperty.call(merged.categories, '__proto__')).toBe(true)
    expect(merged.categories.__proto__).not.toBe(Object.prototype)
    expect((merged.categories as Record<string, { instances: unknown[] }>)['__proto__']!.instances).toHaveLength(1)
  })
})

describe('subjectViewFromRecords — the error type is the contract, not the prose (F11)', () => {
  /**
   * Captures the thrown value and hands it back — deliberately, NOT a
   * try/call/continue loop that could silently record nothing for a call
   * that fails to throw. If `fn` does not throw, `caught` stays `undefined`
   * and the `toBeInstanceOf(SubjectViewError)` assertion below fails loudly,
   * the same non-vacuous shape as `expectSubjectViewErrorCode` above.
   */
  function catchOne(fn: () => unknown): unknown {
    let caught: unknown
    try {
      fn()
    } catch (error) {
      caught = error
    }
    return caught
  }

  it('throws SubjectViewError (not a bare Error) for every refusal, with four distinct codes', () => {
    const caughtNoRecords = catchOne(() => subjectViewFromRecords([]))
    const caughtKindDisagreement = catchOne(() =>
      subjectViewFromRecords([
        record(1, 'individual', { categories: {} }),
        record(2, 'company', { categories: {} }),
      ]),
    )
    const caughtDuplicateIhsId = catchOne(() =>
      subjectViewFromRecords([
        record(1, 'individual', { categories: {} }),
        record(1, 'individual', { categories: {} }),
      ]),
    )
    const caughtOverlay = catchOne(() =>
      subjectViewFromRecords([
        record(1, 'individual', {
          categories: {},
          overlay: { lenderId: 1, applied: 0, updatedAt: null, unprojected: [] },
        }),
      ]),
    )

    for (const caught of [caughtNoRecords, caughtKindDisagreement, caughtDuplicateIhsId, caughtOverlay]) {
      expect(caught).toBeInstanceOf(SubjectViewError)
      expect(caught).toBeInstanceOf(Error) // still a real Error — a catch(e: unknown) instanceof Error check still works.
    }

    // Every condition gets its OWN code — a caller distinguishing "genuinely
    // no subject" from "caller passed contradictory subjectKinds" (the
    // SYS-3545 motivation) needs these to never collapse onto each other.
    const codes = [caughtNoRecords, caughtKindDisagreement, caughtDuplicateIhsId, caughtOverlay].map(
      (e) => (e as SubjectViewError).code,
    )
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.sort()).toEqual(
      ['duplicate-source-ihs-id', 'no-records', 'overlay-projection-present', 'subject-kind-disagreement'].sort(),
    )
  })
})

describe('subjectViewFromRecords — legacySlot and periodPosition are stripped, not just un-typed (F12)', () => {
  /**
   * Same argument as `cardinality`'s omission, applied to the two other
   * per-application members: republishing either here would tell a
   * consumer the opposite of what is true. Proven at the OBJECT level, not
   * only the type level — a type-only omission would still leak the value
   * through anything that doesn't fully trust the type (JSON.stringify, an
   * `as` cast, a consumer written against the wire shape instead of this
   * package's types).
   */
  it('does not carry legacySlot or periodPosition through onto a merged instance', () => {
    const source = record(1, 'individual', {
      categories: {
        c: {
          instances: [instance({ instanceKey: '', legacySlot: 'T1', periodPosition: 1 })],
        },
      },
    })

    const merged = subjectViewFromRecords([source])
    const mergedInstance = merged.categories.c!.instances[0]!

    expect('legacySlot' in mergedInstance).toBe(false)
    expect('periodPosition' in mergedInstance).toBe(false)
    // Round-tripping through JSON is the strongest proof: if the key were
    // merely absent from the TYPE but still present on the object, it would
    // show up here regardless of what any consumer's type-checker believes.
    expect(Object.keys(JSON.parse(JSON.stringify(mergedInstance)))).not.toContain('legacySlot')
    expect(Object.keys(JSON.parse(JSON.stringify(mergedInstance)))).not.toContain('periodPosition')

    // sourceIhsId is the documented way back to the value, on the SOURCE
    // view — never lost, just not republished on the merged shape.
    expect(source.view.categories.c!.instances[0]!.legacySlot).toBe('T1')
    expect(source.view.categories.c!.instances[0]!.periodPosition).toBe(1)
  })

  it('does not break on an instance that carries neither member', () => {
    const merged = subjectViewFromRecords([
      record(1, 'individual', { categories: { c: { instances: [instance({ instanceKey: '' })] } } }),
    ])
    expect('legacySlot' in merged.categories.c!.instances[0]!).toBe(false)
    expect('periodPosition' in merged.categories.c!.instances[0]!).toBe(false)
  })
})
