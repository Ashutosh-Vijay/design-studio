// The Dashboard's reading of one organization or business group (PLAN 6.2): Exchange's assets and who published
// them, API Governance (is it on, what it covers, what conforms), API Manager (what's managed where) and Runtime
// Manager (what runs where). Each product is read on its own: a person with access to only some of them sees
// those, and the rest say why they're missing (access). Every call is a GET (or a Graph API read query) through
// anypoint_api, and call() refuses anything else on these paths. No UI in here, so the AI tools use it too.
import { invoke } from '@tauri-apps/api/core';
import { appCacheDir } from '@tauri-apps/api/path';
import { assetVersions, cmpVersion, compareModels, type Change, type Version } from './sync';

type Reply = { status: number; json: any; text: string };
const get = (path: string, env?: { org: string; env: string }) => invoke<Reply>('anypoint_api', { method: 'GET', path, org: env?.org ?? null, env: env?.env ?? null });
const graph = (query: string) => invoke<Reply>('anypoint_api', { method: 'POST', path: '/graph/api/v2/graphql', body: { query } });

export type Gov = 'failing' | 'validating' | 'conformant' | 'none';
export type Api = {
  groupId: string; assetId: string; name: string; type: string; kind: 'api' | 'fragment' | 'other';
  version: string; versionGroup: string; stable: boolean;
  published: number; byId: string; by: string; // by: the publisher's name, once it's known
  gov: Gov; pass: number; fail: number; rulesets: number; urn: string | null; govAt: number;
  managed: { env: string; version: string; status: string }[];
  versions?: Version[]; // every version (the Graph API gives them at once; otherwise read in the background)
  counts?: Counts | null; // endpoints and the rest, from the latest version's spec (null: couldn't be read)
};
export type Profile = { id: string; name: string; live: boolean; filter: string; rulesets: string[]; total: number; pass: number; fail: number };
export type Env = { id: string; name: string; type: string; production: boolean };
export type Instance = { env: string; production: boolean; groupId: string; assetId: string; name: string; version: string; label: string; status: string; endpoint: string; id: string; technology: string };
export type App = { env: string; production: boolean; name: string; runtime: string; status: string; health: 'up' | 'down' | 'other'; mule: string; updated: number; url: string };
// ok: read. denied: this account isn't allowed (401 or 403). off: not in the organization's subscription.
// error: Anypoint answered something else (said in why). For each product the dashboard reads.
export type Access = 'ok' | 'denied' | 'off' | 'error';
export type Section = 'exchange' | 'governance' | 'apimanager' | 'runtime';
export const SECTION_LABEL: Record<Section, string> = { exchange: 'Exchange', governance: 'API Governance', apimanager: 'API Manager', runtime: 'Runtime Manager' };
export type Reading = {
  org: { id: string; name: string }; at: number;
  access: Record<Section, Access>; why: Partial<Record<Section, string>>;
  // on: profiles are checking APIs. empty: the organization has API Governance but no active profile.
  governance: 'on' | 'empty' | 'off' | 'unknown'; limit: number | null;
  severity: { high: number; medium: number; low: number };
  profiles: Profile[]; apis: Api[];
  environments: Env[]; instances: Instance[]; apps: App[];
  notes: string[]; // anything else worth knowing, in plain words
};

const kindOf = (type: string): Api['kind'] => (/api$/.test(type) ? 'api' : type.includes('fragment') || type === 'oas-components' ? 'fragment' : 'other');
export const KIND_LABEL: Record<string, string> = { 'rest-api': 'REST', 'http-api': 'HTTP', 'soap-api': 'SOAP', 'evented-api': 'AsyncAPI', 'async-api': 'AsyncAPI', 'graphql-api': 'GraphQL', 'grpc-api': 'gRPC', 'raml-fragment': 'Fragment', 'oas-components': 'Fragment', ruleset: 'Ruleset', custom: 'Custom', extension: 'Connector', 'mule-application': 'Mule app', example: 'Example', template: 'Template', policy: 'Policy' };
export const kindLabel = (type: string) => KIND_LABEL[type] ?? type.replace(/-/g, ' ');
const err = (e: unknown) => String(e).replace(/^Error: /, '');
const denied = (r: Reply) => r.status === 401 || r.status === 403;
const message = (r: Reply) => String(r.json?.message ?? r.json?.errors?.[0]?.message ?? r.json?.error?.[0]?.message ?? '').slice(0, 160);
const said = (what: string, r: Reply) => denied(r) ? `This account isn't allowed to read ${what}.` : `${what} answered ${r.status}${message(r) ? `: ${message(r)}` : ''}.`;

// Business groups the person is in (Design Center's org picker): the dashboard reads one at a time.
export async function groups(): Promise<{ id: string; name: string }[]> {
  const r = await get('/accounts/api/me');
  return (r.json?.user?.memberOfOrganizations ?? []).map((o: { id: string; name: string }) => ({ id: o.id, name: o.name }));
}

export async function read(org: { id: string; name: string }, step: (text: string) => void = () => {}): Promise<Reading> {
  const notes: string[] = [];
  const access: Reading['access'] = { exchange: 'ok', governance: 'ok', apimanager: 'ok', runtime: 'ok' };
  const why: Reading['why'] = {};

  // ---------- Exchange: Graph API first (every version and its publisher in one query), the search if that fails ----------
  step('Reading Exchange…');
  let apis: Api[] = [];
  try { apis = await fromGraph(org.id, step); }
  catch (e) {
    const r = e as Reply;
    if (r?.status && denied(r)) { access.exchange = 'denied'; why.exchange = said('Exchange', r); }
    else {
      try { apis = await fromSearch(org.id, step, notes); }
      catch (e2) { const r2 = e2 as Reply; access.exchange = r2?.status && denied(r2) ? 'denied' : 'error'; why.exchange = r2?.status ? said('Exchange', r2) : err(e2); }
    }
  }

  // ---------- Governance: the entitlement says whether the organization has it; the console's own readings say the rest ----------
  step('Reading API Governance…');
  let governance: Reading['governance'] = 'unknown', limit: number | null = null;
  const severity = { high: 0, medium: 0, low: 0 };
  let profiles: Profile[] = [];
  const ent = await get(`/accounts/api/organizations/${org.id}/entitlements/apiGovernance`).catch(() => null);
  limit = typeof ent?.json?.values?.apisPerMonth === 'number' ? ent.json.values.apisPerMonth : null;
  if (ent && ent.status < 300 && ent.json?.values?.enabled === false) { governance = 'off'; access.governance = 'off'; }
  else {
    const q = `organization=${org.id}`, x = '/governance/xapi/api/v1';
    // Its server errors come and go (a 500 on one reading, fine on the next), so each call gets a second try.
    const twice = async (p: string) => { const r = await get(p); return r.status >= 500 ? get(p) : r; };
    try {
      const [stats, plist, pstats, targets] = await Promise.all([twice(`${x}/stats/tenant?${q}`), twice(`${x}/profiles?${q}`), twice(`${x}/stats/tenant/profiles?${q}`), twice(`${x}/stats/tenant/targets?${q}`)]);
      const bad = [stats, plist, pstats, targets].find((r) => r.status >= 300 || r.json == null);
      if (bad) { access.governance = denied(bad) ? 'denied' : 'error'; why.governance = said('API Governance', bad); }
      else {
        Object.assign(severity, { high: stats.json.failed?.high ?? 0, medium: stats.json.failed?.medium ?? 0, low: stats.json.failed?.low ?? 0 });
        const counts = new Map<string, { total: number; pass: number; fail: number }>((pstats.json.profiles ?? []).map((p: any) => [p.id?.id, { total: p.total ?? 0, pass: p.pass ?? 0, fail: p.fail ?? 0 }]));
        profiles = (Array.isArray(plist.json) ? plist.json : []).map((p: any) => ({
          id: p.id, name: p.name, live: p.status === 'LIVE', filter: p.filter ?? '',
          // gav://group/asset/version: the asset's name is enough to recognise a ruleset.
          rulesets: (p.rulesets ?? []).map((r: { version?: string; uri?: string }) => (r.version ?? r.uri ?? '').replace(/^gav:\/\/[^/]+\//, '').replace('/', ' ')),
          ...(counts.get(p.id) ?? { total: 0, pass: 0, fail: 0 }),
        }));
        governance = profiles.some((p) => p.live) ? 'on' : 'empty';
        // A target is one API's version group under the active profiles: urn:ms:{org}:api-project::{assetId}/{versionGroup}.
        const names = new Map<string, string>();
        // Exchange answers an account without its permission with an empty list, not a refusal (proven). APIs that
        // governance knows and Exchange didn't list mean exactly that: their rows come from governance.
        const exchangeEmpty = access.exchange === 'ok' && !apis.length && (targets.json.targets ?? []).length > 0;
        if (exchangeEmpty) { access.exchange = 'denied'; why.exchange = "Exchange listed nothing, though API Governance checks APIs here: this account most likely lacks the Exchange Viewer permission."; }
        for (const t of targets.json.targets ?? []) {
          const m = /^urn:ms:([^:]+):[^:]*::(.+)\/([^/]+)$/.exec(t.id?.id ?? ''); if (!m) continue;
          if (t.owner?.id && t.owner?.label) names.set(t.owner.id, t.owner.label);
          let a = apis.find((y) => y.groupId === m[1] && y.assetId === m[2] && (y.versionGroup === m[3] || !y.versionGroup));
          // Without Exchange, governance is the only list of APIs this account can see: its rows come from here.
          if (!a && access.exchange !== 'ok') {
            a = { groupId: m[1], assetId: m[2], name: t.id?.label || m[2], type: t.targetType ?? 'rest-api', kind: 'api', version: m[3], versionGroup: m[3], stable: true,
              published: 0, byId: t.owner?.id ?? '', by: t.owner?.label ?? '', gov: 'none', pass: 0, fail: 0, rulesets: 0, urn: null, govAt: 0, managed: [], versions: [] };
            apis.push(a);
          }
          if (!a) continue;
          const done = (t.pass ?? 0) + (t.fail ?? 0) + (t.error ?? 0), at = Date.parse(t.time ?? '') || 0;
          Object.assign(a, { urn: t.id.id, pass: t.pass ?? 0, fail: (t.fail ?? 0) + (t.error ?? 0), rulesets: t.total ?? 0, govAt: at,
            // Fewer results than rulesets: Anypoint is still validating it (its console says "In validation 0/2").
            gov: (t.fail ?? 0) + (t.error ?? 0) > 0 ? 'failing' : done < (t.total ?? 0) || !t.total ? 'validating' : 'conformant' });
        }
        for (const a of apis) if (!a.by && names.has(a.byId)) a.by = names.get(a.byId)!;
        const shown = (targets.json.targets ?? []).length, all = targets.json.pageData?.total ?? shown;
        if (shown < all) notes.push(`API Governance listed ${shown} of ${all} governed APIs.`);
      }
    } catch (e) { access.governance = 'error'; why.governance = `API Governance couldn't be read: ${err(e)}.`; }
  }

  // ---------- Environments, then API Manager and Runtime Manager in each (design environments run nothing) ----------
  step('Reading API Manager and Runtime Manager…');
  let environments: Env[] = [];
  const instances: Instance[] = [], apps: App[] = [];
  const envs = await get(`/accounts/api/organizations/${org.id}/environments`).catch(() => null);
  // No environments at all means no permission to see them (every organization has at least one); Anypoint answers
  // that with an empty list as often as with a refusal (proven).
  if (!envs || envs.status >= 300 || !(envs.json?.data ?? []).length) {
    for (const s of ['apimanager', 'runtime'] as const) { access[s] = envs && (denied(envs) || envs.status < 300) ? 'denied' : 'error'; why[s] = envs ? (envs.status < 300 || denied(envs) ? "This account can't see the organization's environments, which API Manager and Runtime Manager need (the View Environment permission)." : said('The environments list', envs)) : "The environments couldn't be read."; }
  } else {
    environments = (envs.json?.data ?? []).map((e: { id: string; name: string; type: string; isProduction?: boolean }) => ({ id: e.id, name: e.name, type: e.type, production: !!e.isProduction || e.type === 'production' }));
    const run = environments.filter((e) => e.type !== 'design');
    const [mgr, rt] = await Promise.all([
      Promise.all(run.map(async (e) => ({ e, r: await get(`/apimanager/api/v1/organizations/${org.id}/environments/${e.id}/apis?limit=500`) }))),
      Promise.all(run.map(async (e) => ({ e, r: await get('/armui/api/v1/applications', { org: org.id, env: e.id }) }))),
    ]);
    const deniedAll = (l: { r: Reply }[]) => l.length > 0 && l.every((x) => denied(x.r));
    if (deniedAll(mgr)) { access.apimanager = 'denied'; why.apimanager = said('API Manager', mgr[0].r); }
    for (const { e, r } of mgr) {
      if (r.status >= 300) { if (access.apimanager === 'ok') notes.push(`API Manager's ${e.name} couldn't be read (${r.status}).`); continue; }
      for (const asset of r.json?.assets ?? []) for (const i of asset.apis ?? []) {
        instances.push({ env: e.name, production: e.production, groupId: asset.groupId ?? '', assetId: asset.assetId ?? '', name: asset.exchangeAssetName ?? asset.assetId ?? '',
          version: i.assetVersion ?? '', label: i.instanceLabel ?? '', status: i.status ?? '', endpoint: i.endpointUri ?? i.endpoint?.uri ?? '', id: String(i.id ?? ''), technology: i.technology ?? '' });
      }
    }
    if (deniedAll(rt)) { access.runtime = 'denied'; why.runtime = said('Runtime Manager', rt[0].r); }
    for (const { e, r } of rt) {
      if (r.status >= 300) { if (access.runtime === 'ok') notes.push(`Runtime Manager's ${e.name} couldn't be read (${r.status}).`); continue; }
      // Each kind of runtime answers on its own: one the subscription lacks (CloudHub 1 on newer organizations) says so, quietly.
      for (const x of r.json?.error ?? []) if (!/entitlement/i.test(`${x.reason ?? ''} ${x.message ?? ''}`)) notes.push(x.status === 401 || x.status === 403 ? `This account can't read ${runtimeLabel(x.targetType)} apps in ${e.name}.` : `Runtime Manager couldn't list ${runtimeLabel(x.targetType)} apps in ${e.name} (${x.status ?? 'no answer'}).`);
      for (const x of r.json?.data ?? []) apps.push(appOf(x, e));
    }
  }
  for (const i of instances) { const a = apis.find((y) => y.assetId === i.assetId && y.groupId === i.groupId); if (a) a.managed.push({ env: i.env, version: i.version, status: i.status }); }
  // API Manager manages APIs that Exchange didn't list: the same empty answer, so the same conclusion.
  if (access.exchange === 'ok' && !apis.length && instances.length) { access.exchange = 'denied'; why.exchange = 'Exchange listed nothing, though API Manager manages APIs here: this account most likely lacks the Exchange Viewer permission.'; }

  const reading: Reading = { org, at: Date.now(), access, why, governance, limit, severity, profiles, apis, environments, instances, apps, notes };
  remember(reading);
  return reading;
}

// Every version of every asset, newest first per asset, with the publisher's name: one query a page. Throws the
// reply when Anypoint refuses, so the caller can tell "not allowed" from "the Graph API isn't answering".
async function fromGraph(org: string, step: (t: string) => void): Promise<Api[]> {
  type G = { groupId: string; assetId: string; version: string; versionGroup: string; name: string; type: string; status: string; createdDate: string; createdBy?: { userName?: string; firstName?: string; lastName?: string } };
  const all: G[] = [];
  for (let offset = 0; offset < 20000; offset += 250) {
    // Development versions come only when every status is asked for by name (proven 2026-11-15).
    const r = await graph(`{ assets(organizationIds: ["${org}"], latestVersionsOnly: false, isGenerated: false, status: [development, published, deprecated], limit: 250, offset: ${offset}) { groupId assetId version versionGroup name type status createdDate createdBy { userName firstName lastName } } }`);
    if (r.status >= 300 || !Array.isArray(r.json?.data?.assets)) throw r;
    all.push(...r.json.data.assets.filter((a: G) => a.groupId === org));
    step(`Reading Exchange… ${all.length} versions`);
    if (r.json.data.assets.length < 250) break;
  }
  // An empty answer isn't trusted: for some permissions the Graph API lists nothing while the REST search lists
  // the assets (proven 2026-11-15 with a real user who had API Manager and Runtime Manager only). Throwing the
  // (200) reply sends read() to the search.
  if (!all.length) throw { status: 200, json: null, text: 'The Graph API listed nothing.' };
  const byAsset = new Map<string, G[]>();
  for (const v of all) { const k = `${v.groupId}/${v.assetId}`; byAsset.set(k, [...(byAsset.get(k) ?? []), v]); }
  return [...byAsset.values()].map((vs) => {
    vs.sort((a, b) => cmpVersion(b.version, a.version));
    // The asset's current version, as Exchange shows it: the newest Stable one, or the newest at all when none is Stable yet.
    const latest = vs.find((v) => v.status === 'published') ?? vs.find((v) => v.status !== 'deprecated') ?? vs[0];
    const who = (v: G) => [v.createdBy?.firstName, v.createdBy?.lastName].filter(Boolean).join(' ') || v.createdBy?.userName || '';
    return {
      groupId: latest.groupId, assetId: latest.assetId, name: latest.name || latest.assetId, type: latest.type ?? '', kind: kindOf(latest.type ?? ''),
      version: latest.version, versionGroup: latest.versionGroup ?? '', stable: latest.status !== 'development',
      published: Date.parse(latest.createdDate) || 0, byId: '', by: who(latest),
      gov: 'none' as Gov, pass: 0, fail: 0, rulesets: 0, urn: null, govAt: 0, managed: [],
      versions: vs.map((v) => ({ version: v.version, status: v.status, created: Date.parse(v.createdDate) || 0, by: who(v) })),
    };
  });
}

// Exchange's REST search: each asset's latest version; who published the rest is read later (details).
async function fromSearch(org: string, step: (t: string) => void, notes: string[]): Promise<Api[]> {
  const assets: any[] = [];
  for (let offset = 0; offset < 5000; offset += 100) {
    const r = await get(`/exchange/api/v2/assets/search?organizationId=${org}&limit=100&offset=${offset}`);
    if (r.status >= 300 || !Array.isArray(r.json)) { if (!offset) throw r; notes.push(`Exchange stopped after ${assets.length} assets (${r.status}).`); break; }
    assets.push(...r.json.filter((a) => a.groupId === org || a.organizationId === org));
    step(`Reading Exchange… ${assets.length} assets`);
    if (r.json.length < 100) break;
  }
  return assets.map((a) => ({
    groupId: a.groupId, assetId: a.assetId, name: a.name || a.assetId, type: a.type ?? '', kind: kindOf(a.type ?? ''),
    version: a.version ?? '', versionGroup: a.versionGroup ?? '', stable: a.status !== 'development',
    published: Date.parse(a.createdAt ?? a.createdDate ?? '') || 0, byId: a.createdById ?? '', by: '',
    gov: 'none', pass: 0, fail: 0, rulesets: 0, urn: null, govAt: 0, managed: [],
  }));
}

// Runtime Manager's list covers every kind of runtime. Its fields differ by kind, so each is read where it may be.
const runtimeLabel = (t?: string) => ({ MC: 'CloudHub 2', CLOUDHUB: 'CloudHub', SERVER: 'Hybrid', SERVER_GROUP: 'Hybrid', CLUSTER: 'Hybrid', RTF: 'Runtime Fabric', RUNTIME_FABRIC: 'Runtime Fabric' } as Record<string, string>)[String(t ?? '').toUpperCase()] ?? (t ? String(t) : 'Runtime');
function appOf(x: any, e: Env): App {
  const t = x.target ?? {};
  const kind = t.provider === 'MC' ? (/fabric/i.test(t.type ?? t.subtype ?? '') ? 'RTF' : 'MC') : t.type ?? x.targetType ?? x.type;
  const status = String(x.application?.status ?? x.lastReportedStatus ?? x.applicationStatus ?? x.status ?? x.state ?? '');
  return {
    env: e.name, production: e.production, name: x.name ?? x.artifact?.name ?? x.domain ?? '', runtime: runtimeLabel(kind), status: status.replace(/_/g, ' ').toLowerCase(),
    health: /^(RUNNING|STARTED|DEPLOYED|APPLIED)$/i.test(status) ? 'up' : /FAIL|STOPPED|UNDEPLOY|NOT_RUNNING|ERROR|DISCONNECTED/i.test(status) ? 'down' : 'other',
    // Hybrid (seen on a real org): target.runtimeVersion and artifact.lastUpdateTime, in milliseconds.
    mule: String(x.currentRuntimeVersion ?? t.runtimeVersion ?? x.muleVersion?.version ?? x.muleVersion ?? x.runtimeVersion ?? ''),
    updated: ((v) => typeof v === 'number' ? v : Date.parse(v ?? '') || 0)(x.artifact?.lastUpdateTime ?? x.lastModifiedDate ?? x.lastUpdateTime ?? x.lastModified ?? x.updated),
    url: x.publicUrl ?? t.deploymentSettings?.http?.inbound?.publicUrl ?? (x.fullDomain ? `https://${x.fullDomain}` : ''),
  };
}

// Who published each version, when the Graph API couldn't say: the asset's own Exchange record, a few at a time in
// the background, newest first. tick is called as each lands. Stops when alive() says the screen moved on.
export async function details(apis: Api[], tick: () => void, alive: () => boolean) {
  // Exchange names a publisher by user name, governance by their own name. Where one asset has both, the pair is
  // learnt, and everyone is shown by their own name wherever it's known.
  const known = new Map<string, string>();
  const queue = [...apis].filter((a) => !a.versions).sort((a, b) => b.published - a.published);
  if (!queue.length) return;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let a = queue.shift(); a && alive(); a = queue.shift()) {
      try {
        const v = await assetVersions(a.groupId, a.assetId, a.version);
        a.versions = v?.versions ?? [];
        const latest = a.versions.find((x) => x.version === a.version) ?? a.versions[0];
        if (latest?.by && a.by && a.by !== latest.by) known.set(latest.by, a.by); else if (latest?.by) a.by = latest.by;
      } catch { a.versions = []; }
      tick();
    }
  }));
  for (const a of apis) { a.by = known.get(a.by) ?? a.by; for (const v of a.versions ?? []) v.by = known.get(v.by) ?? v.by; }
  tick();
}

// ---------- A published version's spec: downloaded once into the app's cache, read by AMF ----------
type Model = Parameters<typeof compareModels>[0];
export type Counts = { endpoints: number; operations: number; methods: Record<string, number>; types: number };
const models = new Map<string, Promise<{ model: Model; dir: string }>>();
export function versionModel(a: Pick<Api, 'groupId' | 'assetId'>, version: string, stable: boolean) {
  const k = `${a.groupId}/${a.assetId}/${version}`;
  if (!models.has(k)) models.set(k, (async () => {
    const root = `${(await appCacheDir()).replace(/\\/g, '/').replace(/\/$/, '')}/dashboard/${a.groupId}/${a.assetId}`;
    const dir = `.apidesigner/published/${version}`;
    // A Stable version never changes, so one download is enough; a Development one can be republished.
    const have = stable && await invoke<{ files: unknown[] }>('open_project', { root: `${root}/${dir}` }).then((p) => p.files.length > 0, () => false);
    if (!have) await invoke('anypoint_fetch_dependency', { root, group: a.groupId, asset: a.assetId, version, published: true });
    const files = (await invoke<{ files: { path: string }[] }>('open_project', { root: `${root}/${dir}` })).files.map((f) => f.path);
    let main = '';
    try { main = JSON.parse(await invoke<string>('read_text_file', { root, path: `${dir}/exchange.json` })).main ?? ''; } catch { /* no exchange.json in the zip */ }
    main = main.replace(/^\//, '');
    if (!files.includes(main)) main = files.find((f) => !f.includes('/') && /\.(raml|ya?ml|json)$/i.test(f) && f !== 'exchange.json') ?? '';
    if (!main) throw new Error(`${a.assetId} ${version} has no specification to read.`);
    const r = await invoke<{ model: Model }>('amf', { op: 'modelOf', args: { dir: `${root}/${dir}`, main } });
    return { model: r.model, dir: `${root}/${dir}` };
  })());
  const p = models.get(k)!;
  p.catch(() => models.delete(k)); // a failure (offline, say) is tried again next time
  return p;
}
export function counts(m: Model): Counts {
  const methods: Record<string, number> = {};
  for (const e of m.endpoints ?? []) for (const o of e.operations ?? []) methods[o.method.toUpperCase()] = (methods[o.method.toUpperCase()] ?? 0) + 1;
  return { endpoints: (m.endpoints ?? []).filter((e) => e.operations?.length).length, operations: Object.values(methods).reduce((a, b) => a + b, 0), methods, types: (m.types ?? []).filter((t) => t.name).length };
}
// The counts for the table, a couple of APIs at a time in the background (Stable versions are kept on this computer).
export async function countAll(apis: Api[], tick: () => void, alive: () => boolean) {
  const queue = apis.filter((a) => a.kind === 'api' && a.counts === undefined && a.version).sort((a, b) => b.published - a.published);
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (let a = queue.shift(); a && alive(); a = queue.shift()) {
      const key = `ads.dash.counts:${a.groupId}/${a.assetId}/${a.version}`;
      let c: Counts | null = null;
      try { c = a.stable ? JSON.parse(localStorage.getItem(key) || 'null') : null; } catch { /* none kept */ }
      if (!c) {
        try { c = counts((await versionModel(a, a.version, a.stable)).model); if (a.stable) try { localStorage.setItem(key, JSON.stringify(c)); } catch { /* full */ } }
        catch { c = null; }
      }
      a.counts = c; tick();
    }
  }));
}
// What changed from one published version to another, with the version number's promise checked: a breaking
// change published as a minor or patch version is flagged.
export async function changes(a: Api, from: Version, to: Version) {
  const [o, n] = await Promise.all([versionModel(a, from.version, from.status !== 'development'), versionModel(a, to.version, to.status !== 'development')]);
  // Types are matched by file and name: each version's files sit in their own folder, so the folder is taken off.
  const local = (m: Model, dir: string): Model => ({ ...m, types: (m.types ?? []).map((t) => ({ ...t, at: t.at && { ...t.at, file: (t.at.file ?? '').replace(/\\/g, '/').replace(new RegExp('^' + dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/?', 'i'), '') } })) });
  const r = compareModels(local(o.model, o.dir), local(n.model, n.dir), '');
  const [x, y] = [from.version, to.version].map((v) => v.split(/[.-]/).map(Number));
  const bump = x[0] !== y[0] ? 'major' : x[1] !== y[1] ? 'minor' : 'patch';
  return { changes: r.changes as Change[], needs: r.part, bump, flagged: r.part === 'major' && bump !== 'major' && x[0] >= 1 };
}

// ---------- Health: a GET to a URL the person saved, timed. Only when they press Check, never on a timer ----------
export type Check = { ok: boolean; code: number | null; ms: number; at: number; note: string };
export async function check(url: string): Promise<Check> {
  const t0 = performance.now();
  try {
    await invoke<string>('fetch_url', { url });
    return { ok: true, code: 200, ms: Math.round(performance.now() - t0), at: Date.now(), note: '' };
  } catch (e) {
    const t = err(e), code = Number(/answered (\d{3})/.exec(t)?.[1]) || null;
    return { ok: false, code, ms: Math.round(performance.now() - t0), at: Date.now(), note: code ? '' : t.replace(/^Couldn't fetch it: /, '') };
  }
}
const healthKey = (org: string) => `ads.dash.health:${org}`;
export type Saved = Record<string, { url: string; last?: Check }>;
export function savedHealth(org: string): Saved { try { return JSON.parse(localStorage.getItem(healthKey(org)) || '{}'); } catch { return {}; } }
export function saveHealth(org: string, s: Saved) { try { localStorage.setItem(healthKey(org), JSON.stringify(s)); } catch { /* not kept */ } }

// One API's conformance report: ruleset by ruleset, each failing rule with its message and the place in the spec.
export type Report = { status: string; rulesets: { name: string; version: string; status: string; aspect: string; rules: { id: string; message: string; severity: string; places: string[] }[] }[] };
export async function report(urn: string): Promise<Report> {
  const r = await get(`/governance/xapi/api/v1/report/summary?urn=${encodeURIComponent(urn)}`);
  if (r.status >= 300 || !r.json) throw new Error(denied(r) ? "This account isn't allowed to read API Governance's reports." : `The conformance report couldn't be read (${r.status}).`);
  return {
    status: r.json.status ?? '',
    rulesets: (r.json.aspects ?? []).flatMap((a: any) => (a.rulesets ?? []).map((s: any) => ({
      name: s.ruleset?.name ?? s.ruleset?.assetId ?? '', version: s.ruleset?.version ?? '', status: s.status ?? '', aspect: a.aspect?.label ?? '',
      rules: (s.rules ?? []).map((x: any) => ({
        id: x.rule?.id ?? '', severity: x.severity ?? '',
        message: (x.occurrences?.[0]?.message ?? x.rule?.message ?? '').replace(/^null /, 'It '),
        // ...#/web-api/endpoint/%2Fmemes/supportedOperation/get/...: the part after # reads as a path into the API.
        places: (x.occurrences ?? []).map((o: { location?: string }) => place(o.location ?? '')),
      })),
    }))),
  };
}
function place(location: string) {
  const parts = (location.split('#')[1] ?? '').split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], next = parts[i + 1];
    if (p === 'endpoint' && next) { out.push(next); i++; }
    else if (p === 'supportedOperation' && next) { out.push(next.toUpperCase()); i++; }
    else if (p === 'returns' && next) { out.push(`response ${next}`); i++; }
    else if ((p === 'parameter' || p === 'header' || p === 'query' || p === 'payload') && next && !['parameter', 'header'].includes(next)) { out.push(`${p} ${next}`); i++; }
    else if (/\//.test(p)) out.push(p);
  }
  return out.join(' · ') || 'the API as a whole';
}

// ---------- What the tiles and lists count ----------
export const DAY = 86400000;
export function summary(r: Reading) {
  const apis = r.apis.filter((a) => a.kind === 'api');
  const governed = apis.filter((a) => a.gov !== 'none');
  const by = (k: Gov) => apis.filter((a) => a.gov === k).length;
  const kinds = new Map<string, number>(); for (const a of apis) kinds.set(kindLabel(a.type), (kinds.get(kindLabel(a.type)) ?? 0) + 1);
  const prodApps = r.apps.filter((a) => a.production);
  return {
    apis: apis.length, fragments: r.apis.filter((a) => a.kind === 'fragment').length, others: r.apis.filter((a) => a.kind === 'other').length,
    kinds: [...kinds].sort((a, b) => b[1] - a[1]),
    governed: governed.length, conformant: by('conformant'), failing: by('failing'), validating: by('validating'),
    recent: apis.filter((a) => a.published && r.at - a.published < 30 * DAY).length, stale: apis.filter((a) => a.published && r.at - a.published > 365 * DAY).length,
    development: apis.filter((a) => !a.stable).length, managed: apis.filter((a) => a.managed.length).length,
    apps: r.apps.length, appsUp: r.apps.filter((a) => a.health === 'up').length, appsDown: r.apps.filter((a) => a.health === 'down'),
    prodApps: prodApps.length, prodDown: prodApps.filter((a) => a.health === 'down').length, instances: r.instances.length,
  };
}

// ---------- The trend: one reading a day per organization, kept on this computer (Anypoint keeps no history) ----------
export type Point = { d: string; apis: number; governed: number; conformant: number; failing: number };
const key = (org: string) => `ads.dash.history:${org}`;
export function history(org: string): Point[] { try { return JSON.parse(localStorage.getItem(key(org)) || '[]'); } catch { return []; } }
function remember(r: Reading) {
  if (r.access.governance !== 'ok' || r.access.exchange !== 'ok') return; // half a reading would draw a false dip
  const s = summary(r), d = new Date(r.at).toISOString().slice(0, 10);
  const list = [...history(r.org.id).filter((p) => p.d !== d), { d, apis: s.apis, governed: s.governed, conformant: s.conformant, failing: s.failing }].slice(-180);
  try { localStorage.setItem(key(r.org.id), JSON.stringify(list)); } catch { /* no storage: no trend */ }
}

// ---------- Export: the rows as they're shown, for a spreadsheet ----------
export const GOV_LABEL: Record<Gov, string> = { conformant: 'Conformant', failing: 'Not conformant', validating: 'In validation', none: 'Not governed' };
const cell = (s: string | number) => { const t = String(s); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function csv(apis: Api[]) {
  const head = ['Name', 'Asset ID', 'Kind', 'Latest version', 'Stage', 'Last published', 'Published by', 'Governance', 'Rulesets passing', 'Rulesets failing', 'Endpoints', 'Operations', 'Managed in'];
  const rows = apis.map((a) => [a.name, a.assetId, kindLabel(a.type), a.version, a.stable ? 'Stable' : 'Development', a.published ? new Date(a.published).toISOString().slice(0, 10) : '', a.by,
    GOV_LABEL[a.gov], a.gov === 'none' ? '' : a.pass, a.gov === 'none' ? '' : a.fail, a.counts?.endpoints ?? '', a.counts?.operations ?? '', a.managed.map((m) => `${m.env} ${m.version}`.trim()).join('; ')]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function csvApps(apps: App[]) {
  const head = ['Name', 'Environment', 'Production', 'Runtime', 'Status', 'Mule version', 'Last changed', 'URL'];
  const rows = apps.map((a) => [a.name, a.env, a.production ? 'Yes' : 'No', a.runtime, a.status, a.mule, a.updated ? new Date(a.updated).toISOString().slice(0, 10) : '', a.url]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
