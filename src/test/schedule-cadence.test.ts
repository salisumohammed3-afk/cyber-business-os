import { describe, it, expect } from "vitest";
import {
  validateCadence,
  computeNextRun,
  describeCadence,
  previewNextRuns,
} from "../../api/lib/schedule.mjs";

// Anchor "now" so tests are deterministic. 2026-05-02 11:30:00 UTC = a Saturday.
const NOW = new Date(Date.UTC(2026, 4, 2, 11, 30, 0));

describe("Stage 5: scheduled-tasks cadence parser", () => {
  describe("validateCadence", () => {
    it("accepts valid hourly", () => {
      expect(validateCadence("hourly", { minute: 0 })).toBeNull();
      expect(validateCadence("hourly", { minute: 59 })).toBeNull();
    });
    it("rejects bad hourly minute", () => {
      expect(validateCadence("hourly", { minute: 60 })).toMatch(/0\.\.59/);
      expect(validateCadence("hourly", { minute: -1 })).toMatch(/0\.\.59/);
      expect(validateCadence("hourly", {})).toMatch(/0\.\.59/);
    });
    it("accepts valid daily", () => {
      expect(validateCadence("daily", { time: "09:30" })).toBeNull();
      expect(validateCadence("daily", { time: "09:30", tz: "Europe/London" })).toBeNull();
      expect(validateCadence("daily", { time: "00:00" })).toBeNull();
      expect(validateCadence("daily", { time: "23:59" })).toBeNull();
    });
    it("rejects bad daily time format", () => {
      expect(validateCadence("daily", { time: "9:30" })).toMatch(/HH:MM/);
      expect(validateCadence("daily", { time: "25:00" })).toMatch(/out of range/);
      expect(validateCadence("daily", {})).toMatch(/HH:MM/);
    });
    it("accepts valid weekly", () => {
      expect(validateCadence("weekly", { days: ["mon", "wed"], time: "09:00" })).toBeNull();
      expect(validateCadence("weekly", { days: ["fri"], time: "17:00", tz: "America/New_York" })).toBeNull();
    });
    it("rejects bad weekly", () => {
      expect(validateCadence("weekly", { days: [], time: "09:00" })).toMatch(/non-empty/);
      expect(validateCadence("weekly", { days: ["bogus"], time: "09:00" })).toMatch(/sun,mon,tue/);
      expect(validateCadence("weekly", { time: "09:00" })).toMatch(/non-empty/);
    });
    it("accepts valid monthly", () => {
      expect(validateCadence("monthly", { day_of_month: 1, time: "09:00" })).toBeNull();
      expect(validateCadence("monthly", { day_of_month: 28, time: "09:00" })).toBeNull();
    });
    it("rejects monthly day_of_month > 28 (forces use of cron for 29-31)", () => {
      expect(validateCadence("monthly", { day_of_month: 29, time: "09:00" })).toMatch(/1\.\.28/);
      expect(validateCadence("monthly", { day_of_month: 31, time: "09:00" })).toMatch(/1\.\.28/);
    });
    it("accepts valid cron", () => {
      expect(validateCadence("cron", { expr: "0 9 * * 1" })).toBeNull();
      expect(validateCadence("cron", { expr: "*/15 * * * *" })).toBeNull();
    });
    it("rejects bad cron", () => {
      expect(validateCadence("cron", { expr: "0 9 * *" })).toMatch(/5 space-separated/);
      expect(validateCadence("cron", {})).toMatch(/string/);
    });
    it("rejects unknown type", () => {
      expect(validateCadence("yearly", {})).toMatch(/unknown/);
    });
  });

  describe("computeNextRun: hourly", () => {
    it("rolls to next hour when target minute is past", () => {
      const next = computeNextRun("hourly", { minute: 0 }, NOW);
      // NOW is 11:30, next :00 is 12:00
      expect(next.toISOString()).toBe("2026-05-02T12:00:00.000Z");
    });
    it("stays in this hour when target minute is future", () => {
      const next = computeNextRun("hourly", { minute: 45 }, NOW);
      expect(next.toISOString()).toBe("2026-05-02T11:45:00.000Z");
    });
    it("rolls forward when target minute equals now", () => {
      // NOW is :30, target is :30 → must be NEXT hour, not now
      const next = computeNextRun("hourly", { minute: 30 }, NOW);
      expect(next.toISOString()).toBe("2026-05-02T12:30:00.000Z");
    });
  });

  describe("computeNextRun: daily (UTC)", () => {
    it("rolls to tomorrow when today's time has passed", () => {
      // NOW is 11:30 UTC; daily at 09:00 UTC has passed → tomorrow
      const next = computeNextRun("daily", { time: "09:00" }, NOW);
      expect(next.toISOString()).toBe("2026-05-03T09:00:00.000Z");
    });
    it("stays today when today's time is still future", () => {
      // NOW is 11:30 UTC; daily at 14:00 UTC is later today
      const next = computeNextRun("daily", { time: "14:00" }, NOW);
      expect(next.toISOString()).toBe("2026-05-02T14:00:00.000Z");
    });
  });

  describe("computeNextRun: daily with timezone", () => {
    it("Europe/London BST in May → 09:00 London = 08:00 UTC", () => {
      // 2026-05-02 is in BST (UTC+1). Daily at 09:00 London = 08:00 UTC.
      // NOW is 11:30 UTC = 12:30 London → today's 09:00 London has passed → tomorrow.
      const next = computeNextRun("daily", { time: "09:00", tz: "Europe/London" }, NOW);
      expect(next.toISOString()).toBe("2026-05-03T08:00:00.000Z");
    });
    it("America/New_York EDT in May → 09:00 NY = 13:00 UTC", () => {
      // EDT is UTC-4. Daily at 09:00 NY → 13:00 UTC.
      // NOW is 11:30 UTC; today's 13:00 UTC is still future.
      const next = computeNextRun("daily", { time: "09:00", tz: "America/New_York" }, NOW);
      expect(next.toISOString()).toBe("2026-05-02T13:00:00.000Z");
    });
  });

  describe("computeNextRun: weekly", () => {
    it("Monday 09:00 UTC from a Saturday", () => {
      // NOW = Saturday 11:30. Next Monday 09:00 = 2026-05-04 09:00 UTC.
      const next = computeNextRun("weekly", { days: ["mon"], time: "09:00" }, NOW);
      expect(next.toISOString()).toBe("2026-05-04T09:00:00.000Z");
    });
    it("multiple days picks soonest", () => {
      // Saturday 11:30. Days = mon,wed,fri. Next is Monday.
      const next = computeNextRun("weekly", { days: ["mon", "wed", "fri"], time: "09:00" }, NOW);
      expect(next.getUTCDay()).toBe(1); // Monday
    });
    it("today is one of the days but time has passed → next match", () => {
      // NOW is Saturday 11:30. Days = sat (today), time 09:00 passed.
      // Next sat = 7 days later.
      const next = computeNextRun("weekly", { days: ["sat"], time: "09:00" }, NOW);
      expect(next.toISOString()).toBe("2026-05-09T09:00:00.000Z");
    });
    it("today is one of the days and time is future → fires today", () => {
      // NOW is Saturday 11:30. Days = sat (today), time 17:00 future.
      const next = computeNextRun("weekly", { days: ["sat"], time: "17:00" }, NOW);
      expect(next.toISOString()).toBe("2026-05-02T17:00:00.000Z");
    });
  });

  describe("computeNextRun: monthly", () => {
    it("1st of next month if today's already past target", () => {
      // NOW = May 2nd. Target = 1st of month → this month's 1st passed → next is June 1st.
      const next = computeNextRun("monthly", { day_of_month: 1, time: "09:00" }, NOW);
      expect(next.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    });
    it("later this month when day_of_month is in future", () => {
      // NOW = May 2nd. Target = 15th → May 15th 09:00.
      const next = computeNextRun("monthly", { day_of_month: 15, time: "09:00" }, NOW);
      expect(next.toISOString()).toBe("2026-05-15T09:00:00.000Z");
    });
  });

  describe("computeNextRun: cron", () => {
    it("'0 9 * * 1' from Saturday = next Monday 09:00", () => {
      const next = computeNextRun("cron", { expr: "0 9 * * 1" }, NOW);
      expect(next.toISOString()).toBe("2026-05-04T09:00:00.000Z");
    });
    it("'*/15 * * * *' from 11:30 = 11:45", () => {
      const next = computeNextRun("cron", { expr: "*/15 * * * *" }, NOW);
      expect(next.toISOString()).toBe("2026-05-02T11:45:00.000Z");
    });
    it("supports lists 'min1,min2'", () => {
      const next = computeNextRun("cron", { expr: "0,30 * * * *" }, NOW);
      // 11:30 itself is past → next match is 12:00
      expect(next.toISOString()).toBe("2026-05-02T12:00:00.000Z");
    });
  });

  describe("previewNextRuns", () => {
    it("returns 3 successive firings", () => {
      const previews = previewNextRuns("daily", { time: "09:00" }, 3, NOW);
      expect(previews).toHaveLength(3);
      expect(previews[0].toISOString()).toBe("2026-05-03T09:00:00.000Z");
      expect(previews[1].toISOString()).toBe("2026-05-04T09:00:00.000Z");
      expect(previews[2].toISOString()).toBe("2026-05-05T09:00:00.000Z");
    });

    it("weekly with multiple days produces correct sequence", () => {
      const previews = previewNextRuns(
        "weekly",
        { days: ["mon", "wed", "fri"], time: "09:00" },
        4, NOW
      );
      // From Saturday: mon, wed, fri, mon
      expect(previews.map(p => p.getUTCDay())).toEqual([1, 3, 5, 1]);
    });
  });

  describe("describeCadence (human-readable preview)", () => {
    it("hourly", () => {
      expect(describeCadence("hourly", { minute: 15 })).toBe("every hour at :15");
    });
    it("daily UTC", () => {
      expect(describeCadence("daily", { time: "09:00" })).toBe("every day at 09:00 UTC");
    });
    it("daily with tz", () => {
      expect(describeCadence("daily", { time: "08:00", tz: "Europe/London" }))
        .toBe("every day at 08:00 Europe/London");
    });
    it("weekly", () => {
      expect(describeCadence("weekly", { days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00" }))
        .toBe("every Mon, Tue, Wed, Thu, Fri at 08:00 UTC");
    });
    it("monthly with ordinal", () => {
      expect(describeCadence("monthly", { day_of_month: 1, time: "09:00" }))
        .toBe("1st of every month at 09:00 UTC");
      expect(describeCadence("monthly", { day_of_month: 15, time: "09:00" }))
        .toBe("15th of every month at 09:00 UTC");
      expect(describeCadence("monthly", { day_of_month: 22, time: "09:00" }))
        .toBe("22nd of every month at 09:00 UTC");
      expect(describeCadence("monthly", { day_of_month: 23, time: "09:00" }))
        .toBe("23rd of every month at 09:00 UTC");
    });
    it("cron", () => {
      expect(describeCadence("cron", { expr: "0 9 * * 1" })).toBe("cron: 0 9 * * 1");
    });
  });
});
