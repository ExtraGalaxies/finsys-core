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
 * SYS-3334 — the v2 envelope's shape is a CONTRACT, and this pins it.
 *
 * These types moved here from `@finsys/lender-client`, which still declares
 * them for its 2.5.0 consumers and will re-export from here instead. That
 * re-export is only a no-op if the two declarations agree member for member,
 * and two declarations of one wire shape drifting apart — with nothing
 * comparing them — is the defect the move exists to prevent. It would be
 * absurd to reintroduce it in the act of fixing it.
 *
 * WHAT THIS FILE CAN AND CANNOT DO. It cannot compare against the SDK: core
 * must not depend on a package that depends on core. So it pins THIS side
 * exhaustively, and the two-way assignability check lives in the SDK's own
 * suite, which is the only place both declarations exist at once.
 *
 * The pins below are compile-time — `npm run lint` runs `tsc --noEmit`, so a
 * renamed or dropped member fails there rather than here. The runtime
 * assertions exist so the file is not silently excluded from the suite: a test
 * that only type-checks reports nothing when it stops being run at all.
 */
import { describe, expect, it } from 'vitest';

import type {
  CanonicalAddress,
  CanonicalCategory,
  CanonicalFieldEnvelope,
  CanonicalInstance,
  CanonicalView,
} from './canonical-view.js';
// The ROOT entry, not the module: this is what a consumer imports, and the
// module-level import above cannot see a name left out of index.ts. SYS-3421:
// `CanonicalAttestation` was declared in 8.1.0's first candidate and not
// exported — finsys-api's resolver hit TS2305 and mirrored the interface.
// `npm run lint` (tsc over src/**) turns a missing root export into TS2305
// on this line; vitest strips the type import, so the runtime is unaffected.
import type * as Root from './index.js';

describe('the v2 canonical envelope', () => {
  it('exports every member of the envelope from the ROOT entry (SYS-3421)', () => {
    // Type-level pins — each line is a compile error under `npm run lint` if
    // index.ts drops the name. The runtime assertion is deliberately trivial;
    // the test exists for tsc, and vitest is what runs it in CI.
    const attestation: Root.CanonicalAttestation = {
      value: 'x',
      origin: 'manual',
      adapterId: 'manual-override',
      adapterVersion: 1,
    };
    const envelope: Root.CanonicalFieldEnvelope = { value: 'x', confidentiality: 'internal' };
    const address: Root.CanonicalAddress = { category: 'applicant-identity', field: 'fullName' };
    const view: Root.CanonicalView = { ihsId: 1, categories: {} };
    const category: Root.CanonicalCategory = { instances: [] };
    const instance: Root.CanonicalInstance = {
      instanceKey: 'k',
      adapterId: 'a',
      adapterVersion: 1,
      fields: {},
      // SYS-3334 (round 2, F4): the v1-slot + per-instance-label pair.
      legacySlot: 'T1',
      periodPosition: 1,
      sourceLabel: 'Maybank',
    };
    expect([attestation, envelope, address, view, category, instance]).toHaveLength(6);
  });

  it('carries exactly the members a 2.5.0 consumer already builds against', () => {
    // Every OPTIONAL member is present here and every REQUIRED member is the
    // only thing omitted below, so both directions are pinned: dropping a
    // member breaks this literal, and making an optional member required
    // breaks the minimal literal in the next test.
    const envelope: CanonicalFieldEnvelope = {
      value: 'MY',
      confidence: 0.97,
      origin: 'extraction',
      confidentiality: 'sensitive',
      // SYS-3415: present only under a lender-overlay projection.
      originalValue: 'SG',
      // SYS-3421: present only when more than one attestation exists.
      attestations: [
        { value: 'MY', origin: 'manual', adapterId: 'manual-override-v1', adapterVersion: 1, runId: 99, observedAt: '2026-08-19T00:00:00.000Z', lenderId: 7 },
        { value: 'SG', origin: 'extraction', adapterId: 'finxtract-ic-v1', adapterVersion: 1, runId: 42 },
        // A clear is an attestation: `value: null` is admitted HERE and only
        // here (the envelope's `value` never is — a resolved null is absence).
        { value: null, origin: 'manual', adapterId: 'manual-override-v1', adapterVersion: 1, runId: 98, lenderId: 7 },
      ],
      resolvedBy: 'class-precedence@1',
    };
    const instance: CanonicalInstance = {
      instanceKey: 'mobile',
      adapterId: 'applicant-contact-form-v1',
      adapterVersion: 1,
      runId: 42,
      observedAt: '2026-08-18T00:00:00.000Z',
      fields: { contactValue: envelope },
      // SYS-3334 (round 2, F4): present ONLY when the source row carried a v1
      // slot / a human label — both optional, pinned here alongside the rest.
      legacySlot: 'T2',
      sourceLabel: 'Maybank',
      // The period COORDINATE (financial statements) — distinct from the slot.
      periodPosition: 2,
    };
    const category: CanonicalCategory = { cardinality: 'multi', instances: [instance] };
    const view: CanonicalView = {
      ihsId: 9154,
      categories: { 'applicant-contact': category },
      // SYS-3415: present iff read under `?overlay=mine`.
      overlay: { lenderId: 7, applied: 1, updatedAt: '2026-08-18T00:00:00.000Z', unprojected: [] },
    };
    const address: CanonicalAddress = {
      category: 'applicant-contact',
      field: 'contactValue',
      instanceKey: 'mobile',
    };

    expect(view.categories['applicant-contact']!.instances[0]!.fields.contactValue!.value).toBe('MY');
    expect(address.instanceKey).toBe('mobile');
  });

  it('the optional members really are optional', () => {
    // A `single` category legitimately has no cardinality declared, an
    // adapter run may carry no confidence, and an address WITHOUT an
    // instanceKey is the ordinary case — it means "latest by observedAt".
    // Making any of these required would break every such caller.
    const minimal: CanonicalView = {
      ihsId: 1,
      categories: {
        'applicant-identity': {
          instances: [
            {
              instanceKey: '',
              adapterId: 'applicant-identity-form-v1',
              adapterVersion: 1,
              fields: { personName: { value: 'Yusra Singh', confidentiality: 'sensitive' } },
            },
          ],
        },
      },
    };
    const latest: CanonicalAddress = { category: 'applicant-identity', field: 'personName' };

    expect(minimal.categories['applicant-identity']!.cardinality).toBeUndefined();
    expect(minimal.categories['applicant-identity']!.instances[0]!.instanceKey).toBe('');
    expect(latest.instanceKey).toBeUndefined();
  });

  it("a single-cardinality instance key is the empty string, not absent", () => {
    // The distinction is load-bearing: '' means "the one instance a
    // single-cardinality category has", and the host REFUSES a
    // single-cardinality manifest that carries a real key. A consumer reading
    // `instanceKey` as optional would write `?? 'default'` and invent a key
    // the API never uses.
    const instance: CanonicalInstance = {
      instanceKey: '',
      adapterId: 'subject-company-form-v1',
      adapterVersion: 1,
      fields: {},
    };
    expect(instance.instanceKey).toBe('');
    expect('instanceKey' in instance).toBe(true);
  });
});
