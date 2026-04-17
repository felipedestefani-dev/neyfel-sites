import { createClient } from "@supabase/supabase-js";

const STORAGE_KEY = "pc_agenda_v1";
const PROXY_KEY = "pc_price_proxy";
const LIVE_INTERVAL_KEY = "pc_live_interval_min";
const APP_TAB_KEY = "app_active_tab_v1";
const FIN_STORAGE_KEY = "fin_ledger_v1";
const CAL_STORAGE_KEY = "cal_events_v1";
const CAL_VIEW_KEY = "cal_view_ym_v1";

/** @param {string} raw */
function normalizeSupabaseUrl(raw) {
  let u = String(raw ?? "").trim().replace(/\/+$/u, "");
  if (!u) return "";
  if (!/^https?:\/\//iu.test(u)) u = `https://${u}`;
  return u;
}

const supabaseUrl = normalizeSupabaseUrl(String(import.meta.env.VITE_SUPABASE_URL ?? ""));
const supabaseAnonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const useSupabase = Boolean(supabaseUrl && supabaseAnonKey);

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
if (useSupabase) {
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

/** @type {string | null} */
let authedUserId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let cloudSaveTimer = null;
const CLOUD_SAVE_MS = 700;

const CAL_MONTHS_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];
const CAL_MONTH_ABBR_PT = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

const FIN_TYPE_LABEL = {
  ganho: "Ganhos",
  despesa: "Despesas",
  gasto: "Gastos",
  investimento: "Investimentos",
};

const FIN_PILL = {
  ganho: "pill--green",
  despesa: "pill--yellow",
  gasto: "pill--cyan",
  investimento: "pill--yellow",
};

const CATEGORY_LABEL = {
  processador: "Processador",
  placa_mae: "Placa-mãe",
  memoria: "Memória RAM",
  armazenamento: "Armazenamento",
  gpu: "Placa de vídeo",
  fonte: "Fonte",
  gabinete: "Gabinete",
  cooler: "Cooler",
  monitor: "Monitor",
  periferico: "Periférico",
  outros: "Outros",
};

const STATUS_LABEL = {
  pesquisa: "Pesquisa",
  carrinho: "No carrinho",
  comprado: "Comprado",
};

const STATUS_PILL = {
  pesquisa: "pill--cyan",
  carrinho: "pill--yellow",
  comprado: "pill--green",
};

/**
 * @typedef {Object} AgendaEntry
 * @property {string} id
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} category
 * @property {string} status
 * @property {string} name
 * @property {string} store
 * @property {number} price
 * @property {string} url
 * @property {string} notes
 * @property {string} mlItemId
 * @property {boolean} liveEnabled
 * @property {string} lastLiveAt
 * @property {string} lastLiveError
 */

/** @type {AgendaEntry[]} */
let entries = [];
let editingId = null;
/** @type {ReturnType<typeof setInterval> | null} */
let liveTimer = null;

/** @type {{ id: string, createdAt: string, updatedAt: string, type: string, date: string, description: string, amount: number, notes: string }[]} */
let finEntries = [];
let finEditingId = null;

/** @type {{ id: string, createdAt: string, updatedAt: string, date: string, title: string, time: string, notes: string }[]} */
let calEvents = [];
let calEditingId = null;
let calViewYear = new Date().getFullYear();
let calViewMonth = new Date().getMonth();
let calSelected = "";

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clampStr(s, max) {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

function parseMoneyBR(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return 0;

  const normalized = raw.replace(/\s/g, "").replace("R$", "").replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100) / 100;
}

function formatBRL(value) {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
  } catch {
    return `R$ ${value.toFixed(2).replace(".", ",")}`;
  }
}

function formatShortWhen(iso) {
  const d = new Date(String(iso || ""));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toYmdLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toast(msg) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = msg;
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 2400);
}

function normalizeMlItemId(raw) {
  const s = clampStr(raw, 32).trim().toUpperCase().replace(/-/g, "");
  if (!s) return "";
  const m = s.match(/^MLB(\d{6,})$/);
  return m ? `MLB${m[1]}` : "";
}

function extractMlItemIdFromUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;

  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if (!h.includes("mercadolivre") && !h.includes("mercadolibre")) return null;
  } catch {
    // segue tentando regex (link incompleto / colado diferente)
  }

  const m = s.match(/\b(MLB\d{6,})\b/i);
  if (m) return m[1].toUpperCase();
  const m2 = s.match(/\bMLB-(\d{6,})\b/i);
  if (m2) return `MLB${m2[1]}`;
  return null;
}

function resolveMlItemId(e) {
  const manual = normalizeMlItemId(e.mlItemId);
  if (manual) return manual;
  return extractMlItemIdFromUrl(e.url);
}

function getProxyBase() {
  return clampStr(localStorage.getItem(PROXY_KEY) || "", 200).replace(/\/$/, "");
}

function updateMlHint() {
  const el = $("ml-hint");
  const url = $("f-url").value;
  const manual = normalizeMlItemId($("f-ml-id").value);
  const fromUrl = extractMlItemIdFromUrl(url);
  const resolved = manual || fromUrl;

  if (!url.trim() && !manual) {
    el.textContent = "";
    return;
  }

  if (!resolved) {
    el.textContent =
      "Não detectei um ID MLB… no link. Preço automático aqui funciona principalmente com anúncios do Mercado Livre.";
    return;
  }

  el.textContent = `Mercado Livre: ${resolved} — dá para buscar preço pela API pública.`;
}

function parseEntriesArray(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x) => x && typeof x === "object")
    .map((x) => {
      const url = clampStr(x.url, 2000);
      const mlFromField = normalizeMlItemId(x.mlItemId);
      const mlFromUrl = extractMlItemIdFromUrl(url);
      return {
        id: String(x.id || uid()),
        createdAt: String(x.createdAt || new Date().toISOString()),
        updatedAt: String(x.updatedAt || new Date().toISOString()),
        category: String(x.category || "outros"),
        status: String(x.status || "pesquisa"),
        name: clampStr(x.name, 140),
        store: clampStr(x.store, 80),
        price: Number.isFinite(Number(x.price)) ? Number(x.price) : 0,
        url,
        notes: clampStr(x.notes, 500),
        mlItemId: mlFromField || mlFromUrl || "",
        liveEnabled: x.liveEnabled === false ? false : true,
        lastLiveAt: String(x.lastLiveAt || ""),
        lastLiveError: clampStr(x.lastLiveError, 300),
      };
    });
}

function load() {
  if (useSupabase) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      entries = [];
      return;
    }
    entries = parseEntriesArray(JSON.parse(raw));
  } catch {
    entries = [];
  }
}

function save() {
  if (!useSupabase) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return;
  }
  if (authedUserId) scheduleCloudSave();
}

function normalizeEntryDraft(draft) {
  const category = CATEGORY_LABEL[draft.category] ? draft.category : "outros";
  const status = STATUS_LABEL[draft.status] ? draft.status : "pesquisa";
  const url = clampStr(draft.url, 2000);
  const mlItemId =
    normalizeMlItemId(draft.mlItemId) || normalizeMlItemId(extractMlItemIdFromUrl(url) || "") || "";

  return {
    category,
    status,
    name: clampStr(draft.name, 140),
    store: clampStr(draft.store, 80),
    price: Number.isFinite(draft.price) ? draft.price : 0,
    url,
    notes: clampStr(draft.notes, 500),
    mlItemId,
    liveEnabled: draft.liveEnabled === false ? false : true,
  };
}

function getFiltered() {
  const q = $("search").value.trim().toLowerCase();
  const cat = $("filter-cat").value;
  const st = $("filter-status").value;

  return entries
    .filter((e) => (cat === "todos" ? true : e.category === cat))
    .filter((e) => (st === "todos" ? true : e.status === st))
    .filter((e) => {
      if (!q) return true;
      const ml = resolveMlItemId(e) || "";
      const hay = `${e.name} ${e.store} ${e.notes} ${ml}`.toLowerCase();
      return hay.includes(q);
    })
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function computeTotals(list) {
  const total = list.reduce((acc, e) => acc + (Number(e.price) || 0), 0);
  const stores = new Set(
    list
      .map((e) => e.store.trim())
      .filter(Boolean),
  );
  return { total, count: list.length, stores: stores.size };
}

function renderTotals() {
  const allTotals = computeTotals(entries);
  $("sum-total").textContent = formatBRL(allTotals.total);
  $("sum-count").textContent = String(allTotals.count);
  $("sum-stores").textContent = String(allTotals.stores);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchMlItem(itemId) {
  const proxy = getProxyBase();
  const target = proxy
    ? `${proxy}/ml/items/${encodeURIComponent(itemId)}`
    : `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`;

  const res = await fetch(target, { headers: { Accept: "application/json" } });
  const text = await res.text();

  /** @type {any} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Resposta inválida (${res.status})`);
  }

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }

  if (data?.blocked_by || (data?.error && !data?.price)) {
    throw new Error(String(data?.message || data?.error || "ML indisponível"));
  }

  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Preço não encontrado na resposta");
  }

  return {
    price: Math.round(price * 100) / 100,
    currency_id: String(data.currency_id || "BRL"),
  };
}

async function refreshEntryById(entryId, { silent = false, skipRender = false, respectLiveToggle = false } = {}) {
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return false;

  const e = entries[idx];
  const mlId = resolveMlItemId(e);
  if (!mlId) {
    if (!silent) toast("Este item não tem Mercado Livre (ID MLB…) para consultar.");
    return false;
  }

  if (respectLiveToggle && e.liveEnabled === false) return false;

  try {
    const { price } = await fetchMlItem(mlId);
    const prev = Number(entries[idx].price) || 0;
    const now = new Date().toISOString();

    entries[idx] = {
      ...entries[idx],
      price,
      lastLiveAt: now,
      lastLiveError: "",
      updatedAt: now,
    };
    save();

    if (!silent) {
      toast(prev !== price ? `Preço ML atualizado (${mlId}).` : `Preço ML conferido (${mlId}).`);
    }
  } catch (err) {
    const now = new Date().toISOString();
    entries[idx] = {
      ...entries[idx],
      lastLiveError: clampStr(String(err?.message || err), 300),
      updatedAt: now,
    };
    save();
    if (!silent) toast("Não consegui buscar o preço no ML (bloqueio/rede). Tente o proxy local.");
  }

  if (!skipRender) renderList();
  return true;
}

function isPcPanelActive() {
  const el = document.getElementById("panel-pc");
  return Boolean(el && !el.hidden);
}

async function refreshAllLiveEntries({ quiet = false, respectLiveToggle = false } = {}) {
  if (!isPcPanelActive()) return;

  const targets = entries.filter((e) => resolveMlItemId(e)).filter((e) => (respectLiveToggle ? e.liveEnabled !== false : true));

  if (targets.length === 0) {
    if (!quiet) toast("Nenhum item com Mercado Livre para atualizar.");
    return;
  }

  if (!quiet) toast(`Atualizando ${targets.length} itens no ML…`);

  for (const e of targets) {
    if (document.hidden) break;
    if (respectLiveToggle && e.liveEnabled === false) continue;
    await refreshEntryById(e.id, { silent: true, skipRender: true, respectLiveToggle: false });
    await new Promise((r) => window.setTimeout(r, 350));
  }

  renderList();
  if (!quiet) toast("Atualização ML finalizada.");
}

function restartLiveTimer() {
  if (liveTimer) window.clearInterval(liveTimer);
  liveTimer = null;

  const mins = Number($("live-interval").value || "0");
  localStorage.setItem(LIVE_INTERVAL_KEY, String(mins));
  if (!mins || mins <= 0) return;

  liveTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (!isPcPanelActive()) return;
    void refreshAllLiveEntries({ quiet: true, respectLiveToggle: true });
  }, mins * 60 * 1000);
}

function loadLivePrefsUi() {
  const mins = String(localStorage.getItem(LIVE_INTERVAL_KEY) || "0");
  const allowed = new Set(["0", "3", "5", "10", "15"]);
  $("live-interval").value = allowed.has(mins) ? mins : "0";
  $("price-proxy").value = localStorage.getItem(PROXY_KEY) || "";
}

function persistProxyFromUi() {
  localStorage.setItem(PROXY_KEY, clampStr($("price-proxy").value, 200));
}

function renderList() {
  const list = getFiltered();
  const empty = $("empty");
  const emptyText = $("empty-text");
  const ul = $("list");

  renderTotals();

  if (list.length === 0) {
    empty.hidden = false;
    ul.innerHTML = "";
    if (entries.length === 0) {
      emptyText.textContent = "Nenhuma peça ainda. Comece em “Novo lançamento”.";
    } else {
      emptyText.textContent = "Nenhum resultado com esses filtros/busca. Ajuste e tente de novo.";
    }
    return;
  }

  empty.hidden = true;
  ul.innerHTML = list
    .map((e) => {
      const cat = escapeHtml(CATEGORY_LABEL[e.category] || e.category);
      const st = escapeHtml(STATUS_LABEL[e.status] || e.status);
      const stClass = STATUS_PILL[e.status] || "pill";
      const title = escapeHtml(e.name || "Sem nome");
      const store = e.store.trim() ? escapeHtml(e.store.trim()) : "—";
      const price = formatBRL(Number(e.price) || 0);
      const url = e.url.trim();
      const notes = e.notes.trim() ? escapeHtml(e.notes.trim()) : "";
      const mlId = resolveMlItemId(e);

      const link = url
        ? `<a class="mono" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir link</a>`
        : `<span class="muted">Sem link</span>`;

      const liveLine = mlId
        ? e.lastLiveError
          ? `<div class="row__live row__live--err">ML ${escapeHtml(mlId)}: ${escapeHtml(e.lastLiveError)}</div>`
          : e.lastLiveAt
            ? `<div class="row__live">ML ${escapeHtml(mlId)} · última sync: ${escapeHtml(formatShortWhen(e.lastLiveAt))}</div>`
            : `<div class="row__live">ML ${escapeHtml(mlId)} · ainda não sincronizado</div>`
        : "";

      const mlBtn = mlId
        ? `<button class="row__btn" type="button" data-action="ml-refresh">ML agora</button>`
        : "";

      const livePill =
        mlId && e.liveEnabled === false
          ? `<span class="pill">ML manual</span>`
          : mlId
            ? `<span class="pill pill--green">ML</span>`
            : "";

      return `
        <li class="row" data-id="${escapeHtml(e.id)}">
          <div>
            <div class="row__top">
              <span class="pill pill--cyan">${cat}</span>
              <span class="pill ${escapeHtml(stClass)}">${st}</span>
              ${livePill}
            </div>
            <div class="row__title">${title}</div>
            <div class="row__meta">
              <span><span class="muted">Loja:</span> ${store}</span>
              <span class="price">${escapeHtml(price)}</span>
              <span>${link}</span>
            </div>
            ${liveLine}
            ${notes ? `<div class="row__notes"><span class="muted">Obs:</span> ${notes}</div>` : ""}
          </div>
          <div class="row__actions">
            ${mlBtn}
            <button class="row__btn" type="button" data-action="edit">Editar</button>
            <button class="row__btn row__btn--danger" type="button" data-action="delete">Excluir</button>
          </div>
        </li>
      `;
    })
    .join("");
}

function readForm() {
  const url = $("f-url").value;
  const mlTyped = $("f-ml-id").value;
  const mlItemId = normalizeMlItemId(mlTyped) || normalizeMlItemId(extractMlItemIdFromUrl(url) || "") || "";

  return normalizeEntryDraft({
    category: $("f-category").value,
    status: $("f-status").value,
    name: $("f-name").value,
    store: $("f-store").value,
    price: parseMoneyBR($("f-price").value),
    url,
    notes: $("f-notes").value,
    mlItemId,
    liveEnabled: $("f-live").checked,
  });
}

function resetForm() {
  editingId = null;
  $("form").reset();
  $("f-live").checked = true;
  $("btn-cancel").hidden = true;
  $("btn-save").textContent = "Salvar na agenda";
  updateMlHint();
}

function fillForm(e) {
  $("f-category").value = CATEGORY_LABEL[e.category] ? e.category : "outros";
  $("f-status").value = STATUS_LABEL[e.status] ? e.status : "pesquisa";
  $("f-name").value = e.name || "";
  $("f-store").value = e.store || "";
  $("f-price").value = Number(e.price) ? String(e.price).replace(".", ",") : "";
  $("f-url").value = e.url || "";
  $("f-ml-id").value = normalizeMlItemId(e.mlItemId) || "";
  $("f-live").checked = e.liveEnabled !== false;
  $("f-notes").value = e.notes || "";
  updateMlHint();
}

function upsertFromForm() {
  const draft = readForm();
  if (!draft.name) {
    toast("Informe o nome da peça.");
    $("f-name").focus();
    return;
  }
  if (!Number.isFinite(draft.price)) {
    toast("Preço inválido. Ex.: 1299,90");
    $("f-price").focus();
    return;
  }

  const now = new Date().toISOString();
  /** @type {string | null} */
  let createdId = null;

  if (editingId) {
    const idx = entries.findIndex((x) => x.id === editingId);
    if (idx === -1) {
      resetForm();
      toast("Não encontrei o item para editar.");
      renderList();
      return;
    }
    entries[idx] = {
      ...entries[idx],
      ...draft,
      updatedAt: now,
    };
    createdId = editingId;
    toast("Atualizado.");
  } else {
    createdId = uid();
    entries.unshift({
      id: createdId,
      createdAt: now,
      updatedAt: now,
      lastLiveAt: "",
      lastLiveError: "",
      ...draft,
    });
    toast("Salvo na agenda.");
  }

  save();
  resetForm();
  renderList();

  const ne = entries.find((x) => x.id === createdId);
  if (ne && resolveMlItemId(ne) && ne.liveEnabled) {
    void refreshEntryById(ne.id, { silent: true });
  }
}

function deleteEntry(id) {
  const ok = window.confirm("Excluir este item?");
  if (!ok) return;
  entries = entries.filter((x) => x.id !== id);
  if (editingId === id) resetForm();
  save();
  toast("Excluído.");
  renderList();
}

function startEdit(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (!isPcPanelActive()) setAppTab("pc", { fromHash: false });
  editingId = id;
  fillForm(e);
  $("btn-cancel").hidden = false;
  $("btn-save").textContent = "Atualizar item";
  window.location.hash = "#novo";
  $("f-name").focus();
}

function clearAll() {
  const msg =
    useSupabase && authedUserId
      ? "Limpar TODA a agenda? Isso apaga também os dados na nuvem para esta conta."
      : "Limpar TODA a agenda? Isso apaga os dados salvos neste navegador.";
  const ok = window.confirm(msg);
  if (!ok) return;
  entries = [];
  if (!useSupabase) {
    localStorage.removeItem(STORAGE_KEY);
  } else if (authedUserId) {
    scheduleCloudSave();
  }
  resetForm();
  toast("Agenda limpa.");
  renderList();
}

function setDefaultFinDate() {
  const el = document.getElementById("fin-f-date");
  if (!el) return;
  if (!el.value) {
    el.value = new Date().toISOString().slice(0, 10);
  }
}

function parseFinArray(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      id: String(x.id || uid()),
      createdAt: String(x.createdAt || new Date().toISOString()),
      updatedAt: String(x.updatedAt || new Date().toISOString()),
      type: FIN_TYPE_LABEL[x.type] ? String(x.type) : "gasto",
      date: clampStr(x.date, 12) || new Date().toISOString().slice(0, 10),
      description: clampStr(x.description, 160),
      amount: Number.isFinite(Number(x.amount)) ? Math.max(0, Number(x.amount)) : 0,
      notes: clampStr(x.notes, 400),
    }));
}

function loadFin() {
  if (useSupabase) return;
  try {
    const raw = localStorage.getItem(FIN_STORAGE_KEY);
    if (!raw) {
      finEntries = [];
      return;
    }
    finEntries = parseFinArray(JSON.parse(raw));
  } catch {
    finEntries = [];
  }
}

function saveFin() {
  if (!useSupabase) {
    localStorage.setItem(FIN_STORAGE_KEY, JSON.stringify(finEntries));
    return;
  }
  if (authedUserId) scheduleCloudSave();
}

function normalizeFinDraft(draft) {
  const type = FIN_TYPE_LABEL[draft.type] ? draft.type : "gasto";
  const amt = Number(draft.amount);
  return {
    type,
    date: clampStr(draft.date, 12) || new Date().toISOString().slice(0, 10),
    description: clampStr(draft.description, 160),
    amount: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : 0,
    notes: clampStr(draft.notes, 400),
  };
}

function computeFinTotals() {
  const sums = { ganho: 0, despesa: 0, gasto: 0, investimento: 0 };
  for (const e of finEntries) {
    const k = FIN_TYPE_LABEL[e.type] ? e.type : "gasto";
    sums[k] += Number(e.amount) || 0;
  }
  const out = sums.despesa + sums.gasto + sums.investimento;
  const saldo = sums.ganho - out;
  return { sums, saldo };
}

function renderFinTotals() {
  const { sums, saldo } = computeFinTotals();
  $("fin-sum-ganho").textContent = formatBRL(sums.ganho);
  $("fin-sum-despesa").textContent = formatBRL(sums.despesa);
  $("fin-sum-gasto").textContent = formatBRL(sums.gasto);
  $("fin-sum-invest").textContent = formatBRL(sums.investimento);
  $("fin-sum-saldo").textContent = formatBRL(saldo);
  $("fin-sum-saldo").classList.toggle("total__value--red", saldo < 0);
  $("fin-sum-saldo").classList.toggle("total__value--green", saldo >= 0);
}

function getFinFiltered() {
  const q = $("fin-search").value.trim().toLowerCase();
  const t = $("fin-filter-type").value;
  return finEntries
    .filter((e) => (t === "todos" ? true : e.type === t))
    .filter((e) => {
      if (!q) return true;
      const hay = `${e.description} ${e.notes}`.toLowerCase();
      return hay.includes(q);
    })
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function renderFinList() {
  const list = getFinFiltered();
  const empty = $("fin-empty");
  const emptyText = $("fin-empty-text");
  const ul = $("fin-list");

  renderFinTotals();

  if (list.length === 0) {
    empty.hidden = false;
    ul.innerHTML = "";
    emptyText.textContent = finEntries.length === 0 ? "Nenhum lançamento ainda." : "Nenhum resultado com esse filtro.";
    return;
  }

  empty.hidden = true;
  ul.innerHTML = list
    .map((e) => {
      const label = escapeHtml(FIN_TYPE_LABEL[e.type] || e.type);
      const pill = escapeHtml(FIN_PILL[e.type] || "pill");
      const desc = escapeHtml(e.description || "Sem descrição");
      const amt = formatBRL(Number(e.amount) || 0);
      const dt = escapeHtml(e.date || "—");
      const notes = e.notes.trim() ? escapeHtml(e.notes.trim()) : "";

      return `
        <li class="row" data-fin-id="${escapeHtml(e.id)}">
          <div>
            <div class="row__top">
              <span class="pill ${pill}">${label}</span>
              <span class="pill">${dt}</span>
            </div>
            <div class="row__title">${desc}</div>
            <div class="row__meta">
              <span class="price">${escapeHtml(amt)}</span>
            </div>
            ${notes ? `<div class="row__notes"><span class="muted">Obs:</span> ${notes}</div>` : ""}
          </div>
          <div class="row__actions">
            <button class="row__btn" type="button" data-fin-action="edit">Editar</button>
            <button class="row__btn row__btn--danger" type="button" data-fin-action="delete">Excluir</button>
          </div>
        </li>
      `;
    })
    .join("");
}

function readFinForm() {
  return normalizeFinDraft({
    type: $("fin-f-type").value,
    date: $("fin-f-date").value,
    description: $("fin-f-desc").value,
    amount: parseMoneyBR($("fin-f-amount").value),
    notes: $("fin-f-notes").value,
  });
}

function resetFinForm() {
  finEditingId = null;
  $("fin-form").reset();
  $("fin-btn-cancel").hidden = true;
  $("fin-btn-save").textContent = "Salvar";
  setDefaultFinDate();
}

function fillFinForm(e) {
  $("fin-f-type").value = FIN_TYPE_LABEL[e.type] ? e.type : "gasto";
  $("fin-f-date").value = e.date || new Date().toISOString().slice(0, 10);
  $("fin-f-desc").value = e.description || "";
  $("fin-f-amount").value = Number(e.amount) ? String(e.amount).replace(".", ",") : "";
  $("fin-f-notes").value = e.notes || "";
}

function upsertFinFromForm() {
  const draft = readFinForm();
  if (!draft.description) {
    toast("Informe a descrição.");
    $("fin-f-desc").focus();
    return;
  }
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    toast("Valor inválido. Ex.: 250,50");
    $("fin-f-amount").focus();
    return;
  }

  const now = new Date().toISOString();

  if (finEditingId) {
    const idx = finEntries.findIndex((x) => x.id === finEditingId);
    if (idx === -1) {
      resetFinForm();
      toast("Não encontrei o lançamento.");
      renderFinList();
      return;
    }
    finEntries[idx] = { ...finEntries[idx], ...draft, updatedAt: now };
    toast("Lançamento atualizado.");
  } else {
    finEntries.unshift({
      id: uid(),
      createdAt: now,
      updatedAt: now,
      ...draft,
    });
    toast("Lançamento salvo.");
  }

  saveFin();
  resetFinForm();
  renderFinList();
}

function deleteFinEntry(id) {
  const ok = window.confirm("Excluir este lançamento?");
  if (!ok) return;
  finEntries = finEntries.filter((x) => x.id !== id);
  if (finEditingId === id) resetFinForm();
  saveFin();
  toast("Excluído.");
  renderFinList();
}

function startFinEdit(id) {
  const e = finEntries.find((x) => x.id === id);
  if (!e) return;
  finEditingId = id;
  fillFinForm(e);
  $("fin-btn-cancel").hidden = false;
  $("fin-btn-save").textContent = "Atualizar";
  window.location.hash = "#fin-novo";
  $("fin-f-desc").focus();
}

function clearFinAll() {
  const msg =
    useSupabase && authedUserId
      ? "Limpar todos os lançamentos financeiros? Isso reflete na nuvem."
      : "Limpar todos os lançamentos financeiros?";
  const ok = window.confirm(msg);
  if (!ok) return;
  finEntries = [];
  if (!useSupabase) {
    localStorage.removeItem(FIN_STORAGE_KEY);
  } else if (authedUserId) {
    scheduleCloudSave();
  }
  resetFinForm();
  toast("Financeiro limpo.");
  renderFinList();
}

function loadCalViewFromStorage() {
  const raw = localStorage.getItem(CAL_VIEW_KEY) || "";
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (!m) return;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (Number.isFinite(y) && mo >= 0 && mo <= 11) {
    calViewYear = y;
    calViewMonth = mo;
  }
}

function saveCalView() {
  localStorage.setItem(CAL_VIEW_KEY, `${calViewYear}-${pad2(calViewMonth + 1)}`);
}

function parseCalArray(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      id: String(x.id || uid()),
      createdAt: String(x.createdAt || new Date().toISOString()),
      updatedAt: String(x.updatedAt || new Date().toISOString()),
      date: clampStr(x.date, 12),
      title: clampStr(x.title, 160),
      time: clampStr(x.time, 8),
      notes: clampStr(x.notes, 400),
    }))
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date));
}

function loadCal() {
  calSelected = toYmdLocal(new Date());
  loadCalViewFromStorage();
  if (useSupabase) return;
  try {
    const raw = localStorage.getItem(CAL_STORAGE_KEY);
    if (!raw) {
      calEvents = [];
      return;
    }
    calEvents = parseCalArray(JSON.parse(raw));
  } catch {
    calEvents = [];
  }
}

function saveCal() {
  if (!useSupabase) {
    localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(calEvents));
    return;
  }
  if (authedUserId) scheduleCloudSave();
}

function scheduleCloudSave() {
  if (!useSupabase || !authedUserId || !supabase) return;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(() => void flushCloudNow(), CLOUD_SAVE_MS);
}

async function flushCloudNow() {
  if (!useSupabase || !supabase || !authedUserId) return;
  const { error } = await supabase.from("user_data").upsert(
    {
      user_id: authedUserId,
      pc_entries: entries,
      fin_entries: finEntries,
      cal_events: calEvents,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    console.error(error);
    toast("Erro ao salvar na nuvem.");
  }
}

function tryMigrateLocalStorageToState() {
  let touched = false;
  try {
    if (entries.length === 0) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const next = parseEntriesArray(JSON.parse(raw));
        if (next.length) {
          entries = next;
          touched = true;
        }
      }
    }
    if (finEntries.length === 0) {
      const raw = localStorage.getItem(FIN_STORAGE_KEY);
      if (raw) {
        const next = parseFinArray(JSON.parse(raw));
        if (next.length) {
          finEntries = next;
          touched = true;
        }
      }
    }
    if (calEvents.length === 0) {
      const raw = localStorage.getItem(CAL_STORAGE_KEY);
      if (raw) {
        const next = parseCalArray(JSON.parse(raw));
        if (next.length) {
          calEvents = next;
          touched = true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return touched;
}

/**
 * @param {{ id: string }} user Utilizador da sessão (evita corrida com getUser() logo após o login).
 */
async function hydrateFromCloud(user) {
  if (!supabase || !user?.id) return;

  const { data, error } = await supabase
    .from("user_data")
    .select("pc_entries, fin_entries, cal_events")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error(error);
    toast("Não foi possível carregar os dados na nuvem.");
    return;
  }

  const countLen = (v) => (Array.isArray(v) ? v.length : 0);
  const cloudPc = data?.pc_entries;
  const cloudFin = data?.fin_entries;
  const cloudCal = data?.cal_events;
  const cloudEmpty = countLen(cloudPc) + countLen(cloudFin) + countLen(cloudCal) === 0;

  if (data && !cloudEmpty) {
    entries = parseEntriesArray(cloudPc);
    finEntries = parseFinArray(cloudFin);
    calEvents = parseCalArray(cloudCal);
  } else {
    entries = [];
    finEntries = [];
    calEvents = [];
    const migrated = tryMigrateLocalStorageToState();
    await flushCloudNow();
    if (migrated) {
      toast("Dados salvos neste navegador foram enviados para a nuvem.");
    }
  }

  calSelected = toYmdLocal(new Date());
  loadCalViewFromStorage();
  applyRouteFromHash();
  updateMlHint();
  renderList();
  renderFinList();
  renderCalendarUi();
}

/** @type {string | null} */
let lastHydratedUserId = null;

function setAuthMsg(text, isErr = false) {
  const el = document.getElementById("auth-msg");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle("auth-msg--err", Boolean(text && isErr));
}

function showAuthGate() {
  lastHydratedUserId = null;
  document.body.classList.add("is-authing");
  const screen = document.getElementById("auth-screen");
  const header = document.getElementById("main-header");
  const main = document.getElementById("conteudo-principal");
  const foot = document.querySelector(".site-footer");
  const acc = document.getElementById("topbar-account");
  if (screen) screen.hidden = false;
  if (header) header.hidden = true;
  if (main) main.hidden = true;
  if (foot) foot.hidden = true;
  if (acc) acc.hidden = true;
}

async function showAppAfterAuth(user) {
  document.body.classList.remove("is-authing");
  const screen = document.getElementById("auth-screen");
  const header = document.getElementById("main-header");
  const main = document.getElementById("conteudo-principal");
  const foot = document.querySelector(".site-footer");
  const acc = document.getElementById("topbar-account");
  const label = document.getElementById("auth-user-label");
  if (screen) screen.hidden = true;
  if (header) header.hidden = false;
  if (main) main.hidden = false;
  if (foot) foot.hidden = false;
  if (acc) acc.hidden = false;
  if (label) label.textContent = user.email || "";

  authedUserId = user.id;

  const needHydrate = lastHydratedUserId !== user.id;
  if (needHydrate) {
    lastHydratedUserId = user.id;
    try {
      await hydrateFromCloud(user);
    } catch (err) {
      console.error(err);
      lastHydratedUserId = null;
      toast("Erro ao carregar dados na nuvem. Verifique a tabela user_data e a rede.");
    }
  }
  loadLivePrefsUi();
  restartLiveTimer();
}

async function handleAuthEvent(_event, session) {
  if (!session?.user) {
    authedUserId = null;
    entries = [];
    finEntries = [];
    calEvents = [];
    showAuthGate();
    renderList();
    renderFinList();
    renderCalendarUi();
    return;
  }
  try {
    await showAppAfterAuth(session.user);
  } catch (err) {
    console.error(err);
    toast("Erro ao abrir a sessão. Recarregue a página e tente de novo.");
  }
}

const MSG_FETCH_FAIL =
  "O navegador não conseguiu ligar ao Supabase (Failed to fetch). Confira: (1) VITE_SUPABASE_URL no .env.local igual a Settings → API → Project URL; (2) abra o site com npm run dev em http://localhost:5173 — não use file://; (3) desative bloqueadores de anúncios/rastreio nesta página; (4) no painel Supabase, veja se o projeto não está pausado.";

function mapAuthError(err) {
  const msg = String(err?.message ?? err ?? "");
  const lower = msg.toLowerCase();
  if (
    lower.includes("failed to fetch") ||
    lower.includes("load failed") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed")
  ) {
    return MSG_FETCH_FAIL;
  }
  if (lower.includes("invalid login") || lower.includes("invalid_credentials")) {
    return "E-mail ou senha incorretos.";
  }
  if (lower.includes("email not confirmed")) {
    return "Confirme o link no e-mail antes de entrar (ou desative a confirmação em Authentication → Providers no Supabase).";
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return MSG_FETCH_FAIL;
  }
  return msg || "Não foi possível entrar.";
}

function wireAuth() {
  if (!useSupabase || !supabase) return;

  const formLogin = document.getElementById("form-login");

  formLogin?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = document.getElementById("auth-email-login")?.value?.trim() || "";
    const password = document.getElementById("auth-pass-login")?.value || "";
    setAuthMsg("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.error("signInWithPassword", error);
        setAuthMsg(mapAuthError(error), true);
        return;
      }
      if (!data?.session) {
        setAuthMsg("Login não devolveu sessão. Confirme o e-mail da conta ou tente outro navegador.", true);
      }
    } catch (err) {
      console.error("signInWithPassword", err);
      setAuthMsg(mapAuthError(err), true);
    }
  });

  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
    await flushCloudNow();
    await supabase.auth.signOut();
  });

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "INITIAL_SESSION") return;
    void handleAuthEvent(event, session);
  });
}

async function init() {
  wire();
  wireAuth();

  if (!useSupabase) {
    const authScr = document.getElementById("auth-screen");
    if (authScr) authScr.hidden = true;
    load();
    loadFin();
    loadCal();
    applyRouteFromHash();
    updateMlHint();
    renderList();
    renderFinList();
    loadLivePrefsUi();
    restartLiveTimer();
    return;
  }

  const cfgErr = document.getElementById("auth-config-error");
  if (cfgErr) cfgErr.hidden = true;

  showAuthGate();

  try {
    const health = await fetch(`${supabaseUrl}/auth/v1/health`, { method: "GET" });
    if (!health.ok) {
      if (cfgErr) {
        cfgErr.hidden = false;
        cfgErr.textContent = `O Supabase respondeu HTTP ${health.status}. Confira VITE_SUPABASE_URL (Project URL) e a chave anon.`;
      }
    }
  } catch {
    if (cfgErr) {
      cfgErr.hidden = false;
      cfgErr.textContent = MSG_FETCH_FAIL;
    }
  }

  const { data } = await supabase.auth.getSession();
  await handleAuthEvent("INITIAL_CHECK", data.session);
}

function normalizeCalDraft(draft) {
  const date = clampStr(draft.date, 12);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(date);
  return {
    date: ok ? date : toYmdLocal(new Date()),
    title: clampStr(draft.title, 160),
    time: clampStr(draft.time, 8),
    notes: clampStr(draft.notes, 400),
  };
}

function calEventsOnDate(ymd) {
  return calEvents
    .filter((e) => e.date === ymd)
    .slice()
    .sort((a, b) => {
      const ta = a.time || "";
      const tb = b.time || "";
      if (ta && tb) return ta.localeCompare(tb);
      if (ta) return -1;
      if (tb) return 1;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
}

function calHasEventOn(ymd) {
  return calEvents.some((e) => e.date === ymd);
}

function syncCalStripDate() {
  const el = document.getElementById("cal-strip-date");
  if (el) el.value = calSelected;
}

function calSelectedIsToday() {
  return calSelected === toYmdLocal(new Date());
}

/** Células do mês (domingo = primeira coluna), como etec-informa.vercel.app */
function buildCalendarCellsForMonth(year, month) {
  const dim = new Date(year, month + 1, 0).getDate();
  const first = new Date(year, month, 1);
  const pad = first.getDay();
  const prevDim = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < pad; i++) {
    const d = prevDim - pad + i + 1;
    const pm = month === 0 ? 11 : month - 1;
    const py = month === 0 ? year - 1 : year;
    cells.push({ y: py, m: pm, d, muted: true });
  }
  for (let d = 1; d <= dim; d++) {
    cells.push({ y: year, m: month, d, muted: false });
  }
  const total = cells.length;
  const tail = (7 - (total % 7)) % 7;
  let nd = 1;
  const nm = month === 11 ? 0 : month + 1;
  const ny = month === 11 ? year + 1 : year;
  for (let i = 0; i < tail; i++) {
    cells.push({ y: ny, m: nm, d: nd++, muted: true });
  }
  return cells.map(({ y, m, d, muted }) => ({
    iso: toYmdLocal(new Date(y, m, d)),
    n: d,
    muted,
  }));
}

function renderCalDayList() {
  const list = calEventsOnDate(calSelected);
  const empty = $("cal-day-empty");
  const wrap = $("cal-day-list");
  $("cal-f-date").value = calSelected;
  syncCalStripDate();

  const label = $("cal-selected-label");
  label.textContent = calSelectedIsToday() ? "Hoje" : "Eventos neste dia";

  const parts = calSelected.split("-").map(Number);
  const monAbbr =
    parts.length >= 2 && parts[1] >= 1 && parts[1] <= 12 ? CAL_MONTH_ABBR_PT[parts[1] - 1] : "";
  const dayNum = parts.length >= 3 ? String(parts[2]) : "";

  if (list.length === 0) {
    empty.hidden = false;
    wrap.innerHTML = "";
    return;
  }

  empty.hidden = true;
  wrap.innerHTML = list
    .map((e) => {
      const title = escapeHtml(e.title || "Sem título");
      const notes = e.notes.trim() ? escapeHtml(e.notes.trim()) : "";
      const whenLine = e.time ? escapeHtml(e.time) : "—";
      const badge = `<div class="calendar-day-event__badge"><span class="calendar-day-event__num">${escapeHtml(dayNum)}</span><span class="calendar-day-event__mon">${escapeHtml(monAbbr)}</span></div>`;
      const desc = notes ? `<div class="agenda__desc">${notes}</div>` : "";
      return `<article class="agenda__item calendar-day-event" data-cal-id="${escapeHtml(e.id)}">${badge}<div class="agenda__meta"><div class="agenda__title">${title}</div>${desc}<div class="calendar-day-event__when">${whenLine}</div><div class="calendar-day-event__actions"><button type="button" class="calendar-ev-btn" data-cal-action="edit">Editar</button><button type="button" class="calendar-ev-btn calendar-ev-btn--danger" data-cal-action="delete">Excluir</button></div></div></article>`;
    })
    .join("");
}

function renderCalGrid() {
  const year = calViewYear;
  const month = calViewMonth;
  const today = toYmdLocal(new Date());

  $("cal-month-label").textContent = `${CAL_MONTHS_PT[month]} ${year}`;

  const cells = buildCalendarCellsForMonth(year, month);
  $("cal-grid").innerHTML = cells
    .map(({ iso, muted, n }) => {
      const mutedC = muted ? " calendar-day--muted" : "";
      const has = calHasEventOn(iso);
      const tone = has ? " calendar-day--has-events calendar-day--tone-orange" : "";
      const isToday = iso === today ? " calendar-day--today" : "";
      const isSel = iso === calSelected ? " calendar-day--selected" : "";
      return `<button type="button" class="calendar-day${mutedC}${tone}${isToday}${isSel}" data-cal-day="${escapeHtml(iso)}" aria-pressed="${iso === calSelected ? "true" : "false"}"><span class="calendar-day__num">${n}</span></button>`;
    })
    .join("");
}

function renderCalendarUi() {
  renderCalGrid();
  renderCalDayList();
}

function selectCalDay(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
  const d = new Date(`${ymd}T12:00:00`);
  if (!Number.isNaN(d.getTime())) {
    if (d.getFullYear() !== calViewYear || d.getMonth() !== calViewMonth) {
      calViewYear = d.getFullYear();
      calViewMonth = d.getMonth();
      saveCalView();
    }
  }
  calSelected = ymd;
  $("cal-f-date").value = ymd;
  renderCalendarUi();
}

function shiftCalMonth(delta) {
  calViewMonth += delta;
  if (calViewMonth > 11) {
    calViewMonth = 0;
    calViewYear++;
  }
  if (calViewMonth < 0) {
    calViewMonth = 11;
    calViewYear--;
  }
  saveCalView();
  renderCalGrid();
}

function resetCalForm() {
  calEditingId = null;
  $("cal-form").reset();
  $("cal-f-date").value = calSelected;
  $("cal-btn-cancel").hidden = true;
  $("cal-btn-save").textContent = "Salvar evento";
}

function fillCalForm(e) {
  $("cal-f-date").value = e.date || calSelected;
  $("cal-f-title").value = e.title || "";
  $("cal-f-time").value = e.time || "";
  $("cal-f-notes").value = e.notes || "";
}

function upsertCalFromForm() {
  const draft = normalizeCalDraft({
    date: $("cal-f-date").value,
    title: $("cal-f-title").value,
    time: $("cal-f-time").value,
    notes: $("cal-f-notes").value,
  });

  if (!draft.title.trim()) {
    toast("Informe o título do evento.");
    $("cal-f-title").focus();
    return;
  }

  const now = new Date().toISOString();

  if (calEditingId) {
    const idx = calEvents.findIndex((x) => x.id === calEditingId);
    if (idx === -1) {
      resetCalForm();
      toast("Não encontrei o evento.");
      renderCalendarUi();
      return;
    }
    calEvents[idx] = { ...calEvents[idx], ...draft, updatedAt: now };
    calSelected = draft.date;
    toast("Evento atualizado.");
  } else {
    calEvents.unshift({
      id: uid(),
      createdAt: now,
      updatedAt: now,
      ...draft,
    });
    calSelected = draft.date;
    toast("Evento salvo.");
  }

  saveCal();
  const parts = draft.date.split("-").map(Number);
  if (parts.length === 3 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    calViewYear = parts[0];
    calViewMonth = parts[1] - 1;
    saveCalView();
  }
  resetCalForm();
  renderCalendarUi();
}

function deleteCalEntry(id) {
  const ok = window.confirm("Excluir este evento?");
  if (!ok) return;
  calEvents = calEvents.filter((x) => x.id !== id);
  if (calEditingId === id) resetCalForm();
  saveCal();
  toast("Excluído.");
  renderCalendarUi();
}

function startCalEdit(id) {
  const e = calEvents.find((x) => x.id === id);
  if (!e) return;
  const d0 = new Date(`${e.date}T12:00:00`);
  if (!Number.isNaN(d0.getTime())) {
    calViewYear = d0.getFullYear();
    calViewMonth = d0.getMonth();
    saveCalView();
  }
  calEditingId = id;
  fillCalForm(e);
  calSelected = e.date || calSelected;
  $("cal-btn-cancel").hidden = false;
  $("cal-btn-save").textContent = "Atualizar evento";
  window.location.hash = "#cal-novo";
  $("cal-f-title").focus();
  renderCalendarUi();
}

function clearCalAll() {
  const msg =
    useSupabase && authedUserId
      ? "Limpar todos os eventos do calendário? Isso reflete na nuvem."
      : "Limpar todos os eventos do calendário?";
  const ok = window.confirm(msg);
  if (!ok) return;
  calEvents = [];
  if (!useSupabase) {
    localStorage.removeItem(CAL_STORAGE_KEY);
  } else if (authedUserId) {
    scheduleCloudSave();
  }
  resetCalForm();
  toast("Calendário limpo.");
  renderCalendarUi();
}

function wireCal() {
  $("cal-prev").addEventListener("click", () => shiftCalMonth(-1));
  $("cal-next").addEventListener("click", () => shiftCalMonth(1));

  $("cal-grid").addEventListener("click", (ev) => {
    const t = ev.target;
    const btn = t instanceof HTMLElement ? t.closest("button[data-cal-day]") : null;
    if (!btn) return;
    const day = btn.getAttribute("data-cal-day");
    if (day) selectCalDay(day);
  });

  $("cal-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    upsertCalFromForm();
  });

  $("cal-btn-cancel").addEventListener("click", () => {
    resetCalForm();
    toast("Edição cancelada.");
  });

  $("cal-btn-clear").addEventListener("click", () => clearCalAll());

  $("cal-f-date").addEventListener("change", () => {
    const v = $("cal-f-date").value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      selectCalDay(v);
    }
  });

  $("cal-strip-date").addEventListener("change", () => {
    const v = $("cal-strip-date").value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) selectCalDay(v);
  });

  $("cal-strip-prev").addEventListener("click", () => {
    const dt = new Date(`${calSelected}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return;
    dt.setDate(dt.getDate() - 1);
    selectCalDay(toYmdLocal(dt));
  });

  $("cal-strip-next").addEventListener("click", () => {
    const dt = new Date(`${calSelected}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return;
    dt.setDate(dt.getDate() + 1);
    selectCalDay(toYmdLocal(dt));
  });

  $("cal-day-list").addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("button[data-cal-action]");
    if (!btn) return;
    const row = btn.closest("[data-cal-id]");
    const id = row?.getAttribute("data-cal-id");
    if (!id) return;
    const action = btn.getAttribute("data-cal-action");
    if (action === "edit") startCalEdit(id);
    if (action === "delete") deleteCalEntry(id);
  });
}

function resolveInitialTab() {
  const h = (window.location.hash || "").toLowerCase();
  if (h === "#financeiro" || h.startsWith("#fin")) return "financeiro";
  if (h === "#calendario" || h.startsWith("#cal-")) return "calendario";
  if (h === "#inicio" || h === "#novo" || h === "#agenda") return "pc";
  const saved = localStorage.getItem(APP_TAB_KEY);
  if (!h && (saved === "financeiro" || saved === "calendario")) return saved;
  return "pc";
}

function setAppTab(tab, { fromHash = false } = {}) {
  const t = tab === "financeiro" ? "financeiro" : tab === "calendario" ? "calendario" : "pc";

  $("panel-pc").hidden = t !== "pc";
  $("panel-fin").hidden = t !== "financeiro";
  $("panel-cal").hidden = t !== "calendario";

  $("tab-app-pc").classList.toggle("is-active", t === "pc");
  $("tab-app-fin").classList.toggle("is-active", t === "financeiro");
  $("tab-app-cal").classList.toggle("is-active", t === "calendario");

  $("tab-app-pc").setAttribute("aria-selected", String(t === "pc"));
  $("tab-app-fin").setAttribute("aria-selected", String(t === "financeiro"));
  $("tab-app-cal").setAttribute("aria-selected", String(t === "calendario"));

  localStorage.setItem(APP_TAB_KEY, t);

  if (!fromHash) {
    const cur = (window.location.hash || "").toLowerCase();
    if (t === "financeiro") {
      if (cur !== "#financeiro" && !cur.startsWith("#fin")) {
        window.location.hash = "financeiro";
      }
    } else if (t === "calendario") {
      if (cur !== "#calendario" && !cur.startsWith("#cal-")) {
        window.location.hash = "calendario";
      }
    } else if (
      cur === "#financeiro" ||
      cur.startsWith("#fin") ||
      cur === "#calendario" ||
      cur.startsWith("#cal-")
    ) {
      window.location.hash = "inicio";
    }
  }

  renderFinList();
  if (t === "calendario") renderCalendarUi();
}

function applyRouteFromHash() {
  const tab = resolveInitialTab();
  if (tab === "financeiro") {
    setAppTab("financeiro", { fromHash: true });
    return;
  }
  if (tab === "calendario") {
    setAppTab("calendario", { fromHash: true });
    return;
  }
  setAppTab("pc", { fromHash: true });
}

function wireFin() {
  setDefaultFinDate();

  $("fin-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    upsertFinFromForm();
  });

  $("fin-btn-cancel").addEventListener("click", () => {
    resetFinForm();
    toast("Edição cancelada.");
  });

  $("fin-btn-clear").addEventListener("click", () => clearFinAll());

  ["fin-search", "fin-filter-type"].forEach((id) => {
    $(id).addEventListener("input", () => renderFinList());
    $(id).addEventListener("change", () => renderFinList());
  });

  $("fin-list").addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("button[data-fin-action]");
    if (!btn) return;
    const row = btn.closest(".row");
    const id = row?.getAttribute("data-fin-id");
    if (!id) return;
    const action = btn.getAttribute("data-fin-action");
    if (action === "edit") startFinEdit(id);
    if (action === "delete") deleteFinEntry(id);
  });
}

function wire() {
  loadLivePrefsUi();
  restartLiveTimer();

  $("tab-app-pc").addEventListener("click", () => setAppTab("pc"));
  $("tab-app-fin").addEventListener("click", () => setAppTab("financeiro"));
  $("tab-app-cal").addEventListener("click", () => setAppTab("calendario"));

  $("form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    upsertFromForm();
  });

  $("btn-cancel").addEventListener("click", () => {
    resetForm();
    toast("Edição cancelada.");
  });

  $("btn-clear").addEventListener("click", () => clearAll());

  $("btn-refresh-ml").addEventListener("click", () => {
    void refreshAllLiveEntries({ quiet: false, respectLiveToggle: false });
  });

  ["f-url", "f-ml-id"].forEach((id) => {
    $(id).addEventListener("input", () => updateMlHint());
    $(id).addEventListener("change", () => updateMlHint());
  });

  $("live-interval").addEventListener("change", () => {
    restartLiveTimer();
  });

  $("price-proxy").addEventListener("change", () => {
    persistProxyFromUi();
  });

  $("price-proxy").addEventListener("blur", () => {
    persistProxyFromUi();
  });

  ["search", "filter-cat", "filter-status"].forEach((id) => {
    $(id).addEventListener("input", () => renderList());
    $(id).addEventListener("change", () => renderList());
  });

  $("list").addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("button[data-action]");
    if (!btn) return;
    const row = btn.closest(".row");
    const id = row?.getAttribute("data-id");
    if (!id) return;
    const action = btn.getAttribute("data-action");
    if (action === "edit") startEdit(id);
    if (action === "delete") deleteEntry(id);
    if (action === "ml-refresh") void refreshEntryById(id, { silent: false });
  });

  window.addEventListener("hashchange", () => applyRouteFromHash());

  wireFin();
  wireCal();
}

void init().catch((err) => {
  console.error("init", err);
  const cfg = document.getElementById("auth-config-error");
  if (cfg) {
    cfg.hidden = false;
    cfg.textContent = "Erro ao iniciar o app. Abra o console (F12) para detalhes.";
  }
});
