const DEFAULTS = { discountThreshold: 15 };
const PRICE_RE = /R\$\s*([\d.]+(?:,\d{1,2})?)/i;
const ITEM_RE = /\/marketplace\/item\/(\d+)/;
const STATE_RE = /,\s*[A-Z]{2}$/;
const PARTS_RE = /\b(PECAS?|PARA DESMANCHE|SOMENTE PECAS|RETIRADA DE PECAS|ACESSORIOS|CARENAGEM|MOTOR AVULSO|RODA AVULSA|PNEU|ESCAPAMENTO|PAINEL|PONTEIRA|GUIDAO|RETROVISOR|BANCO|CARBURADOR|FAROL|LANTERNA|CHASSI|QUADRO|BLOCO)\b/;
const badgesById = new Map();
let discountThreshold = DEFAULTS.discountThreshold;
let detailAnalysisInProgress = false;
let searchScanInProgress = false;
let searchScanRequested = false;
let observedUrl = location.href;

const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const isPartsListing = (value) => PARTS_RE.test(normalize(value));
function matchesMotoCatalog(query, catalog) {
  const queryTokens = normalize(query).split(" ").filter(Boolean);
  const hasToken = (token) => queryTokens.some((candidate) => token === candidate || (/^\d/.test(token) && candidate.startsWith(token)));
  return catalog.some(({ model }) => {
    const tokens = normalize(model).split(" ").filter(Boolean);
    const modelNumbers = tokens.filter((token) => /^\d{2,4}/.test(token));
    const queryNumbers = queryTokens.filter((token) => /^\d{2,4}/.test(token));
    if (queryNumbers.length && modelNumbers.length && !modelNumbers.some((number) => queryNumbers.some((candidate) => number.startsWith(candidate) || candidate.startsWith(number)))) return false;
    const distinctiveName = tokens.filter((token) => /^[A-Z]{3,}$/.test(token));
    if (distinctiveName.length) return distinctiveName.some(hasToken);
    const shortName = tokens.filter((token) => /^[A-Z]{2,}$/.test(token));
    return shortName.some(hasToken) && modelNumbers.length > 0;
  });
}
function looksLikeMotoSearch(query) {
  const normalized = normalize(query);
  const hasDisplacement = /\b(50|100|110|125|150|160|180|190|200|220|250|300|350|400|450|500|600|650|700|750|800|900|1000|1100|1200|1300)\b/.test(normalized);
  if (!hasDisplacement) return false;
  const knownMakeOrModel = /\b(KAWASAKI|HONDA|YAMAHA|SUZUKI|BMW|DUCATI|TRIUMPH|KTM|HARLEY|BAJAJ|APRILIA|HUSQVARNA|SHINERAY|DAFRA|BENELLI|HAOJUE|ZONTES|NINJA|VERSYS|CBX|CBR|CB|CG|TWISTER|XRE|BIZ|FAZER|XTZ|XT|TIGER|DUKE|DOMINAR|FALCON|LANDER)\b/.test(normalized);
  return knownMakeOrModel;
}
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(value);

async function saveListingRecord(record) {
  const key = `listing:${record.id}`;
  const existing = (await chrome.storage.local.get(key))[key] || {};
  const now = new Date().toISOString();
  const saved = {
    ...existing,
    ...record,
    id: record.id,
    firstSeenAt: existing.firstSeenAt || record.lastSeenAt || now,
    lastSeenAt: record.lastSeenAt || existing.lastSeenAt || now,
    updatedAt: now
  };
  await chrome.storage.local.set({ [key]: saved });
  return saved;
}

function parsePrice(text) {
  const match = String(text || "").match(PRICE_RE);
  if (!match) return null;
  const amount = Number(match[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
}

function lowestReportedPrice(text) {
  const matches = [...String(text || "").matchAll(/R\$\s*([\d.]+(?:,[\d]{1,2})?)/gi)];
  const prices = matches.map((match) => Number(match[1].replace(/\./g, "").replace(",", ".")))
    .filter((amount) => Number.isFinite(amount) && amount > 0);
  return prices.length ? Math.min(...prices) : null;
}

function hasValidFipeMapping(record) {
  return Boolean(record?.fipeQuote && record?.verifiedModel && record?.fipeValidUntil && Date.parse(record.fipeValidUntil) > Date.now());
}

async function settings() {
  const stored = (await chrome.storage.local.get("settings")).settings || {};
  return { ...DEFAULTS, ...stored };
}

function fipeQuote(evidence, year) {
  return chrome.runtime.sendMessage({
    type: "RESOLVE_FIPE",
    payload: { evidence, year }
  });
}

function gapLabel(askingPrice, fipePrice, threshold) {
  const pct = ((fipePrice - askingPrice) / fipePrice) * 100;
  const rounded = Math.round(pct);
  if (pct >= threshold) return { text: `POTENCIAL · ${rounded}% abaixo da FIPE`, kind: "good", pct };
  if (pct > 0) return { text: `${rounded}% abaixo da FIPE · revisar`, kind: "maybe", pct };
  return { text: `${Math.abs(rounded)}% acima da FIPE`, kind: "high", pct };
}

function makeBadge() {
  const badge = document.createElement("div");
  badge.className = "mpfl-badge";
  badge.textContent = "Carregando anuncio...";
  return badge;
}

async function decorateSearchResults() {
  if (!location.pathname.includes("/search")) return;
  if (searchScanInProgress) {
    searchScanRequested = true;
    return;
  }
  searchScanInProgress = true;
  try {
    const config = await settings();
    discountThreshold = Number.isFinite(Number(config.discountThreshold)) ? Number(config.discountThreshold) : DEFAULTS.discountThreshold;
    const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
    const jobs = [];
    const catalogResult = await chrome.runtime.sendMessage({ type: "MOTO_CATALOG" }).catch(() => null);
    const motoCatalog = catalogResult?.models || [];
    const query = new URL(location.href).searchParams.get("query") || "";
    const motorcycleSearch = matchesMotoCatalog(query, motoCatalog) || looksLikeMotoSearch(query);

    for (const anchor of anchors) {
      const id = anchor.href.match(ITEM_RE)?.[1];
      if (!id || anchor.dataset.mpflDone || badgesById.has(id)) continue;
      anchor.dataset.mpflDone = "1";
      const text = anchor.innerText?.trim() || "";
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const title = lines.find((line) => line && !PRICE_RE.test(line) && !STATE_RE.test(line)) || "";
      const price = parsePrice(text);
      const year = Number((text.match(/\b(?:19|20)\d{2}\b/) || [])[0]) || null;
      const url = `https://www.facebook.com/marketplace/item/${id}/?locale=pt_BR`;
      const locationText = lines.find((line) => STATE_RE.test(line)) || null;
      const imageUrl = anchor.querySelector("img")?.src || null;
      const baseRecord = {
        id, title, price, year, location: locationText, imageUrl,
        url, searchQuery: query, visibleText: text,
        lastSeenAt: new Date().toISOString()
      };
      const saved = await saveListingRecord(baseRecord);
      const badge = makeBadge();
      badge.dataset.listingId = id;
      badgesById.set(id, badge);
      anchor.insertAdjacentElement("afterend", badge);
      if (isPartsListing(`${title} ${text}`)) {
        badge.textContent = "Anúncio de peças/acessórios — FIPE ignorada";
        await saveListingRecord({ id, analysisStatus: "ignored-parts", fipeError: null });
        continue;
      }
      if (!motorcycleSearch) {
        badge.textContent = motoCatalog.length
          ? "Busca não identificada no catálogo FIPE — consulta ignorada"
          : "Busca não reconhecida como moto (informe modelo e cilindrada)";
        continue;
      }
      if (hasValidFipeMapping(saved)) {
        updateBadge(id, saved);
        continue;
      }
      badge.textContent = "Lendo detalhes do anúncio para identificar a moto...";
      jobs.push({ id, url, title, price, searchQuery: query });
    }
    if (jobs.length) {
      const queued = await chrome.runtime.sendMessage({ type: "QUEUE_DETAIL_ANALYSIS", items: jobs });
      if (!queued?.ok) {
        for (const item of jobs) await saveListingRecord({ id: item.id, fipeError: queued?.error || "Inicie o worker headless local" });
      } else {
        pollHeadlessResults(jobs);
      }
    }
  } finally {
    searchScanInProgress = false;
    if (searchScanRequested) {
      searchScanRequested = false;
      scheduleScan();
    }
  }
}

function updateBadge(id, record) {
  const badge = badgesById.get(id);
  if (!badge) return;
  if (!hasValidFipeMapping(record)) {
    badge.textContent = record.fipeError ? "FIPE: " + record.fipeError : "Lendo detalhes do anuncio...";
    return;
  }
  const comparison = gapLabel(record.price, record.fipeQuote.price, discountThreshold);
  badge.className = `mpfl-badge mpfl-${comparison.kind}`;
  badge.innerHTML = `<b>${comparison.text}</b><span>${money(record.price)} · FIPE ${money(record.fipeQuote.price)} (${escapeHtml(record.fipeQuote.referenceMonth)})</span><small>${escapeHtml(record.fipeQuote.brand)} ${escapeHtml(record.fipeQuote.model)} ${escapeHtml(record.fipeQuote.year)} · válida até ${new Date(record.fipeValidUntil).toLocaleDateString("pt-BR")}</small>`;
}

async function pollHeadlessResults(items) {
  const pending = new Map(items.map((item) => [item.id, item]));
  while (pending.size && location.pathname.includes("/search")) {
    const response = await chrome.runtime.sendMessage({ type: "GET_DETAIL_RESULTS", ids: [...pending.keys()] }).catch(() => null);
    if (!response?.items) {
      for (const item of pending.values()) await saveListingRecord({ id: item.id, fipeError: "Worker headless desconectado" });
      return;
    }
    for (const result of response.items) {
      if (result.status === "queued" || result.status === "processing") continue;
      const item = pending.get(result.id);
      if (!item) continue;
      pending.delete(result.id);
      if (result.status === "done" && result.bodyText) {
        await analyzeFetchedDetails(item, result);
      } else {
        const message = result.error || (result.status === "blocked" ? "Facebook pausou as consultas" : "Worker perdeu este trabalho");
        await saveListingRecord({ id: item.id, analysisStatus: "fipe-unavailable", fipeError: message });
      }
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

async function analyzeFetchedDetails(item, result) {
  const bodyLines = result.bodyText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const title = (result.title || item.title || "Anuncio").split(/ [—–•] /)[0].trim();
  const vehicleFacts = sectionAfter(bodyLines, "SOBRE ESSE VEICULO", ["DESCRICAO DO VENDEDOR", "INFORMACOES DO VENDEDOR"]);
  const sellerDescription = sectionAfter(bodyLines, "DESCRICAO DO VENDEDOR", ["INFORMACOES DO VENDEDOR", "DETALHES DO VENDEDOR", "SELECOES DE HOJE"]);
  if (isPartsListing(`${title} ${item.title || ""} ${vehicleFacts} ${sellerDescription}`)) {
    await saveListingRecord({ id: item.id, analysisStatus: "ignored-parts", fipeError: null });
    return;
  }
  const yearInFacts = vehicleFacts.match(/(?:ANO(?: DO MODELO)?|YEAR)[^0-9]{0,20}((?:19|20)\d{2})/i)?.[1]
    || vehicleFacts.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const year = Number(yearInFacts || title.match(/\b(?:19|20)\d{2}\b/)?.[0] || item.year || 0) || null;
  const price = lowestReportedPrice(sellerDescription) || parsePrice(result.bodyText) || item.price;
  const characteristicText = `${vehicleFacts} ${sellerDescription}`.trim();
  const record = await saveListingRecord({
    id: item.id, title, price, year, vehicleFacts, sellerDescription,
    modelEvidence: characteristicText, detailSeenAt: new Date().toISOString()
  });
  if (!year || !price) {
    await saveListingRecord({ id: item.id, analysisStatus: "detail-incomplete", fipeError: "Ano ou preco ausente nos detalhes" });
    return;
  }
  try {
    const valid = hasValidFipeMapping(record);
    const quoteResult = valid
      ? { ok: true, quote: record.fipeQuote }
      : await fipeQuote(`${title} ${vehicleFacts} ${sellerDescription}`, year);
    if (!quoteResult?.ok) throw new Error(quoteResult?.error || "Falha na FIPE");
    const quote = quoteResult.quote;
    const comparison = gapLabel(price, quote.price, discountThreshold);
    await saveListingRecord({
      id: item.id, analysisStatus: "detail-analyzed", fipeQuote: quote,
      verifiedModel: `${quote.brand} ${quote.model}`, modelEvidence: `${title} ${characteristicText}`,
      fipeCheckedAt: valid ? record.fipeCheckedAt : new Date().toISOString(),
      fipeValidUntil: valid ? record.fipeValidUntil : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      fipePercentBelow: Number(comparison.pct.toFixed(1)),
      relevance: comparison.kind === "good" ? "potential" : comparison.kind === "maybe" ? "review" : "above-fipe",
      fipeError: null
    });
  } catch (error) {
    await saveListingRecord({ id: item.id, analysisStatus: "fipe-unavailable", fipeError: error.message });
  }
}
function sectionAfter(lines, heading, stops) {
  const start = lines.findIndex((line) => normalize(line).startsWith(normalize(heading)));
  if (start < 0) return "";
  const output = [];
  for (let i = start + 1; i < lines.length && output.join(" ").length < 1200; i++) {
    if (stops.some((stop) => normalize(lines[i]).startsWith(normalize(stop)))) break;
    const normalizedLine = normalize(lines[i]);
    if (lines[i].trim() && !normalizedLine.includes("LOCALIZACAO APROXIMADA")) output.push(lines[i].trim());
  }
  return output.join(" ").trim();
}

function analyzeCharacteristics(text) {
  const normalized = normalize(text);
  const positiveRules = [
    [/(REVISAD|REVISAO FEITA|MOTOR FEITO|PNEUS NOVOS)/, "manutenção/revisão mencionada"],
    [/(DOCUMENTO EM DIA|IPVA PAGO|LICENCIAMENTO PAGO)/, "documentação ou tributos em dia mencionados"],
    [/(MANUAL DO PROPRIETARIO|CHAVE RESERVA|NOTA FISCAL)/, "item/documentação adicional mencionada"]
  ];
  const riskRules = [
    [/(MOTOR BATENDO|FUMACA|VAZAMENTO|PRECISA FAZER|PARA PECAS)/, "há sinal de reparo mecânico"],
    [/(SINISTRO|LEILAO|DOCUMENTO ATRASADO|SEM DOCUMENTO|RESTRICAO)/, "há alerta de histórico/documentação"]
  ];
  const positive = positiveRules.filter(([pattern]) => pattern.test(normalized)).map(([, label]) => label);
  const risks = riskRules.filter(([pattern]) => pattern.test(normalized)).map(([, label]) => label);
  const mileageText = text.match(/\b([\d.]+)\s*km\b/i)?.[1] || null;
  const mileage = mileageText ?Number(mileageText.replace(/\./g, "")) : null;
  if (mileage && mileage > 100000) risks.push(`quilometragem alta (${mileageText} km)`);
  else if (mileage && mileage <= 50000) positive.push(`quilometragem abaixo de 50 mil km (${mileageText} km)`);
  return { positive, risks, mileageText };
}

function panelShell() {
  let panel = document.getElementById("mpfl-panel");
  if (panel) return panel;
  panel = document.createElement("aside");
  panel.id = "mpfl-panel";
  panel.innerHTML = '<div class="mpfl-panel-head"><strong>Marketplace FIPE Lens</strong><button type="button" aria-label="Fechar">×</button></div><div class="mpfl-panel-body">Analisando anúncio…</div>';
  panel.querySelector("button").addEventListener("click", () => panel.remove());
  panel.classList.add("mpfl-inline-panel");
  placePanelInListing(panel);
  return panel;
}

function placePanelInListing(panel) {
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,span,div")];
  const descriptionHeading = headings.find((node) => normalize(node.textContent) === "DESCRICAO DO VENDEDOR");
  const factsHeading = headings.find((node) => normalize(node.textContent) === "SOBRE ESSE VEICULO");
  const heading = descriptionHeading || factsHeading;
  if (!heading) {
    (document.querySelector("main") || document.body).appendChild(panel);
    return;
  }
  let section = heading;
  for (let depth = 0; depth < 2 && section.parentElement; depth++) section = section.parentElement;
  section.insertAdjacentElement("afterend", panel);
}

async function analyzeDetail() {
  const match = location.pathname.match(ITEM_RE);
  if (!match || document.getElementById("mpfl-panel") || detailAnalysisInProgress) return;
  detailAnalysisInProgress = true;
  const isAuto = new URL(location.href).searchParams.get("mpfl_auto") === "1";
  const finishAuto = async () => {
    detailAnalysisInProgress = false;
    if (isAuto) {
      try { await chrome.runtime.sendMessage({ type: "AUTO_DETAIL_DONE" }); } catch {}
    }
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const pageText = document.body.innerText;
    if (PRICE_RE.test(pageText) && /SOBRE ESSE VEICULO|DESCRICAO DO VENDEDOR/i.test(normalize(pageText))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const panel = panelShell();
  const bodyLines = document.body.innerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const title = (document.title.split(" | Facebook Marketplace")[0] || "Anuncio").split(/ [\u2014\u2013\u2022] /)[0].trim();
  const pagePrice = parsePrice(bodyLines.join(" "));
  const vehicleFacts = sectionAfter(bodyLines, "SOBRE ESSE VEICULO", ["DESCRICAO DO VENDEDOR", "INFORMACOES DO VENDEDOR"]);
  const sellerDescription = sectionAfter(bodyLines, "DESCRICAO DO VENDEDOR", ["INFORMACOES DO VENDEDOR", "DETALHES DO VENDEDOR", "SELECOES DE HOJE"]);
  const price = lowestReportedPrice(sellerDescription) || pagePrice;
  if (isPartsListing(`${title} ${vehicleFacts} ${sellerDescription}`)) {
    panel.querySelector(".mpfl-panel-body").textContent = "Anúncio de peças/acessórios; consulta FIPE ignorada.";
    await saveListingRecord({ id: match[1], analysisStatus: "ignored-parts", fipeError: null });
    await finishAuto();
    return;
  }
  const factYear = vehicleFacts.match(/(?:ANO(?: DO MODELO)?|YEAR)[^0-9]{0,20}((?:19|20)\d{2})/i)?.[1]
    || vehicleFacts.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const year = Number(factYear || title.match(/\b(?:19|20)\d{2}\b/)?.[0] || 0) || null;
  const characteristicText = `${vehicleFacts} ${sellerDescription}`.trim();
  const signals = analyzeCharacteristics(characteristicText);
  const saved = await saveListingRecord({
    id: match[1], title, price, year,
    url: `https://www.facebook.com/marketplace/item/${match[1]}/`,
    vehicleFacts, sellerDescription, positiveSignals: signals.positive,
    riskSignals: signals.risks, detailSeenAt: new Date().toISOString()
  });
  const content = panel.querySelector(".mpfl-panel-body");
  if (!year || !price) {
    content.textContent = "Detalhes carregados, mas nao encontrei preco e ano do veiculo.";
    await saveListingRecord({ id: match[1], analysisStatus: "detail-incomplete", fipeError: "Ano ou preco ausente nos detalhes" });
    await finishAuto();
    return;
  }

  const config = await settings();
  discountThreshold = Number.isFinite(Number(config.discountThreshold)) ? Number(config.discountThreshold) : DEFAULTS.discountThreshold;
  const evidence = `${title} ${vehicleFacts} ${sellerDescription}`;
  content.textContent = "Identificando marca, modelo, cilindrada e ano nos detalhes...";
  try {
    const quoteValid = hasValidFipeMapping(saved);
    const result = quoteValid
      ? { ok: true, quote: saved.fipeQuote }
      : await fipeQuote(evidence, year);
    if (!result?.ok) throw new Error(result?.error || "Falha na FIPE");
    const quote = result.quote;
    const comparison = gapLabel(price, quote.price, Number.isFinite(Number(config.discountThreshold)) ? Number(config.discountThreshold) : DEFAULTS.discountThreshold);
    const checkedAt = quoteValid ? saved.fipeCheckedAt : new Date().toISOString();
    const validUntil = quoteValid ? saved.fipeValidUntil : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await saveListingRecord({
      id: match[1], analysisStatus: "detail-analyzed", fipeQuote: quote,
      verifiedModel: `${quote.brand} ${quote.model}`, modelEvidence: characteristicText,
      fipeCheckedAt: checkedAt, fipeValidUntil: validUntil,
      fipePercentBelow: Number(comparison.pct.toFixed(1)),
      relevance: comparison.kind === "good" ? "potential" : comparison.kind === "maybe" ? "review" : "above-fipe",
      fipeError: null
    });
    const positive = signals.positive.length ? signals.positive.join(", ") : "nenhum sinal positivo explicito";
    const risks = signals.risks.length ? signals.risks.join(", ") : "nenhum alerta explicito";
    content.innerHTML = `<b>${escapeHtml(title)}</b><p>${money(price)} - FIPE ${money(quote.price)} (${escapeHtml(quote.referenceMonth)})</p><p>${escapeHtml(quote.brand)} ${escapeHtml(quote.model)} ${escapeHtml(quote.year)} - ${comparison.text}</p><p>${escapeHtml(characteristicText || "Sem descricao visivel.")}</p><p>Favoraveis: ${escapeHtml(positive)}</p><p>Verificar: ${escapeHtml(risks)}</p>`;
  } catch (error) {
    content.textContent = `FIPE nao calculada: ${error.message}`;
    await saveListingRecord({ id: match[1], analysisStatus: "fipe-unavailable", fipeError: error.message, modelEvidence: characteristicText });
  }
  await finishAuto();
}
let timer;
function scheduleScan() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    decorateSearchResults();
    analyzeDetail();
  }, 500);
}

scheduleScan();
new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", () => {
  observedUrl = location.href;
  scheduleScan();
});
setInterval(() => {
  if (location.href === observedUrl) return;
  observedUrl = location.href;
  scheduleScan();
}, 750);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    for (const [key, change] of Object.entries(changes)) {
      const match = key.match(/^listing:(\d+)$/);
      if (match && change.newValue) updateBadge(match[1], change.newValue);
    }
  }
  if (area === "local" && changes.settings) {
    discountThreshold = Number.isFinite(Number(changes.settings.newValue?.discountThreshold)) ? Number(changes.settings.newValue.discountThreshold) : DEFAULTS.discountThreshold;
    document.querySelectorAll(".mpfl-badge").forEach((badge) => badge.remove());
    badgesById.clear();
    document.querySelectorAll("a[data-mpfl-done]").forEach((anchor) => delete anchor.dataset.mpflDone);
    document.getElementById("mpfl-panel")?.remove();
    scheduleScan();
  }
});



