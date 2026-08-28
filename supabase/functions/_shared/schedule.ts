// Scheduling and the send_log gate.
//
// The cron runner ticks hourly and every function decides for itself whether
// this is its moment. Two different rules are in use and BOTH must be kept:
//
//   "atOrAfter" — the summary reports. If the scheduled tick fails, a later tick
//                 the same day still runs, so a transient failure self-heals.
//   "exact"     — the form and reminder senders, which must not fire again later
//                 in the day if something went wrong at the scheduled hour.
//
// Idempotency comes from send_log: one row per (kind, run_date). Only a genuine
// success writes the success kind; failures go to a separate "<kind>_error" row
// so they never block the retry.
import { supabase } from "./client.ts";
import type { CyprusNow } from "./time.ts";

export type WindowMode = "exact" | "atOrAfter";

export function inScheduleWindow(
  now: CyprusNow,
  schedDay: string,
  schedHour: number,
  mode: WindowMode,
): boolean {
  if (now.weekday !== schedDay) return false;
  return mode === "exact" ? now.hour === schedHour : now.hour >= schedHour;
}

export async function alreadyLogged(kind: string, runDate: string): Promise<boolean> {
  const { data } = await supabase.from("send_log").select("id")
    .eq("kind", kind).eq("run_date", runDate).maybeSingle();
  return !!data;
}

export async function markSent(kind: string, runDate: string, detail: string): Promise<void> {
  await supabase.from("send_log").upsert(
    { kind, run_date: runDate, detail },
    { onConflict: "kind,run_date" },
  );
}

// Never let a logging failure mask the original error.
export async function logError(kind: string, runDate: string, detail: string): Promise<void> {
  try {
    await supabase.from("send_log").upsert(
      { kind, run_date: runDate, detail: String(detail).slice(0, 500) },
      { onConflict: "kind,run_date" },
    );
  } catch (_e) { /* ignore */ }
}
