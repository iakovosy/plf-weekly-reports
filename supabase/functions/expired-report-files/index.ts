// EXPIRED-REPORT-FILES: console endpoint for the Expired Subscriptions report.
// Auth: the admin console passcode (portal_settings.admin_passcode) in the JSON body — same
// trust model as the rest of the console. verify_jwt false by design.
//
// Actions:
//   {passcode, action:'list'}              -> [{name, created_at, size}] newest first
//   {passcode, action:'url', file:'x.pdf'} -> {url} 1-hour signed download URL
//   {passcode, action:'stages'}            -> {pipeline:{id,label}, stages:[{id,label}]}
//     stage list of the configured expired_report_pipeline, for the console's
//     exclude-stages picker. The HubSpot token never leaves this function.
//   {passcode, action:'generate'}          -> {pdfB64, filename, count, pipelineLabel}
//     (v3) builds the report from HubSpot as it stands RIGHT NOW and hands it
//     straight back for download. Nothing is archived and no email is sent: the
//     weekly Friday run owns the archive, and a button press is a look, not an
//     event. The query and the layout come from _shared/expiredReport.ts, the
//     same code the weekly email uses, so the two documents cannot drift apart.
import { supabase } from "../_shared/client.ts";
import { getSettings } from "../_shared/settings.ts";
import { cyprusNow, prettyDate } from "../_shared/time.ts";
import { buildExpiredPdf, fetchExpiredRows } from "../_shared/expiredReport.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    let settings: Record<string, string>;
    try {
      settings = await getSettings();
    } catch (_e) {
      return json({ error: "config" }, 500);
    }
    if (!settings.admin_passcode) return json({ error: "config" }, 500);
    const supplied = String(body.passcode ?? "");
    if (!supplied || supplied !== settings.admin_passcode) return json({ error: "unauthorized" }, 401);

    const action = String(body.action ?? "");

    if (action === "list") {
      const { data, error } = await supabase.storage.from("expired-reports")
        .list("", { limit: 500, sortBy: { column: "name", order: "desc" } });
      if (error) return json({ error: String(error.message || error) }, 500);
      return json({
        files: (data || []).filter((f: any) => f.name.endsWith(".pdf"))
          .map((f: any) => ({ name: f.name, created_at: f.created_at, size: f.metadata?.size ?? null })),
      });
    }

    if (action === "url") {
      const file = String(body.file ?? "");
      if (!/^[A-Za-z0-9._-]+\.pdf$/.test(file)) return json({ error: "bad file name" }, 400);
      const { data, error } = await supabase.storage.from("expired-reports").createSignedUrl(file, 3600);
      if (error || !data?.signedUrl) return json({ error: String(error?.message || "not found") }, 404);
      return json({ url: data.signedUrl });
    }

    if (action === "stages") {
      const token = settings.hubspot_token;
      if (!token) return json({ error: "hubspot_token not set" }, 500);
      const pipeline = settings.expired_report_pipeline || "0";
      const r = await fetch(
        `https://api.hubapi.com/crm/v3/pipelines/tickets/${encodeURIComponent(pipeline)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
      );
      if (!r.ok) return json({ error: `HubSpot ${r.status}` }, 502);
      const d = await r.json();
      const stages = (d.stages || []).map((s: any) => ({ id: String(s.id), label: String(s.label) }))
        .sort((a: any, b: any) => a.label.localeCompare(b.label));
      return json({ pipeline: { id: String(d.id ?? pipeline), label: String(d.label ?? "") }, stages });
    }

    if (action === "generate") {
      const token = settings.hubspot_token;
      if (!token) return json({ error: "hubspot_token not set" }, 500);
      const now = cyprusNow();
      const pretty = prettyDate(now.date);
      const { rows, excludedNote, pipelineLabel, excludedCount } =
        await fetchExpiredRows(settings, token, now.date);
      const pdfB64 = await buildExpiredPdf(pretty, pipelineLabel, rows, excludedNote, "Current List");
      return json({
        pdfB64,
        filename: `PLF-Expired-Subscriptions-${now.date}.pdf`,
        count: rows.length,
        excludedCount,
        pipelineLabel,
        asOf: pretty,
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
