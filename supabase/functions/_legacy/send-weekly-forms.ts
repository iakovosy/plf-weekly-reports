// Sends the CORPORATE DEPARTMENT WEEKLY REPORT form link.
// Table-based markup + bulletproof button (padding on the TD) for desktop Outlook (Word engine).
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function cyprusNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Nicosia",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10),
    weekday: get("weekday"),
    day: parseInt(get("day"), 10),
  };
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
  if (!resendKey) return { ok: false, detail: "No email provider configured (set a Brevo or Resend API key in Settings)" };
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return { ok: resp.ok, detail: resp.ok ? null : await resp.text() };
}

const BLUE = "#4F75FF";

function buildEmail(name: string, link: string, prettyDate: string, monthlyNote: boolean) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F2F2F2">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Please complete this week's report (${prettyDate}) before Wednesday 17:30.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%">
        <!-- Header -->
        <tr>
          <td bgcolor="${BLUE}" style="background-color:${BLUE};padding:24px 28px">
            <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:6px">Corporate Department Weekly Report</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:26px 28px;border-left:1px solid #E2DDD9;border-right:1px solid #E2DDD9;border-bottom:1px solid #E2DDD9;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101418;line-height:1.5">
            <p style="margin:0 0 14px">Dear ${name},</p>
            <p style="margin:0 0 14px">Please complete this week's report before <strong style="color:${BLUE}">Wednesday 17:30</strong>.</p>
            <p style="margin:0 0 14px">The consolidated results are reviewed at the weekly Corporate meeting at <strong>08:30</strong>.</p>
            ${monthlyNote ? `<p style="margin:0 0 14px;color:${BLUE}"><strong>Note:</strong> this week includes the monthly estimated income question.</p>` : ""}
            <!-- Bulletproof button: padding + color live on the TD, which desktop Outlook honours -->
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
        <!-- Footer -->
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
    const targetAdminId = body.admin_id || null;
    const now = cyprusNow();
    const portalUrl = (settings.portal_url || "").replace(/\/$/, "");

    // ---------- Individual send ----------
    if (targetAdminId) {
      const { data: admin, error: adErr } = await supabase.from("report_admins")
        .select("id,name,email").eq("id", targetAdminId).maybeSingle();
      if (adErr) throw adErr;
      if (!admin) return new Response(JSON.stringify({ error: "admin not found" }), { status: 404 });

      const { data: latest } = await supabase.from("weekly_submissions")
        .select("report_date").order("report_date", { ascending: false }).limit(1);
      const reportDate = latest?.length ? latest[0].report_date as string : now.date;

      const { error: upErr } = await supabase.from("weekly_submissions")
        .upsert([{ admin_id: admin.id, report_date: reportDate }],
          { onConflict: "admin_id,report_date", ignoreDuplicates: true });
      if (upErr) throw upErr;

      const { data: sub, error: sErr } = await supabase.from("weekly_submissions")
        .select("token").eq("admin_id", admin.id).eq("report_date", reportDate).single();
      if (sErr) throw sErr;

      const [y, m, d] = reportDate.split("-");
      const prettyDate = `${d}/${m}/${y}`;
      const rd = new Date(reportDate + "T00:00:00Z");
      const monthlyNote = rd.getUTCDate() <= 7 && rd.getUTCDay() === 3;
      const link = `${portalUrl}/?token=${sub.token}`;
      const r = await sendEmail(settings, admin.email, `Corporate Department Weekly Report — ${prettyDate}`, buildEmail(admin.name, link, prettyDate, monthlyNote));
      return new Response(JSON.stringify({ ok: r.ok, individual: admin.email, reportDate, detail: r.detail }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ---------- Bulk send ----------
    const schedDay = settings.forms_day || "Wed";
    const schedHour = parseInt(settings.forms_hour ?? "9", 10);
    if (!force && !(now.weekday === schedDay && now.hour === schedHour)) {
      return new Response(JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }), { status: 200 });
    }

    const reportDate = now.date;

    const { data: logRow } = await supabase.from("send_log").select("id")
      .eq("kind", "forms").eq("run_date", reportDate).maybeSingle();
    if (logRow && !force) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: admins, error: aErr } = await supabase.from("report_admins")
      .select("id,name,email").eq("active", true);
    if (aErr) throw aErr;
    if (!admins?.length) {
      return new Response(JSON.stringify({ skipped: true, reason: "no active admins" }), { status: 200 });
    }

    const { error: upErr } = await supabase.from("weekly_submissions")
      .upsert(admins.map((a: any) => ({ admin_id: a.id, report_date: reportDate })),
        { onConflict: "admin_id,report_date", ignoreDuplicates: true });
    if (upErr) throw upErr;

    const { data: subs, error: sErr } = await supabase.from("weekly_submissions")
      .select("admin_id,token").eq("report_date", reportDate);
    if (sErr) throw sErr;
    const tokenByAdmin = new Map(subs.map((s: any) => [s.admin_id, s.token]));

    const [y, m, d] = reportDate.split("-");
    const prettyDate = `${d}/${m}/${y}`;
    const isFirstWed = now.day <= 7 && now.weekday === "Wed";

    const results: any[] = [];
    for (const a of admins) {
      const link = `${portalUrl}/?token=${tokenByAdmin.get(a.id)}`;
      const r = await sendEmail(settings, a.email, `Corporate Department Weekly Report — ${prettyDate}`, buildEmail(a.name, link, prettyDate, isFirstWed));
      results.push({ email: a.email, ...r });
    }

    await supabase.from("send_log").upsert(
      { kind: "forms", run_date: reportDate, detail: JSON.stringify(results) },
      { onConflict: "kind,run_date" });

    return new Response(JSON.stringify({ ok: true, reportDate, sent: results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
