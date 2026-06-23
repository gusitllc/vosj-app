// cf-tunnel-setup.cjs — create/reuse a Cloudflare named tunnel, set its ingress
// (public hostname -> in-cluster service), and upsert the DNS CNAMEs. Robust JSON
// via global fetch (the CF API is public HTTPS). Reads everything from env:
//   CLOUDFLARE_API_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID CF_ZONE_ID
//   TUNNEL_NAME TUNNEL_BASE_DOMAIN HOST_PAIRS_JSON   ([{host, service}, ...])
// Progress -> stderr; the connector TOKEN is written to stdout (and only that).
'use strict';

const EMAIL = process.env.CLOUDFLARE_API_EMAIL;
const KEY = process.env.CLOUDFLARE_API_KEY;
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const ZONE = process.env.CF_ZONE_ID;
const NAME = process.env.TUNNEL_NAME || 'vosj-poc';
const BASE = process.env.TUNNEL_BASE_DOMAIN || 'vosj.com';
const HOSTS = JSON.parse(process.env.HOST_PAIRS_JSON || '[]');
const API = 'https://api.cloudflare.com/client/v4';
const H = { 'X-Auth-Email': EMAIL, 'X-Auth-Key': KEY, 'Content-Type': 'application/json' };

function log(m) { process.stderr.write(m + '\n'); }

async function cf(method, path, body) {
  const res = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (j.success === false) throw new Error(`${method} ${path} -> ${JSON.stringify(j.errors || j)}`);
  return j;
}

(async () => {
  if (!EMAIL || !KEY || !ACCT || !ZONE) throw new Error('missing CF creds or zone id');

  // 1. find or create the tunnel (remotely-managed: ingress lives in the CF API).
  const list = await cf('GET', `/accounts/${ACCT}/cfd_tunnel?name=${encodeURIComponent(NAME)}&is_deleted=false`);
  let tid = (list.result || []).find((x) => x.name === NAME)?.id;
  if (!tid) {
    log(`creating tunnel '${NAME}'`);
    const c = await cf('POST', `/accounts/${ACCT}/cfd_tunnel`, { name: NAME, config_src: 'cloudflare' });
    tid = c.result.id;
  } else {
    log(`tunnel '${NAME}' already exists (${tid})`);
  }

  // 2. connector token (used by the cloudflared Deployment).
  const tk = await cf('GET', `/accounts/${ACCT}/cfd_tunnel/${tid}/token`);
  const token = tk.result;
  if (!token) throw new Error('no connector token returned');

  // 3. ingress: each public hostname -> its in-cluster service, + a catch-all 404.
  const ingress = HOSTS.map((h) => ({ hostname: `${h.host}.${BASE}`, service: h.service }));
  ingress.push({ service: 'http_status:404' });
  await cf('PUT', `/accounts/${ACCT}/cfd_tunnel/${tid}/configurations`, { config: { ingress } });
  log(`ingress set (${ingress.length} rules)`);

  // 4. DNS: upsert a proxied CNAME <host>.<base> -> <tid>.cfargotunnel.com.
  const target = `${tid}.cfargotunnel.com`;
  for (const h of HOSTS) {
    const fqdn = `${h.host}.${BASE}`;
    const ex = await cf('GET', `/zones/${ZONE}/dns_records?type=CNAME&name=${encodeURIComponent(fqdn)}`);
    const rec = (ex.result || [])[0];
    const body = { type: 'CNAME', name: fqdn, content: target, proxied: true };
    if (rec) await cf('PUT', `/zones/${ZONE}/dns_records/${rec.id}`, body);
    else await cf('POST', `/zones/${ZONE}/dns_records`, body);
    log(`dns ${fqdn} -> ${target}`);
  }

  process.stdout.write(token);
})().catch((e) => { log('ERROR ' + e.message); process.exit(1); });
