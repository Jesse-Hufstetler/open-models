// Builds data/models.json from Hugging Face + OpenRouter.
// Only orgs listed in data/orgs.json are fetched. Quantized re-uploads and
// test models are skipped so each release appears once.
// On any failure it leaves the previous file untouched and exits 0,
// so a flaky API never turns into a red X and an email.
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'models.json');
const ORGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'orgs.json'), 'utf8'));
const PER_ORG = 100;
const NEWEST_PER_ORG = 30;
const NEW_ORGS = path.join(__dirname, '..', 'data', 'new-orgs.json');

// Anything reported here makes the workflow open one GitHub issue (see update.yml). The build itself still
// succeeds on partial failure so the last good data stays published.
function problem(msg) {
  console.warn(msg);
  if (process.env.STATUS_FILE) fs.appendFileSync(process.env.STATUS_FILE, msg + '\n');
}
const PIPELINES = new Set(['text-generation', 'image-text-to-text', 'any-to-any']);
const SKIP = /(awq|gptq|gguf|fp8|fp4|mlx|bnb|int[48]|[1248]bit|w4a16|w8a8|quantized|tiny-random|^tiny-|oblit|eagle|speculator|onnx)/i;
const PRECISION = /^(bf16|fp16|f16)$/i;
const SIZE = /^\d+(\.\d+)?[BMK]$/i;
const ACTIVE = /^A\d+(\.\d+)?B$/i;
const VERSION = /^[vr]?\d+(\.\d+)*$/i;
const PRODUCT_ALIASES = { 'gpt-oss': /^gpt-oss/i };

const SCORES = path.join(__dirname, '..', 'data', 'scores.json');
// Free tier is 100 requests/day: one daily run uses 1-2. Cap per run, and skip if the cache is fresh.
const AA_MAX_REQUESTS = 4;
const AA_MIN_AGE_H = 20;
const norm = s => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: Object.assign({ 'User-Agent': 'open-models-build' }, headers) }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(getJson(res.headers.location, headers));
      }
      if (res.statusCode !== 200) return reject(new Error(res.statusCode + ' ' + url));
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// "NVIDIA-Nemotron-3-Nano-30B-A3B-BF16" -> product Nemotron, version 3, variant Nano
function parseName(name, author, orgName) {
  let tokens = name.split('-');
  let product = null, version = '';

  for (const [alias, re] of Object.entries(PRODUCT_ALIASES)) {
    if (re.test(name)) { product = alias; tokens = tokens.slice(alias.split('-').length); }
  }
  if (!product) {
    const first = tokens[0].toLowerCase();
    if (tokens.length > 1 && first === author.toLowerCase()) tokens.shift();
    const m = tokens[0].match(/^([A-Za-z]+?)(\d+(?:\.\d+)*)$/);
    if (m) { product = m[1]; version = m[2]; } else { product = tokens[0]; }
    tokens.shift();
  }
  if (!version) {
    const i = tokens.findIndex(t => VERSION.test(t) && parseFloat(t.replace(/^[vr]/i, '')) < 100); // 2048, 2507 etc. are not versions
    if (i >= 0) { version = tokens[i]; tokens.splice(i, 1); }
  }
  if (product === product.toLowerCase() && product !== 'gpt-oss') product = product[0].toUpperCase() + product.slice(1);

  const activeTok = tokens.find(t => ACTIVE.test(t));
  const variant = tokens.filter(t => !SIZE.test(t) && !ACTIVE.test(t) && !PRECISION.test(t)).join(' ');
  return { product, version, variant, active_b: activeTok ? parseFloat(activeTok.slice(1)) : null };
}

const EPOCH = path.join(__dirname, '..', 'data', 'epoch.json');
const normV = s => norm(s.replace(/_[a-z0-9]+$/i, '')); // Epoch model_version ends in _<effort>, e.g. _xhigh

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// Epoch publishes one ZIP of CSVs (CC BY). The workflow downloads it to EPOCH_DIR; we keep the columns we use.
function loadEpoch() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(EPOCH, 'utf8')); } catch (e) {}
  const dir = process.env.EPOCH_DIR;
  if (!dir) { console.log('Epoch: no download, using cached scores'); return prev; }
  try {
    const read = f => parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
    const pick = (rows, nameKey, valKey, scale) => rows
      .map(r => ({ name: r[nameKey], v: parseFloat(r[valKey]) * scale }))
      .filter(r => r.name && isFinite(r.v));
    const out = {
      fetched: new Date().toISOString(),
      source: 'Epoch AI (CC BY 4.0)',
      eci: read('epoch_capabilities_index/eci_scores.csv')
        .map(r => ({ name: r['Display name'], v: parseFloat(r.eci), org: r.Organization, open: /open/i.test(r['Accessibility group'] || '') }))
        .filter(r => r.name && isFinite(r.v)),
      gpqa: pick(read('gpqa_diamond.csv'), 'Model version', 'mean_score', 100),
      swe: pick(read('swe_bench_verified.csv'), 'Model version', 'mean_score', 100),
    };
    if (!out.eci.length) throw new Error('no ECI rows');
    fs.writeFileSync(EPOCH, JSON.stringify(out, null, 1));
    console.log('Epoch: ' + out.eci.length + ' ECI, ' + out.gpqa.length + ' GPQA, ' + out.swe.length + ' SWE-bench rows');
    return out;
  } catch (e) {
    problem('Epoch data could not be read, keeping cached scores: ' + e.message);
    return prev;
  }
}

async function loadAa() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(SCORES, 'utf8')); } catch (e) {}
  const key = process.env.AA_API_KEY;
  if (!key) { console.log('AA: no key, using cached scores'); return prev; }
  if (prev && Date.now() - Date.parse(prev.fetched) < AA_MIN_AGE_H * 3600e3) {
    console.log('AA: cache is fresh, not calling the API');
    return prev;
  }
  try {
    const out = [];
    let requests = 0;
    for (let page = 1; page <= AA_MAX_REQUESTS; page++) {
      requests++;
      const r = await getJson('https://artificialanalysis.ai/api/v2/language/models/free?page=' + page + '&page_size=100', { 'x-api-key': key });
      if (!Array.isArray(r.data)) throw new Error('unexpected response shape: ' + Object.keys(r).join(','));
      for (const m of r.data) {
        const e = m.evaluations || {};
        out.push({
          name: m.name,
          slug: m.slug,
          creator: m.model_creator && m.model_creator.name,
          released: m.release_date,
          intelligence: e.artificial_analysis_intelligence_index,
          coding: e.artificial_analysis_coding_index,
          agentic: e.artificial_analysis_agentic_index,
          tps: m.performance && m.performance.median_output_tokens_per_second,
        });
      }
      if (!(r.pagination && r.pagination.has_more)) break;
    }
    const scores = { fetched: new Date().toISOString(), source: 'Artificial Analysis', models: out };
    fs.writeFileSync(SCORES, JSON.stringify(scores, null, 1));
    console.log('AA: fetched ' + out.length + ' models in ' + requests + ' request(s)');
    return scores;
  } catch (e) {
    problem('Artificial Analysis fetch failed, keeping cached scores: ' + e.message);
    return prev;
  }
}

async function main() {
  const authors = Object.keys(ORGS.orgs);
  const hfUrl = (author, sort, limit) =>
    'https://huggingface.co/api/models?author=' + encodeURIComponent(author) +
    '&sort=' + sort + '&direction=-1&limit=' + limit +
    '&expand[]=safetensors&expand[]=downloads&expand[]=likes&expand[]=tags&expand[]=lastModified' +
    '&expand[]=createdAt&expand[]=pipeline_tag';
  // Most-downloaded catches the established models; newest catches fresh releases that have few downloads yet.
  const [lists, or] = await Promise.all([
    Promise.all(authors.map(async a => {
      const [top, fresh] = await Promise.all([
        getJson(hfUrl(a, 'downloads', PER_ORG)),
        getJson(hfUrl(a, 'createdAt', NEWEST_PER_ORG)),
      ]);
      const seen = new Set(top.map(m => m.id));
      return top.concat(fresh.filter(m => !seen.has(m.id)));
    })),
    getJson('https://openrouter.ai/api/v1/models'),
  ]);

  const aa = await loadAa();
  const aaByName = {};
  if (aa) {
    for (const m of aa.models) {
      const k = norm(m.name);
      // AA lists reasoning and non-reasoning variants under one name; keep the stronger one.
      if (m.intelligence != null && (!aaByName[k] || m.intelligence > aaByName[k].intelligence)) aaByName[k] = m;
    }
  }
  const epoch = loadEpoch();
  const ep = { eci: {}, gpqa: {}, swe: {} };
  if (epoch) {
    for (const k of Object.keys(ep)) {
      for (const r of epoch[k] || []) {
        const n = normV(r.name);
        if (ep[k][n] == null || r.v > ep[k][n]) ep[k][n] = r.v;
      }
    }
  }
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  let aaMatched = 0, epochMatched = 0;

  const orByHf = {};
  for (const m of or.data || []) {
    if (m.hugging_face_id) orByHf[m.hugging_face_id] = m;
  }

  const models = [];
  lists.forEach((list, i) => {
    const author = authors[i], org = ORGS.orgs[author];
    for (const m of list) {
      const name = m.id.split('/')[1];
      if (!PIPELINES.has(m.pipeline_tag) || SKIP.test(name)) continue;
      // Some labs (e.g. Mistral) ship without safetensors metadata; fall back to the size in the name.
      const sized = name.split('-').find(t => /^\d+(\.\d+)?B$/i.test(t));
      const params = m.safetensors && m.safetensors.total ? Math.round(m.safetensors.total / 1e7) / 100
        : sized ? parseFloat(sized) : null;
      if (!params) continue;
      const o = orByHf[m.id];
      const license = (m.tags.find(t => t.startsWith('license:')) || '').slice(8) || null;
      const a = aaByName[norm(name)];
      if (a) aaMatched++;
      const en = normV(name), eci = ep.eci[en];
      if (eci != null) epochMatched++;
      models.push({
        id: m.id,
        country: org.country,
        org: org.org,
        ...parseName(name, author, org.org),
        params_b: params,
        downloads: m.downloads,
        likes: m.likes,
        license,
        created: m.createdAt ? m.createdAt.slice(0, 10) : null,
        updated: m.lastModified ? m.lastModified.slice(0, 10) : null,
        aa_intel: a ? a.intelligence : null,
        aa_coding: a ? a.coding : null,
        aa_agentic: a ? a.agentic : null,
        aa_tps: a ? a.tps : null,
        epoch_eci: r1(eci),
        epoch_gpqa: r1(ep.gpqa[en]),
        epoch_swe: r1(ep.swe[en]),
        context: o ? o.context_length : null,
        price_in: o ? Number(o.pricing.prompt) * 1e6 : null,
        price_out: o ? Number(o.pricing.completion) * 1e6 : null,
      });
    }
  });

  // Labs that Epoch marks open-weight but that aren't in data/orgs.json yet: the list to extend next.
  const known = Object.entries(ORGS.orgs).flatMap(([author, o]) => [norm(author), norm(o.org)].concat((o.aliases || []).map(norm)));
  const missing = {};
  for (const r of (epoch && epoch.eci) || []) {
    if (!r.open || !r.org) continue;
    const n = norm(r.org);
    if (known.some(k => k && (n.includes(k) || k.includes(n)))) continue;
    (missing[r.org] = missing[r.org] || []).push(r.name);
  }
  const newOrgs = Object.entries(missing).sort().map(([org, names]) => ({ org, count: names.length, examples: names.slice(0, 3) }));
  fs.writeFileSync(NEW_ORGS, JSON.stringify(newOrgs, null, 1));
  if (newOrgs.length) console.log('New open-weight labs not in orgs.json: ' + newOrgs.map(o => o.org).join(', '));

  if (aa) console.log('AA: matched ' + aaMatched + ' of ' + aa.models.length + ' AA models to rows');
  if (epoch) console.log('Epoch: matched ' + epochMatched + ' ECI rows to models');
  if (models.length < 20) throw new Error('suspiciously few models: ' + models.length);

  // Only rewrite when the data changed, so the Action doesn't commit noise.
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  if (prev && JSON.stringify(prev.models) === JSON.stringify(models)) {
    console.log('No changes.');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), models }, null, 1));
  console.log('Wrote ' + models.length + ' models.');
}

main().catch(e => {
  problem('Build failed, keeping previous data: ' + e.message);
  process.exit(0);
});
