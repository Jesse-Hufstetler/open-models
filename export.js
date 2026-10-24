// Builds the downloadable data files (CSV, XLSX, ODS) for the Open Models page.
// Loaded on demand from index.html. XLSX needs ExcelJS and ODS needs JSZip as globals.
(function (root) {
  'use strict';

  const HUES = { score: [13, 148, 136], size: [234, 88, 12], pop: [37, 99, 235], new: [22, 163, 74] };
  const blend = (rgb, a) => rgb.map(c => 255 * (1 - a) + c * a);
  const toHex = rgb => '#' + rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
  const parseHex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const tintOf = (color, a) => color ? toHex(blend(parseHex(color), a)) : null;
  const serial = ms => ms / 864e5 + 25569; // spreadsheet date serial from epoch ms

  const num = (k, nf, hue, extra) => ({ k, kind: 'num', nf, hue, center: 1, w: 9, ...extra });
  const SPEC = [
    { k: 'id', kind: 'link', w: 46, tint: 'org' },
    { k: 'country', w: 9, center: 1, tint: 'country' },
    { k: 'org', w: 16, tint: 'org' },
    { k: 'product', w: 16, tint: 'org' },
    { k: 'version', w: 8, center: 1, heat: 1 },
    { k: 'variant', w: 24 },
    num('composite', '0', 'score', { lo: 15, hi: 95, calc: 'score', w: 8 }),
    num('aa_intel', '0', 'score', { lo: 5, hi: 65 }),
    num('aa_coding', '0', 'score', { lo: 5, hi: 65 }),
    num('aa_agentic', '0', 'score', { lo: 5, hi: 65 }),
    num('epoch_eci', '0', 'score', { lo: 110, hi: 165 }),
    num('epoch_gpqa', '0', 'score', { lo: 30, hi: 95 }),
    num('epoch_swe', '0', 'score', { lo: 20, hi: 90 }),
    num('params_b', '0.0#', 'size', { pct: 1 }),
    num('active_b', '0.0#', 'size', { pct: 1 }),
    num('q4', '0.0', 'size', { pct: 1, calc: 'ram', w: 11 }),
    num('context', '#,##0', 'size', { pct: 1 }),
    num('downloads', '#,##0', 'pop', { pct: 1, w: 11 }),
    num('likes', '#,##0', 'pop', { pct: 1 }),
    { k: 'created', kind: 'date', nf: 'date', hue: 'new', recent: 1, w: 11 },
    { k: 'updated', kind: 'date', nf: 'date', hue: 'new', recent: 1, w: 11 },
  ];
  const IDX = Object.fromEntries(SPEC.map((s, i) => [s.k, i]));
  const COL = i => String.fromCharCode(65 + i);
  const SCORE_COLS = ['aa_intel', 'aa_coding', 'aa_agentic', 'epoch_eci', 'epoch_gpqa', 'epoch_swe'].map(k => COL(IDX[k]));
  const PARAM_CELL = 'B5'; // Q4 GB-per-billion-params setting on the About sheet

  const heatAlpha = t => t < 0.12 ? 0 : 0.05 + 0.5 * t * t;

  function value(m, s) {
    const v = m[s.k];
    if (v == null || v === '') return null;
    return s.kind === 'date' ? new Date(v) : v;
  }

  // Formulas for the two calculated columns, in XLSX or ODS syntax.
  function formulas(ods, last) {
    const sep = ods ? ';' : ',';
    const ref = (c, r) => ods ? `[.${c}${r}]` : `${c}${r}`;
    const fixed = c => ods ? `[.${c}$2:.${c}$${last}]` : `${c}$2:${c}$${last}`;
    const rowRange = r => ods ? `[.${SCORE_COLS[0]}${r}:.${SCORE_COLS[5]}${r}]` : `${SCORE_COLS[0]}${r}:${SCORE_COLS[5]}${r}`;
    const param = ods ? `[$About.$${PARAM_CELL[0]}$${PARAM_CELL.slice(1)}]` : `About!$${PARAM_CELL[0]}$${PARAM_CELL.slice(1)}`;
    return {
      score(r) {
        // Percentile rank among all models with that score (ties share the average rank), averaged over the scores present.
        const terms = SCORE_COLS.map(c => `IF(ISNUMBER(${ref(c, r)})${sep}(COUNTIF(${fixed(c)}${sep}"<"&${ref(c, r)})+COUNTIF(${fixed(c)}${sep}"<="&${ref(c, r)}))/2/COUNT(${fixed(c)})*100${sep}0)`);
        const n = `COUNT(${rowRange(r)})`;
        return `IF(${n}=0${sep}""${sep}(${terms.join('+')})/${n})`;
      },
      ram: r => `${ref(COL(IDX.params_b), r)}*${param}`,
    };
  }

  function colorScale(s, d) {
    const end = toHex(blend(HUES[s.hue], 0.55));
    let cfvo;
    if (s.recent) cfvo = [{ t: 'number', v: serial(d.now - 365 * 864e5) }, { t: 'number', v: serial(d.now) }];
    else if (s.pct) cfvo = [{ t: 'percentile', v: 5 }, { t: 'maximum' }];
    else cfvo = [{ t: 'number', v: s.lo }, { t: 'number', v: s.hi }];
    return { cfvo, colors: ['#ffffff', end] };
  }

  function cellFill(m, s, d) {
    if (s.tint === 'org') return tintOf(d.orgs[m.org], 0.16);
    if (s.tint === 'country') return tintOf(d.countries[m.country] && d.countries[m.country].color, 0.16);
    if (s.heat) { const a = heatAlpha(m.ver_t || 0); return a ? toHex(blend(HUES.new, a)) : null; }
    return null;
  }

  function aboutRows(d) {
    return [
      [{ v: 'Open Models', bold: 1 }],
      [{ v: 'Open-weight LLMs for self-hosting, with benchmark scores. Data exported ' + d.generated + '. Live page: https://jesse-hufstetler.github.io/open-models/' }],
      [],
      [{ v: 'Setting', bold: 1 }, { v: 'Value', bold: 1 }, { v: 'Notes', bold: 1 }],
      [{ v: 'Q4 GB per billion params' }, { v: 0.57, input: 1 }, { v: 'Used by the RAM GB (Q4) column on the Models sheet (Params B x this number). Weights only. Try 1 for Q8 or 2 for FP16, then add 10-30% for context cache and overhead.', wrap: 1 }],
      [],
      [{ v: 'Score', bold: 1 }, {}, { v: 'Each of the six intelligence scores is turned into a percentile rank among all models that have it (ties share the average rank), then averaged over the scores a model has. 0-100. It is a spreadsheet formula, so it updates if you edit a score.', wrap: 1 }],
      [{ v: 'Active B', bold: 1 }, {}, { v: 'Parameters used per token, in billions. Dense models list their total parameters here so mixture-of-experts and dense models sort together.', wrap: 1 }],
      [{ v: 'Colors', bold: 1 }, {}, { v: 'Org and country tints are fixed fills. Number columns use conditional-formatting color scales; created/updated are relative to the export date.', wrap: 1 }],
      [{ v: 'Sources', bold: 1 }, {}, { v: 'Artificial Analysis (artificialanalysis.ai), Epoch AI (epoch.ai, CC BY), Hugging Face, OpenRouter. Made by Jesse Hufstetler: https://jesse-hufstetler.github.io/', wrap: 1 }],
    ];
  }
  const ABOUT_WIDTHS = [30, 12, 100];

  // ---------- CSV ----------
  function csv(d) {
    const q = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const out = [d.cols.map(c => q(c.label)).join(',')];
    for (const m of d.models) {
      out.push(SPEC.map(s => {
        const v = value(m, s);
        if (v == null) return '';
        if (s.kind === 'date') return v.toISOString().slice(0, 10);
        if (s.calc) return q(Math.round(v * 100) / 100);
        return q(v);
      }).join(','));
    }
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  // ---------- XLSX ----------
  async function xlsx(d) {
    const wb = new root.ExcelJS.Workbook();
    wb.creator = 'Open Models';
    const last = d.models.length + 1;
    const f = formulas(false, last);
    const ws = wb.addWorksheet('Models', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = SPEC.map(s => ({ width: s.w }));
    const solid = hex => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex.slice(1).toUpperCase() } });
    const labels = SPEC.map(s => d.cols.find(c => c.k === s.k) || { label: s.k, tip: '' });
    const hr = ws.addRow(labels.map(c => c.label));
    hr.eachCell((cell, i) => {
      cell.font = { bold: true };
      cell.fill = solid('#ececee');
      cell.alignment = { horizontal: SPEC[i - 1].center ? 'center' : 'left', vertical: 'middle' };
      if (labels[i - 1].tip) cell.note = labels[i - 1].tip;
    });
    d.models.forEach((m, n) => {
      const r = n + 2;
      const row = ws.addRow(SPEC.map(s => {
        const v = value(m, s);
        if (s.calc) return { formula: f[s.calc](r), ...(d.noCache ? {} : { result: v == null ? '' : v }) };
        if (s.kind === 'link') return { text: v, hyperlink: 'https://huggingface.co/' + v };
        return v;
      }));
      row.eachCell({ includeEmpty: true }, (cell, i) => {
        const s = SPEC[i - 1];
        const fill = cellFill(m, s, d);
        if (fill) cell.fill = solid(fill);
        if (s.nf) cell.numFmt = s.nf === 'date' ? 'yyyy-mm-dd' : s.nf;
        if (s.center) cell.alignment = { horizontal: 'center' };
      });
    });
    ws.autoFilter = { from: 'A1', to: COL(SPEC.length - 1) + last };
    SPEC.forEach((s, i) => {
      if (!s.hue) return;
      const sc = colorScale(s, d);
      const cf = c => ({ type: c.t === 'maximum' ? 'max' : c.t === 'number' ? 'num' : 'percentile', ...(c.v != null ? { value: c.v } : {}) });
      ws.addConditionalFormatting({
        ref: `${COL(i)}2:${COL(i)}${last}`,
        rules: [{ type: 'colorScale', cfvo: sc.cfvo.map(cf), color: sc.colors.map(c => ({ argb: 'FF' + c.slice(1).toUpperCase() })) }],
      });
    });
    const about = wb.addWorksheet('About');
    about.columns = ABOUT_WIDTHS.map(width => ({ width }));
    aboutRows(d).forEach(cells => {
      const row = about.addRow(cells.map(c => c.v == null ? null : c.v));
      cells.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        cell.alignment = { vertical: 'top', wrapText: !!c.wrap };
        if (c.bold) cell.font = { bold: true };
        if (c.input) cell.fill = solid('#fff3bf');
      });
    });
    return wb.xlsx.writeBuffer();
  }

  // ---------- ODS ----------
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NF = { '0': 'N0', '0.0#': 'N1', '0.0': 'N1f', '#,##0': 'NG', date: 'ND' };

  async function ods(d) {
    const last = d.models.length + 1;
    const f = formulas(true, last);
    const styles = new Map();
    const style = o => { const k = JSON.stringify(o); if (!styles.has(k)) styles.set(k, { name: 'ce' + styles.size, o }); return styles.get(k).name; };
    const para = s => String(s).split('\n').map(l => `<text:p>${esc(l)}</text:p>`).join('');
    const cell = (o, body, attrs) => `<table:table-cell table:style-name="${style(o)}"${attrs || ''}>${body || ''}</table:table-cell>`;
    const str = (o, text, extra) => cell(o, `<text:p>${esc(text)}</text:p>`, ' office:value-type="string"' + (extra || ''));
    const flt = (o, v, extra) => cell(o, `<text:p>${v}</text:p>`, ` office:value-type="float" office:value="${v}"` + (extra || ''));

    const labels = SPEC.map(s => d.cols.find(c => c.k === s.k) || { label: s.k, tip: '' });
    let rows = '<table:table-row>' + SPEC.map((s, i) => {
      const o = { fill: '#ececee', bold: 1, center: s.center ? 1 : 0 };
      const note = labels[i].tip ? `<office:annotation><dc:creator>Open Models</dc:creator>${para(labels[i].tip)}</office:annotation>` : '';
      return cell(o, note + `<text:p>${esc(labels[i].label)}</text:p>`, ' office:value-type="string"');
    }).join('') + '</table:table-row>';

    d.models.forEach((m, n) => {
      const r = n + 2;
      rows += '<table:table-row>' + SPEC.map(s => {
        const v = value(m, s);
        const o = { fill: cellFill(m, s, d), nf: s.nf ? NF[s.nf] : null, center: s.center ? 1 : 0 };
        if (s.calc) {
          const fa = ` table:formula="${esc('of:=' + f[s.calc](r))}"`;
          if (d.noCache || v == null) return cell(o, v == null ? '<text:p/>' : '', fa + (v == null ? ' office:value-type="string" office:string-value=""' : ''));
          return flt(o, v, fa);
        }
        if (v == null) return cell(o);
        if (s.kind === 'date') return cell(o, `<text:p>${v.toISOString().slice(0, 10)}</text:p>`, ` office:value-type="date" office:date-value="${v.toISOString().slice(0, 10)}"`);
        if (s.kind === 'link') return cell(o, `<text:p><text:a xlink:href="https://huggingface.co/${esc(v)}" xlink:type="simple">${esc(v)}</text:a></text:p>`, ' office:value-type="string"');
        if (s.kind === 'num') return flt(o, v);
        return str(o, v);
      }).join('') + '</table:table-row>';
    });

    const cfs = SPEC.map((s, i) => {
      if (!s.hue) return '';
      const sc = colorScale(s, d);
      const entries = sc.cfvo.map((c, j) => `<calcext:color-scale-entry calcext:value="${c.v == null ? 0 : c.v}" calcext:type="${c.t}" calcext:color="${sc.colors[j]}"/>`).join('');
      return `<calcext:conditional-format calcext:target-range-address="Models.${COL(i)}2:Models.${COL(i)}${last}"><calcext:color-scale>${entries}</calcext:color-scale></calcext:conditional-format>`;
    }).join('');

    const cols = SPEC.map(s => `<table:table-column table:style-name="${'co' + s.w}"/>`).join('');
    const aboutCols = ABOUT_WIDTHS.map(w => `<table:table-column table:style-name="${'co' + w}"/>`).join('');
    const aboutBody = aboutRows(d).map(cells => '<table:table-row>' + (cells.length ? cells.map(c => {
      const o = { bold: c.bold ? 1 : 0, wrap: c.wrap ? 1 : 0, fill: c.input ? '#fff3bf' : null };
      if (c.v == null) return cell(o);
      return typeof c.v === 'number' ? flt(o, c.v) : str(o, c.v);
    }).join('') : '<table:table-cell/>') + '</table:table-row>').join('');

    const widths = [...new Set([...SPEC.map(s => s.w), ...ABOUT_WIDTHS])];
    const colStyles = widths.map(w => `<style:style style:name="co${w}" style:family="table-column"><style:table-column-properties style:column-width="${(w * 0.075 + 0.1).toFixed(3)}in"/></style:style>`).join('');
    const cellStyles = [...styles.values()].map(({ name, o }) => {
      const cp = [o.fill ? `fo:background-color="${o.fill}"` : '', o.wrap ? 'fo:wrap-option="wrap" style:vertical-align="top"' : ''].filter(Boolean).join(' ');
      return `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${o.nf ? ` style:data-style-name="${o.nf}"` : ''}>` +
        (cp ? `<style:table-cell-properties ${cp}/>` : '') +
        (o.center ? '<style:paragraph-properties fo:text-align="center"/>' : '') +
        (o.bold ? '<style:text-properties fo:font-weight="bold"/>' : '') + '</style:style>';
    }).join('');
    const numStyles =
      '<number:number-style style:name="N0"><number:number number:decimal-places="0" number:min-integer-digits="1"/></number:number-style>' +
      '<number:number-style style:name="N1"><number:number number:decimal-places="2" loext:min-decimal-places="1" number:min-integer-digits="1"/></number:number-style>' +
      '<number:number-style style:name="N1f"><number:number number:decimal-places="1" number:min-integer-digits="1"/></number:number-style>' +
      '<number:number-style style:name="NG"><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/></number:number-style>' +
      '<number:date-style style:name="ND"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>';

    const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"';
    const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:automatic-styles>${colStyles}${numStyles}${cellStyles}</office:automatic-styles><office:body><office:spreadsheet>` +
      `<table:table table:name="Models">${cols}${rows}<calcext:conditional-formats>${cfs}</calcext:conditional-formats></table:table>` +
      `<table:table table:name="About">${aboutCols}${aboutBody}</table:table>` +
      `<table:database-ranges><table:database-range table:name="__Anonymous_Sheet_DB__0" table:target-range-address="Models.A1:Models.${COL(SPEC.length - 1)}${last}" table:display-filter-buttons="true"/></table:database-ranges>` +
      '</office:spreadsheet></office:body></office:document-content>';

    const styleXml = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles><style:default-style style:family="table-cell"/><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`;
    const item = (name, type, v) => `<config:config-item config:name="${name}" config:type="${type}">${v}</config:config-item>`;
    // Settings are what make the header row stay put (frozen pane) when you scroll.
    const settings = '<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"><office:settings><config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
      item('ViewId', 'string', 'view1') +
      '<config:config-item-map-named config:name="Tables"><config:config-item-map-entry config:name="Models">' +
      item('HorizontalSplitMode', 'short', 0) + item('VerticalSplitMode', 'short', 2) + item('HorizontalSplitPosition', 'int', 0) + item('VerticalSplitPosition', 'int', 1) +
      item('ActiveSplitRange', 'short', 2) + item('PositionLeft', 'int', 0) + item('PositionRight', 'int', 0) + item('PositionTop', 'int', 0) + item('PositionBottom', 'int', 1) +
      '</config:config-item-map-entry></config:config-item-map-named>' +
      item('ActiveTable', 'string', 'Models') +
      '</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set></office:settings></office:document-settings>';
    const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/></manifest:manifest>';

    const MIME = 'application/vnd.oasis.opendocument.spreadsheet';
    const zip = new root.JSZip();
    zip.file('mimetype', MIME, { compression: 'STORE' });
    zip.file('META-INF/manifest.xml', manifest);
    zip.file('content.xml', content);
    zip.file('styles.xml', styleXml);
    zip.file('settings.xml', settings);
    return zip.generateAsync({ type: 'uint8array', mimeType: MIME, compression: 'DEFLATE' });
  }

  function download(name, data, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  root.OMExport = { csv, xlsx, ods, download };
})(typeof window !== 'undefined' ? window : globalThis);
