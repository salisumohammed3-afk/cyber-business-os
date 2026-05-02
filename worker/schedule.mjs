// Cadence parser + next-run computation. Pure ES module, no deps.
// Imported by:
//   - api/schedules.ts (validates proposals + computes next_run_at on create)
//   - worker/schedule-firing.mjs (computes next_run_at after each firing)
//
// Supported cadence types:
//   hourly:  { minute: 0..59 }                              fires every hour at :MM
//   daily:   { time: "HH:MM", tz?: "Europe/London" }        fires once per day at HH:MM tz
//   weekly:  { days: ["mon","wed"], time: "HH:MM", tz? }    fires on listed days
//   monthly: { day_of_month: 1..28, time: "HH:MM", tz? }    fires once per month
//   cron:    { expr: "0 9 * * 1" }                          escape hatch (subset: nums, *, /step, lists)
//
// All next_run_at values returned as Date in UTC. tz only affects how HH:MM is interpreted.
// Capped day_of_month at 28 to dodge edge cases (no Feb 30, no day 31 in 30-day months).

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ── Timezone offset helper ──────────────────────────────────────────────────
// Returns the offset (ms) such that:  wallClockInTz = utcDate + offset.
// Positive for east-of-UTC (London BST = +3600000, NY EST = -18000000).
function tzOffsetMs(utcDate, tz) {
  if (!tz || tz === "UTC") return 0;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(utcDate);
  const g = t => parts.find(p => p.type === t)?.value;
  const asUtc = Date.UTC(
    parseInt(g("year")),
    parseInt(g("month")) - 1,
    parseInt(g("day")),
    parseInt(g("hour") === "24" ? "0" : g("hour")),  // some locales return "24" for midnight
    parseInt(g("minute")),
    parseInt(g("second"))
  );
  return asUtc - utcDate.getTime();
}

// Build a UTC Date from a target tz wall-clock specification.
// Handles DST by computing the offset at the candidate time.
function tzWallClockToUtc(year, month, day, hour, minute, tz) {
  // First pass: assume offset stable around target time
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = tzOffsetMs(candidate, tz);
  candidate = new Date(candidate.getTime() - offset);
  // Second pass to handle DST jumps where the offset itself shifted.
  // (Rare but real around clock-change dates.)
  const offset2 = tzOffsetMs(candidate, tz);
  if (offset2 !== offset) {
    candidate = new Date(new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).getTime() - offset2);
  }
  return candidate;
}

// Get the wall-clock parts of a UTC date in a target tz
function partsInTz(utcDate, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const parts = fmt.formatToParts(utcDate);
  const g = t => parts.find(p => p.type === t)?.value;
  return {
    year: parseInt(g("year")),
    month: parseInt(g("month")),
    day: parseInt(g("day")),
    hour: parseInt(g("hour") === "24" ? "0" : g("hour")),
    minute: parseInt(g("minute")),
    weekday: g("weekday").toLowerCase().slice(0, 3),
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateCadence(type, spec) {
  if (!spec || typeof spec !== "object") return "cadence_spec must be an object";
  if (type === "hourly") {
    const m = Number(spec.minute);
    if (!Number.isInteger(m) || m < 0 || m > 59) return "hourly.minute must be 0..59";
    return null;
  }
  if (type === "daily" || type === "weekly" || type === "monthly") {
    if (typeof spec.time !== "string" || !/^\d{2}:\d{2}$/.test(spec.time))
      return type + ".time must be 'HH:MM'";
    const [h, m] = spec.time.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) return type + ".time hour/minute out of range";
    if (type === "weekly") {
      if (!Array.isArray(spec.days) || spec.days.length === 0)
        return "weekly.days must be a non-empty array (e.g. ['mon','wed'])";
      for (const d of spec.days) {
        if (!DAYS.includes(String(d).toLowerCase()))
          return "weekly.days values must be one of: " + DAYS.join(",");
      }
    }
    if (type === "monthly") {
      const d = Number(spec.day_of_month);
      if (!Number.isInteger(d) || d < 1 || d > 28)
        return "monthly.day_of_month must be 1..28 (use cron for 29-31)";
    }
    return null;
  }
  if (type === "cron") {
    if (typeof spec.expr !== "string") return "cron.expr must be a string";
    const fields = spec.expr.trim().split(/\s+/);
    if (fields.length !== 5) return "cron.expr must be 5 space-separated fields: 'min hr dom mon dow'";
    return null;
  }
  return "unknown cadence type: " + type;
}

// ── Cron parsing (minimal subset: numbers, *, ranges a-b, lists a,b, /step) ─

function parseCronField(field, min, max) {
  // Returns array of valid integers within [min, max]
  const parts = field.split(",");
  const out = new Set();
  for (const part of parts) {
    let [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;
    let start, end;
    if (range === "*") {
      start = min; end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      start = a; end = b;
    } else {
      const n = parseInt(range);
      start = n; end = n;
    }
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("invalid cron field: " + field);
    for (let v = start; v <= end; v += step) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function nextCronMatch(expr, fromUtc) {
  const [minF, hrF, domF, monF, dowF] = expr.trim().split(/\s+/);
  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hrF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);
  // Walk minute by minute from fromUtc+1 up to ~5y forward
  let t = new Date(fromUtc.getTime() + 60_000 - (fromUtc.getSeconds() * 1000) - fromUtc.getMilliseconds());
  const limit = new Date(fromUtc.getTime() + 5 * 365 * 24 * 60 * 60_000);
  while (t < limit) {
    const min = t.getUTCMinutes();
    const hr = t.getUTCHours();
    const dom = t.getUTCDate();
    const mon = t.getUTCMonth() + 1;
    const dow = t.getUTCDay();
    if (
      minutes.includes(min) &&
      hours.includes(hr) &&
      doms.includes(dom) &&
      months.includes(mon) &&
      dows.includes(dow)
    ) {
      return new Date(t);
    }
    t = new Date(t.getTime() + 60_000);
  }
  throw new Error("cron expression has no match within 5 years");
}

// ── Main: compute next run ──────────────────────────────────────────────────

export function computeNextRun(type, spec, fromUtc) {
  const from = fromUtc instanceof Date ? fromUtc : new Date(fromUtc);

  if (type === "hourly") {
    const targetMin = Number(spec.minute);
    const next = new Date(from);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(targetMin);
    if (next <= from) next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }

  if (type === "daily") {
    const tz = spec.tz || "UTC";
    const [h, m] = spec.time.split(":").map(Number);
    const here = partsInTz(from, tz);
    let candidate = tzWallClockToUtc(here.year, here.month, here.day, h, m, tz);
    if (candidate <= from) {
      // Roll forward 1 day in target tz
      const tomorrow = new Date(candidate.getTime() + 24 * 3600_000);
      const tParts = partsInTz(tomorrow, tz);
      candidate = tzWallClockToUtc(tParts.year, tParts.month, tParts.day, h, m, tz);
    }
    return candidate;
  }

  if (type === "weekly") {
    const tz = spec.tz || "UTC";
    const [h, m] = spec.time.split(":").map(Number);
    const targetDows = new Set(spec.days.map(d => DAYS.indexOf(String(d).toLowerCase())));
    // Walk forward day by day up to 8 days to find a match
    for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
      const probe = new Date(from.getTime() + dayOffset * 24 * 3600_000);
      const parts = partsInTz(probe, tz);
      const dow = DAYS.indexOf(parts.weekday);
      if (!targetDows.has(dow)) continue;
      const candidate = tzWallClockToUtc(parts.year, parts.month, parts.day, h, m, tz);
      if (candidate > from) return candidate;
    }
    throw new Error("weekly: no future match in next 7 days (impossible given valid input)");
  }

  if (type === "monthly") {
    const tz = spec.tz || "UTC";
    const [h, m] = spec.time.split(":").map(Number);
    const dom = Number(spec.day_of_month);
    const here = partsInTz(from, tz);
    // Try this month first
    let candidate = tzWallClockToUtc(here.year, here.month, dom, h, m, tz);
    if (candidate <= from) {
      // Roll to next month
      let nextMonth = here.month + 1;
      let nextYear = here.year;
      if (nextMonth > 12) { nextMonth = 1; nextYear++; }
      candidate = tzWallClockToUtc(nextYear, nextMonth, dom, h, m, tz);
    }
    return candidate;
  }

  if (type === "cron") {
    return nextCronMatch(spec.expr, from);
  }

  throw new Error("unknown cadence type: " + type);
}

// ── Human-readable preview (for chat cards + Settings UI) ───────────────────

export function describeCadence(type, spec) {
  const tz = spec.tz || "UTC";
  if (type === "hourly") return `every hour at :${String(spec.minute).padStart(2, "0")}`;
  if (type === "daily") return `every day at ${spec.time} ${tz}`;
  if (type === "weekly") {
    const d = spec.days.map(x => x[0].toUpperCase() + x.slice(1, 3).toLowerCase()).join(", ");
    return `every ${d} at ${spec.time} ${tz}`;
  }
  if (type === "monthly") {
    const ord = (n) => {
      const s = ["th", "st", "nd", "rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    return `${ord(spec.day_of_month)} of every month at ${spec.time} ${tz}`;
  }
  if (type === "cron") return `cron: ${spec.expr}`;
  return type;
}

// Produce next N preview firings, useful for the "Approve schedule?" chat card
export function previewNextRuns(type, spec, count = 3, fromUtc = new Date()) {
  const out = [];
  let from = fromUtc;
  for (let i = 0; i < count; i++) {
    const next = computeNextRun(type, spec, from);
    out.push(next);
    from = next;
  }
  return out;
}
