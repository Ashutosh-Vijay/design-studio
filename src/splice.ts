// Form edits as minimal text changes (PLAN 3.1): every function takes the file's text and returns the
// new text, touching only the lines it must. Nodes are found by their key path from the top of the file,
// so an edit never depends on stale positions. The caller turns old and new text into one small change.
import { parse, stringify } from 'yaml';
import { entries, kids, kid, type Entry } from './raml';

export type Path = string[];

// A path step "#n" is the nth item of a "- " list (OAS parameters, servers). It finds the item's first key;
// the steps after it look among that item's keys.
export function find(E: Entry[], path: Path): number {
  let ck = -1, item: [number, number] | null = null, seq = -1;
  for (const key of path) {
    if (key.startsWith('#')) {
      if (ck < 0) return -1;
      const its = items(E, ck), n = +key.slice(1);
      if (n >= its.length) return -1;
      seq = ck; item = [its[n], its[n + 1] ?? Infinity]; ck = its[n];
      continue;
    }
    const list = item ? kids(E, seq).filter((i) => i >= item![0] && i < item![1]) : ck < 0 ? E.flatMap((e, i) => (e.ind === 0 ? [i] : [])) : kids(E, ck);
    const j = list.find((i) => E[i].key === key);
    if (j == null) return -1;
    ck = j; item = null;
  }
  return ck;
}
// The entries that open each item of a "- " list under key k.
export const items = (E: Entry[], k: number) => kids(E, k).filter((j) => E[j].dash);
// The lines of the nth item: from its dash line to the next item (or the list's end).
function itemLines(E: Entry[], L: string[], k: number, n: number): [number, number] {
  const its = items(E, k);
  let end = its[n + 1] != null ? E[its[n + 1]].line : blockEnd(E, L, k);
  while (end - 1 > E[its[n]].line && !L[end - 1].trim()) end--;
  return [E[its[n]].line, end];
}

// Add an item to a "- " list, at the indent its items already use: addItem(t, [...op, 'parameters'], ['name: id', 'in: path']).
export function addItem(text: string, path: Path, lines: string[]): string {
  text = ensure(text, path);
  const E = entries(text), k = find(E, path), L = text.split('\n');
  const its = items(E, k);
  const col = its.length ? E[its[0]].ind - 2 : E[k].ind + step(E);
  const add = lines.map((l, i) => ' '.repeat(col) + (i === 0 ? '- ' : '  ') + l);
  if (E[k].val) L[E[k].line] = L[E[k].line].replace(/:\s.*$/, ':'); // "parameters: []" becomes a block
  L.splice(its.length ? itemLines(E, L, k, its.length - 1)[1] : blockEnd(E, L, k), 0, ...add);
  return L.join('\n');
}
// Remove the nth item of a list (the list itself goes when it ends up empty).
export function removeItem(text: string, path: Path, n: number): string {
  const E = entries(text), k = find(E, path); if (k < 0 || n >= items(E, k).length) return text;
  const L = text.split('\n'), [a, b] = itemLines(E, L, k, n);
  L.splice(a, b - a);
  text = L.join('\n');
  const E2 = entries(text), k2 = find(E2, path);
  return k2 >= 0 && !items(E2, k2).length && blockEnd(E2, text.split('\n'), k2) === E2[k2].line + 1 ? remove(text, path, false) : text;
}
// Set a key inside the nth item of a list: changed in place, or added at the end of the item.
export function setInItem(text: string, path: Path, n: number, key: string, value: string | null, raw = false): string {
  const E = entries(text), k = find(E, [...path, '#' + n, key]);
  if (k >= 0 || value == null || value === '') return setScalar(text, [...path, '#' + n], key, value, raw);
  const s = find(E, path), L = text.split('\n'), [, end] = itemLines(E, L, s, n);
  L.splice(end, 0, ' '.repeat(E[items(E, s)[n]].ind) + key + ': ' + (raw ? value : quote(value)));
  return L.join('\n');
}

// The file's indent step (2 in nearly every spec), from the smallest indent in use.
function step(E: Entry[]) {
  // A list item's key sits 2 past its dash ("  - title"): the dash's column is the indent.
  const s = E.map((e) => (e.dash ? e.ind - 2 : e.ind)).filter((i) => i > 0);
  return s.length ? Math.min(...s) : 2;
}
const childInd = (E: Entry[], k: number) => (k < 0 ? 0 : kids(E, k)[0] != null ? E[kids(E, k)[0]].ind : E[k].ind + step(E));

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
export function unquote(v: string): string {
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
  const L = text.split('\n');
  if (v.startsWith('[')) return flowItems(flowSpan(L, E[k].line, v).text).map(unquote);
  if (v) return [unquote(v)];
  return L.slice(E[k].line + 1, blockEnd(E, L, k)).map((l) => l.match(/^\s*-\s+(.*)$/)?.[1]).filter((x): x is string => !!x).map((s) => unquote(s.trim()));
}

// A flow list can run over several lines (enum: [ then items, then ]): its whole text and its last line.
function flowSpan(L: string[], line: number, v: string): { text: string; last: number } {
  let text = v, last = line;
  while (!/\]\s*(#.*)?$/.test(text) && last + 1 < L.length) text += ' ' + L[++last].trim();
  return { text: text.replace(/\s+#[^\]]*$/, ''), last };
}
// A flow list's items as written, quotes kept; a comma inside quotes doesn't split.
function flowItems(v: string): string[] {
  return (v.replace(/^\[|\]\s*$/g, '').match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

// ---------- Edits ----------
// Make sure every key on the path exists, adding missing ones at the end of their parent.
export function ensure(text: string, path: Path): string {
  for (let n = 1; n <= path.length; n++) {
    const E = entries(text);
    if (find(E, path.slice(0, n)) >= 0) continue;
    // A new key in a list item ("- name: id"): it goes at the end of the item, lined up with the item's keys.
    if (n >= 2 && path[n - 2].startsWith('#')) {
      const seq = find(E, path.slice(0, n - 2)), i = +path[n - 2].slice(1), L = text.split('\n');
      const it = items(E, seq)[i]; if (it == null) return text;
      L.splice(itemLines(E, L, seq, i)[1], 0, ' '.repeat(L[E[it].line].match(/^\s*-\s+/)![0].length) + path[n - 1] + ':');
      text = L.join('\n');
      continue;
    }
    const parent = n === 1 ? -1 : find(E, path.slice(0, n - 1));
    text = insertLines(text, E, parent, [path[n - 1] + ':'], false, path[n - 1]);
  }
  return text;
}

// Where RAML keys usually sit inside a resource or method, so a new one lands where people expect it
// (query parameters before the body and responses, methods and nested resources last).
const ORDER = ['title', 'summary', 'displayName', 'description', 'type', 'is', 'securedBy', 'uriParameters', 'queryParameters', 'queryString', 'headers', 'body', 'responses'];
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : k.startsWith('/') || ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k) ? 100 : -1);

// Lines (indented relative to the child level) added as the parent's last child, or before the first
// sibling that should come after `key`.
function insertLines(text: string, E: Entry[], parent: number, lines: string[], first = false, key?: string): string {
  const L = text.split('\n');
  const ind = ' '.repeat(childInd(E, parent));
  const add = lines.map((l) => (l ? ind + l : ''));
  let at: number;
  const later = key && parent >= 0 && rank(key) >= 0 ? kids(E, parent).find((j) => rank(E[j].key) > rank(key) || (rank(key) <= 4 && rank(E[j].key) < 0)) : undefined;
  const firstRes = E.find((e) => e.ind === 0 && e.key.startsWith('/'));
  if (first && parent >= 0) at = E[parent].line + 1;
  else if (first && parent < 0) {
    // A new root key (version, protocols, securedBy) goes in the header, after the last of title, version and
    // the like, rather than after the resources at the end of the file.
    const head = E.filter((e) => e.ind === 0 && ['title', 'description', 'version', 'baseUri', 'baseUriParameters', 'protocols', 'mediaType', 'securedBy'].includes(e.key));
    at = head.length ? blockEnd(E, L, E.indexOf(head[head.length - 1])) : /^(﻿)?#%/.test(L[0]) ? 1 : 0;
  }
  else if (later != null) at = E[later].line;
  else if (parent < 0 && key && !key.startsWith('/') && firstRes) {
    // A new top-level declaration (types:, traits:, uses:) goes before the resources, above any comment
    // that belongs to the first one, with a blank line to keep them apart.
    at = firstRes.line;
    while (at > 0 && L[at - 1].trimStart().startsWith('#')) at--;
    add.push('');
  }
  else if (parent < 0) { at = L.length; while (at > 0 && !L[at - 1].trim()) at--; }
  else at = blockEnd(E, L, parent);
  // A parent written as "key: {}" or "[]" gets its value replaced by the block. "key: Type" is RAML's short
  // form of a type, so the type moves into the block as type: Type and nothing is lost.
  if (parent >= 0 && E[parent].val && !/^[|>]/.test(E[parent].val)) {
    const v = E[parent].val;
    // A non-empty flow map ({ type: integer, default: 10 }) is written out as a block, so nothing in it is lost;
    // a key the edit sets itself is left to the edit.
    let flow: string[] = [];
    if (/^\{.*\S.*\}$/.test(v)) {
      let y: unknown; try { y = parse(v); } catch { return text; }
      const own = new Set(lines.map((l) => l.match(/^([^\s:]+)\s*:/)?.[1]));
      let skip = false;
      for (const l of stringify(y, { lineWidth: 0 }).trimEnd().split('\n')) {
        if (!/^\s/.test(l)) skip = own.has(l.match(/^([^:]+):/)?.[1].replace(/^["']|["']$/g, ''));
        if (!skip) flow.push(ind + l);
      }
    }
    L[E[parent].line] = L[E[parent].line].replace(/:\s.*$/, ':');
    add.unshift(...flow);
    if (!flow.length && !/^(\{.*\}|\[\s*\]|null|~)$/.test(v) && !lines.some((l) => /^type\s*:/.test(l))) add.unshift(ind + 'type: ' + v);
  }
  L.splice(at, 0, ...add);
  return L.join('\n');
}

// Add a child key with its own lines below it, e.g. addChild(t, [res, 'get', 'responses'], ['404:', '  description: Not found']).
export function addChild(text: string, path: Path, lines: string[], first = false): string {
  text = ensure(text, path);
  const E = entries(text);
  return insertLines(text, E, find(E, path), lines, first);
}

// Remove a node and everything under it. A list key left empty (queryParameters:, properties:) goes too,
// since an empty key reads as null; a method or resource left empty stays.
const LISTS = ['queryParameters', 'headers', 'uriParameters', 'baseUriParameters', 'properties', 'body', 'responses',
  'types', 'traits', 'resourceTypes', 'securitySchemes', 'annotationTypes', 'uses'];
export function remove(text: string, path: Path, pruneEmpty = true): string {
  const E = entries(text), k = find(E, path); if (k < 0) return text;
  const L = text.split('\n');
  L.splice(E[k].line, blockEnd(E, L, k) - E[k].line);
  text = L.join('\n');
  if (pruneEmpty && path.length > 1 && LISTS.includes(path[path.length - 2])) {
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
    // A facet (example, pattern, maxLength) goes after the node's type:, which reads first.
    const tk = p >= 0 && rank(key) < 0 ? kid(E, p, 'type') : undefined;
    if (tk != null) {
      const L = text.split('\n');
      L.splice(blockEnd(E, L, tk), 0, ...body(' '.repeat(step(E))).map((l) => (l ? ' '.repeat(E[tk].ind) + l : '')));
      return L.join('\n');
    }
    // Known keys go in their usual place; others (title, version, usage) first.
    return rank(key) >= 0 && p >= 0 ? insertLines(text, E, p, body(' '.repeat(step(E))), false, key) : insertLines(text, E, p, body(' '.repeat(step(E))), true);
  }
  if (scalar(text, [...path, key]) === value) return text;
  const L = text.split('\n'), end = blockEnd(E, L, k);
  const lead = L[E[k].line].match(/^\s*(- )?/)![0];
  const keyText = L[E[k].line].slice(lead.length).match(/^("[^"]*"|'[^']*'|[^\s#:](?:[^:\s]|[ \t]+(?=[^\s#:]))*?)\s*:/)![0];
  // A one-line value keeps whatever followed it: a comment, or trailing spaces.
  const rest = L[E[k].line].slice(lead.length + keyText.length), at = rest.indexOf(E[k].val);
  const comment = !multi && !/^[|>]/.test(E[k].val) && at >= 0 ? (rest.slice(at + E[k].val.length).match(/^\s+#.*$|^[ \t]+$/)?.[0] ?? '') : '';
  const sep = (!/^[|>]/.test(E[k].val) && L[E[k].line].slice(lead.length + keyText.length).match(/^[ \t]+/)?.[0]) || ' ';
  const lines = multi ? [lead + keyText + ' |', ...value.split('\n').map((l) => (l ? ' '.repeat(E[k].ind + step(E)) + l : ''))] : [lead + keyText + sep + q(value) + comment];
  L.splice(E[k].line, end - E[k].line, ...lines);
  return L.join('\n');
}

// Rename a key in place (a property, a query parameter, a status code). Its value and children stay.
export function renameKey(text: string, path: Path, nu: string): string {
  const E = entries(text), k = find(E, path); if (k < 0) return text;
  const L = text.split('\n'), l = L[E[k].line];
  const lead = l.match(/^\s*(- )?/)![0];
  // A quoted key stays quoted the same way.
  L[E[k].line] = lead + l.slice(lead.length).replace(/^("[^"]*"|'[^']*'|[^\s#:](?:[^:\s]|[ \t]+(?=[^\s#:]))*?)(\s*:)/, (_m, old: string, colon) => (/^["']/.test(old) ? old[0] + nu + old[0] : /^\d+\??$/.test(nu) ? nu : quote(nu)) + colon);
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
    const flow = `${key}: [ ${items.map(quote).join(', ')} ]`;
    if (!parent.length) return insertLines(text, E, -1, [flow], true);
    text = ensure(text, parent);
    const E2 = entries(text);
    return insertLines(text, E2, find(E2, parent), [flow], false, key);
  }
  const L = text.split('\n'), v = E[k].val, end = blockEnd(E, L, k);
  if (!v) {
    // "- item" lines: keep the lines of items that stay, drop the others, add new ones after the last.
    const body = L.slice(E[k].line + 1, end);
    const itemOf = (l: string) => { const m = l.match(/^\s*-\s+(.*?)\s*$/); return m ? unquote(m[1]) : null; };
    const first = body.find((l) => itemOf(l) != null);
    const ind = first ? first.match(/^\s*/)![0] : ' '.repeat(E[k].ind + step(E));
    const kept = body.filter((l) => { const i = itemOf(l); return i == null || items.includes(i); });
    const have = kept.map(itemOf);
    const last = kept.reduce((a, l, i) => (itemOf(l) != null ? i : a), -1);
    kept.splice(last + 1, 0, ...items.filter((i) => !have.includes(i)).map((i) => `${ind}- ${quote(i)}`));
    L.splice(E[k].line + 1, end - E[k].line - 1, ...kept);
    return L.join('\n');
  }
  // A single value (key: a) becomes a list on its own line; only a real [ list can run over several lines.
  const span = v.startsWith('[') ? flowSpan(L, E[k].line, v) : { text: `[${v.replace(/\s+#.*$/, '')}]`, last: E[k].line };
  const spaced = /^\[\s/.test(v) || v === '[]';
  // Items that stay keep their text as written (quotes and all); new ones are quoted when YAML needs it.
  const was = new Map(flowItems(span.text).map((t) => [unquote(t), t]));
  const out = items.map((i) => was.get(i) ?? quote(i));
  const flow = spaced ? `[ ${out.join(', ')} ]` : `[${out.join(', ')}]`;
  L[E[k].line] = L[E[k].line].replace(/:\s.*?(\s+#.*|\s*)$/, (_m, c) => ': ' + flow + c);
  if (span.last > E[k].line) L.splice(E[k].line + 1, span.last - E[k].line); // a list that ran over several lines is now one
  return L.join('\n');
}

// ---------- Refactorings (Design Center's "Extract to Declaration", ALS's extract and delete actions) ----------

// Take some children of a node out of the text. Returns the text without them, and their lines with the
// children's own indent removed (nested lines keep their relative indent).
function takeChildren(text: string, path: Path, pick: (key: string) => boolean): { text: string; lines: string[] } {
  const E = entries(text), k = find(E, path); if (k < 0) return { text, lines: [] };
  const L = text.split('\n');
  const js = kids(E, k).filter((j) => pick(E[j].key));
  if (!js.length) return { text, lines: [] };
  const ind = E[js[0]].ind;
  const lines = js.flatMap((j) => L.slice(E[j].line, blockEnd(E, L, j)).map((l) => (l.trim() ? l.slice(Math.min(ind, l.match(/^\s*/)![0].length)) : '')));
  for (const j of [...js].reverse()) L.splice(E[j].line, blockEnd(E, L, j) - E[j].line);
  return { text: L.join('\n'), lines };
}
const nest = (E: Entry[], lines: string[]) => lines.map((l) => (l ? ' '.repeat(step(E)) + l : ''));
// An empty "example:" says nothing, and AMF ignores it in a resource but validates it as null inside a
// trait or resource type (found on a real spec). Templates leave those lines out, so the API means the same.
const dropEmptyExamples = (lines: string[]) => lines.filter((l, i) => {
  if (!/^\s*(- )?examples?\s*:\s*(#.*)?$/.test(l)) return true; // also "example : " (a corpus quirk)
  const next = lines.slice(i + 1).find((x) => x.trim());
  return !!next && next.search(/\S/) > l.search(/\S/);
});

// A name not yet used in a declaration section; a number is added when taken, as Design Center does.
export function freeName(text: string, sect: string, base: string): string {
  const E = entries(text), k = find(E, [sect]);
  const have = k < 0 ? [] : kids(E, k).map((j) => E[j].key);
  let n = base, i = 1;
  while (have.includes(n)) n = base + i++;
  return n;
}

// Extract to Declaration: an inline type (a property, a body, a parameter written out in full) becomes a
// declared type in this file's types:, and the inline one says type: Name. Examples, required and the
// description stay where they are: they belong to the use, not the type.
export function extractType(text: string, path: Path, name: string): string {
  const STAY = ['example', 'examples', 'required', 'description', 'displayName'];
  const r = takeChildren(text, path, (k) => !STAY.includes(k) && !k.startsWith('('));
  if (!r.lines.length) return text;
  const t = setScalar(r.text, path, 'type', name);
  return addChild(t, ['types'], [`${name}:`, ...nest(entries(t), r.lines)]);
}

// Extract trait: some parts of a method (query parameters, headers, responses) become a trait, and the
// method gets it in its is: list.
export function extractTrait(text: string, methodPath: Path, keys: string[], name: string): string {
  const r = takeChildren(text, methodPath, (k) => keys.includes(k));
  if (!r.lines.length) return text;
  let t = addChild(r.text, ['traits'], [`${name}:`, ...nest(entries(r.text), dropEmptyExamples(r.lines))]);
  t = setList(t, [...methodPath, 'is'], [...(list(t, [...methodPath, 'is']) ?? []), name]);
  return t;
}

// Extract resource type: a resource's methods (and its is:) become a resource type, and the resource
// says type: name. Its description, URI parameters and nested resources stay.
export function extractResourceType(text: string, resPath: Path, name: string): string {
  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const r = takeChildren(text, resPath, (k) => METHODS.includes(k.replace(/\?$/, '')) || k === 'is');
  if (!r.lines.length) return text;
  const t = addChild(r.text, ['resourceTypes'], [`${name}:`, ...nest(entries(r.text), dropEmptyExamples(r.lines))]);
  return setScalar(t, resPath, 'type', name);
}

// Delete with cascade: take every use of a declaration out of a file. `ref` matches the name as this file
// writes it (Name in its own file, alias.Name elsewhere). Traits leave is: lists, resource types leave
// resources; a type leaves type:, items: and unions, and a "name: Type" shorthand becomes "name: any".
export function dropRefs(text: string, ref: string, kind: 'type' | 'trait' | 'rt'): { text: string; uses: number } {
  const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`^${esc}(\\[\\])?$`);
  const pathOf = (t: string, line: number) => {
    const E = entries(t), at = E.findIndex((e) => e.line === line);
    const out: string[] = []; let cur = Infinity;
    for (let i = at; i >= 0; i--) if (i === at || E[i].ind < cur) { out.unshift(E[i].key); cur = E[i].ind; if (cur === 0) break; }
    return out;
  };
  let uses = 0;
  for (let guard = 0; guard < 500; guard++) {
    const E = entries(text);
    let changed = false;
    for (const e of E) {
      const v = unquote(e.val);
      if (kind === 'trait' && e.key === 'is') {
        const p = pathOf(text, e.line), cur = list(text, p) ?? [];
        if (cur.some((i) => i === ref)) { text = setList(text, p, cur.filter((i) => i !== ref)); changed = true; break; }
      } else if (kind === 'rt' && e.key === 'type' && whole.test(v)) {
        const p = pathOf(text, e.line);
        if (p.length >= 2 && p[p.length - 2].startsWith('/')) { text = remove(text, p, false); changed = true; break; }
      } else if (kind === 'type' && v && !/^[|>!]/.test(v)) {
        const p = pathOf(text, e.line);
        if (p.length >= 2 && p[p.length - 2].startsWith('/') && e.key === 'type') continue; // a resource's type: is a resource type
        // Words in prose and example data aren't uses, even when they equal the type's name.
        if (/^(description|displayName|usage|title|example|examples|pattern|default|enum)$/.test(e.key) || p.some((x) => x === 'example' || x === 'examples')) continue;
        if (whole.test(v)) {
          text = e.key === 'type' || e.key === 'items' ? remove(text, p, false) : setType(text, p, 'any');
          changed = true; break;
        }
        const parts = v.split('|').map((s) => s.trim());
        if (parts.length > 1 && parts.some((s) => whole.test(s))) {
          // A union just loses that member: "A | X" becomes "A".
          const L = text.split('\n'), keep = parts.filter((s) => !whole.test(s)).join(' | ');
          L[e.line] = L[e.line].replace(/(:\s*)([^#]*?)(\s*(#.*)?)$/, (_m, c, _v, tail) => c + keep + tail);
          text = L.join('\n'); changed = true; break;
        }
      }
    }
    if (!changed) break;
    uses++;
  }
  return { text, uses };
}

// A declaration's own lines (its key and everything under it), with its indent removed.
export function declLines(text: string, path: Path): string[] {
  const E = entries(text), k = find(E, path); if (k < 0) return [];
  const L = text.split('\n');
  return L.slice(E[k].line, blockEnd(E, L, k)).map((l) => (l.trim() ? l.slice(Math.min(E[k].ind, l.match(/^\s*/)![0].length)) : ''));
}

// Uses of a bare name in value positions (type: X, items: X, "prop: X", X[], unions), never in descriptions.
const PROSE = /^\s*(- )?(description|displayName|usage|title|example|examples|pattern)\s*:/;
export function usesName(lines: string[], name: string): boolean {
  const re = new RegExp(`(^|[\\s|(\\[,])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=(\\[\\])?\\??($|[\\s|),\\]]))`);
  return lines.some((l) => { const m = l.match(/^\s*(?:- )?[^:#]+?\s*:\s*(.+)$/); return !!m && !PROSE.test(l) && re.test(m[1]); });
}
// Rewrite those uses, e.g. Order to lib.Order after the type moved into a library.
export function qualify(text: string, name: string, to: string): string {
  const re = new RegExp(`(^|[\\s|(\\[,])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=(\\[\\])?\\??($|[\\s|),\\]]))`, 'g');
  return text.split('\n').map((l) => {
    const m = l.match(/^(\s*(?:- )?[^:#]+?\s*:\s*)(.+)$/);
    return !m || PROSE.test(l) ? l : m[1] + m[2].replace(re, (_x, pre) => pre + to);
  }).join('\n');
}

// The smallest single change that turns a into b, for the editor (one undo step, cursor kept).
export function diff(a: string, b: string) {
  let s = 0; const n = Math.min(a.length, b.length);
  while (s < n && a[s] === b[s]) s++;
  let e = 0;
  while (e < n - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}
