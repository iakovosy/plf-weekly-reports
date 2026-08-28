// The branded HTML email shell used by the form and reminder senders.
//
// Everything here is table-based with inline styles and `bgcolor` attributes
// alongside the CSS, because desktop Outlook renders mail through the Word
// engine and ignores most stylesheet colour. Do not "modernise" this into divs
// and flexbox — it will look broken in Outlook.
import { HEX } from "./pdf.ts";

const { BLUE, GREY } = HEX;
const AMBER = "#F7C135";

// Hidden text shown in the inbox preview line, padded so the client does not
// pull body copy in after it.
export function preheader(text: string): string {
  const pad = "&nbsp;&zwnj;".repeat(10);
  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${text}${pad}</div>`;
}

// Bulletproof button: the padding and background live on the TD, which Outlook
// honours, rather than on the anchor, which it does not.
export function button(link: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" style="padding:24px 0 26px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="${BLUE}" style="background-color:${BLUE};border-radius:8px;padding:14px 38px" align="center">
                      <a href="${link}" target="_blank" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none"><span style="color:#ffffff">${label}</span></a>
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>`;
}

export function linkFallback(link: string): string {
  return `<p style="font-size:12px;color:#888888;margin:0">If the button doesn't work, copy this link:<br><a href="${link}" style="color:${BLUE}">${link}</a></p>`;
}

// Amber callout used at the top of reminder emails.
export function noticeBox(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td bgcolor="#FFF7E0" style="background-color:#FFF7E0;border-left:4px solid ${AMBER};padding:12px 14px;font-size:13px;color:#7a5b00">${text}</td>
            </tr></table>`;
}

export type ShellOptions = {
  /** Blue banner headline, e.g. "Weekly Workload Check-in". */
  title: string;
  /** Already-rendered HTML for the white card. */
  body: string;
  /** Inbox preview line. */
  preview?: string;
  /** Card width in px. The form and reminder mails use 560. */
  width?: number;
};

export function brandedShell(o: ShellOptions): string {
  const width = o.width ?? 560;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F2F2F2">
  ${o.preview ? preheader(o.preview) : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F2F2F2"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;max-width:100%">
      <tr><td bgcolor="${BLUE}" style="background-color:${BLUE};padding:24px 28px">
        <div style="font-family:Arial,Helvetica,sans-serif;color:#EAF0FF;font-size:11px;letter-spacing:3px;font-weight:bold">PHILIPPOU LAW FIRM</div>
        <div style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;padding-top:6px">${o.title}</div>
      </td></tr>
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:26px 28px;border-left:1px solid ${GREY};border-right:1px solid ${GREY};border-bottom:1px solid ${GREY};font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101418;line-height:1.5">
        ${o.body}
      </td></tr>
      <tr><td align="center" style="padding:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#B3B3B3">All Rights Reserved © Philippou Law Firm</td></tr>
    </table>
  </td></tr></table></body></html>`;
}
