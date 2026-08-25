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
 * SYS-3542 (SYS-3463a), rescoped by SYS-3554 (the furnisher axis).
 *
 * CLOCK: no fixture below mixes a fixed timestamp with a clock-relative
 * assertion — every `observedAt` is a literal ISO string compared only
 * against another literal in the same fixture, and nothing here reads the wall
 * clock (`subjectViewFromRecords` itself never touches `Date`). There is
 * therefore nothing to freeze. SYS-3554 added no clock-reading fixture and no
 * relative timestamp; `contestedLead` is decided by comparing two parsed
 * literals to each other, never to now.
 */
import { describe, expect, it } from 'vitest'

import type {
  CanonicalFieldEnvelope,
  CanonicalInstance,
  CanonicalView,
  SubjectSource,
} from './canonical-view.js'
import {
  SubjectViewError,
  sameSubjectSource,
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

function src(furnisherId: string, recordRef: string): SubjectSource {
  return { furnisherId, recordRef }
}

/**
 * SYS-3554: every record this helper builds carries the SAME `view.ihsId`,
 * deliberately, and no test overrides it. `ihsId` is a foreign tenant's
 * auto-increment primary key arriving inside a PULLED PAYLOAD; identity comes
 * from `source`, which the caller stamps from the credentialed channel. Baking
 * one colliding value into every fixture means any reintroduction of
 * payload-derived identity — keying, de-duplicating or ordering on
 * `view.ihsId` — fails most of this file rather than one test somebody
 * could delete. The value is a real-looking application id rather than 0 so
 * that a reintroduced `${ihsId}#` qualifier would be visible in a diff of
 * expected keys instead of blending into an empty string.
 */
const PAYLOAD_IHS_ID = 4207

function record(
  source: SubjectSource,
  subjectKind: string,
  view: Omit<CanonicalView, 'ihsId'>,
): SubjectViewRecord {
  return { subjectKind, source, view: { ihsId: PAYLOAD_IHS_ID, ...view } }
}

describe('subjectViewFromRecords — the flat-field latest-by-observedAt rule', () => {
  /**
   * THE ORDER-INDEPENDENCE PROOF the task calls for. Two furnished records
   * each contribute one instance to 'applicant-identity' with a conflicting
   * value for 'employerName', at distinct observedAt timestamps. Fed in
   * EITHER order, the merge must sort the later-observed instance first — a
   * merge that instead trusted array position would pass one of these two
   * cases and fail the other, which is exactly the defect this proves absent.
   */
  it('sorts the later-observedAt instance first, regardless of record feed order', () => {
    // The sources are deliberately arranged so that the SECONDARY key would
    // pick the WRONG instance if it fired here ('a-furnisher' sorts ahead of
    // 'b-furnisher', and it is the one holding the OLDER observation): this
    // only passes when the observedAt comparison itself is doing the work, so
    // a mutation that disables it cannot hide behind a fixture where the
    // secondary key happens to agree with the right answer.
    const earlier = record(src('a-furnisher', '1058'), 'individual', {
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
    const later = record(src('b-furnisher', '1042'), 'individual', {
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
      const category = merged.categories['applicant-identity']!
      const [first, second] = category.instances
      expect(first!.fields.employerName!.value, `${label}: instances[0]`).toBe('New Employer Sdn Bhd')
      expect(second!.fields.employerName!.value, `${label}: instances[1]`).toBe('Old Employer Sdn Bhd')
      // The lead won on EVIDENCE, so it is not contested — the flag must not
      // fire merely because two furnishers are present.
      expect(category.contestedLead, `${label}: contestedLead`).toBeUndefined()
    }
  })

  it('sorts an instance with a real observedAt ahead of one with none', () => {
    const withTimestamp = record(src('a-furnisher', '1'), 'individual', {
      categories: {
        c: {
          instances: [instance({ instanceKey: '', observedAt: '2026-01-01T00:00:00.000Z' })],
        },
      },
    })
    const withoutTimestamp = record(src('b-furnisher', '2'), 'individual', {
      categories: {
        c: { instances: [instance({ instanceKey: '' })] },
      },
    })

    for (const [label, merged] of [
      ['timestamped-first', subjectViewFromRecords([withTimestamp, withoutTimestamp])],
      ['timestamped-second', subjectViewFromRecords([withoutTimestamp, withTimestamp])],
    ] as const) {
      const category = merged.categories.c!
      expect(category.instances[0]!.source.furnisherId, label).toBe('a-furnisher')
      expect(category.contestedLead, `${label}: contestedLead`).toBeUndefined()
    }
  })

  /**
   * F5 (review), REPLACED BY SYS-3554. The tie-break used to be `sourceIhsId`
   * DESCENDING as a recency proxy; it is now a deterministic order over the
   * SOURCE PAIR that claims no temporal meaning at all, plus `contestedLead`
   * saying so out loud. What survives from F5 is the property F5 was actually
   * for: BOTH feed orders land on the SAME lead, which the arrival-order rule
   * F5 replaced could not do (it produced a different "winner" per order).
   */
  it('breaks a tie (equal or both-absent observedAt) deterministically, regardless of feed order', () => {
    const a = record(src('a-furnisher', '1'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })
    const b = record(src('b-furnisher', '2'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })

    const forward = subjectViewFromRecords([a, b])
    expect(forward.categories.c!.instances.map((i) => i.source.furnisherId)).toEqual([
      'a-furnisher',
      'b-furnisher',
    ])

    const reverse = subjectViewFromRecords([b, a])
    expect(reverse.categories.c!.instances.map((i) => i.source.furnisherId)).toEqual([
      'a-furnisher',
      'b-furnisher',
    ])
  })

  /**
   * The case F4/F5 exist for: a category where NO instance carries
   * `observedAt` at all. Before F5's fix, this fell back to record-arrival
   * order — order-DEPENDENT despite the CHANGELOG's original "regardless of
   * feed order" claim. It is still genuinely order-independent, and SYS-3554
   * adds the part F5 was missing: the lead is now MARKED as unresolved rather
   * than presented as the latest.
   */
  it('is order-independent even when NOTHING in the category carries observedAt', () => {
    const a = record(src('a-furnisher', '10'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })
    const b = record(src('b-furnisher', '20'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '' })] } },
    })

    const forward = subjectViewFromRecords([a, b]).categories.c!
    const reverse = subjectViewFromRecords([b, a]).categories.c!
    expect(forward.instances[0]!.source.furnisherId).toBe('a-furnisher')
    expect(reverse.instances[0]!.source.furnisherId).toBe('a-furnisher')
    expect(forward.contestedLead?.sources.map((source) => source.furnisherId)).toEqual([
      'a-furnisher',
      'b-furnisher',
    ])
    expect(reverse.contestedLead?.sources.map((source) => source.furnisherId)).toEqual([
      'a-furnisher',
      'b-furnisher',
    ])
  })

  /**
   * F1 (review, HIGH): a raw string comparison of `observedAt` misorders
   * two REAL failure modes this package's own docs name. Both are proven
   * here by execution, not asserted by description.
   */
  describe('parses observedAt rather than comparing it as a string (F1)', () => {
    it("orders correctly across a mixed UTC offset — +08:00 (this estate's own timezone) vs Z", () => {
      // 09:00 +08:00 is 01:00Z — an HOUR EARLIER than 08:00Z. A raw string
      // comparison ranks '+08:00' > 'Z' as VERY FIRST characters after the
      // shared date/hour prefix diverge, i.e. it would call this one later.
      // The sources are deliberately the REVERSE of the correct answer (the
      // loser sorts FIRST on the secondary key) so that key cannot mask a
      // broken primary comparison here.
      const trueEarlierButStringLater = record(src('a-furnisher', '2'), 'individual', {
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
      const trueLaterButStringEarlier = record(src('b-furnisher', '1'), 'individual', {
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
      // ranks the earlier, no-millis timestamp as the LATER one. Sources
      // again reversed from the correct answer, same reason as above.
      const earlierNoMillis = record(src('a-furnisher', '2'), 'individual', {
        categories: {
          c: {
            instances: [
              instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00Z', fields: { f: envelope('no-millis') } }),
            ],
          },
        },
      })
      const laterWithMillis = record(src('b-furnisher', '1'), 'individual', {
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
      // Sources reversed from the correct answer again, same reason.
      const malformed = record(src('a-furnisher', '2'), 'individual', {
        categories: {
          c: { instances: [instance({ instanceKey: '', observedAt: 'not-a-timestamp' })] },
        },
      })
      const real = record(src('b-furnisher', '1'), 'individual', {
        categories: {
          c: { instances: [instance({ instanceKey: '', observedAt: '2026-01-01T00:00:00.000Z' })] },
        },
      })

      expect(() => subjectViewFromRecords([malformed, real])).not.toThrow()
      const merged = subjectViewFromRecords([malformed, real])
      expect(merged.categories.c!.instances[0]!.source.furnisherId).toBe('b-furnisher')
    })
  })
})

describe('subjectViewFromRecords — the furnisher axis (SYS-3554)', () => {
  /**
   * THE DECISIVE TEST, and it was impossible to write against the previous
   * contract — which is the point. A bureau aggregates from MANY furnishers,
   * each running their own finsys-api instance with its own auto-increment
   * sequence, so lender A's application 7 and lender B's application 7 are the
   * same value and mean nothing to each other. Before SYS-3554 these two
   * records raised `duplicate-source-ihs-id` and the subject failed every
   * inquiry; had the throw not fired first, their instances would have merged
   * silently under one qualified key, putting one lender's document in the
   * other's place inside a credit report.
   */
  it('gives two furnishers with COLLIDING record refs two distinct instances, neither overwriting the other', () => {
    const lenderA = record(src('furnisher-a', '7'), 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [instance({ instanceKey: '', fields: { employerName: envelope('A') } })],
        },
      },
    })
    const lenderB = record(src('furnisher-b', '7'), 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [instance({ instanceKey: '', fields: { employerName: envelope('B') } })],
        },
      },
    })

    const category = subjectViewFromRecords([lenderA, lenderB]).categories['applicant-identity']!

    expect(category.instances).toHaveLength(2)
    expect(category.instances.map((i) => i.fields.employerName!.value).sort()).toEqual(['A', 'B'])
    expect(category.instances.map((i) => i.source.furnisherId).sort()).toEqual([
      'furnisher-a',
      'furnisher-b',
    ])
    // The colliding ref survives verbatim on BOTH — it is provenance for the
    // s.31 correction channel, not a key, so it is neither renamed nor
    // disambiguated.
    expect(category.instances.map((i) => i.source.recordRef)).toEqual(['7', '7'])
    // And note what both records also share: PAYLOAD_IHS_ID. Payload content
    // is not identity.
    expect(lenderA.view.ihsId).toBe(lenderB.view.ihsId)
  })

  /**
   * The SAME pair twice IS a duplicate — two copies of one furnished record,
   * whose instances no correctly-keyed lookup could tell apart. This is F3's
   * check, rescoped from the bare foreign sequence to the pair.
   */
  it('throws on two records carrying the SAME (furnisherId, recordRef) pair', () => {
    const first = record(src('furnisher-a', '7'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('A') } })] } },
    })
    const duplicate = record(src('furnisher-a', '7'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('B') } })] } },
    })

    const call = () => subjectViewFromRecords([first, duplicate])
    expect(call).toThrowError(/furnisher "furnisher-a" record "7".*more than once/s)
    expectSubjectViewErrorCode(call, 'duplicate-source-record')
  })

  /**
   * THE MUTATION-BITER for the duplicate check. `('a', 'b#c')` and
   * `('a#b', 'c')` are two DIFFERENT sources that any `#`-join maps to the
   * single string 'a#b#c'. A duplicate check that keyed on a joined pair —
   * the obvious refactor, and the shape this whole ticket exists to remove —
   * would call these duplicates and throw, failing one legitimate furnisher's
   * subject entirely. Nothing about this fixture is exotic: a furnisher id is
   * bureau-minted text and a recordRef is opaque by contract, so both halves
   * can contain any character at all.
   */
  it('does not treat two delimiter-ambiguous pairs as one — no join is safe when both halves are opaque', () => {
    const left = record(src('a', 'b#c'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('left') } })] } },
    })
    const right = record(src('a#b', 'c'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('right') } })] } },
    })

    expect(() => subjectViewFromRecords([left, right])).not.toThrow()
    const category = subjectViewFromRecords([left, right]).categories.c!
    expect(category.instances).toHaveLength(2)
    expect(category.instances.map((i) => i.fields.f!.value).sort()).toEqual(['left', 'right'])
    expect(sameSubjectSource(src('a', 'b#c'), src('a#b', 'c'))).toBe(false)
  })

  it('round-trips a recordRef containing delimiter-ish characters intact', () => {
    // Every character a joined key has ever been delimited by in this estate,
    // plus the ones a naive escaper reaches for next.
    const hostileRef = 'REF#1|2:3/4 {"a":1}'
    const merged = subjectViewFromRecords([
      record(src('furnisher-a', hostileRef), 'company', {
        categories: { docs: { instances: [instance({ instanceKey: 'bankStatements#1' })] } },
      }),
    ])
    const [only] = merged.categories.docs!.instances
    expect(only!.source.recordRef).toBe(hostileRef)
    expect(only!.source.furnisherId).toBe('furnisher-a')
    // And the raw instanceKey is untouched by it — the two never meet.
    expect(only!.instanceKey).toBe('bankStatements#1')
  })

  describe('both halves of the pair are required (missing-source-identity)', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['an empty furnisherId — every furnisher at once', { furnisherId: '', recordRef: '7' }],
      ['an empty recordRef — collides with every ref-less record', { furnisherId: 'furnisher-a', recordRef: '' }],
      ['a missing furnisherId', { recordRef: '7' }],
      ['a missing recordRef', { furnisherId: 'furnisher-a' }],
      ['a numeric recordRef, which is the old shape leaking back', { furnisherId: 'furnisher-a', recordRef: 7 }],
      ['no source at all', undefined],
    ]

    for (const [label, source] of cases) {
      it(`throws on ${label}`, () => {
        const call = () =>
          subjectViewFromRecords([
            record(source as SubjectSource, 'individual', {
              categories: { c: { instances: [instance({ instanceKey: '' })] } },
            }),
          ])
        expect(call).toThrowError(/no usable source identity/)
        expectSubjectViewErrorCode(call, 'missing-source-identity')
      })
    }
  })

  it('sameSubjectSource compares both halves independently', () => {
    expect(sameSubjectSource(src('a', '1'), src('a', '1'))).toBe(true)
    expect(sameSubjectSource(src('a', '1'), src('a', '2'))).toBe(false)
    expect(sameSubjectSource(src('a', '1'), src('b', '1'))).toBe(false)
  })
})

describe("subjectViewFromRecords — ordering does not depend on any furnisher's sequence numbers (SYS-3554)", () => {
  /**
   * THE PROOF that the recency proxy is gone rather than renamed. Two
   * furnishers tie on `observedAt` (both absent). Under the old rule the
   * winner was whichever record had the higher `sourceIhsId`, so SWAPPING the
   * two furnishers' sequence numbers flipped the lead — that is precisely the
   * systematic preference for whoever numbers higher that SYS-3554 names.
   * Here the same furnisher leads under both assignments, because the
   * sequence numbers are not consulted at all.
   */
  it('gives the same lead when the two furnishers swap sequence numbers', () => {
    function build(alphaRef: string, betaRef: string) {
      return subjectViewFromRecords([
        record(src('alpha', alphaRef), 'individual', {
          categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('alpha') } })] } },
        }),
        record(src('beta', betaRef), 'individual', {
          categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('beta') } })] } },
        }),
      ]).categories.c!
    }

    // alpha numbers far higher than beta, then far lower. Under the old
    // `sourceIhsId`-descending rule these two calls disagree.
    const alphaHigh = build('99999', '1')
    const alphaLow = build('1', '99999')

    expect(alphaHigh.instances[0]!.fields.f!.value).toBe('alpha')
    expect(alphaLow.instances[0]!.fields.f!.value).toBe('alpha')
    // ...and in BOTH cases the lead is reported as unresolved, because it is:
    // nothing here says which observation is newer.
    for (const [label, category] of [
      ['alpha-high', alphaHigh],
      ['alpha-low', alphaLow],
    ] as const) {
      expect(category.contestedLead?.sources.map((s) => s.furnisherId), label).toEqual(['alpha', 'beta'])
    }
  })

  it('does not order by recordRef even within one furnisher — an opaque ref is not a sequence', () => {
    // '9' > '10' lexicographically and 9 < 10 numerically; either reading is
    // an assertion about a furnisher's numbering that this package refuses to
    // make. What it DOES guarantee is determinism plus disclosure.
    const nine = record(src('furnisher-a', '9'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('nine') } })] } },
    })
    const ten = record(src('furnisher-a', '10'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('ten') } })] } },
    })

    const forward = subjectViewFromRecords([nine, ten]).categories.c!
    const reverse = subjectViewFromRecords([ten, nine]).categories.c!
    expect(forward.instances.map((i) => i.fields.f!.value)).toEqual(
      reverse.instances.map((i) => i.fields.f!.value),
    )
    // Same furnisher, different records: still two observations that cannot be
    // ordered on evidence, so still contested.
    expect(forward.contestedLead?.sources.map((s) => s.recordRef)).toEqual(['10', '9'])
  })
})

describe('subjectViewFromRecords — contestedLead marks an unresolved lead (SYS-3554)', () => {
  it('is ABSENT when the lead won on observedAt', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt: '2026-01-01T00:00:00.000Z' })] } },
      }),
      record(src('b', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z' })] } },
      }),
    ])
    expect(merged.categories.c!.contestedLead).toBeUndefined()
    expect('contestedLead' in merged.categories.c!).toBe(false)
  })

  it('is ABSENT when the tie is WITHIN one furnished record — one producer ordering its own instances is not a disagreement', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', {
        categories: {
          c: {
            instances: [
              instance({ instanceKey: 'x', fields: { f: envelope('first') } }),
              instance({ instanceKey: 'y', fields: { f: envelope('second') } }),
            ],
          },
        },
      }),
    ])
    const category = merged.categories.c!
    expect(category.contestedLead).toBeUndefined()
    // Stable: the record's own order survives, because compareSources returns
    // 0 for two instances of one record and Array.prototype.sort is stable.
    expect(category.instances.map((i) => i.fields.f!.value)).toEqual(['first', 'second'])
  })

  it('is PRESENT when two sources tie at the top, listing each distinct source once', () => {
    // The 'a' record contributes TWO tied instances; it must appear once, not
    // twice — the flag names SOURCES in disagreement, not instances.
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', {
        categories: {
          c: {
            instances: [instance({ instanceKey: 'x' }), instance({ instanceKey: 'y' })],
          },
        },
      }),
      record(src('b', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: 'z' })] } },
      }),
    ])
    expect(merged.categories.c!.contestedLead!.sources).toEqual([
      { furnisherId: 'a', recordRef: '1' },
      { furnisherId: 'b', recordRef: '1' },
    ])
  })

  it('counts only the instances tied at the TOP rank, not every source in the category', () => {
    // 'b' is genuinely older, so it is not contesting the lead — including it
    // would turn the flag into "more than one source exists", which is the
    // normal case and would make it useless.
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z' })] } },
      }),
      record(src('a2', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z' })] } },
      }),
      record(src('b', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt: '2020-01-01T00:00:00.000Z' })] } },
      }),
    ])
    expect(merged.categories.c!.contestedLead!.sources.map((s) => s.furnisherId)).toEqual(['a', 'a2'])
  })

  it('treats an ABSENT and an UNPARSEABLE observedAt as the same rank, so they contest each other', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '' })] } },
      }),
      record(src('b', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt: 'not-a-timestamp' })] } },
      }),
    ])
    expect(merged.categories.c!.contestedLead!.sources.map((s) => s.furnisherId)).toEqual(['a', 'b'])
  })
})

describe('subjectViewFromRecords — instanceKey passes through RAW (SYS-3554)', () => {
  /**
   * SYS-3542 rewrote every key to `${sourceIhsId}#${rawKey}` so a lookup over
   * a category's instances could stay one-dimensional. SYS-3554 reverses that:
   * the qualifier would now be an opaque string, so the scheme is no longer
   * reversible (finsys-client's seat slices at the first '#' on the stated
   * argument that "sourceIhsId is numeric"), and no delimiter is safe when
   * both halves are opaque. Uniqueness is the TUPLE instead.
   */
  it('leaves "" as "" and never prefixes it with anything', () => {
    const merged = subjectViewFromRecords([
      record(src('furnisher-a', '1042'), 'individual', {
        categories: {
          'applicant-identity': {
            cardinality: 'single',
            instances: [instance({ instanceKey: '', fields: { nric: envelope('A') } })],
          },
        },
      }),
      record(src('furnisher-b', '1058'), 'individual', {
        categories: {
          'applicant-identity': {
            cardinality: 'single',
            instances: [instance({ instanceKey: '', fields: { nric: envelope('B') } })],
          },
        },
      }),
    ])
    const instances = merged.categories['applicant-identity']!.instances
    expect(instances.map((i) => i.instanceKey)).toEqual(['', ''])
    // Both survive — the collision the old qualification existed to prevent is
    // now prevented by the tuple, not by rewriting the key.
    expect(instances.map((i) => i.fields.nric!.value).sort()).toEqual(['A', 'B'])
    const identities = instances.map((i) => [i.source.furnisherId, i.source.recordRef, i.instanceKey])
    expect(new Set(identities.map((parts) => JSON.stringify(parts))).size).toBe(2)
  })

  it('leaves a non-empty raw key exactly as the producer wrote it, "#" included', () => {
    const merged = subjectViewFromRecords([
      record(src('furnisher-a', '7'), 'company', {
        categories: { docs: { instances: [instance({ instanceKey: 'bankStatements#1' })] } },
      }),
    ])
    expect(merged.categories.docs!.instances[0]!.instanceKey).toBe('bankStatements#1')
  })
})

describe('subjectViewFromRecords — cardinality is omitted, not carried through', () => {
  it('does not copy a "single"-cardinality flag onto the merged category', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', {
        categories: { c: { cardinality: 'single', instances: [instance({ instanceKey: '' })] } },
      }),
    ])
    expect('cardinality' in merged.categories.c!).toBe(false)
  })
})

describe('subjectViewFromRecords — subjectKind', () => {
  it('carries the (agreeing) subjectKind through', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', { categories: {} }),
      record(src('b', '1'), 'individual', { categories: {} }),
    ])
    expect(merged.subjectKind).toBe('individual')
  })

  it('throws on subjectKind disagreement across records for one subject, naming both sources', () => {
    const call = () =>
      subjectViewFromRecords([
        record(src('furnisher-a', '1'), 'individual', { categories: {} }),
        record(src('furnisher-b', '2'), 'company', { categories: {} }),
      ])
    expect(call).toThrowError(
      /subjectKind disagreement.*furnisher "furnisher-a" record "1".*individual.*furnisher "furnisher-b" record "2".*company/s,
    )
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
  it('throws when a record carries CanonicalView.overlay, naming the source', () => {
    const overlaid = record(src('furnisher-a', '1042'), 'individual', {
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
    expect(call).toThrowError(/furnisher "furnisher-a" record "1042".*overlay/s)
    expectSubjectViewErrorCode(call, 'overlay-projection-present')
  })

  it('does not throw on a facts-only view (overlay absent)', () => {
    const facts = record(src('furnisher-a', '1042'), 'individual', { categories: {} })
    expect(() => subjectViewFromRecords([facts])).not.toThrow()
  })
})

describe('subjectViewFromRecords — aliasing (F7)', () => {
  it('gives a merged instance a fresh fields object, so reassigning a field there does not touch the source view', () => {
    const source = record(src('a', '1'), 'individual', {
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
    const source = record(src('a', '1'), 'individual', {
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

    const merged = subjectViewFromRecords([record(src('a', '1'), 'individual', { categories })])

    expect(Object.prototype.hasOwnProperty.call(merged.categories, '__proto__')).toBe(true)
    expect(merged.categories.__proto__).not.toBe(Object.prototype)
    expect((merged.categories as Record<string, { instances: unknown[] }>)['__proto__']!.instances).toHaveLength(1)
  })

  /**
   * SYS-3554: the same hazard, one level down. The duplicate check keys on
   * `furnisherId`, which is bureau-minted TEXT — a plain-object accumulator
   * would let a furnisher registered as '__proto__' read back
   * Object.prototype, so a `has` check would answer for a furnisher that had
   * never been seen. A `Map` has no such accessor.
   */
  it('does not confuse a furnisher named "__proto__" with Object.prototype', () => {
    const merged = subjectViewFromRecords([
      record(src('__proto__', '1'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('one') } })] } },
      }),
      record(src('__proto__', '2'), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('two') } })] } },
      }),
    ])
    expect(merged.categories.c!.instances).toHaveLength(2)

    const call = () =>
      subjectViewFromRecords([
        record(src('__proto__', '1'), 'individual', { categories: {} }),
        record(src('__proto__', '1'), 'individual', { categories: {} }),
      ])
    expectSubjectViewErrorCode(call, 'duplicate-source-record')
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

  it('throws SubjectViewError (not a bare Error) for every refusal, with five distinct codes', () => {
    const caughtNoRecords = catchOne(() => subjectViewFromRecords([]))
    const caughtKindDisagreement = catchOne(() =>
      subjectViewFromRecords([
        record(src('a', '1'), 'individual', { categories: {} }),
        record(src('b', '1'), 'company', { categories: {} }),
      ]),
    )
    const caughtMissingIdentity = catchOne(() =>
      subjectViewFromRecords([record({ furnisherId: '', recordRef: '' }, 'individual', { categories: {} })]),
    )
    const caughtDuplicateRecord = catchOne(() =>
      subjectViewFromRecords([
        record(src('a', '1'), 'individual', { categories: {} }),
        record(src('a', '1'), 'individual', { categories: {} }),
      ]),
    )
    const caughtOverlay = catchOne(() =>
      subjectViewFromRecords([
        record(src('a', '1'), 'individual', {
          categories: {},
          overlay: { lenderId: 1, applied: 0, updatedAt: null, unprojected: [] },
        }),
      ]),
    )

    const caughtAll = [
      caughtNoRecords,
      caughtKindDisagreement,
      caughtMissingIdentity,
      caughtDuplicateRecord,
      caughtOverlay,
    ]
    for (const caught of caughtAll) {
      expect(caught).toBeInstanceOf(SubjectViewError)
      expect(caught).toBeInstanceOf(Error) // still a real Error — a catch(e: unknown) instanceof Error check still works.
    }

    // Every condition gets its OWN code — a caller distinguishing "genuinely
    // no subject" from "caller passed contradictory subjectKinds" (the
    // SYS-3545 motivation) needs these to never collapse onto each other.
    const codes = caughtAll.map((e) => (e as SubjectViewError).code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.sort()).toEqual(
      [
        'duplicate-source-record',
        'missing-source-identity',
        'no-records',
        'overlay-projection-present',
        'subject-kind-disagreement',
      ].sort(),
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
    const source = record(src('a', '1'), 'individual', {
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

    // `source` is the documented way back to the value: ask THAT furnisher for
    // THAT record's own CanonicalView, where the member still means something.
    expect(source.view.categories.c!.instances[0]!.legacySlot).toBe('T1')
    expect(source.view.categories.c!.instances[0]!.periodPosition).toBe(1)
  })

  it('does not break on an instance that carries neither member', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', { categories: { c: { instances: [instance({ instanceKey: '' })] } } }),
    ])
    expect('legacySlot' in merged.categories.c!.instances[0]!).toBe(false)
    expect('periodPosition' in merged.categories.c!.instances[0]!).toBe(false)
  })
})

/**
 * SYS-3464 — per-field recency across sources.
 *
 * CLOCK (this block, restating the file header's rule because this block is
 * the one that turns on `observedAt` ordering hardest): every timestamp below
 * is a literal ISO string, compared only against another literal in the same
 * fixture. Nothing reads the wall clock, nothing is expressed relative to now,
 * and `subjectViewFromRecords` still never touches `Date` beyond `Date.parse`
 * of a literal it was handed. There is nothing to freeze.
 */
describe('subjectViewFromRecords — per-field recency across sources (SYS-3464)', () => {
  /**
   * THE DEFECT, STATED AS A TEST. Furnisher A supplied two fields in January;
   * furnisher B supplied ONE of them in June. Row-latest collapses the
   * category to B's newer row and spreads it flat, so `monthlyIncome` — which
   * nobody retracted and which the subject's file still holds — vanishes. That
   * is s.29 RACUN's Complete and Not-misleading limbs failing at once, with
   * nothing erroring anywhere.
   */
  it('does not let a fresher PARTIAL row erase a field another source supplied', () => {
    const older = record(src('furnisher-a', '1'), 'individual', {
      categories: {
        'applicant-identity': {
          cardinality: 'single',
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-01-01T00:00:00.000Z',
              fields: {
                employerName: envelope('Old Employer Sdn Bhd'),
                monthlyIncome: envelope('4200'),
              },
            }),
          ],
        },
      },
    })
    const newerButPartial = record(src('furnisher-b', '1'), 'individual', {
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

    for (const [label, merged] of [
      ['older-first', subjectViewFromRecords([older, newerButPartial])],
      ['newer-first', subjectViewFromRecords([newerButPartial, older])],
    ] as const) {
      const selected = merged.categories['applicant-identity']!.fieldsByInstanceKey['']!
      expect(selected.employerName!.envelope.value, `${label}: employerName`).toBe('New Employer Sdn Bhd')
      // The whole ticket, in one assertion: the field the newer row did not
      // mention is still there, at the value the older row attested.
      expect(selected.monthlyIncome!.envelope.value, `${label}: monthlyIncome`).toBe('4200')
    }
  })

  it('carries PER-FIELD provenance — the winning field names its own source, instance and observedAt, not the row lead"s', () => {
    const older = record(src('furnisher-a', '1'), 'individual', {
      categories: {
        c: {
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-01-01T00:00:00.000Z',
              fields: { kept: envelope('from-a'), superseded: envelope('stale') },
            }),
          ],
        },
      },
    })
    const newer = record(src('furnisher-b', '2'), 'individual', {
      categories: {
        c: {
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-06-01T00:00:00.000Z',
              fields: { superseded: envelope('fresh') },
            }),
          ],
        },
      },
    })

    const category = subjectViewFromRecords([older, newer]).categories.c!
    const selected = category.fieldsByInstanceKey['']!

    expect(selected.superseded!.source).toEqual({ furnisherId: 'furnisher-b', recordRef: '2' })
    expect(selected.superseded!.observedAt).toBe('2026-06-01T00:00:00.000Z')
    // The row lead is furnisher-b. `kept` must NOT inherit it.
    expect(category.instances[0]!.source.furnisherId).toBe('furnisher-b')
    expect(selected.kept!.source).toEqual({ furnisherId: 'furnisher-a', recordRef: '1' })
    expect(selected.kept!.observedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(selected.kept!.instanceKey).toBe('')
  })

  it('keeps a field that exists ONLY on the oldest of three observations', () => {
    const build = (ref: string, observedAt: string, fields: Record<string, ReturnType<typeof envelope>>) =>
      record(src(`furnisher-${ref}`, ref), 'individual', {
        categories: { c: { instances: [instance({ instanceKey: '', observedAt, fields })] } },
      })

    const merged = subjectViewFromRecords([
      build('c', '2026-06-01T00:00:00.000Z', { common: envelope('newest') }),
      build('b', '2026-03-01T00:00:00.000Z', { common: envelope('middle') }),
      build('a', '2026-01-01T00:00:00.000Z', { common: envelope('oldest'), onlyOnOldest: envelope('survives') }),
    ])

    const selected = merged.categories.c!.fieldsByInstanceKey['']!
    expect(selected.common!.envelope.value).toBe('newest')
    expect(selected.onlyOnOldest!.envelope.value).toBe('survives')
    expect(selected.onlyOnOldest!.source.furnisherId).toBe('furnisher-a')
  })

  it('preserves single-source behavior where it was already correct — the newer of one furnisher"s own instances wins the field', () => {
    const merged = subjectViewFromRecords([
      record(src('furnisher-a', '1'), 'individual', {
        categories: {
          c: {
            instances: [
              instance({ instanceKey: '', observedAt: '2026-01-01T00:00:00.000Z', fields: { f: envelope('old') } }),
              instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z', fields: { f: envelope('new') } }),
            ],
          },
        },
      }),
    ])
    const category = merged.categories.c!
    // Row-latest and per-field agree here, which is the point: the fix does
    // not move a case that was already right.
    expect(category.instances[0]!.fields.f!.value).toBe('new')
    expect(category.fieldsByInstanceKey['']!.f!.envelope.value).toBe('new')
    expect(category.fieldsByInstanceKey['']!.f!.contested).toBeUndefined()
    expect(category.contestedLead).toBeUndefined()
  })

  describe('same-field disagreement at the same instant', () => {
    function twoAtOneInstant(aValue: string, bValue: string) {
      return subjectViewFromRecords([
        record(src('furnisher-a', '1'), 'individual', {
          categories: {
            c: {
              instances: [
                instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z', fields: { f: envelope(aValue) } }),
              ],
            },
          },
        }),
        record(src('furnisher-b', '2'), 'individual', {
          categories: {
            c: {
              instances: [
                instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z', fields: { f: envelope(bValue) } }),
              ],
            },
          },
        }),
      ]).categories.c!
    }

    it('SURFACES the conflict rather than resolving it, in contestedLead"s own shape', () => {
      const category = twoAtOneInstant('Employer A', 'Employer B')
      expect(category.fieldsByInstanceKey['']!.f!.contested!.sources).toEqual([
        { furnisherId: 'furnisher-a', recordRef: '1' },
        { furnisherId: 'furnisher-b', recordRef: '2' },
      ])
      // Same tie, same shape, at the two grains — the row lead is contested too.
      expect(category.contestedLead!.sources).toEqual(category.fieldsByInstanceKey['']!.f!.contested!.sources)
    })

    it('does NOT fire when the tied sources AGREE — an agreement is not a finding', () => {
      const category = twoAtOneInstant('Same Employer Sdn Bhd', 'Same Employer Sdn Bhd')
      const selection = category.fieldsByInstanceKey['']!.f!
      expect(selection.contested).toBeUndefined()
      expect('contested' in selection).toBe(false)
      // ...and the row-grain flag still fires, because at row grain the merge
      // cannot see values. The two grains disagreeing HERE is the answer, not
      // an inconsistency: "the lead row is arbitrary, and no field is disputed."
      expect(category.contestedLead!.sources).toHaveLength(2)
    })

    it('does NOT fire when the tie is confined to one source, matching contestedLead', () => {
      const category = subjectViewFromRecords([
        record(src('furnisher-a', '1'), 'individual', {
          categories: {
            c: {
              instances: [
                instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z', fields: { f: envelope('first') } }),
                instance({ instanceKey: '', observedAt: '2026-06-01T00:00:00.000Z', fields: { f: envelope('second') } }),
              ],
            },
          },
        }),
      ]).categories.c!
      expect(category.fieldsByInstanceKey['']!.f!.contested).toBeUndefined()
      expect(category.contestedLead).toBeUndefined()
      expect(category.fieldsByInstanceKey['']!.f!.envelope.value).toBe('first')
    })

    it('counts only the observations tied at the TOP rank for that field', () => {
      const at = (furnisherId: string, observedAt: string, value: string) =>
        record(src(furnisherId, '1'), 'individual', {
          categories: { c: { instances: [instance({ instanceKey: '', observedAt, fields: { f: envelope(value) } })] } },
        })
      const category = subjectViewFromRecords([
        at('a', '2026-06-01T00:00:00.000Z', 'lead-one'),
        at('b', '2026-06-01T00:00:00.000Z', 'lead-two'),
        at('c', '2020-01-01T00:00:00.000Z', 'ancient'),
      ]).categories.c!
      expect(category.fieldsByInstanceKey['']!.f!.contested!.sources.map((s) => s.furnisherId)).toEqual(['a', 'b'])
    })

    it('treats an ABSENT and an UNPARSEABLE observedAt as one rank, so they contest each other per field', () => {
      const category = subjectViewFromRecords([
        record(src('a', '1'), 'individual', {
          categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('absent') } })] } },
        }),
        record(src('b', '1'), 'individual', {
          categories: {
            c: {
              instances: [
                instance({ instanceKey: '', observedAt: 'not-a-timestamp', fields: { f: envelope('unparseable') } }),
              ],
            },
          },
        }),
      ]).categories.c!
      expect(category.fieldsByInstanceKey['']!.f!.contested!.sources.map((s) => s.furnisherId)).toEqual(['a', 'b'])
      // A real timestamp still beats both, per field as per row.
      expect(category.fieldsByInstanceKey['']!.f!.observedAt).toBeUndefined()
    })
  })

  /**
   * THE CHIMERA GUARD. Per-field selection is scoped to `instanceKey` — two
   * bank statements in one category are two different accounts, not two
   * observations of one. Fusing their fields would fabricate a row nobody
   * attested, which is a worse "not misleading" failure than the erasure this
   * ticket fixes.
   */
  it('never fuses fields across two different instanceKeys', () => {
    const merged = subjectViewFromRecords([
      record(src('furnisher-a', '1'), 'individual', {
        categories: {
          bankStatements: {
            cardinality: 'multi',
            instances: [
              instance({
                instanceKey: 'bankStatements#1',
                observedAt: '2026-01-01T00:00:00.000Z',
                fields: { accountNumber: envelope('111'), closingBalance: envelope('10') },
              }),
              instance({
                instanceKey: 'bankStatements#2',
                observedAt: '2026-06-01T00:00:00.000Z',
                fields: { accountNumber: envelope('222') },
              }),
            ],
          },
        },
      }),
    ])
    const byKey = merged.categories.bankStatements!.fieldsByInstanceKey
    expect(Object.keys(byKey).sort()).toEqual(['bankStatements#1', 'bankStatements#2'])
    expect(byKey['bankStatements#1']!.accountNumber!.envelope.value).toBe('111')
    expect(byKey['bankStatements#1']!.closingBalance!.envelope.value).toBe('10')
    // The newer, partial instance does not inherit the older one's balance.
    expect(byKey['bankStatements#2']!.accountNumber!.envelope.value).toBe('222')
    expect(byKey['bankStatements#2']!.closingBalance).toBeUndefined()
  })

  it('merges two furnishers under one instanceKey without either erasing the other', () => {
    const merged = subjectViewFromRecords([
      record(src('furnisher-a', '1'), 'individual', {
        categories: {
          docs: {
            instances: [
              instance({
                instanceKey: 'payslip#abc',
                observedAt: '2026-01-01T00:00:00.000Z',
                fields: { gross: envelope('5000'), net: envelope('4100') },
              }),
            ],
          },
        },
      }),
      record(src('furnisher-b', '1'), 'individual', {
        categories: {
          docs: {
            instances: [
              instance({
                instanceKey: 'payslip#abc',
                observedAt: '2026-06-01T00:00:00.000Z',
                fields: { gross: envelope('5500') },
              }),
            ],
          },
        },
      }),
    ])
    const selected = merged.categories.docs!.fieldsByInstanceKey['payslip#abc']!
    expect(selected.gross!.envelope.value).toBe('5500')
    expect(selected.gross!.source.furnisherId).toBe('furnisher-b')
    expect(selected.net!.envelope.value).toBe('4100')
    expect(selected.net!.source.furnisherId).toBe('furnisher-a')
  })

  it('hands back the SAME envelope reference the instance holds — the aliasing contract is unchanged', () => {
    const source = record(src('a', '1'), 'individual', {
      categories: { c: { instances: [instance({ instanceKey: '', fields: { f: envelope('original') } })] } },
    })
    const merged = subjectViewFromRecords([source])
    expect(merged.categories.c!.fieldsByInstanceKey['']!.f!.envelope).toBe(
      source.view.categories.c!.instances[0]!.fields.f!,
    )
  })

  /**
   * F10's hazard, one level further down: `instanceKey` and a FIELD NAME are
   * both producer-supplied text off the wire, and a plain-object accumulator
   * lets either one named `__proto__` read back `Object.prototype` — so a
   * "have I already claimed this field?" check answers for something nobody
   * furnished, and the real observation is silently dropped.
   */
  it('does not confuse a "__proto__" instanceKey or field name with Object.prototype', () => {
    const categories = JSON.parse(
      `{"c":{"instances":[{"instanceKey":"__proto__","adapterId":"t","adapterVersion":1,` +
        `"fields":{"__proto__":{"value":"deep","confidentiality":"internal"}}}]}}`,
    ) as CanonicalView['categories']

    const byKey = subjectViewFromRecords([record(src('a', '1'), 'individual', { categories })]).categories.c!
      .fieldsByInstanceKey
    expect(Object.prototype.hasOwnProperty.call(byKey, '__proto__')).toBe(true)
    const selected = (byKey as Record<string, Record<string, { envelope: { value: unknown } }>>)['__proto__']!
    expect(Object.prototype.hasOwnProperty.call(selected, '__proto__')).toBe(true)
    expect(selected['__proto__']!.envelope.value).toBe('deep')
  })

  it('gives an empty category an empty selection map rather than omitting the member', () => {
    const merged = subjectViewFromRecords([
      record(src('a', '1'), 'individual', { categories: { c: { instances: [] } } }),
    ])
    expect(merged.categories.c!.fieldsByInstanceKey).toEqual({})
  })

  it('is order-independent — the same selection whichever record is fed first', () => {
    const a = record(src('furnisher-a', '1'), 'individual', {
      categories: {
        c: {
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-01-01T00:00:00.000Z',
              fields: { one: envelope('a-one'), two: envelope('a-two') },
            }),
          ],
        },
      },
    })
    const b = record(src('furnisher-b', '2'), 'individual', {
      categories: {
        c: {
          instances: [
            instance({
              instanceKey: '',
              observedAt: '2026-06-01T00:00:00.000Z',
              fields: { two: envelope('b-two'), three: envelope('b-three') },
            }),
          ],
        },
      },
    })

    const forward = subjectViewFromRecords([a, b]).categories.c!.fieldsByInstanceKey
    const reverse = subjectViewFromRecords([b, a]).categories.c!.fieldsByInstanceKey
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse))
    expect(forward['']!.one!.envelope.value).toBe('a-one')
    expect(forward['']!.two!.envelope.value).toBe('b-two')
    expect(forward['']!.three!.envelope.value).toBe('b-three')
  })
})
