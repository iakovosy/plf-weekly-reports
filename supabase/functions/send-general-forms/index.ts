// GENERAL WEEKLY WORKLOAD REPORT — form sender (Mon 09:00 or forced).
// Individual resend via body.admin_id. Honours general_start_date.
//
// Uses the "exact" schedule rule, not "at or past": if the 09:00 tick is missed
// the forms must NOT go out at 14:00 instead.
//
// Plumbing lives in ../_shared.
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, markSent } from "../_shared/schedule.ts";
import { brandedShell, button, linkFallback } from "../_shared/emailLayout.ts";
import { HEX } from "../_shared/pdf.ts";

const KIND = "general_forms";
const { BLUE } = HEX;

function buildEmail(name: string, link: string, pretty: string): string {
  return brandedShell({
    title: "Weekly Workload Check-in",
    preview: `Please complete this week's workload check-in (${pretty}) before Monday 17:30.`,
    body: `<p style="margin:0 0 14px">Dear ${name},</p>
        <p style="margin:0 0 14px">Please share how your workload is looking for this week. It only takes a moment and helps us balance the team.</p>
        <p style="margin:0 0 14px">Kindly complete it before <strong style="color:${BLUE}">Monday 17:30</strong>.</p>
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
    const targetAdminId = body.admin_id || null;
    const now = cyprusNow();
    const portalUrl = (settings.portal_url || "").replace(/\/$/, "");
    const formUrl = `${portalUrl}/general.html`;

    // ---------- Individual resend ----------
    if (targetAdminId) {
      const { data: admin } = await supabase.from("general_admins")
        .select("id,name,email").eq("id", targetAdminId).maybeSingle();
      if (!admin) return new Response(JSON.stringify({ error: "admin not found" }), { status: 404 });

      const { data: latest } = await supabase.from("general_submissions")
        .select("report_date").order("report_date", { ascending: false }).limit(1);
      const reportDate = latest?.length ? latest[0].report_date as string : now.date;

      await supabase.from("general_submissions").upsert(
        [{ admin_id: admin.id, report_date: reportDate }],
        { onConflict: "admin_id,report_date", ignoreDuplicates: true },
      );
      const { data: sub } = await supabase.from("general_submissions")
        .select("token").eq("admin_id", admin.id).eq("report_date", reportDate).single();

      const pretty = prettyDate(reportDate);
      const link = `${formUrl}?token=${sub!.token}`;
      const r = await sendEmail(
        settings,
        admin.email,
        `Weekly Workload Check-in — ${pretty}`,
        buildEmail(admin.name, link, pretty),
        { okDetail: null },
      );
      return new Response(
        JSON.stringify({ ok: r.ok, individual: admin.email, reportDate, detail: r.detail }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // ---------- Bulk send ----------
    const schedDay = settings.general_forms_day || "Mon";
    const schedHour = parseInt(settings.general_forms_hour ?? "9", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "exact")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now }),
        { status: 200 },
      );
    }
    const startDate = settings.general_start_date || "";
    if (!force && startDate && now.date < startDate) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "before general_start_date", now: now.date, startDate }),
        { status: 200 },
      );
    }

    const reportDate = now.date;
    if (!force && await alreadyLogged(KIND, reportDate)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: admins } = await supabase.from("general_admins")
      .select("id,name,email").eq("active", true);
    if (!admins?.length) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "no active general admins" }),
        { status: 200 },
      );
    }

    await supabase.from("general_submissions").upsert(
      admins.map((a: any) => ({ admin_id: a.id, report_date: reportDate })),
      { onConflict: "admin_id,report_date", ignoreDuplicates: true },
    );
    const { data: subs } = await supabase.from("general_submissions")
      .select("admin_id,token").eq("report_date", reportDate);
    const tokenByAdmin = new Map(subs!.map((s: any) => [s.admin_id, s.token]));

    const pretty = prettyDate(reportDate);
    const results: any[] = [];
    for (const a of admins) {
      const link = `${formUrl}?token=${tokenByAdmin.get(a.id)}`;
      const r = await sendEmail(
        settings,
        a.email,
        `Weekly Workload Check-in — ${pretty}`,
        buildEmail(a.name, link, pretty),
        { okDetail: null },
      );
      results.push({ email: a.email, ...r });
    }
    await markSent(KIND, reportDate, JSON.stringify(results));

    return new Response(
      JSON.stringify({ ok: true, reportDate, sent: results }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
