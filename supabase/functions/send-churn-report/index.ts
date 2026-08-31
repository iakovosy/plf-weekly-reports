// MONTHLY CLIENT CHURN — Annual Corporate Services + Accounting.
//
// Churn is a ticket entering the "Disengaged" stage of either pipeline during
// the month. The headline is CLIENTS, not tickets: one client leaving commonly
// closes several services at once (three nominee tickets for one company is
// routine), so counting tickets overstates churn badly.
//
// "Dormant" in the Accounting pipeline is NOT churn — the firm's ruling. It is
// carried on the report as a separate line for visibility only.
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
import { cyprusMidnightUTC, cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, splitRecipients, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, logError, markSent } from "../_shared/schedule.ts";
import { hsSearch } from "../_shared/hubspot.ts";
import {
  COLORS,
  createDoc,
  drawFooterAllPages,
  drawLetterhead,
  esc,
  HEX,
  raw,
  wrap,
} from "../_shared/pdf.ts";

const KIND = "churn_report";
const ERROR_KIND = "churn_report_error";
const { BLUE, SOFT, GREY } = HEX;

const CORPORATE = { pipeline: "0", disengaged: "1311365244", label: "Annual Corporate Services" };
const ACCOUNTING = { pipeline: "655847443", disengaged: "965225025", label: "Accounting" };
const DORMANT_STAGE = "1281528096"; // Accounting only; not churn.

const W = 595, H = 842, M = 44, BOTTOM = 56;

// Client reference as used by the firm: a six-digit number beginning 1 or 3
// (300461, 301059, 100456, 102266). Tickets carry it in the subject.
const REF = /\b([13]\d{5})\b/;

/** Group key for a ticket. Reference where present, else a normalised name. */
function clientKey(subject: string): { key: string; ref: string | null } {
  const s = String(subject || "");
  const m = s.match(REF);
  if (m) return { key: m[1], ref: m[1] };
  // No reference on the ticket — fall back to the leading name.
  const name = s.split(/\s+-\s+|\s-\s/)[0].trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return { key: name ? "N:" + name : "N:UNKNOWN", ref: null };
}

/** A readable label for a client group, preferring the longest subject seen. */
function clientLabel(subjects: string[]): string {
  const s = subjects.slice().sort((a, b) => b.length - a.length)[0] || "";
  // Trim the trailing " - <service>" noise where obvious.
  return s.replace(/\s+-\s+$/, "").trim();
}

/** Service name = the tail of the subject, which is how the firm names them. */
function serviceName(subject: string): string {
  const parts = String(subject || "").split(/\s+-\s+|\s-\s/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(subject || "");
}

type Row = { id: string; subject: string; entered: string; endDate: string | null };

async function fetchDisengaged(
  token: string,
  cfg: { pipeline: string; disengaged: string },
  startMs: number,
  endMs: number,
): Promise<Row[]> {
  const prop = `hs_v2_date_entered_${cfg.disengaged}`;
  const res = await hsSearch(token, "tickets", {
    filterGroups: [{
      filters: [
        { propertyName: "hs_pipeline", operator: "EQ", value: cfg.pipeline },
        { propertyName: prop, operator: "GTE", value: String(startMs) },
        { propertyName: prop, operator: "LT", value: String(endMs) },
      ],
    }],
    sorts: [{ propertyName: prop, direction: "ASCENDING" }],
    properties: ["subject", prop, "subscription_end_date", "hs_pipeline_stage"],
    limit: 100,
  });
  return res.map((t: any) => ({
    id: String(t.id),
    subject: String(t.properties?.subject || t.id),
    entered: String(t.properties?.[prop] || ""),
    endDate: t.properties?.subscription_end_date || null,
  }));
}

/** Distinct clients currently holding at least one non-disengaged service. */
async function activeClients(token: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const cfg of [CORPORATE, ACCOUNTING]) {
    const res = await hsSearch(token, "tickets", {
      filterGroups: [{
        filters: [
          { propertyName: "hs_pipeline", operator: "EQ", value: cfg.pipeline },
          { propertyName: "hs_pipeline_stage", operator: "NEQ", value: cfg.disengaged },
        ],
      }],
      properties: ["subject"],
      limit: 100,
    }, 25);
    for (const t of res) keys.add(clientKey(String(t.properties?.subject || "")).key);
  }
  return keys;
}

async function countDormant(token: string): Promise<number> {
  const res = await hsSearch(token, "tickets", {
    filterGroups: [{
      filters: [
        { propertyName: "hs_pipeline", operator: "EQ", value: ACCOUNTING.pipeline },
        { propertyName: "hs_pipeline_stage", operator: "EQ", value: DORMANT_STAGE },
      ],
    }],
    properties: ["subject"],
    limit: 100,
  }, 5);
  return res.length;
}

type Client = {
  key: string;
  ref: string | null;
  label: string;
  services: { name: string; pipeline: string; entered: string }[];
};

function groupClients(corporate: Row[], accounting: Row[]): Map<string, Client> {
  const map = new Map<string, Client>();
  const add = (rows: Row[], pipelineLabel: string) => {
    for (const r of rows) {
      const { key, ref } = clientKey(r.subject);
      if (!map.has(key)) map.set(key, { key, ref, label: "", services: [] });
      const c = map.get(key)!;
      c.services.push({ name: serviceName(r.subject), pipeline: pipelineLabel, entered: r.entered });
      c.label = clientLabel([c.label, r.subject].filter(Boolean));
    }
  };
  add(corporate, CORPORATE.label);
  add(accounting, ACCOUNTING.label);
  return map;
}

async function buildPdf(o: {
  monthLabel: string;
  clients: Client[];
  corpServices: number;
  corpClients: number;
  accServices: number;
  accClients: number;
  activeStart: number | null;
  rate: number | null;
  dormant: number;
  noRefCount: number;
  partial: boolean;
}): Promise<string> {
  const d = await createDoc();
  const { font, bold, clean } = d;

  let page = d.doc.addPage([W, H]);
  drawLetterhead(page, d, {
    W, H, M,
    title: "Monthly Client Churn",
    subtitle: `${o.monthLabel} — Annual Corporate Services and Accounting`,
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
  const table = (cols: { t: string; w: number }[], rows: string[][], redCol = -1) => {
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
    for (const r of rows) {
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
          page.drawText(line, {
            x: x + 4, y: y - li * 11, size: 8.5,
            font: (i === 0 || isTotal) ? bold : font,
            color: (i === redCol && !isTotal && line !== "0") ? COLORS.red : COLORS.black,
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
  table(
    [{ t: "", w: 300 }, { t: "", w: 200 }],
    [
      ["Clients lost", String(o.clients.length)],
      ["Services closed", String(o.corpServices + o.accServices)],
      ["Churn rate (clients)", o.rate == null ? "—" : o.rate.toFixed(2) + "%"],
      ["Clients active at start of month", o.activeStart == null ? "—" : String(o.activeStart)],
    ],
  );
  para(
    "Clients is the figure to quote. A single client leaving usually closes several services at once, so the service count is always the larger number.",
    8.5, font, COLORS.note,
  );
  y -= 6;

  heading("By pipeline");
  table(
    [{ t: "Pipeline", w: 260 }, { t: "Services closed", w: 110 }, { t: "Clients", w: 90 }],
    [
      ["Annual Corporate Services", String(o.corpServices), String(o.corpClients)],
      ["Accounting", String(o.accServices), String(o.accClients)],
      ["TOTAL", String(o.corpServices + o.accServices), String(o.clients.length)],
    ],
  );
  para(
    "The total client count is deduplicated: a client leaving both pipelines is counted once, so the two rows above can add to more than the total.",
    8.5, font, COLORS.note,
  );
  y -= 6;

  heading("Clients lost this month");
  if (!o.clients.length) {
    para("No clients disengaged during the month.", 10, font, COLORS.black);
  } else {
    table(
      [{ t: "Ref", w: 50 }, { t: "Client", w: 210 }, { t: "Services closed", w: 150 }, { t: "Date", w: 60 }],
      o.clients.map((c) => [
        c.ref || "—",
        c.label,
        c.services.map((s) => s.name).join(", "),
        c.services[0]?.entered ? String(c.services[0].entered).slice(0, 10).split("-").reverse().join("/") : "—",
      ]),
    );
  }

  heading("Notes");
  const notes = [
    `Churn is a service entering the Disengaged stage of either pipeline during ${o.monthLabel}.`,
    `Dormant accounting files are NOT counted as churn, per the firm's definition. There are currently ${o.dormant} in that stage.`,
    "Revenue lost is not shown: HubSpot carries no fee on these tickets. It can be added once standard annual fees per service are supplied.",
    "The churn rate uses clients holding at least one live service at the start of the month as its denominator.",
  ];
  if (o.noRefCount > 0) {
    notes.push(`${o.noRefCount} ticket(s) carried no client reference in the subject and were grouped by company name, which is less reliable.`);
  }
  if (o.partial) {
    notes.push("This month is not yet complete — the figures are provisional and will be restated on the scheduled run.");
  }
  notes.forEach((n, i) => {
    need(14);
    page.drawText(`${i + 1}.`, { x: M, y, size: 9, font: bold, color: COLORS.blue });
    para(n, 9, font, COLORS.black, 18);
    y -= 3;
  });

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

    // ---- Which month? ----
    // Scheduled runs report the month just ended. A forced run can name one.
    let year: number, month: number; // month is 1-12
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
    const nextFirst = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
    const startMs = cyprusMidnightUTC(first);
    const endMs = cyprusMidnightUTC(nextFirst);
    const partial = Date.now() < endMs;
    const monthLabel = new Date(first + "T00:00:00Z")
      .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    runDate = first;

    // ---- Schedule window (monthly, not weekly) ----
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
    const [corpRows, accRows] = await Promise.all([
      fetchDisengaged(token, CORPORATE, startMs, endMs),
      fetchDisengaged(token, ACCOUNTING, startMs, endMs),
    ]);

    stage = "group";
    const clientMap = groupClients(corpRows, accRows);
    const clients = [...clientMap.values()].sort((a, b) =>
      (a.ref || "zz").localeCompare(b.ref || "zz")
    );
    const corpClientCount = new Set(corpRows.map((r) => clientKey(r.subject).key)).size;
    const accClientCount = new Set(accRows.map((r) => clientKey(r.subject).key)).size;
    const noRefCount = [...corpRows, ...accRows].filter((r) => !clientKey(r.subject).ref).length;

    stage = "active clients";
    const active = await activeClients(token);
    const activeAtEnd = active.size;
    // Clients that left during the month are no longer in the active set, so the
    // start-of-month population is the current one plus those lost.
    const activeStart = activeAtEnd + clients.length;
    const rate = activeStart > 0 ? (clients.length / activeStart) * 100 : null;

    stage = "dormant";
    const dormant = await countDormant(token);

    stage = "build pdf";
    const pdfB64 = await buildPdf({
      monthLabel,
      clients,
      corpServices: corpRows.length,
      corpClients: corpClientCount,
      accServices: accRows.length,
      accClients: accClientCount,
      activeStart,
      rate,
      dormant,
      noRefCount,
      partial,
    });
    const pdfName = `Churn ${year}-${String(month).padStart(2, "0")}.pdf`;

    stage = "store";
    if (!preview) {
      await supabase.from("churn_monthly").upsert({
        period: first,
        corporate_services: corpRows.length,
        corporate_clients: corpClientCount,
        accounting_services: accRows.length,
        accounting_clients: accClientCount,
        total_services: corpRows.length + accRows.length,
        total_clients: clients.length,
        dormant_services: dormant,
        active_clients_start: activeStart,
        churn_rate: rate == null ? null : Number(rate.toFixed(3)),
        detail: {
          clients: clients.map((c) => ({
            ref: c.ref,
            label: c.label,
            services: c.services,
          })),
        },
        computed_at: new Date().toISOString(),
        reported_at: new Date().toISOString(),
      }, { onConflict: "period" });

      // File it in the Corporate documents area so there is a permanent record.
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
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear all,</p>
    <p style="margin:0 0 6px">Client churn for <b>${monthLabel}</b>${partial ? " (month not yet complete — provisional)" : ""}:</p>
    <table style="border-collapse:collapse;margin:14px 0">
      <tr><th style="${th}">Measure</th><th style="${th}">Value</th></tr>
      <tr style="background:${SOFT};font-weight:bold"><td style="${td}">Clients lost</td><td style="${td}">${clients.length}</td></tr>
      <tr><td style="${td}">Services closed</td><td style="${td}">${corpRows.length + accRows.length}</td></tr>
      <tr><td style="${td}">Churn rate (clients)</td><td style="${td}">${rate == null ? "—" : rate.toFixed(2) + "%"}</td></tr>
      <tr><td style="${td}">Annual Corporate Services</td><td style="${td}">${corpRows.length} services / ${corpClientCount} clients</td></tr>
      <tr><td style="${td}">Accounting</td><td style="${td}">${accRows.length} services / ${accClientCount} clients</td></tr>
    </table>
    <p style="margin:0 0 6px">The attached PDF lists every client lost and which services closed.</p>
    <p style="margin:0 0 24px;font-size:12px;color:#666">Clients is the figure to quote — one client leaving usually closes several services, so the service count is always higher. Dormant accounting files are not counted as churn. Revenue lost is not shown because HubSpot holds no fee against these tickets.</p>
    ${settings.email_signature || ""}
  </div>
</body></html>`;

    stage = "send";
    const subject = (preview ? "[PREVIEW] " : "") +
      `Monthly Client Churn — ${monthLabel} (${clients.length} client${clients.length === 1 ? "" : "s"})`;
    const r = await sendEmail(settings, recipients, subject, html, { pdfB64, pdfName });
    if (!preview) {
      if (r.ok) await markSent(KIND, first, r.detail ?? "sent");
      else await logError(ERROR_KIND, first, "send failed: " + r.detail);
    }

    return new Response(
      JSON.stringify({
        ok: r.ok,
        preview,
        partial,
        month: first,
        monthLabel,
        clients: clients.length,
        services: corpRows.length + accRows.length,
        corporate: { services: corpRows.length, clients: corpClientCount },
        accounting: { services: accRows.length, clients: accClientCount },
        activeStart,
        rate,
        dormant,
        noRefCount,
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
