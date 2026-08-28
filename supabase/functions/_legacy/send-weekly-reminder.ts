// Wednesday 17:00 reminder: emails ONLY the admins who have not yet submitted this week's form.
// Sends nothing if everyone has submitted. Reuses each admin's existing token (same week's form).
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function cyprusNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Nicosia",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10), weekday: get("weekday") };
}

async function getSettings() {
  const { data, error } = await supabase.from("portal_settings").select("key,value");
  if (error) throw error;
  return Object.fromEntries(data.map((r: any) => [r.key, r.value]));
}

function parseFrom(from: string) {
  const m = from.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() };
  return { email: from.trim() };
}

async function sendEmail(settings: Record<string, string>, to: string, subject: string, html: string) {
  const from = settings.from_email || "PLF Reports <onboarding@resend.dev>";
  const brevoKey = settings.brevo_api_key;
  if (brevoKey) {
    const f = parseFrom(from);
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": brevoKey },
      body: JSON.stringify({ sender: { email: f.email, name: f.name ?? "PLF Reports" }, to: [{ email: to }], subject, htmlContent: html }),
    });
    return { ok: resp.ok, detail: resp.ok ? null : await resp.text() };
  }
  const resendKey = Deno.env.get("RESEND_API_KEY") || settings.resend_api_key;
  if (!resendKey) return { ok: false, detail: "No email provider configured" };
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return { ok: resp.ok, detail: resp.ok ? null : await resp.text() };
}

const BLUE = "#4F75FF", AMBER = "#F7C135";

function buildReminder(name: string, link: string, prettyDate: string) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F2F2F2">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Reminder: your weekly report (${prettyDate}) is due today at 17:30. It only takes a minute.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%">
        <tr>
          <td bgcolor="${BLUE}" style="background-color:${BLUE};padding:24px 28px">
            <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:6px">Reminder — Weekly Report</div>
          </td>
        </tr>
        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:26px 28px;border-left:1px solid #E2DDD9;border-right:1px solid #E2DDD9;border-bottom:1px solid #E2DDD9;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101418;line-height:1.5">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="#FFF7E0" style="background-color:#FFF7E0;border-left:4px solid ${AMBER};padding:12px 14px;font-size:13px;color:#7a5b00">
                This is a friendly reminder — your report for this week hasn't been submitted yet.
              </td>
            </tr></table>
            <p style="margin:16px 0 14px">Dear ${name},</p>
            <p style="margin:0 0 14px">Please complete this week's report before <strong style="color:${BLUE}">today, 17:30</strong>. It only takes a minute.</p>
            <p style="margin:0 0 14px">The consolidated results are reviewed at the weekly Corporate meeting at <strong>08:30</strong>.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" style="padding:24px 0 26px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="${BLUE}" style="background-color:${BLUE};border-radius:8px;padding:14px 38px" align="center">
                      <a href="${link}" target="_blank" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none"><span style="color:#ffffff">Complete weekly report</span></a>
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="font-size:12px;color:#888888;margin:0">If the button doesn't work, copy this link:<br><a href="${link}" style="color:${BLUE}">${link}</a></p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#B3B3B3">All Rights Reserved © Philippou Law Firm</td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  try {
    const settings = await getSettings();
    if (req.headers.get("x-cron-secret") !== settings.cron_secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;
    const now = cyprusNow();
    const portalUrl = (settings.portal_url || "").replace(/\/$/, "");

    // Fixed schedule: Wednesday 17:00 Cyprus time (settings override allowed but not exposed in UI).
    const schedDay = settings.reminder_day || "Wed";
    const schedHour = parseInt(settings.reminder_hour ?? "17", 10);
    if (!force && !(now.weekday === schedDay && now.hour === schedHour)) {
      return new Response(JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }), { status: 200 });
    }

    // The reminder targets the form sent earlier the same day. Only proceed if a forms send happened today.
    const { data: formsLog } = await supabase.from("send_log").select("id")
      .eq("kind", "forms").eq("run_date", now.date).maybeSingle();
    if (!formsLog && !force) {
      return new Response(JSON.stringify({ skipped: true, reason: "no forms were sent today — nothing to remind" }), { status: 200 });
    }

    // Use today's report if it exists, else the latest (covers a forced test on another day).
    let reportDate = now.date;
    const { data: todays } = await supabase.from("weekly_submissions")
      .select("id").eq("report_date", now.date).limit(1);
    if (!todays?.length) {
      const { data: latest } = await supabase.from("weekly_submissions")
        .select("report_date").order("report_date", { ascending: false }).limit(1);
      if (!latest?.length) {
        return new Response(JSON.stringify({ skipped: true, reason: "no submissions rows exist" }), { status: 200 });
      }
      reportDate = latest[0].report_date as string;
    }

    // Idempotency: don't send the reminder twice for the same week.
    const { data: remLog } = await supabase.from("send_log").select("id")
      .eq("kind", "reminder").eq("run_date", reportDate).maybeSingle();
    if (remLog && !force) {
      return new Response(JSON.stringify({ skipped: true, reason: "reminder already sent this week" }), { status: 200 });
    }

    // Non-submitters only, and only if their admin is still active.
    const { data: pending, error: pErr } = await supabase.from("weekly_submissions")
      .select("token, report_admins!inner(name,email,active)")
      .eq("report_date", reportDate).eq("status", "pending");
    if (pErr) throw pErr;

    const targets = (pending || []).filter((r: any) => r.report_admins?.active);
    if (!targets.length) {
      // Everyone submitted (or no active pending) — send nothing, but log so we don't re-check every hour.
      await supabase.from("send_log").upsert(
        { kind: "reminder", run_date: reportDate, detail: "no non-submitters — nothing sent" },
        { onConflict: "kind,run_date" });
      return new Response(JSON.stringify({ ok: true, reportDate, sent: 0, reason: "everyone submitted" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const [yy, mm, dd] = reportDate.split("-");
    const prettyDate = `${dd}/${mm}/${yy}`;

    const results: any[] = [];
    for (const t of targets) {
      const link = `${portalUrl}/?token=${t.token}`;
      const r = await sendEmail(settings, t.report_admins.email, `Reminder — Weekly Report due today 17:30 — ${prettyDate}`, buildReminder(t.report_admins.name, link, prettyDate));
      results.push({ email: t.report_admins.email, ...r });
    }

    await supabase.from("send_log").upsert(
      { kind: "reminder", run_date: reportDate, detail: JSON.stringify(results) },
      { onConflict: "kind,run_date" });

    return new Response(JSON.stringify({ ok: true, reportDate, sent: results.length, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
