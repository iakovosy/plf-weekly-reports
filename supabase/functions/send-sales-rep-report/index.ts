// SALES REP PERFORMANCE report: covering email + branded PDF showing each sales
// rep's funnel for a chosen period, with the previous period beside it.
//
// WHY ONE REPORT RATHER THAN ONE PER METRIC
// These numbers are a funnel - connected calls -> deals created -> meetings ->
// converted. The counts are already visible live in HubSpot; what a document
// adds is the RATIOS BETWEEN the stages, and those cannot be computed if the
// stages live in separate reports. So one report, one row per rep.
//
// WHO COUNTS AS A REP
// The sales_rep picklist in HubSpot still holds everyone who ever sold, so it
// cannot decide who belongs in a current league table. The portal already keeps
// that roster - sales_admins, managed in the console - so the report takes the
// list from there. A rep who leaves is removed in one place and disappears from
// the next report; nothing here needs editing.
//
// sales_rep IS MULTI-SELECT. A shared deal arrives as "Kristin Hofmann;Georgia
// Markitsi", so the value is split on ";" and each named rep is credited. Both
// get a full unit of credit - a shared deal would otherwise appear as its own
// phantom rep, which is what happened before this was handled.
//
// METRIC DEFINITIONS - the call metrics were verified against the live HubSpot
// dashboard before being coded, because a report that quietly disagrees with
// the dashboard everyone reads is worse than no report. These definitions used
// to be printed on the first page of the PDF; that page has been removed, so
// this comment is now the only place they are written down. Keep it accurate:
//
//   Connected calls   calls whose OUTCOME (hs_call_disposition) is "Connected".
//                     This is the call outcome, NOT hs_call_status: status
//                     COMPLETED gave 321 for one rep in Aug 2026 where the
//                     dashboard said 102. The disposition gives exactly 102.
//   Median duration   median hs_call_duration across those connected calls that
//                     have a duration recorded. Calls with no duration are
//                     excluded, not counted as zero - verified at 95s for the
//                     same rep/month, matching the dashboard.
//   Meetings booked   deals CREATED during the period. In this firm a deal is
//                     created at the moment a meeting is booked with the lead -
//                     the first stage of the pipeline is literally "Meeting
//                     Scheduled" - so the meeting and the deal are one event.
//                     An earlier version labelled the Quote sent count
//                     "Meetings booked", which made the two look like they
//                     disagreed when they were simply different milestones.
//   Quote sent        deals that entered the Quote sent stage during the
//                     period. A later milestone, kept under its own name.
//   Converted         deals entering the Converted stage during the period.
//   Company regs      of those Converted deals, the ones whose service category
//                     is Company Registration. A SUBSET of Converted, never an
//                     addition to it. The category lives on
//                     serv_category_corporate, not on service_category, which
//                     is present but unpopulated - checked, and the wrong one
//                     returns zero for every month. Verified against the
//                     dashboard card "Sales reps - Company Registration - last
//                     month": both give 19 for August 2026, and the same split
//                     across reps.
//
// THE ORDER OF THE FUNNEL MATTERS, AND WAS WRONG ONCE
// A deal is created at Meeting Scheduled and reaches Quote sent later. An
// earlier version had those two the wrong way round and divided one by the
// other, printing "229%" and "443%" conversion rates - nonsense, and a reminder
// that a ratio between two stages means nothing unless the stages are in order.
//
// ONE PERIOD, ONE NUMBER PER CELL
// An earlier version showed the chosen period and the one before it in the same
// cell as "49 (63)", and nobody could tell which was which. Splitting them into
// columns fixed the ambiguity but not the clutter, so the report now shows the
// chosen period ONLY. Half the HubSpot searches disappeared with it.
//
// THE RATIOS ARE COHORT-BASED, NOT PERIOD-BASED
// Dividing "converted this month" by "created this month" compares two
// different sets of deals: most deals converting in August were created in June
// or July. That is not a conversion rate. So the second table follows a single
// COHORT instead - of the meetings booked in the period, how many have since
// reached Quote sent or Converted. Those figures cannot exceed 100%, and
// they answer the question a conversion rate is supposed to answer.
//
// Calls are attributed by HubSpot OWNER; deals by the sales_rep property.
// They are joined on the person's name, which is the only link that exists.
//
// PACING: this report makes far more HubSpot search calls than the weekly ones,
// which is enough to trip HubSpot's per-second search cap. The pacing and 429
// retry live in _shared/hubspot.ts so every report gets them.
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, splitRecipients } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { logError, markSent } from "../_shared/schedule.ts";
import { fetchOwners, fetchPipeline, hsSearch } from "../_shared/hubspot.ts";
import {
  COLORS,
  createDoc,
  drawFooterAllPages,
  drawLetterhead,
  wrap,
} from "../_shared/pdf.ts";

const KIND = "sales_rep_report";
const ERROR_KIND = "sales_rep_report_error";
const W = 595, H = 842, M = 40;

// HubSpot's built-in "Connected" call outcome.
const CONNECTED = "f240bbac-87c9-4f6e-bf70-924b57d47db7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

const norm = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// "Kristin Hofmann;Georgia Markitsi" -> both names.
const repsOn = (d: any): string[] =>
  String(d?.properties?.sales_rep || "")
    .split(";").map((x) => x.trim()).filter(Boolean);

// serv_category_corporate is multi-select too: a deal can read
// "Company Registration;Nominee Secretary;Nominee Office", so test for
// membership rather than equality.
const isCompanyReg = (d: any): boolean =>
  String(d?.properties?.serv_category_corporate || "")
    .split(";").map((x) => x.trim()).includes("Company Registration");

type Range = { start: number; end: number; label: string; short: string };

const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const OFF = 3 * 3600000;   // Cyprus is UTC+2/+3; close enough at month scale

function monthRange(year: number, month: number): Range {
  return {
    start: Date.UTC(year, month, 1) - OFF,
    end: Date.UTC(year, month + 1, 1) - OFF,
    label: `${MON[month]} ${year}`,
    short: `${SHORT[month]} ${String(year).slice(2)}`,
  };
}

function periodsFor(period: string, now: { date: string }): { cur: Range; prev: Range } {
  const [y, m] = now.date.split("-").map(Number);
  if (period === "year") {
    return {
      cur: { start: Date.UTC(y, 0, 1) - OFF, end: Date.now(), label: `${y} so far`, short: String(y) },
      prev: { start: Date.UTC(y - 1, 0, 1) - OFF, end: Date.UTC(y, 0, 1) - OFF, label: String(y - 1), short: String(y - 1) },
    };
  }
  if (period === "last-month") {
    const lm = m - 2, ly = lm < 0 ? y - 1 : y;
    const pm = m - 3, py = pm < 0 ? y - 1 : y;
    return { cur: monthRange(ly, (lm + 12) % 12), prev: monthRange(py, (pm + 12) % 12) };
  }
  const pm = m - 2, py = pm < 0 ? y - 1 : y;
  return {
    cur: {
      start: Date.UTC(y, m - 1, 1) - OFF, end: Date.now(),
      label: `${MON[m - 1]} ${y} so far`, short: `${SHORT[m - 1]} so far`,
    },
    prev: monthRange(py, (pm + 12) % 12),
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};

const secs = (ms: number | null) => ms == null ? "-" : `${Math.round(ms / 1000)}s`;

type RepRow = {
  name: string;
  calls: number;
  dur: number | null;
  scheduled: number;   // deals created = meetings booked; see header note
  converted: number;
  companyReg: number;  // of those converted, the Company Registration ones
  // cohort: of the meetings scheduled this period, how far they have got since
  cohort: number; cohortQuote: number; cohortConverted: number;
};

async function callsFor(token: string, ownerId: string, r: Range) {
  const rows = await hsSearch(token, "calls", {
    filterGroups: [{
      filters: [
        { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId },
        { propertyName: "hs_call_disposition", operator: "EQ", value: CONNECTED },
        { propertyName: "hs_timestamp", operator: "GTE", value: String(r.start) },
        { propertyName: "hs_timestamp", operator: "LT", value: String(r.end) },
      ],
    }],
    properties: ["hs_call_duration"],
    limit: 100,
  }, 20);
  const durations = rows
    .map((c: any) => parseInt(String(c.properties?.hs_call_duration ?? ""), 10))
    .filter((n: number) => !isNaN(n) && n > 0);
  return { count: rows.length, median: median(durations) };
}

async function dealsEntering(
  token: string, pipeline: string, prop: string, r: Range, extra: string[] = [],
) {
  return await hsSearch(token, "deals", {
    filterGroups: [{
      filters: [
        { propertyName: "pipeline", operator: "EQ", value: pipeline },
        { propertyName: prop, operator: "GTE", value: String(r.start) },
        { propertyName: prop, operator: "LT", value: String(r.end) },
      ],
    }],
    properties: ["dealname", "sales_rep", prop, ...extra],
    limit: 100,
  }, 20);
}

type Section = { title: string; note?: string; cols: { t: string; w: number }[]; rows: string[][]; lines?: string[] };

async function buildPdf(title: string, subtitle: string, sections: Section[]): Promise<string> {
  const d = await createDoc();
  const { font, bold, clean } = d;
  let page = d.doc.addPage([W, H]);
  drawLetterhead(page, d, { W, H, M, title, subtitle, bandHeight: 84 });
  let y = H - 108;
  const newPage = () => { page = d.doc.addPage([W, H]); y = H - 50; };

  for (const sec of sections) {
    const cols = sec.cols;
    const TW = cols.reduce((s, c) => s + c.w, 0);
    const headerRow = () => {
      let x = M;
      page.drawRectangle({ x: M, y: y - 4, width: TW, height: 18, color: COLORS.blue });
      for (const c of cols) {
        page.drawText(clean(c.t), { x: x + 4, y, size: 8, font: bold, color: COLORS.white });
        x += c.w;
      }
      y -= 20;
    };
    if (y < 150) newPage();
    page.drawText(clean(sec.title.toUpperCase()), { x: M, y, size: 10, font: bold, color: COLORS.navy });
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + 150, y: y - 4 }, thickness: 1.2, color: COLORS.blue });
    y -= 14;
    if (sec.note) {
      for (const ln of wrap(sec.note, W - 2 * M, 8, font)) {
        if (y < 60) newPage();
        page.drawText(clean(ln), { x: M, y, size: 8, font, color: COLORS.note });
        y -= 10;
      }
      y -= 4;
    }
    if (sec.lines) {
      for (const ln of sec.lines) {
        if (y < 70) newPage();
        page.drawText(clean(ln), { x: M, y, size: 9, font, color: COLORS.black });
        y -= 13;
      }
      y -= 16;
      continue;
    }
    if (!sec.rows.length) {
      page.drawText("Nothing to show.", { x: M, y, size: 9.5, font, color: COLORS.black });
      y -= 26;
      continue;
    }
    headerRow();
    let ri = 0;
    for (const r of sec.rows) {
      const vals = r.map(clean);
      const isTotal = vals[0] === "TEAM";
      const rowFont = (i: number) => (i === 0 || isTotal) ? bold : font;
      const cl = vals.map((v, i) => wrap(v, cols[i].w, 8.5, rowFont(i)));
      const rowH = Math.max(...cl.map((l) => l.length)) * 11 + 8;
      if (y - rowH < 50) { newPage(); headerRow(); }
      if (isTotal) {
        page.drawRectangle({ x: M, y: y - rowH + 13, width: TW, height: rowH, color: COLORS.totalRow });
      } else if (ri % 2 === 1) {
        page.drawRectangle({ x: M, y: y - rowH + 13, width: TW, height: rowH, color: COLORS.soft });
      }
      let x = M;
      vals.forEach((_, i) => {
        cl[i].forEach((line, li) => {
          page.drawText(line, { x: x + 4, y: y - li * 11, size: 8.5, font: rowFont(i), color: COLORS.black });
        });
        x += cols[i].w;
      });
      page.drawLine({
        start: { x: M, y: y - rowH + 11 }, end: { x: M + TW, y: y - rowH + 11 },
        thickness: 0.5, color: COLORS.grey,
      });
      y -= rowH;
      ri++;
    }
    y -= 22;
  }
  drawFooterAllPages(d, M);
  return await d.doc.saveAsBase64();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  let stage = "init", runDate = "";
  try {
    const settings = await getSettings();
    const body = await req.json().catch(() => ({}));

    const byPass = settings.admin_passcode && String(body.passcode ?? "") === settings.admin_passcode;
    const byCron = req.headers.get("x-cron-secret") === settings.cron_secret;
    if (!byPass && !byCron) return json({ error: "unauthorized" }, 401);

    const now = cyprusNow();
    runDate = now.date;
    const period = ["this-month", "last-month", "year"].includes(String(body.period))
      ? String(body.period) : "last-month";
    const { cur } = periodsFor(period, now);

    stage = "hubspot token";
    const token = settings.hubspot_token;
    if (!token) return json({ skipped: true, reason: "hubspot_token not set" });

    // The current Sales roster, from the portal rather than from HubSpot's
    // picklist of everyone who ever sold.
    stage = "roster";
    const { data: admins } = await supabase
      .from("sales_admins").select("name").eq("active", true);
    const roster = new Map<string, string>();   // normalised -> display name
    for (const a of (admins || [])) if (a.name) roster.set(norm(a.name), a.name);
    if (!roster.size) return json({ skipped: true, reason: "no active sales reps on the roster" });

    const pipeline = settings.sales_deals_pipeline || "default";
    const convStage = (settings.sales_deals_converted_stages || "249514588,closedwon").split(",")[0].trim();

    stage = "pipeline";
    const pipeInfo = await fetchPipeline(token, "deals", pipeline);
    let quoteSentId = "";
    for (const [id, st] of pipeInfo.stages) {
      if (String(st.label).toLowerCase().replace(/[^a-z]/g, "").includes("quotesent")) { quoteSentId = id; break; }
    }
    const QUOTE = quoteSentId ? `hs_v2_date_entered_${quoteSentId}` : "";
    const CONV = `hs_v2_date_entered_${convStage}`;

    stage = "owners";
    const { names: ownerNames } = await fetchOwners(token);
    const ownerByName = new Map<string, string>();
    for (const [id, nm] of ownerNames) if (nm) ownerByName.set(norm(nm), id);

    // Only people on the roster get a row. A shared deal credits every rep
    // named on it who is on the roster.
    const tally = (rows: any[]) => {
      const m = new Map<string, number>();
      for (const d of rows) {
        for (const r of repsOn(d)) {
          const key = norm(r);
          if (!roster.has(key)) continue;
          m.set(key, (m.get(key) || 0) + 1);
        }
      }
      return m;
    };

    stage = "deals";
    // Only the chosen period. Dropping the previous-period fetches roughly
    // halves the HubSpot searches this report makes, and nothing shows a
    // comparison any more, so fetching them would be work nobody sees.
    const createdCur = await dealsEntering(
      token, pipeline, "createdate", cur, [QUOTE, CONV].filter(Boolean),
    );
    // Conversions carry their service category so the Company Registration
    // subset can be counted here rather than in a second query.
    const convCur = await dealsEntering(token, pipeline, CONV, cur, ["serv_category_corporate"]);

    const t = {
      scheduled: tally(createdCur),
      converted: tally(convCur),
      companyReg: tally(convCur.filter(isCompanyReg)),
    };

    // Cohort: follow the meetings scheduled in this period and see how far they
    // got. The same deals all the way across, so nothing can exceed 100%.
    const has = (d: any, p: string) => !!p && String(d.properties?.[p] ?? "").trim() !== "";
    const coh = new Map<string, { n: number; quote: number; conv: number }>();
    for (const d of createdCur) {
      for (const r of repsOn(d)) {
        const key = norm(r);
        if (!roster.has(key)) continue;
        const c = coh.get(key) || { n: 0, quote: 0, conv: 0 };
        c.n++;
        if (has(d, QUOTE)) c.quote++;
        if (has(d, CONV)) c.conv++;
        coh.set(key, c);
      }
    }

    stage = "calls";
    const rows: RepRow[] = [];
    const unmatched: string[] = [];
    for (const [key, display] of [...roster.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      const oid = ownerByName.get(key);
      if (!oid) unmatched.push(display);
      const c = oid ? await callsFor(token, oid, cur) : { count: 0, median: null };
      const k = coh.get(key) || { n: 0, quote: 0, conv: 0 };
      rows.push({
        name: display,
        calls: c.count,
        dur: c.median,
        scheduled: t.scheduled.get(key) || 0,
        converted: t.converted.get(key) || 0,
        companyReg: t.companyReg.get(key) || 0,
        cohort: k.n, cohortQuote: k.quote, cohortConverted: k.conv,
      });
    }
    rows.sort((a, b) =>
      b.converted - a.converted || b.scheduled - a.scheduled || a.name.localeCompare(b.name));

    stage = "build pdf";
    const sum = (f: (r: RepRow) => number) => rows.reduce((s, r) => s + f(r), 0);

    // One row per rep again. The per-rep blocks existed only to keep two
    // periods apart; with a single period every cell holds one number, so a
    // single table is both unambiguous and comparable across reps.
    const nPct = (n: number, of: number) =>
      of ? `${n}  (${Math.round((n / of) * 100)}%)` : "0  (-)";

    const mainRows = rows.map((r) => [
      r.name, String(r.calls), secs(r.dur),
      String(r.scheduled), String(r.converted), String(r.companyReg),
    ]);
    if (rows.length) {
      mainRows.push([
        "TEAM", String(sum((r) => r.calls)), "-",
        String(sum((r) => r.scheduled)), String(sum((r) => r.converted)),
        String(sum((r) => r.companyReg)),
      ]);
    }

    const cohortRows = rows.map((r) => [
      r.name, String(r.cohort), nPct(r.cohortQuote, r.cohort), nPct(r.cohortConverted, r.cohort),
    ]);
    if (rows.length) {
      const cN = sum((r) => r.cohort);
      cohortRows.push([
        "TEAM", String(cN),
        nPct(sum((r) => r.cohortQuote), cN), nPct(sum((r) => r.cohortConverted), cN),
      ]);
    }

    const sections: Section[] = [
      {
        title: `By sales rep — ${cur.label}`,
        note: "Company regs converted is a SUBSET of Converted, not an addition to it: the converted deals whose service category is Company Registration. A deal shared between two reps is counted for both.",
        cols: [
          { t: "Sales rep", w: 100 }, { t: "Conn. calls", w: 68 }, { t: "Median call", w: 68 },
          { t: "Meetings booked", w: 88 }, { t: "Converted", w: 72 },
          { t: "Company regs converted", w: 119 },
        ],
        rows: mainRows,
      },
      {
        title: `What became of the meetings booked in ${cur.label}`,
        note: `This follows ONLY the meetings booked in ${cur.label} and asks how far they have got since - the same deals all the way across, which is why nothing here can exceed 100%. Each cell gives the number of deals first, then what share of that rep's booked meetings it is.`,
        cols: [
          { t: "Sales rep", w: 150 }, { t: "Meetings booked", w: 120 },
          { t: "Reached quote sent", w: 125 }, { t: "Converted", w: 120 },
        ],
        rows: cohortRows,
      },
    ];

    if (unmatched.length) {
      sections.push({
        title: "No matching HubSpot user",
        note: "Calls are attributed by HubSpot owner. These reps are on the Sales roster but no HubSpot user matched their name, so their call figures above read zero rather than being genuinely zero.",
        cols: [], rows: [],
        lines: unmatched.map((u, i) => `${i + 1}. ${u}`),
      });
    }

    const pdfB64 = await buildPdf(
      "Sales Rep Performance",
      `${pipeInfo.label || "Sales Pipeline"} — ${cur.label}`,
      sections,
    );
    const pdfName = `PLF-Sales-Rep-Performance-${now.date}.pdf`;

    stage = "send";
    const to = (typeof body.to === "string" ? [body.to] : Array.isArray(body.to) ? body.to : null) ??
      splitRecipients(settings.sales_rep_report_recipient || settings.sales_deals_report_recipient);
    if (!to.length) return json({ skipped: true, reason: "no recipient" });

    const td = "padding:6px 10px;border:1px solid #E2DDD9;font-size:13px";
    const th = "padding:7px 10px;background:#4F75FF;color:#ffffff;text-align:left;font-size:12px";
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 14px">Sales rep performance for <b>${cur.label}</b>.</p>
    <table style="border-collapse:collapse;margin:14px 0">
      <tr><th style="${th}">Sales rep</th><th style="${th}">Connected calls</th><th style="${th}">Meetings booked</th><th style="${th}">Converted</th><th style="${th}">Company regs</th></tr>
      ${rows.map((r) =>
        `<tr><td style="${td}">${r.name}</td><td style="${td};text-align:center">${r.calls}</td><td style="${td};text-align:center">${r.scheduled}</td><td style="${td};text-align:center">${r.converted}</td><td style="${td};text-align:center">${r.companyReg}</td></tr>`
      ).join("")}
    </table>
    <p style="margin:0 0 24px">Company regs is the Company Registration share of Converted, not an extra. The attached PDF adds median call length and what has since become of the meetings booked in ${cur.label}.</p>
    ${settings.email_signature || ""}
  </div>
</body></html>`;

    const r = await sendEmail(settings, to, `Sales Rep Performance — ${cur.label}`, html, { pdfB64, pdfName });
    if (byCron && r.ok) await markSent(KIND, now.date, r.detail ?? "sent");
    if (!r.ok) await logError(ERROR_KIND, now.date, "send failed: " + r.detail);

    return json({
      ok: r.ok,
      period,
      current: cur.label,
      reps: rows.map((x) => x.name),
      unmatched,
      to,
      detail: r.detail,
      generated: prettyDate(now.date),
    });
  } catch (e) {
    await logError(ERROR_KIND, runDate || new Date().toISOString().slice(0, 10), `crashed at ${stage}: ${String(e)}`);
    return json({ error: String(e), stage }, 500);
  }
});
