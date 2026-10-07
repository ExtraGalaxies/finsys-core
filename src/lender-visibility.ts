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
 * The form fields that may ever be lender-visible on a bureau record, per
 * jurisdiction.
 *
 * A program chooses a subset of its jurisdiction's list; nothing outside the
 * list may ever be chosen. The list holds loan terms only. Identity fields are
 * not here: the consumer keeps them always visible.
 *
 * A jurisdiction is ASSESSED if and only if the list declares it, even with no
 * fields. An undeclared jurisdiction has no lender-visible fields at all, and a
 * consumer should refuse to configure lender visibility under it.
 *
 * Why a separate list, not an attribute on a form field: a form config is
 * authored data and accepts any key, so an attribute could be stamped onto a
 * custom field. The list lives only here, and every content change is one
 * reviewable diff with its own `version`.
 *
 * Adding a field is a minor release. Removing one is a major release, because
 * consumers' stored subsets that name it stop validating.
 */

import listData from "./data/lender-visible-eligible.json" with { type: "json" };
import { BASE_FIELD_SPECS } from "./catalogs.js";
import { JURISDICTION_CODES, resolveJurisdiction, type Jurisdiction } from "./jurisdiction.js";

/** One jurisdiction's eligible list. `version` bumps on every content change. */
export type LenderVisibleEligibleList = Readonly<{ version: number; fields: ReadonlyArray<string> }>;

/** Assessed jurisdictions only. An absent key means not assessed. */
export type LenderVisibleEligibleTable = Readonly<Partial<Record<Jurisdiction, LenderVisibleEligibleList>>>;

/** Why a subset, or one entry of it, was refused. */
export enum LenderVisibleRefusal {
  /** The subset is not an array. */
  NotAnArray = "not_an_array",
  /** The jurisdiction is unknown, or the list does not declare it. */
  UnassessedJurisdiction = "unassessed_jurisdiction",
  NotAString = "not_a_string",
  /** Not a base field: a custom field, or no field at all. */
  NotInBaseSpec = "not_in_base_spec",
  /** A document (file) field. Never eligible. */
  DocumentField = "document_field",
  /** A base field this jurisdiction's list does not declare. */
  NotEligible = "not_eligible",
  /** A repeat of an earlier entry. */
  Duplicate = "duplicate",
}

/** One refusal. `field` is the offending entry; absent when the whole input was refused. */
export type LenderVisibleRefusalDetail = Readonly<{ reason: LenderVisibleRefusal; field?: unknown }>;

export type LenderVisibleSubsetCheck =
  | Readonly<{ ok: true; jurisdiction: Jurisdiction; version: number; fields: ReadonlyArray<string> }>
  | Readonly<{ ok: false; refusals: ReadonlyArray<LenderVisibleRefusalDetail> }>;

const namesOf = (fields: typeof BASE_FIELD_SPECS.fields): Set<string> =>
  new Set(fields.flatMap((f) => (typeof f.name === "string" ? [f.name] : [])));

const BASE_NAMES: ReadonlySet<string> = namesOf(BASE_FIELD_SPECS.fields);

/** A file field, or any field pointing at a document. Module-only; exported for tests. */
export const isDocumentFieldSpec = (f: (typeof BASE_FIELD_SPECS.fields)[number]): boolean =>
  f.type === "file" || f.document_type != null;

// A name is a document field if ANY base entry with that name is one; the base
// spec repeats some names, so this fails closed.
const DOCUMENT_NAMES: ReadonlySet<string> = namesOf(BASE_FIELD_SPECS.fields.filter(isDocumentFieldSpec));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates and deep-freezes a table. Throws on any bad entry; the shipped
 * table is built with it at module load, so bad shipped data fails the import.
 *
 * Not re-exported from the package: a caller-built table is a channel for
 * widening the list. It stays module-exported for this package's tests.
 */
export function buildLenderVisibleEligible(raw: unknown): LenderVisibleEligibleTable {
  if (!isPlainObject(raw)) {
    throw new Error("lender-visible eligible list must be an object of jurisdiction → {version, fields}");
  }
  const table: Partial<Record<Jurisdiction, LenderVisibleEligibleList>> = {};
  for (const [j, entry] of Object.entries(raw)) {
    const at = `lender-visible eligible list "${j}"`;
    if (!(JURISDICTION_CODES as readonly string[]).includes(j)) {
      throw new Error(`${at}: the jurisdiction registry does not declare "${j}"`);
    }
    if (!isPlainObject(entry)) throw new Error(`${at} must be an object of {version, fields}`);
    const { version, fields } = entry;
    if (!Number.isInteger(version) || (version as number) < 1) {
      throw new Error(`${at}: version must be a positive integer`);
    }
    if (!Array.isArray(fields)) throw new Error(`${at}: fields must be an array`);
    const seen = new Set<string>();
    for (const name of fields) {
      if (typeof name !== "string") throw new Error(`${at}: entry ${JSON.stringify(name)} is not a string`);
      if (!BASE_NAMES.has(name)) throw new Error(`${at}: "${name}" is not a base field`);
      if (DOCUMENT_NAMES.has(name)) throw new Error(`${at}: "${name}" is a document field`);
      if (seen.has(name)) throw new Error(`${at}: "${name}" is listed more than once`);
      seen.add(name);
    }
    table[j as Jurisdiction] = Object.freeze({
      version: version as number,
      fields: Object.freeze([...(fields as string[])]),
    });
  }
  return Object.freeze(table);
}

/** The shipped list, validated at load. Deep-frozen. */
export const LENDER_VISIBLE_ELIGIBLE: LenderVisibleEligibleTable = buildLenderVisibleEligible(listData);

function listFor(table: LenderVisibleEligibleTable, jurisdiction: string | null | undefined): LenderVisibleEligibleList | null {
  // Absence means Malaysia, as everywhere on this axis; '' and unknown codes resolve to null.
  const resolved = resolveJurisdiction(jurisdiction);
  return resolved === null ? null : (table[resolved] ?? null);
}

/** The eligible list for a jurisdiction, or null when it is not assessed. Absence means MY. */
export function lenderVisibleEligibleFor(jurisdiction: string | null | undefined): LenderVisibleEligibleList | null {
  return listFor(LENDER_VISIBLE_ELIGIBLE, jurisdiction);
}

/**
 * Whether a jurisdiction's lender-visible fields have been assessed. A consumer
 * should refuse lender visibility settings under a jurisdiction where this is
 * false. Absence means MY; '' and unknown codes are false.
 */
export function isLenderVisibilityAssessed(jurisdiction: string | null | undefined): boolean {
  return lenderVisibleEligibleFor(jurisdiction) !== null;
}

/** `checkLenderVisibleSubset` against a given table. Module-only; see `buildLenderVisibleEligible`. */
export function checkLenderVisibleSubsetAgainst(
  table: LenderVisibleEligibleTable,
  jurisdiction: string | null | undefined,
  fields: unknown,
): LenderVisibleSubsetCheck {
  const list = listFor(table, jurisdiction);
  const whole: LenderVisibleRefusalDetail[] = [];
  if (list === null) whole.push({ reason: LenderVisibleRefusal.UnassessedJurisdiction });
  if (!Array.isArray(fields)) whole.push({ reason: LenderVisibleRefusal.NotAnArray });
  if (list === null || !Array.isArray(fields)) return { ok: false, refusals: whole };

  const eligible = new Set(list.fields);
  const seen = new Set<string>();
  const refusals: LenderVisibleRefusalDetail[] = [];
  for (const field of fields as unknown[]) {
    let reason: LenderVisibleRefusal | null = null;
    if (typeof field !== "string") reason = LenderVisibleRefusal.NotAString;
    else if (!BASE_NAMES.has(field)) reason = LenderVisibleRefusal.NotInBaseSpec;
    else if (DOCUMENT_NAMES.has(field)) reason = LenderVisibleRefusal.DocumentField;
    else if (!eligible.has(field)) reason = LenderVisibleRefusal.NotEligible;
    else if (seen.has(field)) reason = LenderVisibleRefusal.Duplicate;
    if (reason !== null) refusals.push({ reason, field });
    else seen.add(field as string);
  }
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, jurisdiction: resolveJurisdiction(jurisdiction)!, version: list.version, fields: [...seen].sort() };
}

/**
 * Validates a program's chosen subset against its jurisdiction's list.
 *
 * Refuses a non-array, an unassessed jurisdiction, and any entry that is not a
 * string, not a base field (a custom name), a document field, not in the list,
 * or a duplicate. Every refused entry is named. On success the fields come back
 * sorted, with the list version they were checked against.
 */
export function checkLenderVisibleSubset(jurisdiction: string | null | undefined, fields: unknown): LenderVisibleSubsetCheck {
  return checkLenderVisibleSubsetAgainst(LENDER_VISIBLE_ELIGIBLE, jurisdiction, fields);
}

/** `narrowToLenderVisibleEligible` against a given table. Module-only; see `buildLenderVisibleEligible`. */
export function narrowToLenderVisibleEligibleAgainst(
  table: LenderVisibleEligibleTable,
  jurisdiction: string | null | undefined,
  fields: unknown,
): string[] {
  const list = listFor(table, jurisdiction);
  if (list === null || !Array.isArray(fields)) return [];
  const eligible = new Set(list.fields);
  const out = new Set<string>();
  for (const f of fields as unknown[]) {
    if (typeof f === "string" && eligible.has(f)) out.add(f);
  }
  return [...out].sort();
}

/**
 * The fields of `fields` that are in the jurisdiction's list, deduped and
 * sorted. Never throws and never widens: an unassessed jurisdiction or a
 * non-array yields [].
 */
export function narrowToLenderVisibleEligible(jurisdiction: string | null | undefined, fields: unknown): string[] {
  return narrowToLenderVisibleEligibleAgainst(LENDER_VISIBLE_ELIGIBLE, jurisdiction, fields);
}
