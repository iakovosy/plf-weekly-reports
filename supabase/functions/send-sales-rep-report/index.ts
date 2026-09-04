// SALES REP PERFORMANCE report: covering email + branded PDF showing each sales
// rep's funnel for a chosen period, with the previous period beside it.
//
// WHY ONE REPORT RATHER THAN ONE PER METRIC
// These numbers are a funnel - connected calls -> meetings -> deals created ->
// converted. The counts are already visible live in HubSpot; what a document
// adds is the RATIOS BETWEEN the stages, and those cannot be computed if the
// stages live in separate reports. So one report, one row per rep.
//
// WHY THE PERIOD IS A PARAMETER
// The HubSpot dashboard carries the same metric twice, once per period, because
// a dashboard card cannot take a parameter. A generated document can, so this
// takes period=this-month|last-month|year and always prints the previous
// comparable period next to each figure.
//
// METRIC DEFINITIONS - each was verified against the live HubSpot dashboard
// before being written here, because a report that quietly disagrees with the
// dashboard is worse than no report:
//
//   Connected calls   calls whose OUTCOME (hs_call_disposition) is "Connected".
//                     Note this is the call outcome, NOT hs_call_status: status
//                     COMPLETED gave 321 for one rep in Aug 2026 where the
//                     dashboard said 102. The disposition gives exactly 102.
//   Median duration   median hs_call_duration across those connected calls that
//                     have a duration recorded. Calls with no duration are
//                     excluded, not counted as zero - verified at 95s for the
//                     same rep/month, matching the dashboard.
//   Meetings          deals that ENTERED the Quote sent stage during the period.
//                     "Quote sent" is where the lawyer meeting happens; the
//                     weekly deals report already uses this same definition.
//   Created/Converted/Disengaged
//                     deals created, or entering the Converted / Disengaged
//                     stage, during the period, attributed by the sales_rep
//                     property on the deal.
//
// Calls are attributed by HubSpot OWNER; deals by the sales_rep TEXT property.
// They are joined on the person's name, which is the only link that exists.
// Any name that appears on one side but not the other is listed in the PDF
// rather than dropped, so a mismatch is visible instead of silently halving
// somebody's funnel.
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

// sales_rep picklist values that are not people and must never appear in a
// per-rep league table.
const NOT_A_REP = ["existing client – no rep", "existing client - no rep", "wolf media digital"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

const norm = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const isRep = (name: string) => !!name && !NOT_A_REP.includes(norm(name));

type Range = { start: number; end: number; label: string };

// Month boundaries in Cyprus time. Cyprus is UTC+2/+3, so a month starts a
// couple of hours before UTC midnight; Date.UTC minus the offset is close
// enough for month-scale reporting and never lands mid-day.
function monthRange(year: number, month: number, label: string): Range {
  const off = 3 * 3600000;
  return {
    start: Date.UTC(year, month, 1) - off,
    end: Date.UTC(year, month + 1, 1) - off,
    label,
  };
}

function periodsFor(period: string, now: { date: string }): { cur: Range; prev: Range } {
  const [y, m] = now.date.split("-").map(Number);
  const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  if (period === "year") {
    const off = 3 * 3600000;
    return {
      cur: { start: Date.UTC(y, 0, 1) - off, end: Date.now(), label: `${y} so far` },
      prev: { start: Date.UTC(y - 1, 0, 1) - off, end: Date.UTC(y, 0, 1) - off, label: String(y - 1) },
    };
  }
  if (period === "last-month") {
    const lm = m - 2, ly = lm < 0 ? y - 1 : y, lmi = (lm + 12) % 12;
    const pm = m - 3, py = pm < 0 ? y - 1 : y, pmi = (pm + 12) % 12;
    return { cur: monthRange(ly, lmi, `${MON[lmi]} ${ly}`), prev: monthRange(py, pmi, `${MON[pmi]} ${py}`) };
  }
  // this-month: current month to date, against the whole of last month
  const off = 3 * 3600000;
  const pm = m - 2, py = pm < 0 ? y - 1 : y, pmi = (pm + 12) % 12;
  return {
    cur: { start: Date.UTC(y, m - 1, 1) - off, end: Date.now(), label: `${MON[m - 1]} ${y} so far` },
    prev: monthRange(py, pmi, `${MON[pmi]} ${py}`),
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};

const secs = (ms: number | null) => ms == null ? "-" : `${Math.round(ms / 1000)}s`;

// A count with its previous-period value beneath it, so every figure carries
// its own comparison rather than needing a second table.
const withPrev = (cur: number, prev: number) => `${cur}  (${prev})`;

type RepRow = {
  name: string;
  calls: number; callsPrev: number;
  dur: number | null; durPrev: number | null;
  meetings: number; meetingsPrev: number;
  created: number; createdPrev: number;
  converted: number; convertedPrev: number;
  disengaged: number; disengagedPrev: number;
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

async function dealsEntering(token: string, pipeline: string, prop: string, r: Range) {
  return await hsSearch(token, "deals", {
    filterGroups: [{
      filters: [
        { propertyName: "pipeline", operator: "EQ", value: pipeline },
        { propertyName: prop, operator: "GTE", value: String(r.start) },
        { propertyName: prop, operator: "LT", value: String(r.end) },
      ],
    }],
    properties: ["dealname", "sales_rep", prop],
    limit: 100,
  }, 20);
}

const tally = (rows: any[]) => {
  const m = new Map<string, number>();
  for (const d of rows) {
    const rep = String(d.properties?.sales_rep || "").trim();
    if (!isRep(rep)) continue;
    m.set(rep, (m.get(rep) || 0) + 1);
  }
  return m;
};

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
    if (y < 130) newPage();
    page.drawText(clean(sec.title.toUpperCase()), { x: M, y, size: 10, font: bold, color: COLORS.navy });
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + 150, y: y - 4 }, thickness: 1.2, color: COLORS.blue });
    y -= 14;
    if (sec.note) {
      for (const ln of wrap(sec.note, W - 2 * M, 8, font)) {
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

    // Console (passcode) or cron (secret). Either is fine; neither means no.
    const byPass = settings.admin_passcode && String(body.passcode ?? "") === settings.admin_passcode;
    const byCron = req.headers.get("x-cron-secret") === settings.cron_secret;
    if (!byPass && !byCron) return json({ error: "unauthorized" }, 401);

    const now = cyprusNow();
    runDate = now.date;
    const period = ["this-month", "last-month", "year"].includes(String(body.period))
      ? String(body.period) : "last-month";
    const { cur, prev } = periodsFor(period, now);

    stage = "hubspot token";
    const token = settings.hubspot_token;
    if (!token) return json({ skipped: true, reason: "hubspot_token not set" });

    const pipeline = settings.sales_deals_pipeline || "default";
    const convStage = (settings.sales_deals_converted_stages || "249514588,closedwon").split(",")[0].trim();

    stage = "pipeline";
    const pipeInfo = await fetchPipeline(token, "deals", pipeline);
    let quoteSentId = "";
    for (const [id, st] of pipeInfo.stages) {
      if (String(st.label).toLowerCase().replace(/[^a-z]/g, "").includes("quotesent")) { quoteSentId = id; break; }
    }

    stage = "owners";
    const { names: ownerNames } = await fetchOwners(token);

    stage = "deals";
    const dealsFor = async (r: Range) => ({
      created: await dealsEntering(token, pipeline, "createdate", r),
      meetings: quoteSentId ? await dealsEntering(token, pipeline, `hs_v2_date_entered_${quoteSentId}`, r) : [],
      converted: await dealsEntering(token, pipeline, `hs_v2_date_entered_${convStage}`, r),
      disengaged: await dealsEntering(token, pipeline, "hs_v2_date_entered_closedlost", r),
    });
    const [dCur, dPrev] = await Promise.all([dealsFor(cur), dealsFor(prev)]);

    const t = {
      created: tally(dCur.created), createdPrev: tally(dPrev.created),
      meetings: tally(dCur.meetings), meetingsPrev: tally(dPrev.meetings),
      converted: tally(dCur.converted), convertedPrev: tally(dPrev.converted),
      disengaged: tally(dCur.disengaged), disengagedPrev: tally(dPrev.disengaged),
    };

    // Everyone who appears anywhere in the deal data, plus every active owner
    // who made a connected call. A rep with calls but no deals still belongs in
    // the table - that gap is exactly what the report is for.
    const repNames = new Set<string>();
    for (const m of Object.values(t)) for (const k of m.keys()) repNames.add(k);
    const ownerByName = new Map<string, string>();
    for (const [id, nm] of ownerNames) if (nm) ownerByName.set(norm(nm), id);

    stage = "calls";
    const rows: RepRow[] = [];
    const unmatched: string[] = [];
    for (const name of [...repNames].sort()) {
      const oid = ownerByName.get(norm(name));
      if (!oid) unmatched.push(name);
      const [c, cp] = oid
        ? await Promise.all([callsFor(token, oid, cur), callsFor(token, oid, prev)])
        : [{ count: 0, median: null }, { count: 0, median: null }];
      rows.push({
        name,
        calls: c.count, callsPrev: cp.count,
        dur: c.median, durPrev: cp.median,
        meetings: t.meetings.get(name) || 0, meetingsPrev: t.meetingsPrev.get(name) || 0,
        created: t.created.get(name) || 0, createdPrev: t.createdPrev.get(name) || 0,
        converted: t.converted.get(name) || 0, convertedPrev: t.convertedPrev.get(name) || 0,
        disengaged: t.disengaged.get(name) || 0, disengagedPrev: t.disengagedPrev.get(name) || 0,
      });
    }
    rows.sort((a, b) => b.converted - a.converted || b.created - a.created || a.name.localeCompare(b.name));

    stage = "build pdf";
    const sum = (f: (r: RepRow) => number) => rows.reduce((s, r) => s + f(r), 0);
    const pct = (a: number, b: number) => b ? Math.round((a / b) * 100) + "%" : "-";

    const funnelRows = rows.map((r) => [
      r.name,
      withPrev(r.calls, r.callsPrev),
      `${secs(r.dur)}  (${secs(r.durPrev)})`,
      withPrev(r.meetings, r.meetingsPrev),
      withPrev(r.created, r.createdPrev),
      withPrev(r.converted, r.convertedPrev),
      withPrev(r.disengaged, r.disengagedPrev),
    ]);
    if (rows.length) {
      funnelRows.push([
        "TEAM",
        withPrev(sum((r) => r.calls), sum((r) => r.callsPrev)),
        "-",
        withPrev(sum((r) => r.meetings), sum((r) => r.meetingsPrev)),
        withPrev(sum((r) => r.created), sum((r) => r.createdPrev)),
        withPrev(sum((r) => r.converted), sum((r) => r.convertedPrev)),
        withPrev(sum((r) => r.disengaged), sum((r) => r.disengagedPrev)),
      ]);
    }

    const ratioRows = rows.map((r) => [
      r.name,
      pct(r.meetings, r.calls),
      pct(r.created, r.meetings),
      pct(r.converted, r.created),
      pct(r.converted, r.calls),
    ]);
    if (rows.length) {
      ratioRows.push([
        "TEAM",
        pct(sum((r) => r.meetings), sum((r) => r.calls)),
        pct(sum((r) => r.created), sum((r) => r.meetings)),
        pct(sum((r) => r.converted), sum((r) => r.created)),
        pct(sum((r) => r.converted), sum((r) => r.calls)),
      ]);
    }

    const sections: Section[] = [
      {
        title: "The funnel, by sales rep",
        note: `${cur.label}, with ${prev.label} in brackets. Connected calls are calls whose outcome is "Connected". Duration is the median of those calls that have a duration recorded. Meetings are deals that reached Quote sent.`,
        cols: [
          { t: "Sales rep", w: 108 }, { t: "Conn. calls", w: 70 }, { t: "Median call", w: 72 },
          { t: "Meetings", w: 62 }, { t: "Created", w: 62 }, { t: "Converted", w: 68 },
          { t: "Diseng.", w: 73 },
        ],
        rows: funnelRows,
      },
      {
        title: "Where each rep leaks",
        note: `Conversion between funnel stages for ${cur.label}. A low call-to-meeting rate and a high meeting-to-deal rate mean different problems: the first is about who is being called, the second about what happens in the meeting.`,
        cols: [
          { t: "Sales rep", w: 150 }, { t: "Call → meeting", w: 95 }, { t: "Meeting → deal", w: 95 },
          { t: "Deal → converted", w: 100 }, { t: "Call → converted", w: 75 },
        ],
        rows: ratioRows,
      },
    ];

    if (unmatched.length) {
      sections.push({
        title: "Not matched to a HubSpot user",
        note: "Deals are attributed by the sales_rep property (a name); calls are attributed by HubSpot owner. These names had no matching owner, so their call figures above read zero rather than being genuinely zero.",
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
    <p style="margin:0 0 14px">Sales rep performance for <b>${cur.label}</b>, with ${prev.label} shown in brackets for comparison.</p>
    <table style="border-collapse:collapse;margin:14px 0">
      <tr><th style="${th}">Sales rep</th><th style="${th}">Connected calls</th><th style="${th}">Meetings</th><th style="${th}">Created</th><th style="${th}">Converted</th></tr>
      ${rows.map((r) =>
        `<tr><td style="${td}">${r.name}</td><td style="${td};text-align:center">${r.calls} (${r.callsPrev})</td><td style="${td};text-align:center">${r.meetings} (${r.meetingsPrev})</td><td style="${td};text-align:center">${r.created} (${r.createdPrev})</td><td style="${td};text-align:center">${r.converted} (${r.convertedPrev})</td></tr>`
      ).join("")}
    </table>
    <p style="margin:0 0 24px">The attached PDF adds median call duration, disengaged deals, and the conversion rate between each funnel stage.</p>
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
      previous: prev.label,
      reps: rows.length,
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
