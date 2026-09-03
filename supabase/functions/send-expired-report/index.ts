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
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { getSettings, splitRecipients, unauthorized } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { alreadyLogged, inScheduleWindow, logError, markSent } from "../_shared/schedule.ts";
// The ticket query and the PDF live in _shared so the console's on-demand
// button produces exactly the same document as this weekly email.
import { buildExpiredPdf, fetchExpiredRows } from "../_shared/expiredReport.ts";

const KIND = "expired_report";
const ERROR_KIND = "expired_report_error";
const OWNER_ERROR_KIND = "expired_owner_error";

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
    const { rows, excludedNote, pipelineLabel, excludedCount, owners: ownerInfo } = await fetchExpiredRows(
      settings,
      token,
      now.date,
    );
    const pipeline = settings.expired_report_pipeline || "0";
    const excludedNames = settings.expired_report_exclude_stages ?? "Renewal,Disengaged";
    const pretty = prettyDate(now.date);

    stage = "build pdf";
    const pdfB64 = await buildExpiredPdf(pretty, pipelineLabel, rows, excludedNote);
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
          const ow = ownerInfo;
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
                const pPdf = await buildExpiredPdf(pretty, pipelineLabel, mine, note, "Your Tickets");
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
