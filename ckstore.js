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
  }
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
