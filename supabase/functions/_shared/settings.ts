// portal_settings is a flat key/value bag. Every function reads the whole thing
// once at the top of a request and then treats it as read-only.
import { supabase } from "./client.ts";

export type Settings = Record<string, string>;

export async function getSettings(): Promise<Settings> {
  const { data, error } = await supabase.from("portal_settings").select("key,value");
  if (error) throw error;
  return Object.fromEntries(data.map((r: any) => [r.key, r.value]));
}

// Scheduled functions authenticate the caller with a shared secret rather than a
// JWT, so they can be invoked by the cron runner. Returns true when the request
// is NOT authorised, so callers can `if (unauthorized(req, settings)) return ...`.
export function unauthorized(req: Request, settings: Settings): boolean {
  return req.headers.get("x-cron-secret") !== settings.cron_secret;
}

// Comma/semicolon separated recipient strings, as stored in the *_report_recipient keys.
export function splitRecipients(value: string | undefined | null): string[] {
  const v = (value ?? "").trim();
  return v ? v.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : [];
}
