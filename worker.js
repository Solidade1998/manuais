// Entrada para Cloudflare Workers: arquivos do app vêm dos "assets";
// tudo que começa com /api/ vai para o servidor (server.js).
import { onRequest } from './server.js';
export { CkStore } from './ckstore.js'; // checklists em tempo real (Durable Object)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return onRequest({ request, env, ctx });
    return env.ASSETS.fetch(request);
  },
};
