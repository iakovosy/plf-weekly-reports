// GENERAL workload reminder (Mon 17:00): emails only the admins who have not
// submitted this week. Sends nothing if everyone has, but still writes the
// send_log row so the hourly tick stops re-checking.
//
// Uses the "exact" schedule rule — a missed 17:00 tick must not fire later.
//
// Plumbing lives in ../_shared.
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, markSent } from "../_shared/schedule.ts";
import { brandedShell, button, linkFallback, noticeBox } from "../_shared/emailLayout.ts";
import { HEX } from "../_shared/pdf.ts";

const KIND = "general_reminder";
const FORMS_KIND = "general_forms";
const { BLUE } = HEX;

function buildReminder(name: string, link: string, pretty: string): string {
  return brandedShell({
    title: "Reminder — Weekly Workload Check-in",
    preview: `Reminder: your weekly workload check-in (${pretty}) is due today at 17:30.`,
    body: `${noticeBox("This is a friendly reminder — your workload check-in for this week hasn't been submitted yet.")}
        <p style="margin:16px 0 14px">Dear ${name},</p>
        <p style="margin:0 0 14px">Please complete this week's workload check-in before <strong style="color:${BLUE}">today, 17:30</strong>. It only takes a moment.</p>
        ${button(link, "Complete workload check-in")}
        ${linkFallback(link)}`,
  });
}

Deno.serve(async (req) => {
  try {
    const settings = await getSettings();
    if (unauthorized(req, settings)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;
    const now = cyprusNow();
    const portalUrl = (settings.portal_url || "").replace(/\/$/, "");
    const formUrl = `${portalUrl}/general.html`;

    const schedDay = settings.general_reminder_day || "Mon";
    const schedHour = parseInt(settings.general_reminder_hour ?? "17", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "exact")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now }),
        { status: 200 },
      );
    }

    // The reminder chases the forms sent earlier the same day. If no forms went
    // out, there is nothing to chase.
    if (!force && !await alreadyLogged(FORMS_KIND, now.date)) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "no general forms sent today" }),
        { status: 200 },
      );
    }

    // Use today's report if it exists, else the latest (covers a forced test).
    let reportDate = now.date;
    const { data: todays } = await supabase.from("general_submissions")
      .select("id").eq("report_date", now.date).limit(1);
    if (!todays?.length) {
      const { data: latest } = await supabase.from("general_submissions")
        .select("report_date").order("report_date", { ascending: false }).limit(1);
      if (!latest?.length) {
        return new Response(JSON.stringify({ skipped: true, reason: "no rows" }), { status: 200 });
      }
      reportDate = latest[0].report_date as string;
    }

    if (!force && await alreadyLogged(KIND, reportDate)) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "reminder already sent" }),
        { status: 200 },
      );
    }

    const { data: pending } = await supabase.from("general_submissions")
      .select("token, general_admins!inner(name,email,active)")
      .eq("report_date", reportDate).eq("status", "pending");
    const targets = (pending || []).filter((r: any) => r.general_admins?.active);

    if (!targets.length) {
      await markSent(KIND, reportDate, "no non-submitters");
      return new Response(
        JSON.stringify({ ok: true, reportDate, sent: 0, reason: "everyone submitted" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const pretty = prettyDate(reportDate);
    const results: any[] = [];
    for (const t of targets) {
      const link = `${formUrl}?token=${t.token}`;
      const r = await sendEmail(
        settings,
        t.general_admins.email,
        `Reminder — Weekly Workload Check-in due today 17:30 — ${pretty}`,
        buildReminder(t.general_admins.name, link, pretty),
        { okDetail: null },
      );
      results.push({ email: t.general_admins.email, ...r });
    }
    await markSent(KIND, reportDate, JSON.stringify(results));

    return new Response(
      JSON.stringify({ ok: true, reportDate, sent: results.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
