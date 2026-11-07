// =====================================================================
//  Manuais — app para consultar manuais de manutenção no celular
//  Tudo fica salvo no próprio aparelho (IndexedDB). Nada é enviado.
// =====================================================================
import * as pdfjsLib from './lib/pdf.min.mjs';

const APP_VERSION = '2.2.0';
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
const saveDoc = d => dbPut('docs', d);

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
const fmtMB = b => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';

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
const docById = id => S.docs.find(d => d.id === id);

// ---------------------------------------------------------------------
//  PDF
// ---------------------------------------------------------------------
const pdfCache = new Map();
function getPdf(id) {
  if (pdfCache.has(id)) { const p = pdfCache.get(id); pdfCache.delete(id); pdfCache.set(id, p); return p; }
  const p = (async () => {
    const blob = await dbGet('files', id);
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
  const walk = async (items, prefix) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i], id = prefix ? prefix + '.' + i : String(i);
      const n = { id, t: (it.title || '').replace(/\s+/g, ' ').trim() || '(sem título)', p: await pageOf(it.dest) };
      if (it.items?.length) n.c = await walk(it.items, id);
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
const G_MAN = 'MHC80 — Manuais', G_TRE = 'MHC — Treinamento', G_ESQ = 'MHC — Esquemas';
const CATALOG = [
  [/corrective.?maintenance|manuten..o.?corretiva/i, 'Manutenção Corretiva', G_MAN, 10],
  [/preventive.?maintenance|manuten..o.?preventiva/i, 'Manutenção Preventiva', G_MAN, 11],
  [/operator.?manual|manual.?de.?opera/i, 'Manual de Operação', G_MAN, 12],
  [/lockout|intertravamento/i, 'Intertravamento (Bloqueio e Etiquetagem)', G_MAN, 13, 'Segurança'],
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
  [/EL.?TRICO.?HIDR/i, 'Esquema Elétrico / Hidráulico', G_ESQ, 41, 'Elétrica'],
  [/^AR.?ESQUEM|ESQUEM.{0,6}AR\b/i, 'Esquema Pneumático (Ar)', G_ESQ, 40, 'Pneumática'],
  [/HIDR.?ULICO.?ESQUEM/i, 'Esquema Hidráulico', G_ESQ, 42, 'Hidráulica'],
];
function fromCatalog(file) {
  for (const [re, name, group, order, cat] of CATALOG) if (re.test(file)) return { name, group, order, cat };
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
  const r = await fetch('api/' + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, cache: 'no-store' });
  if (opts.raw && r.ok) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Erro ' + r.status); e.status = r.status; e.data = data; throw e; }
  return data;
}

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

async function wipeAll(reason) {
  closeViewer(true);
  for (const d of [...S.docs]) await removeLocalDoc(d).catch(() => {});
  S.docs = []; S.texts.clear();
  AUTH = {}; lsSet(LS_AUTH, null);
  showLogin(reason, true);
}

// confere se o acesso continua válido (quando tem internet)
async function checkAccess() {
  try {
    const r = await api('me');
    AUTH.lastOk = Date.now(); AUTH.admin = r.admin; AUTH.name = r.name; lsSet(LS_AUTH, AUTH);
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
    navigator.storage?.persist?.().catch(() => {});
    const byRid = new Map(S.docs.filter(d => d.rid).map(d => [d.rid, d]));
    // removidos da nuvem → sai do aparelho
    for (const d of S.docs.filter(d => d.rid && !remote.some(r => r.rid === d.rid))) await removeLocalDoc(d);
    // nome/grupo mudou → só atualiza
    for (const r of remote) {
      const d = byRid.get(r.rid);
      if (d && d.sha === r.sha && (d.name !== r.name || d.group !== r.group || d.order !== r.order || d.cat !== r.cat)) {
        Object.assign(d, { name: r.name, group: r.group, order: r.order, cat: r.cat, _cats: null }); await saveDoc(d);
      }
    }
    const todo = remote.filter(r => byRid.get(r.rid)?.sha !== r.sha).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    if (!todo.length) { if (manual) toast('Manuais em dia ✔'); return; }
    const total = todo.reduce((a, r) => a + r.size, 0); let done = 0;
    for (let k = 0; k < todo.length; k++) {
      const r = todo[k];
      const chunks = [];
      for (let i = 0; i < r.parts; i++) {
        syncBar(`Baixando manuais ${k + 1} de ${todo.length} · ${fmtMB(done)} de ${fmtMB(total)}`, done / total);
        const res = await api(`file/${r.rid}/${r.sha}/${i}`, { raw: true });
        const b = await res.blob(); chunks.push(b); done += b.size;
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
    toast('Download interrompido: ' + (e.status ? e.message : 'sem internet') + '. Toque em ⟳ para continuar.', 6000);
  } finally {
    syncing = false; syncBar(null);
    if ($('#home').classList.contains('active')) renderHome(true);
    indexQueue();
  }
}
$('#btnSync').onclick = () => sync(true);
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
      const t = pageTitle([...lines.entries()].map(([y, L]) => ({ y, t: L.t.replace(/\s+/g, ' ').trim(), s: L.s })).filter(l => l.t), page.view[3] - page.view[1]);
      if (t) rec.heads.push({ p, t });
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
    S.texts.delete(d.id);
    renderAfterIndex(d);
  } catch (err) {
    console.error('indexação', err);
    d.textFail = String(err.message || err);
    await saveDoc(d).catch(() => {});
  }
}

// Descobre o título de uma página. Funciona com slides exportados do
// PowerPoint (título em cima, número do slide, anotações embaixo) e com
// páginas comuns (primeira linha em letra bem maior que o resto).
function pageTitle(lines, h) {
  lines.sort((a, b) => b.y - a.y);
  const num = lines.find(l => /^\d{1,3}$/.test(l.t) && l.s <= 10 && l.y > h * 0.35 && l.y < h * 0.75);
  let region = num ? lines.filter(l => l.y > num.y + 2) : lines.filter(l => l.y > h * 0.6);
  region = region.filter(l => !/^\d{1,3}$/.test(l.t) && /[a-zA-ZÀ-ú]{2}/.test(l.t));
  if (!region.length) return null;
  const sizes = lines.map(l => l.s).sort((a, b) => a - b), median = sizes[Math.floor(sizes.length / 2)];
  const max = Math.max(...region.map(l => l.s));
  if (!num && (max < median * 1.25 || region[0].s < max)) return null;
  if (max < 12) return null;
  // junta as linhas seguidas do título (título em 2 linhas)
  const first = region.findIndex(l => l.s === max);
  const parts = [region[first]];
  for (let i = first + 1; i < region.length && parts.length < 3; i++) {
    const l = region[i], prev = parts[parts.length - 1];
    if (l.s === max && prev.y - l.y < max * 1.8) parts.push(l); else break;
  }
  const t = parts.map(l => l.t).join(' ').replace(/\s+/g, ' ').trim();
  return t.length >= 3 && t.length <= 90 && /^[A-ZÀ-Ý0-9"“(]/.test(t) && !/[.:;]$/.test(t) ? t : null;
}

function autoOutline(rec) {
  const base = t => norm(t).replace(/[,;.\s]*\(?(cont\.?|continua..o|continued)\)?\s*$/i, '').trim();
  // cabeçalhos que se repetem em muitas páginas não servem
  const freq = {};
  for (const h of rec.heads) freq[base(h.t)] = (freq[base(h.t)] || 0) + 1;
  const lim = Math.max(4, rec.pages.length * 0.2);
  const out = []; let last = null;
  for (const h of rec.heads) {
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
  const docs = onlyId ? [docById(onlyId)] : S.docs;
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
  const pending = (onlyId ? [docById(onlyId)] : S.docs).filter(d => !d.textDone);
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
  if (!topics.length && !pages.length) {
    box.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🔎'), `Nada encontrado para “${q}”.`));
  }
  if (pending.length) box.append(el('div', { class: 'note' }, `Ainda preparando a busca dentro do texto de: ${pending.map(d => d.name).join(', ')}. Os resultados vão aparecer quando terminar.`));
  const scanned = (onlyId ? [docById(onlyId)] : S.docs).filter(d => d.scanned);
  if (scanned.length) box.append(el('div', { class: 'note' }, `Sem texto pesquisável (PDF escaneado): ${scanned.map(d => d.name).join(', ')}. Neles a busca só encontra o sumário e as páginas salvas.`));
}

// ---------------------------------------------------------------------
//  Navegação (o botão voltar do Android funciona)
// ---------------------------------------------------------------------
function show(id) {
  const prev = document.querySelector('.screen.active');
  if (prev) S.scroll[prev.id] = prev.querySelector('.body')?.scrollTop || 0;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
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

function renderChips() {
  const have = new Set();
  for (const d of S.docs) for (const c of docCats(d).values()) have.add(c);
  const list = ['Todos', ...CAT_ORDER.filter(c => have.has(c))];
  if (!list.includes(S.cat)) S.cat = 'Todos';
  const box = $('#chips'); box.innerHTML = '';
  box.hidden = S.docs.length === 0;
  for (const c of list) box.append(el('button', { class: 'chip' + (c === S.cat ? ' on' : ''), onclick: () => { S.cat = c; S.scroll.home = 0; renderHome(); $('#homeBody').scrollTop = 0; } }, c));
}

function renderHome(keepScroll) {
  const y = $('#homeBody').scrollTop;
  renderChips();
  const box = $('#homeBody'); box.innerHTML = '';
  if (!S.docs.length) {
    box.append(el('div', { class: 'empty' },
      el('div', { class: 'big' }, '📚'),
      AUTH.admin
        ? el('p', { html: 'Nenhum manual na nuvem ainda.<br>Toque em <b>Painel</b> → <b>Enviar PDFs</b> para publicar os manuais para a equipe.' })
        : el('p', { html: 'Os manuais vão baixar automaticamente quando houver internet.<br>Toque em <b>⟳</b> para tentar agora.<br><br>Depois de baixados, funcionam <b>sem internet</b>.' })));
    return;
  }
  if (S.q.trim()) { renderSearch(box, S.q); return; }
  if (S.cat !== 'Todos') { renderCategory(box, S.cat); if (keepScroll) box.scrollTop = y; return; }

  // Continuar lendo
  const recent = S.docs.filter(d => d.opened).sort((a, b) => b.opened - a.opened).slice(0, 3);
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
  const favs = S.docs.flatMap(d => d.favs.map(f => ({ d, f })));
  if (favs.length) {
    box.append(el('h3', { class: 'sec' }, 'Favoritos'));
    for (const { d, f } of favs.sort((a, b) => (b.f.at || 0) - (a.f.at || 0)).slice(0, 12))
      box.append(el('button', { class: 'row', onclick: () => openViewer(d.id, f.p) },
        el('div', { class: 'main' }, el('div', { class: 't' }, '⭐ ' + f.t), el('div', { class: 's' }, d.name)),
        el('div', { class: 'pg' }, 'p. ' + f.p)));
  }
  // Manuais por grupo
  const groups = new Map();
  for (const d of [...S.docs].sort(byOrder)) {
    const g = d.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d);
  }
  const gOrd = g => Math.min(...groups.get(g).map(d => d.order ?? 999));
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || gOrd(a) - gOrd(b) || a.localeCompare(b, 'pt'));
  for (const g of names) {
    box.append(el('h3', { class: 'sec' }, g || (names.length > 1 ? 'Outros' : 'Manuais')));
    const grid = el('div', { class: 'grid' });
    for (const d of groups.get(g)) grid.append(docCard(d));
    box.append(grid);
  }
  footer(box);
  if (keepScroll) box.scrollTop = y;
}

function byOrder(a, b) { return (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'pt', { numeric: true }); }
function docCard(d) {
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
    f.textContent = `${S.docs.length} manuais · ${fmtMB(total)}` + (est?.quota ? ` · espaço livre p/ o app: ${fmtMB(est.quota - est.usage)}` : '') + ` · v${APP_VERSION}`;
  } catch {}
}

function renderCategory(box, cat) {
  let any = false;
  for (const d of [...S.docs].sort(byOrder)) {
    const cats = docCats(d);
    const roots = [];
    const walk = (nodes, parentCat) => { for (const n of nodes) { const c = cats.get(n.id); if (c === cat && parentCat !== cat) roots.push(n); else if (n.c) walk(n.c, c); } };
    walk(outlineOf(d), null);
    if (!roots.length) continue;
    any = true;
    box.append(el('h3', { class: 'sec' }, d.name));
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
    box.append(el('div', { class: 'note', html: d.textDone
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

function openViewer(id, page, q) { go({ s: 'viewer', id, p: page || 1, q: q || '' }); }

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
    `Os manuais baixam sozinhos (use Wi-Fi). O código é pessoal e funciona em até ${c.max} celular${c.max > 1 ? 'es' : ''}. Não repasse.`;
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
  for (const r of [...ADM.docs].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'pt'))) {
    const local = S.docs.find(d => d.rid === r.rid);
    box.append(el('button', { class: 'row', onclick: () => local ? editDocSheet(local) : toast('Este manual ainda está baixando neste aparelho') },
      el('div', { class: 'main' }, el('div', { class: 't' }, r.name), el('div', { class: 's' }, `${r.group || 'sem grupo'} · ${fmtMB(r.size)}${r.pages ? ' · ' + r.pages + ' pág.' : ''}`)),
      el('div', { class: 'pg' }, '⋯')));
  }
  box.append(el('div', { class: 'empty small', style: 'padding:20px 0 0' }, `Endereço do app: ${appUrl()}`));
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
      if (old && old.sha === sha) { sent += f.size; status.textContent = `${f.name}: já está na nuvem`; continue; }
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
      const meta = { rid, sha, file: f.name, name: old?.name || known.name, group: old?.group ?? known.group, order: old?.order ?? known.order, cat: old?.cat ?? known.cat };
      const doc = await addPdfBlob(new Blob([buf], { type: 'application/pdf' }), meta);
      if (localOld) { doc.favs = localOld.favs; doc.lastPage = localOld.lastPage; await saveDoc(doc); await removeLocalDoc(localOld); }
      const r = await api('admin/doc', { json: { rid, sha, parts, size: f.size, file: f.name, name: doc.name, group: doc.group, order: doc.order ?? null, cat: doc.cat ?? null, pages: doc.pages } });
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
window.__app = { S, V, findCode, get AUTH() { return AUTH; }, sync };
