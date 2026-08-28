// SALES DEALS weekly report: covering email + branded PDF analysing HubSpot deals
// created by sales reps (custom property sales_rep) over a Wednesday->Wednesday week
// in Cyprus time.
//
// Sections: per-rep summary (created / converted / in progress / disengaged /
// conversion rate / EUR value); conversions that ENTERED the Converted stage during
// the week whatever week they were created; disengaged-this-week split by whether the
// deal ever reached "Quote sent" (the lawyer meeting), each with the Closed Lost
// Reason; and a hygiene list of new-business deals with no sales_rep recorded.
//
// force:true bypasses the window; force + to => preview (no send_log row, [PREVIEW]
// subject). On a forced run outside the scheduled day the window becomes
// [most recent scheduled-day 00:00, now] so a mid-week test shows the running week.
//
// Plumbing lives in ../_shared.
import { addDays, cyprusMidnightUTC, cyprusNow, prettifyOrDash, prettyDate } from "../_shared/time.ts";
import { getSettings, splitRecipients, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, logError, markSent } from "../_shared/schedule.ts";
import { fetchPipeline, hsSearch } from "../_shared/hubspot.ts";
import {
  COLORS,
  createDoc,
  drawFooterAllPages,
  drawLetterhead,
  raw,
  wrap,
} from "../_shared/pdf.ts";

const KIND = "sales_deals_report";
const ERROR_KIND = "sales_deals_report_error";

const W = 595, H = 842, M = 40;

const DEAL_PROPS = [
  "dealname",
  "dealstage",
  "sales_rep",
  "createdate",
  "amount",
  "dealtype",
  "closed_lost_reason",
  "hs_v2_date_entered_249514588",
  "hubspot_owner_id",
];

async function searchDeals(token: string, filters: any[], extraProps: string[] = []): Promise<any[]> {
  return await hsSearch(token, "deals", {
    filterGroups: [{ filters }],
    sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    properties: [...DEAL_PROPS, ...extraProps],
    limit: 100,
  });
}

const eur = (n: number) => "€" + Math.round(n).toLocaleString("en-GB");
const num = (s: any) => {
  const n = parseFloat(String(s ?? ""));
  return isNaN(n) ? 0 : n;
};

// A section is either a table (cols + rows) or a plain numbered list (lines).
type Section = {
  title: string;
  note?: string;
  cols: { t: string; w: number }[];
  rows: string[][];
  redCol?: number;
  lines?: string[];
};

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

    if (y < 120) newPage();
    page.drawText(clean(sec.title.toUpperCase()), { x: M, y, size: 10, font: bold, color: COLORS.navy });
    page.drawLine({
      start: { x: M, y: y - 4 },
      end: { x: M + 140, y: y - 4 },
      thickness: 1.2,
      color: COLORS.blue,
    });
    y -= 14;
    if (sec.note) {
      page.drawText(clean(sec.note), { x: M, y, size: 8, font, color: COLORS.note });
      y -= 14;
    }

    if (sec.lines) {
      for (const ln of sec.lines) {
        if (y < 70) newPage();
        page.drawText(clean(ln), { x: M, y, size: 9, font, color: COLORS.black });
        y -= 13;
      }
      y -= 14;
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
      const isTotal = vals[0] === "TOTAL";
      const rowFont = (i: number) => (i === 0 || isTotal) ? bold : font;
      const cl = vals.map((v, i) => wrap(v, cols[i].w, 8.5, rowFont(i)));
      const rowH = Math.max(...cl.map((l) => l.length)) * 11 + 8;
      if (y - rowH < 50) { newPage(); headerRow(); }

      if (isTotal) {
        page.drawRectangle({
          x: M, y: y - rowH + 13, width: TW, height: rowH, color: COLORS.totalRow,
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
            font: rowFont(i),
            // A non-zero count in the flagged column reads red.
            color: (sec.redCol === i && !isTotal && line !== "0" && line !== "-")
              ? COLORS.red
              : COLORS.black,
          });
        });
        x += cols[i].w;
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
    y -= 22;
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

    const schedDay = settings.sales_deals_report_day || "Wed";
    const schedHour = parseInt(settings.sales_deals_report_hour ?? "8", 10);
    if (!force && !inScheduleWindow(now, schedDay, schedHour, "atOrAfter")) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }),
        { status: 200 },
      );
    }
    if (!force && await alreadyLogged(KIND, now.date)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    stage = "hubspot token";
    const token = settings.hubspot_token;
    if (!token) {
      await logError(ERROR_KIND, now.date, "hubspot_token not set in portal_settings");
      return new Response(
        JSON.stringify({ skipped: true, reason: "hubspot_token not set" }),
        { status: 200 },
      );
    }

    stage = "window";
    const DAYIDX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    const daysSince = ((DAYIDX[now.weekday] ?? 0) - (DAYIDX[schedDay] ?? 2) + 7) % 7;
    let startMs: number, endMs: number, startLabel: string, endLabel: string, partial = false;
    if (daysSince === 0) {
      endMs = cyprusMidnightUTC(now.date);
      startMs = cyprusMidnightUTC(addDays(now.date, -7));
      startLabel = addDays(now.date, -7);
      endLabel = now.date;
    } else {
      const lastSched = addDays(now.date, -daysSince);
      startMs = cyprusMidnightUTC(lastSched);
      endMs = Date.now();
      startLabel = lastSched;
      endLabel = now.date;
      partial = true;
    }

    stage = "fetch deals";
    const pipeline = settings.sales_deals_pipeline || "default";
    const convertedIds = new Set(
      (settings.sales_deals_converted_stages || "249514588,closedwon")
        .split(",").map((s: string) => s.trim()).filter(Boolean),
    );
    const lostIds = new Set(
      (settings.sales_deals_lost_stages || "closedlost")
        .split(",").map((s: string) => s.trim()).filter(Boolean),
    );
    const pipeInfo = await fetchPipeline(token, "deals", pipeline);
    const stageLabel = (id: string) => pipeInfo.stages.get(String(id))?.label || raw(id);

    // The lawyer meeting happens at "Quote sent". A disengaged deal that reached that
    // stage or any later one had the meeting; one that never did dropped before it.
    // Auto-detected by label, overridable via sales_deals_quote_sent_stage (id or label).
    const norm = (x: string) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
    const quoteOverride = (settings.sales_deals_quote_sent_stage || "").trim();
    let quoteSentId = "";
    if (quoteOverride) {
      if (pipeInfo.stages.has(quoteOverride)) quoteSentId = quoteOverride;
      else {
        for (const [id, st] of pipeInfo.stages) {
          if (norm(st.label) === norm(quoteOverride)) { quoteSentId = id; break; }
        }
      }
    }
    if (!quoteSentId) {
      for (const [id, st] of pipeInfo.stages) {
        if (norm(st.label).includes("quotesent")) { quoteSentId = id; break; }
      }
    }
    const quoteOrder = quoteSentId ? (pipeInfo.stages.get(quoteSentId)?.order ?? 99) : Infinity;
    // Stage-entry timestamp properties for Quote sent and every later non-lost stage.
    const reachedProps: string[] = [];
    if (quoteSentId) {
      for (const [id, st] of pipeInfo.stages) {
        if (!lostIds.has(id) && (st.order ?? 99) >= quoteOrder) {
          reachedProps.push(`hs_v2_date_entered_${id}`);
        }
      }
    }

    const pipeFilter = { propertyName: "pipeline", operator: "EQ", value: pipeline };
    const [createdDeals, convertedThisWeek, lostThisWeek] = await Promise.all([
      searchDeals(token, [
        pipeFilter,
        { propertyName: "createdate", operator: "GTE", value: String(startMs) },
        { propertyName: "createdate", operator: "LT", value: String(endMs) },
      ]),
      searchDeals(token, [
        pipeFilter,
        { propertyName: "hs_v2_date_entered_249514588", operator: "GTE", value: String(startMs) },
        { propertyName: "hs_v2_date_entered_249514588", operator: "LT", value: String(endMs) },
      ]),
      searchDeals(token, [
        pipeFilter,
        { propertyName: "hs_v2_date_entered_closedlost", operator: "GTE", value: String(startMs) },
        { propertyName: "hs_v2_date_entered_closedlost", operator: "LT", value: String(endMs) },
      ], ["hs_v2_date_entered_closedlost", ...reachedProps]),
    ]);

    stage = "aggregate";
    type RepAgg = { created: number; clients: number; open: number; lost: number; value: number };
    const reps = new Map<string, RepAgg>();
    const repOf = (t: any) => String(t.properties?.sales_rep || "").trim();
    const get = (name: string) => {
      if (!reps.has(name)) reps.set(name, { created: 0, clients: 0, open: 0, lost: 0, value: 0 });
      return reps.get(name)!;
    };

    const hygiene: string[] = [];
    for (const d of createdDeals) {
      const p = d.properties || {};
      const rep = repOf(d);
      if (!rep) {
        if (String(p.dealtype || "") === "newbusiness") {
          hygiene.push(
            `${p.dealname || d.id} — stage: ${stageLabel(p.dealstage)}, created ${prettifyOrDash(p.createdate)}`,
          );
        }
        continue;
      }
      const a = get(rep);
      a.created++;
      a.value += num(p.amount);
      const st = String(p.dealstage || "");
      if (convertedIds.has(st)) a.clients++;
      else if (lostIds.has(st)) a.lost++;
      else a.open++;
    }
    // Conversions this week carrying no rep are an attribution gap worth flagging.
    for (const d of convertedThisWeek) {
      if (!repOf(d) && String(d.properties?.dealtype || "") === "newbusiness") {
        const p = d.properties || {};
        const line =
          `${p.dealname || d.id} — CONVERTED this week, no sales rep (created ${prettifyOrDash(p.createdate)})`;
        if (!hygiene.some((h) => h.startsWith(String(p.dealname || d.id)))) hygiene.push(line);
      }
    }

    const repOrder = [...reps.entries()]
      .sort((a, b) => b[1].created - a[1].created || a[0].localeCompare(b[0]));
    const tot = { created: 0, clients: 0, open: 0, lost: 0, value: 0 };
    for (const [, a] of repOrder) {
      tot.created += a.created;
      tot.clients += a.clients;
      tot.open += a.open;
      tot.lost += a.lost;
      tot.value += a.value;
    }
    const rate = (c: number, n: number) => n ? Math.round((c / n) * 100) + "%" : "-";
    const summaryRows = repOrder.map(([name, a]) => [
      name, String(a.created), String(a.clients), String(a.open), String(a.lost),
      rate(a.clients, a.created), eur(a.value),
    ]);
    if (summaryRows.length) {
      summaryRows.push([
        "TOTAL", String(tot.created), String(tot.clients), String(tot.open), String(tot.lost),
        rate(tot.clients, tot.created), eur(tot.value),
      ]);
    }

    const convRep = convertedThisWeek.filter((d) => repOf(d));
    const convRows = convRep.map((d, i) => {
      const p = d.properties || {};
      return [
        String(i + 1), raw(p.dealname), repOf(d), prettifyOrDash(p.createdate),
        p.amount ? eur(num(p.amount)) : "-",
      ];
    });
    const convValue = convRep.reduce((s, d) => s + num(d.properties?.amount), 0);

    const lostRep = lostThisWeek.filter((d) => repOf(d));
    const reachedQuote = (d: any) => {
      const p = d.properties || {};
      return reachedProps.some((k) => {
        const v = p[k];
        return v != null && String(v).trim() !== "";
      });
    };
    const splitOk = !!quoteSentId;
    const lostBefore = splitOk ? lostRep.filter((d) => !reachedQuote(d)) : lostRep;
    const lostAfter = splitOk ? lostRep.filter((d) => reachedQuote(d)) : [];
    const lostRowsOf = (list: any[]) =>
      list.map((d, i) => {
        const p = d.properties || {};
        return [String(i + 1), raw(p.dealname), repOf(d), raw(p.closed_lost_reason)];
      });
    const beforeRows = lostRowsOf(lostBefore);
    const afterRows = lostRowsOf(lostAfter);

    const prettyRange = `${prettifyOrDash(startLabel)} – ${prettifyOrDash(endLabel)}`;

    stage = "build pdf";
    const sections: Section[] = [
      {
        title: `Per sales rep — deals created this week`,
        note: `Deals created ${prettyRange}${partial ? " (week in progress)" : ""}. Clients = reached Converted/Completed. Value = sum of deal amounts.`,
        cols: [
          { t: "Sales rep", w: 135 }, { t: "Created", w: 50 }, { t: "Clients", w: 48 },
          { t: "In prog.", w: 52 }, { t: "Diseng.", w: 52 }, { t: "Conv. %", w: 52 },
          { t: "Value €", w: 75 },
        ],
        rows: summaryRows,
        redCol: 4,
      },
      {
        title: "Converted this week",
        note: `Deals that entered the Converted stage ${prettyRange}, whatever week they were created. Total value ${eur(convValue)}.`,
        cols: [
          { t: "#", w: 24 }, { t: "Deal", w: 200 }, { t: "Sales rep", w: 110 },
          { t: "Created", w: 66 }, { t: "Amount", w: 64 },
        ],
        rows: convRows,
      },
      ...(splitOk
        ? [
          {
            title: "Disengaged this week — before the lawyer meeting",
            note: `Deals that entered Disengaged ${prettyRange} without reaching Quote sent — dropped before the meeting with the lawyer. Reason as recorded on the deal.`,
            cols: [
              { t: "#", w: 24 }, { t: "Deal", w: 170 }, { t: "Sales rep", w: 105 },
              { t: "Reason", w: 165 },
            ],
            rows: beforeRows,
          },
          {
            title: "Disengaged this week — after the lawyer meeting",
            note: `Deals that reached Quote sent or later (the lawyer meeting happened) then entered Disengaged ${prettyRange}. Reason as recorded on the deal.`,
            cols: [
              { t: "#", w: 24 }, { t: "Deal", w: 170 }, { t: "Sales rep", w: 105 },
              { t: "Reason", w: 165 },
            ],
            rows: afterRows,
          },
        ]
        : [
          {
            title: "Disengaged this week",
            note: `Deals that entered Disengaged ${prettyRange}, with the reason recorded on the deal. (Quote sent stage not found — not split.)`,
            cols: [
              { t: "#", w: 24 }, { t: "Deal", w: 170 }, { t: "Sales rep", w: 105 },
              { t: "Reason", w: 165 },
            ],
            rows: beforeRows,
          },
        ]),
    ];
    if (hygiene.length) {
      sections.push({
        title: "Missing sales rep — check attribution",
        note: "New-business deals in this week's data with no sales rep recorded.",
        cols: [],
        rows: [],
        lines: hygiene.map((h, i) => `${i + 1}. ${h}`),
      });
    }

    const pdfB64 = await buildPdf(
      "Sales Deals — Weekly Report",
      `${pipeInfo.label || "Sales Pipeline"} — week ${prettyRange}`,
      sections,
    );
    const pdfName = `PLF-Sales-Deals-${now.date}.pdf`;

    stage = "resolve recipients";
    const recipients = overrideTo ?? splitRecipients(settings.sales_deals_report_recipient);
    if (!recipients.length) {
      await logError(ERROR_KIND, now.date, "no sales_deals_report_recipient configured");
      return new Response(JSON.stringify({ skipped: true, reason: "no recipient" }), { status: 200 });
    }

    const td = "padding:6px 10px;border:1px solid #E2DDD9;font-size:13px";
    const th = "padding:7px 10px;background:#4F75FF;color:#ffffff;text-align:left;font-size:12px";
    const tableHtml = summaryRows.length
      ? `<table style="border-collapse:collapse;margin:14px 0">
      <tr><th style="${th}">Sales rep</th><th style="${th}">Created</th><th style="${th}">Clients</th><th style="${th}">In progress</th><th style="${th}">Disengaged</th><th style="${th}">Conv. %</th><th style="${th}">Value</th></tr>
      ${
        summaryRows.map((r) =>
          `<tr${r[0] === "TOTAL" ? ' style="background:#EEF2FF;font-weight:bold"' : ""}><td style="${td}">${r[0]}</td><td style="${td};text-align:center">${r[1]}</td><td style="${td};text-align:center">${r[2]}</td><td style="${td};text-align:center">${r[3]}</td><td style="${td};text-align:center">${r[4]}</td><td style="${td};text-align:center">${r[5]}</td><td style="${td};text-align:right">${r[6]}</td></tr>`
        ).join("")
      }
    </table>`
      : `<p style="margin:0 0 14px">No rep-created deals this week.</p>`;

    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 6px">Please find below the weekly Sales deals report for <b>${prettyRange}</b>${partial ? " (week in progress)" : ""}: ${tot.created} deal${tot.created === 1 ? "" : "s"} created by the sales team, ${convRep.length} conversion${convRep.length === 1 ? "" : "s"} this week (${eur(convValue)}), ${lostRep.length} disengaged.</p>
    ${tableHtml}
    <p style="margin:0 0 24px">The attached PDF adds this week's conversions and the disengaged leads with reasons, split into those that dropped before the lawyer meeting (Quote sent) and those that disengaged after it${hygiene.length ? ", plus " + hygiene.length + " deal" + (hygiene.length === 1 ? "" : "s") + " missing a sales rep" : ""}.</p>
    ${settings.email_signature || ""}
  </div>
</body></html>`;

    stage = "send";
    const subject = (preview ? "[PREVIEW] " : "") +
      `Sales Deals Report — week ${prettyRange} (${tot.created} created, ${convRep.length} converted)`;
    const r = await sendEmail(settings, recipients, subject, html, { pdfB64, pdfName });
    if (!preview) {
      if (r.ok) await markSent(KIND, now.date, r.detail ?? "sent");
      else await logError(ERROR_KIND, now.date, "send failed: " + r.detail);
    }

    return new Response(
      JSON.stringify({
        ok: r.ok,
        preview,
        partial,
        window: { start: startLabel, end: endLabel },
        created: tot.created,
        converted: convRep.length,
        disengaged: lostRep.length,
        hygiene: hygiene.length,
        reps: repOrder.map(([n, a]) => ({ rep: n, ...a })),
        to: recipients,
        detail: r.detail,
        generated: prettyDate(now.date),
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
