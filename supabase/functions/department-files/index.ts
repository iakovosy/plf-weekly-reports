// DEPARTMENT-FILES: document store for the admin console, one folder per department.
//
// Auth: the console passcode (portal_settings.admin_passcode) in the JSON body —
// the same trust model as expired-report-files. verify_jwt false by design.
//
// Files live in the private 'department-reports' bucket under <department>/<name>,
// so nothing here is reachable without going through the console. Downloads are
// served as short-lived signed URLs rather than by making the bucket public.
//
// Actions:
//   {passcode, action:'list',   department}                    -> [{name, created_at, size}] newest first
//   {passcode, action:'url',    department, file}              -> {url} 1-hour signed download link
//   {passcode, action:'upload', department, file, contentBase64, contentType}
//   {passcode, action:'delete', department, file}
import { supabase } from "../_shared/client.ts";

const BUCKET = "department-reports";

// Folder names are fixed rather than free text: a caller cannot invent a path.
const DEPARTMENTS = ["corporate", "sales", "general", "firm"];

// 25 MB — comfortably above a long PDF report, well below the edge function limit.
const MAX_BYTES = 25 * 1024 * 1024;

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

// Allow letters, digits, space, dot, dash, underscore and brackets. No slashes,
// so a file name can never climb out of its department folder.
const SAFE_NAME = /^[A-Za-z0-9 ._()\-]+\.[A-Za-z0-9]{1,8}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));

    const { data: st, error: stErr } = await supabase.from("portal_settings")
      .select("key,value").in("key", ["admin_passcode"]);
    if (stErr) return json({ error: "config" }, 500);
    const settings = Object.fromEntries((st || []).map((r: any) => [r.key, r.value]));
    if (!settings.admin_passcode) return json({ error: "config" }, 500);

    const supplied = String(body.passcode ?? "");
    if (!supplied || supplied !== settings.admin_passcode) return json({ error: "unauthorized" }, 401);

    const department = String(body.department ?? "corporate").toLowerCase();
    if (!DEPARTMENTS.includes(department)) return json({ error: "unknown department" }, 400);

    const action = String(body.action ?? "");

    if (action === "list") {
      const { data, error } = await supabase.storage.from(BUCKET)
        .list(department, { limit: 500, sortBy: { column: "name", order: "desc" } });
      if (error) return json({ error: String(error.message || error) }, 500);
      return json({
        files: (data || [])
          .filter((f: any) => f.name && !f.name.startsWith("."))
          .map((f: any) => ({
            name: f.name,
            created_at: f.created_at,
            size: f.metadata?.size ?? null,
          })),
      });
    }

    if (action === "url") {
      const file = String(body.file ?? "");
      if (!SAFE_NAME.test(file)) return json({ error: "bad file name" }, 400);
      const { data, error } = await supabase.storage.from(BUCKET)
        .createSignedUrl(`${department}/${file}`, 3600);
      if (error || !data?.signedUrl) return json({ error: String(error?.message || "not found") }, 404);
      return json({ url: data.signedUrl });
    }

    if (action === "upload") {
      const file = String(body.file ?? "");
      if (!SAFE_NAME.test(file)) return json({ error: "bad file name" }, 400);
      const b64 = String(body.contentBase64 ?? "");
      if (!b64) return json({ error: "no content" }, 400);

      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      } catch (_e) {
        return json({ error: "content is not valid base64" }, 400);
      }
      if (bytes.length > MAX_BYTES) return json({ error: "file too large" }, 413);

      const { error } = await supabase.storage.from(BUCKET).upload(
        `${department}/${file}`,
        bytes,
        {
          contentType: String(body.contentType || "application/octet-stream"),
          upsert: true,
        },
      );
      if (error) return json({ error: String(error.message || error) }, 500);
      return json({ ok: true, department, file, bytes: bytes.length });
    }

    if (action === "delete") {
      const file = String(body.file ?? "");
      if (!SAFE_NAME.test(file)) return json({ error: "bad file name" }, 400);
      const { error } = await supabase.storage.from(BUCKET).remove([`${department}/${file}`]);
      if (error) return json({ error: String(error.message || error) }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
