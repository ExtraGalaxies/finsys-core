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
 * SYS-3414 — where every key of the v1 flat IHS response goes in v2.
 *
 * A consumer migrating off `GET /lender/ihs/:ihsId` has one question per key:
 * what do I read instead? This answers it for all 662, and it answers
 * "nothing, and here is why" for the ones with no destination — which is the
 * half a rename table would leave out and the half that loses data.
 *
 * WHAT THIS IS NOT. It is not a runtime shim and nothing reads it at request
 * time. It is a migration instrument: consumers read it once, while porting.
 * It goes away with the v1 surface.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FAILURE MODE IT WAS BUILT AGAINST, because it bit twice while it was
 * being built and both times the output looked finished.
 *
 * 1. An address that does not resolve. The first draft emitted 20 addresses
 *    naming fields the category does not declare — 18 invented outright, and
 *    2 from substring matching, one of which sent `tangibleAssets` to
 *    `nonCurrentAssetIntangibleAssets`: the opposite fact, spelled almost the
 *    same. All 20 were confidently formatted.
 *
 * 2. An address that resolves and is still wrong. Resolving proves a field
 *    EXISTS somewhere; it does not prove it is the RIGHT somewhere. 38 keys
 *    carried a field name declared by more than one category, and matching on
 *    name alone silently took whichever category came first in the JSON — it
 *    put `companyName` on `financial-statement`, and split one bank statement
 *    across two categories while its own siblings went to a third.
 *
 * So this map records HOW each address was derived, in `via`, and the test
 * beside it re-proves closure against the live registry on every run. The two
 * `via` values that mean "somebody wrote this down" are `wide-column-feeder`
 * and `form-intake-fieldmap`; `name-equality` means "the names matched and
 * only one category declares it", which is weaker and is why an ambiguous
 * name is refused rather than guessed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A `mapped` entry is not a promise that data is there today. It is the
 * address. `mapped-pending-build` says the address is real and nothing writes
 * it yet — the field is declared, the table or the instance is not. Read
 * `retired` as "this key has no v2 destination", never as "this data is
 * gone": several retired keys are live data arriving under a different name
 * (`city` is submitted as `permanentcity`), and one, `ssmIncorporatedDate`,
 * is a dead column with live readers (SYS-3419).
 */

import raw from './data/v1-migration-map.json' with { type: 'json' };

/** What happens to a v1 key in v2. */
export type V1Disposition =
  /** One v2 address. Read it there. */
  | 'mapped'
  /** TWO attestors, one legacy column. v2 keeps both; the disagreement is the signal. */
  | 'mapped-fanout'
  /** The address is well-formed and nothing writes it yet. */
  | 'mapped-pending-build'
  /** Not adapter data — it moved to another surface, named in `surface`. */
  | 'relocated'
  /** v1 envelope machinery the v2 shape supersedes. */
  | 'structural'
  /** No v2 destination. NOT the same as "the data is gone" — read `note`. */
  | 'retired'
  /** A destination is wanted and no canonical field exists to be the destination. */
  | 'vocabulary-gap'
  /** More than one defensible destination; picking one needs an owner, not a lookup. */
  | 'needs-decision';

/** How the address was derived. The first two are authored; the rest are weaker. */
export type V1ResolutionSource =
  /** finsys-api's wideColumnFeeders.ts — which document category feeds the column. */
  | 'wide-column-feeder'
  /** A form-intake manifest's fieldMap — which form field produces the canonical one. */
  | 'form-intake-fieldmap'
  /** The category registry's own `legacyName` bridge. */
  | 'legacy-name'
  /** Names matched and exactly one category declares it. Refused when ambiguous. */
  | 'name-equality'
  /** The SYS-2499 column audit's NOT-ADAPTER classes. */
  | 'column-audit'
  /** The six-consumer sweep — a verdict no rule can derive. */
  | 'consumer-sweep'
  /** Authored against evidence cited in `note`. */
  | 'hand-authored';

/**
 * Where a value lives in v2.
 *
 * `instanceKey` names ONE instance. `instanceKeyPrefix` means the v1 key became
 * N instances and the reader must collect all of them — a shape change, not a
 * rename (a document-pointer column held a JSON array of paths; document-intake
 * keys one instance per file). AT MOST ONE OF THE TWO IS EVER PRESENT, and a
 * test asserts it, because an address carrying both would leave a consumer to
 * pick — and picking `instanceKey` on a fan-out silently reads one file of N.
 */
export interface V1Address {
  readonly category: string;
  readonly field: string;
  readonly instanceKey?: string;
  readonly instanceKeyPrefix?: string;
}

export interface V1MigrationEntry {
  readonly disposition: V1Disposition;
  readonly via?: V1ResolutionSource;
  /** Present on `mapped`, `mapped-pending-build`. */
  readonly address?: V1Address;
  /** Present on `mapped-fanout`, always length >= 2. */
  readonly addresses?: ReadonlyArray<V1Address>;
  /** Present on `relocated` — the surface that now serves this key. */
  readonly surface?: string;
  readonly note?: string;
  readonly reason?: string;
}

interface RawMap {
  readonly schemaVersion: string;
  readonly entries: Readonly<Record<string, V1MigrationEntry>>;
}

const map = raw as unknown as RawMap;

const DISPOSITIONS: ReadonlySet<string> = new Set<V1Disposition>([
  'mapped',
  'mapped-fanout',
  'mapped-pending-build',
  'relocated',
  'structural',
  'retired',
  'vocabulary-gap',
  'needs-decision',
]);

let validated = false;

/**
 * The cast above is a claim, not a check — TypeScript verifies nothing about
 * imported JSON at runtime, so a map carrying a disposition outside the union
 * would type-check as exhaustive and then fall through every consumer's
 * `switch` as `undefined`. A key silently treated as having no destination is
 * the precise shape of loss this map exists to prevent.
 *
 * So it is checked, and checked LAZILY rather than at module load. Every
 * production consumer of this package imports it for the category registry and
 * never touches the migration map; an import-time throw would turn a bad data
 * file into a total outage for code that does not read the data. Validating on
 * first access puts the failure where the data is actually used, and costs one
 * pass over 662 entries the first time somebody asks.
 */
function assertValidated(): void {
  if (validated) return;
  const bad: string[] = [];
  for (const [key, entry] of Object.entries(map.entries)) {
    if (!DISPOSITIONS.has(entry.disposition)) bad.push(`${key}: "${entry.disposition}"`);
  }
  if (bad.length > 0) {
    throw new Error(
      `v1-migration-map.json declares ${bad.length} unknown disposition(s), so this map cannot ` +
        `be read safely: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}. ` +
        `Regenerate it with scripts/build-v1-migration-map.py.`,
    );
  }
  validated = true;
}

/** Draft until the v1 surface retires; the shape may still move. */
export const V1_MIGRATION_MAP_VERSION: string = map.schemaVersion;

/** Every v1 response key this map accounts for. */
export function v1MigrationKeys(): ReadonlyArray<string> {
  assertValidated();
  return Object.keys(map.entries);
}

/** The disposition of one v1 key, or null if the map does not know it. */
export function v1MigrationEntry(key: string): V1MigrationEntry | null {
  assertValidated();
  return Object.prototype.hasOwnProperty.call(map.entries, key) ? map.entries[key]! : null;
}

/**
 * Every address a key resolves to — 0, 1, or (fanout) 2+.
 *
 * Returning an array rather than an optional single address is deliberate:
 * a caller that handles only the single case silently drops the second
 * attestor of a fanout key and reports one source's answer as "the" answer.
 */
export function v1Addresses(key: string): ReadonlyArray<V1Address> {
  const e = v1MigrationEntry(key);
  if (!e) return [];
  if (e.addresses) return e.addresses;
  return e.address ? [e.address] : [];
}

/** Keys sharing a disposition — for a consumer auditing its own reads. */
export function v1KeysByDisposition(d: V1Disposition): ReadonlyArray<string> {
  assertValidated();
  return Object.keys(map.entries).filter((k) => map.entries[k]!.disposition === d);
}

// ── Reverse lookup (SYS-3334) ────────────────────────────────────────

/**
 * The reverse of `v1Addresses`: given a place on the canonical plane, the v1
 * key that used to hold it — or null.
 *
 * WHY IT EXISTS. The instance-shaped detail processor has to render a v2 view
 * with the labels and groupings the v1 panel had, or the flag flip on the
 * consumer is a redesign rather than a migration. Both label and grouping are
 * keyed by the LEGACY column name (the display-name catalogue and the form
 * spec), so the processor needs canonical → legacy. This map is the only
 * complete statement of that relationship: 771 keys, generated and proven.
 *
 * WHEN IT ANSWERS NULL, AND WHY THAT IS THE RIGHT ANSWER.
 *   - No v1 key ever held this address: a canonical-only field (the alt-data
 *     categories, or a registry field newer than the wide table). The caller
 *     falls back to the registry's own names.
 *   - More than one v1 key maps here with no instanceKey to tell them apart:
 *     the T-slot families (bankBalanceT1..T6 → closingBalance). Those are
 *     document-extraction fields, rendered by the file-field tables and never
 *     by the detail panel, so the ambiguity never reaches a caller that needs
 *     it resolved. Returning null rather than a guess is deliberate: a guess
 *     would label six documents' balances "T1".
 *
 * `instanceKey` matters: `contactValue` at `email` was `email`, at `mobile` was
 * `mobilePhoneNo`. An address without one matches only entries without one.
 */
export function v1KeyForAddress(
  category: string,
  field: string,
  instanceKey?: string,
): string | null {
  const idx = reverseIndex();
  const hits = idx.get(reverseKey(category, field, instanceKey));
  return hits && hits.length === 1 ? hits[0]! : null;
}

function reverseKey(category: string, field: string, instanceKey?: string): string {
  return `${category} ${field} ${instanceKey ?? ''}`;
}

let reverse: Map<string, string[]> | null = null;

function reverseIndex(): Map<string, string[]> {
  if (reverse) return reverse;
  assertValidated();
  const idx = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(map.entries)) {
    // Only addresses a consumer can read TODAY. `mapped-pending-build` names a
    // destination that does not exist yet; sending a reader there is a wrong
    // answer with every success signal true.
    if (entry.disposition !== 'mapped' && entry.disposition !== 'mapped-fanout') continue;
    for (const a of entry.addresses ?? (entry.address ? [entry.address] : [])) {
      // A prefix address is a fan-out over N instances (document pointers);
      // no single instance corresponds to the v1 key, so it is not reversible.
      if (a.instanceKeyPrefix) continue;
      const k = reverseKey(a.category, a.field, a.instanceKey);
      const list = idx.get(k);
      if (list) list.push(key);
      else idx.set(k, [key]);
    }
  }
  reverse = idx;
  return idx;
}
