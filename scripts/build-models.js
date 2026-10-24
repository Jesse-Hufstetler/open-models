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
const PIPELINES = new Set(['text-generation', 'image-text-to-text', 'any-to-any']);
const SKIP = /(awq|gptq|gguf|fp8|fp4|mlx|bnb|int[48]|[1248]bit|w4a16|w8a8|quantized|tiny-random|^tiny-|oblit|eagle|speculator|onnx)/i;
const PRECISION = /^(bf16|fp16|f16)$/i;
const SIZE = /^\d+(\.\d+)?[BMK]$/i;
const ACTIVE = /^A\d+(\.\d+)?B$/i;
const VERSION = /^[vr]?\d+(\.\d+)*$/i;
const PRODUCT_ALIASES = { 'gpt-oss': /^gpt-oss/i };

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'open-models-build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(getJson(res.headers.location));
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

async function main() {
  const authors = Object.keys(ORGS.orgs);
  const [lists, or] = await Promise.all([
    Promise.all(authors.map(a => getJson(
      'https://huggingface.co/api/models?author=' + encodeURIComponent(a) +
      '&sort=downloads&direction=-1&limit=' + PER_ORG +
      '&expand[]=safetensors&expand[]=downloads&expand[]=likes&expand[]=tags&expand[]=lastModified' +
      '&expand[]=createdAt&expand[]=pipeline_tag'))),
    getJson('https://openrouter.ai/api/v1/models'),
  ]);

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
        context: o ? o.context_length : null,
        price_in: o ? Number(o.pricing.prompt) * 1e6 : null,
        price_out: o ? Number(o.pricing.completion) * 1e6 : null,
      });
    }
  });

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
  console.warn('build failed, keeping previous data:', e.message);
  process.exit(0);
});
