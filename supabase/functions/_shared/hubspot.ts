// HubSpot CRM access, shared by the expired-subscriptions and sales-deals reports.
// The private app token lives in portal_settings.hubspot_token and never leaves
// the edge runtime.

const HS = "https://api.hubapi.com";

export async function hsFetch(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(HS + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HubSpot ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// Paginated CRM object search. Capped at 10 pages (1000 records), which is the
// limit both reports have always used.
export async function hsSearch(
  token: string,
  objectType: string,
  body: Record<string, unknown>,
  maxPages = 10,
): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined = undefined;
  for (let page = 0; page < maxPages; page++) {
    const payload = after ? { ...body, after } : body;
    const res = await hsFetch(token, `/crm/v3/objects/${objectType}/search`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    out.push(...(res.results || []));
    after = res.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

export type Stage = { label: string; order: number };

// Pipeline name plus its stages by id. `order` matters to the sales deals
// report, which needs to know which stages come at or after "Quote sent".
//
// Returns an empty result on failure rather than throwing: a missing label
// degrades a report, it should not kill the run. Callers supply their own
// fallback name via `pipeInfo.label || "..."`.
export async function fetchPipeline(
  token: string,
  objectType: "tickets" | "deals",
  pipeline: string,
): Promise<{ label: string; stages: Map<string, Stage> }> {
  try {
    const res = await hsFetch(token, `/crm/v3/pipelines/${objectType}/${pipeline}`);
    const map = new Map<string, Stage>();
    (res.stages || []).forEach((s: any, i: number) =>
      map.set(String(s.id), { label: s.label, order: s.displayOrder ?? i })
    );
    return { label: res.label as string, stages: map };
  } catch (_e) {
    return { label: "", stages: new Map<string, Stage>() };
  }
}

// Owner id -> lowercased email. Needs the crm.objects.owners.read scope; on
// failure the error string is returned rather than thrown, so a caller can
// carry on without per-owner routing.
export async function fetchOwners(
  token: string,
): Promise<{ map: Map<string, string>; error: string | null }> {
  const map = new Map<string, string>();
  try {
    let after: string | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const res = await hsFetch(
        token,
        `/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      for (const o of (res.results || [])) {
        if (o.email) map.set(String(o.id), String(o.email).toLowerCase());
      }
      after = res.paging?.next?.after;
      if (!after) break;
    }
    return { map, error: null };
  } catch (e) {
    return { map, error: String(e) };
  }
}
