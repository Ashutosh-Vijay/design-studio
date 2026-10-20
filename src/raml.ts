// A fast line-based reading of RAML: the outline (tree, autocomplete) and the shelf's context.
// It runs on every cursor move and edit, so it never waits on AMF. AMF still has the final word on errors.

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
export const BUILTIN_TYPES = ['string', 'number', 'integer', 'boolean', 'date-only', 'time-only', 'datetime', 'datetime-only', 'file', 'object', 'array', 'any', 'nil'];

// One "key:" line. Handles "key : value" (a corpus quirk) and "- key:" list items.
// A YAML key: quoted, or plain. In YAML a # starts a comment only after whitespace, so keys like
// /#X-Amz-Target=... (AWS's OpenAPI specs) are keys, not comments (seen 2026-10-20 in the public corpus).
const KEY_RE = /^(\s*)(- )?("[^"]*"|'[^']*'|[^\s#:](?:[^:\s]|[ \t]+(?=[^\s#:]))*?)\s*:(?:\s+(.*))?$/;
export type Entry = { line: number; ind: number; key: string; val: string; from: number; dash: boolean }; // dash: the key opens a "- " list item

// The shelf, breadcrumb, tree selection and Inspector all read the same text after each keystroke: parse it once.
let lastText = '', lastEntries: Entry[] = [];
export function entries(text: string): Entry[] {
  if (text === lastText) return lastEntries;
  lastEntries = parseEntries(text); lastText = text;
  return lastEntries;
}
function parseEntries(text: string): Entry[] {
  const out: Entry[] = [];
  let pos = 0, block = -1; // inside a | or > text block: lines indented deeper than its key are text, not keys
  for (const [i, l] of text.split('\n').entries()) {
    if (block >= 0 && (!l.trim() || l.match(/^\s*/)![0].length > block)) { pos += l.length + 1; continue; }
    block = -1;
    const m = l.match(KEY_RE);
    if (m && !l.trimStart().startsWith('#')) {
      const ind = m[1].length + (m[2] ? 2 : 0);
      const val = (m[4] || '').replace(/\s+#.*$/, '').trim();
      out.push({ line: i, ind, key: m[3].replace(/^["']|["']$/g, ''), val, from: pos + ind, dash: !!m[2] });
      if (/^[|>][-+0-9]*$/.test(val)) block = ind;
    }
    pos += l.length + 1;
  }
  return out;
}
export function kids(E: Entry[], k: number): number[] {
  if (k < 0 || k >= E.length) return []; // a key that isn't there has no children
  const out: number[] = []; let ci: number | null = null;
  for (let j = k + 1; j < E.length; j++) {
    if (E[j].ind <= E[k].ind) break;
    if (ci === null) ci = E[j].ind;
    if (E[j].ind === ci) out.push(j);
  }
  return out;
}
export const kid = (E: Entry[], k: number, key: string) => kids(E, k).find((j) => E[j].key === key);
const topIndex = (E: Entry[], key: string) => E.findIndex((e) => e.ind === 0 && e.key === key);

export type Method = { kind: 'method'; id: string; m: string; path: string; name: string; from: number };
export type Resource = { kind: 'res'; id: string; key: string; path: string; from: number; methods: Method[]; children: Resource[] };
export type Decl = { kind: 'type' | 'trait' | 'rt' | 'sec'; id: string; name: string; alias: string | null; file: string; from: number };
export type Library = { alias: string; path: string };
export type Outline = { resources: Resource[]; types: Decl[]; traits: Decl[]; resourceTypes: Decl[]; securitySchemes: Decl[]; libraries: Library[] };

// Library paths in uses: can be relative to the root file or start with / (project root).
export function libraryPaths(rootPath: string, rootText: string): Library[] {
  const E = entries(rootText), u = topIndex(E, 'uses');
  if (u < 0) return [];
  const dir = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';
  return kids(E, u).map((j) => ({ alias: E[j].key, path: E[j].val.startsWith('/') ? E[j].val.slice(1) : normalizePath(dir + E[j].val) }));
}
export function normalizePath(p: string) {
  const out: string[] = [];
  for (const part of p.split('/')) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return out.join('/');
}

function declsOf(text: string, file: string, alias: string | null, key: string, kind: Decl['kind']): Decl[] {
  const E = entries(text), t = topIndex(E, key);
  if (t < 0) return [];
  return kids(E, t).map((j) => ({ kind, id: `${kind}:${alias ? alias + '.' : ''}${E[j].key}`, name: E[j].key, alias, file, from: E[j].from }));
}

export function buildOutline(rootPath: string, rootText: string, libTexts: Map<string, string>): Outline {
  const E = entries(rootText);
  const walk = (k: number, parent: string): Resource => {
    const path = parent + E[k].key;
    const r: Resource = { kind: 'res', id: 'res:' + path, key: E[k].key, path, from: E[k].from, methods: [], children: [] };
    for (const j of kids(E, k)) {
      if (E[j].key.startsWith('/')) r.children.push(walk(j, path));
      else if (METHODS.includes(E[j].key)) {
        const dn = kid(E, j, 'displayName');
        r.methods.push({ kind: 'method', id: `m:${E[j].key}:${path}`, m: E[j].key, path, name: dn != null ? E[dn].val : '', from: E[j].from });
      }
    }
    return r;
  };
  const resources = E.flatMap((e, k) => (e.ind === 0 && e.key.startsWith('/') ? [walk(k, '')] : []));
  const libraries = libraryPaths(rootPath, rootText);
  const types = [...declsOf(rootText, rootPath, null, 'types', 'type')];
  const traits = [...declsOf(rootText, rootPath, null, 'traits', 'trait')];
  const resourceTypes = [...declsOf(rootText, rootPath, null, 'resourceTypes', 'rt')];
  const securitySchemes = [...declsOf(rootText, rootPath, null, 'securitySchemes', 'sec')];
  for (const lib of libraries) {
    const text = libTexts.get(lib.path); if (text == null) continue;
    types.push(...declsOf(text, lib.path, lib.alias, 'types', 'type'));
    traits.push(...declsOf(text, lib.path, lib.alias, 'traits', 'trait'));
    resourceTypes.push(...declsOf(text, lib.path, lib.alias, 'resourceTypes', 'rt'));
    securitySchemes.push(...declsOf(text, lib.path, lib.alias, 'securitySchemes', 'sec'));
  }
  return { resources, types, traits, resourceTypes, securitySchemes, libraries };
}

// The same outline for an OAS 3.0 YAML file: paths and their operations, components schemas and security schemes.
export function buildOasOutline(file: string, text: string): Outline {
  const E = entries(text), p = topIndex(E, 'paths'), c = topIndex(E, 'components');
  const resources: Resource[] = p < 0 ? [] : kids(E, p).filter((j) => E[j].key.startsWith('/')).map((j) => ({
    kind: 'res', id: 'res:' + E[j].key, key: E[j].key, path: E[j].key, from: E[j].from, children: [],
    methods: kids(E, j).filter((x) => METHODS.includes(E[x].key)).map((x) => {
      const s = kid(E, x, 'summary');
      return { kind: 'method', id: `m:${E[x].key}:${E[j].key}`, m: E[x].key, path: E[j].key, name: s != null ? E[s].val : '', from: E[x].from };
    }),
  }));
  const decls = (key: string, kind: Decl['kind']): Decl[] => {
    const s = c < 0 ? undefined : kid(E, c, key);
    return s == null ? [] : kids(E, s).map((j) => ({ kind, id: `${kind}:${E[j].key}`, name: E[j].key, alias: null, file, from: E[j].from }));
  };
  return { resources, types: decls('schemas', 'type'), traits: [], resourceTypes: [], securitySchemes: decls('securitySchemes', 'sec'), libraries: [] };
}

// The keys around a line, outermost first (for selecting the tree node under the cursor).
export function keyPathAt(text: string, line: number): Entry[] {
  const E = entries(text), at = new Map(E.map((e) => [e.line, e]));
  const out: Entry[] = []; let cur = Infinity;
  for (let i = line; i >= 0; i--) {
    const e = at.get(i); if (!e) continue;
    if (i === line || e.ind < cur) { out.unshift(e); cur = e.ind; if (cur === 0) break; }
  }
  return out;
}

// ---------- The shelf: what can go at the cursor, Design Center's columns ----------
export type ShelfCol = { title: string; items: string[] };
export type ShelfCtx =
  | { kind: 'type'; line: number; label: string; value: string }
  | { kind: 'is'; line: number; label: string; value: string }
  | { kind: 'keys'; cols: ShelfCol[]; label: string; container: number; E: Entry[] }
  | { kind: 'none'; label: string };

const SHELF: Record<string, [string, string[]][]> = {
  // Design Center's own columns at the top level.
  root: [['Template', ['New documentation']], ['Types and Traits', ['annotationTypes', 'resourceTypes', 'traits', 'types']], ['Root', ['baseUri', 'mediaType', 'protocols', 'version']], ['Parameters', ['baseUriParameters']], ['Docs', ['title', 'description', 'documentation']], ['Security', ['securitySchemes', 'securedBy']], ['Others', ['uses']]],
  // A library has declarations only: no resources, title or baseUri.
  library: [['Types and Traits', ['types', 'traits', 'resourceTypes', 'annotationTypes']], ['Security', ['securitySchemes']], ['Docs', ['usage']], ['Others', ['uses']]],
  resource: [['Methods', METHODS], ['Docs', ['description', 'displayName']], ['Types and Traits', ['is', 'type']], ['Security', ['securedBy']], ['Parameters', ['uriParameters']]],
  method: [['Docs', ['description', 'displayName']], ['Types and Traits', ['is']], ['Security', ['securedBy']], ['Parameters', ['queryParameters', 'headers', 'queryString']], ['Body', ['body']], ['Responses', ['responses']], ['Protocols', ['protocols']]],
  responses: [['Success', ['200', '201', '202', '204']], ['Client errors', ['400', '401', '403', '404', '409', '422']], ['Server errors', ['500', '502', '503']]],
  response: [['Docs', ['description']], ['Body', ['body']], ['Headers', ['headers']]],
  body: [['Media types', ['application/json', 'application/xml', 'text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded']]],
  media: [['Types and Examples', ['type', 'example', 'examples']]],
};
// Keys that take a value on the same line, so the cursor lands after "key: ".
export const SCALAR_KEYS = ['title', 'usage', 'version', 'baseUri', 'mediaType', 'description', 'displayName', 'type', 'example', 'securedBy', 'protocols', 'is'];

export function shelfContext(text: string, line: number, col: number): ShelfCtx {
  const E = entries(text), L = text.split('\n');
  const here = E.findIndex((e) => e.line === line);
  // The type or trait list only when picking a value: the value is empty, or the cursor is after the colon.
  // On the key itself of a line that already has a value, the shelf shows its block's keys instead.
  const picking = here >= 0 && (!E[here].val || col > (L[line] ?? '').indexOf(':', E[here].ind));
  if (picking && (E[here].key === 'type' || E[here].key === 'items')) return { kind: 'type', line, label: E[here].key, value: E[here].val };
  if (picking && E[here].key === 'is') return { kind: 'is', line, label: 'is', value: E[here].val };
  let ck = -1;
  if (here >= 0 && !E[here].val) ck = here; // on a block key: suggest what goes inside it
  else if (here >= 0) { for (let j = here - 1; j >= 0; j--) if (E[j].ind < E[here].ind) { ck = j; break; } }
  else {
    const t = L[line] ?? '';
    const ind = t.trim() ? t.match(/^\s*/)![0].length : col;
    for (let j = E.length - 1; j >= 0; j--) if (E[j].line < line && E[j].ind < ind) { ck = j; break; }
  }
  const key = ck >= 0 ? E[ck].key : null;
  // Fragments (#%RAML 1.0 Library, DataType, Trait...): a library gets its own keys; the others are a single
  // declaration, so there's nothing to add at their top level.
  const frag = /^(\uFEFF)?#%RAML 1\.0 (\w+)/.exec(text)?.[2];
  const kind = ck < 0 ? (!frag || frag === 'Overlay' || frag === 'Extension' ? 'root' : frag === 'Library' ? 'library' : null) : key!.startsWith('/') ? 'resource' : METHODS.includes(key!) ? 'method' : key === 'responses' ? 'responses'
    : /^\d{3}$/.test(key!) ? 'response'
    // A body that names its type directly (the default media type) takes type and examples, not media types.
    : key === 'body' ? (kids(E, ck).some((j) => ['type', 'example', 'examples', 'properties', 'schema'].includes(E[j].key)) ? 'media' : 'body')
    : key!.includes('/') ? 'media' : null;
  const label = ck < 0 ? 'top level' : keyPathAt(text, E[ck].line).map((e) => e.key).join(' › ');
  if (!kind) return { kind: 'none', label };
  const have = new Set((ck < 0 ? E.filter((e) => e.ind === 0) : kids(E, ck).map((j) => E[j])).map((e) => e.key));
  const cols = SHELF[kind].map(([title, items]) => ({ title, items: items.filter((i) => !have.has(i) && !(i === 'New documentation' && have.has('documentation'))) })).filter((c) => c.items.length);
  return { kind: 'keys', cols, label, container: ck, E };
}

// Where and what to insert for a shelf item. Returns the change and where the cursor goes.
export function shelfEdit(text: string, line: number, ctx: ShelfCtx, item: string): { from: number; to: number; insert: string; cursor: number } | null {
  const L = text.split('\n');
  const lineStart = (n: number) => L.slice(0, n).reduce((a, l) => a + l.length + 1, 0);
  if (ctx.kind === 'type') {
    const s = lineStart(line), l = L[line], c = l.indexOf(':') + 1;
    const insert = ' ' + item;
    return { from: s + c, to: s + l.length, insert, cursor: s + c + insert.length };
  }
  if (ctx.kind === 'is') {
    const s = lineStart(line), l = L[line];
    const cur = (l.match(/\[(.*)\]/) || ['', ''])[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (cur.includes(item)) return null;
    const c = l.indexOf(':') + 1, insert = ` [ ${[...cur, item].join(', ')} ]`;
    return { from: s + c, to: s + l.length, insert, cursor: s + c + insert.length };
  }
  if (ctx.kind !== 'keys') return null;
  const E = ctx.E, ck = ctx.container;
  const first = ck >= 0 ? kids(E, ck)[0] : undefined;
  const ind = ck < 0 ? 0 : first != null ? E[first].ind : E[ck].ind + 2;
  const keyText = item === 'New documentation'
    ? 'documentation:\n  - title: \n    content: '
    : ' '.repeat(ind) + item + ':' + (SCALAR_KEYS.includes(item) ? ' ' : '');
  if (!(L[line] ?? '').trim()) { const s = lineStart(line); return { from: s, to: s + L[line].length, insert: keyText, cursor: s + keyText.length }; }
  // Otherwise at the end of the container's block, so siblings stay in reading order.
  let end = L.length;
  if (ck >= 0) { for (let j = ck + 1; j < E.length; j++) if (E[j].ind <= E[ck].ind) { end = E[j].line; break; } }
  while (end - 1 > (ck >= 0 ? E[ck].line : -1) && !L[end - 1].trim()) end--;
  const at = end >= L.length ? text.length : lineStart(end);
  const insert = end >= L.length ? (text.endsWith('\n') ? '' : '\n') + keyText : keyText + '\n';
  return { from: at, to: at, insert, cursor: at + (end >= L.length ? insert.length : keyText.length) };
}
