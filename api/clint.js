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

    if (action === 'explore') {
      const start = (req.query && req.query.start) || '2026-10-01';
      const end = (req.query && req.query.end) || '2026-10-14';
      const out = { start, end };
      const uRes = await clint('/v1/users', { limit: 200 });
      const names = {};
      rows(uRes).forEach((u) => { names[u.id] = ((u.first_name || '') + ' ' + (u.last_name || '')).trim(); });
      out.userNames = names;
      const oRes = await clint('/v1/origins', { limit: 200 });
      const origs = rows(oRes).filter((o) => /^VENDAS (SDR|SOCIAL SELLER|CLOSER)/.test((o.name || '').trim()));
      out.deals = [];
      for (const o of origs) {
        for (const st of ['OPEN', 'WON', 'LOST']) {
          const r = await clint('/v1/deals', { origin_id: o.id, status: st, created_at_start: start + 'T00:00:00-03:00', created_at_end: end + 'T23:59:59-03:00', limit: 200 });
          const list = rows(r);
          const byUser = {};
          list.forEach((d) => { const uid = (d.user && d.user.id) || 'sem'; byUser[uid] = (byUser[uid] || 0) + 1; });
          out.deals.push({ origin: o.name.trim(), status: st, totalCount: r.totalCount, page: list.length, userShape: list[0] ? shape(list[0].user) : null, byUser });
        }
      }
      const ch = await clint('/v2/channel-accounts', { limit: 50 });
      out.chats = [];
      for (const acc of rows(ch)) {
        const variants = {
          none: {},
          created: { created_at_start: start + 'T00:00:00-03:00', created_at_end: end + 'T23:59:59-03:00' },
          created2: { start_date: start, end_date: end },
        };
        const o = { account: acc.name, type: acc.type };
        for (const k of Object.keys(variants)) {
          try {
            const r = await clint('/v2/chats/channel-account/' + acc.id, Object.assign({ limit: 100 }, variants[k]));
            o[k] = { total: r.total_count, pages: r.total_pages, got: rows(r).length };
          } catch (e) { o[k] = { error: e.message }; }
        }
        const r = await clint('/v2/chats/channel-account/' + acc.id, { limit: 60 });
        const list = rows(r);
        const diffs = [];
        let nullFirst = 0, withUser = 0;
        list.forEach((c) => {
          if (c.user_id) withUser++;
          if (!c.first_response_at) { nullFirst++; return; }
          if (c.first_customer_message_at) diffs.push(Math.round((new Date(c.first_response_at) - new Date(c.first_customer_message_at)) / 60000));
        });
        o.sample = { n: list.length, withUser, nullFirstResponse: nullFirst, diffMinutes: diffs.slice(0, 30), newest: list[0] && list[0].created_at, oldest: list.length && list[list.length - 1].created_at };
        o.msgs = [];
        for (const c of list.slice(0, 4)) {
          try {
            const m = await clint('/v2/messages/chat/' + c.id, { limit: 12 });
            o.msgs.push(rows(m).map((x) => [x.type, x.sent, x.source, x.content_type, x.user_id ? 'u' : '-', x.created_at]));
          } catch (e) { o.msgs.push('erro ' + e.message); }
        }
        out.chats.push(o);
      }
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: 'action inválida' });
  } catch (e) {
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message });
  }
};
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
