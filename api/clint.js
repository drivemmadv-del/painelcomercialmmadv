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
      const out = {};
      const oRes = await clint('/v1/origins', { limit: 200 });
      const sdr = rows(oRes).find((o) => (o.name || '').trim() === 'VENDAS SDR');
      const dq = { origin_id: sdr.id, status: 'OPEN', created_at_start: start + 'T00:00:00-03:00', created_at_end: end + 'T23:59:59-03:00' };
      const d1000 = await clint('/v1/deals', Object.assign({ limit: 1000 }, dq));
      const list = rows(d1000);
      out.limit1000 = { total: d1000.totalCount, got: list.length, pages: d1000.totalPages };
      const ds = list.map((d) => d.created_at).sort();
      out.createdRange = [ds[0], ds[ds.length - 1]];
      out.dealKeys = list[0] ? Object.keys(list[0]) : [];
      out.contactShape = list[0] ? shape(list[0].contact) : null;
      out.fieldsKeys = list[0] && list[0].fields ? Object.keys(list[0].fields).slice(0, 20) : [];
      out.samples = [];
      for (const d of list.slice(0, 5)) {
        const o = { dealCreated: d.created_at, stage: d.stage };
        try {
          const cc = await clint('/v2/chats/contact/' + d.contact.id, { limit: 20 });
          const chs = rows(cc);
          o.chats = chs.map((c) => ({ created: c.created_at, firstCust: c.first_customer_message_at, firstResp: c.first_response_at, ch: c.channel_account_id.slice(0, 4), user: c.user_id ? 'u' : '-' }));
          if (chs[0]) {
            const m1 = await clint('/v2/messages/chat/' + chs[0].id, { limit: 100 });
            const ms = rows(m1);
            o.msgMeta = { total: m1.total_count, pages: m1.total_pages, got: ms.length, first: ms[0] && ms[0].created_at, last: ms.length && ms[ms.length - 1].created_at };
            o.msgs = ms.map((x) => [x.type, x.content_type, x.source, x.user_id ? 'u' : '-', x.created_at]).slice(-12);
          }
        } catch (e) { o.error = e.message; }
        out.samples.push(o);
      }
      const ch = await clint('/v2/channel-accounts', { limit: 50 });
      const acc = rows(ch).find((a) => a.type === 'WHATSAPP');
      out.chatParams = {};
      const tests = { user_id: { user_id: '9c71d887-94a5-46f1-a7ef-0a4dbc0ca9ef' }, last_message_at_start: { last_message_at_start: start + 'T00:00:00-03:00' }, updated_at_start: { updated_at_start: start + 'T00:00:00-03:00' }, first_response_at_start: { first_response_at_start: start + 'T00:00:00-03:00' }, created_at_from: { created_at_from: start }, from: { from: start, to: end }, status: { status: 'OPEN' } };
      for (const k of Object.keys(tests)) {
        try {
          const r = await clint('/v2/chats/channel-account/' + acc.id, Object.assign({ limit: 5 }, tests[k]));
          out.chatParams[k] = r.total_count;
        } catch (e) { out.chatParams[k] = 'erro ' + e.message.slice(0, 80); }
      }
      try {
        const dl = await clint('/v2/dashboards', { limit: 50 });
        out.dashboardsShape = shape(dl);
        out.dashboards = rows(dl).map((d) => ({ id: d.id, name: d.name }));
      } catch (e) { out.dashboardsError = e.message; }
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: 'action inválida' });
  } catch (e) {
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message });
  }
};
