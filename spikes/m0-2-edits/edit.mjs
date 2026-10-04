/**
 * M0.2: can we edit a real RAML so the diff contains only the intended change?
 *
 *   node edit.mjs <spec-dir>      (a git repo with the untouched spec committed)
 *
 * A. Whole-document round trip: parse with the `yaml` library's Document API and
 *    write it back with no change at all. Anything it alters is damage.
 * B. Position-based patches: the parser only tells us WHERE things are (byte
 *    ranges); the edit splices text at those ranges and leaves every other byte
 *    alone. Four edits:
 *      B1 duplicate an endpoint as a new path, copying its example files
 *      B2 rename a library type and every reference to it
 *      B3 add a response to a method
 *      B4 change a description
 */
import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename, extname } from 'node:path';
import { parseDocument, isMap, isPair, isScalar, isSeq, visit, Parser, CST } from 'yaml';

const root = process.argv[2];
const customTags = [{ tag: '!include', resolve: (s) => s }];
const walk = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => (f === '.git' ? [] : walk(join(p, f)))) : [p];
const ramls = walk(root).filter((f) => f.endsWith('.raml'));
const parse = (src) => parseDocument(src, { customTags, keepSourceTokens: true, uniqueKeys: false });

// ---- A: does a no-op round trip keep the file byte for byte? ---------------
let docDamaged = 0, cstDamaged = 0, parseErrors = 0;
for (const f of ramls) {
  const src = readFileSync(f, 'utf8');
  const doc = parse(src);
  if (doc.errors.length) { parseErrors++; console.log(`  parse error in ${relative(root, f)}: ${doc.errors[0].message.split('\n')[0]}`); }
  if (String(doc) !== src) docDamaged++;
  const cst = [...new Parser().parse(src)].map((t) => CST.stringify(t)).join('');
  if (cst !== src) cstDamaged++;
}
console.log(`A. ${ramls.length} RAML files, ${parseErrors} with YAML parse errors`);
console.log(`   Document API round trip, no edits: ${docDamaged} of ${ramls.length} files come back different`);
console.log(`   CST round trip, no edits:          ${cstDamaged} of ${ramls.length} files come back different\n`);

// ---- B: position-based patches -----------------------------------------------
const mainName = JSON.parse(readFileSync(join(root, 'exchange.json'), 'utf8')).main;
const mainPath = join(root, mainName);

/** Offsets of the line containing `off`. */
const lineStart = (src, off) => src.lastIndexOf('\n', off - 1) + 1;
const lineEnd = (src, off) => { const i = src.indexOf('\n', off); return i < 0 ? src.length : i + 1; };
const indentOf = (src, off) => { const s = lineStart(src, off); let i = s; while (src[i] === ' ') i++; return i - s; };
/** End of a pair's block: the end of the last line its value occupies. */
const blockEnd = (src, pair) => lineEnd(src, Math.max(pair.value.range[1] - 1, pair.key.range[1]));
const splice = (src, from, to, text) => src.slice(0, from) + text + src.slice(to);

// B1: duplicate the first top-level resource that has nested resources and includes.
{
  let src = readFileSync(mainPath, 'utf8');
  const doc = parse(src);
  const pair = doc.contents.items.find((p) => String(p.key.value).startsWith('/') && src.slice(p.key.range[0], p.value.range[1]).includes('!include'));
  const oldPath = String(pair.key.value);
  const newPath = `${oldPath}-copy`;
  const from = lineStart(src, pair.key.range[0]);
  const to = blockEnd(src, pair);
  let block = src.slice(from, to);
  block = block.replace(oldPath, newPath); // first occurrence = the key itself
  // Copy each example file the block includes, and point the copy at it.
  const copied = [];
  block = block.replace(/!include\s+(\/?examples\/[^\s]+)/g, (m, inc) => {
    const ext = extname(inc);
    const target = inc.replace(ext, `-copy${ext}`);
    const fromFile = join(root, inc.replace(/^\//, ''));
    if (existsSync(fromFile) && !copied.includes(target)) { copyFileSync(fromFile, join(root, target.replace(/^\//, ''))); copied.push(target); }
    return m.replace(inc, target);
  });
  src = splice(src, to, to, block);
  writeFileSync(mainPath, src);
  console.log(`B1 duplicated ${oldPath} (${block.split('\n').length - 1} lines) as ${newPath}, copied ${copied.length} example files`);
}

// B2: rename the first type declared in data-types/quote.raml, and every reference.
{
  const libPath = join(root, 'data-types/quote.raml');
  let lib = readFileSync(libPath, 'utf8');
  const doc = parse(lib);
  const types = doc.contents.items.find((p) => p.key.value === 'types').value;
  const typePair = types.items[0];
  const oldName = String(typePair.key.value);
  const newName = `${oldName}Renamed`;
  // Same-library references: scalars under type/items keys mentioning the bare name.
  const spans = [[typePair.key.range[0], typePair.key.range[1], newName]];
  const word = new RegExp(`(?<![\\w.])${oldName}(?![\\w])`, 'g');
  visit(doc, {
    Pair(_, p) {
      if (isScalar(p.key) && ['type', 'items'].includes(p.key.value) && isScalar(p.value)) {
        const [s, e] = p.value.range;
        for (const m of lib.slice(s, e).matchAll(word)) spans.push([s + m.index, s + m.index + oldName.length, newName]);
      }
    },
  });
  for (const [s, e, t] of spans.sort((a, b) => b[0] - a[0])) lib = splice(lib, s, e, t);
  writeFileSync(libPath, lib);
  let refs = spans.length - 1;
  // Other files: references through whatever alias they gave quote.raml in uses:.
  for (const f of ramls) {
    if (f === libPath) continue;
    let src = readFileSync(f, 'utf8');
    const d = parse(src);
    const uses = isMap(d.contents) && d.contents.items.find((p) => p.key?.value === 'uses');
    const alias = uses && isMap(uses.value) && uses.value.items.find((p) => /(^|\/)lead\.raml$/.test(String(p.value?.value)))?.key.value;
    if (!alias) continue;
    const ref = new RegExp(`(?<![\\w.])${alias}\\.${oldName}(?![\\w])`, 'g');
    const found = [...src.matchAll(ref)].reverse();
    for (const m of found) src = splice(src, m.index, m.index + m[0].length, `${alias}.${newName}`);
    if (found.length) { writeFileSync(f, src); refs += found.length; }
  }
  console.log(`B2 renamed type ${oldName} to ${newName}: the declaration and ${refs} references`);
}

// B3: add a 404 response after the last response of the first method that has responses.
{
  let src = readFileSync(mainPath, 'utf8');
  const doc = parse(src);
  let target = null;
  visit(doc, {
    Pair(_, p) {
      if (!target && isScalar(p.key) && p.key.value === 'responses' && isMap(p.value) && p.value.items.length) { target = p; return visit.BREAK; }
    },
  });
  const last = target.value.items[target.value.items.length - 1];
  const at = blockEnd(src, last);
  const ind = indentOf(src, last.key.range[0]);
  const step = ind - indentOf(src, target.key.range[0]);
  const pad = (n) => ' '.repeat(ind + step * n);
  const text = `${pad(0)}404:\n${pad(1)}description: Not found\n${pad(1)}body:\n${pad(2)}application/json:\n${pad(3)}example: {"message": "Not found"}\n`;
  src = splice(src, at, at, text);
  writeFileSync(mainPath, src);
  console.log(`B3 added a 404 response at line ${src.slice(0, at).split('\n').length}, indented ${ind} (step ${step})`);
}

// B4: change the first method description, keeping its quoting style.
{
  let src = readFileSync(mainPath, 'utf8');
  const doc = parse(src);
  let node = null;
  visit(doc, {
    Pair(_, p) {
      if (!node && isScalar(p.key) && p.key.value === 'description' && isScalar(p.value) && p.value.type !== 'BLOCK_LITERAL' && p.value.type !== 'BLOCK_FOLDED' && indentOf(src, p.key.range[0]) >= 4) { node = p.value; return visit.BREAK; }
    },
  });
  const [s, e] = node.range;
  const raw = src.slice(s, e);
  const q = raw[0] === '"' || raw[0] === "'" ? raw[0] : '';
  const updated = `${q}${node.value} (edited)${q}`;
  src = splice(src, s, e, updated);
  writeFileSync(mainPath, src);
  console.log(`B4 description ${raw} -> ${updated}`);
}
