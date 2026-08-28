// ARCHIVE-REPORT: render a document to a branded PDF and file it against a department.
//
// Takes the report content as JSON, lays it out with the same letterhead the
// weekly reports use, and stores the result in the private department-reports
// bucket. This exists so a report can be filed without moving a finished PDF
// across the network — the content travels as text and the PDF is made here.
//
// Auth: the console passcode, like department-files.
//
// POST {passcode, department, filename, title, subtitle, blocks:[...]}
//
// Block types:
//   {t:'h',       text}                     section heading
//   {t:'p',       text}                     paragraph
//   {t:'meta',    text}                     small grey line (attribution, refs)
//   {t:'quote',   text, tone?:'bad'|'good'} indented quotation
//   {t:'bullets', items:[string]}           numbered list
//   {t:'table',   cols:[{t,w}], rows:[[..]]}
import { supabase } from "../_shared/client.ts";
import { COLORS, createDoc, drawFooterAllPages, drawLetterhead, wrap } from "../_shared/pdf.ts";
import { rgb } from "npm:pdf-lib@1.17.1";

const BUCKET = "department-reports";
const DEPARTMENTS = ["corporate", "sales", "general", "firm"];
const SAFE_NAME = /^[A-Za-z0-9 ._()\-]+\.[A-Za-z0-9]{1,8}$/;

const W = 595, H = 842, M = 44;
const BOTTOM = 56; // leave room for the footer

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const QUOTE_BG = { bad: rgb(0.984, 0.894, 0.906), good: rgb(0.93, 0.968, 0.93), plain: rgb(0.95, 0.95, 0.95) };
const QUOTE_BAR = { bad: COLORS.red, good: rgb(0.18, 0.49, 0.196), plain: COLORS.blue };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    const { data: st } = await supabase.from("portal_settings")
      .select("key,value").in("key", ["admin_passcode"]);
    const settings = Object.fromEntries((st || []).map((r: any) => [r.key, r.value]));
    if (!settings.admin_passcode) return json({ error: "config" }, 500);
    if (String(body.passcode ?? "") !== settings.admin_passcode) return json({ error: "unauthorized" }, 401);

    const department = String(body.department ?? "corporate").toLowerCase();
    if (!DEPARTMENTS.includes(department)) return json({ error: "unknown department" }, 400);

    const filename = String(body.filename ?? "");
    if (!SAFE_NAME.test(filename)) return json({ error: "bad file name" }, 400);

    const blocks: any[] = Array.isArray(body.blocks) ? body.blocks : [];
    if (!blocks.length) return json({ error: "no content" }, 400);

    const d = await createDoc();
    const { font, bold, clean } = d;

    let page = d.doc.addPage([W, H]);
    let y = drawLetterhead(page, d, {
      W, H, M,
      title: String(body.title ?? "Report"),
      subtitle: String(body.subtitle ?? ""),
      bandHeight: 84,
    });
    y -= 6;

    const newPage = () => { page = d.doc.addPage([W, H]); y = H - 56; };
    const need = (h: number) => { if (y - h < BOTTOM) newPage(); };

    const para = (text: string, size: number, f: any, color: any, indent = 0, lead = 1.45) => {
      const width = W - M * 2 - indent;
      for (const line of wrap(clean(text), width + 8, size, f)) {
        need(size * lead);
        page.drawText(line, { x: M + indent, y, size, font: f, color });
        y -= size * lead;
      }
    };

    for (const b of blocks) {
      const t = String(b?.t ?? "p");

      if (t === "h") {
        need(34);
        y -= 10;
        para(String(b.text ?? ""), 12, bold, COLORS.navy, 0, 1.3);
        page.drawLine({
          start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 },
          thickness: 1, color: COLORS.blue,
        });
        y -= 8;
        continue;
      }

      if (t === "meta") {
        para(String(b.text ?? ""), 8.5, font, COLORS.note, 0, 1.4);
        y -= 3;
        continue;
      }

      if (t === "quote") {
        const tone = (b.tone === "bad" || b.tone === "good") ? b.tone : "plain";
        const size = 9.5, indent = 16;
        const lines = wrap(clean(String(b.text ?? "")), W - M * 2 - indent - 8, size, font);
        const boxH = lines.length * size * 1.45 + 12;
        need(boxH + 6);
        page.drawRectangle({
          x: M, y: y - boxH + size, width: W - M * 2, height: boxH,
          color: (QUOTE_BG as any)[tone],
        });
        page.drawRectangle({
          x: M, y: y - boxH + size, width: 3, height: boxH,
          color: (QUOTE_BAR as any)[tone],
        });
        let ly = y - 4;
        for (const line of lines) {
          page.drawText(line, { x: M + indent, y: ly, size, font, color: COLORS.black });
          ly -= size * 1.45;
        }
        y = y - boxH - 6;
        continue;
      }

      if (t === "bullets") {
        const items: string[] = Array.isArray(b.items) ? b.items : [];
        items.forEach((it, i) => {
          const label = `${i + 1}.`;
          need(14);
          page.drawText(label, { x: M, y, size: 9.5, font: bold, color: COLORS.blue });
          para(String(it), 9.5, font, COLORS.black, 20);
          y -= 3;
        });
        y -= 4;
        continue;
      }

      if (t === "table") {
        const cols: any[] = Array.isArray(b.cols) ? b.cols : [];
        const rows: any[][] = Array.isArray(b.rows) ? b.rows : [];
        if (!cols.length) continue;
        const TW = cols.reduce((s, c) => s + (c.w || 80), 0);
        const header = () => {
          need(24);
          let x = M;
          page.drawRectangle({ x: M, y: y - 4, width: TW, height: 17, color: COLORS.blue });
          for (const c of cols) {
            page.drawText(clean(String(c.t ?? "")), { x: x + 4, y, size: 8, font: bold, color: COLORS.white });
            x += (c.w || 80);
          }
          y -= 19;
        };
        header();
        let ri = 0;
        for (const r of rows) {
          const vals = cols.map((_, i) => clean(String(r[i] ?? "")));
          const cl = vals.map((v, i) => wrap(v, cols[i].w || 80, 8.5, i === 0 ? bold : font));
          const rowH = Math.max(...cl.map((l) => l.length)) * 11 + 7;
          if (y - rowH < BOTTOM) { newPage(); header(); }
          if (ri % 2 === 1) {
            page.drawRectangle({ x: M, y: y - rowH + 12, width: TW, height: rowH, color: COLORS.soft });
          }
          let x = M;
          vals.forEach((_, i) => {
            cl[i].forEach((line, li) => {
              page.drawText(line, {
                x: x + 4, y: y - li * 11, size: 8.5,
                font: i === 0 ? bold : font, color: COLORS.black,
              });
            });
            x += (cols[i].w || 80);
          });
          page.drawLine({
            start: { x: M, y: y - rowH + 10 }, end: { x: M + TW, y: y - rowH + 10 },
            thickness: 0.5, color: COLORS.grey,
          });
          y -= rowH;
          ri++;
        }
        y -= 10;
        continue;
      }

      // default: paragraph
      para(String(b.text ?? ""), 9.5, font, COLORS.black);
      y -= 6;
    }

    drawFooterAllPages(d, M);
    const pdfB64 = await d.doc.saveAsBase64();

    const bytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
    const { error } = await supabase.storage.from(BUCKET).upload(
      `${department}/${filename}`,
      bytes,
      { contentType: "application/pdf", upsert: true },
    );
    if (error) return json({ error: String(error.message || error) }, 500);

    return json({ ok: true, department, filename, bytes: bytes.length, pages: d.doc.getPageCount() });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
