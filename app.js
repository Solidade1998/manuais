// =====================================================================
//  Manuais — app para consultar manuais de manutenção no celular
//  Tudo fica salvo no próprio aparelho (IndexedDB). Nada é enviado.
// =====================================================================
import * as pdfjsLib from './lib/pdf.min.mjs';

const APP_VERSION = '3.3.1';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';
const LIB = new URL('lib/', location.href).href;
const PDF_OPTS = {
  standardFontDataUrl: LIB + 'standard_fonts/',
  wasmUrl: LIB + 'wasm/', iccUrl: LIB + 'iccs/',
  isEvalSupported: false,
};

// ---------------------------------------------------------------------
//  Banco de dados local
// ---------------------------------------------------------------------
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('manuais', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('docs', { keyPath: 'id' }); // dados e sumário
      d.createObjectStore('files');                    // o PDF em si
      d.createObjectStore('text');                     // texto das páginas (busca)
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    let out;
    const r = fn(tx.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Sem espaço?'));
  });
}
const dbGet = (s, k) => idb(s, 'readonly', st => st.get(k));
const dbPut = (s, v, k) => idb(s, 'readwrite', st => st.put(v, k));
const dbDel = (s, k) => idb(s, 'readwrite', st => st.delete(k));
const dbAll = s => idb(s, 'readonly', st => st.getAll());
const saveDoc = d => {
  if (d.cloud) { // manual aberto pela nuvem: guarda só favoritos e última página
    try { const m = JSON.parse(localStorage.getItem('manuais.cloudmeta') || '{}'); m[d.rid] = { favs: d.favs, lastPage: d.lastPage, opened: d.opened }; localStorage.setItem('manuais.cloudmeta', JSON.stringify(m)); } catch {}
    return Promise.resolve();
  }
  return dbPut('docs', d);
};

// ---------------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
let toastT;
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
}
const fmtMB = b => !b ? '0 MB' : b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(b > 104857600 ? 0 : 1).replace('.', ',') + ' MB';

// Normalização para busca: sem acento e minúsculo, MESMO tamanho do texto
// original (assim dá para recortar e destacar o trecho certo).
const ACC = {};
for (let i = 0xC0; i <= 0x24F; i++) {
  const c = String.fromCharCode(i), b = c.normalize('NFD')[0].toLowerCase();
  ACC[c] = b.length === 1 ? b : c.toLowerCase().length === 1 ? c.toLowerCase() : c;
}
const norm = s => s.replace(/[À-ɏ]/g, c => ACC[c]).toLowerCase();
const STOP = new Set('a o e as os de do da dos das em no na nos nas um uma ao aos para por com que se'.split(' '));
const terms = q => { const all = norm(q).split(/\s+/).filter(Boolean); const f = all.filter(t => !STOP.has(t)); return f.length ? f : all; };

// ---------------------------------------------------------------------
//  Categorias (sistemas da máquina) a partir do título dos capítulos
// ---------------------------------------------------------------------
const CATS = [
  ['Hidráulica', /hidraul/],
  ['Pneumática', /pneumat|^ar$|^ar\b|ar comprimido|compressor de ar|freio a ar/],
  ['Elétrica', /eletric|eletron|bateria|chicote|alternador|fusive|\brele\b/],
  ['Motor', /^motor|motor diesel|arrefec|radiador|turbo/],
  ['Combustível', /combust|diesel/],
  ['Lubrificação', /lubrif|fluidos?\b|\boleo|graxa/],
  ['Segurança', /seguranc/],
  ['Geral', /^introdu|historico|identificacao de literatura|^sumario|^indice|^anexo|^apendice|especificac|torque|^prefacio|^glossario/],
];
const CAT_ORDER = ['Mecânica', ...CATS.map(c => c[0])];
const catOf = t => { const n = norm(t).trim(); for (const [c, re] of CATS) if (re.test(n)) return c; return null; };

function docCats(doc) {
  // devolve Map(idDoNó -> categoria). Capítulo herda para os subtópicos,
  // a não ser que o capítulo seja genérico (Mecânica/Geral) e o subtópico
  // seja claramente de outro sistema.
  if (doc._cats) return doc._cats;
  const m = new Map();
  const walk = (nodes, parent) => {
    for (const n of nodes) {
      let c = doc.catFix?.[n.id];
      if (!c) {
        const own = catOf(n.t);
        if (!parent) c = doc.cat || own || 'Mecânica';
        else if ((parent === 'Mecânica' || parent === 'Geral') && own && own !== 'Geral') c = own;
        else c = parent;
      }
      m.set(n.id, c);
      if (n.c) walk(n.c, c);
    }
  };
  walk(outlineOf(doc), null);
  return (doc._cats = m);
}
const outlineOf = d => (d.outline?.length ? d.outline : d.auto || []);
function flatOutline(doc) {
  if (doc._flat) return doc._flat;
  const out = [];
  const walk = (nodes, path) => { for (const n of nodes) { const p = [...path, n.t]; out.push({ n, path: p }); if (n.c) walk(n.c, p); } };
  walk(outlineOf(doc), []);
  return (doc._flat = out);
}
function topicAt(doc, page) {
  let best = null;
  for (const f of flatOutline(doc)) if (f.n.p != null && f.n.p <= page && (!best || f.n.p >= best.n.p)) best = f;
  return best;
}

// ---------------------------------------------------------------------
//  Estado
// ---------------------------------------------------------------------
const S = {
  docs: [], cat: 'Todos', q: '', mq: '',
  texts: new Map(),            // id -> {raw:[], norm:[]}
  expanded: new Map(),         // id -> Set(nós abertos)
  scroll: {},                  // posição de rolagem de cada tela
  cur: null,                   // manual aberto
  ixId: null,                  // manual sendo indexado
};
const docById = id => S.docs.find(d => d.id === id) || S.cloud.find(d => d.id === id);
S.cloud = [];            // manuais que ficam só na nuvem (abrem com internet)
S.cloudBlobs = new Map(); // PDFs da nuvem abertos nesta sessão (só na memória)
S.brand = (() => { try { return localStorage.getItem('manuais.brand') || 'Todas'; } catch { return 'Todas'; } })();
const brandOf = d => d.brand || 'Outros';
const inBrand = d => S.brand === 'Todas' || brandOf(d) === S.brand;
const visDocs = () => S.docs.filter(inBrand);

// ---------------------------------------------------------------------
//  PDF
// ---------------------------------------------------------------------
const pdfCache = new Map();
function getPdf(id) {
  if (pdfCache.has(id)) { const p = pdfCache.get(id); pdfCache.delete(id); pdfCache.set(id, p); return p; }
  const p = (async () => {
    const blob = id.startsWith('c:') ? S.cloudBlobs.get(id) : await dbGet('files', id);
    if (!blob) throw new Error('Arquivo não encontrado');
    const data = new Uint8Array(await blob.arrayBuffer());
    const task = pdfjsLib.getDocument({ data, ...PDF_OPTS });
    const pdf = await task.promise; pdf._task = task; return pdf;
  })();
  pdfCache.set(id, p);
  p.catch(() => pdfCache.delete(id));
  while (pdfCache.size > 2) {
    const k = [...pdfCache.keys()].find(k => k !== id && k !== V.id && k !== S.ixId);
    if (!k) break;
    const old = pdfCache.get(k); pdfCache.delete(k);
    old.then(d => d._task.destroy()).catch(() => {});
  }
  return p;
}

async function readOutline(pdf) {
  let ol;
  try { ol = await pdf.getOutline(); } catch { return []; }
  if (!ol?.length) return [];
  // Esquemas EPLAN: o sumário tem dezenas de milhares de itens (lista de cada
  // fio/borne). Usa só a "árvore de páginas", que é o que interessa.
  let eplan = false;
  const tree = ol.find(o => /^(árvore de páginas|arvore de paginas|arborescence de page|page tree|seitenbaum)/i.test((o.title || '').trim()));
  if (tree?.items?.length) {
    eplan = true; ol = tree.items;
    if (ol.length === 1 && ol[0].items?.length) ol = ol[0].items; // pula a raiz única
  }
  // limite de itens: corta os níveis mais fundos se passar de 4000
  const MAXN = 4000;
  const perDepth = [];
  (function cnt(items, d) { for (const it of items) { perDepth[d] = (perDepth[d] || 0) + 1; if (it.items?.length) cnt(it.items, d + 1); } })(ol, 0);
  let maxDepth = perDepth.length, acc = 0;
  for (let d = 0; d < perDepth.length; d++) { acc += perDepth[d]; if (acc > MAXN) { maxDepth = Math.max(1, d); break; } }
  const pageOf = async dest => {
    try {
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) return null;
      const ref = dest[0];
      if (typeof ref === 'number') return ref + 1;
      if (ref && typeof ref === 'object') return (await pdf.getPageIndex(ref)) + 1;
    } catch {}
    return null;
  };
  const walk = async (items, prefix, depth = 0) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i], id = prefix ? prefix + '.' + i : String(i);
      let t = (it.title || '');
      if (eplan) t = t.replace(/_/g, ' ').replace(/^&E[A-Z]{2,3}\d*\s+/, '');
      const n = { id, t: t.replace(/\s+/g, ' ').trim() || '(sem título)', p: await pageOf(it.dest) };
      if (it.items?.length && depth + 1 < maxDepth) n.c = await walk(it.items, id, depth + 1);
      if (n.p == null && n.c?.length) n.p = n.c.find(x => x.p != null)?.p ?? null;
      out.push(n);
    }
    return out;
  };
  return walk(ol, '');
}

// ---------------------------------------------------------------------
//  Catálogo: reconhece manuais conhecidos pelo nome do arquivo e já
//  coloca nome bonito, grupo, ordem e sistema. Para novas máquinas,
//  é só acrescentar linhas aqui.
// ---------------------------------------------------------------------
const G_MAN = 'MHC80 — Manuais', G_TRE = 'MHC80 — Treinamento', G_ESQ = 'MHC80 — Esquemas';
const CATALOG = [
  [/MHC80.*corrective.?maintenance/i, 'Manutenção Corretiva', G_MAN, 10],
  [/MHC80.*preventive.?maintenance/i, 'Manutenção Preventiva', G_MAN, 11],
  [/MHC80.*operator.?manual|manual.?de.?opera.*MHC80/i, 'Manual de Operação', G_MAN, 12],
  [/MHC80.*lockout|intertravamento.*MHC80/i, 'Intertravamento (Bloqueio e Etiquetagem)', G_MAN, 13, 'Segurança'],
  [/(^|[^.\d])1_MHC_Introduction/i, '1 · Introdução', G_TRE, 21],
  [/2_MHC_Mechanical/i, '2 · Sistema Mecânico', G_TRE, 22, 'Mecânica'],
  [/3_MHC_Pneumatic/i, '3 · Sistema Pneumático', G_TRE, 23, 'Pneumática'],
  [/4_MHC_Hydraulic/i, '4 · Sistema Hidráulico', G_TRE, 24, 'Hidráulica'],
  [/5\.1_MHC_Electrical/i, '5.1 · Padrões Elétricos e Esquemas', G_TRE, 26, 'Elétrica'],
  [/5_MHC_Electrical/i, '5 · Sistema Elétrico', G_TRE, 25, 'Elétrica'],
  [/6_MHC_Data/i, '6 · Registro de Dados (Edge Gateway)', G_TRE, 27, 'Elétrica'],
  [/7_MHC_General/i, '7 · Operações Gerais', G_TRE, 28],
  [/8_MHC_Maintenance/i, '8 · Tarefas de Manutenção', G_TRE, 29],
  [/9_MHC_Trouble/i, '9 · Solução de Problemas', G_TRE, 30],
  [/EL.?TRICO.?HIDR.*MHC/i, 'Esquema Elétrico / Hidráulico', G_ESQ, 41, 'Elétrica'],
  [/^AR.?ESQUEM.*MHC/i, 'Esquema Pneumático (Ar)', G_ESQ, 40, 'Pneumática'],
  [/^HIDR.?ULICO.?ESQUEM.*MHC/i, 'Esquema Hidráulico', G_ESQ, 42, 'Hidráulica'],
].map(([re, name, group, order, cat]) => [re, name, group, order, cat, 'Loram']);
// Convenção para arquivos já organizados:  Marca__Grupo__Ordem__Nome[__Sistema].pdf
function fromConvention(file) {
  const base = String(file || '').normalize('NFC').replace(/\.pdf$/i, '').replace(/^.*[\\/]/, '');
  const p = base.split('__').map(x => x.trim());
  if (p.length < 4 || !/^\d+$/.test(p[2])) return null;
  const cat = p[4] && CAT_ORDER.find(c => norm(c) === norm(p[4]));
  return { brand: p[0], group: p[1], order: +p[2], name: p[3], cat: cat || undefined };
}
function fromCatalog(file) {
  const conv = fromConvention(file); if (conv) return conv;
  for (const [re, name, group, order, cat, brand] of CATALOG) if (re.test(file)) return { name, group, order, cat, brand };
  return null;
}

// ---------------------------------------------------------------------
//  Guardar um PDF no aparelho (vindo da nuvem ou enviado pelo admin)
// ---------------------------------------------------------------------
async function addPdfBlob(blob, meta) {
  const buf = await blob.arrayBuffer();
  const stored = new Blob([buf], { type: 'application/pdf' }); // cópia antes do pdf.js "consumir" o buffer
  const task = pdfjsLib.getDocument({ data: new Uint8Array(buf), ...PDF_OPTS });
  const pdf = await task.promise;
  const outline = await readOutline(pdf);
  const pages = pdf.numPages;
  await task.destroy();
  const known = fromCatalog(meta.file || '') || {};
  const doc = {
    id: uid(), rid: meta.rid || null, sha: meta.sha || null,
    name: meta.name || known.name || (meta.file || 'Manual').replace(/\.pdf$/i, '').replace(/_+/g, ' ').trim(),
    file: meta.file || '', group: meta.group ?? known.group ?? '', order: meta.order ?? known.order, cat: meta.cat ?? known.cat,
    brand: meta.brand ?? known.brand ?? null,
    size: blob.size, pages, added: Date.now(), opened: 0, lastPage: 1, outline, favs: [], catFix: {},
    textDone: false, textProgress: 0,
  };
  await dbPut('files', stored, doc.id);
  await saveDoc(doc);
  S.docs.push(doc);
  return doc;
}
async function removeLocalDoc(d) {
  S.docs = S.docs.filter(x => x.id !== d.id); S.texts.delete(d.id);
  const p = pdfCache.get(d.id); pdfCache.delete(d.id); p?.then(x => x._task.destroy()).catch(() => {});
  await dbDel('docs', d.id); await dbDel('files', d.id); await dbDel('text', d.id);
}

// ---------------------------------------------------------------------
//  Acesso por código
// ---------------------------------------------------------------------
const LS_AUTH = 'manuais.auth', LS_DEV = 'manuais.dev';
const OFFLINE_DAYS = 30; // sem conferir o acesso por mais que isso, o app trava até ter internet
const lsGet = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let AUTH = lsGet(LS_AUTH, {});
function deviceId() {
  let d = lsGet(LS_DEV);
  if (!d) { d = 'd' + uid().replace(/-/g, ''); lsSet(LS_DEV, d); }
  return d;
}
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (AUTH.token) headers.authorization = 'Bearer ' + AUTH.token;
  let body = opts.body;
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
  const r = await fetch('api/' + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, cache: 'no-store', signal: opts.signal });
  if (opts.raw && r.ok) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Erro ' + r.status); e.status = r.status; e.data = data; throw e; }
  return data;
}

// baixa um pedaço de manual, tentando de novo se a conexão cair no meio
async function fetchPart(rid, sha, i) {
  let last;
  for (let t = 0; t < 3; t++) {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 90000); // 90 s por pedaço
    try { const res = await api(`file/${rid}/${sha}/${i}`, { raw: true, signal: ac.signal }); return await res.blob(); }
    catch (e) { last = e.name === 'AbortError' ? Object.assign(new Error('demorou demais (sinal fraco?)'), {}) : e; if (e.status && e.status < 500) break; await sleep(1200 * (t + 1)); }
    finally { clearTimeout(timer); }
  }
  throw last;
}
const errTxt = e => e?.status ? `${e.message} (erro ${e.status})` : `conexão interrompida${e?.message ? ' — ' + e.message : ''}`;

function showLogin(msg, isError) {
  show('login');
  $('#loginMsg').textContent = msg || 'Digite o código de acesso que você recebeu.';
  $('#loginErr').hidden = true;
  if (isError) { $('#loginErr').textContent = msg; $('#loginErr').hidden = false; $('#loginMsg').textContent = 'Digite o código de acesso que você recebeu.'; }
}
$('#loginCode').addEventListener('keydown', e => e.key === 'Enter' && $('#loginBtn').click());
// acha o código no meio de qualquer texto (ex.: a mensagem inteira do WhatsApp)
function findCode(t) {
  const m = String(t || '').toUpperCase().match(/AND[\s\-_]*SL[\s\-_]*([A-Z0-9]{6})\b/) || String(t || '').toUpperCase().match(/\bMHC[\s\-_]*([A-Z0-9]{6})\b/);
  if (!m) return null;
  return m[0].startsWith('AND') ? 'AND-SL-' + m[1] : 'MHC-' + m[1];
}
$('#loginCode').addEventListener('paste', e => {
  const t = e.clipboardData?.getData('text'); const c = findCode(t);
  if (c) { e.preventDefault(); $('#loginCode').value = c; }
});
// olhinho: mostra / esconde o código
$('#eyeBtn').onclick = () => {
  const i = $('#loginCode'), show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  $('#eyeBtn').classList.toggle('on', show); $('#eyeBtn').textContent = show ? '🙈' : '👁';
};
const maskCode = p => p.replace(/[A-Z0-9]{6}$/, '••••••');
function codeView(pretty) {
  const box = el('div', { class: 'bigcode' }, maskCode(pretty));
  const eye = el('button', { class: 'eye', type: 'button', 'aria-label': 'Mostrar código', onclick: () => {
    const show = box.textContent !== pretty;
    box.textContent = show ? pretty : maskCode(pretty); eye.textContent = show ? '🙈' : '👁'; eye.classList.toggle('on', show);
  } }, '👁');
  return el('div', { class: 'bigwrap' }, box, eye);
}
$('#pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    const c = findCode(t) || t.trim().slice(0, 20);
    if (!c) throw 0;
    $('#loginCode').value = c;
    if (findCode(t)) $('#loginBtn').click();
  } catch { $('#loginCode').focus(); toast('Segure o dedo no campo e toque em Colar'); }
};
// código vindo pelo link do convite (…/#codigo=AND-SL-XXXXXX)
(() => {
  const m = location.hash.match(/codigo=([^&]+)/i);
  if (m) { const c = findCode(decodeURIComponent(m[1])); if (c) lsSet('manuais.pending', c); history.replaceState(null, '', location.pathname); }
  const p = lsGet('manuais.pending'); if (p) $('#loginCode').value = p;
})();
$('#loginBtn').onclick = async () => {
  const code = $('#loginCode').value.trim();
  if (!code) return;
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'Conferindo…'; $('#loginErr').hidden = true;
  try {
    const r = await api('login', { json: { code, deviceId: deviceId() } });
    AUTH = { token: r.token, name: r.name, admin: r.admin, issued: Date.now(), lastOk: Date.now() };
    lsSet(LS_AUTH, AUTH); lsSet('manuais.pending', null);
    $('#loginCode').value = '';
    await startApp();
    sync(true);
  } catch (e) {
    $('#loginErr').textContent = e.status ? e.message : 'Sem conexão com a internet. Tente de novo com sinal.';
    $('#loginErr').hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
};

// O app do administrador monta o sumário automático dos PDFs sem sumário e
// manda para a nuvem, para quem abre pela nuvem também ter.
let pushing = false;
async function pushAutos() {
  if (!AUTH.admin || pushing) return; pushing = true;
  try {
    for (const d of S.docs.filter(d => d.rid && d.textDone && !d.outline?.length && d.auto?.length && d.autoUp !== d.sha)) {
      try { await api('admin/auto', { json: { rid: d.rid, sha: d.sha, auto: d.auto } }); d.autoUp = d.sha; await saveDoc(d); }
      catch (e) { if (!e.status) break; }
    }
  } finally { pushing = false; }
}

async function wipeAll(reason) {
  closeViewer(true);
  for (const d of [...S.docs]) await removeLocalDoc(d).catch(() => {});
  S.docs = []; S.texts.clear();
  AUTH = {}; lsSet(LS_AUTH, null); lsSet('manuais.sel', null); lsSet('manuais.remote', null); lsSet('manuais.cloudmeta', null); try { SEL = null; } catch {}
  S.cloud = []; S.cloudBlobs.clear();
  showLogin(reason, true);
}

// confere se o acesso continua válido (quando tem internet)
async function checkAccess() {
  try {
    const r = await api('me');
    AUTH.lastOk = Date.now(); AUTH.admin = r.admin; AUTH.name = r.name; AUTH.storage = r.storage; lsSet(LS_AUTH, AUTH);
    $('#btnAdmin').hidden = !AUTH.admin;
    return true;
  } catch (e) {
    if (e.status === 403 && e.data?.revoked && Date.now() - (AUTH.issued || 0) > 5 * 60000) {
      await wipeAll('Seu acesso foi encerrado. Os manuais foram removidos deste aparelho. Fale com o responsável.');
      return false;
    }
    if (e.status === 401) { await wipeAll('Seu acesso precisa ser refeito. Digite o código novamente.'); return false; }
    // sem internet: tudo bem, a não ser que esteja há muito tempo sem conferir
    if (!e.status && Date.now() - (AUTH.lastOk || 0) > OFFLINE_DAYS * 86400000) {
      showLogin(`Faz mais de ${OFFLINE_DAYS} dias que o app não confere seu acesso. Conecte à internet e abra o app de novo.`);
      $('#loginCode').value = ''; return false;
    }
    return !e.status;
  }
}

// ---------------------------------------------------------------------
//  Sincronizar os manuais com a nuvem
// ---------------------------------------------------------------------
const PART = 20 * 1024 * 1024;
let syncing = false;
function syncBar(text, frac) {
  const b = $('#syncBar');
  if (text == null) { b.hidden = true; return; }
  b.hidden = false; $('#syncText').textContent = text;
  $('#syncFill').style.width = Math.round((frac || 0) * 100) + '%';
}
async function sync(manual) {
  if (syncing || !AUTH.token) return; syncing = true;
  try {
    if (!(await checkAccess())) return;
    let remote;
    try { remote = (await api('docs')).docs; }
    catch (e) { if (manual) toast(e.status ? e.message : 'Sem internet — usando os manuais já baixados.'); return; }
    lastRemote = remote;
    navigator.storage?.persist?.().catch(() => {});
    const byRid = new Map(S.docs.filter(d => d.rid).map(d => [d.rid, d]));
    // removidos da nuvem → sai do aparelho
    for (const d of S.docs.filter(d => d.rid && !remote.some(r => r.rid === d.rid))) await removeLocalDoc(d);
    // nome/grupo mudou → só atualiza
    for (const r of remote) {
      const d = byRid.get(r.rid);
      if (d && d.sha === r.sha && (d.name !== r.name || d.group !== r.group || d.order !== r.order || d.cat !== r.cat || (d.brand || null) !== (r.brand || null))) {
        Object.assign(d, { name: r.name, group: r.group, order: r.order, cat: r.cat, brand: r.brand || null, _cats: null }); await saveDoc(d);
      }
    }
    // desmarcados → saem do celular
    if (SEL) for (const d of S.docs.filter(d => d.rid && remote.some(r => r.rid === d.rid && !wanted(r)))) await removeLocalDoc(d);
    // primeira vez: pede para escolher
    if (!SEL && !AUTH.admin) { if ($('#home').classList.contains('active')) go({ s: 'pick' }); return; }
    const todo = remote.filter(r => wanted(r) && byRid.get(r.rid)?.sha !== r.sha).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const novos = remote.filter(r => !wanted(r) && !SEL?.off?.includes(r.rid) && !S.docs.some(d => d.rid === r.rid));
    S.cloudOnly = novos.length;
    if (!todo.length) { if (manual) toast('Manuais em dia ✔'); return; }
    const total = todo.reduce((a, r) => a + r.size, 0); let done = 0;
    for (let k = 0; k < todo.length; k++) {
      const r = todo[k];
      const chunks = [];
      for (let i = 0; i < r.parts; i++) {
        syncBar(`Baixando manuais ${k + 1} de ${todo.length} · ${fmtMB(done)} de ${fmtMB(total)}`, done / total);
        const b = await fetchPart(r.rid, r.sha, i); chunks.push(b); done += b.size;
      }
      syncBar(`Preparando ${r.name}…`, done / total);
      const old = byRid.get(r.rid);
      const doc = await addPdfBlob(new Blob(chunks, { type: 'application/pdf' }), r);
      if (old) { doc.favs = old.favs; doc.lastPage = old.lastPage; doc.opened = old.opened; await saveDoc(doc); await removeLocalDoc(old); }
      renderHome(true);
    }
    toast(todo.length === 1 ? 'Manual atualizado' : `${todo.length} manuais baixados`);
  } catch (e) {
    console.error('sync', e);
    toast('Download interrompido: ' + errTxt(e) + '. Toque em ⟳ para continuar.', 7000);
  } finally {
    syncing = false; syncBar(null);
    refreshCloud(lastRemote);
    pushAutos();
    if ($('#home').classList.contains('active')) renderHome(true);
    indexQueue();
  }
}
$('#btnSync').onclick = () => sync(true);

// ---------------------------------------------------------------------
//  Manuais "só na nuvem": aparecem com ☁ e abrem pela internet, sem
//  ocupar espaço no celular.
// ---------------------------------------------------------------------
let lastRemote = null;
const LS_REMOTE = 'manuais.remote';
const showCloud = () => lsGet('manuais.showcloud', true);
function refreshCloud(remote) {
  if (remote) lsSet(LS_REMOTE, remote.map(({ rid, sha, parts, name, file, group, order, cat, brand, size, pages, ha }) => ({ rid, sha, parts, name, file, group, order, cat, brand, size, pages, ha })));
  const rem = remote || lsGet(LS_REMOTE, []) || [];
  const meta = lsGet('manuais.cloudmeta', {}) || {};
  S.cloud = rem.filter(r => !S.docs.some(d => d.rid === r.rid)).map(r => {
    const old = S.cloud.find(c => c.rid === r.rid && c.sha === r.sha);
    if (old) return Object.assign(old, { name: r.name, group: r.group || '', order: r.order, cat: r.cat, brand: r.brand || null, ha: r.ha, _cats: null });
    const m = meta[r.rid] || {};
    return { id: 'c:' + r.rid, rid: r.rid, sha: r.sha, parts: r.parts, cloud: true, ha: r.ha, name: r.name, file: r.file, group: r.group || '', order: r.order, cat: r.cat,
      brand: r.brand || null, size: r.size, pages: r.pages, outline: null, auto: null, favs: m.favs || [], lastPage: m.lastPage || 1, opened: m.opened || 0,
      catFix: {}, textDone: true, textProgress: 1 };
  });
}
async function openCloud(d, then) {
  if (!S.cloudBlobs.has(d.id)) {
    const chunks = []; let got = 0;
    try {
      for (let i = 0; i < d.parts; i++) {
        toast(`☁ Abrindo da nuvem… ${Math.round((got / (d.size || 1)) * 100)}%`, 0);
        const b = await fetchPart(d.rid, d.sha, i); chunks.push(b); got += b.size;
      }
    } catch (e) {
      console.error('nuvem', e);
      openSheet(el('div', {}, el('h4', {}, 'Não deu para abrir pela nuvem'),
        el('p', { class: 'muted' }, `${d.name} (${fmtMB(d.size)})`),
        el('div', { class: 'note' }, 'Motivo: ' + errTxt(e)),
        el('div', { class: 'acts' }, el('button', { class: 'ok', onclick: () => { closeSheet(); openCloud(d, then); } }, 'Tentar de novo'), el('button', { onclick: closeSheet }, 'Fechar'))));
      $('#toast').hidden = true; return;
    }
    // guarda na memória no máximo 2 manuais da nuvem
    while (S.cloudBlobs.size >= 2) {
      const k = S.cloudBlobs.keys().next().value; S.cloudBlobs.delete(k);
      const p = pdfCache.get(k); pdfCache.delete(k); p?.then(x => x._task.destroy()).catch(() => {});
    }
    S.cloudBlobs.set(d.id, new Blob(chunks, { type: 'application/pdf' }));
    $('#toast').hidden = true;
  }
  if (!d.outline) {
    try { const pdf = await getPdf(d.id); d.outline = await readOutline(pdf); d.pages = pdf.numPages; d._cats = d._flat = null; }
    catch { d.outline = []; }
  }
  // sem sumário próprio: usa o sumário automático que o administrador mandou para a nuvem
  if (!d.outline?.length && !d.auto && d.ha === d.sha) {
    try { d.auto = (await api(`auto/${d.rid}/${d.sha}`)).auto; d._cats = d._flat = null; } catch {}
  }
  then();
}
function setLocal(d, keep) {
  // keep=true: baixar este manual · keep=false: tirar do celular (continua na nuvem)
  const r = { rid: d.rid, brand: d.brand, group: d.group };
  if (!SEL) SEL = AUTH.admin ? { machines: [...new Set((lsGet(LS_REMOTE, []) || []).map(mkey))], docs: [], off: [] } : { machines: [], docs: [], off: [] };
  const k = mkey(r);
  if (keep) { SEL.off = SEL.off.filter(x => x !== d.rid); if (!SEL.machines.includes(k) && !SEL.docs.includes(d.rid)) SEL.docs.push(d.rid); }
  else { SEL.docs = SEL.docs.filter(x => x !== d.rid); if (SEL.machines.includes(k) && !SEL.off.includes(d.rid)) SEL.off.push(d.rid); }
  lsSet(LS_SEL, SEL);
}
window.addEventListener('online', () => sync());

// ---------------------------------------------------------------------
//  Indexação do texto (para a busca) — roda em segundo plano, uma vez
// ---------------------------------------------------------------------
let indexing = false;
async function indexQueue() {
  if (indexing) return; indexing = true;
  try {
    for (;;) {
      const d = S.docs.find(d => !d.textDone && !d.textFail);
      if (!d) break;
      await indexDoc(d);
    }
  } finally { indexing = false; S.ixId = null; }
}

async function indexDoc(d) {
  S.ixId = d.id;
  try {
    const pdf = await getPdf(d.id);
    let rec = (await dbGet('text', d.id)) || { pages: [], heads: [] };
    for (let p = rec.pages.length + 1; p <= pdf.numPages; p++) {
      if (!docById(d.id)) return; // foi excluído
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let s = '';
      const lines = new Map();
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        s += it.str + (it.hasEOL ? ' ' : '');
        const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 2) / 2;
        const y = Math.round(it.transform[5]);
        const L = lines.get(y) || { t: '', s: 0 };
        L.t += it.str; L.s = Math.max(L.s, size); lines.set(y, L);
      }
      rec.pages.push(s.replace(/\s+/g, ' ').trim());
      // título da página (para PDFs sem sumário)
      const pc = pageCands([...lines.entries()].map(([y, L]) => ({ y, t: L.t.replace(/\s+/g, ' ').trim(), s: L.s })).filter(l => l.t), page.view[3] - page.view[1]);
      if (pc.c.length) rec.heads.push({ p, ...pc });
      page.cleanup();
      if (p % 25 === 0 || p === pdf.numPages) {
        d.textProgress = p / pdf.numPages;
        await dbPut('text', rec, d.id);
        updateProgress(d);
      }
      if (p % 3 === 0) await sleep(0);
    }
    // texto pronto
    const chars = rec.pages.reduce((a, s) => a + s.length, 0);
    d.scanned = chars < d.pages * 20; // praticamente sem texto = PDF escaneado
    if (!d.outline?.length) d.auto = autoOutline(rec);
    delete rec.heads;
    await dbPut('text', rec, d.id);
    d.textDone = true; d.textProgress = 1; d._cats = d._flat = null;
    await saveDoc(d);
    pushAutos();
    S.texts.delete(d.id);
    renderAfterIndex(d);
  } catch (err) {
    console.error('indexação', err);
    d.textFail = String(err.message || err);
    await saveDoc(d).catch(() => {});
  }
}

// Candidatos a título de cada página (linhas do alto da página). Funciona
// com slides do PowerPoint (título em cima, número do slide, anotações
// embaixo) e com páginas comuns. A escolha final é feita em autoOutline,
// depois de descartar cabeçalhos/rodapés que se repetem.
function pageCands(lines, h) {
  lines.sort((a, b) => b.y - a.y);
  const num = lines.find(l => /^\d{1,3}$/.test(l.t) && l.s <= 10 && l.y > h * 0.35 && l.y < h * 0.75);
  let region = num ? lines.filter(l => l.y > num.y + 2) : lines.filter(l => l.y > h * 0.6);
  region = region.filter(l => !/^\d{1,3}$/.test(l.t) && /[a-zA-ZÀ-ú]{2}/.test(l.t)).slice(0, 10);
  const sizes = lines.map(l => l.s).sort((a, b) => a - b), m = sizes[Math.floor(sizes.length / 2)] || 10;
  return { c: region.map(l => ({ t: l.t.slice(0, 120), s: l.s, y: l.y })), m, sl: !!num };
}
// chave para achar linhas repetidas (ignora ordem das palavras e números de página)
const hkey = t => norm(t).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !/^[a-z]?\d{1,4}[a-z]?$/.test(w)).sort().join(' ');
const isUpper = t => { const L = t.replace(/[^A-Za-zÀ-ú]/g, ''); return L.length >= 4 && L === L.toUpperCase(); };
function pickTitle(pc, bad) {
  const region = pc.c.filter(l => !bad.has(hkey(l.t)));
  if (!region.length) return null;
  const max = Math.max(...region.map(l => l.s));
  let first, upperMode = false;
  if (pc.sl || (max >= pc.m * 1.25 && max >= 12 && region[0].s === max)) first = region.findIndex(l => l.s === max);
  else { first = region.slice(0, 3).findIndex(l => isUpper(l.t) && l.t.length <= 70); upperMode = true; if (first < 0) return null; }
  const parts = [region[first]];
  for (let i = first + 1; i < region.length && parts.length < 3; i++) {
    const l = region[i], prev = parts[parts.length - 1];
    if (l.s === parts[0].s && prev.y - l.y < parts[0].s * 1.8 && (!upperMode || isUpper(l.t))) parts.push(l); else break;
  }
  const t = parts.map(l => l.t).join(' ').replace(/\s+/g, ' ').trim();
  return t.length >= 3 && t.length <= 90 && /^[A-ZÀ-Ý0-9"“(]/.test(t) && !/[.:;]$/.test(t) ? t : null;
}

function autoOutline(rec) {
  const heads = rec.heads || [];
  // esquemas EPLAN sem marcadores: o "título" seria o carimbo do desenho — melhor sem sumário
  if (rec.pages.filter(t => /ePLAN|EPLAN/.test(t)).length > rec.pages.length * 0.3) return [];
  // linhas que aparecem em muitas páginas = cabeçalho/rodapé
  const freqL = {};
  for (const h of heads) if (h.c) for (const k of new Set(h.c.map(l => hkey(l.t)))) freqL[k] = (freqL[k] || 0) + 1;
  const limL = Math.max(5, heads.length * 0.03);
  const bad = new Set(Object.keys(freqL).filter(k => freqL[k] > limL));
  const titles = heads.map(h => ({ p: h.p, t: h.c ? pickTitle(h, bad) : h.t })).filter(x => x.t);
  const base = t => norm(t).replace(/[,;.\s]*\(?(cont\.?|continua..o|continued)\)?\s*$/i, '').trim();
  const freq = {};
  for (const h of titles) freq[base(h.t)] = (freq[base(h.t)] || 0) + 1;
  const lim = 4; // título repetido em mais de 4 páginas = capa/cabeçalho, não capítulo
  const out = []; let last = null;
  for (const h of titles) {
    const b = base(h.t);
    if (freq[b] > lim) continue;
    if (b === last) continue; // "..., cont." = continuação do mesmo assunto
    last = b;
    out.push({ id: 'a' + out.length, t: h.t.replace(/[,;\s]*\(?cont\.?\)?\s*$/i, ''), p: h.p });
  }
  return out.slice(0, 3000);
}

function updateProgress(d) {
  const b = document.querySelector(`[data-prog="${d.id}"]`);
  if (b) b.style.width = Math.round(d.textProgress * 100) + '%';
  const t = document.querySelector(`[data-progtxt="${d.id}"]`);
  if (t) t.textContent = `Preparando busca… ${Math.round(d.textProgress * 100)}%`;
}
function renderAfterIndex(d) {
  if ($('#home').classList.contains('active')) renderHome(true);
  if ($('#manual').classList.contains('active') && S.cur?.id === d.id) renderManual(true);
}

async function loadTexts(ids) {
  for (const id of ids) {
    if (S.texts.has(id)) continue;
    const rec = await dbGet('text', id);
    if (rec?.pages) S.texts.set(id, { raw: rec.pages, norm: rec.pages.map(norm) });
  }
}

// ---------------------------------------------------------------------
//  Busca
// ---------------------------------------------------------------------
async function search(q, onlyId) {
  const ts = terms(q); if (!ts.length) return { topics: [], pages: [] };
  const docs = onlyId ? [docById(onlyId)] : visDocs();
  const phrase = norm(q.trim()).replace(/\s+/g, ' ');
  const topics = [];
  for (const d of docs) {
    for (const f of flatOutline(d)) {
      const n = norm(f.n.t);
      if (ts.every(t => n.includes(t))) topics.push({ d, f, score: n.includes(phrase) ? 2 : 1 });
    }
    for (const fav of d.favs) {
      const n = norm(fav.t);
      if (ts.every(t => n.includes(t))) topics.push({ d, f: { n: { t: fav.t, p: fav.p }, path: ['⭐ ' + fav.t] }, score: 3 });
    }
  }
  topics.sort((a, b) => b.score - a.score);
  await loadTexts(docs.filter(d => d.textProgress > 0).map(d => d.id));
  const pages = [];
  for (const d of docs) {
    const tx = S.texts.get(d.id); if (!tx) continue;
    tx.norm.forEach((n, i) => {
      if (!ts.every(t => n.includes(t))) return;
      const pi = n.indexOf(phrase);
      let count = 0; for (const t of ts) { let k = -1; while ((k = n.indexOf(t, k + 1)) !== -1 && count < 50) count++; }
      const toc = (tx.raw[i].match(/[.…]{6,}/g) || []).length >= 5; // página de índice vai pro fim
      pages.push({ d, p: i + 1, score: (pi >= 0 ? 1000 : 0) + count - (toc ? 5000 : 0), at: pi >= 0 ? pi : n.indexOf(ts[0]), raw: tx.raw[i], norm: n });
    });
  }
  pages.sort((a, b) => b.score - a.score);
  return { topics, pages, ts: phrase.includes(' ') ? [...ts, phrase] : ts };
}

function snippet(r, ts) {
  const a = Math.max(0, r.at - 50), b = Math.min(r.raw.length, r.at + 110);
  const raw = r.raw.slice(a, b), n = r.norm.slice(a, b);
  const marks = new Array(raw.length).fill(false);
  for (const t of ts) { let k = -1; while ((k = n.indexOf(t, k + 1)) !== -1) for (let j = k; j < k + t.length; j++) marks[j] = true; }
  let out = a > 0 ? '…' : '', open = false;
  for (let i = 0; i < raw.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(raw[i]);
  }
  if (open) out += '</mark>';
  return out + (b < r.raw.length ? '…' : '');
}
function hlTitle(t, ts) {
  const n = norm(t); const marks = new Array(t.length).fill(false);
  for (const x of ts) { let k = -1; while ((k = n.indexOf(x, k + 1)) !== -1) for (let j = k; j < k + x.length; j++) marks[j] = true; }
  let out = '', open = false;
  for (let i = 0; i < t.length; i++) {
    if (marks[i] && !open) { out += '<mark>'; open = true; }
    if (!marks[i] && open) { out += '</mark>'; open = false; }
    out += esc(t[i]);
  }
  return out + (open ? '</mark>' : '');
}

async function renderSearch(box, q, onlyId) {
  const token = (box._tok = (box._tok || 0) + 1);
  const res = await search(q, onlyId);
  if (box._tok !== token) return; // usuário digitou de novo
  box.innerHTML = '';
  const { topics, pages, ts } = res;
  const pending = (onlyId ? [docById(onlyId)] : visDocs()).filter(d => !d.textDone);
  if (!onlyId && S.brand !== 'Todas') box.prepend(el('div', { class: 'muted small', style: 'margin:6px 2px' }, `Buscando só em ${S.brand}. Para buscar em tudo, toque em “Todas” lá em cima.`));
  if (topics.length) {
    box.append(el('h3', { class: 'sec' }, `Tópicos do sumário (${topics.length})`));
    for (const { d, f } of topics.slice(0, 60)) {
      box.append(el('button', { class: 'row', onclick: () => openViewer(d.id, f.n.p || 1, q) },
        el('div', { class: 'main' },
          el('div', { class: 't', html: hlTitle(f.n.t, ts) }),
          el('div', { class: 's' }, (onlyId ? '' : d.name + ' · ') + f.path.slice(0, -1).join(' › '))),
        el('div', { class: 'pg' }, f.n.p ? 'p. ' + f.n.p : '')));
    }
  }
  if (pages.length) {
    box.append(el('h3', { class: 'sec' }, `Dentro das páginas (${pages.length})`));
    let shown = 0;
    const more = el('button', { class: 'row', style: 'justify-content:center;font-weight:600' }, 'Mostrar mais resultados');
    const addSome = () => {
      for (const r of pages.slice(shown, shown + 40)) {
        const tp = topicAt(r.d, r.p);
        more.before(el('button', { class: 'row', onclick: () => openViewer(r.d.id, r.p, q) },
          el('div', { class: 'main' },
            el('div', { class: 't' }, (onlyId ? '' : r.d.name + ' · ') + 'página ' + r.p),
            tp ? el('div', { class: 's' }, tp.path.join(' › ')) : null,
            el('div', { class: 'snip', html: snippet(r, ts) }))));
      }
      shown += 40; more.hidden = shown >= pages.length;
    };
    box.append(more); more.onclick = addSome; addSome();
  }
  const cl = onlyId ? [] : S.cloud.filter(inBrand).filter(d => ts.every(t => norm(d.name + ' ' + d.group).includes(t)));
  if (cl.length) {
    box.append(el('h3', { class: 'sec' }, `Na nuvem (${cl.length}) — abre com internet`));
    for (const d of cl) box.append(el('button', { class: 'row', onclick: () => openCloud(d, () => go({ s: 'manual', id: d.id })) },
      el('div', { class: 'main' }, el('div', { class: 't' }, '☁ ' + d.name), el('div', { class: 's' }, `${d.brand ? d.brand + ' · ' : ''}${d.group} · ${fmtMB(d.size)}`)), el('div', { class: 'pg' }, '›')));
  }
  if (!topics.length && !pages.length && !cl.length) {
    box.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🔎'), `Nada encontrado para “${q}”.`));
  }
  if (pending.length) box.append(el('div', { class: 'note' }, `Ainda preparando a busca dentro do texto de: ${pending.map(d => d.name).join(', ')}. Os resultados vão aparecer quando terminar.`));
  const scanned = (onlyId ? [docById(onlyId)] : visDocs()).filter(d => d.scanned);
  if (scanned.length) box.append(el('div', { class: 'note' }, `Sem texto pesquisável (PDF escaneado): ${scanned.map(d => d.name).join(', ')}. Neles a busca só encontra o sumário e as páginas salvas.`));
}

// ---------------------------------------------------------------------
//  Navegação (o botão voltar do Android funciona)
// ---------------------------------------------------------------------
function show(id) {
  const prev = document.querySelector('.screen.active');
  if (prev) S.scroll[prev.id] = prev.querySelector('.body')?.scrollTop || 0;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  updateTabs(id);
}
function go(state) { history.pushState(state, ''); route(state); }
async function route(st) {
  st ||= { s: 'home' };
  closeSheet();
  if (!AUTH.token) return showLogin();
  if (st.s === 'home') { closeViewer(); show('home'); renderHome(); restoreScroll('home', '#homeBody'); }
  else if (st.s === 'manual') {
    closeViewer();
    const d = docById(st.id); if (!d) return route({ s: 'home' });
    const same = S.cur?.id === d.id; S.cur = d;
    if (!same) { S.mq = ''; $('#manualSearch').value = ''; S.scroll.manual = 0; }
    show('manual'); renderManual(); restoreScroll('manual', '#manualBody');
  } else if (st.s === 'viewer') { show('viewer'); await startViewer(st); }
  else if (st.s === 'admin') { closeViewer(); show('admin'); renderAdmin(); }
  else if (st.s === 'pick') { closeViewer(); show('pick'); renderPick(); }
  else if (st.s === 'conv') { closeViewer(); show('conv'); renderConv(); }
  else if (st.s === 'check') { closeViewer(); show('check'); renderCheck(); }
  else if (st.s === 'checkrun') { closeViewer(); show('checkrun'); renderCheckRun(st); }
}
function restoreScroll(scr, sel) { const y = S.scroll[scr] || 0; requestAnimationFrame(() => ($(sel).scrollTop = y)); }
window.addEventListener('popstate', e => route(e.state));
document.querySelectorAll('[data-back]').forEach(b => (b.onclick = () => history.back()));

// ---------------------------------------------------------------------
//  Tela inicial
// ---------------------------------------------------------------------
let searchT;
$('#search').addEventListener('input', e => {
  S.q = e.target.value; $('#searchClear').hidden = !S.q;
  clearTimeout(searchT); searchT = setTimeout(() => renderHome(), 220);
});
$('#searchClear').onclick = () => { $('#search').value = S.q = ''; $('#searchClear').hidden = true; renderHome(); };
$('#search').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

function renderBrands() {
  const brands = [...new Set([...S.docs, ...(showCloud() ? S.cloud : [])].map(brandOf))].sort((a, b) => (a === 'Outros') - (b === 'Outros') || a.localeCompare(b, 'pt'));
  const box = $('#brands'); box.innerHTML = '';
  if (brands.length < 2) { box.hidden = true; S.brand = 'Todas'; return; }
  if (S.brand !== 'Todas' && !brands.includes(S.brand)) S.brand = 'Todas';
  box.hidden = false;
  for (const b of ['Todas', ...brands]) box.append(el('button', { class: 'brand' + (b === S.brand ? ' on' : ''), onclick: () => {
    S.brand = b; try { localStorage.setItem('manuais.brand', b); } catch {}
    S.cat = 'Todos'; renderHome(); $('#homeBody').scrollTop = 0;
  } }, b));
}
function renderChips() {
  renderBrands();
  const have = new Set();
  for (const d of visDocs()) for (const c of docCats(d).values()) have.add(c);
  const list = ['Todos', ...CAT_ORDER.filter(c => have.has(c))];
  if (!list.includes(S.cat)) S.cat = 'Todos';
  const box = $('#chips'); box.innerHTML = '';
  box.hidden = visDocs().length === 0;
  for (const c of list) box.append(el('button', { class: 'chip' + (c === S.cat ? ' on' : ''), onclick: () => { S.cat = c; S.scroll.home = 0; renderHome(); $('#homeBody').scrollTop = 0; } }, c));
}

function renderHome(keepScroll) {
  const y = $('#homeBody').scrollTop;
  renderChips();
  const box = $('#homeBody'); box.innerHTML = '';
  const cloudVis = showCloud() ? S.cloud.filter(inBrand) : [];
  if (!visDocs().length && !cloudVis.length) {
    box.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '📚'),
      AUTH.admin
        ? el('p', { html: 'Nenhum manual na nuvem ainda.<br>Toque em <b>Painel</b> → <b>Enviar PDFs</b> para publicar os manuais para a equipe.' })
        : el('div', {}, el('p', { html: 'Nenhum manual neste celular ainda.<br>Escolha as máquinas que você atende — só elas serão baixadas.<br><br>Depois de baixados, funcionam <b>sem internet</b>.' }),
            el('button', { class: 'btn-accent big', onclick: () => go({ s: 'pick' }) }, '📥 Escolher manuais'))));
    return;
  }
  if (S.q.trim()) { renderSearch(box, S.q); return; }
  if (S.cat !== 'Todos') { renderCategory(box, S.cat); if (keepScroll) box.scrollTop = y; return; }

  // Continuar lendo
  const recent = visDocs().filter(d => d.opened).sort((a, b) => b.opened - a.opened).slice(0, 3);
  if (recent.length) {
    box.append(el('h3', { class: 'sec' }, 'Continuar de onde parou'));
    for (const d of recent) {
      const tp = topicAt(d, d.lastPage);
      box.append(el('button', { class: 'row', onclick: () => openViewer(d.id, d.lastPage) },
        el('div', { class: 'main' }, el('div', { class: 't' }, d.name), el('div', { class: 's' }, (tp ? tp.n.t + ' · ' : '') + 'página ' + d.lastPage)),
        el('div', { class: 'pg' }, '›')));
    }
  }
  // Favoritos
  const favs = visDocs().flatMap(d => d.favs.map(f => ({ d, f })));
  if (favs.length) {
    box.append(el('h3', { class: 'sec' }, 'Favoritos'));
    for (const { d, f } of favs.sort((a, b) => (b.f.at || 0) - (a.f.at || 0)).slice(0, 12))
      box.append(el('button', { class: 'row', onclick: () => openViewer(d.id, f.p) },
        el('div', { class: 'main' }, el('div', { class: 't' }, '⭐ ' + f.t), el('div', { class: 's' }, d.name)),
        el('div', { class: 'pg' }, 'p. ' + f.p)));
  }
  // Manuais por grupo
  const groups = new Map();
  const multi = new Set([...S.docs, ...S.cloud].map(brandOf)).size > 1 && S.brand === 'Todas';
  for (const d of [...visDocs(), ...cloudVis].sort(byBrandOrder)) {
    const g = (multi ? brandOf(d) + ' · ' : '') + (d.group || ''); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d);
  }
  const gOrd = g => Math.min(...groups.get(g).map(d => d.order ?? 999));
  const gBr = g => brandOf(groups.get(g)[0]);
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || gBr(a).localeCompare(gBr(b), 'pt') || gOrd(a) - gOrd(b) || a.localeCompare(b, 'pt'));
  for (const g of names) {
    box.append(el('h3', { class: 'sec' }, g || (names.length > 1 ? 'Outros' : 'Manuais')));
    const grid = el('div', { class: 'grid' });
    for (const d of groups.get(g)) grid.append(docCard(d));
    box.append(grid);
  }
  footer(box);
  if (keepScroll) box.scrollTop = y;
}

function byBrandOrder(a, b) { return brandOf(a).localeCompare(brandOf(b), 'pt') || byOrder(a, b); }
function byOrder(a, b) { return (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'pt', { numeric: true }); }
function docCard(d) {
  if (d.cloud) return el('div', { class: 'card cloudcard', role: 'button', onclick: () => openCloud(d, () => go({ s: 'manual', id: d.id })) },
    el('div', { class: 'name' }, d.name),
    el('div', { class: 'meta' }, `☁ na nuvem · ${fmtMB(d.size)}${d.pages ? ' · ' + d.pages + ' pág.' : ''}`));
  const meta = `${d.pages} pág.` + (d.outline?.length ? '' : d.auto?.length ? ' · sumário auto' : ' · sem sumário');
  return el('div', { class: 'card', role: 'button', onclick: e => { if (!e.target.closest('.more')) go({ s: 'manual', id: d.id }); } },
    AUTH.admin ? el('button', { class: 'more', 'aria-label': 'Opções', onclick: () => editDocSheet(d) }, '⋯') : null,
    el('div', { class: 'name' }, d.name),
    !d.textDone && !d.textFail ? el('div', { class: 'bar' }, el('i', { 'data-prog': d.id, style: `width:${Math.round(d.textProgress * 100)}%` })) : null,
    el('div', { class: 'meta' }, d.textFail ? '⚠ busca indisponível' : meta));
}

async function footer(box) {
  const f = el('div', { class: 'empty', style: 'padding:24px 0 0;font-size:13px' });
  box.append(f);
  try {
    const est = await navigator.storage?.estimate?.();
    const total = S.docs.reduce((a, d) => a + d.size, 0);
    f.textContent = `${S.docs.length} baixados · ${fmtMB(total)}` + (S.cloud.length ? ` · ${S.cloud.length} na nuvem` : '') + (est?.quota ? ` · espaço livre p/ o app: ${fmtMB(est.quota - est.usage)}` : '') + ` · v${APP_VERSION}`;
  } catch {}
}

function renderCategory(box, cat) {
  let any = false;
  for (const d of [...visDocs()].sort(byBrandOrder)) {
    const cats = docCats(d);
    const roots = [];
    const walk = (nodes, parentCat) => { for (const n of nodes) { const c = cats.get(n.id); if (c === cat && parentCat !== cat) roots.push(n); else if (n.c) walk(n.c, c); } };
    walk(outlineOf(d), null);
    if (!roots.length) continue;
    any = true;
    box.append(el('h3', { class: 'sec' }, (S.brand === 'Todas' && d.brand ? d.brand + ' · ' : '') + d.name));
    box.append(renderTree(roots, d, { top: true }));
  }
  if (!any) box.append(el('div', { class: 'empty' }, 'Nenhum capítulo nesta categoria.'));
}

// ---------------------------------------------------------------------
//  Árvore do sumário
// ---------------------------------------------------------------------
function renderTree(nodes, d, opts = {}) {
  const exp = S.expanded.get(d.id) || S.expanded.set(d.id, new Set()).get(d.id);
  const cats = docCats(d);
  const ul = el('ul', { class: 'tree' });
  for (const n of nodes) {
    const li = el('li', { class: opts.top ? 'top' : '' });
    const has = !!n.c?.length;
    const fav = d.favs.some(f => f.k === n.id);
    let sub = null;
    const toggle = () => {
      if (exp.has(n.id)) { exp.delete(n.id); sub?.remove(); sub = null; tog.textContent = '▶'; }
      else { exp.add(n.id); sub = renderTree(n.c, d); li.append(sub); tog.textContent = '▼'; }
    };
    const tog = el('button', { class: 'tog' + (has ? '' : ' leaf'), onclick: toggle }, '▶');
    const lbl = el('button', { class: 'lbl', onclick: () => (has ? toggle() : openViewer(d.id, n.p || 1)) }, n.t);
    if (opts.top && opts.showCat) {
      lbl.append(el('span', { class: 'catdot', onclick: e => { e.stopPropagation(); catSheet(d, n); } }, cats.get(n.id)));
    }
    const pg = n.p ? el('span', { class: 'p' }, (has ? 'p. ' + n.p + ' ›' : 'p. ' + n.p)) : null;
    if (pg && has) pg.onclick = e => { e.stopPropagation(); openViewer(d.id, n.p); };
    if (pg) lbl.append(pg);
    const star = has ? null : el('button', { class: 'star' + (fav ? ' on' : ''), 'aria-label': 'Favorito', onclick: async () => {
      const i = d.favs.findIndex(f => f.k === n.id);
      if (i >= 0) d.favs.splice(i, 1); else d.favs.push({ k: n.id, t: n.t, p: n.p || 1, at: Date.now() });
      star.classList.toggle('on', i < 0); star.textContent = i < 0 ? '★' : '☆';
      await saveDoc(d);
    } }, fav ? '★' : '☆');
    li.append(el('div', { class: 'node' }, tog, lbl, star));
    if (has && (exp.has(n.id) || opts.open)) { exp.add(n.id); sub = renderTree(n.c, d); li.append(sub); tog.textContent = '▼'; }
    ul.append(li);
  }
  return ul;
}

function catSheet(d, n) {
  openSheet(el('div', {},
    el('h4', {}, 'Sistema deste capítulo'),
    el('p', { class: 's', style: 'color:var(--muted);margin-top:0' }, n.t),
    ...CAT_ORDER.map(c => el('button', { class: 'opt', onclick: async () => {
      d.catFix[n.id] = c; d._cats = null; await saveDoc(d); closeSheet(); renderManual(true);
    } }, c)),
    el('div', { class: 'acts' }, el('button', { onclick: closeSheet }, 'Cancelar'))));
}

// ---------------------------------------------------------------------
//  Tela do manual (sumário)
// ---------------------------------------------------------------------
let mSearchT;
$('#manualSearch').addEventListener('input', e => {
  S.mq = e.target.value; $('#manualSearchClear').hidden = !S.mq;
  clearTimeout(mSearchT); mSearchT = setTimeout(() => renderManual(), 220);
});
$('#manualSearchClear').onclick = () => { $('#manualSearch').value = S.mq = ''; $('#manualSearchClear').hidden = true; renderManual(); };
$('#manualSearch').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#btnOpenPdf').onclick = () => S.cur && openViewer(S.cur.id, S.cur.lastPage || 1);

function renderManual(keepScroll) {
  const d = S.cur; if (!d) return;
  const box = $('#manualBody'); const y = box.scrollTop;
  $('#manualTitle').textContent = d.name;
  $('#manualSearchClear').hidden = !S.mq;
  box.innerHTML = '';
  if (S.mq.trim()) { renderSearch(box, S.mq, d.id); return; }
  if (!d.textDone && !d.textFail) box.append(el('div', { class: 'progress', 'data-progtxt': d.id, style: 'margin:6px 2px' }, `Preparando busca… ${Math.round(d.textProgress * 100)}%`));
  if (d.cloud) box.append(el('div', { class: 'note' }, `☁ Aberto pela nuvem — precisa de internet e não aparece na busca por texto. `,
    el('button', { class: 'btn-accent', style: 'margin-top:8px;width:100%', onclick: () => {
      setLocal(d, true); toast(`Baixando “${d.name}” (${fmtMB(d.size)})…`); history.back(); setTimeout(() => sync(true), 300);
    } }, `📱 Baixar para usar sem internet (${fmtMB(d.size)})`)));
  else if (d.rid) box.append(el('div', { class: 'muted small', style: 'margin:6px 2px;display:flex;align-items:center;gap:8px' }, `📱 Baixado no celular (${fmtMB(d.size)})`,
    el('button', { class: 'btn-ghost', style: 'margin-left:auto;font-size:13px', onclick: async () => {
      if (!confirm(`Tirar “${d.name}” do celular? Ele continua disponível pela nuvem (com internet). Os favoritos dele são apagados.`)) return;
      setLocal(d, false); await removeLocalDoc(d); refreshCloud(); history.back(); toast('Removido do celular — continua na nuvem ☁');
    } }, 'Tirar do celular')));
  if (d.favs.length) {
    box.append(el('h3', { class: 'sec' }, 'Favoritos / páginas salvas'));
    for (const f of [...d.favs].sort((a, b) => a.p - b.p))
      box.append(el('button', { class: 'row', onclick: () => openViewer(d.id, f.p) },
        el('div', { class: 'main' }, el('div', { class: 't' }, '⭐ ' + f.t)), el('div', { class: 'pg' }, 'p. ' + f.p)));
  }
  const ol = outlineOf(d);
  if (ol.length) {
    box.append(el('h3', { class: 'sec' }, d.outline?.length ? 'Sumário' : 'Sumário (gerado automaticamente)'));
    if (!d.outline?.length) box.append(el('div', { class: 'note' }, 'Este PDF não tinha sumário; este foi montado pelos títulos em letra maior. Pode ter falhas — use ☆ no leitor para salvar as páginas que você mais usa.'));
    box.append(renderTree(ol, d, { top: true, showCat: !!d.outline?.length && !d.cat }));
  } else {
    box.append(el('div', { class: 'note', html: d.cloud
      ? 'Este PDF não tem sumário próprio. Toque em <b>Abrir</b> para ler, ou baixe o manual para o app montar um sumário automático.'
      : d.textDone
      ? 'Este PDF não tem sumário e não deu para montar um automaticamente.<br><br>Abra o manual e toque em <b>☆</b> nas páginas importantes: elas viram o seu sumário aqui.'
      : 'Este PDF não tem sumário. Assim que a preparação terminar, o app tenta montar um sumário pelos títulos.' }));
  }
  if (d.scanned) box.append(el('div', { class: 'note' }, 'Este PDF parece ser escaneado (imagem), então a busca dentro do texto não funciona nele.'));
  if (keepScroll) box.scrollTop = y;
}

// ---------------------------------------------------------------------
//  Folhas (diálogos)
// ---------------------------------------------------------------------
function openSheet(content) {
  const c = $('#sheetCard'); c.innerHTML = ''; c.append(content); $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function editDocSheet(d) {
  const groups = [...new Set(S.docs.map(x => x.group).filter(Boolean))].sort();
  const name = el('input', { value: d.name });
  const group = el('input', { value: d.group, list: 'grpList', placeholder: 'ex.: MHC80 — Manuais' });
  const dl = el('datalist', { id: 'grpList' }, groups.map(g => el('option', { value: g })));
  const chips = el('div', { class: 'chips', style: 'padding:6px 0' }, groups.map(g => el('button', { class: 'chip', onclick: () => (group.value = g) }, g)));
  openSheet(el('div', {},
    el('h4', {}, 'Editar manual'),
    d.rid ? el('p', { class: 'muted small', style: 'margin:0' }, 'As mudanças valem para todos da equipe.') : null,
    el('label', {}, 'Nome que aparece no app'), name,
    el('label', {}, 'Grupo'), group, dl, groups.length ? chips : null,
    el('div', { class: 'acts' },
      el('button', { class: 'ok', onclick: async () => {
        const nn = name.value.trim() || d.name, ng = group.value.trim();
        try { if (d.rid) await api('admin/docmeta', { json: { rid: d.rid, name: nn, group: ng } }); }
        catch (e) { toast('Não salvou: ' + (e.status ? e.message : 'sem internet'), 4000); return; }
        d.name = nn; d.group = ng; await saveDoc(d); closeSheet(); renderHome(true); if ($('#admin').classList.contains('active')) renderAdmin();
      } }, 'Salvar'),
      el('button', { onclick: () => confirmDelete(d), class: 'danger' }, d.rid ? 'Remover para todos' : 'Excluir'),
      d.textFail ? el('button', { onclick: async () => { delete d.textFail; await saveDoc(d); closeSheet(); renderHome(true); indexQueue(); } }, 'Tentar busca de novo') : null,
      el('button', { onclick: closeSheet }, 'Cancelar'))));
}
function confirmDelete(d) {
  openSheet(el('div', {},
    el('h4', {}, 'Remover “' + d.name + '”?'),
    el('p', { class: 'muted' }, d.rid ? 'O manual sai da nuvem e some do celular de todos da equipe na próxima vez que abrirem o app com internet.' : 'O manual sai deste aparelho.'),
    el('div', { class: 'acts' },
      el('button', { class: 'danger', onclick: async () => {
        try { if (d.rid) await api('admin/docdelete', { json: { rid: d.rid } }); }
        catch (e) { toast('Não removeu: ' + (e.status ? e.message : 'sem internet'), 4000); return; }
        await removeLocalDoc(d);
        closeSheet(); renderHome(); if ($('#admin').classList.contains('active')) renderAdmin(); toast('Manual removido');
      } }, 'Remover'),
      el('button', { onclick: closeSheet }, 'Cancelar'))));
}

// ---------------------------------------------------------------------
//  Leitor de PDF
// ---------------------------------------------------------------------
const V = { id: null, pdf: null, n: 0, zoom: 1, w: 0, aspect: 1.414, pages: [], obs: null, q: '', hits: [], hitI: 0, cur: 1, token: 0 };
const pagesEl = $('#pages'), innerEl = $('#pagesInner');

function openViewer(id, page, q) {
  const d = docById(id);
  if (d?.cloud && !S.cloudBlobs.has(d.id)) return openCloud(d, () => go({ s: 'viewer', id, p: page || 1, q: q || '' }));
  go({ s: 'viewer', id, p: page || 1, q: q || '' });
}

async function startViewer(st) {
  const d = docById(st.id); if (!d) return history.back();
  const token = ++V.token;
  $('#viewerTitle').textContent = d.name; $('#viewerPage').textContent = 'abrindo…';
  if (V.id !== d.id || !V.pdf) {
    closeViewer(true);
    innerEl.innerHTML = '';
    let pdf;
    try { pdf = await getPdf(d.id); } catch (e) { toast('Erro ao abrir: ' + e.message, 5000); return; }
    if (token !== V.token) return;
    V.id = d.id; V.pdf = pdf; V.n = pdf.numPages; V.pages = []; V.zoom = 1; V.cur = st.p || 1;
    const p1 = await pdf.getPage(1); const vp = p1.getViewport({ scale: 1 });
    V.aspect = vp.height / vp.width;
    for (let i = 1; i <= V.n; i++) {
      const div = el('div', { class: 'page', 'data-p': i }, el('div', { class: 'num' }, i));
      V.pages.push({ div, aspect: V.aspect, canvas: null, task: null, scale: 0, hl: false });
      innerEl.append(div);
    }
    V.obs = new IntersectionObserver(onIntersect, { root: pagesEl, rootMargin: '1200px 0px' });
    V.pages.forEach(p => V.obs.observe(p.div));
  }
  V.doc = d;
  setQuery(st.q);
  layout();
  scrollToPage(st.p || 1);
  d.opened = Date.now(); saveDoc(d);
  updateCur();
}

function closeViewer(keepNothing) {
  if (!V.obs && !keepNothing) return;
  V.obs?.disconnect(); V.obs = null;
  for (const p of V.pages) { p.task?.cancel(); if (p.canvas) { p.canvas.width = p.canvas.height = 0; } }
  V.pages = []; V.pdf = null; V.id = null; innerEl.innerHTML = ''; visible.clear();
}

function layout() {
  V.w = Math.min(pagesEl.clientWidth - 16, 1100);
  const w = Math.round(V.w * V.zoom);
  innerEl.style.width = Math.max(pagesEl.clientWidth, w + 16) + 'px';
  for (const p of V.pages) { p.div.style.width = w + 'px'; p.div.style.height = Math.round(w * p.aspect) + 'px'; }
}
function scrollToPage(n, frac = 0) {
  const p = V.pages[Math.min(Math.max(n, 1), V.n) - 1]; if (!p) return;
  pagesEl.scrollTop = p.div.offsetTop - 8 + frac * p.div.offsetHeight;
}

const visible = new Set();
function onIntersect(entries) {
  for (const e of entries) {
    const i = +e.target.dataset.p;
    if (e.isIntersecting) visible.add(i); else { visible.delete(i); unrender(i); }
  }
  pumpRender();
}
let pumping = false;
async function pumpRender() {
  if (pumping) return; pumping = true;
  try {
    for (;;) {
      const target = Math.round(V.w * V.zoom);
      // primeiro as páginas mais perto da página atual
      const todo = [...visible].filter(i => V.pages[i - 1] && V.pages[i - 1].scale !== target).sort((a, b) => Math.abs(a - V.cur) - Math.abs(b - V.cur));
      if (!todo.length || !V.pdf) break;
      await renderPage(todo[0], target);
    }
  } finally { pumping = false; }
}
async function renderPage(i, cssW) {
  const P = V.pages[i - 1]; const pdf = V.pdf; if (!P || !pdf) return;
  try {
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const asp = vp1.height / vp1.width;
    if (Math.abs(asp - P.aspect) > 0.01) {
      const before = P.div.offsetTop < pagesEl.scrollTop;
      const oldH = P.div.offsetHeight;
      P.aspect = asp; P.div.style.height = Math.round(cssW * asp) + 'px';
      if (before) pagesEl.scrollTop += P.div.offsetHeight - oldH;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = (cssW * dpr) / vp1.width;
    const maxPx = 14e6; // limite de memória do iPhone para cada imagem
    if (vp1.width * vp1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (vp1.width * vp1.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    P.task?.cancel();
    const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
    P.task = task;
    await task.promise;
    if (V.pdf !== pdf || !visible.has(i)) { canvas.width = canvas.height = 0; return; }
    if (P.canvas) { P.canvas.width = P.canvas.height = 0; P.canvas.remove(); }
    P.div.querySelector('.num')?.remove();
    P.div.prepend(canvas); P.canvas = canvas; P.scale = cssW; P.task = null;
    if (V.q && !P.hl) drawHighlights(i, page, vp1);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.warn('render', i, e);
    P.scale = Math.round(V.w * V.zoom); // não tentar de novo em loop
  }
}
function unrender(i) {
  const P = V.pages[i - 1]; if (!P) return;
  P.task?.cancel(); P.task = null;
  if (P.canvas) { P.canvas.width = P.canvas.height = 0; P.canvas.remove(); P.canvas = null; }
  P.div.querySelectorAll('.hl').forEach(h => h.remove()); P.hl = false;
  if (!P.div.querySelector('.num')) P.div.append(el('div', { class: 'num' }, i));
  P.scale = 0;
}

// --- destaque das palavras buscadas ---
function setQuery(q) {
  V.q = (q || '').trim(); V.hits = []; V.hitI = 0;
  for (const P of V.pages) { P.div.querySelectorAll('.hl').forEach(h => h.remove()); P.hl = false; }
  const tx = S.texts.get(V.id);
  if (V.q && tx) { const ts = terms(V.q); tx.norm.forEach((n, i) => { if (ts.every(t => n.includes(t))) V.hits.push(i + 1); }); }
  $('#hitBar').hidden = !V.q;
  updateHitBar();
  for (const i of visible) { const P = V.pages[i - 1]; if (P?.canvas) V.pdf.getPage(i).then(pg => drawHighlights(i, pg, pg.getViewport({ scale: 1 }))); }
}
function updateHitBar() {
  if (!V.q) return;
  const k = V.hits.indexOf(V.cur);
  $('#hitText').textContent = V.hits.length
    ? `“${V.q}” — ${V.hits.length} pág.` + (k >= 0 ? ` (${k + 1}ª)` : '')
    : `“${V.q}”`;
  $('#hitPrev').hidden = $('#hitNext').hidden = V.hits.length < 2;
}
async function drawHighlights(i, page, vp1) {
  const P = V.pages[i - 1]; if (!P || P.hl || !V.q) return;
  P.hl = true;
  const ts = terms(V.q);
  const tc = await page.getTextContent();
  for (const it of tc.items) {
    if (!it.str) continue;
    const n = norm(it.str);
    for (const t of ts) {
      let k = -1;
      while ((k = n.indexOf(t, k + 1)) !== -1) {
        const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]);
        const len = it.str.length || 1;
        const x = tx[4] + (it.width * k) / len, w = (it.width * t.length) / len, y = tx[5] - fh;
        P.div.append(el('div', { class: 'hl', style:
          `left:${(x / vp1.width) * 100}%;top:${(y / vp1.height) * 100}%;width:${(w / vp1.width) * 100}%;height:${(fh * 1.2 / vp1.height) * 100}%` }));
      }
    }
  }
}
$('#hitClose').onclick = () => setQuery('');
$('#hitNext').onclick = () => { const n = V.hits.find(h => h > V.cur) ?? V.hits[0]; if (n) scrollToPage(n); };
$('#hitPrev').onclick = () => { const n = [...V.hits].reverse().find(h => h < V.cur) ?? V.hits[V.hits.length - 1]; if (n) scrollToPage(n); };

// --- página atual / título do tópico ---
let curT, saveT;
pagesEl.addEventListener('scroll', () => { if (!curT) curT = requestAnimationFrame(() => { curT = null; updateCur(); }); }, { passive: true });
function updateCur() {
  if (!V.pages.length) return;
  const r = pagesEl.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * 0.35)?.closest('.page');
  if (hit) V.cur = +hit.dataset.p;
  const tp = V.doc && topicAt(V.doc, V.cur);
  $('#viewerTitle').textContent = tp ? tp.n.t : V.doc?.name || '';
  $('#viewerPage').textContent = `${V.doc?.name || ''} · pág. ${V.cur} de ${V.n}`;
  const fav = V.doc?.favs.some(f => f.p === V.cur);
  $('#btnMark').textContent = fav ? '★' : '☆';
  $('#btnMark').style.color = fav ? 'var(--accent2)' : '';
  updateHitBar();
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (V.doc && V.doc.lastPage !== V.cur) { V.doc.lastPage = V.cur; saveDoc(V.doc); } }, 800);
}

// --- zoom: botões, pinça (2 dedos) e toque duplo ---
function setZoom(z, ax, ay) {
  z = Math.min(Math.max(z, 0.5), 5);
  if (Math.abs(z - V.zoom) < 0.01) return;
  const r = pagesEl.getBoundingClientRect();
  ax ??= r.width / 2; ay ??= r.height / 2;
  const cx = pagesEl.scrollLeft + ax, cy = pagesEl.scrollTop + ay, f = z / V.zoom;
  V.zoom = z; layout();
  pagesEl.scrollLeft = cx * f - ax; pagesEl.scrollTop = cy * f - ay;
  pumpRender();
}
$('#zoomIn').onclick = () => setZoom(V.zoom * 1.4);
$('#zoomOut').onclick = () => setZoom(V.zoom / 1.4);
$('#zoomFit').onclick = () => { const p = V.cur; V.zoom = 1; layout(); scrollToPage(p); pagesEl.scrollLeft = 0; pumpRender(); };
$('#goPage').onclick = () => {
  const inp = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: V.n, value: V.cur });
  const ok = () => { const n = parseInt(inp.value, 10); if (n >= 1 && n <= V.n) { scrollToPage(n); closeSheet(); } };
  inp.addEventListener('keydown', e => e.key === 'Enter' && ok());
  openSheet(el('div', {}, el('h4', {}, `Ir para a página (1 a ${V.n})`), inp,
    el('div', { class: 'acts' }, el('button', { class: 'ok', onclick: ok }, 'Ir'), el('button', { onclick: closeSheet }, 'Cancelar'))));
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
};
let pinch = null, lastTap = 0, tapStart = null;
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
pagesEl.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches, r = pagesEl.getBoundingClientRect();
    const mx = (a.clientX + b.clientX) / 2 - r.left, my = (a.clientY + b.clientY) / 2 - r.top;
    pinch = { d0: dist(a, b), z0: V.zoom, mx, my, s: 1 };
    innerEl.style.transformOrigin = `${pagesEl.scrollLeft + mx}px ${pagesEl.scrollTop + my}px`;
  } else if (e.touches.length === 1) tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
pagesEl.addEventListener('touchmove', e => {
  if (pinch && e.touches.length === 2) {
    e.preventDefault();
    pinch.s = Math.min(Math.max(dist(e.touches[0], e.touches[1]) / pinch.d0, 0.5 / pinch.z0), 5 / pinch.z0);
    innerEl.style.transform = `scale(${pinch.s})`;
  } else tapStart = null;
}, { passive: false });
pagesEl.addEventListener('touchend', e => {
  if (pinch && e.touches.length < 2) {
    const { z0, s, mx, my } = pinch; pinch = null;
    innerEl.style.transform = '';
    setZoom(z0 * s, mx, my);
    return;
  }
  if (tapStart && e.changedTouches.length === 1 && Date.now() - tapStart.t < 250) {
    const now = Date.now(), t = e.changedTouches[0], r = pagesEl.getBoundingClientRect();
    if (now - lastTap < 320) {
      lastTap = 0;
      setZoom(V.zoom > 1.2 ? 1 : 2.2, t.clientX - r.left, t.clientY - r.top);
      if (V.zoom === 1) pagesEl.scrollLeft = 0;
    } else lastTap = now;
  }
  tapStart = null;
});
document.addEventListener('gesturestart', e => e.preventDefault());
window.addEventListener('resize', () => { if ($('#viewer').classList.contains('active')) { const p = V.cur; layout(); scrollToPage(p); pumpRender(); } });

// --- salvar página como favorito / tópico ---
$('#btnMark').onclick = () => {
  const d = V.doc; if (!d) return;
  const existing = d.favs.find(f => f.p === V.cur);
  if (existing) {
    openSheet(el('div', {}, el('h4', {}, '⭐ ' + existing.t), el('p', { style: 'color:var(--muted)' }, 'Página ' + existing.p),
      el('div', { class: 'acts' },
        el('button', { class: 'danger', onclick: async () => { d.favs = d.favs.filter(f => f !== existing); await saveDoc(d); closeSheet(); updateCur(); toast('Removido dos favoritos'); } }, 'Remover'),
        el('button', { onclick: closeSheet }, 'Fechar'))));
    return;
  }
  const tp = topicAt(d, V.cur);
  const inp = el('input', { value: tp ? tp.n.t : `Página ${V.cur}` });
  const ok = async () => { d.favs.push({ k: null, t: inp.value.trim() || `Página ${V.cur}`, p: V.cur, at: Date.now() }); await saveDoc(d); closeSheet(); updateCur(); toast('Salvo nos favoritos'); };
  inp.addEventListener('keydown', e => e.key === 'Enter' && ok());
  openSheet(el('div', {}, el('h4', {}, `Salvar página ${V.cur}`), el('label', {}, 'Nome (aparece nos favoritos e na busca)'), inp,
    el('div', { class: 'acts' }, el('button', { class: 'ok', onclick: ok }, 'Salvar'), el('button', { onclick: closeSheet }, 'Cancelar'))));
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
};

// ---------------------------------------------------------------------
//  Escolher quais manuais baixar neste celular
// ---------------------------------------------------------------------
const LS_SEL = 'manuais.sel';
let SEL = lsGet(LS_SEL, null); // {machines:[], docs:[], off:[]}  · null = ainda não escolheu
const machineOf = r => (r.group || '').split(' — ')[0].trim() || r.group || 'Geral';
const mkey = r => (r.brand || 'Outros') + '|' + machineOf(r);
function wanted(r) {
  if (!SEL) return !!AUTH.admin; // admin recebe tudo até escolher
  if (SEL.docs?.includes(r.rid)) return true;
  return !!SEL.machines?.includes(mkey(r)) && !SEL.off?.includes(r.rid);
}
$('#btnPick').onclick = () => go({ s: 'pick' });

let PICK = null; // {remote, sel}
async function renderPick() {
  const box = $('#pickBody');
  box.innerHTML = '<div class="empty">Carregando a lista da nuvem…</div>';
  let remote;
  try { remote = (await api('docs')).docs; }
  catch (e) { box.innerHTML = ''; box.append(el('div', { class: 'note' }, 'Sem internet. Para escolher os manuais, conecte o celular à internet.')); $('#pickSum').textContent = ''; return; }
  const base = SEL || (AUTH.admin ? { machines: [...new Set(remote.map(mkey))], docs: [], off: [] } : { machines: [], docs: [], off: [] });
  PICK = { remote, sel: JSON.parse(JSON.stringify(base)), open: PICK?.open || new Set() };
  drawPick();
}
function pickWanted(r) {
  const s = PICK.sel;
  return s.docs.includes(r.rid) || (s.machines.includes(mkey(r)) && !s.off.includes(r.rid));
}
function drawPick() {
  const box = $('#pickBody'); box.innerHTML = '';
  const { remote, sel } = PICK;
  box.append(el('div', { class: 'note', html: '<b>✔ Marcado = 📱 baixado no celular</b>: funciona sem internet e entra na busca.<br><b>Desmarcado = ☁ fica na nuvem</b>: aparece na tela inicial e abre com internet, sem ocupar espaço.<br><br>Marcando a máquina inteira, os manuais novos dela também baixam sozinhos.' }));
  const sc = el('button', { class: 'row', onclick: () => { lsSet('manuais.showcloud', !showCloud()); drawPick(); } },
    el('div', { class: 'ck ' + (showCloud() ? 'on' : '') }, showCloud() ? '✓' : ''),
    el('div', { class: 'main' }, el('div', { class: 't' }, 'Mostrar na tela inicial os manuais da nuvem'), el('div', { class: 's' }, 'Desligue para ver só os baixados')));
  box.append(sc);
  const brands = [...new Set(remote.map(r => r.brand || 'Outros'))].sort((a, b) => a.localeCompare(b, 'pt'));
  for (const b of brands) {
    box.append(el('h3', { class: 'sec' }, b));
    const rs = remote.filter(r => (r.brand || 'Outros') === b);
    const machines = [...new Set(rs.map(machineOf))].sort((x, y) => Math.min(...rs.filter(r => machineOf(r) === x).map(r => r.order ?? 999)) - Math.min(...rs.filter(r => machineOf(r) === y).map(r => r.order ?? 999)));
    for (const m of machines) {
      const docs = rs.filter(r => machineOf(r) === m).sort((x, y) => (x.order ?? 999) - (y.order ?? 999));
      const key = b + '|' + m;
      const on = docs.filter(pickWanted);
      const state = on.length === 0 ? '' : on.length === docs.length ? 'on' : 'part';
      const size = docs.reduce((a, r) => a + r.size, 0), sizeOn = on.reduce((a, r) => a + r.size, 0);
      const wrap = el('div', { class: 'mach' });
      const toggleMachine = () => {
        if (state === 'on') { sel.machines = sel.machines.filter(k => k !== key); sel.docs = sel.docs.filter(id => !docs.some(r => r.rid === id)); }
        else { if (!sel.machines.includes(key)) sel.machines.push(key); sel.off = sel.off.filter(id => !docs.some(r => r.rid === id)); }
        drawPick();
      };
      const opened = PICK.open.has(key);
      wrap.append(el('div', { class: 'mrow' },
        el('button', { class: 'ck ' + state, 'aria-label': 'Marcar máquina', onclick: toggleMachine }, state === 'on' ? '✓' : state === 'part' ? '–' : ''),
        el('button', { class: 'main', style: 'text-align:left', onclick: () => { opened ? PICK.open.delete(key) : PICK.open.add(key); drawPick(); } },
          el('div', { class: 't', style: 'font-weight:700' }, m),
          el('div', { class: 's muted small' }, `${on.length} de ${docs.length} manuais · ${fmtMB(sizeOn)} de ${fmtMB(size)}`)),
        el('button', { class: 'btn-ghost', onclick: () => { opened ? PICK.open.delete(key) : PICK.open.add(key); drawPick(); } }, opened ? '▲' : '▼')));
      if (opened) {
        const list = el('div', { class: 'mlist' }); let lastG = null;
        for (const r of docs) {
          const g = (r.group || '').split(' — ').slice(1).join(' — ');
          if (g && g !== lastG) { list.append(el('div', { class: 'gsub' }, g)); lastG = g; }
          const w = pickWanted(r);
          list.append(el('div', { class: 'drow' },
            el('button', { class: 'ck ' + (w ? 'on' : ''), onclick: () => {
              if (sel.machines.includes(key)) { w ? sel.off.push(r.rid) : (sel.off = sel.off.filter(x => x !== r.rid)); }
              else { w ? (sel.docs = sel.docs.filter(x => x !== r.rid)) : sel.docs.push(r.rid); }
              drawPick();
            } }, w ? '✓' : ''),
            el('div', { class: 'main' }, el('div', {}, r.name), el('div', { class: 'muted small' }, `${fmtMB(r.size)}${r.pages ? ' · ' + r.pages + ' pág.' : ''}`))));
        }
        wrap.append(list);
      }
      box.append(wrap);
    }
  }
  const n = remote.filter(pickWanted), tot = n.reduce((a, r) => a + r.size, 0);
  $('#pickSum').textContent = `📱 ${n.length} baixados · ${fmtMB(tot)} no celular · ☁ ${remote.length - n.length} na nuvem`;
}
$('#pickSave').onclick = async () => {
  if (!PICK) return;
  const keep = new Set(PICK.remote.filter(pickWanted).map(r => r.rid));
  const drop = S.docs.filter(d => d.rid && !keep.has(d.rid));
  if (drop.length && !confirm(`${drop.length} manual(is) desmarcado(s) serão apagados deste celular (os favoritos deles também). Continuar?`)) return;
  SEL = PICK.sel; lsSet(LS_SEL, SEL);
  for (const d of drop) await removeLocalDoc(d);
  history.back();
  setTimeout(() => sync(true), 300);
};

// ---------------------------------------------------------------------
//  Painel do administrador
// ---------------------------------------------------------------------
$('#btnAdmin').onclick = () => go({ s: 'admin' });
const ago = t => {
  if (!t) return 'nunca';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'agora'; if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60); if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24); return d === 1 ? 'ontem' : `há ${d} dias`;
};
const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
function inviteText(c) {
  const link = appUrl() + '#codigo=' + encodeURIComponent(c.pretty);
  return `Olá, ${c.name}! Seu acesso ao app *Manuais da Manutenção*:\n\n` +
    `1️⃣ Toque no link (o código já vai preenchido):\n${link}\n\n` +
    `2️⃣ Instale o app:\n   • Android (Chrome): menu ⋮ → *Adicionar à tela inicial*\n   • iPhone (Safari): Compartilhar → *Adicionar à Tela de Início*\n\n` +
    `3️⃣ Abra o app pelo ícone. Se pedir o código, copie esta mensagem inteira e toque em *📋 Colar código*.\n\n` +
    `Seu código: ${c.pretty}\n\n` +
    `4️⃣ Na primeira vez, o app mostra a lista de manuais: marque só os que quer baixar no celular (use Wi-Fi). Os desmarcados ficam na nuvem e abrem com internet.\n\n` +
    `O código é pessoal e funciona em até ${c.max} celular${c.max > 1 ? 'es' : ''}. Não repasse.`;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copiado'); }
  catch { const a = el('textarea', {}, t); document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); toast('Copiado'); }
}

let ADM = { codes: [], docs: [] };
async function renderAdmin() {
  const box = $('#adminBody');
  if (!ADM.loaded) box.innerHTML = '<div class="empty">Carregando…</div>';
  try {
    const [c, d] = await Promise.all([api('admin/codes'), api('docs')]);
    ADM = { codes: c.codes, docs: d.docs, loaded: true };
    // manuais enviados antes de existir "marca": completa pelo catálogo
    for (const r of ADM.docs.filter(r => (r.mv || 0) < 2)) {
      const k = fromCatalog(r.file);
      try { ADM.docs = (await api('admin/docmeta', { json: { rid: r.rid, ...(k || {}), mv: 2 } })).docs; } catch {}
    }
  } catch (e) {
    box.innerHTML = ''; box.append(el('div', { class: 'note' }, 'Não consegui falar com o servidor: ' + (e.status ? e.message : 'sem internet') + '.'));
    return;
  }
  box.innerHTML = '';
  // ---- acessos ----
  box.append(el('h3', { class: 'sec' }, `Acessos da equipe (${ADM.codes.length})`));
  box.append(el('button', { class: 'row', style: 'justify-content:center;font-weight:700;color:var(--accent2)', onclick: newCodeSheet }, '＋ Novo acesso'));
  for (const c of ADM.codes) {
    const n = Object.keys(c.devices || {}).length;
    const last = Math.max(0, ...Object.values(c.devices || {}).map(v => v.last || 0));
    const recentTry = (c.attempts || []).filter(a => Date.now() - a.at < 30 * 86400000).length;
    box.append(el('button', { class: 'row', onclick: async () => { await renderAdmin(); codeSheet(ADM.codes.find(x => x.code === c.code) || c); } },
      el('div', { class: 'main' },
        el('div', { class: 't' }, c.name,
          c.blocked ? el('span', { class: 'badge red' }, 'Bloqueado') : n ? el('span', { class: 'badge ok' }, 'Ativo') : el('span', { class: 'badge warn' }, 'Não usado'),
          recentTry ? el('span', { class: 'badge red' }, `⚠ ${recentTry} tentativa${recentTry > 1 ? 's' : ''}`) : null),
        el('div', { class: 's' }, `${maskCode(c.pretty)} · ${n}/${c.max} celular${c.max > 1 ? 'es' : ''} · último uso: ${ago(last)}`)),
      el('div', { class: 'pg' }, '›')));
  }
  // ---- manuais ----
  const total = ADM.docs.reduce((a, d) => a + d.size, 0);
  box.append(el('h3', { class: 'sec' }, `Manuais na nuvem (${ADM.docs.length} · ${fmtMB(total)})`));
  box.append(el('button', { class: 'row', style: 'justify-content:center;font-weight:700;color:var(--accent2)', onclick: () => $('#fileInput').click() }, '＋ Enviar PDFs (novos ou atualizados)'));
  box.append(el('div', { class: 'note' }, 'Dica: envie pelo computador, é mais rápido. Se mandar um PDF com o mesmo nome de arquivo de um que já está na nuvem, ele substitui o antigo para todos (os favoritos de cada um são mantidos).'));
  for (const r of [...ADM.docs].sort((a, b) => (a.brand || '').localeCompare(b.brand || '') || (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'pt'))) {
    const local = S.docs.find(d => d.rid === r.rid);
    box.append(el('button', { class: 'row', onclick: () => local ? editDocSheet(local) : toast('Este manual ainda está baixando neste aparelho') },
      el('div', { class: 'main' }, el('div', { class: 't' }, r.name), el('div', { class: 's' }, `${r.brand ? r.brand + ' · ' : ''}${r.group || 'sem grupo'} · ${fmtMB(r.size)}${r.pages ? ' · ' + r.pages + ' pág.' : ''}`)),
      el('div', { class: 'pg' }, '⋯')));
  }
  box.append(el('div', { class: 'empty small', style: 'padding:20px 0 0' }, `Endereço do app: ${appUrl()}`,
    el('br'), AUTH.storage === 'R2' ? 'Arquivos guardados no R2 (até 10 GB grátis) ✔' : 'Arquivos guardados no KV (limite de 1 GB) — ative o R2 para caber tudo'));
}

function newCodeSheet() {
  const name = el('input', { placeholder: 'ex.: João – turno B' });
  let max = 1;
  const seg = el('div', { class: 'seg' }, [1, 2, 3].map(n => el('button', { class: n === 1 ? 'on' : '', onclick: e => { max = n; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); } }, n + (n > 1 ? ' celulares' : ' celular'))));
  const create = async () => {
    if (!name.value.trim()) return name.focus();
    try {
      const c = await api('admin/codes', { json: { name: name.value.trim(), max } });
      await renderAdmin(); codeSheet(c, true);
    } catch (e) { toast(e.status ? e.message : 'Sem internet', 4000); }
  };
  name.addEventListener('keydown', e => e.key === 'Enter' && create());
  openSheet(el('div', {}, el('h4', {}, 'Novo acesso'),
    el('label', {}, 'Nome da pessoa'), name,
    el('label', {}, 'Em quantos celulares o código pode funcionar'), seg,
    el('div', { class: 'acts' }, el('button', { class: 'ok', onclick: create }, 'Criar código'), el('button', { onclick: closeSheet }, 'Cancelar'))));
  setTimeout(() => name.focus(), 50);
}

function codeSheet(c, fresh) {
  const act = async (action, extra = {}, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    try { const r = await api('admin/code', { json: { code: c.code, action, ...extra } }); await renderAdmin(); if (!r.deleted) codeSheet(ADM.codes.find(x => x.code === c.code) || r); else { closeSheet(); toast('Acesso excluído'); } }
    catch (e) { toast(e.status ? e.message : 'Sem internet', 4000); }
  };
  const devs = Object.entries(c.devices || {});
  const seg = el('div', { class: 'seg' }, [1, 2, 3].map(n => el('button', { class: n === c.max ? 'on' : '', onclick: () => act('setMax', { max: n }) }, String(n))));
  openSheet(el('div', {},
    el('h4', {}, c.name, c.blocked ? el('span', { class: 'badge red' }, 'Bloqueado') : null),
    fresh ? el('p', { class: 'muted', style: 'margin:0' }, 'Código criado! Envie para a pessoa:') : null,
    codeView(c.pretty),
    el('div', { class: 'acts' },
      el('button', { class: 'ok', onclick: () => window.open('https://wa.me/?text=' + encodeURIComponent(inviteText(c)), '_blank') }, '📲 Enviar pelo WhatsApp'),
      el('button', { onclick: () => copyText(inviteText(c)) }, 'Copiar mensagem')),
    el('label', {}, `Celulares usando este código (${devs.length} de ${c.max})`),
    devs.length ? el('div', {}, devs.map(([id, v]) => el('div', { class: 'devrow' },
      el('div', {}, el('div', {}, v.label || 'Aparelho'), el('div', { class: 'muted small' }, `desde ${new Date(v.first).toLocaleDateString('pt-BR')} · último uso ${ago(v.last)}`)),
      el('button', { onclick: () => act('removeDevice', { deviceId: id }, `Remover este celular? Os manuais serão apagados dele na próxima vez que abrir com internet.`) }, 'Remover'))))
      : el('p', { class: 'muted small' }, 'Ainda não foi usado.'),
    (c.attempts || []).length ? el('div', {},
      el('label', {}, 'Tentativas bloqueadas (outro celular tentou usar o código)'),
      ...(c.attempts || []).slice(0, 5).map(a => el('div', { class: 'muted small' }, `⚠ ${new Date(a.at).toLocaleString('pt-BR')} · ${a.label}`))) : null,
    el('label', {}, 'Limite de celulares'), seg,
    el('div', { class: 'acts' },
      c.blocked
        ? el('button', { class: 'ok', onclick: () => act('unblock') }, 'Desbloquear')
        : el('button', { class: 'danger', onclick: () => act('block', {}, `Bloquear ${c.name}? Os manuais serão apagados do celular dele na próxima vez que abrir o app com internet.`) }, 'Bloquear'),
      devs.length ? el('button', { onclick: () => act('reset', {}, 'Liberar todas as vagas? (use quando a pessoa trocar de celular)') }, 'Liberar vagas') : null,
      el('button', { class: 'danger', onclick: () => act('delete', {}, `Excluir o acesso de ${c.name} de vez?`) }, 'Excluir'),
      el('button', { onclick: closeSheet }, 'Fechar'))));
}

// ---- enviar PDFs para a nuvem ----
$('#fileInput').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (files.length) await uploadFiles(files);
};
async function sha16(buf) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const slug = s => norm(s).replace(/\.pdf$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'manual';
async function uploadFiles(files) {
  let remote;
  try { remote = (await api('docs')).docs; } catch (e) { toast(e.status ? e.message : 'Sem internet', 4000); return; }
  const status = el('div', { class: 'progress' }); const bar = el('div', { class: 'bar', style: 'height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:8px' }, el('i', { style: 'display:block;height:100%;width:0;background:var(--accent)' }));
  openSheet(el('div', {}, el('h4', {}, 'Enviando para a nuvem'), status, bar, el('p', { class: 'muted small' }, 'Não feche o app até terminar.')));
  const total = files.reduce((a, f) => a + f.size, 0); let sent = 0, ok = 0;
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    try {
      const buf = await f.arrayBuffer();
      const sha = await sha16(buf);
      const old = remote.find(r => r.file === f.name);
      if (old && old.sha === sha) {
        sent += f.size; status.textContent = `${f.name}: já está na nuvem`;
        const k2 = fromCatalog(f.name);
        if (k2) { const r = await api('admin/docmeta', { json: { rid: old.rid, ...k2 } }); remote = r.docs; ok++; }
        continue;
      }
      const rid = old?.rid || slug(f.name) + '-' + Math.random().toString(36).slice(2, 6);
      const parts = Math.max(1, Math.ceil(buf.byteLength / PART));
      for (let i = 0; i < parts; i++) {
        status.textContent = `Enviando ${k + 1} de ${files.length}: ${f.name}` + (parts > 1 ? ` (parte ${i + 1}/${parts})` : '');
        bar.firstChild.style.width = Math.round((sent / total) * 100) + '%';
        const piece = buf.slice(i * PART, Math.min((i + 1) * PART, buf.byteLength));
        await api(`admin/part?rid=${rid}&sha=${sha}&i=${i}`, { method: 'PUT', body: piece, headers: { 'content-type': 'application/octet-stream' } });
        sent += piece.byteLength;
      }
      // guarda também neste aparelho (sem baixar de novo)
      const localOld = S.docs.find(d => d.rid === rid);
      const known = fromCatalog(f.name) || {};
      const meta = { rid, sha, file: f.name, name: known.name || old?.name, group: known.group ?? old?.group, order: known.order ?? old?.order, cat: known.cat ?? old?.cat, brand: known.brand ?? old?.brand };
      const doc = await addPdfBlob(new Blob([buf], { type: 'application/pdf' }), meta);
      if (localOld) { doc.favs = localOld.favs; doc.lastPage = localOld.lastPage; await saveDoc(doc); await removeLocalDoc(localOld); }
      const r = await api('admin/doc', { json: { rid, sha, parts, size: f.size, file: f.name, name: doc.name, group: doc.group, order: doc.order ?? null, cat: doc.cat ?? null, brand: doc.brand ?? null, pages: doc.pages } });
      remote = r.docs; ok++;
    } catch (e) {
      console.error(e);
      toast(`Erro em ${f.name}: ${e.status ? e.message : 'sem internet'}`, 6000); await sleep(2000);
    }
  }
  bar.firstChild.style.width = '100%';
  closeSheet(); toast(`${ok} manual(is) publicado(s) para a equipe`, 4000);
  renderAdmin(); renderHome(true); indexQueue();
}

// ---------------------------------------------------------------------
//  Abas (Manuais · Conversão · Checklist)
// ---------------------------------------------------------------------
const TAB_SCREENS = ['home', 'conv', 'check'];
document.querySelectorAll('#tabs button').forEach(b => (b.onclick = () => {
  const t = b.dataset.tab;
  if (t === 'check') { location.href = 'checklist'; return; } // checklist completo por MHC
  if (document.querySelector('.screen.active')?.id === t) return;
  history.replaceState({ s: t }, ''); route({ s: t });
}));
function updateTabs(id) {
  const on = TAB_SCREENS.includes(id) && !!AUTH.token;
  $('#tabs').hidden = !on; document.body.classList.toggle('withtabs', on);
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
}

// ---------------------------------------------------------------------
//  Conversão mm · pol · cm (foco em chaves)
// ---------------------------------------------------------------------
const IN = 25.4;
const W_MM = [5.5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 34, 35, 36, 38, 41, 42, 46, 50, 55, 60, 65, 70, 75, 80];
const W_IN = ['1/4', '5/16', '11/32', '3/8', '7/16', '1/2', '9/16', '5/8', '11/16', '3/4', '13/16', '7/8', '15/16', '1', '1 1/16', '1 1/8', '1 3/16', '1 1/4', '1 5/16', '1 3/8',
  '1 7/16', '1 1/2', '1 9/16', '1 5/8', '1 11/16', '1 3/4', '1 13/16', '1 7/8', '2', '2 1/16', '2 3/16', '2 1/4', '2 3/8', '2 1/2', '2 9/16', '2 3/4', '3', '3 1/8'];
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function parseIn(s) {
  s = String(s).trim().replace(/["”″]|pol|in/gi, '').replace(',', '.').trim();
  let m = s.match(/^(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\s*\/\s*(\d+)$/); if (m) return m[1] / m[2];
  const v = parseFloat(s); return isFinite(v) ? v : NaN;
}
function frac(inches, den = 64) {
  let n = Math.round(inches * den); if (n === 0) return '0"';
  const whole = Math.floor(n / den); let r = n % den;
  if (!r) return whole + '"';
  const g = gcd(r, den); const f = `${r / g}/${den / g}`;
  return (whole ? whole + ' ' : '') + f + '"';
}
const fmtN = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString().replace('.', ',');
function fitTxt(diff) {
  const a = Math.abs(diff);
  if (a <= 0.15) return ['ok', '✔ serve'];
  if (a <= 0.4) return ['mid', diff > 0 ? '≈ fica um pouco folgada' : '≈ fica justa — teste antes'];
  return ['no', '✖ não serve'];
}
let CONV = { unit: lsGet('manuais.cvu', 'mm'), val: '' };
function renderConv() {
  const box = $('#convBody'); box.innerHTML = '';
  const inp = el('input', { inputmode: CONV.unit === 'pol' ? 'text' : 'decimal', value: CONV.val, placeholder: CONV.unit === 'pol' ? 'ex.: 3/4 ou 1 1/8' : 'ex.: 19', autocomplete: 'off', enterkeyhint: 'done' });
  const seg = el('div', { class: 'seg3' }, ['mm', 'pol', 'cm'].map(u => el('button', { class: u === CONV.unit ? 'on' : '', onclick: () => {
    // mantém a medida ao trocar a unidade
    const mm = toMM(); CONV.unit = u; lsSet('manuais.cvu', u);
    if (isFinite(mm)) CONV.val = u === 'mm' ? fmtN(mm, 2) : u === 'cm' ? fmtN(mm / 10, 3) : frac(mm / IN).replace('"', '');
    renderConv();
  } }, u === 'pol' ? 'pol (")' : u)));
  const res = el('div');
  const toMM = () => { const v = CONV.unit === 'pol' ? parseIn(CONV.val) * IN : parseFloat(String(CONV.val).replace(',', '.')) * (CONV.unit === 'cm' ? 10 : 1); return v; };
  const draw = () => {
    res.innerHTML = '';
    const mm = toMM();
    if (!isFinite(mm) || mm <= 0) { res.append(el('div', { class: 'muted small', style: 'margin:4px 2px' }, CONV.unit === 'pol' ? 'Digite em polegada: 3/4, 1 1/8, 0,75…' : 'Digite a medida.')); return; }
    const inch = mm / IN;
    const grid = el('div', { class: 'cv-res' },
      el('div', { class: 'cv-box' }, el('div', { class: 'k' }, 'Milímetro'), el('div', { class: 'v' }, fmtN(mm, 2) + ' mm')),
      el('div', { class: 'cv-box' }, el('div', { class: 'k' }, 'Polegada (fração)'), el('div', { class: 'v' }, frac(inch))),
      el('div', { class: 'cv-box' }, el('div', { class: 'k' }, 'Polegada (decimal)'), el('div', { class: 'v' }, fmtN(inch, 4) + '"')),
      el('div', { class: 'cv-box' }, el('div', { class: 'k' }, 'Centímetro'), el('div', { class: 'v' }, fmtN(mm / 10, 3) + ' cm')));
    // chave equivalente
    const imp = W_IN.map(t => ({ t: t + '"', mm: parseIn(t) * IN })), met = W_MM.map(v => ({ t: fmtN(v, 1) + ' mm', mm: v }));
    const near = (list) => list.reduce((b, x) => (Math.abs(x.mm - mm) < Math.abs(b.mm - mm) ? x : b));
    const mk = (title, w) => {
      const d = w.mm - mm, [cls, txt] = fitTxt(d);
      return el('div', { class: 'cv-box wide' }, el('div', { class: 'k' }, title),
        el('div', { class: 'v' }, w.t, el('span', { class: 'muted', style: 'font-size:15px;font-weight:600' }, `  (${fmtN(w.mm, 2)} mm · ${d >= 0 ? '+' : ''}${fmtN(d, 2)} mm)`)),
        el('div', { class: 'fit ' + cls }, txt));
    };
    grid.append(mk('Chave em polegada mais próxima', near(imp)), mk('Chave em milímetro mais próxima', near(met)));
    res.append(grid);
  };
  inp.addEventListener('input', () => { CONV.val = inp.value; draw(); });
  box.append(seg, el('div', { class: 'cv-in' }, inp), res);
  // atalhos de chave
  const quick = CONV.unit === 'pol' ? ['1/4', '5/16', '3/8', '7/16', '1/2', '9/16', '5/8', '11/16', '3/4', '13/16', '7/8', '15/16', '1', '1 1/16', '1 1/8', '1 1/4'] : [8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 30];
  box.append(el('h3', { class: 'sec' }, 'Atalhos'), el('div', { class: 'keys' }, quick.map(q => el('button', { onclick: () => { CONV.val = String(q); inp.value = CONV.val; draw(); } }, CONV.unit === 'pol' ? q + '"' : q + (CONV.unit === 'cm' ? '' : '')))));
  // tabela de chaves
  box.append(el('h3', { class: 'sec' }, 'Tabela de chaves mm × pol'));
  const tb = el('table', { class: 'cvt' }, el('tr', {}, el('th', {}, 'mm'), el('th', {}, 'pol mais próxima'), el('th', {}, 'diferença')));
  for (const v of W_MM) {
    const w = W_IN.map(t => ({ t, mm: parseIn(t) * IN })).reduce((b, x) => (Math.abs(x.mm - v) < Math.abs(b.mm - v) ? x : b));
    const d = w.mm - v, [cls, txt] = fitTxt(d);
    tb.append(el('tr', { onclick: () => { CONV.unit = 'mm'; CONV.val = String(v).replace('.', ','); renderConv(); $('#convBody').scrollTop = 0; } },
      el('td', {}, el('b', {}, fmtN(v, 1))), el('td', {}, w.t + '"'), el('td', { class: 'fit ' + cls }, `${d >= 0 ? '+' : ''}${fmtN(d, 2)} mm ${txt.split(' ')[0]}`)));
  }
  box.append(tb, el('p', { class: 'muted small' }, '✔ serve: diferença até 0,15 mm · ≈ pode servir, teste antes · ✖ não use (risco de espanar a cabeça do parafuso).'));
  draw();
  if (!CONV.val) setTimeout(() => inp.focus(), 100);
}

// ---------------------------------------------------------------------
//  Checklist
// ---------------------------------------------------------------------
// Modelos de checklist. Para incluir novos, é só acrescentar aqui.
const CHECKLISTS = [
  {
    id: 'mhc80-rota-ligada', brand: 'Loram', machine: 'MHC80', title: 'Rota Ligada', cond: 'MOTOR DIESEL LIGADO', partial: true,
    items: [
      [1, 'Segurança', 'Freio manual', 'Aplicar freio manual. +F157:M163', 'Freio manual acionado e volante travado.', 'Diário'],
      [2, 'Segurança', 'Calço', 'Calçar roda.', 'Calçar máquina de acordo com procedimento específico.', 'Diário'],
      [3, 'Mecânico', 'Correia de piso', 'Inspecionar correia da esteira de piso quanto ao funcionamento', 'Correia funcionando corretamente, sem nenhum dano, ruptura, rasgos ou rebites ausentes.', 'Diário'],
      [4, 'Mecânico', 'Correia de transferência', 'Inspecionar correia da esteira de transferência quanto ao funcionamento', 'Correia funcionando corretamente, sem nenhum dano, ruptura, rasgos ou rebites ausentes.', 'Diário'],
      [5, 'Mecânico', 'Correia de piso', 'Lubrificar corrente da esteira do piso', 'Corrente devidamente lubrificada.', 'Diário'],
      [6, 'Mecânico', 'Esteiras', 'Inspecionar rolamentos traseiros', 'Rolamentos não gastos, sem sobreaquecimento, sem ruídos incomuns, parafusos apertados.', 'Semanal'],
      [7, 'Mecânico', 'Correia de piso', 'Inspeção de rodas dentadas, dianteiras e traseiras', 'Rodas dentadas sem rachadura, quebra ou parafusos ausentes.', 'Mensal'],
      [8, 'Mecânico', 'Correia de transferência', 'Ajuste e inspeção do raspador da correia de transferência', 'Raspador bem ajustado com a correia em funcionamento.', 'Mensal'],
      [9, 'Mecânico', 'Correia de transferência', 'Rastreamento da correia', 'Correia alinhada.', 'Mensal'],
      [10, 'Mecânico', 'Correia de transferência', 'Inspeção de polias e rolamentos', 'Rolamento e polia sem acúmulo de detritos ou rachaduras. Rolamento lubrificado.', 'Mensal'],
      [11, 'Mecânico', 'Correia de piso', 'Ajuste e inspeção do raspador da correia de piso', 'Raspador bem ajustado com a correia em funcionamento.', 'Mensal'],
    ].map(([seq, sis, sub, at, esp, esc]) => ({ seq, sis, sub, at, esp, esc })),
  },
];
const LS_CKD = 'manuais.ck.draft', LS_CKH = 'manuais.ck.hist';
const RES = { ok: 'Ok', nok: 'Não Ok', na: 'Não se aplica' };
const today = () => new Date().toLocaleDateString('pt-BR');
function newRun(tpl) {
  return { id: uid(), tpl: tpl.id, date: today(), started: Date.now(), maq: '', resp: AUTH.name && AUTH.name !== 'Administrador' ? AUTH.name : '', esc: ['Diário'], ans: {} };
}
const tplOf = id => CHECKLISTS.find(t => t.id === id);
const drafts = () => lsGet(LS_CKD, {});
const saveDraft = r => { const d = drafts(); d[r.tpl] = r; lsSet(LS_CKD, d); };

function renderCheck() {
  const box = $('#checkBody'); box.innerHTML = '';
  const d = drafts();
  const open = Object.values(d).filter(r => tplOf(r.tpl));
  if (open.length) {
    box.append(el('h3', { class: 'sec' }, 'Em andamento'));
    for (const r of open) {
      const t = tplOf(r.tpl), n = Object.keys(r.ans).length;
      box.append(el('button', { class: 'row', onclick: () => go({ s: 'checkrun', tpl: r.tpl }) },
        el('div', { class: 'main' }, el('div', { class: 't' }, `${t.machine} · ${t.title}`), el('div', { class: 's' }, `${r.maq || 'sem nº da máquina'} · ${r.date} · ${n} respondido(s)`)),
        el('div', { class: 'pg' }, '›')));
    }
  }
  box.append(el('h3', { class: 'sec' }, 'Novo checklist'));
  const machines = [...new Set(CHECKLISTS.map(t => t.brand + ' · ' + t.machine))];
  for (const m of machines) {
    for (const t of CHECKLISTS.filter(t => t.brand + ' · ' + t.machine === m)) {
      box.append(el('button', { class: 'row', onclick: () => {
        const cur = drafts()[t.id];
        if (cur && Object.keys(cur.ans).length && !confirm('Já existe um checklist desta rota em andamento. Começar um novo e descartar o atual?')) return go({ s: 'checkrun', tpl: t.id });
        saveDraft(newRun(t)); go({ s: 'checkrun', tpl: t.id });
      } },
        el('div', { class: 'main' }, el('div', { class: 't' }, `${m} — ${t.title}`), el('div', { class: 's' }, `Condição: ${t.cond} · ${t.items.length} itens${t.partial ? ' · exemplo parcial' : ''}`)),
        el('div', { class: 'pg' }, '＋')));
    }
  }
  const hist = lsGet(LS_CKH, []);
  if (hist.length) {
    box.append(el('h3', { class: 'sec' }, 'Últimos feitos'));
    for (const r of hist.slice(0, 15)) {
      const t = tplOf(r.tpl); if (!t) continue;
      const nok = Object.values(r.ans).filter(a => a.r === 'nok').length;
      box.append(el('button', { class: 'row', onclick: () => summarySheet(r, true) },
        el('div', { class: 'main' }, el('div', { class: 't' }, `${t.machine} · ${t.title}`, nok ? el('span', { class: 'badge red' }, `${nok} não ok`) : el('span', { class: 'badge ok' }, 'tudo ok')),
          el('div', { class: 's' }, `${r.maq || '—'} · ${r.date} · ${r.resp || ''}`)), el('div', { class: 'pg' }, '›')));
    }
  }
  box.append(el('div', { class: 'note' }, 'O checklist fica salvo no celular, mesmo sem internet. Ao terminar, use o resumo para passar para a folha (frente: Ok/Não ok de cada item; verso: as falhas).'));
}

let CR = null;
function renderCheckRun(st) {
  const t = tplOf(st.tpl); if (!t) return history.back();
  CR = drafts()[t.id] || newRun(t); saveDraft(CR);
  $('#crTitle').textContent = `${t.machine} · ${t.title}`;
  $('#crSub').textContent = `Condição: ${t.cond}`;
  const box = $('#crBody'); box.innerHTML = '';
  const maq = el('input', { value: CR.maq, placeholder: 'ex.: MHC 05', oninput: e => { CR.maq = e.target.value; saveDraft(CR); } });
  const resp = el('input', { value: CR.resp, placeholder: 'seu nome', oninput: e => { CR.resp = e.target.value; saveDraft(CR); } });
  box.append(el('div', { class: 'ck-meta' }, el('div', {}, el('label', {}, 'Nº / prefixo da máquina'), maq), el('div', {}, el('label', {}, 'Responsável'), resp)));
  const escs = [...new Set(t.items.map(i => i.esc))];
  const seg = el('div', { class: 'chips', style: 'padding:0 0 8px' }, el('span', { class: 'muted small', style: 'align-self:center' }, 'Fazer hoje:'),
    escs.map(e => el('button', { class: 'chip' + (CR.esc.includes(e) ? ' on' : ''), onclick: () => {
      CR.esc = CR.esc.includes(e) ? CR.esc.filter(x => x !== e) : [...CR.esc, e]; saveDraft(CR); renderCheckRun(st);
    } }, e)));
  box.append(seg);
  if (t.partial) box.append(el('div', { class: 'note' }, 'Modelo de exemplo (itens 1 a 11 da folha). Quando chegar a folha completa, os demais itens entram aqui.'));
  const items = t.items.filter(i => CR.esc.includes(i.esc));
  for (const it of items) box.append(ckItem(it));
  const hidden = t.items.length - items.length;
  if (hidden) box.append(el('div', { class: 'muted small', style: 'text-align:center;margin:8px' }, `${hidden} item(ns) de outro escopo escondido(s) — marque em "Fazer hoje" para mostrar.`));
  updateCrSum(t);
}
function ckItem(it) {
  const a = CR.ans[it.seq] || {};
  const card = el('div', { class: 'ck-item ' + (a.r || '') });
  const set = r => {
    if (CR.ans[it.seq]?.r === r) delete CR.ans[it.seq];
    else CR.ans[it.seq] = { ...(CR.ans[it.seq] || {}), r };
    saveDraft(CR); card.replaceWith(ckItem(it)); updateCrSum(tplOf(CR.tpl));
  };
  card.append(el('div', { class: 'ck-head' }, el('div', { class: 'ck-seq' }, it.seq),
    el('div', { style: 'flex:1;min-width:0' },
      el('div', { class: 'muted small' }, `${it.sis} › ${it.sub} `, el('span', { class: 'tag' }, it.esc)),
      el('div', { class: 'ck-at' }, it.at),
      el('div', { class: 'ck-exp' }, 'Esperado: ' + it.esp))));
  card.append(el('div', { class: 'ck-btns' },
    el('button', { class: 'b-ok' + (a.r === 'ok' ? ' on' : ''), onclick: () => set('ok') }, '✔ Ok'),
    el('button', { class: 'b-nok' + (a.r === 'nok' ? ' on' : ''), onclick: () => set('nok') }, '✖ Não ok'),
    el('button', { class: 'b-na' + (a.r === 'na' ? ' on' : ''), onclick: () => set('na') }, 'N/A')));
  if (a.r === 'nok') {
    const f = (k, label, ph, ta) => {
      const inp = el(ta ? 'textarea' : 'input', { rows: ta ? 2 : null, placeholder: ph, oninput: e => { CR.ans[it.seq][k] = e.target.value; saveDraft(CR); } });
      inp.value = a[k] || ''; return el('div', {}, el('label', {}, label), inp);
    };
    card.append(el('div', { class: 'ck-fail' },
      f('falha', 'Falha encontrada', 'ex.: raspador danificado', true),
      f('acao', 'Ação corretiva', 'ex.: troca do raspador', true),
      f('mat', 'Material', 'ex.: 241920 (1 un)')));
  }
  return card;
}
function updateCrSum(t) {
  const items = t.items.filter(i => CR.esc.includes(i.esc));
  const done = items.filter(i => CR.ans[i.seq]).length, nok = items.filter(i => CR.ans[i.seq]?.r === 'nok').length;
  $('#crSum').textContent = `${done} de ${items.length} respondidos` + (nok ? ` · ${nok} não ok` : '');
}
$('#crDone').onclick = () => CR && summarySheet(CR, false);

function summaryText(r) {
  const t = tplOf(r.tpl);
  const items = t.items.filter(i => r.ans[i.seq]);
  const fails = items.filter(i => r.ans[i.seq].r === 'nok');
  let s = `*Checklist ${t.machine} — ${t.title}* (${t.cond})\nMáquina: ${r.maq || '—'} · Data: ${r.date} · Resp.: ${r.resp || '—'}\n\n`;
  s += items.map(i => `${i.seq}. ${i.sub}: ${RES[r.ans[i.seq].r]}`).join('\n');
  if (fails.length) s += '\n\n*Falhas encontradas*\n' + fails.map(i => { const a = r.ans[i.seq]; return `Seq ${i.seq} — ${a.falha || '?'} → ${a.acao || '?'} · Material: ${a.mat || '—'}`; }).join('\n');
  return s;
}
function summarySheet(r, fromHist) {
  const t = tplOf(r.tpl);
  const vis = t.items.filter(i => (r.esc || []).includes(i.esc));
  const missing = vis.filter(i => !r.ans[i.seq]);
  const fails = vis.filter(i => r.ans[i.seq]?.r === 'nok');
  const front = el('table', { class: 'sheet-tbl' }, el('tr', {}, el('th', {}, 'Seq'), el('th', {}, 'Subsistema'), el('th', {}, 'Resultado'), el('th', {}, 'Escopo')),
    t.items.filter(i => r.ans[i.seq]).map(i => el('tr', {}, el('td', {}, i.seq), el('td', {}, i.sub), el('td', { class: r.ans[i.seq].r === 'nok' ? 'fit no' : r.ans[i.seq].r === 'ok' ? 'fit ok' : '' }, RES[r.ans[i.seq].r]), el('td', {}, i.esc))));
  const back = fails.length ? el('table', { class: 'sheet-tbl' }, el('tr', {}, el('th', {}, 'Seq'), el('th', {}, 'Falha encontrada'), el('th', {}, 'Ação corretiva'), el('th', {}, 'Material')),
    fails.map(i => { const a = r.ans[i.seq]; return el('tr', {}, el('td', {}, i.seq), el('td', {}, a.falha || '—'), el('td', {}, a.acao || '—'), el('td', {}, a.mat || '—')); }))
    : el('p', { class: 'muted' }, 'Nenhuma falha (nada para o verso).');
  const txt = summaryText(r);
  openSheet(el('div', {},
    el('h4', {}, 'Resumo para a folha'),
    el('div', { class: 'muted small' }, `${t.machine} · ${t.title} · ${r.maq || '—'} · ${r.date}`),
    missing.length && !fromHist ? el('div', { class: 'note', style: 'color:var(--accent2)' }, `Faltam ${missing.length} item(ns): ${missing.map(i => i.seq).join(', ')}`) : null,
    el('label', {}, 'FRENTE — resultado de cada item'), front,
    el('label', {}, 'VERSO — registro de falhas (atividades corretivas)'), back,
    el('div', { class: 'acts' },
      el('button', { class: 'ok', onclick: async () => {
        if (navigator.share) { try { await navigator.share({ text: txt }); return; } catch {} }
        window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank');
      } }, '📤 Compartilhar'),
      el('button', { onclick: () => copyText(txt) }, 'Copiar texto'),
      fromHist ? null : el('button', { class: 'ok', onclick: () => {
        if (missing.length && !confirm(`Ainda faltam ${missing.length} item(ns). Concluir assim mesmo?`)) return;
        const h = lsGet(LS_CKH, []); h.unshift({ ...r, done: Date.now() }); lsSet(LS_CKH, h.slice(0, 50));
        const d = drafts(); delete d[r.tpl]; lsSet(LS_CKD, d);
        closeSheet(); toast('Checklist concluído e salvo no histórico'); history.back();
      } }, '✔ Concluir'),
      el('button', { onclick: closeSheet }, 'Fechar'))));
}

// ---------------------------------------------------------------------
//  Início
// ---------------------------------------------------------------------
let started = false;
async function startApp() {
  $('#btnAdmin').hidden = !AUTH.admin;
  if (!started) {
    started = true;
    try { S.docs = await dbAll('docs'); }
    catch (e) { toast('Erro ao abrir o banco de dados: ' + e.message, 8000); S.docs = []; }
    for (const d of S.docs) { d.favs ||= []; d.catFix ||= {}; delete d.textFail; } // tenta de novo a cada abertura
    loadTexts(S.docs.filter(d => d.textDone).map(d => d.id)).catch(() => {});
    refreshCloud();
  }
  history.replaceState({ s: 'home' }, '');
  route({ s: 'home' });
  indexQueue();
}
async function boot() {
  if (!AUTH.token) { showLogin(); return; }
  await startApp();
  sync();
}
boot();

// modo offline + atualização
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão do app instalada. Feche e abra o app para usar.', 6000);
        }
      });
    });
  }).catch(e => console.warn('SW', e));
}
// para testes
window.__app = { S, V, findCode, parseIn, frac, get AUTH() { return AUTH; }, sync };
