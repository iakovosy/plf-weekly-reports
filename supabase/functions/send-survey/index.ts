// SEND-SURVEY: emails the survey link to its recipients, on demand from the
// console. Auth: the admin console passcode, like the other console endpoints.
//
// There is no schedule. A staff survey goes out when someone decides it should,
// not on a timer, so this function only ever runs because a person pressed a
// button.
//
// Actions:
//   {passcode, survey_id, action:'send'}              -> everyone not yet sent
//   {passcode, survey_id, action:'send', resend:true} -> everyone who has not responded
//   {passcode, survey_id, action:'send', email:'x@y'} -> one person
//   {passcode, survey_id, action:'test', email:'x@y'} -> the invite, to you, using
//       the preview token; sends nothing to staff and marks nothing as sent.
//
// A survey must be OPEN before invitations go out. Sending a link to a draft
// would give people a form that refuses their answers.
import { supabase } from "../_shared/client.ts";
import { getSettings } from "../_shared/settings.ts";
import { sendEmail } from "../_shared/email.ts";
import { brandedShell, button, linkFallback } from "../_shared/emailLayout.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

function inviteHtml(o: {
  name: string | null;
  title: string;
  link: string;
  minutes: string;
  signature: string;
}): string {
  const greeting = o.name ? o.name.split(/\s+/)[0] : "colleague";
  return brandedShell({
    title: o.title,
    preview: `Your answers are anonymous. It takes about ${o.minutes}.`,
    body: `
      <p style="margin:0 0 14px">Dear ${greeting},</p>
      <p style="margin:0 0 14px">We are asking the team for feedback on how we lead and how we work
      together. It takes about ${o.minutes} and every question is answered by ticking a box.</p>
      <p style="margin:0 0 18px"><b>Your answers are anonymous.</b> We do not record your name or
      email address against your answers, and results are only ever shared as combined totals.</p>
      ${button(o.link, "Start the survey")}
      ${linkFallback(o.link)}
      <p style="margin:18px 0 0;font-size:12px;color:#666">This link is personal to you only so that
      we can see how many people have replied — it is not linked to your answers. Please do not
      forward it.</p>
      ${o.signature}`,
  });
}

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
    if (String(body.passcode ?? "") !== settings.admin_passcode) {
      return json({ error: "unauthorized" }, 401);
    }

    const surveyId = String(body.survey_id ?? "");
    if (!surveyId) return json({ error: "survey_id required" }, 400);

    const { data: survey, error: sErr } = await supabase
      .from("surveys").select("*").eq("id", surveyId).single();
    if (sErr || !survey) return json({ error: "survey not found" }, 404);

    const portal = (settings.portal_url || "").replace(/\/$/, "");
    if (!portal) return json({ error: "portal_url is not set in Settings" }, 400);
    const linkFor = (token: string) => `${portal}/survey.html?token=${token}`;

    const action = String(body.action ?? "send");
    const signature = settings.email_signature || "";
    // The stated length comes from the survey itself. A survey that was
    // shortened must not still promise the old duration in its invitation.
    const minutes = String((survey.definition || {}).minutes || "a few minutes");

    if (action === "test") {
      const to = String(body.email ?? "").trim();
      if (!to) return json({ error: "email required" }, 400);
      const { data: prev } = await supabase.from("survey_tokens")
        .select("token").eq("survey_id", surveyId).eq("recipient_email", "preview@philippoulaw.com")
        .maybeSingle();
      if (!prev) return json({ error: "no preview token for this survey" }, 400);
      const r = await sendEmail(
        settings, [to], `[TEST] ${survey.title}`,
        inviteHtml({ name: "there", title: survey.title, link: linkFor(prev.token), minutes, signature }),
      );
      return json({ ok: r.ok, tested: to, detail: r.detail });
    }

    if (action !== "send") return json({ error: "unknown action" }, 400);

    if (survey.status !== "open") {
      return json({
        error: "Open the survey before sending. A draft link would refuse people's answers.",
        status: survey.status,
      }, 400);
    }

    let q = supabase.from("survey_tokens")
      .select("token,recipient_name,recipient_email,sent_at,used")
      .eq("survey_id", surveyId)
      .neq("recipient_email", "preview@philippoulaw.com");

    const one = String(body.email ?? "").trim().toLowerCase();
    if (one) q = q.eq("recipient_email", one);

    const { data: rows, error: tErr } = await q;
    if (tErr) return json({ error: String(tErr.message || tErr) }, 500);

    const resend = body.resend === true;
    // Default: only people who have never been emailed. resend: everyone who
    // has not yet responded — never someone who has, so nobody is nagged after
    // doing what was asked.
    const targets = (rows || []).filter((t: any) =>
      one ? true : (resend ? !t.used : !t.sent_at)
    );

    const sent: string[] = [];
    const failed: { email: string; detail: string | null }[] = [];
    for (const t of targets) {
      const r = await sendEmail(
        settings, [t.recipient_email], survey.title,
        inviteHtml({
          name: t.recipient_name, title: survey.title,
          link: linkFor(t.token), minutes, signature,
        }),
      );
      if (r.ok) {
        sent.push(t.recipient_email);
        await supabase.from("survey_tokens")
          .update({ sent_at: new Date().toISOString() }).eq("token", t.token);
      } else {
        failed.push({ email: t.recipient_email, detail: r.detail });
      }
    }

    return json({
      ok: failed.length === 0,
      considered: targets.length,
      sent: sent.length,
      failed,
      mode: one ? "single" : resend ? "resend-to-non-responders" : "first-send",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
