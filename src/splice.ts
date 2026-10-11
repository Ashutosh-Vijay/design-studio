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
  const add = lines.map((l) => (l ? ind + l : ''));
  let at: number;
  const later = key && parent >= 0 && rank(key) >= 0 ? kids(E, parent).find((j) => rank(E[j].key) > rank(key) || (rank(key) <= 2 && rank(E[j].key) < 0)) : undefined;
  const firstRes = E.find((e) => e.ind === 0 && e.key.startsWith('/'));
  if (first && parent >= 0) at = E[parent].line + 1;
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
    // Known keys go in their usual place; others (title, version, usage) first.
    return rank(key) >= 0 && p >= 0 ? insertLines(text, E, p, body(' '.repeat(step(E))), false, key) : insertLines(text, E, p, body(' '.repeat(step(E))), true);
  }
  if (scalar(text, [...path, key]) === value) return text;
  const L = text.split('\n'), end = blockEnd(E, L, k);
  const lead = L[E[k].line].match(/^\s*(- )?/)![0];
  const keyText = L[E[k].line].slice(lead.length).match(/^("[^"]*"|'[^']*'|[^:#]*?)\s*:/)![0];
  // A one-line value keeps whatever followed it: a comment, or trailing spaces.
  const comment = !multi && !/^[|>]/.test(E[k].val) ? (L[E[k].line].match(/\s+#.*$|[ \t]+$/)?.[0] ?? '') : '';
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
  L[E[k].line] = lead + l.slice(lead.length).replace(/^("[^"]*"|'[^']*'|[^:#]*?)(\s*:)/, (_m, old: string, colon) => (/^["']/.test(old) ? old[0] + nu + old[0] : nu) + colon);
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
    // "- item" lines: keep the lines of items that stay, drop the others, add new ones after the last.
    const body = L.slice(E[k].line + 1, end);
    const itemOf = (l: string) => { const m = l.match(/^\s*-\s+(.*?)\s*$/); return m ? unquote(m[1]) : null; };
    const first = body.find((l) => itemOf(l) != null);
    const ind = first ? first.match(/^\s*/)![0] : ' '.repeat(E[k].ind + step(E));
    const kept = body.filter((l) => { const i = itemOf(l); return i == null || items.includes(i); });
    const have = kept.map(itemOf);
    const last = kept.reduce((a, l, i) => (itemOf(l) != null ? i : a), -1);
    kept.splice(last + 1, 0, ...items.filter((i) => !have.includes(i)).map((i) => `${ind}- ${i}`));
    L.splice(E[k].line + 1, end - E[k].line - 1, ...kept);
    return L.join('\n');
  }
  const spaced = /^\[\s/.test(v) || v === '[]';
  const flow = spaced ? `[ ${items.join(', ')} ]` : `[${items.join(', ')}]`;
  L[E[k].line] = L[E[k].line].replace(/:\s.*?(\s+#.*|\s*)$/, (_m, c) => ': ' + flow + c);
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
  let t = addChild(r.text, ['traits'], [`${name}:`, ...nest(entries(r.text), r.lines)]);
  t = setList(t, [...methodPath, 'is'], [...(list(t, [...methodPath, 'is']) ?? []), name]);
  return t;
}

// Extract resource type: a resource's methods (and its is:) become a resource type, and the resource
// says type: name. Its description, URI parameters and nested resources stay.
export function extractResourceType(text: string, resPath: Path, name: string): string {
  const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const r = takeChildren(text, resPath, (k) => METHODS.includes(k.replace(/\?$/, '')) || k === 'is');
  if (!r.lines.length) return text;
  const t = addChild(r.text, ['resourceTypes'], [`${name}:`, ...nest(entries(r.text), r.lines)]);
  return setScalar(t, resPath, 'type', name);
}

// Delete with cascade: take every use of a declaration out of a file. `ref` matches the name as this file
// writes it (Name in its own file, alias.Name elsewhere). Traits leave is: lists, resource types leave
// resources; a type leaves type:, items: and unions, and a "name: Type" shorthand becomes "name: any".
export function dropRefs(text: string, ref: string, kind: 'type' | 'trait' | 'rt'): string {
  const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`^${esc}(\\[\\])?$`);
  const pathOf = (t: string, line: number) => {
    const E = entries(t), at = E.findIndex((e) => e.line === line);
    const out: string[] = []; let cur = Infinity;
    for (let i = at; i >= 0; i--) if (i === at || E[i].ind < cur) { out.unshift(E[i].key); cur = E[i].ind; if (cur === 0) break; }
    return out;
  };
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
  }
  return text;
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
