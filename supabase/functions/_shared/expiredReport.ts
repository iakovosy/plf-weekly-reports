// Expired Subscriptions: the ticket query and the PDF, shared by the weekly
// sender (send-expired-report) and the console's on-demand button
// (expired-report-files, action 'generate').
//
// Both must produce the SAME document. When the console offers an instant PDF
// and the Friday email offers another, any difference between them reads as one
// of the two being wrong — so the query, the stage exclusions and the layout all
// live here rather than being written twice.
import type { Settings } from "./settings.ts";
import { fetchPipeline, hsSearch } from "./hubspot.ts";
import { prettifyOrDash } from "./time.ts";
import {
  COLORS,
  createDoc,
  drawFooterAllPages,
  drawLetterhead,
  raw,
  wrap,
} from "./pdf.ts";

export type ExpiredRow = {
  subject: string;
  end: string;
  days: number;
  renewal: string;
  stage: string;
  stageId?: string;
  ownerId?: string;
};

// This report keeps a 40pt margin (the other reports use 44) so its six columns
// fit without shrinking the text.
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

export type ExpiredData = {
  rows: ExpiredRow[];
  allCount: number;
  excludedCount: number;
  excludedNote: string;
  pipelineLabel: string;
};

/**
 * Expired tickets for the configured pipeline, with excluded stages removed.
 *
 * `todayIso` is a Cyprus-local YYYY-MM-DD: the caller decides what "today"
 * means, so the weekly run and an on-demand run can both be explicit about it.
 */
export async function fetchExpiredRows(
  settings: Settings,
  token: string,
  todayIso: string,
): Promise<ExpiredData> {
  const pipeline = settings.expired_report_pipeline || "0";
  const todayMs = Date.parse(todayIso + "T00:00:00Z");

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
    fetchPipeline(token, "tickets", pipeline),
  ]);

  // Excluded stages may be given as labels or as raw stage ids.
  const excludeRawStr = settings.expired_report_exclude_stages ?? "Renewal,Disengaged";
  const excludeTerms = excludeRawStr.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
  const excludedIds = new Set<string>();
  if (excludeTerms.length) {
    for (const [id, st] of pipeInfo.stages.entries()) {
      if (
        excludeTerms.includes(String(st.label).toLowerCase()) ||
        excludeTerms.includes(String(id).toLowerCase())
      ) excludedIds.add(String(id));
    }
    for (const t of excludeTerms) if (/^\d+$/.test(t)) excludedIds.add(t);
  }
  const excludedNames = excludeTerms.length ? excludeRawStr : "";

  const all: ExpiredRow[] = tickets.map((t: any) => {
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
      stage: pipeInfo.stages.get(String(p.hs_pipeline_stage))?.label || raw(p.hs_pipeline_stage),
      ownerId: String(p.hubspot_owner_id || ""),
    };
  });

  const rows = all.filter((r) => !excludedIds.has(r.stageId!));
  const excludedCount = all.length - rows.length;
  const excludedNote = excludedNames
    ? `Excluding stages: ${excludedNames} (${excludedCount} ticket${excludedCount === 1 ? "" : "s"} hidden).`
    : "";

  return {
    rows,
    allCount: all.length,
    excludedCount,
    excludedNote,
    pipelineLabel: pipeInfo.label || "Annual Corporate Services",
  };
}

/** The branded PDF, returned base64. `subtitle` distinguishes the weekly list
 * from an owner's own list or an on-demand pull. */
export async function buildExpiredPdf(
  pretty: string,
  pipelineLabel: string,
  rows: ExpiredRow[],
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
    page.drawText("No expired subscriptions.", {
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
