// Weekly summary email + branded PDF attachment (Corporate department).
//
// Schedule window is "correct day, at or past the scheduled hour, not already
// logged as sent", so a failed run self-heals on the next hourly tick. Only a
// genuine success writes send_log kind "report"; failures go to "report_error",
// which does NOT block a retry.
//
// Recipients come from summary_recipients (stream='corporate', active) with a
// fallback to the legacy report_recipient setting if the table is empty.
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

const KIND = "report";
const ERROR_KIND = "report_error";
const { BLUE, SOFT, GREY } = HEX;

// Landscape — this table is far too wide for portrait.
const W = 842, H = 595, M = 36;
const COLS = [
  { t: "Admin", w: 95 },
  { t: "Workload", w: 48 },
  { t: "Assistance", w: 55 },
  { t: "Outstanding <=7d", w: 80 },
  { t: "Overdue >7d", w: 68 },
  { t: "Overdue >30d", w: 70 },
  { t: "Invoices issued", w: 68 },
  { t: "Still to issue", w: 100 },
  { t: "Est. income (month)", w: 76 },
  { t: "To raise at the meeting", w: 110 },
];
const TW = COLS.reduce((s, c) => s + c.w, 0);

async function buildPdf(
  pretty: string,
  submitted: any[],
  missingNames: string[],
  incomeOf: (id: string) => string,
): Promise<string> {
  const d = await createDoc();
  const { font, bold, clean } = d;

  let page = d.doc.addPage([W, H]);
  drawLetterhead(page, d, {
    W,
    H,
    M,
    title: "Corporate Department — Weekly Report Summary",
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

  let rowIndex = 0;
  for (const r of submitted) {
    const vals = [
      raw(r.report_admins.name),
      raw(r.workload_capacity),
      ynRaw(r.needs_assistance),
      raw(r.outstanding_amount),
      raw(r.total_overdue_amount),
      raw(r.overdue_30_amount),
      ynRaw(r.invoices_all_issued),
      raw(r.pending_invoices_detail),
      incomeOf(r.admin_id),
      raw(r.additional_notes),
    ].map(clean);
    const cellLines = vals.map((v, i) => wrap(v, COLS[i].w, 8, i === 0 ? bold : font));
    const rowH = Math.max(...cellLines.map((l) => l.length)) * 10 + 6;

    if (y - rowH < 50) {
      page = d.doc.addPage([W, H]);
      y = H - 50;
      headerRow();
    }
    if (rowIndex % 2 === 1) {
      page.drawRectangle({ x: M, y: y - rowH + 12, width: TW, height: rowH, color: COLORS.soft });
    }
    let x = M;
    vals.forEach((_, i) => {
      cellLines[i].forEach((line, li) => {
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
    rowIndex++;
  }

  // This report footers only the final page, unlike the others.
  drawFooter(
    page,
    d,
    M,
    "Generated automatically for the weekly meeting — All Rights Reserved © Philippou Law Firm",
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

    const schedDay = settings.report_day || "Thu";
    const schedHour = parseInt(settings.report_hour ?? "8", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "atOrAfter")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }),
        { status: 200 },
      );
    }

    stage = "load submissions";
    const { data: latest, error: lErr } = await supabase.from("weekly_submissions")
      .select("report_date").order("report_date", { ascending: false }).limit(1);
    if (lErr) throw lErr;
    if (!latest?.length) {
      return new Response(JSON.stringify({ skipped: true, reason: "no submissions exist" }), { status: 200 });
    }
    const reportDate = latest[0].report_date as string;
    runDate = reportDate;

    if (!force && await alreadyLogged(KIND, reportDate)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: rows, error: rErr } = await supabase.from("weekly_submissions")
      .select("*, report_admins(name,email)").eq("report_date", reportDate);
    if (rErr) throw rErr;
    rows.sort((a: any, b: any) => a.report_admins.name.localeCompare(b.report_admins.name));

    stage = "income map";
    // Estimated monthly income is only asked on the first Wednesday, so carry the
    // most recent answer given so far this month.
    const monthStart = reportDate.slice(0, 8) + "01";
    const { data: monthSubs } = await supabase.from("weekly_submissions")
      .select("admin_id, report_date, estimated_monthly_income")
      .gte("report_date", monthStart).lte("report_date", reportDate)
      .not("estimated_monthly_income", "is", null)
      .order("report_date", { ascending: false });
    const incomeMap = new Map<string, string>();
    for (const s of (monthSubs || [])) {
      if (!incomeMap.has(s.admin_id) && s.estimated_monthly_income) {
        incomeMap.set(s.admin_id, s.estimated_monthly_income);
      }
    }
    const incomeOf = (id: string) => incomeMap.get(id) || "-";

    const pretty = prettyDate(reportDate);
    const submitted = rows.filter((r: any) => r.status === "submitted");
    const missing = rows.filter((r: any) => r.status !== "submitted");
    const needHelp = submitted.filter((r: any) => r.needs_assistance === true)
      .map((r: any) => r.report_admins.name);

    const th = (t: string) =>
      `<th bgcolor="${BLUE}" style="background-color:${BLUE};color:#ffffff;padding:9px 10px;font-size:12px;text-align:left;border:1px solid #3d5ecc;white-space:nowrap;font-family:Arial,Helvetica,sans-serif">${t}</th>`;
    const td = (v: string, hl = false, boldTxt = false) =>
      `<td ${hl ? `bgcolor="${SOFT}"` : `bgcolor="#ffffff"`} style="padding:8px 10px;border:1px solid ${GREY};font-size:12.5px;white-space:nowrap;font-family:Arial,Helvetica,sans-serif;${hl ? `background-color:${SOFT};` : "background-color:#ffffff;"}${boldTxt ? "font-weight:bold;" : ""}">${v}</td>`;
    const tdWrap = (v: string) =>
      `<td bgcolor="#ffffff" style="padding:8px 10px;border:1px solid ${GREY};font-size:12.5px;min-width:140px;font-family:Arial,Helvetica,sans-serif;background-color:#ffffff">${v}</td>`;

    let table = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%"><tr>` +
      th("Admin") + th("Workload") + th("Assistance") + th("Outstanding ≤7d") +
      th("Overdue >7d") + th("Overdue >30d") + th("Invoices issued") + th("Still to issue") +
      th("Est. income (month)") + th("To raise at the meeting") + `</tr>`;
    for (const r of submitted) {
      table += `<tr>` +
        td(esc(r.report_admins.name), false, true) +
        td(esc(r.workload_capacity), r.workload_capacity >= 8) +
        td(yn(r.needs_assistance), r.needs_assistance === true) +
        td(esc(r.outstanding_amount)) +
        td(esc(r.total_overdue_amount)) +
        td(esc(r.overdue_30_amount), !!r.overdue_30_amount) +
        td(yn(r.invoices_all_issued), r.invoices_all_issued === false) +
        tdWrap(esc(r.pending_invoices_detail)) +
        td(esc(incomeMap.get(r.admin_id))) +
        tdWrap(esc(r.additional_notes)) +
        `</tr>`;
    }
    table += "</table>";

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F2F2F2">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Weekly summary — ${submitted.length}/${rows.length} admins submitted for ${pretty}. Full table + PDF inside.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="1040" cellpadding="0" cellspacing="0" border="0" style="width:1040px;max-width:100%">
        <tr>
          <td bgcolor="${BLUE}" style="background-color:${BLUE};padding:20px 26px">
            <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:5px">Corporate Department — Weekly Report Summary</div>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:13px;padding-top:5px">Week of ${pretty}</div>
          </td>
        </tr>
        <tr>
          <td bgcolor="#ffffff" style="background-color:#ffffff;padding:22px 26px;border-left:1px solid ${GREY};border-right:1px solid ${GREY};border-bottom:1px solid ${GREY};font-family:Arial,Helvetica,sans-serif;color:#101418">
            <p style="font-size:13px;margin:0 0 14px">
              <strong>${submitted.length}/${rows.length}</strong> admins submitted.
              ${missing.length ? `<span style="color:#b00020"><strong>Not submitted:</strong> ${missing.map((r: any) => esc(r.report_admins.name)).join(", ")}.</span>` : ""}
              ${needHelp.length ? `<br><span style="color:${BLUE}"><strong>Requesting assistance:</strong> ${needHelp.join(", ")}.</span>` : ""}
            </p>
            ${table}
            <p style="font-size:12px;color:#666666;margin:14px 0 0">📎 The full results table is also attached as a PDF for the meeting.</p>
            <p style="font-size:11px;color:#999999;margin:8px 0 0">Generated automatically · Highlighted cells indicate items needing attention · Est. income shows each admin's latest answer for the current month.</p>
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

    stage = "build pdf";
    const pdfB64 = await buildPdf(
      pretty,
      submitted,
      missing.map((r: any) => r.report_admins.name),
      incomeOf,
    );
    const pdfName = `PLF-Weekly-Report-${reportDate}.pdf`;

    stage = "resolve recipients";
    const { data: recs } = await supabase.from("summary_recipients")
      .select("email").eq("stream", "corporate").eq("active", true);
    let to = (recs || []).map((r: any) => r.email).filter(Boolean);
    if (!to.length && settings.report_recipient) to = [settings.report_recipient];
    if (!to.length) {
      await logError(ERROR_KIND, reportDate, "no active corporate recipients");
      return new Response(
        JSON.stringify({ skipped: true, reason: "no active corporate recipients" }),
        { status: 200 },
      );
    }

    stage = "send";
    const r = await sendEmail(
      settings,
      to,
      `Weekly Report Summary — Corporate Department — ${pretty} (${submitted.length}/${rows.length} submitted)`,
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
