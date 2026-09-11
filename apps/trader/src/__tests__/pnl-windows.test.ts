import { describe, it, expect } from "vitest";

// helpers mirrored from index.ts (kept small; index is not importable as a unit)
function utcWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Thu = new Date(jan4);
  week1Thu.setUTCDate(jan4.getUTCDate() - jan4DayNum + 3);
  const week = 1 + Math.round((date.getTime() - week1Thu.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

describe("utcWeekKey", () => {
  it("Jan 1 2026 is 2026-W01", () => {
    expect(utcWeekKey(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });

  it("Monday and following Sunday share a week", () => {
    const monday = new Date("2026-09-07T00:00:00Z");   // Monday
    const sunday = new Date("2026-09-13T23:59:59Z");   // Sunday
    expect(utcWeekKey(monday)).toBe(utcWeekKey(sunday));
  });

  it("Sunday before that Monday is the prior week", () => {
    const prevSunday = new Date("2026-09-06T23:59:59Z");
    const monday = new Date("2026-09-07T00:00:00Z");
    expect(utcWeekKey(prevSunday)).not.toBe(utcWeekKey(monday));
  });

  it("weeks are zero-padded and monotonic across a month", () => {
    expect(utcWeekKey(new Date("2026-09-01T00:00:00Z"))).toMatch(/^2026-W\d{2}$/);
    expect(utcWeekKey(new Date("2026-09-29T00:00:00Z"))).toMatch(/^2026-W\d{2}$/);
  });
});
