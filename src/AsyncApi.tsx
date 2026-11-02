// AsyncAPI 2.x forms: the API (info, contact, licence, servers), a channel with its publish and subscribe, a
// message, a security scheme. Schemas use the OAS schema form (same JSON Schema, same components.schemas).
// Read with the yaml library (it reads JSON too and keeps positions); every change is a minimal splice of the
// text, YAML through src/splice.ts and JSON through OasJson's editor, so the code stays the master.
import { useMemo, type ReactNode } from 'react';
import { parseDocument, stringify, isMap, isScalar } from 'yaml';
import { Icons } from './components/Icons';
import { Select } from './components/Popup';
import { Field, Sec, AddSelect, IconBtn, ReadOnlyBox, Badge, BTN, MEDIA, SampleCheck, type SampleResult } from './Inspector';
import { entries, keyPathAt } from './raml';
import { jsonSet, jsonRename } from './OasJson';
import * as S from './splice';

const PROTOCOLS = ['kafka', 'kafka-secure', 'amqp', 'amqps', 'mqtt', 'secure-mqtt', 'ws', 'wss', 'jms', 'anypointmq', 'solace', 'ibmmq', 'sns', 'sqs', 'googlepubsub', 'pulsar', 'nats', 'redis', 'stomp', 'stomps', 'http', 'https'];
const SCHEME_TYPES = ['userPassword', 'apiKey', 'X509', 'symmetricEncryption', 'asymmetricEncryption', 'httpApiKey', 'http', 'oauth2', 'openIdConnect', 'plain', 'scramSha256', 'scramSha512', 'gssapi'];
const CONTENT_TYPES = [...MEDIA, 'application/avro', 'application/vnd.apache.avro+json', 'application/octet-stream'];
const MSG = '#/components/messages/', SCH = '#/components/schemas/';
type J = Record<string, unknown>;

// Set (or with undefined, remove) the value at a path, in YAML: a scalar or a list of scalars in place, anything
// else written out as a block where the old one was (or added at the end of its parent).
function yamlSet(text: string, path: string[], value: unknown): string {
  const parent = path.slice(0, -1), key = path[path.length - 1];
  if (value === undefined) return S.remove(text, path, false);
  if (value === null || typeof value !== 'object') return S.setScalar(text, parent, key, String(value), typeof value !== 'string');
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) return S.setList(text, path, value.map(String));
  const body = stringify(value, { lineWidth: 0 }).trimEnd().split('\n');
  const E = entries(text), k = S.find(E, path);
  if (k < 0) return S.addChild(text, parent, [key + ':', ...body.map((l) => '  ' + l)]);
  const L = text.split('\n'), ind = ' '.repeat(E[k].ind + 2);
  L.splice(E[k].line, S.blockEnd(E, L, k) - E[k].line, L[E[k].line].replace(/:(\s.*)?$/, ':'), ...body.map((l) => ind + l));
  return L.join('\n');
}

export function AsyncForms({ text, line, json, readOnly, onEdit, onGoLine, onCopyType, onCheckSample, file }: {
  file: string; text: string; line: number; json: boolean; readOnly: boolean | string;
  onEdit: (fn: (t: string) => string) => void; onGoLine: (line: number) => void;
  onCopyType: (name: string, file: string, as: 'jsonSchema' | 'ramlType') => void; onCheckSample: (name: string, file: string, payload: string) => Promise<SampleResult>;
}) {
  const doc = useMemo(() => parseDocument(text), [text]);
  const js = useMemo(() => { try { return (doc.toJS() ?? {}) as J; } catch { return {} as J; } }, [doc]);
  const kp = useMemo(() => keyPathAt(text, line).map((e) => e.key.replace(/^["']|["']$/g, '')), [text, line]);
  const get = (p: string[]): unknown => p.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as J)[k] : undefined), js);
  const str = (p: string[]) => { const v = get(p); return v == null || typeof v === 'object' ? '' : String(v); };
  const names = (p: string[]) => { const v = get(p); return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []; };
  // Every edit: '' removes the key, as the other forms do.
  const put = (p: string[], v: unknown) => onEdit((t) => (json ? jsonSet(t, p, v === '' ? undefined : v) : yamlSet(t, p, v === '' ? undefined : v)));
  const rename = (p: string[], nu: string) => onEdit((t) => (json ? jsonRename(t, p, nu) : S.renameKey(t, p, nu)));
  // The line a key starts on, for "go to the code".
  const lineOf = (p: string[]) => {
    const m = doc.getIn(p.slice(0, -1), true);
    const pair = isMap(m) ? m.items.find((x) => isScalar(x.key) && String(x.key.value) === p[p.length - 1]) : undefined;
    const off = pair && isScalar(pair.key) && pair.key.range ? pair.key.range[0] : -1;
    return off < 0 ? -1 : text.slice(0, off).split('\n').length - 1;
  };
  const go = (p: string[]) => { const l = lineOf(p); if (l >= 0) onGoLine(l); };
  const free = (base: string, have: string[]) => { let n = base, i = 2; while (have.includes(n)) n = base + i++; return n; };
  const refName = (v: unknown, prefix: string) => { const r = v && typeof v === 'object' ? (v as J).$ref : undefined; return typeof r === 'string' && r.startsWith(prefix) ? r.slice(prefix.length) : null; };

  const messages = names(['components', 'messages']), schemas = names(['components', 'schemas']), schemes = names(['components', 'securitySchemes']);
  const label = (l: string, inner: ReactNode) => <label className="flex items-center gap-2 py-[3px]"><span className="w-[92px] shrink-0 text-[11.5px] text-content-faint">{l}</span>{inner}</label>;
  const txt = (p: string[], l: string, o: { mono?: boolean; options?: string[]; placeholder?: string } = {}) =>
    label(l, <Field value={str(p)} mono={o.mono} options={o.options} placeholder={o.placeholder} onCommit={(v) => put(p, v.trim())} />);
  const desc = (p: string[], placeholder = 'Description') => <div className="mt-1.5"><Field label="Description" multiline value={str(p)} placeholder={placeholder} onCommit={(v) => put(p, v)} /></div>;
  const title = (name: string, kind: string, p: string[], editable = true) => (
    <>
      {editable ? <Field mono value={name} className="!text-[13px] font-bold" onCommit={(v) => { const n = v.trim(); if (n && n !== name) rename(p, n); }} />
        : <span className="font-mono text-[13.5px] font-bold break-all">{name}</span>}
      <div className="mt-1 flex items-center gap-2 text-[12.5px] text-content-secondary">{kind}
        {lineOf(p) >= 0 && <button data-nav onClick={() => go(p)} className="ml-auto font-mono text-[11px] text-content-faint hover:text-accent">{file}:{lineOf(p) + 1}</button>}</div>
    </>
  );
  // A $ref picker: a schema or message by name, or "written in place" when it isn't a $ref.
  const refPick = (p: string[], prefix: string, options: string[], placeholder: string) => {
    const v = get(p), n = refName(v, prefix);
    return (
      <span className="flex items-center gap-0.5 min-w-0 flex-1">
        <Field value={n ?? ''} mono options={options} placeholder={v && !n ? 'written in place' : placeholder}
          onCommit={(x) => { const t = x.trim(); if (!t) put(p, undefined); else if (t !== n) put(p, { $ref: prefix + t }); }}
          className={!n || options.includes(n) ? 'text-[var(--syn-type)]' : 'text-err'} />
        {n && options.includes(n) && <IconBtn nav title={`Go to ${n}`} onClick={() => go(['components', prefix === MSG ? 'messages' : 'schemas', n])}><Icons.ChevronRight size={12} /></IconBtn>}
      </span>
    );
  };

  let h: ReactNode;
  if (kp[0] === 'channels' && kp[1]) {
    const name = kp[1], ch = ['channels', name];
    const params = [...name.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    h = (
      <>
        {title(name, 'Channel', ch)}
        {desc([...ch, 'description'])}
        {params.length > 0 && <Sec title="Parameters" count={params.length}>
          {params.map((pn) => (
            <div key={pn} className="py-[3px] flex flex-col gap-1">
              <div className="flex items-center gap-1.5"><span className="font-mono text-[12px] w-[30%] shrink-0 truncate">{pn}</span>
                <Field mono value={str([...ch, 'parameters', pn, 'schema', 'type'])} options={['string', 'integer', 'number', 'boolean']} ariaLabel="Type" placeholder="string"
                  onCommit={(v) => put([...ch, 'parameters', pn, 'schema'], v.trim() ? { ...((get([...ch, 'parameters', pn, 'schema']) as J) ?? {}), type: v.trim() } : undefined)} /></div>
              <Field value={str([...ch, 'parameters', pn, 'description'])} placeholder={`What ${pn} is`} onCommit={(v) => put([...ch, 'parameters', pn, 'description'], v.trim())} />
            </div>
          ))}
        </Sec>}
        {(['subscribe', 'publish'] as const).map((op) => {
          const o = [...ch, op], has = get(o) != null;
          return (
            <Sec key={op} title={op === 'subscribe' ? 'Subscribe: clients receive these messages' : 'Publish: clients send these messages'}
              add={has ? <IconBtn title={`Remove ${op}`} onClick={() => put(o, undefined)}><Icons.X size={11} /></IconBtn>
                : <button onClick={() => put(o, { operationId: op === 'subscribe' ? 'on' + name.replace(/(^|[^A-Za-z0-9]+)(\w)/g, (_m, _s, c) => c.toUpperCase()) : name.replace(/[^A-Za-z0-9]+(\w)/g, (_m, c) => c.toUpperCase()),
                  ...(messages[0] ? { message: { $ref: MSG + messages[0] } } : { message: { payload: { type: 'object' } } }) })}
                  className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add {op}</button>}>
              {has ? (
                <div className="border border-line rounded-md p-2 bg-bg flex flex-col">
                  <div className="flex items-center gap-2 mb-0.5"><Badge m={op} /><button data-nav onClick={() => go(o)} className="ml-auto font-mono text-[11px] text-content-faint hover:text-accent">{file}:{lineOf(o) + 1}</button></div>
                  {txt([...o, 'operationId'], 'Operation id', { mono: true })}
                  {txt([...o, 'summary'], 'Summary')}
                  {desc([...o, 'description'])}
                  {label('Message', refPick([...o, 'message'], MSG, messages, messages.length ? 'Pick a message' : 'Add a message in the API tree first'))}
                </div>
              ) : <div className="text-[11.5px] text-content-faint">None.</div>}
            </Sec>
          );
        })}
      </>
    );
  } else if (kp[0] === 'components' && kp[1] === 'messages' && kp[2]) {
    const name = kp[2], m = ['components', 'messages', name];
    const payload = refName(get([...m, 'payload']), SCH);
    // Where it's used: every publish and subscribe whose message is this one.
    const uses = names(['channels']).flatMap((c) => (['subscribe', 'publish'] as const).filter((op) => refName(get(['channels', c, op, 'message']), MSG) === name).map((op) => ({ c, op })));
    h = (
      <>
        {title(name, 'Message', m)}
        {payload && <div className="mt-3 flex flex-wrap gap-1.5">
          <button data-nav onClick={() => onCopyType(payload, file, 'jsonSchema')} className={BTN} title="AMF renders the payload schema as JSON Schema and puts it on the clipboard">Copy payload as JSON Schema</button>
        </div>}
        {payload && <SampleCheck key={payload} name={payload} run={(p) => onCheckSample(payload, file, p)} />}
        <Sec title="Message">
          {txt([...m, 'name'], 'Name', { mono: true })}
          {txt([...m, 'title'], 'Title')}
          {txt([...m, 'summary'], 'Summary')}
          {txt([...m, 'contentType'], 'Content type', { mono: true, options: CONTENT_TYPES, placeholder: str(['defaultContentType']) || 'application/json' })}
          {desc([...m, 'description'])}
        </Sec>
        <Sec title="Payload and headers">
          {label('Payload', refPick([...m, 'payload'], SCH, schemas, 'Pick a schema'))}
          {label('Headers', refPick([...m, 'headers'], SCH, schemas, 'None'))}
          {!payload && get([...m, 'payload']) != null && <div className="mt-1 text-[11px] text-content-faint">The payload is written in place. Pick a schema to share it, and to check samples against it.</div>}
        </Sec>
        <Sec title="Used by" count={uses.length}>
          {uses.map(({ c, op }) => (
            <div key={c + op} onClick={() => go(['channels', c, op])} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)]">
              <Badge m={op} /><span className="font-mono text-[11.5px] truncate">{c}</span></div>
          ))}
          {!uses.length && <div className="text-[11.5px] text-content-faint">No channel uses it.</div>}
        </Sec>
      </>
    );
  } else if (kp[0] === 'components' && kp[1] === 'securitySchemes' && kp[2]) {
    const s = ['components', 'securitySchemes', kp[2]], t = str([...s, 'type']);
    h = (
      <>
        {title(kp[2], 'Security scheme', s)}
        <Sec title="Type">
          <Select value={t} onChange={(v) => put([...s, 'type'], v)} mono className="w-full text-[12px]"
            options={(SCHEME_TYPES.includes(t) || !t ? SCHEME_TYPES : [t, ...SCHEME_TYPES]).map((x) => ({ value: x }))} />
        </Sec>
        {desc([...s, 'description'])}
        {(t === 'httpApiKey' || t === 'apiKey' || t === 'http' || t === 'openIdConnect' || t === 'oauth2') && <Sec title="Settings">
          {t === 'httpApiKey' && <>{txt([...s, 'name'], 'Name', { mono: true, placeholder: 'X-API-Key' })}{txt([...s, 'in'], 'In', { mono: true, options: ['header', 'query', 'cookie'] })}</>}
          {t === 'apiKey' && txt([...s, 'in'], 'In', { mono: true, options: ['user', 'password'] })}
          {t === 'http' && <>{txt([...s, 'scheme'], 'Scheme', { mono: true, options: ['bearer', 'basic'] })}{txt([...s, 'bearerFormat'], 'Bearer format', { mono: true, placeholder: 'JWT' })}</>}
          {t === 'openIdConnect' && txt([...s, 'openIdConnectUrl'], 'OpenID URL', { mono: true })}
          {t === 'oauth2' && <div className="text-[11.5px] text-content-faint">OAuth 2.0 flows and scopes: edit them in the code.</div>}
        </Sec>}
      </>
    );
  } else {
    const servers = names(['servers']);
    h = (
      <>
        <span className="text-[13.5px] font-bold">{str(['info', 'title']) || 'Untitled API'}</span>
        <div className="mt-1 text-[12.5px] text-content-secondary">AsyncAPI {str(['asyncapi'])}, {names(['channels']).length} channels, {messages.length} messages, {schemas.length} schemas</div>
        <Sec title="Info">
          {txt(['info', 'title'], 'Title')}
          {txt(['info', 'version'], 'Version', { mono: true })}
          {txt(['defaultContentType'], 'Content type', { mono: true, options: CONTENT_TYPES, placeholder: 'Pick or type one' })}
          {desc(['info', 'description'])}
        </Sec>
        <Sec title="Contact and licence">
          {txt(['info', 'contact', 'name'], 'Contact')}
          {txt(['info', 'contact', 'email'], 'Email', { mono: true })}
          {txt(['info', 'contact', 'url'], 'URL', { mono: true })}
          {txt(['info', 'license', 'name'], 'Licence')}
          {txt(['info', 'license', 'url'], 'Licence URL', { mono: true })}
        </Sec>
        <Sec title="Servers" count={servers.length || undefined}
          add={<button onClick={() => put(['servers', free('production', servers)], { url: 'broker.mycompany.com:9093', protocol: 'kafka-secure' })}
            className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add server</button>}>
          {servers.map((sn) => {
            const sp = ['servers', sn];
            const sec = ((get([...sp, 'security']) as J[] | undefined) ?? []).map((o) => Object.keys(o ?? {})[0]).filter(Boolean);
            const setSec = (list: string[]) => put([...sp, 'security'], list.length ? list.map((x) => ({ [x]: [] })) : undefined);
            return (
              <div key={sn} className="group/r border border-line rounded-md p-2 mb-1.5 bg-bg flex flex-col">
                <div className="flex items-center gap-1"><Field mono value={sn} onCommit={(v) => { const n = v.trim(); if (n && n !== sn) rename(sp, n); }} />
                  <span className="opacity-0 group-hover/r:opacity-100 group-focus-within/r:opacity-100"><IconBtn title="Remove this server" onClick={() => put(sp, undefined)}><Icons.X size={11} /></IconBtn></span></div>
                {txt([...sp, 'url'], 'URL', { mono: true })}
                {txt([...sp, 'protocol'], 'Protocol', { mono: true, options: PROTOCOLS })}
                {desc([...sp, 'description'])}
                <div className="mt-1.5 flex flex-wrap items-center gap-[5px]">
                  {sec.map((x) => <span key={x} className="inline-flex items-center gap-1 h-[22px] pl-2 pr-0.5 rounded font-mono text-[11.5px] text-warn bg-warn-tint">{x}<IconBtn title="Remove" onClick={() => setSec(sec.filter((y) => y !== x))}><Icons.X size={10} /></IconBtn></span>)}
                  {!sec.length && <span className="text-[11.5px] text-content-faint">{schemes.length ? 'Not secured.' : 'Not secured. Add a security scheme in the API tree first.'}</span>}
                  <AddSelect label="Secured by" options={schemes.filter((x) => !sec.includes(x))} onPick={(x) => setSec([...sec, x])} />
                </div>
              </div>
            );
          })}
          {!servers.length && <div className="text-[11.5px] text-content-faint">No servers. Add the broker clients connect to.</div>}
        </Sec>
        <div className="mt-4 text-[11.5px] text-content-faint">Add channels, messages, schemas and security schemes with + in the API tree. Pick one there, or put the cursor in it, to edit it here.</div>
      </>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-3.5 pt-3.5 pb-6 select-none">
      {readOnly && <div className="mb-3 flex items-center gap-1.5 text-[11.5px] text-content-faint"><Icons.Lock size={12} />{typeof readOnly === 'string' ? readOnly : 'Read-only: managed by Exchange'}</div>}
      <ReadOnlyBox readOnly={!!readOnly}>{h}</ReadOnlyBox>
    </div>
  );
}
