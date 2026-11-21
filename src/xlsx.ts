// A small .xlsx writer for the Dashboard's endpoint export: inline strings, a fixed set of styles, links between
// sheets, merged cells, data bars, frozen headers and filters. The zip is stored (no compression): a workbook of a
// few thousand rows is a few hundred KB either way. No UI imports, so it runs anywhere.

// Styles, by index into cellXfs below.
export const S = {
  plain: 0, title: 1, sub: 2, head: 3, text: 4, link: 5, big: 6, label: 7,
  GET: 8, POST: 9, PUT: 10, PATCH: 11, DELETE: 12, method: 13,
  mono: 14, num: 15, section: 16, back: 17, muted: 18, pct: 19,
} as const;
export type Cell = string | number | null | { v: string | number; s?: number; link?: string };
export type Sheet = {
  name: string; rows: Cell[][]; widths?: number[]; merges?: string[]; freeze?: number; filter?: string;
  bars?: { range: string; color: string }[]; grid?: boolean; tab?: string;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 can't hold (a stray control character in a description) are dropped.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
export const col = (i: number) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
// A sheet's name as Excel allows it: 31 characters, none of []:*?/\, not starting or ending with a quote, unique.
export function sheetName(want: string, taken: Set<string>) {
  const base = want.replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()) || name.toLowerCase() === 'history'; n++) name = `${base.slice(0, 31 - ` (${n})`.length)} (${n})`;
  taken.add(name.toLowerCase());
  return name;
}
export const linkTo = (sheet: string) => `'${sheet.replace(/'/g, "''")}'!A1`;

function sheetXml(sh: Sheet) {
  const links: string[] = [];
  const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
    if (c === null || c === undefined || c === '') return '';
    const o = typeof c === 'object' ? c : { v: c };
    const ref = col(ci) + (ri + 1), s = o.s ? ` s="${o.s}"` : '';
    if (o.link) links.push(`<hyperlink ref="${ref}" location="${esc(o.link)}" display="${esc(String(o.v))}"/>`);
    return typeof o.v === 'number' && Number.isFinite(o.v) ? `<c r="${ref}"${s}><v>${o.v}</v></c>`
      : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(o.v))}</t></is></c>`;
  }).join('')}</row>`).join('');
  const pane = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + (sh.tab ? `<sheetPr><tabColor rgb="FF${sh.tab}"/></sheetPr>` : '')
    + `<sheetViews><sheetView workbookViewId="0"${sh.grid === false ? ' showGridLines="0"' : ''}>${pane}</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + (sh.widths?.length ? `<cols>${sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '')
    + `<sheetData>${rows}</sheetData>`
    + (sh.filter ? `<autoFilter ref="${sh.filter}"/>` : '')
    + (sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
    + (sh.bars ?? []).map((b, i) => `<conditionalFormatting sqref="${b.range}"><cfRule type="dataBar" priority="${i + 1}"><dataBar><cfvo type="num" val="0"/><cfvo type="max"/><color rgb="FF${b.color}"/></dataBar></cfRule></conditionalFormatting>`).join('')
    + (links.length ? `<hyperlinks>${links.join('')}</hyperlinks>` : '')
    + `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`;
}

// Fonts, fills and borders the styles pick from. Method colours follow the usual API-docs convention.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0%"/></numFmts>
<fonts count="13">
<font><sz val="11"/><color rgb="FF1F2328"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="18"/><color rgb="FF1F2328"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF6E7781"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><u/><sz val="11"/><color rgb="FF0969DA"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="22"/><color rgb="FF1F2328"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FF1A7F37"/><name val="Consolas"/><family val="3"/></font>
<font><b/><sz val="10"/><color rgb="FF0969DA"/><name val="Consolas"/><family val="3"/></font>
<font><b/><sz val="10"/><color rgb="FF9A6700"/><name val="Consolas"/><family val="3"/></font>
<font><b/><sz val="10"/><color rgb="FF8250DF"/><name val="Consolas"/><family val="3"/></font>
<font><b/><sz val="10"/><color rgb="FFCF222E"/><name val="Consolas"/><family val="3"/></font>
<font><sz val="10"/><color rgb="FF1F2328"/><name val="Consolas"/><family val="3"/></font>
<font><b/><sz val="13"/><color rgb="FF1F2328"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="10">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF24364B"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F5F8"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDAFBE1"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDF4FF"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF8C5"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFBEFFF"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEBE9"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFF2F5"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFE1E4E8"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="20">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="5" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="7" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="8" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="9" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="10" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="11" fillId="9" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="11" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="12" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ---------- The zip (stored entries): the workbook, and a project published straight to Exchange (sync.ts) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function zip(files: [string, string | Uint8Array][]) {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let at = 0;
  // A fixed time (1 Jan 2026) keeps two exports of the same data byte-identical.
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [path, text] of files) {
    const name = enc.encode(path), data = typeof text === 'string' ? enc.encode(text) : text;
    let crc = 0xffffffff; for (const b of data) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
    const head = new Uint8Array(30 + name.length), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); head.set(name, 30);
    const cen = new Uint8Array(46 + name.length), c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, at, true); cen.set(name, 46);
    parts.push(head, data); central.push(cen); at += head.length + data.length;
  }
  const size = central.reduce((n, x) => n + x.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, at, true);
  const out = new Uint8Array(at + size + 22);
  let o = 0; for (const p of [...parts, ...central, end]) { out.set(p, o); o += p.length; }
  return out;
}

export function workbook(sheets: Sheet[], title: string) {
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${
      sheets.some((s) => s.filter) ? `<definedNames>${sheets.map((s, i) => s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name.replace(/'/g, "''"))}'!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '').join('')}</definedNames>` : ''}</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zip(files);
}
