// =====================================================================
//  Servidor do app Manuais (Cloudflare Pages Functions)
//
//  Precisa de, nas configurações do projeto no Cloudflare:
//    - KV namespace ligado com o nome  DB
//    - Variável secreta  ADMIN_CODE  (código do administrador)
//    - Variável secreta  SECRET      (texto aleatório longo, para assinar)
//
//  Guarda no KV:
//    code:<CÓDIGO>          dados de cada acesso (nome, celulares, bloqueio)
//    docs                   lista de manuais publicados
//    part:<rid>:<sha>:<i>   pedaços dos PDFs (até 20 MB cada)
// =====================================================================

const DAY = 86400000;
const enc = new TextEncoder();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);

function b64url(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I/L
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return 'ANDSL' + [...r].map(x => ALPHA[x % ALPHA.length]).join('');
}
const fmtCode = c => c.startsWith('ANDSL') ? 'AND-SL-' + c.slice(5) : c.startsWith('MHC') ? 'MHC-' + c.slice(3) : c;
const getEntry = async (env, code) => env.DB.get('code:' + code, { type: 'json' });
const putEntry = (env, code, e) => env.DB.put('code:' + code, JSON.stringify(e));
const getDocs = async env => (await env.DB.get('docs', { type: 'json' })) || [];

// Onde ficam os pedaços dos PDFs: no R2 (binding FILES, 10 GB grátis) se
// estiver ligado; senão no KV (1 GB). Leitura procura nos dois.
async function partPut(env, key, body) {
  if (env.FILES) return env.FILES.put(key, body);
  return env.DB.put(key, body);
}
async function partGet(env, key) {
  if (env.FILES) { const o = await env.FILES.get(key); if (o) return o.body; }
  return env.DB.get(key, { type: 'stream' });
}
async function partDel(env, key) {
  if (env.FILES) await env.FILES.delete(key).catch(() => {});
  await env.DB.delete(key).catch(() => {});
}

// Quem está fazendo o pedido? (token: CÓDIGO.aparelho.assinatura)
async function whoIs(request, env) {
  const h = request.headers.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [code, dev, sig] = tok.split('.');
  if (!code || !dev || !sig) return { err: 'sem-token' };
  if (!sameText(sig, await hmac(env.SECRET, code + '|' + dev))) return { err: 'token-invalido' };
  if (code === 'ADMIN') return { admin: true, code, dev, name: 'Administrador' };
  const e = await getEntry(env, code);
  if (!e) return { err: 'revogado', revoked: true };
  if (e.blocked) return { err: 'revogado', revoked: true };
  if (!e.devices?.[dev]) return { err: 'revogado', revoked: true };
  return { code, dev, entry: e, name: e.name };
}

function deviceLabel(ua = '') {
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return 'Android · ' + m[1].replace(/ Build.*/, '').trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Windows/.test(ua)) return 'Computador Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  return 'Aparelho';
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB || !env.SECRET || !env.ADMIN_CODE) return fail('Servidor não configurado (falta DB, SECRET ou ADMIN_CODE).', 500);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;
  try {
    // ---------------- entrar com o código ----------------
    if (path[0] === 'login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const code = cleanCode(body.code);
      const dev = String(body.deviceId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
      if (!code || dev.length < 8) return fail('Digite o código.');
      const ua = request.headers.get('user-agent') || '';
      if (sameText(code, cleanCode(env.ADMIN_CODE))) {
        return json({ token: `ADMIN.${dev}.${await hmac(env.SECRET, 'ADMIN|' + dev)}`, name: 'Administrador', admin: true, func: 'all' });
      }
      const e = await getEntry(env, code);
      if (!e) { await new Promise(r => setTimeout(r, 700)); return fail('Código não encontrado. Confira com o responsável.', 403); }
      if (e.blocked) return fail('Este código foi bloqueado. Fale com o responsável.', 403);
      e.devices ||= {};
      if (!e.devices[dev]) {
        if (Object.keys(e.devices).length >= (e.max || 1)) {
          e.attempts = [{ at: Date.now(), label: deviceLabel(ua) }, ...(e.attempts || [])].slice(0, 10);
          await putEntry(env, code, e);
          return fail(`Este código já está em uso no limite de ${e.max || 1} celular(es). Fale com o responsável.`, 403);
        }
        e.devices[dev] = { label: String(body.label || deviceLabel(ua)).slice(0, 60), first: Date.now(), last: Date.now() };
        await putEntry(env, code, e);
      }
      return json({ token: `${code}.${dev}.${await hmac(env.SECRET, code + '|' + dev)}`, name: e.name, admin: false, func: e.func || 'mec' });
    }

    // daqui para baixo, só com token válido
    const who = await whoIs(request, env);
    if (who.err) return fail(who.err, who.revoked ? 403 : 401, { revoked: !!who.revoked });

    // ---------------- conferir acesso ----------------
    if (path[0] === 'me' && method === 'GET') {
      if (!who.admin) {
        const d = who.entry.devices[who.dev];
        if (Date.now() - (d.last || 0) > DAY / 4) { d.last = Date.now(); await putEntry(env, who.code, who.entry); }
      }
      return json({ ok: true, name: who.name, admin: !!who.admin, func: who.admin ? 'all' : (who.entry.func || 'mec'), storage: env.FILES ? 'R2' : 'KV' });
    }

    // ---------------- lista de manuais ----------------
    if (path[0] === 'docs' && method === 'GET') return json({ docs: await getDocs(env) });

    // ---------------- sumário automático (montado pelo app do admin) ----------------
    if (path[0] === 'auto' && method === 'GET' && path.length === 3) {
      const a = await env.DB.get(`auto:${path[1]}:${path[2]}`, { type: 'json' });
      if (!a) return fail('Sem sumário', 404);
      return json({ auto: a });
    }

    // ---------------- baixar pedaço de um manual ----------------
    if (path[0] === 'file' && method === 'GET' && path.length === 4) {
      const [, rid, sha, i] = path;
      const stream = await partGet(env, `part:${rid}:${sha}:${i}`);
      if (!stream) return fail('Arquivo não encontrado', 404);
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
    }

    // ---------------- checklists (cada pessoa envia os seus) ----------------
    //  ck:<CÓDIGO>:<id>  inspeção completa; o resumo vai no metadata para a lista do admin
    if (path[0] === 'ck' && path[1] === 'save' && method === 'POST') {
      const raw = await request.text();
      if (raw.length > 200000) return fail('Checklist grande demais.', 413);
      const i = JSON.parse(raw || '{}');
      const id = String(i.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (!id || !i.cat || !i.mhc) return fail('Checklist incompleto.');
      const st = i.sum || {};
      const meta = { n: String(who.name || '').slice(0, 60), m: String(i.mhc).slice(0, 6), c: String(i.cat).slice(0, 6), e: String(i.escopo || '').slice(0, 1),
        i: +i.inicio || 0, f: +i.fim || 0, u: +i.upd || Date.now(), ok: +st.ok || 0, nok: +st.nok || 0, na: +st.na || 0, tot: +st.tot || 0, falta: +st.falta || 0 };
      await env.DB.put(`ck:${who.code}:${id}`, JSON.stringify({ ...i, by: meta.n }), { metadata: meta });
      return json({ ok: true });
    }
    if (path[0] === 'ck' && path[1] === 'delete' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (id) await env.DB.delete(`ck:${who.code}:${id}`);
      return json({ ok: true });
    }

    // ================= ADMINISTRADOR =================
    if (path[0] !== 'admin') return fail('Rota desconhecida', 404);
    if (!who.admin) return fail('Somente o administrador.', 403);
    const what = path[1];

    // checklists da equipe: lista (só o resumo) e um completo
    if (what === 'ck' && method === 'GET' && path.length === 2) {
      const out = [];
      let cursor;
      do {
        const page = await env.DB.list({ prefix: 'ck:', cursor });
        for (const k of page.keys) { const [, code, id] = k.name.split(':'); out.push({ code, id, ...(k.metadata || {}) }); }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      out.sort((a, b) => (b.i || 0) - (a.i || 0));
      return json({ list: out });
    }
    if (what === 'ck' && method === 'GET' && path.length === 4) {
      const i = await env.DB.get(`ck:${cleanCode(path[2]) || 'ADMIN'}:${path[3].replace(/[^a-z0-9]/gi, '')}`, { type: 'json' });
      if (!i) return fail('Checklist não encontrado.', 404);
      return json({ insp: i });
    }

    if (what === 'codes' && method === 'GET') {
      const out = [];
      let cursor;
      do {
        const page = await env.DB.list({ prefix: 'code:', cursor });
        for (const k of page.keys) {
          const e = await env.DB.get(k.name, { type: 'json' });
          if (e) out.push({ code: k.name.slice(5), pretty: fmtCode(k.name.slice(5)), ...e });
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt'));
      return json({ codes: out });
    }
    if (what === 'codes' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name) return fail('Digite o nome da pessoa.');
      const max = Math.min(Math.max(parseInt(body.max, 10) || 1, 1), 5);
      let code;
      do { code = newCode(); } while (await getEntry(env, code));
      const func = ['mec','ele','all'].includes(body.func) ? body.func : 'mec'; // função: mec = mecânico, ele = eletricista, all = todos os checklists
      const e = { name, max, func, created: Date.now(), blocked: false, devices: {}, attempts: [] };
      await putEntry(env, code, e);
      return json({ code, pretty: fmtCode(code), ...e });
    }
    if (what === 'code' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const code = cleanCode(body.code);
      const e = await getEntry(env, code);
      if (!e) return fail('Código não existe.', 404);
      switch (body.action) {
        case 'block': e.blocked = true; break;
        case 'unblock': e.blocked = false; break;
        case 'reset': e.devices = {}; e.attempts = []; break;
        case 'removeDevice': delete e.devices[body.deviceId]; break;
        case 'setFunc': e.func = ['mec','ele','all'].includes(body.func) ? body.func : 'mec'; break;
        case 'setMax': e.max = Math.min(Math.max(parseInt(body.max, 10) || 1, 1), 5); break;
        case 'rename': e.name = String(body.name || e.name).trim().slice(0, 60); break;
        case 'delete': await env.DB.delete('code:' + code); return json({ ok: true, deleted: true });
        default: return fail('Ação desconhecida.');
      }
      await putEntry(env, code, e);
      return json({ ok: true, code, pretty: fmtCode(code), ...e });
    }

    // enviar um pedaço de PDF (corpo = bytes)
    if (what === 'part' && method === 'PUT') {
      const rid = (url.searchParams.get('rid') || '').replace(/[^a-z0-9-]/gi, '');
      const sha = (url.searchParams.get('sha') || '').replace(/[^a-f0-9]/gi, '');
      const i = parseInt(url.searchParams.get('i'), 10);
      if (!rid || !sha || !(i >= 0)) return fail('Parâmetros inválidos.');
      try { await partPut(env, `part:${rid}:${sha}:${i}`, request.body); }
      catch (e) {
        const m = String(e?.message || e);
        if (!env.FILES && /limit|quota|exceed|storage/i.test(m)) return fail('O cofre grátis (KV, 1 GB) encheu. Ative o R2 para caber todos os manuais — veja o passo a passo.', 507);
        throw e;
      }
      return json({ ok: true });
    }
    // publicar / atualizar dados de um manual
    if (what === 'doc' && method === 'POST') {
      const d = await request.json();
      if (!d?.rid || !d.sha || !(d.parts > 0)) return fail('Dados do manual incompletos.');
      const docs = await getDocs(env);
      const old = docs.find(x => x.rid === d.rid);
      const keep = { rid: d.rid, sha: d.sha, parts: d.parts, size: d.size, file: String(d.file || '').slice(0, 200), name: String(d.name || '').slice(0, 120),
        group: String(d.group || '').slice(0, 60), order: d.order ?? null, cat: d.cat || null, brand: d.brand ? String(d.brand).slice(0, 40) : null, pages: d.pages || null, at: Date.now() };
      if (old) {
        if (old.sha !== d.sha) for (let i = 0; i < old.parts; i++) await partDel(env, `part:${old.rid}:${old.sha}:${i}`);
        Object.assign(old, keep);
      } else docs.push(keep);
      await env.DB.put('docs', JSON.stringify(docs));
      return json({ ok: true, docs });
    }
    // guardar o sumário automático de um manual
    if (what === 'auto' && method === 'POST') {
      const d = await request.json();
      if (!d?.rid || !d.sha || !Array.isArray(d.auto)) return fail('Dados incompletos.');
      await env.DB.put(`auto:${d.rid}:${d.sha}`, JSON.stringify(d.auto));
      const docs = await getDocs(env);
      const old = docs.find(x => x.rid === d.rid);
      if (old && old.sha === d.sha && old.ha !== d.sha) { old.ha = d.sha; await env.DB.put('docs', JSON.stringify(docs)); }
      return json({ ok: true });
    }
    // só renomear / mudar grupo
    if (what === 'docmeta' && method === 'POST') {
      const d = await request.json();
      const docs = await getDocs(env);
      const old = docs.find(x => x.rid === d.rid);
      if (!old) return fail('Manual não encontrado.', 404);
      if (d.name != null) old.name = String(d.name).slice(0, 120);
      if (d.group != null) old.group = String(d.group).slice(0, 60);
      if (d.brand != null) old.brand = String(d.brand).slice(0, 40);
      if (d.order != null) old.order = +d.order;
      if (d.cat !== undefined) old.cat = d.cat || null;
      if (d.mv != null) old.mv = +d.mv;
      old.at = Date.now();
      await env.DB.put('docs', JSON.stringify(docs));
      return json({ ok: true, docs });
    }
    if (what === 'docdelete' && method === 'POST') {
      const { rid } = await request.json();
      const docs = await getDocs(env);
      const old = docs.find(x => x.rid === rid);
      if (!old) return json({ ok: true, docs });
      for (let i = 0; i < old.parts; i++) await partDel(env, `part:${old.rid}:${old.sha}:${i}`);
      await env.DB.delete(`auto:${old.rid}:${old.sha}`).catch(() => {});
      const rest = docs.filter(x => x.rid !== rid);
      await env.DB.put('docs', JSON.stringify(rest));
      return json({ ok: true, docs: rest });
    }
    return fail('Rota desconhecida', 404);
  } catch (err) {
    return fail('Erro no servidor: ' + (err?.message || err), 500);
  }
}
