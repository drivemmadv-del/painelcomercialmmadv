/* Atendimentos por dia (Clint).
   Conta, para cada colaborador e cada dia, quantas conversas DIFERENTES receberam ao menos uma
   mensagem humana (enviada por usuário do Clint ou pelo celular; respostas automáticas não contam).
   A consulta é dividida em "fatias" (shard/of) para caber no tempo da função; o painel pede todas
   em paralelo e soma. Dia no fuso -03:00. */

const BASE = 'https://api.clint.digital';
const TZ = '-03:00';

async function clint(path, params) {
  const tries = 6;
  const token = process.env.CLINT_API_TOKEN;
  if (!token) throw new Error('CLINT_API_TOKEN não configurado na Vercel');
  const url = new URL(BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  for (let a = 1; a <= tries; a++) {
    const res = await fetch(url, { headers: { 'api-token': token, accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && a < tries) {
      const ra = parseFloat(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, (ra > 0 && ra < 10 ? ra * 1000 : 700 * a) + Math.random() * 300));
      continue;
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    if (!res.ok) {
      const err = new Error('Clint ' + res.status + ' em ' + path + ': ' + ((body && (body.message || body.error)) || text.slice(0, 160)));
      err.status = res.status;
      throw err;
    }
    return body;
  }
}

function rows(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.items)) return body.items;
  return [];
}

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

const isHuman = (m) => m && m.type === 'USER' && (m.user_id || m.source === 'DEVICE');
const dayBR = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null);

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { await fn(items[k], k); } catch (e) { items[k].failed = true; }
    }
  }));
}

module.exports = async (req, res) => {
  try {
    const todayBR = dayBR(Date.now());
    const start = isoDay(req.query.start) || todayBR.slice(0, 8) + '01';
    const end = isoDay(req.query.end) || todayBR;
    const startMs = Date.parse(start + 'T00:00:00' + TZ);
    const endMs = Date.parse(end + 'T23:59:59' + TZ);
    const lastDay = end < todayBR ? end : todayBR;
    const days = Math.max(1, Math.round((Date.parse(lastDay + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1);
    const of = Math.min(16, Math.max(1, parseInt(req.query.of, 10) || 1));
    const shard = Math.min(of - 1, Math.max(0, parseInt(req.query.shard, 10) || 0));

    const accBody = await clint('/v2/channel-accounts', { limit: 50 });
    const lists = await Promise.all(rows(accBody).map((a) => all('/v2/chats/channel-account/' + a.id, {
      limit: 200, last_message_at_start: start + 'T00:00:00' + TZ,
    }, 60)));

    /* Só conversas que já tiveram alguma resposta e foram abertas até o fim do período */
    const mine = [];
    let total = 0;
    lists.forEach((l) => l.forEach((c) => {
      if (!c.first_response_at) return;
      if (c.created_at && Date.parse(c.created_at) > endMs) return;
      total++;
      if (hash(String(c.id)) % of === shard) mine.push({ c, h: hash('~' + String(c.id)) });
    }));

    /* Ordem pseudoaleatória: se o tempo ou o limite do Clint cortar a leitura, o que foi lido é uma amostra sem viés */
    mine.sort((a, b) => a.h - b.h);
    const deadline = Date.now() + 48000;
    const byUser = {}; /* uid -> { 'AAAA-MM-DD': conversas distintas } */
    let done = 0;
    await pool(mine, 4, async (it) => {
      if (Date.now() > deadline) { it.skipped = true; return; }
      const seen = new Set();
      for (let page = 1; page <= 30; page++) {
        const body = await clint('/v2/messages/chat/' + it.c.id, { limit: 100, page });
        const msgs = rows(body);
        let oldest = Infinity;
        msgs.forEach((m) => {
          const t = Date.parse(m.created_at);
          if (t < oldest) oldest = t;
          if (!isHuman(m) || !(t >= startMs && t <= endMs)) return;
          const uid = m.user_id || it.c.user_id;
          if (!uid) return;
          const key = uid + '|' + dayBR(t);
          if (seen.has(key)) return;
          seen.add(key);
          const d = byUser[uid] = byUser[uid] || {};
          const day = dayBR(t);
          d[day] = (d[day] || 0) + 1;
        });
        /* mensagens vêm da mais nova para a mais antiga: para ao passar do início do período */
        if (oldest < startMs || !(body && body.total_pages > page) || !msgs.length) break;
      }
      done++;
    });

    const pending = mine.filter((x) => x.skipped || x.failed).length;
    /* Dias já encerrados não mudam: ficam em cache por 1 dia; o dia de hoje por 5 minutos */
    /* Guarda em cache se a leitura foi completa ou ao menos uma amostra grande (>= 30% da fatia) */
    const okSample = mine.length === 0 || done >= mine.length * 0.3;
    res.setHeader('Cache-Control', !okSample ? 'no-store' : (end < todayBR ? 'public, s-maxage=86400, stale-while-revalidate=86400' : 'public, s-maxage=300, stale-while-revalidate=600'));
    return res.status(200).json({
      generatedAt: new Date().toISOString(), start, end, days, shard, of,
      chatsTotal: total, chatsInShard: mine.length, processed: done, pending, byUser,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ error: e.message });
  }
};
