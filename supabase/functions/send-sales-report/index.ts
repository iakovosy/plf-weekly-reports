// SALES weekly summary email + branded PDF (Wed 08:00).
//
// Schedule window is "correct day, at or past the scheduled hour, not already
// logged as sent", so a failed run self-heals on the next hourly tick. Only a
// genuine success writes send_log kind "sales_report"; failures go to
// "sales_report_error", which does NOT block a retry.
//
// Recipients come from summary_recipients (stream='sales', active) with a
// fallback to the legacy sales_report_recipient setting if the table is empty.
//
// Plumbing (time, settings, email, send_log, PDF chrome) lives in ../_shared.
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, logError, markSent } from "../_shared/schedule.ts";
import {
  COLORS,
  createDoc,
  drawFooter,
  drawLetterhead,
  esc,
  HEX,
  raw,
  wrap,
  yn,
  ynRaw,
} from "../_shared/pdf.ts";

const KIND = "sales_report";
const ERROR_KIND = "sales_report_error";
const { BLUE, SOFT, GREY } = HEX;

const W = 842, H = 595, M = 36;
const COLS = [
  { t: "Admin", w: 120 },
  { t: "Workload", w: 60 },
  { t: "Conversions", w: 90 },
  { t: "Company reg. conv.", w: 100 },
  { t: "Assistance", w: 60 },
  { t: "Subject", w: 130 },
  { t: "Notes / feedback", w: 150 },
];
const TW = COLS.reduce((s, c) => s + c.w, 0);

// The sales form stores answers as JSON, and the assistance flag arrives as
// either a boolean or the string "true" depending on form version.
const wantsHelp = (a: any) => a?.needs_assistance === "true" || a?.needs_assistance === true;

async function buildPdf(pretty: string, submitted: any[], missingNames: string[]): Promise<string> {
  const d = await createDoc();
  const { font, bold, clean } = d;

  let page = d.doc.addPage([W, H]);
  drawLetterhead(page, d, {
    W,
    H,
    M,
    title: "Sales Department — Weekly Report Summary",
    subtitle: `Week of ${pretty}`,
    bandHeight: 78,
  });

  let y = H - 96;
  page.drawText(
    clean(
      `${submitted.length} admin(s) submitted.` +
        (missingNames.length ? `   Not submitted: ${missingNames.join(", ")}` : ""),
    ),
    { x: M, y, size: 9.5, font, color: COLORS.black },
  );
  y -= 18;

  const headerRow = () => {
    let x = M;
    page.drawRectangle({ x: M, y: y - 4, width: TW, height: 18, color: COLORS.blue });
    for (const c of COLS) {
      page.drawText(c.t, { x: x + 4, y, size: 7.5, font: bold, color: COLORS.white });
      x += c.w;
    }
    y -= 20;
  };
  headerRow();

  let ri = 0;
  for (const r of submitted) {
    const a = r.answers || {};
    const vals = [
      raw(r.name),
      raw(a.workload_capacity),
      raw(a.conversions),
      raw(a.company_reg_conversions),
      ynRaw(wantsHelp(a)),
      raw(a.assistance_subject),
      raw(a.additional_notes),
    ].map(clean);
    const cl = vals.map((v, i) => wrap(v, COLS[i].w, 8, i === 0 ? bold : font));
    const rowH = Math.max(...cl.map((l) => l.length)) * 10 + 6;

    if (y - rowH < 50) {
      page = d.doc.addPage([W, H]);
      y = H - 50;
      headerRow();
    }
    if (ri % 2 === 1) {
      page.drawRectangle({ x: M, y: y - rowH + 12, width: TW, height: rowH, color: COLORS.soft });
    }
    let x = M;
    vals.forEach((_, i) => {
      cl[i].forEach((line, li) => {
        page.drawText(line, {
          x: x + 4,
          y: y - li * 10,
          size: 8,
          font: i === 0 ? bold : font,
          color: COLORS.black,
        });
      });
      x += COLS[i].w;
    });
    page.drawLine({
      start: { x: M, y: y - rowH + 10 },
      end: { x: M + TW, y: y - rowH + 10 },
      thickness: 0.5,
      color: COLORS.grey,
    });
    y -= rowH;
    ri++;
  }

  // Footers only the final page, matching the Corporate report.
  drawFooter(
    page,
    d,
    M,
    "Generated automatically for the weekly Sales meeting — All Rights Reserved © Philippou Law Firm",
  );
  return await d.doc.saveAsBase64();
}

Deno.serve(async (req) => {
  let stage = "init", runDate = "";
  try {
    const settings = await getSettings();
    if (unauthorized(req, settings)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;
    const now = cyprusNow();
    runDate = now.date;

    const schedDay = settings.sales_report_day || "Wed";
    const schedHour = parseInt(settings.sales_report_hour ?? "8", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "atOrAfter")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }),
        { status: 200 },
      );
    }

    stage = "load submissions";
    const { data: latest } = await supabase.from("sales_submissions")
      .select("report_date").order("report_date", { ascending: false }).limit(1);
    if (!latest?.length) {
      return new Response(JSON.stringify({ skipped: true, reason: "no submissions" }), { status: 200 });
    }
    const reportDate = latest[0].report_date as string;
    runDate = reportDate;

    if (!force && await alreadyLogged(KIND, reportDate)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: rows } = await supabase.from("sales_submissions")
      .select("status, answers, sales_admins!inner(name,email)").eq("report_date", reportDate);
    const list = (rows || [])
      .map((r: any) => ({ status: r.status, answers: r.answers, name: r.sales_admins.name }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    const pretty = prettyDate(reportDate);
    const submitted = list.filter((r: any) => r.status === "submitted");
    const missing = list.filter((r: any) => r.status !== "submitted");
    const needHelp = submitted.filter((r: any) => wantsHelp(r.answers)).map((r: any) => r.name);

    const th = (t: string) =>
      `<th bgcolor="${BLUE}" style="background-color:${BLUE};color:#ffffff;padding:9px 10px;font-size:12px;text-align:left;border:1px solid #3d5ecc;white-space:nowrap;font-family:Arial,Helvetica,sans-serif">${t}</th>`;
    const td = (v: string, hl = false, b = false) =>
      `<td bgcolor="${hl ? SOFT : "#ffffff"}" style="padding:8px 10px;border:1px solid ${GREY};font-size:12.5px;white-space:nowrap;font-family:Arial,Helvetica,sans-serif;background-color:${hl ? SOFT : "#ffffff"};${b ? "font-weight:bold;" : ""}">${v}</td>`;
    const tdW = (v: string) =>
      `<td bgcolor="#ffffff" style="padding:8px 10px;border:1px solid ${GREY};font-size:12.5px;min-width:140px;font-family:Arial,Helvetica,sans-serif;background-color:#ffffff">${v}</td>`;

    let table = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%"><tr>` +
      th("Admin") + th("Workload") + th("Conversions") + th("Company reg. conv.") +
      th("Assistance") + th("Subject") + th("Notes / feedback") + `</tr>`;
    for (const r of submitted) {
      const a = r.answers || {};
      const help = wantsHelp(a);
      table += `<tr>` +
        td(esc(r.name), false, true) +
        td(esc(a.workload_capacity), Number(a.workload_capacity) >= 8) +
        td(esc(a.conversions)) +
        td(esc(a.company_reg_conversions)) +
        td(yn(help), help) +
        tdW(esc(a.assistance_subject)) +
        tdW(esc(a.additional_notes)) +
        `</tr>`;
    }
    table += "</table>";

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F2F2F2">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Sales weekly summary — ${submitted.length}/${list.length} submitted for ${pretty}.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="940" cellpadding="0" cellspacing="0" border="0" style="width:940px;max-width:100%">
      <tr><td bgcolor="${BLUE}" style="background-color:${BLUE};padding:20px 26px">
        <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
        <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:5px">Sales Department — Weekly Report Summary</div>
        <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:13px;padding-top:5px">Week of ${pretty}</div>
      </td></tr>
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:22px 26px;border-left:1px solid ${GREY};border-right:1px solid ${GREY};border-bottom:1px solid ${GREY};font-family:Arial,Helvetica,sans-serif;color:#101418">
        <p style="font-size:13px;margin:0 0 14px"><strong>${submitted.length}/${list.length}</strong> admins submitted.
          ${missing.length ? `<span style="color:#b00020"><strong>Not submitted:</strong> ${missing.map((r: any) => esc(r.name)).join(", ")}.</span>` : ""}
          ${needHelp.length ? `<br><span style="color:${BLUE}"><strong>Requesting assistance:</strong> ${needHelp.join(", ")}.</span>` : ""}</p>
        ${table}
        <p style="font-size:12px;color:#666666;margin:14px 0 0">📎 The full results table is also attached as a PDF for the meeting.</p>
      </td></tr>
      <tr><td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#B3B3B3">All Rights Reserved © Philippou Law Firm</td></tr>
    </table>
  </td></tr></table></body></html>`;

    stage = "build pdf";
    const pdfB64 = await buildPdf(pretty, submitted, missing.map((r: any) => r.name));
    const pdfName = `PLF-Sales-Weekly-Report-${reportDate}.pdf`;

    stage = "resolve recipients";
    const { data: recs } = await supabase.from("summary_recipients")
      .select("email").eq("stream", "sales").eq("active", true);
    let to = (recs || []).map((r: any) => r.email).filter(Boolean);
    if (!to.length && (settings.sales_report_recipient || settings.report_recipient)) {
      to = [settings.sales_report_recipient || settings.report_recipient];
    }
    if (!to.length) {
      await logError(ERROR_KIND, reportDate, "no active sales recipients");
      return new Response(
        JSON.stringify({ skipped: true, reason: "no active sales recipients" }),
        { status: 200 },
      );
    }

    stage = "send";
    const r = await sendEmail(
      settings,
      to,
      `Sales Weekly Report Summary — ${pretty} (${submitted.length}/${list.length} submitted)`,
      html,
      { pdfB64, pdfName },
    );

    if (r.ok) await markSent(KIND, reportDate, r.detail ?? "sent");
    else await logError(ERROR_KIND, reportDate, "send failed: " + r.detail);

    return new Response(
      JSON.stringify({ ok: r.ok, reportDate, to, detail: r.detail }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    await logError(
      ERROR_KIND,
      runDate || new Date().toISOString().slice(0, 10),
      `crashed at ${stage}: ${String(e)}`,
    );
    return new Response(JSON.stringify({ error: String(e), stage }), { status: 500 });
  }
});
