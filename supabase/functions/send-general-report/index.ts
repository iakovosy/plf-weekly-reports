// GENERAL weekly workload summary: short covering email + signature + branded PDF
// grouped by department.
//
// Schedule window is "correct day, at or past the scheduled hour, not already logged
// as sent", so a failed run self-heals on the next hourly tick. Failures are logged
// under general_report_error, which does NOT block a retry; only a genuine success
// writes general_report.
//
// Plumbing (time, settings, email, send_log, PDF chrome) lives in ../_shared.
import { rgb } from "npm:pdf-lib@1.17.1";
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, logError, markSent } from "../_shared/schedule.ts";
import {
  COLORS,
  createDoc,
  drawFooterAllPages,
  drawLetterhead,
  raw,
  wrap,
} from "../_shared/pdf.ts";

const KIND = "general_report";
const ERROR_KIND = "general_report_error";

const W = 595, H = 842, M = 40;
const COLS = [
  { t: "Team member", w: 150 },
  { t: "Workload this week", w: 150 },
  { t: "Comments", w: 215 },
];
const TW = COLS.reduce((s, c) => s + c.w, 0);

type Group = { dept: string; rows: any[] };

async function buildPdf(
  pretty: string,
  groups: Group[],
  total: number,
  submittedCount: number,
  missingNames: string[],
): Promise<string> {
  const d = await createDoc();
  const { font, bold, clean } = d;

  let page = d.doc.addPage([W, H]);
  let y = drawLetterhead(page, d, {
    W,
    H,
    M,
    title: "Weekly Workload Check-in — Summary",
    subtitle: `Week of ${pretty}`,
    bandHeight: 84,
  });

  const newPage = () => { page = d.doc.addPage([W, H]); y = H - 50; };
  const headerRow = () => {
    let x = M;
    page.drawRectangle({ x: M, y: y - 4, width: TW, height: 18, color: COLORS.blue });
    for (const c of COLS) {
      page.drawText(c.t, { x: x + 4, y, size: 8, font: bold, color: COLORS.white });
      x += c.w;
    }
    y -= 20;
  };

  page.drawText(clean(`${submittedCount}/${total} submitted.`), {
    x: M, y, size: 9.5, font: bold, color: COLORS.black,
  });
  y -= 14;
  if (missingNames.length) {
    for (const line of wrap(clean(`Not submitted: ${missingNames.join(", ")}`), TW, 9, font)) {
      page.drawText(line, { x: M, y, size: 9, font, color: COLORS.red });
      y -= 11;
    }
  }
  y -= 8;

  for (const g of groups) {
    if (y - 70 < 50) newPage();
    const sub = g.rows.filter((r: any) => r.status === "submitted").length;
    page.drawRectangle({ x: M, y: y - 6, width: TW, height: 20, color: COLORS.navy });
    page.drawText(clean(`${g.dept}`), { x: M + 7, y, size: 9.5, font: bold, color: COLORS.white });
    page.drawText(clean(`${sub}/${g.rows.length} submitted`), {
      x: M + TW - 92, y, size: 8.5, font, color: COLORS.onBlue,
    });
    y -= 26;
    headerRow();

    let ri = 0;
    for (const r of g.rows) {
      const a = r.answers || {};
      const done = r.status === "submitted";
      const wl = done ? String(a.workload || "") : "Not submitted";
      const vals = [raw(r.name), raw(wl), done ? raw(a.comments) : "-"].map(clean);
      const cl = vals.map((v, i) => wrap(v, COLS[i].w, 8.5, i === 0 ? bold : font));
      const rowH = Math.max(...cl.map((l) => l.length)) * 11 + 8;
      if (y - rowH < 50) { newPage(); headerRow(); }

      // Attention shading: absent, at capacity, or nearly at capacity.
      const bc = !done
        ? "#EDEDED"
        : wl.startsWith("100")
        ? "#fbe4e7"
        : wl.startsWith("90")
        ? "#FFF7E0"
        : "#ffffff";
      if (bc !== "#ffffff") {
        const cr = parseInt(bc.slice(1, 3), 16) / 255;
        const cg = parseInt(bc.slice(3, 5), 16) / 255;
        const cb = parseInt(bc.slice(5, 7), 16) / 255;
        page.drawRectangle({
          x: M, y: y - rowH + 13, width: TW, height: rowH, color: rgb(cr, cg, cb),
        });
      } else if (ri % 2 === 1) {
        page.drawRectangle({
          x: M, y: y - rowH + 13, width: TW, height: rowH, color: COLORS.soft,
        });
      }

      let x = M;
      vals.forEach((_, i) => {
        cl[i].forEach((line, li) => {
          page.drawText(line, {
            x: x + 4,
            y: y - li * 11,
            size: 8.5,
            font: i === 0 ? bold : font,
            color: (!done && i === 1) ? COLORS.red : COLORS.black,
          });
        });
        x += COLS[i].w;
      });
      page.drawLine({
        start: { x: M, y: y - rowH + 11 },
        end: { x: M + TW, y: y - rowH + 11 },
        thickness: 0.5,
        color: COLORS.grey,
      });
      y -= rowH;
      ri++;
    }
    y -= 14;
  }

  drawFooterAllPages(d, M);
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
    const overrideTo: string[] | null = force
      ? (typeof body.to === "string" ? [body.to] : Array.isArray(body.to) ? body.to : null)
      : null;
    const preview = !!overrideTo;
    const now = cyprusNow();
    runDate = now.date;

    const schedDay = settings.general_report_day || "Tue";
    const schedHour = parseInt(settings.general_report_hour ?? "10", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "atOrAfter")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }),
        { status: 200 },
      );
    }

    stage = "load submissions";
    const { data: latest } = await supabase.from("general_submissions")
      .select("report_date").order("report_date", { ascending: false }).limit(1);
    if (!latest?.length) {
      return new Response(JSON.stringify({ skipped: true, reason: "no submissions" }), { status: 200 });
    }
    const reportDate = latest[0].report_date as string;
    runDate = reportDate;

    if (!force && await alreadyLogged(KIND, reportDate)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    const { data: rows } = await supabase.from("general_submissions")
      .select("status, answers, general_admins!inner(name,email)").eq("report_date", reportDate);
    const { data: deps } = await supabase.rpc("report_departments");
    const depMap = new Map<string, { department: string; sort_order: number }>();
    for (const d of (deps || [])) {
      depMap.set(String(d.email).toLowerCase(), { department: d.department, sort_order: d.sort_order });
    }

    const list = (rows || []).map((r: any) => {
      const email = String(r.general_admins.email || "").toLowerCase();
      const d = depMap.get(email) || { department: "Unassigned", sort_order: 9999 };
      return {
        status: r.status,
        answers: r.answers,
        name: r.general_admins.name,
        email,
        dept: d.department,
        dord: d.sort_order,
      };
    }).sort((a: any, b: any) => a.name.localeCompare(b.name));

    const pretty = prettyDate(reportDate);
    const submitted = list.filter((r: any) => r.status === "submitted");
    const missing = list.filter((r: any) => r.status !== "submitted");

    const byDept = new Map<string, any[]>();
    for (const r of list) {
      if (!byDept.has(r.dept)) byDept.set(r.dept, []);
      byDept.get(r.dept)!.push(r);
    }
    const groups: Group[] = [...byDept.entries()]
      .map(([dept, rs]) => ({ dept, rows: rs, dord: rs[0].dord }))
      .sort((a, b) => a.dord - b.dord || a.dept.localeCompare(b.dept))
      .map(({ dept, rows }) => ({ dept, rows }));

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 24px">Please find attached the results of the weekly workload (${pretty}).</p>
    ${settings.email_signature || ""}
  </div>
</body></html>`;

    stage = "build pdf";
    const pdfB64 = await buildPdf(pretty, groups, list.length, submitted.length, missing.map((r: any) => r.name));
    const pdfName = `PLF-Weekly-Workload-${reportDate}.pdf`;

    stage = "resolve recipients";
    let recipients: string[];
    if (overrideTo) {
      recipients = overrideTo;
    } else {
      const { data: recs } = await supabase.from("general_recipients")
        .select("email").eq("active", true);
      recipients = (recs || []).map((r: any) => r.email).filter(Boolean);
    }
    if (!recipients.length) {
      await logError(ERROR_KIND, reportDate, "no active general recipients");
      return new Response(
        JSON.stringify({ skipped: true, reason: "no active general recipients" }),
        { status: 200 },
      );
    }

    stage = "send";
    const subject = (preview ? "[PREVIEW] " : "") + `Weekly Workload — ${pretty}`;
    const r = await sendEmail(settings, recipients, subject, html, { pdfB64, pdfName });
    if (!preview) {
      if (r.ok) await markSent(KIND, reportDate, r.detail ?? "sent");
      else await logError(ERROR_KIND, reportDate, "send failed: " + r.detail);
    }

    return new Response(
      JSON.stringify({
        ok: r.ok,
        preview,
        signature: !!settings.email_signature,
        reportDate,
        departments: groups.map((g) => `${g.dept}:${g.rows.length}`),
        to: recipients,
        detail: r.detail,
      }),
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
