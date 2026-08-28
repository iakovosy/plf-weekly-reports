// EXPIRED SUBSCRIPTIONS weekly report: covering email + branded PDF listing HubSpot
// tickets whose subscription_end_date has passed, in the pipeline set by
// portal_settings.expired_report_pipeline (default '0' = Annual Corporate Services).
//
// Stages named in expired_report_exclude_stages (default 'Renewal,Disengaged') are
// hidden. Non-preview runs archive the PDF to the private 'expired-reports' bucket
// so the console can offer it for download.
//
// After the main send, every active summary_recipients row with stream='expired_owners'
// whose email matches a HubSpot ticket owner gets a PDF of ONLY their own tickets.
// Owners with nothing expired that week get no email. Owner-send failures log under
// expired_owner_error and never block or retry the main run.
//
// Plumbing lives in ../_shared.
import { supabase } from "../_shared/client.ts";
import { cyprusNow, prettifyOrDash, prettyDate } from "../_shared/time.ts";
import { getSettings, splitRecipients, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, logError, markSent } from "../_shared/schedule.ts";
import { fetchOwners, fetchStageLabels, hsSearch } from "../_shared/hubspot.ts";
import {
  COLORS,
  createDoc,
  drawFooterAllPages,
  drawLetterhead,
  raw,
  wrap,
} from "../_shared/pdf.ts";

const KIND = "expired_report";
const ERROR_KIND = "expired_report_error";
const OWNER_ERROR_KIND = "expired_owner_error";

const W = 595, H = 842, M = 40;
const COLS = [
  { t: "#", w: 26 },
  { t: "Ticket", w: 189 },
  { t: "Stage", w: 95 },
  { t: "Expired on", w: 68 },
  { t: "Days", w: 37 },
  { t: "Renewal status", w: 100 },
];
const TW = COLS.reduce((s, c) => s + c.w, 0);

type Row = {
  subject: string;
  end: string;
  days: number;
  renewal: string;
  stage: string;
  stageId?: string;
  ownerId?: string;
};

async function buildPdf(
  pretty: string,
  pipelineLabel: string,
  rows: Row[],
  note: string,
  subtitle = "Weekly List",
): Promise<string> {
  const d = await createDoc();
  const { font, bold, clean } = d;

  let page = d.doc.addPage([W, H]);
  drawLetterhead(page, d, {
    W,
    H,
    M,
    title: `Expired Subscriptions — ${subtitle}`,
    subtitle: `${pipelineLabel} — as of ${pretty}`,
    bandHeight: 84,
  });

  let y = H - 104;
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

  page.drawText(clean(`${rows.length} expired ticket${rows.length === 1 ? "" : "s"}.`), {
    x: M, y, size: 9.5, font: bold, color: rows.length ? COLORS.red : COLORS.black,
  });
  y -= 12;
  if (note) {
    page.drawText(clean(note), { x: M, y, size: 8, font, color: COLORS.note });
    y -= 14;
  }
  y -= 6;

  if (!rows.length) {
    page.drawText("No expired subscriptions this week.", {
      x: M, y, size: 10, font, color: COLORS.black,
    });
  } else {
    headerRow();
    let ri = 0;
    for (const r of rows) {
      const vals = [
        String(ri + 1),
        raw(r.subject),
        raw(r.stage),
        prettifyOrDash(r.end),
        String(r.days),
        raw(r.renewal),
      ].map(clean);
      const cl = vals.map((v, i) => wrap(v, COLS[i].w, 8.5, i === 1 ? bold : font));
      const rowH = Math.max(...cl.map((l) => l.length)) * 11 + 8;
      if (y - rowH < 50) { newPage(); headerRow(); }
      if (ri % 2 === 1) {
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
            font: i === 1 ? bold : font,
            // Overdue by more than a month reads red.
            color: (i === 4 && r.days > 30) ? COLORS.red : COLORS.black,
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
  }

  drawFooterAllPages(d, M);
  return await d.doc.saveAsBase64();
}

// `personal` picks the wording: the firm-wide mail says "the weekly list of
// expired subscriptions", an owner's own mail says "the list of your expired
// subscriptions".
function coveringHtml(o: {
  greeting: string;
  personal: boolean;
  pipelineLabel: string;
  count: number;
  pretty: string;
  signature: string;
}): string {
  const what = o.personal
    ? "the list of your expired subscriptions"
    : "the weekly list of expired subscriptions";
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#101418;padding:22px 24px">
    <p style="margin:0 0 14px">Dear ${o.greeting},</p>
    <p style="margin:0 0 24px">Please find attached ${what} in the ${o.pipelineLabel} pipeline (${o.count} ticket${o.count === 1 ? "" : "s"}) as of ${o.pretty}.</p>
    ${o.signature}
  </div>
</body></html>`;
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

    const schedDay = settings.expired_report_day || "Fri";
    const schedHour = parseInt(settings.expired_report_hour ?? "9", 10);
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

    stage = "fetch tickets";
    const pipeline = settings.expired_report_pipeline || "0";
    const todayMs = Date.parse(now.date + "T00:00:00Z");
    const [tickets, pipeInfo] = await Promise.all([
      hsSearch(token, "tickets", {
        filterGroups: [{
          filters: [
            { propertyName: "hs_pipeline", operator: "EQ", value: pipeline },
            { propertyName: "subscription_end_date", operator: "LT", value: String(todayMs) },
          ],
        }],
        sorts: [{ propertyName: "subscription_end_date", direction: "ASCENDING" }],
        properties: [
          "subject",
          "subscription_end_date",
          "subscription_renewal_status",
          "hs_pipeline_stage",
          "hubspot_owner_id",
        ],
        limit: 100,
      }),
      fetchStageLabels(token, "tickets", pipeline),
    ]);

    // Excluded stages may be given as labels or as raw stage ids.
    const excludeRawStr = settings.expired_report_exclude_stages ?? "Renewal,Disengaged";
    const excludeTerms = excludeRawStr.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    const excludedIds = new Set<string>();
    if (excludeTerms.length) {
      for (const [id, label] of pipeInfo.stages.entries()) {
        if (
          excludeTerms.includes(String(label).toLowerCase()) ||
          excludeTerms.includes(String(id).toLowerCase())
        ) excludedIds.add(String(id));
      }
      for (const t of excludeTerms) if (/^\d+$/.test(t)) excludedIds.add(t);
    }
    const excludedNames = excludeTerms.length ? excludeRawStr : "";

    const all: Row[] = tickets.map((t: any) => {
      const p = t.properties || {};
      const end = String(p.subscription_end_date || "").slice(0, 10);
      const days = end
        ? Math.max(0, Math.floor((todayMs - Date.parse(end + "T00:00:00Z")) / 86400000))
        : 0;
      return {
        subject: p.subject || String(t.id),
        end,
        days,
        renewal: p.subscription_renewal_status || "-",
        stageId: String(p.hs_pipeline_stage),
        stage: pipeInfo.stages.get(String(p.hs_pipeline_stage)) || raw(p.hs_pipeline_stage),
        ownerId: String(p.hubspot_owner_id || ""),
      };
    });
    const rows = all.filter((r) => !excludedIds.has(r.stageId!));
    const excludedCount = all.length - rows.length;
    const excludedNote = excludedNames
      ? `Excluding stages: ${excludedNames} (${excludedCount} ticket${excludedCount === 1 ? "" : "s"} hidden).`
      : "";

    const pretty = prettyDate(now.date);
    const pipelineLabel = pipeInfo.label || "Annual Corporate Services";

    stage = "build pdf";
    const pdfB64 = await buildPdf(pretty, pipelineLabel, rows, excludedNote);
    const pdfName = `PLF-Expired-Subscriptions-${now.date}.pdf`;

    stage = "archive pdf";
    let archived = false;
    if (!preview) {
      try {
        const bytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
        const { error: upErr } = await supabase.storage.from("expired-reports")
          .upload(pdfName, bytes, { contentType: "application/pdf", upsert: true });
        archived = !upErr;
        if (upErr) await logError(ERROR_KIND, now.date, "archive failed: " + String(upErr.message || upErr));
      } catch (e) {
        await logError(ERROR_KIND, now.date, "archive failed: " + String(e));
      }
    }

    stage = "resolve recipients";
    const recipients = overrideTo ??
      splitRecipients(settings.expired_report_recipient || settings.report_recipient);
    if (!recipients.length) {
      await logError(ERROR_KIND, now.date, "no expired_report_recipient configured");
      return new Response(JSON.stringify({ skipped: true, reason: "no recipient" }), { status: 200 });
    }

    stage = "send";
    const subject = (preview ? "[PREVIEW] " : "") +
      `Expired Subscriptions — ${pretty} (${rows.length})`;
    const r = await sendEmail(
      settings,
      recipients,
      subject,
      coveringHtml({
        greeting: "all",
        personal: false,
        pipelineLabel,
        count: rows.length,
        pretty,
        signature: settings.email_signature || "",
      }),
      { pdfB64, pdfName },
    );
    if (!preview) {
      if (r.ok) await markSent(KIND, now.date, r.detail ?? "sent");
      else await logError(ERROR_KIND, now.date, "send failed: " + r.detail);
    }

    // ---- Per-owner personal lists (skipped in preview; never blocks the main run) ----
    stage = "owner lists";
    const owners = { enabled: 0, sent: 0, skipped: 0, failed: 0, lookupError: null as string | null };
    if (!preview && r.ok) {
      try {
        const { data: ownRecs } = await supabase.from("summary_recipients")
          .select("name,email").eq("stream", "expired_owners").eq("active", true);
        const list = (ownRecs || []).filter((x: any) => x.email);
        owners.enabled = list.length;
        if (list.length) {
          const ow = await fetchOwners(token);
          if (ow.error) {
            owners.lookupError = ow.error;
            await logError(
              OWNER_ERROR_KIND,
              now.date,
              "owner lookup failed (add the crm.objects.owners.read scope to the HubSpot private app): " + ow.error,
            );
          } else {
            // One person can hold more than one owner id.
            const emailToOwnerIds = new Map<string, string[]>();
            for (const [oid, em] of ow.map.entries()) {
              if (!emailToOwnerIds.has(em)) emailToOwnerIds.set(em, []);
              emailToOwnerIds.get(em)!.push(oid);
            }
            const fails: string[] = [];
            for (const rec of list) {
              const em = String(rec.email).toLowerCase();
              const ids = emailToOwnerIds.get(em) || [];
              const mine = ids.length ? rows.filter((rr) => ids.includes(rr.ownerId!)) : [];
              if (!mine.length) { owners.skipped++; continue; }
              const first = String(rec.name || "").split(/\s+/)[0] || "colleague";
              const note = `Tickets owned by ${rec.name}.` + (excludedNote ? " " + excludedNote : "");
              try {
                const pPdf = await buildPdf(pretty, pipelineLabel, mine, note, "Your Tickets");
                const safe = String(rec.name || "owner")
                  .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "owner";
                const pr = await sendEmail(
                  settings,
                  [rec.email],
                  `Your Expired Subscriptions — ${pretty} (${mine.length})`,
                  coveringHtml({
                    greeting: first,
                    personal: true,
                    pipelineLabel,
                    count: mine.length,
                    pretty,
                    signature: settings.email_signature || "",
                  }),
                  { pdfB64: pPdf, pdfName: `PLF-Expired-Subscriptions-${now.date}-${safe}.pdf` },
                );
                if (pr.ok) owners.sent++;
                else { owners.failed++; fails.push(`${rec.email}: ${pr.detail}`.slice(0, 120)); }
              } catch (e) {
                owners.failed++;
                fails.push(`${rec.email}: ${String(e)}`.slice(0, 120));
              }
            }
            if (fails.length) {
              await logError(
                OWNER_ERROR_KIND,
                now.date,
                `owner sends failed (${owners.failed}/${owners.enabled}): ` + fails.join(" | "),
              );
            }
          }
        }
      } catch (e) {
        await logError(OWNER_ERROR_KIND, now.date, "owner lists crashed: " + String(e));
      }
    }

    return new Response(
      JSON.stringify({
        ok: r.ok,
        preview,
        archived,
        pipeline,
        pipelineLabel,
        count: rows.length,
        excluded: excludedCount,
        excludeStages: excludedNames,
        to: recipients,
        owners,
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
