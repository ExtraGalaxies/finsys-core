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
 * SYS-3334 — the v2 canonical envelope, as a shape this package owns.
 *
 * WHY IT MOVED HERE. These types described the wire shape of a published API
 * and lived only in `@finsys/lender-client`, which is the SDK built for
 * EXTERNAL lenders. Every other consumer therefore had two bad options: take a
 * dependency on an SDK meant for someone else, or re-declare the shape. finhub
 * reads finsys-api through its own gateway and would have re-declared it;
 * FHD's portal would have been the third declaration.
 *
 * Two declarations of one wire shape drifting apart, with nothing comparing
 * them, is this estate's signature defect. So the shape lives once, in the
 * package that already owns published vocabulary — the category registry, the
 * field catalogue, the v1 migration map — and `@finsys/lender-client`
 * re-exports it. Member-for-member identical to what the SDK's 2.5.0
 * declared — but 2.5.0 never exported these names from its index (TS2305 on
 * `import type { CanonicalView } from '@finsys/lender-client'`), so the SDK's
 * re-export is the first release in which a consumer can name them. Additive
 * either way; the members and their meaning are unchanged.
 *
 * WHAT THIS FILE IS NOT. It is a description of a payload, not a client. There
 * is no fetching here and no instance-selection rule — selection is one
 * decision that every consumer must make identically, so it belongs with the
 * code that reads the envelope rather than with the types that describe it.
 */

/** One canonical value, with everything needed to judge it. */
export interface CanonicalFieldEnvelope {
  value: number | boolean | string
  /** Present only when it can be attributed to this instance's run. */
  confidence?: number
  origin?: string
  confidentiality: string
}

export interface CanonicalInstance {
  /** '' for a single-cardinality category. */
  instanceKey: string
  adapterId: string
  adapterVersion: number
  runId?: number
  observedAt?: string
  fields: Record<string, CanonicalFieldEnvelope>
}

export interface CanonicalCategory {
  /**
   * From the producing adapter's manifest, and it describes ONE RECORD:
   * `single` means at most one instance per application. It does NOT mean the
   * subject has one value — see the note on CanonicalView.
   */
  cardinality?: 'single' | 'multi'
  instances: CanonicalInstance[]
}

/**
 * THE SCOPE OF THIS RESPONSE IS ONE APPLICATION. Every instance below comes
 * from the record named by `ihsId`, which is why instances carry no
 * per-instance source reference — at this scope it would be a constant.
 *
 * Do not write code that assumes this is interchangeable with a subject-scoped
 * view. That response would carry source attribution per instance and would
 * re-scope or omit `cardinality`; a consumer that read `single` as licence to
 * take instances[0] is correct here and wrong there.
 */
export interface CanonicalView {
  ihsId: number
  categories: Record<string, CanonicalCategory>
}

/**
 * Where a v1 field lives on the canonical plane. Resolve it with a shared
 * resolver, never by hand — instance selection is the part consumers get
 * subtly different from each other, and a wrongly chosen instance is a
 * plausible value rather than an error.
 */
export interface CanonicalAddress {
  category: string
  field: string
  /**
   * Present: resolve to exactly this instance.
   * Absent: latest by observedAt, which is what v1's flat mirror actually did.
   */
  instanceKey?: string
}
