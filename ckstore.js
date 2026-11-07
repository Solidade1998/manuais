// =====================================================================
//  Checklists em tempo real: um Durable Object com banco SQLite.
//  Grátis no plano Free do Cloudflare (~100 mil linhas gravadas por dia),
//  bem mais que o KV (1 mil gravações por dia). Cada resposta marcada no
//  celular vira uma gravação aqui, e o admin vê quase na hora.
// =====================================================================
import { DurableObject } from 'cloudflare:workers';

export class CkStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ck (
      code TEXT NOT NULL, id TEXT NOT NULL, meta TEXT NOT NULL, data TEXT NOT NULL, upd INTEGER NOT NULL,
      PRIMARY KEY (code, id))`);
    // aba Dicas: dicas (JSON) e fotos (bytes JPEG); a foto "<dica>-<n>" pertence à dica
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tip (id TEXT PRIMARY KEY, data TEXT NOT NULL, upd INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS photo (pid TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL)`);
  }
  tipList() { return this.sql.exec('SELECT data FROM tip ORDER BY upd DESC').toArray().map(r => JSON.parse(r.data)); }
  tipGet(id) { const r = this.sql.exec('SELECT data FROM tip WHERE id = ?', id).toArray()[0]; return r ? JSON.parse(r.data) : null; }
  tipSave(tip) {
    const old = this.tipGet(tip.id);
    const t = { ...tip, comments: old?.comments || [], created: old?.created || Date.now(), by: old?.by || tip.by, upd: Date.now() };
    this.sql.exec('INSERT OR REPLACE INTO tip (id, data, upd) VALUES (?, ?, ?)', t.id, JSON.stringify(t), t.upd);
    // fotos tiradas da dica são apagadas
    const keep = new Set([...(t.fotos || []), ...t.comments.flatMap(c => c.fotos || [])]);
    for (const r of this.sql.exec('SELECT pid FROM photo WHERE pid LIKE ?', t.id + '-%').toArray()) if (!keep.has(r.pid)) this.sql.exec('DELETE FROM photo WHERE pid = ?', r.pid);
    return t;
  }
  tipComment(id, c) {
    const t = this.tipGet(id); if (!t) return null;
    t.comments = [...(t.comments || []), c]; t.upd = Date.now();
    this.sql.exec('UPDATE tip SET data = ?, upd = ? WHERE id = ?', JSON.stringify(t), t.upd, id);
    return t;
  }
  tipUncomment(id, cid) {
    const t = this.tipGet(id); if (!t) return null;
    const c = (t.comments || []).find(x => x.id === cid);
    t.comments = (t.comments || []).filter(x => x.id !== cid); t.upd = Date.now();
    this.sql.exec('UPDATE tip SET data = ?, upd = ? WHERE id = ?', JSON.stringify(t), t.upd, id);
    for (const pid of c?.fotos || []) this.sql.exec('DELETE FROM photo WHERE pid = ?', pid);
    return t;
  }
  tipDel(id) {
    this.sql.exec('DELETE FROM tip WHERE id = ?', id);
    this.sql.exec('DELETE FROM photo WHERE pid LIKE ?', id + '-%');
    return true;
  }
  photoPut(pid, mime, bytes) { this.sql.exec('INSERT OR REPLACE INTO photo (pid, mime, bytes) VALUES (?, ?, ?)', pid, mime, bytes); return true; }
  photoGet(pid) { const r = this.sql.exec('SELECT mime, bytes FROM photo WHERE pid = ?', pid).toArray()[0]; return r ? { mime: r.mime, bytes: r.bytes } : null; }
  saveOne(code, id, meta, data) {
    this.sql.exec('INSERT OR REPLACE INTO ck (code, id, meta, data, upd) VALUES (?, ?, ?, ?, ?)', code, id, JSON.stringify(meta), data, Date.now());
    return true;
  }
  delOne(code, id) { this.sql.exec('DELETE FROM ck WHERE code = ? AND id = ?', code, id); return true; }
  listAll() {
    return this.sql.exec('SELECT code, id, meta FROM ck').toArray().map(r => ({ code: r.code, id: r.id, ...JSON.parse(r.meta) }));
  }
  getOne(code, id) {
    const r = this.sql.exec('SELECT data FROM ck WHERE code = ? AND id = ?', code, id).toArray()[0];
    return r ? r.data : null;
  }
}
