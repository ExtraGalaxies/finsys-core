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
 * Aggregation operators applied by the eval engine when a scoring
 * component reads a canonical field that has multiple instances
 * persisted for the same applicant.
 *
 * Multi-instance is the framework's first-class shape — an adapter
 * may produce 6 bank-statement instances, 12 monthly payment
 * snapshots, 3 mobile lines, etc., per applicant. Eval components
 * must declare HOW they want those instances collapsed into a single
 * scoring value. This module declares the operator set + the runtime
 * helper that applies one to a value list.
 *
 * Consumer is the eval engine (today: finsys-client + FinSim sim-
 * runner; tomorrow: anywhere else evaluating against canonical
 * fields). finsys-core publishes the operator surface so policy
 * fixtures across all consumers reference the same set.
 *
 * v1 operator set, in order of expected use frequency:
 *
 *   sum    — total across instances. Bank balance sum across t1..tN.
 *   mean   — arithmetic mean. Average monthly payment volume.
 *   latest — the instance with the most recent observed_at. Telco
 *            snapshot when only the latest matters.
 *   max    — maximum value across instances. Worst-case suspension
 *            count when multiple telco lines exist.
 *   count  — number of instances with a non-null value for this
 *            field. Useful for "how many bank statements does this
 *            applicant have on file" as a score input.
 */

import type { CanonicalFieldValue } from "./adapter.js";

export type AggregationOp = "sum" | "mean" | "latest" | "max" | "count";

/** Every operator declared in this version of finsys-core. */
export const ALL_AGGREGATION_OPS: ReadonlyArray<AggregationOp> = [
  "sum",
  "mean",
  "latest",
  "max",
  "count",
] as const;

/**
 * One value contributed by one instance. The eval engine builds a
 * list of these (one per instance, in observed-at order — the
 * persistence layer is the source of truth on ordering) and passes
 * to applyAggregation.
 */
export interface InstanceValue {
  readonly value: CanonicalFieldValue;
  /**
   * The instance's observed-at timestamp (ISO string). Only the
   * `latest` operator inspects this; others ignore. Pass an empty
   * string if the operator in question doesn't need it.
   */
  readonly observedAt: string;
}

/**
 * Apply an aggregation operator to a list of instance values.
 *
 * Behaviour for empty + null-only lists:
 *   - empty list → `null`
 *   - all-null values → `null`
 *   - `count` on either of the above → `0`
 *
 * Returns:
 *   - `sum`, `mean`, `max`, `count` → `number | null`
 *   - `latest` → matches the value type of the most-recent instance
 *     (number / boolean / string / null)
 *
 * Throws on operators that don't apply to the value types present
 * (e.g. `sum` of booleans). Eval-policy authors are expected to pair
 * operators with appropriate field types; this is a guardrail against
 * silent garbage rather than an error-recovery mechanism.
 */
export function applyAggregation(
  op: AggregationOp,
  instances: ReadonlyArray<InstanceValue>,
): CanonicalFieldValue {
  if (instances.length === 0) {
    return op === "count" ? 0 : null;
  }

  if (op === "count") {
    return instances.filter((i) => i.value !== null && i.value !== undefined)
      .length;
  }

  if (op === "latest") {
    // Newest by observedAt wins. Stable for tied timestamps (first
    // in list — caller controls input ordering).
    let pick = instances[0]!;
    for (let i = 1; i < instances.length; i++) {
      if (instances[i]!.observedAt > pick.observedAt) pick = instances[i]!;
    }
    return pick.value;
  }

  // Numeric operators below this point. Filter to numeric values
  // only; everything else is silently dropped (a string canonical
  // field can't be summed). If nothing numeric remains, return null.
  const nums: number[] = [];
  for (const i of instances) {
    if (typeof i.value === "number" && Number.isFinite(i.value)) {
      nums.push(i.value);
    } else if (i.value !== null && typeof i.value !== "undefined") {
      throw new Error(
        `applyAggregation: '${op}' requires numeric values; got ${typeof i.value}`,
      );
    }
  }

  if (nums.length === 0) return null;

  switch (op) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "mean":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "max":
      return Math.max(...nums);
  }
}
