// Weekly summary email + branded PDF attachment (Corporate department).
// Reliability (matches send-general-report v6):
//  - DejaVu fonts cached at module scope with an 8s timeout + one retry; falls back to
//    Helvetica with sanitised text if the CDN can't be reached.
//  - Schedule window is "correct day, at or past the scheduled hour, not already logged as
//    sent", so a failed run self-heals on the next hourly tick.
//  - Only a genuine success writes send_log kind "report". Failures go to "report_error",
//    which does NOT block a retry.
// Recipients come from summary_recipients (stream='corporate', active) with fallback to the
// legacy report_recipient setting if the table is empty.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FONT_REG = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf";
const FONT_BOLD = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf";

// Cached across invocations on a warm isolate, so a cold-start burst only pays for this once.
let FONT_CACHE: { reg: Uint8Array; bold: Uint8Array } | null = null;
async function loadFonts() {
  if (FONT_CACHE) return FONT_CACHE;
  const get = async (u: string) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("font " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  };
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [a, b] = await Promise.all([get(FONT_REG), get(FONT_BOLD)]);
      FONT_CACHE = { reg: a, bold: b };
      return FONT_CACHE;
    } catch (e) { last = e; }
  }
  throw last;
}

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

async function logError(runDate: string, detail: string) {
  try {
    await supabase.from("send_log").upsert(
      { kind: "report_error", run_date: runDate, detail: String(detail).slice(0, 500) },
      { onConflict: "kind,run_date" });
  } catch (_e) { /* never let logging mask the original failure */ }
}

function parseFrom(from: string) {
  const m = from.match(/^(.*)<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, "") || undefined, email: m[2].trim() };
  return { email: from.trim() };
}

async function sendEmail(settings: Record<string, string>, to: string[], subject: string, html: string, pdfB64?: string, pdfName?: string) {
  const from = settings.from_email || "PLF Reports <onboarding@resend.dev>";
  const brevoKey = settings.brevo_api_key;
  if (brevoKey) {
    const f = parseFrom(from);
    const payload: any = { sender: { email: f.email, name: f.name ?? "PLF Reports" }, to: to.map((e) => ({ email: e })), subject, htmlContent: html };
    if (pdfB64) payload.attachment = [{ name: pdfName, content: pdfB64 }];
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": brevoKey },
      body: JSON.stringify(payload),
    });
    return { ok: resp.ok, detail: resp.ok ? "sent" : await resp.text() };
  }
  const resendKey = Deno.env.get("RESEND_API_KEY") || settings.resend_api_key;
  if (!resendKey) return { ok: false, detail: "No email provider configured (set a Brevo or Resend API key in Settings)" };
  const payload: any = { from, to, subject, html };
  if (pdfB64) payload.attachments = [{ filename: pdfName, content: pdfB64 }];
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify(payload),
  });
  return { ok: resp.ok, detail: resp.ok ? "sent" : await resp.text() };
}

const esc = (s: any) => s == null || s === "" ? "—" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const raw = (s: any) => s == null || s === "" ? "-" : String(s);
const yn = (b: any) => b === true ? "Yes" : b === false ? "No" : "—";
const ynRaw = (b: any) => b === true ? "Yes" : b === false ? "No" : "-";

const BLUE = "#4F75FF", SOFT = "#EEF2FF", GREY = "#E2DDD9";

async function buildPdf(prettyDate: string, submitted: any[], missingNames: string[], incomeOf: (id: string) => string) {
  const doc = await PDFDocument.create();

  // Unicode fonts (Greek etc.); graceful fallback to Helvetica + sanitised text.
  let font: any, bold: any, unicodeOk = true;
  try {
    doc.registerFontkit(fontkit as any);
    const f = await loadFonts();
    font = await doc.embedFont(f.reg, { subset: true });
    bold = await doc.embedFont(f.bold, { subset: true });
  } catch (_e) {
    unicodeOk = false;
    font = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const clean = (s: string) => unicodeOk ? s : s.replace(/€/g, "EUR").replace(/[^\x20-\x7E -ÿ]/g, "?");

  const blue = rgb(0x4f / 255, 0x75 / 255, 0xff / 255);
  const grey = rgb(0.89, 0.87, 0.85);
  const soft = rgb(0.93, 0.95, 1);
  const black = rgb(0.06, 0.08, 0.09);

  const W = 842, H = 595, M = 36;
  const cols = [
    { t: "Admin", w: 95 }, { t: "Workload", w: 48 }, { t: "Assistance", w: 55 },
    { t: "Outstanding <=7d", w: 80 }, { t: "Overdue >7d", w: 68 }, { t: "Overdue >30d", w: 70 },
    { t: "Invoices issued", w: 68 }, { t: "Still to issue", w: 100 }, { t: "Est. income (month)", w: 76 },
    { t: "To raise at the meeting", w: 110 },
  ];

  function wrap(text: string, width: number, size: number, f: any): string[] {
    const words = String(text).split(/\s+/);
    const lines: string[] = []; let line = "";
    for (const w of words) {
      let word = w;
      // hard-break very long unbroken strings so widthOfTextAtSize can't overflow
      while (f.widthOfTextAtSize(word, size) > width - 8 && word.length > 4) {
        let cut = word.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(word.slice(0, cut), size) > width - 8) cut--;
        const head = word.slice(0, cut);
        if (line) { lines.push(line); line = ""; }
        lines.push(head);
        word = word.slice(cut);
      }
      const test = line ? line + " " + word : word;
      if (f.widthOfTextAtSize(test, size) <= width - 8) line = test;
      else { if (line) lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines.length ? lines : ["-"];
  }

  let page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: H - 78, width: W, height: 78, color: blue });
  const grid = ["..P..", ".L.L.", "F.P.F", ".L.L.", "..P.."];
  grid.forEach((row, ri) => row.split("").forEach((ch, ci) => {
    if (ch !== ".") page.drawText(ch, { x: M + ci * 10, y: H - 30 - ri * 10, size: 9, font: bold, color: rgb(0, 0, 0) });
  }));
  page.drawText("PHILIPPOU LAW FIRM", { x: M + 70, y: H - 30, size: 8, font: bold, color: rgb(0.92, 0.94, 1) });
  page.drawText("Corporate Department — Weekly Report Summary", { x: M + 70, y: H - 46, size: 15, font: bold, color: rgb(1, 1, 1) });
  page.drawText(`Week of ${prettyDate}`, { x: M + 70, y: H - 62, size: 10, font, color: rgb(0.92, 0.94, 1) });

  let y = H - 96;
  page.drawText(clean(`${submitted.length} admin(s) submitted.` + (missingNames.length ? `   Not submitted: ${missingNames.join(", ")}` : "")), { x: M, y, size: 9.5, font, color: black });
  y -= 18;

  const headerRow = () => {
    let x = M;
    page.drawRectangle({ x: M, y: y - 4, width: cols.reduce((s, c) => s + c.w, 0), height: 18, color: blue });
    for (const c of cols) {
      page.drawText(c.t, { x: x + 4, y: y, size: 7.5, font: bold, color: rgb(1, 1, 1) });
      x += c.w;
    }
    y -= 20;
  };
  headerRow();

  let rowIndex = 0;
  for (const r of submitted) {
    const vals = [
      raw(r.report_admins.name), raw(r.workload_capacity), ynRaw(r.needs_assistance),
      raw(r.outstanding_amount), raw(r.total_overdue_amount), raw(r.overdue_30_amount),
      ynRaw(r.invoices_all_issued), raw(r.pending_invoices_detail), incomeOf(r.admin_id),
      raw(r.additional_notes),
    ].map(clean);
    const cellLines = vals.map((v, i) => wrap(v, cols[i].w, 8, i === 0 ? bold : font));
    const rowH = Math.max(...cellLines.map((l) => l.length)) * 10 + 6;

    if (y - rowH < 50) {
      page = doc.addPage([W, H]);
      y = H - 50;
      headerRow();
    }
    if (rowIndex % 2 === 1) {
      page.drawRectangle({ x: M, y: y - rowH + 12, width: cols.reduce((s, c) => s + c.w, 0), height: rowH, color: soft });
    }
    let x = M;
    vals.forEach((_, i) => {
      cellLines[i].forEach((line, li) => {
        page.drawText(line, { x: x + 4, y: y - li * 10, size: 8, font: i === 0 ? bold : font, color: black });
      });
      x += cols[i].w;
    });
    page.drawLine({ start: { x: M, y: y - rowH + 10 }, end: { x: M + cols.reduce((s, c) => s + c.w, 0), y: y - rowH + 10 }, thickness: 0.5, color: grey });
    y -= rowH;
    rowIndex++;
  }

  page.drawText("Generated automatically for the weekly meeting — All Rights Reserved © Philippou Law Firm", { x: M, y: 28, size: 7.5, font, color: rgb(0.6, 0.6, 0.6) });

  return await doc.saveAsBase64();
}

Deno.serve(async (req) => {
  let stage = "init", runDate = "";
  try {
    const settings = await getSettings();
    if (req.headers.get("x-cron-secret") !== settings.cron_secret) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;
    const now = cyprusNow();
    runDate = now.date;

    const schedDay = settings.report_day || "Thu";
    const schedHour = parseInt(settings.report_hour ?? "8", 10);
    // At or past the scheduled hour, so a failed run retries next tick.
    if (!force && !(now.weekday === schedDay && now.hour >= schedHour)) {
      return new Response(JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }), { status: 200 });
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

    const { data: logRow } = await supabase.from("send_log").select("id")
      .eq("kind", "report").eq("run_date", reportDate).maybeSingle();
    if (logRow && !force) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: rows, error: rErr } = await supabase.from("weekly_submissions")
      .select("*, report_admins(name,email)").eq("report_date", reportDate);
    if (rErr) throw rErr;
    rows.sort((a: any, b: any) => a.report_admins.name.localeCompare(b.report_admins.name));

    stage = "income map";
    const monthStart = reportDate.slice(0, 8) + "01";
    const { data: monthSubs } = await supabase.from("weekly_submissions")
      .select("admin_id, report_date, estimated_monthly_income")
      .gte("report_date", monthStart).lte("report_date", reportDate)
      .not("estimated_monthly_income", "is", null)
      .order("report_date", { ascending: false });
    const incomeMap = new Map<string, string>();
    for (const s of (monthSubs || [])) {
      if (!incomeMap.has(s.admin_id) && s.estimated_monthly_income) incomeMap.set(s.admin_id, s.estimated_monthly_income);
    }
    const incomeOf = (id: string) => incomeMap.get(id) || "-";

    const [y, m, dd] = reportDate.split("-");
    const prettyDate = `${dd}/${m}/${y}`;

    const submitted = rows.filter((r: any) => r.status === "submitted");
    const missing = rows.filter((r: any) => r.status !== "submitted");
    const needHelp = submitted.filter((r: any) => r.needs_assistance === true).map((r: any) => r.report_admins.name);

    const th = (t: string) => `<th bgcolor="${BLUE}" style="background-color:${BLUE};color:#ffffff;padding:9px 10px;font-size:12px;text-align:left;border:1px solid #3d5ecc;white-space:nowrap;font-family:Arial,Helvetica,sans-serif">${t}</th>`;
    const td = (v: string, hl = false, boldTxt = false) => `<td ${hl ? `bgcolor="${SOFT}"` : `bgcolor="#ffffff"`} style="padding:8px 10px;border:1px solid ${GREY};font-size:12.5px;white-space:nowrap;font-family:Arial,Helvetica,sans-serif;${hl ? `background-color:${SOFT};` : "background-color:#ffffff;"}${boldTxt ? "font-weight:bold;" : ""}">${v}</td>`;
    const tdWrap = (v: string) => `<td bgcolor="#ffffff" style="padding:8px 10px;border:1px solid ${GREY};font-size:12.5px;min-width:140px;font-family:Arial,Helvetica,sans-serif;background-color:#ffffff">${v}</td>`;

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
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Weekly summary — ${submitted.length}/${rows.length} admins submitted for ${prettyDate}. Full table + PDF inside.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="1040" cellpadding="0" cellspacing="0" border="0" style="width:1040px;max-width:100%">
        <tr>
          <td bgcolor="${BLUE}" style="background-color:${BLUE};padding:20px 26px">
            <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:5px">Corporate Department — Weekly Report Summary</div>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:13px;padding-top:5px">Week of ${prettyDate}</div>
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
    const pdfB64 = await buildPdf(prettyDate, submitted, missing.map((r: any) => r.report_admins.name), incomeOf);
    const pdfName = `PLF-Weekly-Report-${reportDate}.pdf`;

    stage = "resolve recipients";
    const { data: recs } = await supabase.from("summary_recipients")
      .select("email").eq("stream", "corporate").eq("active", true);
    let to = (recs || []).map((r: any) => r.email).filter(Boolean);
    if (!to.length && settings.report_recipient) to = [settings.report_recipient];
    if (!to.length) {
      await logError(reportDate, "no active corporate recipients");
      return new Response(JSON.stringify({ skipped: true, reason: "no active corporate recipients" }), { status: 200 });
    }

    stage = "send";
    const r = await sendEmail(settings, to, `Weekly Report Summary — Corporate Department — ${prettyDate} (${submitted.length}/${rows.length} submitted)`, html, pdfB64, pdfName);

    // Only a real success closes the week out; failures are recorded separately so the
    // next hourly tick retries.
    if (r.ok) {
      await supabase.from("send_log").upsert(
        { kind: "report", run_date: reportDate, detail: r.detail },
        { onConflict: "kind,run_date" });
    } else {
      await logError(reportDate, "send failed: " + r.detail);
    }

    return new Response(JSON.stringify({ ok: r.ok, reportDate, to, detail: r.detail }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    await logError(runDate || new Date().toISOString().slice(0, 10), `crashed at ${stage}: ${String(e)}`);
    return new Response(JSON.stringify({ error: String(e), stage }), { status: 500 });
  }
});
