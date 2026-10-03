/**
 * The Chronicle side of the bench: seeds a campaign through Chronicle's own
 * web forms (register, log in, create a campaign, create API keys) and gives
 * scenarios a second client for "someone edited this in Chronicle".
 *
 * The module gets one key; Chronicle-side edits use another, so they look
 * like a different writer and are never mistaken for the module's echo.
 */

export const CHRONICLE_URL = (process.env.CHRONICLE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');

/** Minimal cookie-jar fetch for the web forms (double-submit CSRF). */
function webSession() {
  const jar = new Map();
  const store = (res) => {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf = () => jar.get('chronicle_csrf') || '';
  return {
    async get(path) {
      const res = await fetch(CHRONICLE_URL + path, { headers: { cookie: cookie() }, redirect: 'manual' });
      store(res);
      return res;
    },
    async post(path, form) {
      const res = await fetch(CHRONICLE_URL + path, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          cookie: cookie(),
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf(),
        },
        body: new URLSearchParams(form).toString(),
      });
      store(res);
      return res;
    },
  };
}

let seq = 0;
let owner = null;

/**
 * One owner per run (Chronicle rate-limits sign-ups), logged in once; each
 * scenario gets its own campaign under it.
 */
async function ownerSession() {
  if (owner) return owner;
  const tag = Date.now().toString(36);
  const web = webSession();
  await web.get('/register');
  const displayName = `Bench GM ${tag}`;
  const password = 'bench-password-1';
  const res = await web.post('/register', { email: `gm-${tag}@bench.test`, display_name: displayName, password, confirm: password });
  if (res.status !== 303) throw new Error(`register failed: HTTP ${res.status}`);
  owner = { web, displayName };
  return owner;
}

/**
 * A fresh campaign and two API keys. Each scenario gets its own campaign so
 * counts ("exactly one page") are never polluted by another.
 */
export async function seedCampaign(label = 'bench') {
  seq += 1;
  const { web, displayName } = await ownerSession();
  const res = await web.post('/campaigns', { name: `${label} ${seq}`, description: 'sync bench', genre: 'fantasy' });
  const loc = res.headers.get('location') || '';
  const campaignId = loc.match(/\/campaigns\/([0-9a-f-]{36})/)?.[1];
  if (!campaignId) throw new Error(`campaign create failed: HTTP ${res.status} ${loc}`);

  // Retried because Chronicle's key prefix has only 256 values and a clash
  // fails the create (keyxmakerx/Chronicle#951).
  const makeKey = async (name) => {
    let status = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await web.post(`/campaigns/${campaignId}/api-keys`, {
        name, vtt_tag: 'foundry', perm_read: 'on', perm_write: 'on', perm_sync: 'on',
      });
      status = r.status;
      const key = (await r.text()).match(/chron_[a-f0-9]{64}/)?.[0];
      if (key) return key;
    }
    throw new Error(`api key create failed: HTTP ${status}`);
  };
  const moduleKey = await makeKey('bench foundry module');
  const otherKey = await makeKey('bench chronicle editor');
  return { campaignId, moduleKey, displayName, chronicle: apiClient(campaignId, otherKey), module: apiClient(campaignId, moduleKey) };
}

/** A REST client scoped to one campaign, for scenario setup and assertions. */
export function apiClient(campaignId, key) {
  const base = `${CHRONICLE_URL}/api/v1/campaigns/${campaignId}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
  const client = {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b || {}),
    put: (p, b) => call('PUT', p, b || {}),
    del: (p) => call('DELETE', p),
    /** Every entity in the campaign, all pages. */
    async allEntities() {
      const out = [];
      for (let page = 1; page < 200; page++) {
        const r = await client.get(`/entities?page=${page}&per_page=100`);
        const rows = r?.data || r || [];
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },
    async entityTypes() {
      const r = await client.get('/entity-types');
      return r?.data || r || [];
    },
  };
  return client;
}
