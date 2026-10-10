// Form edits as minimal text changes (PLAN 3.1): every function takes the file's text and returns the
// new text, touching only the lines it must. Nodes are found by their key path from the top of the file,
// so an edit never depends on stale positions. The caller turns old and new text into one small change.
import { entries, kids, kid, type Entry } from './raml';

export type Path = string[];

export function find(E: Entry[], path: Path): number {
  let ck = -1;
  for (const key of path) {
    const list = ck < 0 ? E.flatMap((e, i) => (e.ind === 0 ? [i] : [])) : kids(E, ck);
    const j = list.find((i) => E[i].key === key);
    if (j == null) return -1;
    ck = j;
  }
  return ck;
}

// The file's indent step (2 in nearly every spec), from the smallest indent in use.
function step(E: Entry[]) {
  const s = E.map((e) => e.ind).filter((i) => i > 0);
  return s.length ? Math.min(...s) : 2;
}
const childInd = (E: Entry[], k: number) => (kids(E, k)[0] != null ? E[kids(E, k)[0]].ind : (k < 0 ? 0 : E[k].ind + step(E)));

// The line after a node's last line. Trailing blank lines and comments at the node's own level or
// shallower belong to whatever comes next, so they stay where they are.
export function blockEnd(E: Entry[], L: string[], k: number) {
  let end = L.length;
  for (let j = k + 1; j < E.length; j++) if (E[j].ind <= E[k].ind) { end = E[j].line; break; }
  while (end - 1 > E[k].line) {
    const l = L[end - 1];
    if (!l.trim() || (l.trimStart().startsWith('#') && l.match(/^\s*/)![0].length <= E[k].ind)) end--; else break;
  }
  return end;
}

// ---------- Reading values for the forms ----------
export function unquote(v: string) {
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
// Plain when YAML reads it back as the same string, double-quoted otherwise.
export function quote(v: string) {
  if (v === '') return '""';
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^#]*$/.test(v) && !/:\s|\s$|:$/.test(v) && !/^(true|false|null|yes|no|on|off|~|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(v);
  return plain ? v : JSON.stringify(v);
}

// A scalar's text, including | and > blocks.
export function scalar(text: string, path: Path): string | null {
  const E = entries(text), k = find(E, path); if (k < 0) return null;
  const v = E[k].val;
  if (!/^[|>][-+0-9]*$/.test(v)) return unquote(v);
  const L = text.split('\n'), end = blockEnd(E, L, k);
  const body = L.slice(E[k].line + 1, end);
  const ind = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  const lines = body.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
  return v.startsWith('>') ? lines.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : lines.join('\n');
}

// A flow list (is: [a, b], enum: [A, B]) or a block list of "- item" lines.
export function list(text: string, path: Path): string[] | null {
  const E = entries(text), k = find(E, path); if (k < 0) return null;
  const v = E[k].val;
  if (v.startsWith('[')) return v.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s.trim())).filter(Boolean);
  if (v) return [unquote(v)];
  const L = text.split('\n');
  return L.slice(E[k].line + 1, blockEnd(E, L, k)).map((l) => l.match(/^\s*-\s+(.*)$/)?.[1]).filter((x): x is string => !!x).map((s) => unquote(s.trim()));
}

// ---------- Edits ----------
// Make sure every key on the path exists, adding missing ones at the end of their parent.
export function ensure(text: string, path: Path): string {
  for (let n = 1; n <= path.length; n++) {
    const E = entries(text);
    if (find(E, path.slice(0, n)) >= 0) continue;
    const parent = n === 1 ? -1 : find(E, path.slice(0, n - 1));
    text = insertLines(text, E, parent, [path[n - 1] + ':'], false, path[n - 1]);
  }
  return text;
}

// Where RAML keys usually sit inside a resource or method, so a new one lands where people expect it
// (query parameters before the body and responses, methods and nested resources last).
const ORDER = ['displayName', 'description', 'type', 'is', 'securedBy', 'uriParameters', 'queryParameters', 'queryString', 'headers', 'body', 'responses'];
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : k.startsWith('/') || ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k) ? 100 : -1);

// Lines (indented relative to the child level) added as the parent's last child, or before the first
// sibling that should come after `key`.
function insertLines(text: string, E: Entry[], parent: number, lines: string[], first = false, key?: string): string {
  const L = text.split('\n');
  const ind = ' '.repeat(childInd(E, parent));
  const add = lines.map((l) => ind + l);
  let at: number;
  const later = key && parent >= 0 && rank(key) >= 0 ? kids(E, parent).find((j) => rank(E[j].key) > rank(key) || (rank(key) <= 2 && rank(E[j].key) < 0)) : undefined;
  if (first && parent >= 0) at = E[parent].line + 1;
  else if (later != null) at = E[later].line;
  else if (parent < 0) { at = L.length; while (at > 0 && !L[at - 1].trim()) at--; }
  else at = blockEnd(E, L, parent);
  // A parent written as "key: value" or "key: {}" gets its value replaced by the block.
  if (parent >= 0 && E[parent].val && !/^[|>]/.test(E[parent].val)) L[E[parent].line] = L[E[parent].line].replace(/:\s.*$/, ':');
  L.splice(at, 0, ...add);
  return L.join('\n');
}

// Add a child key with its own lines below it, e.g. addChild(t, [res, 'get', 'responses'], ['404:', '  description: Not found']).
export function addChild(text: string, path: Path, lines: string[], first = false): string {
  text = ensure(text, path);
  const E = entries(text);
  return insertLines(text, E, find(E, path), lines, first);
}

// Remove a node and everything under it. A parent left empty goes too (an empty key reads as null).
export function remove(text: string, path: Path, pruneEmpty = true): string {
  const E = entries(text), k = find(E, path); if (k < 0) return text;
  const L = text.split('\n');
  L.splice(E[k].line, blockEnd(E, L, k) - E[k].line);
  text = L.join('\n');
  if (pruneEmpty && path.length > 1) {
    const E2 = entries(text), p = find(E2, path.slice(0, -1));
    if (p >= 0 && !E2[p].val && kids(E2, p).length === 0 && blockEnd(E2, text.split('\n'), p) === E2[p].line + 1) return remove(text, path.slice(0, -1), true);
  }
  return text;
}

// Set a scalar key under a node; null or '' removes it. New keys go first (displayName, description read best at the top).
export function setScalar(text: string, path: Path, key: string, value: string | null, raw = false): string {
  const E = entries(text), k = find(E, [...path, key]);
  if (value == null || value === '') return k >= 0 ? remove(text, [...path, key], false) : text;
  const multi = value.includes('\n');
  const q = (v: string) => (raw ? v : quote(v));
  const body = (ind: string) => multi ? [key + ': |', ...value.split('\n').map((l) => (l ? ind + l : ''))] : [key + ': ' + q(value)];
  if (k < 0) {
    const p = path.length ? find(E, path) : -1;
    if (path.length && p < 0) return addChild(text, path, body(' '.repeat(step(E))), true);
    // Known keys go in their usual place; others (title, version, usage) first.
    return rank(key) >= 0 && p >= 0 ? insertLines(text, E, p, body(' '.repeat(step(E))), false, key) : insertLines(text, E, p, body(' '.repeat(step(E))), true);
  }
  if (scalar(text, [...path, key]) === value) return text;
  const L = text.split('\n'), end = blockEnd(E, L, k);
  const lead = L[E[k].line].match(/^\s*(- )?/)![0];
  const keyText = L[E[k].line].slice(lead.length).match(/^("[^"]*"|'[^']*'|[^:#]*?)\s*:/)![0];
  const comment = !multi && !/^[|>]/.test(E[k].val) ? (L[E[k].line].match(/\s+#.*$/)?.[0] ?? '') : '';
  const lines = multi ? [lead + keyText + ' |', ...value.split('\n').map((l) => (l ? ' '.repeat(E[k].ind + step(E)) + l : ''))] : [lead + keyText + ' ' + q(value) + comment];
  L.splice(E[k].line, end - E[k].line, ...lines);
  return L.join('\n');
}

// Rename a key in place (a property, a query parameter, a status code). Its value and children stay.
export function renameKey(text: string, path: Path, nu: string): string {
  const E = entries(text), k = find(E, path); if (k < 0) return text;
  const L = text.split('\n'), l = L[E[k].line];
  const lead = l.match(/^\s*(- )?/)![0];
  L[E[k].line] = lead + l.slice(lead.length).replace(/^("[^"]*"|'[^']*'|[^:#]*?)(\s*:)/, (_m, _k, colon) => nu + colon);
  return L.join('\n');
}

// A property's or parameter's type, in whichever form it's written: "name: Type" or a type: key below it.
export function typeOf(text: string, path: Path): string {
  const E = entries(text), k = find(E, path); if (k < 0) return '';
  if (E[k].val && !/^[|>{]/.test(E[k].val)) return unquote(E[k].val);
  const t = kid(E, k, 'type');
  return t != null ? unquote(E[t].val) : kids(E, k).some((j) => E[j].key === 'properties') ? 'object' : '';
}
export function setType(text: string, path: Path, type: string): string {
  const E = entries(text), k = find(E, path); if (k < 0) return text;
  if (E[k].val && !/^[|>{]/.test(E[k].val)) {
    const L = text.split('\n'), l = L[E[k].line];
    L[E[k].line] = l.replace(/(:\s*)([^#]*?)(\s*(#.*)?)$/, (_m, c, _v, tail) => c + quote(type) + tail);
    return L.join('\n');
  }
  // "name:" with nothing under it, or a block: put type: first.
  return setScalar(text, path, 'type', type);
}

// Optional properties end in "?" (name?: string); a parameter block may say required: false instead.
export function setOptional(text: string, path: Path, optional: boolean): string {
  const E = entries(text), k = find(E, path); if (k < 0) return text;
  const req = kid(E, k, 'required');
  if (req != null) return setScalar(text, path, 'required', optional ? 'false' : 'true', true);
  const key = E[k].key;
  if (optional && !key.endsWith('?')) return renameKey(text, path, key + '?');
  if (!optional && key.endsWith('?')) return renameKey(text, path, key.slice(0, -1));
  return text;
}

// Write a list back in the style it had: flow ([ a, b ] keeps its inner spaces) or "- item" lines.
export function setList(text: string, path: Path, items: string[]): string {
  const E = entries(text), k = find(E, path);
  const parent = path.slice(0, -1), key = path[path.length - 1];
  if (!items.length) return k >= 0 ? remove(text, path, false) : text;
  if (k < 0) {
    const flow = `${key}: [ ${items.join(', ')} ]`;
    if (!parent.length) return insertLines(text, E, -1, [flow]);
    text = ensure(text, parent);
    const E2 = entries(text);
    return insertLines(text, E2, find(E2, parent), [flow], false, key);
  }
  const L = text.split('\n'), v = E[k].val, end = blockEnd(E, L, k);
  if (!v) {
    const ind = ' '.repeat(E[k].ind + step(E));
    L.splice(E[k].line + 1, end - E[k].line - 1, ...items.map((i) => `${ind}- ${i}`));
    return L.join('\n');
  }
  const spaced = /^\[\s/.test(v) || v === '[]';
  const flow = spaced ? `[ ${items.join(', ')} ]` : `[${items.join(', ')}]`;
  L[E[k].line] = L[E[k].line].replace(/:\s.*?(\s+#.*)?$/, (_m, c) => ': ' + flow + (c ?? ''));
  return L.join('\n');
}

// The smallest single change that turns a into b, for the editor (one undo step, cursor kept).
export function diff(a: string, b: string) {
  let s = 0; const n = Math.min(a.length, b.length);
  while (s < n && a[s] === b[s]) s++;
  let e = 0;
  while (e < n - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}
