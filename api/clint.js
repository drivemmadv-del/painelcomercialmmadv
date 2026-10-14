/* Função de servidor (Vercel) que consulta a API do Clint.
   O token fica só na variável de ambiente CLINT_API_TOKEN e nunca vai para o navegador.
   action=metrics&start=AAAA-MM-DD&end=AAAA-MM-DD devolve, por colaborador:
   leads (origens VENDAS SDR, SOCIAL SELLER e CLOSER), leads/dia, conversas atendidas/dia
   e tempo de resposta (média e mediana). */

const BASE = 'https://api.clint.digital';
const ORIGINS = ['VENDAS SDR', 'VENDAS SOCIAL SELLER', 'VENDAS CLOSER'];
const TZ = '-03:00';

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

function rows(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.items)) return body.items;
  return [];
}

/* Percorre todas as páginas de uma listagem */
async function all(path, params, maxPages) {
  const out = [];
  for (let page = 1; page <= (maxPages || 30); page++) {
    const body = await clint(path, Object.assign({}, params, { page }));
    const r = rows(body);
    out.push(...r);
    if (!(body && body.has_next) || !r.length) break;
  }
  return out;
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);


/* Mensagem humana: enviada por um usuário no Clint (user_id) ou pelo celular (source DEVICE).
   Respostas automáticas (robô, modelo) vêm como USER sem user_id e source CHAT. */
const isHuman = (m) => m && m.type === 'USER' && (m.user_id || m.source === 'DEVICE');

async function firstHuman(chatId) {
  const p1 = await clint('/v2/messages/chat/' + chatId, { limit: 100, page: 1 });
  const pages = p1.total_pages || 1;
  let msgs = pages > 1 ? rows(await clint('/v2/messages/chat/' + chatId, { limit: 100, page: pages })) : rows(p1);
  let h = msgs.slice().reverse().find(isHuman);
  if (!h && pages > 2) {
    msgs = rows(await clint('/v2/messages/chat/' + chatId, { limit: 100, page: pages - 1 }));
    h = msgs.slice().reverse().find(isHuman);
  }
  return h || null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = undefined; }
    }
  }));
  return out;
}

function isoDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null; }

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || 'ping';
  try {
    if (action === 'ping') {
      res.setHeader('Cache-Control', 'no-store');
      const u = await clint('/v1/users', { limit: 1 });
      return res.status(200).json({ ok: true, users: rows(u).length });
    }

    if (action === 'metrics') {
      const todayBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const start = isoDay(req.query.start) || todayBR.slice(0, 8) + '01';
      const end = isoDay(req.query.end) || todayBR;
      const startMs = Date.parse(start + 'T00:00:00' + TZ);
      const endMs = Date.parse(end + 'T23:59:59' + TZ);
      const lastDay = end < todayBR ? end : todayBR;
      const days = Math.max(1, Math.round((Date.parse(lastDay + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1);

      const [usersBody, originsBody, accBody] = await Promise.all([
        clint('/v1/users', { limit: 200 }),
        clint('/v1/origins', { limit: 200 }),
        clint('/v2/channel-accounts', { limit: 50 }),
      ]);
      const users = {};
      rows(usersBody).forEach((u) => {
        users[u.id] = { id: u.id, name: u.full_name || u.name || u.email || u.id, email: u.email || null, leads: 0, leadsByOrigin: {}, chats: 0, resp: [] };
      });
      const origins = rows(originsBody).filter((o) => ORIGINS.indexOf((o.name || '').trim()) >= 0);
      const get = (id, fallback) => users[id] || (users[id] = { id, name: fallback || id, email: null, leads: 0, leadsByOrigin: {}, chats: 0, resp: [] });

      /* Leads: negócios criados no período nas 3 origens (qualquer status) */
      const jobs = [];
      origins.forEach((o) => ['OPEN', 'WON', 'LOST'].forEach((st) => jobs.push({ o, st })));
      const results = await Promise.all(jobs.map((j) => all('/v1/deals', {
        origin_id: j.o.id, status: j.st, limit: 1000,
        created_at_start: start + 'T00:00:00' + TZ, created_at_end: end + 'T23:59:59' + TZ,
      })));
      const seenDeal = new Set();
      const leadContacts = new Set();
      let unassigned = 0;
      results.forEach((list, i) => {
        const oname = jobs[i].o.name.trim();
        list.forEach((d) => {
          if (seenDeal.has(d.id)) return;
          seenDeal.add(d.id);
          if (d.contact && d.contact.id) leadContacts.add(d.contact.id);
          if (!d.user || !d.user.id) { unassigned++; return; }
          const u = get(d.user.id, d.user.full_name);
          if (d.user.full_name) u.name = d.user.full_name;
          u.leads++;
          u.leadsByOrigin[oname] = (u.leadsByOrigin[oname] || 0) + 1;
        });
      });

      /* Conversas: chats com mensagem desde o início do período, em todos os canais */
      const accounts = rows(accBody);
      const chatLists = await Promise.all(accounts.map((a) => all('/v2/chats/channel-account/' + a.id, {
        limit: 200, last_message_at_start: start + 'T00:00:00' + TZ,
      }, 40)));
      let chatsTotal = 0;
      const cands = {}; /* conversas de leads do período, por dono da conversa */
      chatLists.forEach((list) => list.forEach((c) => {
        chatsTotal++;
        if (!c.user_id) return;
        const u = get(c.user_id);
        if (c.first_response_at) u.chats++;
        if (c.first_response_at && c.first_customer_message_at && leadContacts.has(c.contact_id)) {
          const t0 = Date.parse(c.first_customer_message_at);
          if (t0 >= startMs && t0 <= endMs) (cands[c.user_id] = cands[c.user_id] || []).push(c);
        }
      }));

      /* Amostra por colaborador (espalhada no período): lê as mensagens para achar a 1ª resposta HUMANA */
      const CAP = Math.min(60, parseInt(req.query.cap, 10) || 40);
      const deadline = Date.now() + 42000;
      const sample = [];
      Object.keys(cands).forEach((uid) => {
        const arr = cands[uid];
        const step = Math.max(1, arr.length / CAP);
        for (let k = 0; k < Math.min(CAP, arr.length); k++) sample.push({ uid, c: arr[Math.floor(k * step)] });
      });
      let truncated = false;
      const found = await pool(sample, 8, async (it) => {
        if (Date.now() > deadline) { truncated = true; return undefined; }
        return firstHuman(it.c.id);
      });
      let respAll = [];
      const stat = {}; /* por dono: amostra, com resposta humana */
      sample.forEach((it, k) => {
        const h = found[k];
        if (h === undefined) return;
        const st = stat[it.uid] = stat[it.uid] || { n: 0, human: 0 };
        st.n++;
        if (!h) return;
        const t0 = Date.parse(it.c.first_customer_message_at);
        const t1 = Date.parse(h.created_at);
        if (!(t1 >= t0)) return;
        st.human++;
        const min = (t1 - t0) / 60000;
        get(h.user_id || it.uid).resp.push(min);
        respAll.push(min);
      });

      const list = Object.keys(users).map((id) => users[id]).filter((u) => u.leads || u.chats || u.resp.length).map((u) => {
        const st = stat[u.id];
        const hr = st && st.n ? st.human / st.n : null;
        return {
          id: u.id, name: u.name, email: u.email,
          leads: u.leads, leadsByOrigin: u.leadsByOrigin, leadsPerDay: round1(u.leads / days),
          chatsReplied: u.chats, humanRate: hr === null ? null : Math.round(hr * 100) / 100,
          chatsHuman: hr === null ? null : Math.round(u.chats * hr),
          chatsPerDay: hr === null ? null : round1((u.chats * hr) / days),
          sampleSize: st ? st.n : 0,
          respCount: u.resp.length,
          avgResponseMin: round1(u.resp.length ? u.resp.reduce((s, x) => s + x, 0) / u.resp.length : null),
          medianResponseMin: round1(median(u.resp)),
        };
      });

      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({
        generatedAt: new Date().toISOString(), start, end, days,
        leadsTotal: leadContacts.size, dealsTotal: seenDeal.size, unassigned, chatsScanned: chatsTotal, truncated,
        responseAll: { count: respAll.length, avgMin: round1(respAll.length ? respAll.reduce((s, x) => s + x, 0) / respAll.length : null), medianMin: round1(median(respAll)) },
        users: list,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'action inválida' });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message });
  }
};
