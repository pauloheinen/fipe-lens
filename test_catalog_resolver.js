/**
 * test_catalog_resolver.js
 * Testa o novo resolver baseado em catálogo contra anúncios reais do Facebook.html
 * Uso: node test_catalog_resolver.js
 *
 * Usa BrasilAPI como fonte (mesmo conjunto de dados FIPE, schema levemente diferente):
 *   /api/fipe/marcas/v1/motos     → [{nome, valor}]
 *   /api/fipe/veiculos/v1/motos/{marcaId}  → [{modelo, valor}]
 *   /api/fipe/anos/v1/motos/{marcaId}/{modeloId} → [{codigo, nome}]
 *   /api/fipe/preco/v1/motos/{marcaId}/{modeloId}/{anoId} → {...,Valor,...}
 */

const fs = require("fs");
const path = require("path");

const BRASIL_API = "https://brasilapi.com.br/api/fipe";
const CACHE_FILE = path.join(__dirname, "fipe_cache_test.json");
const CATALOG_FILE = path.join(__dirname, "fipe_catalog_index.json");
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── cache em disco (simula chrome.storage.local) ────────────────────────────

let diskCache = {};
try { diskCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch {}
function saveDiskCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(diskCache, null, 2));
}

let reqCount = 0;
async function cachedFetch(url) {
  const key = `req:${url}`;
  const now = Date.now();
  const saved = diskCache[key];
  if (saved && saved.value && saved.fetchedAt && (now - saved.fetchedAt) < CACHE_MS) {
    return saved.value;
  }
  reqCount++;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`);
  const value = await resp.json();
  diskCache[key] = { value, fetchedAt: now };
  if (reqCount % 20 === 0) saveDiskCache();
  await new Promise(r => setTimeout(r, 80));
  return value;
}

// ─── wrappers BrasilAPI ──────────────────────────────────────────────────────

async function getMarcas() {
  const raw = await cachedFetch(`${BRASIL_API}/marcas/v1/motos`);
  // raw: [{nome, valor}]  →  normaliza para {codigo, nome}
  return raw.map(m => ({ codigo: String(m.valor), nome: m.nome }));
}

async function getModelos(marcaId) {
  const raw = await cachedFetch(`${BRASIL_API}/veiculos/v1/motos/${marcaId}`);
  // raw: [{modelo, valor}]  →  normaliza para {codigo, nome}
  return raw.map(m => ({ codigo: String(m.valor), nome: m.modelo }));
}

async function getAnos(marcaId, modeloId) {
  try {
    const raw = await cachedFetch(`${BRASIL_API}/anos/v1/motos/${marcaId}/${modeloId}`);
    // raw: [{codigo: "YYYY-N", nome: "YYYY Gasolina"}]
    return raw;
  } catch {
    return [];
  }
}

// ─── helpers de texto (idênticos ao background.js) ──────────────────────────

function normalize(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanEvidence(evidence) {
  return String(evidence || "")
    .replace(/R\$\s*[\d.,]+/gi, " ")
    .replace(/\b\d{1,3}(?:\.\d{3})*\s*(?:mil\s*)?km\b/gi, " ")
    .replace(/\b\d{4,6}\s*km\b/gi, " ")
    .replace(/\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/g, " ");
}

function extractDisplacements(text) {
  const norm = normalize(text);
  const found = new Set();
  for (const token of norm.split(" ").filter(Boolean)) {
    const num = Number(token);
    if (Number.isInteger(num) && num >= 50 && num <= 1400 && (num < 1980 || num > 2030)) found.add(token);
    // captura cilindrada colada: "CBX250", "CB300R", "CB500F" → "250", "300", "500"
    const match = token.match(/^[A-Z]{1,4}(\d{2,4})[A-Z]{0,2}$/);
    if (match) {
      const n = Number(match[1]);
      if (n >= 50 && n <= 1400 && (n < 1980 || n > 2030)) found.add(match[1]);
    }
  }
  return found;
}

/** Extrai tokens de modelo do texto, expandindo tokens colados como "CB500F" → ["CB","500","F"] */
function expandTokens(normText) {
  const tokens = normText.split(" ").filter(Boolean);
  const expanded = new Set(tokens);
  for (const token of tokens) {
    // CB500F → CB, 500, F
    const m = token.match(/^([A-Z]{1,4})(\d{2,4})([A-Z]{0,2})$/);
    if (m) {
      if (m[1]) expanded.add(m[1]);
      if (m[2]) expanded.add(m[2]);
      if (m[3]) expanded.add(m[3]);
    }
  }
  return expanded;
}

const NOISE_TOKENS = new Set([
  "FLEX","FLEXONE","BLUEFLEX","ABS","CBS","EDICAO","ESPECIAL","SPECIAL","EDITION",
  "SERIES","LIMITED","STD","ES","ESD","EX","ESDI","KS","KSE","SPORT","RALLY",
  "ADVENTURE","DISCO","PARTIDA","ELETRICA","INJECAO","CARBURADA","BLACK","WHITE",
  "REPSOL","RACE","RACING"
]);

function getCoreTokens(modelName) {
  const tokens = normalize(modelName).split(" ").filter(Boolean);
  const core = tokens.filter(t => !NOISE_TOKENS.has(t));
  return core.length ? core : tokens;
}

function scoreModel(modelName, evidenceNorm, evTokensSet, evidenceDisplacements) {
  const core = getCoreTokens(modelName);
  const modelDisplacements = core.flatMap(t => (t.match(/\d{2,4}/g) || []).filter(part => Number(part) >= 50 && Number(part) <= 1400));
  if (evidenceDisplacements.size > 0 && modelDisplacements.length > 0) {
    if (!modelDisplacements.some(d => evidenceDisplacements.has(d))) return -100;
  }
  let score = 0, matchedCore = 0, matchedNameToken = 0;
  for (const token of core) {
    if (evTokensSet.has(token)) { score += 25; matchedCore++; if (!/^\d+$/.test(token)) matchedNameToken++; }
    else if (/^\d+$/.test(token)) {
      const glued = [...evTokensSet].some(w => w.includes(token) && new RegExp(`^[A-Z]{1,3}${token}[A-Z]?$`).test(w));
      if (glued) { score += 25; matchedCore++; }
    }
  }
  if (matchedNameToken === 0) return 0;
  if (matchedCore === core.length) score += 50;
  else if (matchedCore >= 2) score += 15 * (matchedCore / core.length);
  const corePhrase = core.join(" ");
  if (corePhrase.length > 3 && evidenceNorm.includes(corePhrase)) score += 40;
  return score;
}

/**
 * Retorna o "nome de família" de um modelo, removendo sufixos de versão.
 * Permite agrupar variantes (ES/EX/ESD/ABS) como mesma família antes de declarar ambiguidade.
 */
const FAMILY_NOISE = new Set([
  "ES","EX","ESD","ESDI","KS","KSE","SE","STD","MIX","FLEX","FLEXONE","BLUEFLEX",
  "GASOLINA","ALCOOL","SPECIAL","EDITION","LIMITED","ANNIVERSARY","25TH",
  "ABS","CBS","TRAIL","RALLY","ADVENTURE","BLACK","WHITE","REPSOL","RACE","RACING"
]);

function modelFamily(modelName) {
  const tokens = normalize(modelName).split(" ").filter(Boolean);
  const family = [];
  for (const t of tokens) {
    if (FAMILY_NOISE.has(t) && family.length > 0) break;
    if (t === "/" || t.startsWith("/")) break;
    family.push(t);
  }
  return family.join(" ");
}



let catalogCache = null;

async function getCatalogIndex() {
  if (catalogCache) return catalogCache;
  if (fs.existsSync(CATALOG_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    if (saved.entries && saved.entries.length > 0) {
      catalogCache = saved.entries;
      console.log(`  [catalog] Carregado do disco: ${catalogCache.length} modelos`);
      return catalogCache;
    }
  }
  console.log("  [catalog] Construindo índice via BrasilAPI...");
  const brands = await getMarcas();
  console.log(`  [catalog] ${brands.length} marcas encontradas`);

  const allEntries = [];
  for (const brand of brands) {
    let models;
    try { models = await getModelos(brand.codigo); } catch { models = []; }
    process.stdout.write(`\r  [catalog] ${brand.nome}: ${models.length} modelos...`);

    const BATCH = 6;
    for (let i = 0; i < models.length; i += BATCH) {
      const batch = models.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (model) => {
        const anos = await getAnos(brand.codigo, model.codigo);
        // BrasilAPI usa 'valor'; Parallelum usa 'codigo' — suporta ambos
        const years = anos
          .map(a => parseInt(String(a.valor || a.codigo || "").split("-")[0], 10))
          .filter(y => Number.isFinite(y) && y > 1950 && y < 2100);
        return years.length > 0 ? {
          brandId: brand.codigo,
          brandName: brand.nome,
          modelId: model.codigo,
          modelName: model.nome,
          years
        } : null;
      }));
      for (const e of results) if (e) allEntries.push(e);
    }
  }

  saveDiskCache();
  console.log(`\n  [catalog] Pronto: ${allEntries.length} entradas`);
  fs.writeFileSync(CATALOG_FILE, JSON.stringify({ entries: allEntries, builtAt: Date.now() }, null, 2));
  catalogCache = allEntries;
  return allEntries;
}

// ─── resolveQuote ─────────────────────────────────────────────────────────────

async function resolveQuote({ evidence, year }) {
  const cleanedEvidence = cleanEvidence(evidence);
  const normalizedEvidence = normalize(cleanedEvidence);
  const evTokensSet = new Set(normalizedEvidence.split(" ").filter(Boolean));
  const displacements = extractDisplacements(cleanedEvidence);
  const targetYear = Number(year);

  const brands = await getMarcas();
  const explicitBrands = brands
    .filter(b => normalize(b.nome).length > 2 && normalizedEvidence.includes(normalize(b.nome)))
    .sort((a, b) => normalize(b.nome).length - normalize(a.nome).length);

  const catalog = await getCatalogIndex();

  function filterByBrandAndYear(brandNomes, tolerance) {
    const brandIds = new Set(
      brands.filter(b => brandNomes.some(n => normalize(b.nome) === normalize(n))).map(b => b.codigo)
    );
    return catalog.filter(entry => {
      if (brandNomes.length && !brandIds.has(entry.brandId)) return false;
      if (!Number.isFinite(targetYear) || targetYear === 0) return true;
      return entry.years.some(y => Math.abs(y - targetYear) <= tolerance);
    });
  }

  function scoreCandidates(candidates) {
    return candidates
      .map(entry => ({ entry, score: scoreModel(entry.modelName, normalizedEvidence, evTokensSet, displacements) }))
      .filter(s => s.score > 20)
      .sort((a, b) => b.score - a.score);
  }

  const brandScope = explicitBrands.length > 0 ? [explicitBrands[0].nome] : [];
  let scored = scoreCandidates(filterByBrandAndYear(brandScope, 0));
  if (scored.length === 0 && Number.isFinite(targetYear) && targetYear !== 0) {
    scored = scoreCandidates(filterByBrandAndYear(brandScope, 1));
  }
  if (scored.length === 0 && brandScope.length) {
    scored = scoreCandidates(filterByBrandAndYear([], 0));
    if (scored.length === 0 && Number.isFinite(targetYear) && targetYear !== 0) {
      scored = scoreCandidates(filterByBrandAndYear([], 1));
    }
  }

  if (scored.length === 0) {
    if (explicitBrands.length === 0) throw new Error("Marca de moto não identificada nos detalhes");
    throw new Error("Modelo/cilindrada não identificados nos detalhes");
  }

  const top = scored[0];
  const runnerUp = scored[1];

  return {
    resolved: true,
    brand: top.entry.brandName,
    model: top.entry.modelName,
    year: targetYear,
    score: top.score,
    runnerUpScore: runnerUp ? runnerUp.score : 0,
    runnerUp: runnerUp ? runnerUp.entry.modelName : null,
    ambiguous: !!(runnerUp && top.score <= runnerUp.score + 20),
    explicitBrand: explicitBrands.length > 0 ? explicitBrands[0].nome : null
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== TESTE DO RESOLVER BASEADO EM CATÁLOGO ===\n");
  console.log("Carregando catálogo FIPE via BrasilAPI...");
  await getCatalogIndex();
  console.log("");

  // Avaliação em larga escala: anúncio sintético por entrada FIPE e comparação
  // entre a busca global e a árvore marca+ano antes da pontuação textual.
  const catalog = await getCatalogIndex();
  const brands = await getMarcas();
  let broadTotal = 0, broadCorrect = 0, globalCorrect = 0;
  let broadCandidates = 0, globalCandidates = 0;
  for (const truth of catalog) {
    const year = truth.years[Math.floor(truth.years.length / 2)];
    const evidence = `${truth.brandName} ${truth.modelName}`;
    const normalized = normalize(cleanEvidence(evidence));
    const tokens = expandTokens(normalized);
    const displacements = extractDisplacements(evidence);
    const score = (entry) => scoreModel(entry.modelName, normalized, tokens, displacements);
    const rank = (entries) => entries
      .map(entry => ({ entry, score: score(entry) }))
      .filter(row => row.score > 20)
      .sort((a, b) => b.score - a.score);
    const scoped = catalog.filter(entry => entry.brandId === truth.brandId && entry.years.some(y => Math.abs(y - year) <= 1));
    const global = catalog.filter(entry => entry.years.some(y => Math.abs(y - year) <= 1));
    const scopedRank = rank(scoped);
    const globalRank = rank(global);
    broadTotal++;
    broadCandidates += scoped.length;
    globalCandidates += global.length;
    if (scopedRank[0]?.entry.modelId === truth.modelId) broadCorrect++;
    if (globalRank[0]?.entry.modelId === truth.modelId) globalCorrect++;
  }
  console.log(`=== VARREDURA DO CATÁLOGO (${broadTotal} anúncios sintéticos) ===`);
  console.log(`Marca+ano: ${broadCorrect}/${broadTotal} top-1 (${(100 * broadCorrect / broadTotal).toFixed(1)}%), média ${ (broadCandidates / broadTotal).toFixed(1)} candidatos`);
  console.log(`Ano global: ${globalCorrect}/${broadTotal} top-1 (${(100 * globalCorrect / broadTotal).toFixed(1)}%), média ${(globalCandidates / broadTotal).toFixed(1)} candidatos`);

  // Casos de teste manuais (todos os que o usuário reportou como problemáticos)
  const cases = [
    // ─ Problemáticos reportados pelo usuário ─
    { id: "cb250-2018",  evidence: "R$16.500 2018 Honda cb Estrela, RS CB Twister 250", year: 2018,
      expected: "CB 250 TWISTER" },
    { id: "cb250-2009",  evidence: "R$10.000 R$11.200 2009 Honda cb Venâncio Aires, RS VENDO TWISTER 250 Oportunidade pra quem procura uma moto Honda Twister 250 Valor R$ 10.000", year: 2009,
      expected: "CBX 250 TWISTER" },
    { id: "cb300-2013",  evidence: "R$11.500 R$15.000 2013 Honda cb Lajeado, RS cabeçote novo da XRE", year: 2013,
      expected: "CB 300R" },
    { id: "cbx-2008",    evidence: "R$8.800 R$9.400 Cbx Twister 2008 - Preta 250cc Dois Lajeados, RS", year: 2008,
      expected: "CBX 250 TWISTER" },
    // ─ Outros casos comuns ─
    { id: "cb500f-2016", evidence: "2016 Honda CB500F 500cc", year: 2016,
      expected: "CB 500F" },
    { id: "fazer-2022",  evidence: "2022 Yamaha Fazer 250 FZ25 azul 8000km", year: 2022,
      expected: "FZ25" },
    { id: "ninja-2015",  evidence: "2015 Kawasaki Ninja 300 verde 15000km", year: 2015,
      expected: "NINJA 300" },
    { id: "titan-2020",  evidence: "Titan 160 2020 Honda 10000km", year: 2020,
      expected: "CG 160 TITAN" },
    { id: "bros-2012",   evidence: "2012 Honda NXR Bros 150", year: 2012,
      expected: "NXR 150 BROS" },
    { id: "fazer150-2018", evidence: "2018 Yamaha FZ15 Fazer 150 vermelha", year: 2018,
      expected: "FZ15" },
    { id: "tenere-2019",  evidence: "2019 Yamaha Tenere 250 XTZ", year: 2019,
      expected: "XTZ 250 TENERE" },
    { id: "lander-2021",  evidence: "2021 Yamaha Lander 250 XTZ250", year: 2021,
      expected: "XTZ 250 LANDER" },
    { id: "cg150-2010",   evidence: "2010 Honda CG 150 Titan ES gasolina", year: 2010,
      expected: "CG 150 TITAN" },
    { id: "biz125-2016",  evidence: "2016 Honda Biz 125 branca baixo km", year: 2016,
      expected: "BIZ 125" },
    { id: "xre300-2021",  evidence: "2021 Honda XRE 300 Adventure", year: 2021,
      expected: "XRE 300" },
    // ─ Deve FALHAR / ser identificado como peça ─
    { id: "peca-escapamento", evidence: "Escapamento original CB 300R 2013", year: 2013,
      expected: "FALHA_ESPERADA" },
  ];

  let ok = 0, ambig = 0, fail = 0, correctModel = 0;

  for (const c of cases) {
    const label = `[${c.id}] ${c.evidence.slice(0, 65)}`;
    const isPeca = c.expected === "FALHA_ESPERADA";
    try {
      const result = await resolveQuote({ evidence: c.evidence, year: c.year });
      const modelNorm = normalize(result.model);
      const expectedNorm = normalize(c.expected || "");
      const modelMatch = expectedNorm && (modelNorm.includes(expectedNorm) || expectedNorm.includes(modelNorm.split(" ").filter(t=>!/^\d+$/.test(t)).join(" ")) || modelNorm.split(" ").some(t => t.length > 3 && expectedNorm.includes(t)));

      if (isPeca) {
        fail++;
        console.log(`⚠  ${label}`);
        console.log(`   → Deveria falhar (é peça) mas resolveu: ${result.brand} / ${result.model}\n`);
      } else if (result.ambiguous) {
        ambig++;
        console.log(`⚠  ${label}`);
        console.log(`   → AMBÍGUO: "${result.model}" (score ${result.score}) vs "${result.runnerUp}" (score ${result.runnerUpScore})`);
        if (c.expected) console.log(`   → Esperado: ${c.expected}`);
        console.log("");
      } else {
        if (modelMatch) correctModel++;
        const checkMark = modelMatch ? "✓" : "≈";
        ok++;
        console.log(`${checkMark}  ${label}`);
        console.log(`   → ${result.brand} / ${result.model} (score ${result.score})`);
        if (c.expected && !modelMatch) console.log(`   ⚡ Esperado: ${c.expected}`);
        console.log("");
      }
    } catch (e) {
      if (isPeca) {
        ok++;
        console.log(`✓  ${label} (peça corretamente não resolvida)`);
        console.log(`   → ${e.message}\n`);
      } else {
        fail++;
        console.log(`✗  ${label}`);
        console.log(`   → ${e.message}`);
        if (c.expected) console.log(`   → Esperado: ${c.expected}`);
        console.log("");
      }
    }
  }

  saveDiskCache();
  console.log(`\n=== RESUMO ===`);
  console.log(`Resolvidos: ${ok} | Ambíguos: ${ambig} | Falhas: ${fail} | Total: ${cases.length}`);
  console.log(`Modelo correto (dos resolvidos): ${correctModel}/${ok}`);
  console.log(`Requests à API (novas, não cacheadas): ${reqCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });
