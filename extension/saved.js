const list = document.getElementById("list");
let records = [];
const money = (value) => Number.isFinite(Number(value)) ?new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(Number(value)) : "—";
const date = (value) => value ?new Date(value).toLocaleString("pt-BR") : "—";
const label = { potential: "POTENCIAL", review: "REVISAR", "above-fipe": "ACIMA DA FIPE" };

function text(parent, tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value || "";
  if (className) node.className = className;
  parent.appendChild(node);
  return node;
}

function render() {
  const query = document.getElementById("filter").value.trim().toLocaleLowerCase("pt-BR");
  const visible = records.filter((item) => `${item.title || ""} ${item.location || ""} ${item.fipeQuote?.model || ""}`.toLocaleLowerCase("pt-BR").includes(query));
  list.replaceChildren();
  document.getElementById("summary").textContent = `${visible.length} de ${records.length} anuncios guardados neste navegador`;
  for (const item of visible) {
    const card = document.createElement("article");
    if (item.imageUrl) {
      const img = document.createElement("img");
      img.src = item.imageUrl;
      img.alt = "Foto do anuncio";
      card.appendChild(img);
    } else {
      const spacer = document.createElement("div");
      card.appendChild(spacer);
    }
    const details = document.createElement("div");
    card.appendChild(details);
    text(details, "h2", item.title || "Anuncio sem titulo");
    const current = item.price ?money(item.price) : "Preco nao identificado";
    const fipe = item.fipeQuote ?`FIPE ${money(item.fipeQuote.price)} · ${item.fipeQuote.model} ${item.fipeQuote.year}` : (item.fipeError || "FIPE ainda nao consultada");
    text(details, "p", `${current} · ${item.location || "Local nao informado"}`);
    text(details, "p", fipe);
    if (item.relevance) text(details, "span", label[item.relevance] || item.relevance, `status ${item.relevance}`);
    if (item.vehicleFacts || item.sellerDescription) text(details, "p", [item.vehicleFacts, item.sellerDescription].filter(Boolean).join(" · "));
    text(details, "small", `Visto: ${date(item.lastSeenAt)} · FIPE consultada: ${date(item.fipeCheckedAt)} · Valida ate: ${date(item.fipeValidUntil)}`);
    const link = document.createElement("a");
    link.href = item.url || `https://www.facebook.com/marketplace/item/${item.id}/`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Abrir anuncio no Facebook";
    details.appendChild(link);
    list.appendChild(card);
  }
  if (!visible.length) text(list, "p", records.length ?"Nenhum anuncio corresponde ao filtro." : "Ainda nao ha anuncios salvos. Abra uma busca do Marketplace com a extensao ativa.");
}

async function load() {
  const all = await chrome.storage.local.get(null);
  records = Object.entries(all)
    .filter(([key]) => key.startsWith("listing:"))
    .map(([, item]) => item)
    .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
  render();
}

document.getElementById("filter").addEventListener("input", render);
document.getElementById("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `marketplace-salvos-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});
load();
