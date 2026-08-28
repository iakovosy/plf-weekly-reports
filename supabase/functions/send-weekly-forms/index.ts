// Sends the CORPORATE DEPARTMENT WEEKLY REPORT form link (Wed 09:00 or forced).
// Individual resend via body.admin_id.
//
// Uses the "exact" schedule rule — a missed 09:00 tick must not fire later.
//
// Plumbing lives in ../_shared.
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, markSent } from "../_shared/schedule.ts";
import { brandedShell, button, linkFallback } from "../_shared/emailLayout.ts";
import { HEX } from "../_shared/pdf.ts";

const KIND = "forms";
const { BLUE } = HEX;

function buildEmail(name: string, link: string, pretty: string, monthlyNote: boolean): string {
  return brandedShell({
    title: "Corporate Department Weekly Report",
    preview: `Please complete this week's report (${pretty}) before Wednesday 17:30.`,
    body: `<p style="margin:0 0 14px">Dear ${name},</p>
        <p style="margin:0 0 14px">Please complete this week's report before <strong style="color:${BLUE}">Wednesday 17:30</strong>.</p>
        <p style="margin:0 0 14px">The consolidated results are reviewed at the weekly Corporate meeting at <strong>08:30</strong>.</p>
        ${monthlyNote ? `<p style="margin:0 0 14px;color:${BLUE}"><strong>Note:</strong> this week includes the monthly estimated income question.</p>` : ""}
        ${button(link, "Complete weekly report")}
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

    // ---------- Individual resend ----------
    if (targetAdminId) {
      const { data: admin, error: adErr } = await supabase.from("report_admins")
        .select("id,name,email").eq("id", targetAdminId).maybeSingle();
      if (adErr) throw adErr;
      if (!admin) return new Response(JSON.stringify({ error: "admin not found" }), { status: 404 });

      const { data: latest } = await supabase.from("weekly_submissions")
        .select("report_date").order("report_date", { ascending: false }).limit(1);
      const reportDate = latest?.length ? latest[0].report_date as string : now.date;

      const { error: upErr } = await supabase.from("weekly_submissions")
        .upsert([{ admin_id: admin.id, report_date: reportDate }], {
          onConflict: "admin_id,report_date",
          ignoreDuplicates: true,
        });
      if (upErr) throw upErr;

      const { data: sub, error: sErr } = await supabase.from("weekly_submissions")
        .select("token").eq("admin_id", admin.id).eq("report_date", reportDate).single();
      if (sErr) throw sErr;

      const pretty = prettyDate(reportDate);
      // The monthly income question rides along on the first Wednesday of the month.
      const rd = new Date(reportDate + "T00:00:00Z");
      const monthlyNote = rd.getUTCDate() <= 7 && rd.getUTCDay() === 3;
      const link = `${portalUrl}/?token=${sub.token}`;
      const r = await sendEmail(
        settings,
        admin.email,
        `Corporate Department Weekly Report — ${pretty}`,
        buildEmail(admin.name, link, pretty, monthlyNote),
        { okDetail: null },
      );
      return new Response(
        JSON.stringify({ ok: r.ok, individual: admin.email, reportDate, detail: r.detail }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // ---------- Bulk send ----------
    const schedDay = settings.forms_day || "Wed";
    const schedHour = parseInt(settings.forms_hour ?? "9", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "exact")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }),
        { status: 200 },
      );
    }

    const reportDate = now.date;
    if (!force && await alreadyLogged(KIND, reportDate)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: admins, error: aErr } = await supabase.from("report_admins")
      .select("id,name,email").eq("active", true);
    if (aErr) throw aErr;
    if (!admins?.length) {
      return new Response(JSON.stringify({ skipped: true, reason: "no active admins" }), { status: 200 });
    }

    const { error: upErr } = await supabase.from("weekly_submissions")
      .upsert(admins.map((a: any) => ({ admin_id: a.id, report_date: reportDate })), {
        onConflict: "admin_id,report_date",
        ignoreDuplicates: true,
      });
    if (upErr) throw upErr;

    const { data: subs, error: sErr } = await supabase.from("weekly_submissions")
      .select("admin_id,token").eq("report_date", reportDate);
    if (sErr) throw sErr;
    const tokenByAdmin = new Map(subs.map((s: any) => [s.admin_id, s.token]));

    const pretty = prettyDate(reportDate);
    const isFirstWed = now.day <= 7 && now.weekday === "Wed";

    const results: any[] = [];
    for (const a of admins) {
      const link = `${portalUrl}/?token=${tokenByAdmin.get(a.id)}`;
      const r = await sendEmail(
        settings,
        a.email,
        `Corporate Department Weekly Report — ${pretty}`,
        buildEmail(a.name, link, pretty, isFirstWed),
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
