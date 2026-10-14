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
      let respAll = [];
      chatLists.forEach((list) => list.forEach((c) => {
        chatsTotal++;
        if (!c.user_id) return;
        const u = get(c.user_id);
        if (c.first_response_at) u.chats++;
        /* Tempo de resposta: só conversas de leads do período; 1ª mensagem do cliente até a 1ª resposta humana */
        if (c.first_response_at && c.first_customer_message_at && leadContacts.has(c.contact_id)) {
          const t0 = Date.parse(c.first_customer_message_at);
          const t1 = Date.parse(c.first_response_at);
          if (t0 >= startMs && t0 <= endMs && t1 >= t0) {
            const min = (t1 - t0) / 60000;
            u.resp.push(min);
            respAll.push(min);
          }
        }
      }));

      const list = Object.keys(users).map((id) => users[id]).filter((u) => u.leads || u.chats || u.resp.length).map((u) => ({
        id: u.id, name: u.name, email: u.email,
        leads: u.leads, leadsByOrigin: u.leadsByOrigin, leadsPerDay: round1(u.leads / days),
        chats: u.chats, chatsPerDay: round1(u.chats / days),
        respCount: u.resp.length,
        avgResponseMin: round1(u.resp.length ? u.resp.reduce((s, x) => s + x, 0) / u.resp.length : null),
        medianResponseMin: round1(median(u.resp)),
      }));

      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({
        generatedAt: new Date().toISOString(), start, end, days,
        leadsTotal: leadContacts.size, dealsTotal: seenDeal.size, unassigned, chatsScanned: chatsTotal,
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
