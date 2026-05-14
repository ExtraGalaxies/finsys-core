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

import { describe, it, expect } from "vitest";
import {
  ALL_AGGREGATION_OPS,
  applyAggregation,
  type InstanceValue,
} from "./adapter-aggregation.js";

function numericInstances(values: number[]): InstanceValue[] {
  return values.map((v, i) => ({
    value: v,
    observedAt: `2026-01-0${i + 1}T00:00:00Z`,
  }));
}

describe("ALL_AGGREGATION_OPS catalogue", () => {
  it("declares the v1 operator set", () => {
    expect(ALL_AGGREGATION_OPS).toEqual([
      "sum",
      "mean",
      "latest",
      "max",
      "count",
    ]);
  });
});

describe("applyAggregation — empty / null handling", () => {
  it("returns null on empty input for all non-count ops", () => {
    for (const op of ALL_AGGREGATION_OPS) {
      const result = applyAggregation(op, []);
      if (op === "count") expect(result).toBe(0);
      else expect(result).toBeNull();
    }
  });

  it("count is 0 on empty + all-null", () => {
    expect(applyAggregation("count", [])).toBe(0);
    expect(
      applyAggregation("count", [
        { value: null, observedAt: "" },
        { value: null, observedAt: "" },
      ]),
    ).toBe(0);
  });

  it("numeric ops return null when every instance is null", () => {
    const nulls: InstanceValue[] = [
      { value: null, observedAt: "2026-01-01" },
      { value: null, observedAt: "2026-01-02" },
    ];
    expect(applyAggregation("sum", nulls)).toBeNull();
    expect(applyAggregation("mean", nulls)).toBeNull();
    expect(applyAggregation("max", nulls)).toBeNull();
  });
});

describe("applyAggregation — sum + mean + max + count", () => {
  it("sums a list of numbers", () => {
    expect(applyAggregation("sum", numericInstances([10, 20, 30]))).toBe(60);
  });

  it("computes a mean", () => {
    expect(applyAggregation("mean", numericInstances([10, 20, 30]))).toBe(20);
  });

  it("returns the max", () => {
    expect(applyAggregation("max", numericInstances([10, 50, 30]))).toBe(50);
  });

  it("counts non-null instances", () => {
    expect(
      applyAggregation("count", [
        { value: 1, observedAt: "" },
        { value: null, observedAt: "" },
        { value: 2, observedAt: "" },
      ]),
    ).toBe(2);
  });

  it("drops null contributions silently from numeric ops", () => {
    const mixed: InstanceValue[] = [
      { value: 10, observedAt: "2026-01-01" },
      { value: null, observedAt: "2026-01-02" },
      { value: 30, observedAt: "2026-01-03" },
    ];
    expect(applyAggregation("sum", mixed)).toBe(40);
    expect(applyAggregation("mean", mixed)).toBe(20);
  });

  it("throws on summing booleans", () => {
    const bools: InstanceValue[] = [
      { value: true, observedAt: "2026-01-01" },
      { value: false, observedAt: "2026-01-02" },
    ];
    expect(() => applyAggregation("sum", bools)).toThrow(/requires numeric/);
  });
});

describe("applyAggregation — latest", () => {
  it("picks the value with the most recent observedAt", () => {
    const xs: InstanceValue[] = [
      { value: "stale", observedAt: "2026-01-01T00:00:00Z" },
      { value: "fresh", observedAt: "2026-06-01T00:00:00Z" },
      { value: "middle", observedAt: "2026-03-01T00:00:00Z" },
    ];
    expect(applyAggregation("latest", xs)).toBe("fresh");
  });

  it("returns the value (any type) of the latest instance", () => {
    const xs: InstanceValue[] = [
      { value: 1, observedAt: "2026-01-01" },
      { value: true, observedAt: "2026-06-01" },
    ];
    expect(applyAggregation("latest", xs)).toBe(true);
  });

  it("is stable for tied observedAt (first wins)", () => {
    const xs: InstanceValue[] = [
      { value: "first", observedAt: "2026-01-01" },
      { value: "second", observedAt: "2026-01-01" },
    ];
    expect(applyAggregation("latest", xs)).toBe("first");
  });
});
