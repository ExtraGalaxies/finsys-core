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
import type { AdapterExtraction, PeriodValues } from "./adapter.js";

/**
 * SYS-3002 — per-period value sets on AdapterExtraction. These are
 * TS-shape tests: AdapterExtraction has no JSON-schema surface in this
 * package (host apps validate extractions at runtime), so the contract
 * lives in the type and these tests exercise it — a shape drift breaks
 * compilation here before it breaks a consumer.
 */
describe("SYS-3002: AdapterExtraction.periods", () => {
  /**
   * The motivating consumer, financial-statement-shaped: ONE document
   * instance carrying period1 (its current fiscal year — the FIRST
   * contractual position, 1-based, there is no period0) and period2
   * (its prior comparative year — the SECOND position). The two
   * positions' date ranges are adjacent here but the contract allows
   * overlap/nesting/stagger — identity is position, never dates.
   */
  function financialStatementInstance(): AdapterExtraction {
    return {
      instanceKey: "doc-fs-2025",
      observedAt: "2026-03-15T00:00:00Z",
      // Instance-level values stay the home for period-less
      // (instance-scoped) fields, e.g. the company name on the cover.
      values: { companyName: "Contoso Sdn Bhd" },
      confidence: { companyName: 0.97 },
      periods: [
        {
          position: 1, // 1-based: the FIRST declared period, current fiscal year
          start: "2025-01-01",
          end: "2025-12-31",
          values: { revenue: 1_200_000, netProfit: 150_000 },
          confidence: { revenue: 0.95, netProfit: 0.9 },
        },
        {
          position: 2, // the SECOND declared period, prior comparative year
          start: "2024-01-01",
          end: "2024-12-31",
          values: { revenue: 950_000, netProfit: 110_000 },
          confidence: { revenue: 0.88, netProfit: null }, // null = derived, no confidence
        },
      ],
    };
  }

  it("carries per-period value sets keyed by 1-based position (period1 = first declared period)", () => {
    const instance = financialStatementInstance();
    expect(instance.periods).toHaveLength(2);
    expect(instance.periods?.[0].position).toBe(1);
    expect(instance.periods?.[1].position).toBe(2);
    // No period0: the first contractual position is 1.
    expect(instance.periods?.every((p) => p.position >= 1)).toBe(true);
  });

  it("keeps period-scoped fields in periods[].values while instance-level values holds period-less fields", () => {
    const instance = financialStatementInstance();
    expect(instance.values.companyName).toBe("Contoso Sdn Bhd");
    expect(instance.periods?.[0].values.revenue).toBe(1_200_000);
    expect(instance.periods?.[1].values.revenue).toBe(950_000);
  });

  it("dated metadata (start/end) is optional display metadata, never identity", () => {
    // A period without dates is fully valid — position alone identifies it.
    const undated: PeriodValues = {
      position: 1,
      values: { revenue: 500_000 },
    };
    expect(undated.start).toBeUndefined();
    expect(undated.end).toBeUndefined();
    expect(undated.position).toBe(1);
  });

  it("per-period confidence follows the instance-level semantics (0..1, null = derived)", () => {
    const instance = financialStatementInstance();
    expect(instance.periods?.[0].confidence?.revenue).toBe(0.95);
    expect(instance.periods?.[1].confidence?.netProfit).toBeNull();
  });

  it("periods is optional — a flat single-period extraction remains valid unchanged (backward compat)", () => {
    const flat: AdapterExtraction = {
      instanceKey: "",
      values: { telcoTenureMonths: 36 },
    };
    expect("periods" in flat).toBe(false);
    expect(flat.values.telcoTenureMonths).toBe(36);
  });
});
