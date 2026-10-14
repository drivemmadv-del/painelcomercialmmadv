/* Função de servidor (Vercel) que consulta a API do Clint.
   O token fica só na variável de ambiente CLINT_API_TOKEN e nunca vai para o navegador. */

const BASE = 'https://api.clint.digital';

async function clint(path, params) {
  const token = process.env.CLINT_API_TOKEN;
  if (!token) throw new Error('CLINT_API_TOKEN não configurado na Vercel');
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url, { headers: { 'api-token': token, accept: 'application/json' } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || text.slice(0, 160);
    const err = new Error('Clint ' + res.status + ' em ' + path + ': ' + msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

/* Descreve só a estrutura (nomes dos campos e tipos), sem devolver dados de contatos */
function shape(v, depth) {
  depth = depth || 0;
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (typeof v === 'object') {
    if (depth >= 3) return 'object';
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = shape(v[k], depth + 1); });
    return o;
  }
  return typeof v;
}

function rows(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.items)) return body.items;
  return [];
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query && req.query.action) || 'probe';
  try {
    if (action === 'probe') {
      const out = {};
      const users = await clint('/v1/users', { limit: 200 });
      out.usersShape = shape(users);
      out.users = rows(users).map((u) => ({ id: u.id, name: u.name || u.full_name || null }));
      const origins = await clint('/v1/origins', { limit: 200 });
      out.originsShape = shape(origins);
      out.origins = rows(origins).map((o) => ({ id: o.id, name: o.name || null }));
      const deals = await clint('/v1/deals', { limit: 1, status: 'OPEN' });
      out.dealsShape = shape(deals);
      try {
        const ch = await clint('/v2/channel-accounts', { limit: 50 });
        out.channelAccountsShape = shape(ch);
        out.channelAccounts = rows(ch).map((c) => ({ id: c.id, name: c.name || c.label || null, type: c.type || c.channel || null }));
        const first = rows(ch)[0];
        if (first) {
          const chats = await clint('/v2/chats/channel-account/' + first.id, { limit: 1 });
          out.chatsShape = shape(chats);
          const chat = rows(chats)[0];
          if (chat) {
            const msgs = await clint('/v2/messages/chat/' + chat.id, { limit: 2 });
            out.messagesShape = shape(msgs);
          }
        }
      } catch (e) {
        out.chatsError = e.message;
      }
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: 'action inválida' });
  } catch (e) {
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message });
  }
};
