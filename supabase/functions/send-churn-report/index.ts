// MONTHLY CLIENT CHURN — nominee services (Annual Corporate Services pipeline).
//
// Churn is a nominee service ticket entering the "Disengaged" stage during the
// month. The headline counts CLIENTS, not tickets: one client leaving routinely
// closes several services at once, so a ticket count overstates churn badly.
//
// Money comes from the deal each nominee ticket is associated with. Several
// tickets commonly share ONE deal — the three nominee tickets for a single
// company all point at the same package deal — so revenue is summed over
// DISTINCT deals. Summing per ticket would multiply the fee by the number of
// services and inflate the figure severalfold.
//
// The Accounting pipeline is deliberately out of scope: those tickets are being
// corrected by hand and are not yet trustworthy. Add it back by restoring an
// ACCOUNTING entry to PIPELINES once the data is clean.
//
// Each run writes a row to churn_monthly. The yearly report adds those rows up
// rather than re-querying HubSpot, so an annual figure can never contradict the
// monthly reports already sent.
//
// Schedule: churn_report_day (day of month, default 1) at churn_report_hour
// (default 9), Cyprus time, reporting the month just ended.
// force:true bypasses the window; force + month:'2026-08' reports a chosen
// month; force + to:'...' makes it a preview (no send_log row, no archive).
import { supabase } from "../_shared/client.ts";
import { cyprusMidnightUTC, cyprusNow } from "../_shared/time.ts";
import { getSettings, splitRecipients, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, logError, markSent } from "../_shared/schedule.ts";
import { hsAssociations, hsBatchRead, hsSearch } from "../_shared/hubspot.ts";
import { COLORS, createDoc, drawFooterAllPages, drawLetterhead, HEX, wrap } from "../_shared/pdf.ts";

const KIND = "churn_report";
const ERROR_KIND = "churn_report_error";
const { BLUE, SOFT, GREY } = HEX;

const NOMINEE = { pipeline: "0", disengaged: "1311365244", label: "Nominee services" };

const W = 595, H = 842, M = 44, BOTTOM = 56;

// Client reference as used by the firm: six digits beginning 1 or 3.
const REF = /\b([13]\d{5})\b/;

function clientKey(subject: string): { key: string; ref: string | null } {
  const s = String(subject || "");
  const m = s.match(REF);
  if (m) return { key: m[1], ref: m[1] };
  const name = s.split(/\s+-\s+|\s-\s/)[0].trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return { key: name ? "N:" + name : "N:UNKNOWN", ref: null };
}

function clientLabel(subjects: string[]): string {
  const s = subjects.slice().sort((a, b) => b.length - a.length)[0] || "";
  return s.replace(/\s+-\s+$/, "").trim();
}

function serviceName(subject: string): string {
  const parts = String(subject || "").split(/\s+-\s+|\s-\s/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(subject || "");
}

const money = (n: number) => "€" + Math.round(n).toLocaleString("en-GB");

type Row = { id: string; subject: string; entered: string };

async function fetchDisengaged(token: string, startMs: number, endMs: number): Promise<Row[]> {
  const prop = `hs_v2_date_entered_${NOMINEE.disengaged}`;
  const res = await hsSearch(token, "tickets", {
    filterGroups: [{
      filters: [
        { propertyName: "hs_pipeline", operator: "EQ", value: NOMINEE.pipeline },
        { propertyName: prop, operator: "GTE", value: String(startMs) },
        { propertyName: prop, operator: "LT", value: String(endMs) },
      ],
    }],
    sorts: [{ propertyName: prop, direction: "ASCENDING" }],
    properties: ["subject", prop],
    limit: 100,
  });
  return res.map((t: any) => ({
    id: String(t.id),
    subject: String(t.properties?.subject || t.id),
    entered: String(t.properties?.[prop] || ""),
  }));
}

async function activeClients(token: string): Promise<number> {
  const res = await hsSearch(token, "tickets", {
    filterGroups: [{
      filters: [
        { propertyName: "hs_pipeline", operator: "EQ", value: NOMINEE.pipeline },
        { propertyName: "hs_pipeline_stage", operator: "NEQ", value: NOMINEE.disengaged },
      ],
    }],
    properties: ["subject"],
    limit: 100,
  }, 25);
  const keys = new Set<string>();
  for (const t of res) keys.add(clientKey(String(t.properties?.subject || "")).key);
  return keys.size;
}

type Client = {
  key: string;
  ref: string | null;
  label: string;
  services: { name: string; entered: string; ticketId: string }[];
  dealIds: Set<string>;
  amount: number;
};

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

    // ---- Which month? Scheduled runs report the month just ended. ----
    let year: number, month: number;
    if (typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)) {
      year = parseInt(body.month.slice(0, 4), 10);
      month = parseInt(body.month.slice(5, 7), 10);
    } else {
      const [y, m] = now.date.split("-").map((x) => parseInt(x, 10));
      year = m === 1 ? y - 1 : y;
      month = m === 1 ? 12 : m - 1;
    }
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const nextY = month === 12 ? year + 1 : year;
    const nextM = month === 12 ? 1 : month + 1;
    const startMs = cyprusMidnightUTC(first);
    const endMs = cyprusMidnightUTC(`${nextY}-${String(nextM).padStart(2, "0")}-01`);
    const partial = Date.now() < endMs;
    const monthLabel = new Date(first + "T00:00:00Z")
      .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    runDate = first;

    const schedDay = parseInt(settings.churn_report_day ?? "1", 10);
    const schedHour = parseInt(settings.churn_report_hour ?? "9", 10);
    if (!force && !(now.day === schedDay && now.hour >= schedHour)) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "outside schedule window", now, schedDay, schedHour }),
        { status: 200 },
      );
    }
    if (!force && await alreadyLogged(KIND, first)) {
      return new Response(JSON.stringify({ skipped: true, reason: "already sent" }), { status: 200 });
    }

    stage = "hubspot token";
    const token = settings.hubspot_token;
    if (!token) {
      await logError(ERROR_KIND, first, "hubspot_token not set in portal_settings");
      return new Response(JSON.stringify({ skipped: true, reason: "hubspot_token not set" }), { status: 200 });
    }

    stage = "fetch disengaged";
    const rows = await fetchDisengaged(token, startMs, endMs);

    stage = "group clients";
    const clientMap = new Map<string, Client>();
    for (const r of rows) {
      const { key, ref } = clientKey(r.subject);
      if (!clientMap.has(key)) {
        clientMap.set(key, { key, ref, label: "", services: [], dealIds: new Set(), amount: 0 });
      }
      const c = clientMap.get(key)!;
      c.services.push({ name: serviceName(r.subject), entered: r.entered, ticketId: r.id });
      c.label = clientLabel([c.label, r.subject].filter(Boolean));
    }

    stage = "associated deals";
    // Each ticket links to the deal carrying the fee. Multiple tickets share one
    // deal, so deduplicate before summing anything.
    const assoc = await hsAssociations(token, "tickets", "deals", rows.map((r) => r.id));
    for (const c of clientMap.values()) {
      for (const s of c.services) {
        for (const dealId of (assoc.get(s.ticketId) || [])) c.dealIds.add(dealId);
      }
    }
    const allDealIds = [...new Set([...clientMap.values()].flatMap((c) => [...c.dealIds]))];

    stage = "deal amounts";
    const deals = allDealIds.length
      ? await hsBatchRead(token, "deals", allDealIds, ["dealname", "amount", "deal_currency_code"])
      : [];
    const amountById = new Map<string, number>();
    const currencies = new Set<string>();
    let dealsWithoutAmount = 0;
    for (const d of deals) {
      const raw = d?.properties?.amount;
      const v = raw == null || raw === "" ? NaN : parseFloat(String(raw));
      if (isNaN(v)) dealsWithoutAmount++;
      else amountById.set(String(d.id), v);
      const ccy = d?.properties?.deal_currency_code;
      if (ccy) currencies.add(String(ccy));
    }
    for (const c of clientMap.values()) {
      c.amount = [...c.dealIds].reduce((s, id) => s + (amountById.get(id) ?? 0), 0);
    }
    const revenueLost = [...new Set(allDealIds)]
      .reduce((s, id) => s + (amountById.get(id) ?? 0), 0);

    const clients = [...clientMap.values()].sort((a, b) => b.amount - a.amount);
    const noRefCount = rows.filter((r) => !clientKey(r.subject).ref).length;
    const ticketsWithoutDeal = rows.filter((r) => (assoc.get(r.id) || []).length === 0).length;

    stage = "active clients";
    const activeNow = await activeClients(token);
    const activeStart = activeNow + clients.length;
    const rate = activeStart > 0 ? (clients.length / activeStart) * 100 : null;

    stage = "build pdf";
    const d = await createDoc();
    const { font, bold, clean } = d;
    let page = d.doc.addPage([W, H]);
    drawLetterhead(page, d, {
      W, H, M,
      title: "Monthly Client Churn",
      subtitle: `${monthLabel} — Nominee services`,
      bandHeight: 84,
    });
    let y = H - 108;
    const newPage = () => { page = d.doc.addPage([W, H]); y = H - 56; };
    const need = (h: number) => { if (y - h < BOTTOM) newPage(); };
    const para = (t: string, size: number, f: any, color: any, indent = 0) => {
      for (const line of wrap(clean(t), W - M * 2 - indent + 8, size, f)) {
        need(size * 1.45);
        page.drawText(line, { x: M + indent, y, size, font: f, color });
        y -= size * 1.45;
      }
    };
    const heading = (t: string) => {
      need(34); y -= 10;
      para(t, 12, bold, COLORS.navy);
      page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 1, color: COLORS.blue });
      y -= 8;
    };
    const table = (cols: { t: string; w: number }[], data: string[][], rightCols: number[] = []) => {
      const TW = cols.reduce((s, c) => s + c.w, 0);
      const header = () => {
        need(24);
        let x = M;
        page.drawRectangle({ x: M, y: y - 4, width: TW, height: 17, color: COLORS.blue });
        for (const c of cols) {
          page.drawText(clean(c.t), { x: x + 4, y, size: 8, font: bold, color: COLORS.white });
          x += c.w;
        }
        y -= 19;
      };
      header();
      let ri = 0;
      for (const r of data) {
        const vals = cols.map((_, i) => clean(String(r[i] ?? "")));
        const cl = vals.map((v, i) => wrap(v, cols[i].w, 8.5, i === 0 ? bold : font));
        const rowH = Math.max(...cl.map((l) => l.length)) * 11 + 7;
        if (y - rowH < BOTTOM) { newPage(); header(); }
        const isTotal = vals[0] === "TOTAL";
        if (isTotal) page.drawRectangle({ x: M, y: y - rowH + 12, width: TW, height: rowH, color: COLORS.totalRow });
        else if (ri % 2 === 1) page.drawRectangle({ x: M, y: y - rowH + 12, width: TW, height: rowH, color: COLORS.soft });
        let x = M;
        vals.forEach((_, i) => {
          cl[i].forEach((line, li) => {
            const w = font.widthOfTextAtSize(line, 8.5);
            const xx = rightCols.includes(i) ? x + cols[i].w - 6 - w : x + 4;
            page.drawText(line, {
              x: xx, y: y - li * 11, size: 8.5,
              font: (i === 0 || isTotal) ? bold : font, color: COLORS.black,
            });
          });
          x += cols[i].w;
        });
        page.drawLine({ start: { x: M, y: y - rowH + 10 }, end: { x: M + TW, y: y - rowH + 10 }, thickness: 0.5, color: COLORS.grey });
        y -= rowH;
        ri++;
      }
      y -= 12;
    };

    heading("Headline");
    table([{ t: "", w: 300 }, { t: "", w: 200 }], [
      ["Clients lost", String(clients.length)],
      ["Annual fees lost", money(revenueLost)],
      ["Services closed", String(rows.length)],
      ["Churn rate (clients)", rate == null ? "—" : rate.toFixed(2) + "%"],
      ["Clients active at start of month", String(activeStart)],
    ]);
    para(
      "Clients and fees are the figures to quote. One client leaving usually closes several services billed under a single deal, so the service count is always higher and must not be multiplied by the fee.",
      8.5, font, COLORS.note,
    );
    y -= 6;

    heading("Clients lost this month");
    if (!clients.length) {
      para("No clients disengaged during the month.", 10, font, COLORS.black);
    } else {
      table(
        [{ t: "Ref", w: 46 }, { t: "Client", w: 190 }, { t: "Services closed", w: 145 }, { t: "Date", w: 52 }, { t: "Annual fee", w: 74 }],
        clients.map((c) => [
          c.ref || "—",
          c.label,
          c.services.map((s) => s.name).join(", "),
          c.services[0]?.entered ? String(c.services[0].entered).slice(0, 10).split("-").reverse().join("/") : "—",
          c.amount ? money(c.amount) : "—",
        ]).concat([["TOTAL", "", String(rows.length) + " services", "", money(revenueLost)]]),
        [4],
      );
    }

    heading("Notes");
    const notes = [
      `Churn is a nominee service entering the Disengaged stage during ${monthLabel}.`,
      "Fees come from the deal each ticket is associated with. Where several services share one deal, that deal is counted once — so the fee total reflects what the client actually paid, not the number of tickets closed.",
      "The Accounting pipeline is excluded for now while its tickets are being corrected. It can be added back once the data is reliable.",
      "The churn rate uses clients holding at least one live nominee service at the start of the month as its denominator.",
    ];
    if (ticketsWithoutDeal > 0) {
      notes.push(`${ticketsWithoutDeal} ticket(s) had no associated deal, so no fee could be attributed to them. The fee total is therefore a floor, not an exact figure.`);
    }
    if (dealsWithoutAmount > 0) {
      notes.push(`${dealsWithoutAmount} associated deal(s) carried no amount and contributed nothing to the total.`);
    }
    if (noRefCount > 0) {
      notes.push(`${noRefCount} ticket(s) carried no client reference and were grouped by company name, which is less reliable.`);
    }
    if (currencies.size > 1) {
      notes.push(`Deals were found in more than one currency (${[...currencies].join(", ")}); amounts have been added without conversion.`);
    }
    if (partial) {
      notes.push("This month is not yet complete — the figures are provisional and will be restated on the scheduled run.");
    }
    notes.forEach((n, i) => {
      need(14);
      page.drawText(`${i + 1}.`, { x: M, y, size: 9, font: bold, color: COLORS.blue });
      para(n, 9, font, COLORS.black, 18);
      y -= 3;
    });

    drawFooterAllPages(d, M);
    const pdfB64 = await d.doc.saveAsBase64();
    const pdfName = `Churn ${year}-${String(month).padStart(2, "0")}.pdf`;

    stage = "store";
    if (!preview) {
      await supabase.from("churn_monthly").upsert({
        period: first,
        corporate_services: rows.length,
        corporate_clients: clients.length,
        accounting_services: 0,
        accounting_clients: 0,
        total_services: rows.length,
        total_clients: clients.length,
        dormant_services: 0,
        active_clients_start: activeStart,
        churn_rate: rate == null ? null : Number(rate.toFixed(3)),
        revenue_lost: Number(revenueLost.toFixed(2)),
        revenue_basis: "Sum of associated nominee deal amounts, deduplicated by deal. Accounting pipeline excluded.",
        detail: {
          scope: "nominee",
          clients: clients.map((c) => ({
            ref: c.ref,
            label: c.label,
            amount: c.amount,
            deals: [...c.dealIds],
            services: c.services,
          })),
          tickets_without_deal: ticketsWithoutDeal,
          deals_without_amount: dealsWithoutAmount,
          currencies: [...currencies],
        },
        computed_at: new Date().toISOString(),
        reported_at: new Date().toISOString(),
      }, { onConflict: "period" });

      try {
        const bytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
        await supabase.storage.from("department-reports")
          .upload(`corporate/${pdfName}`, bytes, { contentType: "application/pdf", upsert: true });
      } catch (e) {
        await logError(ERROR_KIND, first, "archive failed: " + String(e));
      }
    }

    stage = "resolve recipients";
    const recipients = overrideTo ?? splitRecipients(settings.churn_report_recipient);
    if (!recipients.length) {
      await logError(ERROR_KIND, first, "no churn_report_recipient configured");
      return new Response(JSON.stringify({ skipped: true, reason: "no recipient" }), { status: 200 });
    }

    const th = `padding:7px 10px;background:${BLUE};color:#ffffff;text-align:left;font-size:12px`;
    const td = `padding:6px 10px;border:1px solid ${GREY};font-size:13px`;
    const topRows = clients.slice(0, 5).map((c) =>
      `<tr><td style="${td}">${c.ref || "—"} ${c.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td><td style="${td};text-align:right">${c.amount ? money(c.amount) : "—"}</td></tr>`
    ).join("");
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 6px">Nominee client churn for <b>${monthLabel}</b>${partial ? " (month not yet complete — provisional)" : ""}:</p>
    <table style="border-collapse:collapse;margin:14px 0">
      <tr><th style="${th}">Measure</th><th style="${th}">Value</th></tr>
      <tr style="background:${SOFT};font-weight:bold"><td style="${td}">Clients lost</td><td style="${td}">${clients.length}</td></tr>
      <tr style="background:${SOFT};font-weight:bold"><td style="${td}">Annual fees lost</td><td style="${td}">${money(revenueLost)}</td></tr>
      <tr><td style="${td}">Services closed</td><td style="${td}">${rows.length}</td></tr>
      <tr><td style="${td}">Churn rate (clients)</td><td style="${td}">${rate == null ? "—" : rate.toFixed(2) + "%"}</td></tr>
      <tr><td style="${td}">Clients active at start of month</td><td style="${td}">${activeStart}</td></tr>
    </table>
    ${clients.length ? `<p style="margin:14px 0 6px"><b>Largest losses</b></p><table style="border-collapse:collapse;margin:0 0 14px">${topRows}</table>` : ""}
    <p style="margin:0 0 6px">The attached PDF lists every client lost, the services closed and the annual fee.</p>
    <p style="margin:0 0 24px;font-size:12px;color:#666">Fees come from the deal each ticket is associated with; where several services share one deal it is counted once, so the total reflects what the client actually paid. Accounting is excluded while those tickets are being corrected.</p>
    ${settings.email_signature || ""}
  </div>
</body></html>`;

    stage = "send";
    const subject = (preview ? "[PREVIEW] " : "") +
      `Monthly Client Churn — ${monthLabel} (${clients.length} client${clients.length === 1 ? "" : "s"}, ${money(revenueLost)})`;
    const r = await sendEmail(settings, recipients, subject, html, { pdfB64, pdfName });
    if (!preview) {
      if (r.ok) await markSent(KIND, first, r.detail ?? "sent");
      else await logError(ERROR_KIND, first, "send failed: " + r.detail);
    }

    return new Response(
      JSON.stringify({
        ok: r.ok, preview, partial, month: first, monthLabel,
        clients: clients.length, services: rows.length,
        revenueLost, deals: allDealIds.length,
        activeStart, rate,
        ticketsWithoutDeal, dealsWithoutAmount, noRefCount,
        currencies: [...currencies],
        to: recipients, detail: r.detail,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    await logError(ERROR_KIND, runDate || new Date().toISOString().slice(0, 10), `crashed at ${stage}: ${String(e)}`);
    return new Response(JSON.stringify({ error: String(e), stage }), { status: 500 });
  }
});
