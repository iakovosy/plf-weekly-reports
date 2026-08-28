// Cyprus (Asia/Nicosia) wall-clock helpers.
// Every scheduled function decides whether to run based on Cyprus local time,
// not UTC, so that "Wednesday 09:00" means 09:00 in the office.

export type CyprusNow = {
  date: string; // YYYY-MM-DD
  hour: number; // 0-23
  weekday: string; // "Mon" ... "Sun"
  day: number; // day of month
};

export function cyprusNow(): CyprusNow {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Nicosia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    hour: parseInt(g("hour"), 10),
    weekday: g("weekday"),
    day: parseInt(g("day"), 10),
  };
}

// UTC milliseconds of 00:00 Asia/Nicosia on dateStr. Cyprus is UTC+2 (EET) or
// UTC+3 (EEST), so try both offsets and keep whichever lands on midnight.
export function cyprusMidnightUTC(dateStr: string): number {
  const base = Date.parse(dateStr + "T00:00:00Z");
  for (const off of [3, 2]) {
    const cand = base - off * 3600000;
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Nicosia",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(cand));
    const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (
      `${g("year")}-${g("month")}-${g("day")}` === dateStr &&
      (g("hour") === "00" || g("hour") === "24")
    ) return cand;
  }
  return base - 3 * 3600000;
}

export function addDays(dateStr: string, n: number): string {
  return new Date(Date.parse(dateStr + "T00:00:00Z") + n * 86400000)
    .toISOString().slice(0, 10);
}

// "2026-08-28" -> "28/08/2026". Reports print dates this way throughout.
export function prettyDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// Same, but tolerant of null/empty and of full timestamps — used for values
// that come back from HubSpot and may be missing.
export function prettifyOrDash(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = String(iso).slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(iso);
}
