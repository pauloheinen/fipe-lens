const API = "https://parallelum.com.br/fipe/api/v1/motos";
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── helpers de texto ───────────────────────────────────────────────────────

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove ruído do texto do anúncio antes de comparar com modelos FIPE */
function cleanEvidence(evidence) {
  return String(evidence || "")
    .replace(/R\$\s*[\d.,]+/gi, " ")          // preços (ex: R$16.500)
    .replace(/\b\d{1,3}(?:\.\d{3})*\s*(?:mil\s*)?km\b/gi, " ")  // quilometragem
    .replace(/\b\d{4,6}\s*km\b/gi, " ")
    .replace(/\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/g, " ");           // telefones
}

/** Extrai tokens de cilindrada do texto (50–1400 cc, exclui anos 1900–2030) */
function extractDisplacements(text) {
  const norm = normalize(text);
  const found = new Set();
  const tokens = norm.split(" ").filter(Boolean);
  for (const token of tokens) {
    const num = Number(token);
    if (Number.isInteger(num) && num >= 50 && num <= 1400 && (num < 1980 || num > 2030)) {
      found.add(token);
    }
    // captura cilindrada colada: "CBX250", "CB300R" → "250", "300"
    const match = token.match(/^[A-Z]{1,4}(\d{2,4})[A-Z]{0,2}$/);
    if (match) {
      const gluedNum = Number(match[1]);
      if (gluedNum >= 50 && gluedNum <= 1400 && (gluedNum < 1980 || gluedNum > 2030)) {
        found.add(match[1]);
      }
    }
  }
  return found;
}

/** Tokens de sufixo que não identificam o modelo e podem ser ignorados na comparação */
const NOISE_TOKENS = new Set([
  "FLEX", "FLEXONE", "BLUEFLEX", "ABS", "CBS", "EDICAO", "ESPECIAL",
  "SPECIAL", "EDITION", "SERIES", "LIMITED", "STD", "ES", "ESD", "EX",
  "ESDI", "KS", "KSE", "SPORT", "RALLY", "ADVENTURE", "DISCO",
  "PARTIDA", "ELETRICA", "INJECAO", "CARBURADA", "BLACK", "WHITE",
  "REPSOL", "RACE", "RACING"
]);

function getCoreTokens(modelName) {
  const tokens = normalize(modelName).split(" ").filter(Boolean);
  const core = tokens.filter((t) => !NOISE_TOKENS.has(t));
  return core.length ? core : tokens;
}

// ─── cache de API FIPE ──────────────────────────────────────────────────────

async function cachedJson(path) {
  const key = `fipe:${path}`;
  const now = Date.now();
  const saved = (await chrome.storage.local.get(key))[key];
  if (saved && saved.value) {
    const fetchedAt = saved.fetchedAt || (saved.expires - CACHE_MS);
    const expires = fetchedAt + CACHE_MS;
    if (expires > now) {
      if (saved.fetchedAt !== fetchedAt || saved.expires !== expires) {
        await chrome.storage.local.set({ [key]: { value: saved.value, fetchedAt, expires } });
      }
      return saved.value;
    }
  }
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`FIPE respondeu HTTP ${response.status}`);
  const value = await response.json();
  const fetchedAt = Date.now();
  await chrome.storage.local.set({ [key]: { value, fetchedAt, expires: fetchedAt + CACHE_MS } });
  return value;
}

// ─── índice de catálogo FIPE ─────────────────────────────────────────────────
//
// Estrutura: Array de entradas { brandId, brandName, modelId, modelName, years: number[] }
// Armazenada em chrome.storage.local com TTL de 30 dias.
// A construção faz N chamadas de /anos (uma por modelo) mas somente uma vez por mês.

const CATALOG_KEY = "fipe:catalog_index_v2";

async function loadCatalogIndex() {
  const now = Date.now();
  const saved = (await chrome.storage.local.get(CATALOG_KEY))[CATALOG_KEY];
  if (saved && saved.builtAt && (now - saved.builtAt) < CACHE_MS && Array.isArray(saved.entries) && saved.entries.length > 0) {
    return saved.entries;
  }
  return null;  // precisa construir
}

async function saveCatalogIndex(entries) {
  await chrome.storage.local.set({ [CATALOG_KEY]: { entries, builtAt: Date.now() } });
}

/**
 * Constrói o índice completo de catálogo. Para cada marca FIPE, busca os modelos;
 * para cada modelo, busca os anos disponíveis. Faz batches de 10 simultâneos
 * para não estourar a API.
 */
async function buildCatalogIndex() {
  const brands = await cachedJson("/marcas");

  const allEntries = [];
  // Busca modelos de todas as marcas (paralelo por marca, já está cacheado se chamado antes)
  const brandModels = await Promise.all(brands.map(async (brand) => {
    try {
      const data = await cachedJson(`/marcas/${brand.codigo}/modelos`);
      return { brand, models: data.modelos || [] };
    } catch {
      return { brand, models: [] };
    }
  }));

  // Para cada modelo, busca os anos disponíveis em batches de 10
  const flatModels = [];
  for (const { brand, models } of brandModels) {
    for (const model of models) {
      flatModels.push({ brand, model });
    }
  }

  const BATCH = 10;
  for (let i = 0; i < flatModels.length; i += BATCH) {
    const batch = flatModels.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ brand, model }) => {
      try {
        const anos = await cachedJson(`/marcas/${brand.codigo}/modelos/${model.codigo}/anos`);
        const years = anos
          .map((a) => parseInt(a.codigo.split("-")[0], 10))
          .filter((y) => Number.isFinite(y) && y > 1950 && y < 2100);
        return {
          brandId: brand.codigo,
          brandName: brand.nome,
          modelId: model.codigo,
          modelName: model.nome,
          years
        };
      } catch {
        return null;
      }
    }));
    for (const entry of results) {
      if (entry && entry.years.length > 0) allEntries.push(entry);
    }
  }

  await saveCatalogIndex(allEntries);
  return allEntries;
}

/** Retorna o índice do catálogo (do cache ou construído). */
async function getCatalogIndex() {
  const cached = await loadCatalogIndex();
  if (cached) return cached;
  return buildCatalogIndex();
}

// ─── pontuação de candidatos ─────────────────────────────────────────────────

function scoreModel(modelName, evidenceNorm, evTokensSet, evidenceDisplacements) {
  const core = getCoreTokens(modelName);
  const modelDisplacements = core.flatMap((token) => {
    const numbers = token.match(/\d{2,4}/g) || [];
    return numbers.filter((part) => Number(part) >= 50 && Number(part) <= 1400);
  });

  // Se há cilindrada no anúncio e no modelo, elas devem bater
  if (evidenceDisplacements.size > 0 && modelDisplacements.length > 0) {
    const hasMatchingDisp = modelDisplacements.some((d) => evidenceDisplacements.has(d));
    if (!hasMatchingDisp) return -100;
  }

  let score = 0;
  let matchedCore = 0;
  let matchedNameToken = 0;

  for (const token of core) {
    if (evTokensSet.has(token)) {
      score += 25;
      matchedCore += 1;
      if (!/^\d+$/.test(token)) matchedNameToken += 1;
    } else if (/^\d+$/.test(token)) {
      // número colado: "CBX250" no texto pode conter "250" como token separado
      const glued = [...evTokensSet].some(
        (w) => w.includes(token) && new RegExp(`^[A-Z]{1,3}${token}[A-Z]?$`).test(w)
      );
      if (glued) {
        score += 25;
        matchedCore += 1;
      }
    }
  }

  // Cilindrada sozinha não identifica um modelo (ex.: "250" não basta).
  if (matchedNameToken === 0) return 0;

  if (matchedCore === core.length) {
    score += 50;  // bônus por nome completo
  } else if (matchedCore >= 2) {
    score += 15 * (matchedCore / core.length);
  }

  // Bônus por frase contínua no texto
  const corePhrase = core.join(" ");
  if (corePhrase.length > 3 && evidenceNorm.includes(corePhrase)) {
    score += 40;
  }

  return score;
}

// ─── resolução de quote ──────────────────────────────────────────────────────

/**
 * Dado { evidence, year }, resolve qual modelo FIPE corresponde ao anúncio
 * usando o índice de catálogo completo — sem regras hardcoded por modelo.
 *
 * Fluxo:
 *  1. Extrai marca(s) explícita(s) do texto (ex: "Honda", "Yamaha")
 *  2. Filtra o catálogo por marca e por ano (o modelo deve ter existido naquele ano ±1)
 *  3. Pontua cada candidato contra o texto do anúncio
 *  4. Se não encontrou marca explícita, busca em TODAS as marcas (marca implícita pelo melhor score)
 *  5. Se há candidato claro (score isolado), busca o preço e retorna
 */
async function resolveQuote({ evidence, year }) {
  const cleanedEvidence = cleanEvidence(evidence);
  const normalizedEvidence = normalize(cleanedEvidence);
  const evTokensSet = new Set(normalizedEvidence.split(" ").filter(Boolean));
  const displacements = extractDisplacements(cleanedEvidence);
  const targetYear = Number(year);

  // 1. Identifica marcas mencionadas explicitamente no texto
  const brands = await cachedJson("/marcas");
  const explicitBrands = brands
    .filter((b) => normalize(b.nome).length > 2 && normalizedEvidence.includes(normalize(b.nome)))
    .sort((a, b) => normalize(b.nome).length - normalize(a.nome).length);

  // 2. Carrega o catálogo completo com anos
  const catalog = await getCatalogIndex();

  // 3. Filtra candidatos por marca e ano
  function filterByBrandAndYear(brandNomes, tolerance) {
    const brandIds = new Set(
      brands
        .filter((b) => brandNomes.some((n) => normalize(b.nome) === normalize(n)))
        .map((b) => b.codigo)
    );
    return catalog.filter((entry) => {
      if (brandNomes.length && !brandIds.has(entry.brandId)) return false;
      if (!Number.isFinite(targetYear) || targetYear === 0) return true;
      return entry.years.some((y) => Math.abs(y - targetYear) <= tolerance);
    });
  }

  // 4. Pontua candidatos
  function scoreCandidates(candidates) {
    const scored = [];
    for (const entry of candidates) {
      const s = scoreModel(entry.modelName, normalizedEvidence, evTokensSet, displacements);
      if (s > 20) scored.push({ entry, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // 5. Tenta resolver: primeiro com marca explícita, depois sem restrição de marca
  const brandScope = explicitBrands.length > 0 ? [explicitBrands[0].nome] : [];
  let scored = scoreCandidates(filterByBrandAndYear(brandScope, 0));
  // Expande para ano adjacente somente quando o ano exato não gera modelo compatível.
  if (scored.length === 0 && Number.isFinite(targetYear) && targetYear !== 0) {
    scored = scoreCandidates(filterByBrandAndYear(brandScope, 1));
  }
  // Sem modelo compatível nessa marca, tenta novamente em todas as marcas.
  if (scored.length === 0 && brandScope.length) {
    scored = scoreCandidates(filterByBrandAndYear([], 0));
    if (scored.length === 0 && Number.isFinite(targetYear) && targetYear !== 0) {
      scored = scoreCandidates(filterByBrandAndYear([], 1));
    }
  }

  if (scored.length === 0) {
    if (explicitBrands.length === 0) {
      throw new Error("Marca de moto não identificada nos detalhes");
    }
    throw new Error("Modelo/cilindrada não identificados nos detalhes");
  }

  // 6. Critério de desempate
  const top = scored[0];
  const runnerUp = scored[1];

  // Candidato único ou score claramente superior (>20 pts de diferença)
  if (!runnerUp || top.score > runnerUp.score + 20) {
    return getQuote({
      brandCode: top.entry.brandId,
      brandName: top.entry.brandName,
      modelCode: top.entry.modelId,
      modelName: top.entry.modelName,
      year: targetYear
    });
  }

  // Empate: reporta os modelos ambíguos para o usuário entender
  const ambiguous = scored
    .filter((s) => s.score >= top.score - 20)
    .slice(0, 3)
    .map((s) => s.entry.modelName);
  throw new Error(`Versão ambígua: mais de um modelo FIPE corresponde aos detalhes (${ambiguous.join(", ")})`);
}

// ─── busca de preço FIPE ─────────────────────────────────────────────────────

async function getQuote({ brandCode, brandName, modelCode, modelName, year }) {
  let brand;
  if (brandCode) {
    brand = { codigo: brandCode, nome: brandName };
  } else {
    const brands = await cachedJson("/marcas");
    const wantedBrand = normalize(brandName);
    brand = brands.find((item) => normalize(item.nome) === wantedBrand);
    if (!brand) throw new Error(`Marca não encontrada na FIPE: ${brandName}`);
  }

  let model;
  if (modelCode) {
    model = { codigo: modelCode, nome: modelName || "" };
  } else {
    const modelsData = await cachedJson(`/marcas/${brand.codigo}/modelos`);
    const wantedModel = normalize(modelName);
    const exactModels = (modelsData.modelos || []).filter((item) => normalize(item.nome) === wantedModel);
    const models = exactModels.length
      ? exactModels
      : (modelsData.modelos || []).filter((item) => {
          const candidate = normalize(item.nome);
          return candidate === wantedModel || candidate.includes(wantedModel) || wantedModel.includes(candidate);
        });
    if (models.length !== 1) {
      throw new Error(models.length ? `Modelo ambíguo na FIPE: ${modelName}` : `Modelo não encontrado na FIPE: ${modelName}`);
    }
    model = models[0];
  }

  const years = await cachedJson(`/marcas/${brand.codigo}/modelos/${model.codigo}/anos`);
  let yearChoices = years.filter((item) => item.codigo.startsWith(`${year}-`));
  // Tolerância ±1 para fim/início de geração (ex.: CBX 250 anunciada como 2009 mas FIPE só tem até 2008)
  if (!yearChoices.length) {
    yearChoices = years.filter((item) => item.codigo.startsWith(`${year - 1}-`));
    if (!yearChoices.length) {
      yearChoices = years.filter((item) => item.codigo.startsWith(`${year + 1}-`));
    }
  }

  if (!yearChoices.length) throw new Error(`Ano ${year} não encontrado na FIPE para ${model.nome || modelName}`);

  const detail = await cachedJson(`/marcas/${brand.codigo}/modelos/${model.codigo}/anos/${encodeURIComponent(yearChoices[0].codigo)}`);
  const price = Number(String(detail.Valor).replace(/[^\d,]/g, "").replace(".", "").replace(",", "."));
  if (!Number.isFinite(price) || price <= 0) throw new Error("A FIPE retornou um preço inválido");
  return {
    brand: detail.Marca,
    model: detail.Modelo,
    year: detail.AnoModelo,
    fipeCode: detail.CodigoFipe,
    referenceMonth: detail.MesReferencia,
    price,
    formattedPrice: detail.Valor
  };
}

// ─── catálogo de modelos (para content.js filtrar anúncios) ─────────────────

async function getMotoCatalog() {
  const brands = await cachedJson("/marcas");
  const catalog = await Promise.all(brands.map(async (brand) => {
    try {
      const data = await cachedJson(`/marcas/${brand.codigo}/modelos`);
      return (data.modelos || []).map((item) => ({ brand: brand.nome, model: item.nome }));
    } catch {
      return [];
    }
  }));
  return catalog.flat();
}

// ─── headless worker / native host ──────────────────────────────────────────

const HEADLESS_WORKER = "http://127.0.0.1:8765";
const NATIVE_HOST = "com.marketplace.fipelens";

async function ensureHeadlessWorker() {
  try {
    return await chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: "ensure_worker" });
  } catch (error) {
    return { ok: false, error: `Native host indisponivel: ${error.message}` };
  }
}

async function callHeadlessWorker(path, options) {
  try {
    const response = await fetch(`${HEADLESS_WORKER}${path}`, options);
    if (!response.ok) throw new Error(`Headless worker HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return { ok: false, error: error.message || "Headless worker indisponivel" };
  }
}

// ─── message handlers ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MOTO_BRANDS") {
    cachedJson("/marcas")
      .then((brands) => sendResponse({ ok: true, brands: brands.map((item) => item.nome) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "MOTO_CATALOG") {
    getMotoCatalog()
      .then((models) => sendResponse({ ok: true, models }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "BUILD_CATALOG_INDEX") {
    // Força reconstrução do índice (pode ser chamado do popup para warm-up)
    buildCatalogIndex()
      .then((entries) => sendResponse({ ok: true, count: entries.length }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "QUEUE_DETAIL_ANALYSIS") {
    ensureHeadlessWorker().then(async (startup) => {
      if (!startup?.ok) return { ok: false, error: startup?.error || "Nao foi possivel iniciar o worker" };
      const result = await callHeadlessWorker("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: message.items || [] })
      });
      return { ok: Boolean(result.accepted), ...result };
    }).then(sendResponse);
    return true;
  }
  if (message?.type === "GET_DETAIL_RESULTS") {
    const ids = (message.ids || []).map(encodeURIComponent).join(",");
    callHeadlessWorker(`/results?ids=${ids}`).then((result) => sendResponse(result));
    return true;
  }
  if (message?.type !== "RESOLVE_FIPE") return false;
  resolveQuote(message.payload)
    .then((quote) => sendResponse({ ok: true, quote }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Falha ao consultar a FIPE" }));
  return true;
});
