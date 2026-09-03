// HubSpot CRM access, shared by the reports that read from it.
// The private app token lives in portal_settings.hubspot_token and never leaves
// the edge runtime.

const HS = "https://api.hubapi.com";

/** HubSpot batch endpoints accept at most 100 inputs per call. */
const BATCH = 100;

function chunk<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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

// Paginated CRM object search. Capped at maxPages (100 records each).
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

/**
 * Associated object ids, keyed by source id.
 *
 * Note the relationship is many-to-one in places: several nominee service
 * tickets commonly hang off a single deal, which is why callers that sum money
 * must deduplicate the target ids before adding anything up.
 */
export async function hsAssociations(
  token: string,
  fromType: string,
  toType: string,
  ids: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const part of chunk(ids)) {
    const res = await hsFetch(token, `/crm/v4/associations/${fromType}/${toType}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: part.map((id) => ({ id })) }),
    });
    for (const row of (res.results || [])) {
      const from = String(row?.from?.id ?? "");
      const to = (row?.to || []).map((t: any) => String(t.toObjectId));
      if (from) map.set(from, to);
    }
  }
  return map;
}

/** Read objects by id with the given properties. */
export async function hsBatchRead(
  token: string,
  objectType: string,
  ids: string[],
  properties: string[],
): Promise<any[]> {
  const out: any[] = [];
  for (const part of chunk(ids)) {
    const res = await hsFetch(token, `/crm/v3/objects/${objectType}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ properties, inputs: part.map((id) => ({ id })) }),
    });
    out.push(...(res.results || []));
  }
  return out;
}

export type Stage = { label: string; order: number };

// Pipeline name plus its stages by id. `order` matters to the sales deals
// report, which needs to know which stages come at or after "Quote sent".
// Returns an empty result on failure rather than throwing.
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

// Owner id -> lowercased email (`map`) and owner id -> display name (`names`).
// The expired report shows the name; the per-owner sends match on the email.
// Needs the crm.objects.owners.read scope; on failure the error string is
// returned rather than thrown, so a caller can degrade instead of dying.
export async function fetchOwners(
  token: string,
): Promise<{ map: Map<string, string>; names: Map<string, string>; error: string | null }> {
  const map = new Map<string, string>();
  const names = new Map<string, string>();
  try {
    let after: string | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const res = await hsFetch(
        token,
        `/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      for (const o of (res.results || [])) {
        if (o.email) map.set(String(o.id), String(o.email).toLowerCase());
        const nm = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
        if (nm || o.email) names.set(String(o.id), nm || String(o.email));
      }
      after = res.paging?.next?.after;
      if (!after) break;
    }
    return { map, names, error: null };
  } catch (e) {
    return { map, names, error: String(e) };
  }
}
