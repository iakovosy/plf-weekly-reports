// Shared PDF chrome: fonts, the PLF letterhead, the footer, and text wrapping.
// Each report still lays out its own tables — only the parts that were identical
// in every report live here.
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

const FONT_REG = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf";
const FONT_BOLD = "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf";

// Cached across invocations on a warm isolate, so a cold-start burst only pays once.
let FONT_CACHE: { reg: Uint8Array; bold: Uint8Array } | null = null;

export async function loadFonts() {
  if (FONT_CACHE) return FONT_CACHE;
  const get = async (u: string) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("font " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  };
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [a, b] = await Promise.all([get(FONT_REG), get(FONT_BOLD)]);
      FONT_CACHE = { reg: a, bold: b };
      return FONT_CACHE;
    } catch (e) { last = e; }
  }
  throw last;
}

export const COLORS = {
  blue: rgb(0x4f / 255, 0x75 / 255, 0xff / 255),
  navy: rgb(0x27 / 255, 0x54 / 255, 0x8a / 255),
  grey: rgb(0.89, 0.87, 0.85),
  soft: rgb(0.93, 0.95, 1),
  black: rgb(0.06, 0.08, 0.09),
  red: rgb(0.69, 0, 0.13),
  white: rgb(1, 1, 1),
  onBlue: rgb(0.92, 0.94, 1),
  muted: rgb(0.6, 0.6, 0.6),
  note: rgb(0.45, 0.45, 0.45),
};

// Brand colours as hex, for the HTML half of each report.
export const HEX = { BLUE: "#4F75FF", SOFT: "#EEF2FF", GREY: "#E2DDD9" };

export type Doc = {
  doc: any;
  font: any;
  bold: any;
  // Sanitises text when the unicode font could not be fetched and we fell back
  // to Helvetica, which has no Greek glyphs.
  clean: (s: string) => string;
};

// Creates a document with DejaVu (unicode, so Greek renders) and falls back to
// Helvetica with sanitised text if the font CDN can't be reached.
export async function createDoc(): Promise<Doc> {
  const doc = await PDFDocument.create();
  let font: any, bold: any, unicodeOk = true;
  try {
    doc.registerFontkit(fontkit as any);
    const f = await loadFonts();
    font = await doc.embedFont(f.reg, { subset: true });
    bold = await doc.embedFont(f.bold, { subset: true });
  } catch (_e) {
    unicodeOk = false;
    font = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  }
  const clean = (s: string) =>
    unicodeOk ? s : String(s).replace(/\u20ac/g, "EUR").replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "?");
  return { doc, font, bold, clean };
}

// Greedy word wrap that also hard-breaks single words too long for the column.
export function wrap(text: string, width: number, size: number, f: any): string[] {
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    let word = w;
    while (f.widthOfTextAtSize(word, size) > width - 8 && word.length > 4) {
      let cut = word.length - 1;
      while (cut > 1 && f.widthOfTextAtSize(word.slice(0, cut), size) > width - 8) cut--;
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const test = line ? line + " " + word : word;
    if (f.widthOfTextAtSize(test, size) <= width - 8) line = test;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["-"];
}

// The firm mark, drawn from letters rather than an image so the PDF stays
// self-contained and can't be broken by a failed asset fetch.
const LOGO_GRID = ["..P..", ".L.L.", "F.P.F", ".L.L.", "..P.."];

export type LetterheadOptions = {
  W: number;
  H: number;
  M: number;
  title: string;
  subtitle: string;
  /** 84 on portrait reports, 78 on the landscape ones. */
  bandHeight?: number;
};

// Blue banner, logo, firm name, report title and subtitle. Returns the y
// coordinate the caller should continue drawing from.
export function drawLetterhead(page: any, d: Doc, o: LetterheadOptions): number {
  const { W, H, M } = o;
  const band = o.bandHeight ?? 84;
  const titleY = H - (band >= 84 ? 48 : 46);
  const subtitleY = H - (band >= 84 ? 64 : 62);

  page.drawRectangle({ x: 0, y: H - band, width: W, height: band, color: COLORS.blue });
  LOGO_GRID.forEach((row, ri) =>
    row.split("").forEach((ch, ci) => {
      if (ch !== ".") {
        page.drawText(ch, {
          x: M + ci * 10,
          y: H - 30 - ri * 10,
          size: 9,
          font: d.bold,
          color: rgb(0, 0, 0),
        });
      }
    })
  );
  page.drawText("PHILIPPOU LAW FIRM", {
    x: M + 70, y: H - 30, size: 8, font: d.bold, color: COLORS.onBlue,
  });
  page.drawText(d.clean(o.title), {
    x: M + 70, y: titleY, size: 15, font: d.bold, color: COLORS.white,
  });
  page.drawText(d.clean(o.subtitle), {
    x: M + 70, y: subtitleY, size: 10, font: d.font, color: COLORS.onBlue,
  });
  return H - (band + 20);
}

export const FOOTER_DEFAULT =
  "Generated automatically — All Rights Reserved © Philippou Law Firm";

// Most reports footer every page; the two meeting reports footer only the last
// one, which is why `page` and `doc` variants both exist.
export function drawFooter(page: any, d: Doc, M: number, text = FOOTER_DEFAULT): void {
  page.drawText(d.clean(text), { x: M, y: 28, size: 7.5, font: d.font, color: COLORS.muted });
}

export function drawFooterAllPages(d: Doc, M: number, text = FOOTER_DEFAULT): void {
  for (const p of d.doc.getPages()) drawFooter(p, d, M, text);
}

// Small formatters every report repeats.
export const raw = (s: any) => s == null || s === "" ? "-" : String(s);
export const esc = (s: any) =>
  s == null || s === ""
    ? "—"
    : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const yn = (b: any) => b === true ? "Yes" : b === false ? "No" : "—";
export const ynRaw = (b: any) => b === true ? "Yes" : b === false ? "No" : "-";
