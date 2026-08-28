// Outbound email. Brevo is used when brevo_api_key is set, otherwise Resend.
// This is the only place either provider's API shape appears.
import type { Settings } from "./settings.ts";

export type SendResult = { ok: boolean; detail: string | null };

export type SendOptions = {
  pdfB64?: string;
  pdfName?: string;
  // What `detail` says on success. The summary reports record "sent" in send_log;
  // the form/reminder senders record null. Kept configurable so the send_log
  // entries stay exactly as they were before these functions shared this code.
  okDetail?: string | null;
};

export function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^(.*)<([^>]+)>\s*$/);
  if (m) {
    return {
      name: m[1].trim().replace(/^"|"$/g, "") || undefined,
      email: m[2].trim(),
    };
  }
  return { email: from.trim() };
}

export async function sendEmail(
  settings: Settings,
  to: string | string[],
  subject: string,
  html: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const recipients = Array.isArray(to) ? to : [to];
  const okDetail = opts.okDetail === undefined ? "sent" : opts.okDetail;
  const from = settings.from_email || "PLF Reports <onboarding@resend.dev>";

  const brevoKey = settings.brevo_api_key;
  if (brevoKey) {
    const f = parseFrom(from);
    const payload: any = {
      sender: { email: f.email, name: f.name ?? "PLF Reports" },
      to: recipients.map((e) => ({ email: e })),
      subject,
      htmlContent: html,
    };
    if (opts.pdfB64) payload.attachment = [{ name: opts.pdfName, content: opts.pdfB64 }];
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": brevoKey },
      body: JSON.stringify(payload),
    });
    return { ok: resp.ok, detail: resp.ok ? okDetail : await resp.text() };
  }

  const resendKey = Deno.env.get("RESEND_API_KEY") || settings.resend_api_key;
  if (!resendKey) {
    return {
      ok: false,
      detail: "No email provider configured (set a Brevo or Resend API key in Settings)",
    };
  }
  const payload: any = { from, to: recipients, subject, html };
  if (opts.pdfB64) payload.attachments = [{ filename: opts.pdfName, content: opts.pdfB64 }];
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify(payload),
  });
  return { ok: resp.ok, detail: resp.ok ? okDetail : await resp.text() };
}
