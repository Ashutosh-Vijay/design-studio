/**
 * M3 probe, TRIAL ORG ONLY: Exchange dependencies. Publish a library fragment, add it as a dependency of
 * an API project, list the dependencies, and find the asset's downloadable files. Uses the app's saved
 * trial session through the dev app (no secrets here): run with the dev app open, signed in to the trial org.
 *
 *   node deps-probe.mjs
 */
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const ev = (expr) => new Promise((res, rej) => {
  const my = ++id;
  const on = (m) => { const d = JSON.parse(m.data); if (d.id !== my) return; ws.removeEventListener('message', on); if (d.result.exceptionDetails) rej(new Error(d.result.exceptionDetails.exception?.description)); else res(d.result.result.value); };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true } }));
});
const out = await ev(`
  const I = window.__TAURI_INTERNALS__.invoke, api = (m, p, b) => I('anypoint_api', { method: m, path: p, body: b });
  const DC = '/designcenter/api-designer', log = [];
  const me = (await api('GET', '/accounts/api/me')).json.user;
  if (me.organization.name !== 'ashutosh-vijay.dev') return ['not the trial org'];
  const org = me.organizationId, stamp = Date.now();
  // 1. A fragment project with a library, published to Exchange.
  const f = await api('POST', DC + '/projects', { name: 'ads-frag-' + stamp, classifier: 'raml-fragment', subType: 'library' });
  log.push('fragment project: ' + f.status + ' ' + (f.status >= 300 ? f.text.slice(0, 200) : 'keys ' + Object.keys(f.json).join(',')));
  const FB = DC + '/projects/' + f.json.id + '/branches/master';
  log.push('fragment files: ' + JSON.stringify((await api('GET', FB + '/files')).json).slice(0, 300));
  await api('POST', FB + '/acquireLock', {});
  await api('POST', FB + '/save', [{ path: 'common-lib.raml', type: 'FILE', content: '#%RAML 1.0 Library\\ntypes:\\n  Money:\\n    properties:\\n      amount: number\\n      currency: string\\n' }]);
  const assetId = 'ads-frag-' + stamp;
  const pub = await api('POST', FB + '/publish/exchange', { name: assetId, apiVersion: 'v1', version: '1.0.0', main: 'common-lib.raml', assetId, groupId: org, classifier: 'raml-fragment' });
  log.push('publish fragment: ' + pub.status + ' ' + pub.text.slice(0, 200));
  await api('POST', FB + '/releaseLock', {});
  // 2. The asset's files.
  let asset = null;
  for (let i = 0; i < 8 && !asset; i++) { const a = await api('GET', '/exchange/api/v2/assets/' + org + '/' + assetId + '/1.0.0'); if (a.status === 200) asset = a.json; else await new Promise((r) => setTimeout(r, 4000)); }
  log.push('asset files: ' + JSON.stringify((asset?.files ?? []).map((x) => ({ classifier: x.classifier, packaging: x.packaging, link: (x.externalLink || '').slice(0, 60), md5: x.md5 }))));
  // 3. An API project that depends on it.
  const p = await api('POST', DC + '/projects', { name: 'ads-dep-' + stamp, classifier: 'raml' });
  const PB = DC + '/projects/' + p.json.id + '/branches/master';
  await api('POST', PB + '/acquireLock', {});
  for (const body of [{ groupId: org, assetId, version: '1.0.0' }, [{ groupId: org, assetId, version: '1.0.0' }]]) {
    for (const m of ['POST', 'PUT']) {
      const r = await api(m, PB + '/exchange/dependencies', body);
      log.push('add dependency ' + m + ' ' + (Array.isArray(body) ? '[...]' : '{...}') + ' -> ' + r.status + ' ' + r.text.slice(0, 160));
      if (r.status < 300) break;
    }
  }
  log.push('dependencies: ' + JSON.stringify((await api('GET', PB + '/exchange/dependencies')).json).slice(0, 400));
  log.push('project files now: ' + JSON.stringify((await api('GET', PB + '/files')).json.map((x) => x.path)));
  log.push('exchange.json: ' + (await api('GET', PB + '/files/v2/exchange.json')).text.slice(0, 400));
  await api('POST', PB + '/releaseLock', {});
  // 4. Clean up the two projects (the Exchange asset stays; it's a trial org).
  log.push('cleanup: ' + (await api('DELETE', DC + '/projects/' + p.json.id)).status + ' ' + (f.json?.id ? (await api('DELETE', DC + '/projects/' + f.json.id)).status : ''));
  return log;`);
console.log(out.join('\n'));
ws.close();
