// Voto Pizza — prototipo di sistema di voto segreto per giudici via QR code.
// Nessuna dipendenza esterna: basta Node.js 18+.  Avvio:  node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Stato persistente ----------
function token(n = 8) {
  return crypto.randomBytes(n).toString('base64url');
}

function defaultState() {
  return {
    adminPassword: process.env.ADMIN_PASSWORD || 'pizza2026',
    event: {
      name: 'Campionato di Pizza Contemporanea',
      status: 'open', // open | closed | revealed
      baseUrl: '',
      scaleMin: 1,
      scaleMax: 10,
      criteria: [
        { id: 'impasto', label: 'Impasto e cornicione', weight: 1 },
        { id: 'cottura', label: 'Cottura', weight: 1 },
        { id: 'gusto', label: 'Gusto ed equilibrio', weight: 1.5 },
        { id: 'aspetto', label: 'Aspetto e presentazione', weight: 1 },
        { id: 'creativita', label: 'Creatività', weight: 1 },
      ],
    },
    competitors: [], // { id, number, name, code }
    judges: [], // { id, name, token }
    votes: [], // { judgeId, competitorId, scores: {criterio: n}, total, at }
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  state = defaultState();
  seedDemo();
  save();
}

function save() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

function seedDemo() {
  const names = [
    'Marco Esposito', 'Giulia Russo', 'Antonio Ferrara', 'Sara Romano',
    'Luca De Luca', 'Chiara Greco', 'Davide Conti', 'Elena Marino',
  ];
  names.forEach((name, i) => addCompetitor(String(i + 1).padStart(2, '0'), name));
  ['Giudice 1', 'Giudice 2', 'Giudice 3', 'Giudice 4', 'Giudice 5'].forEach(addJudge);
}

function addCompetitor(number, name) {
  const c = { id: token(6), number: String(number), name: String(name), code: token(6) };
  state.competitors.push(c);
  return c;
}

function addJudge(name) {
  const j = { id: token(6), name: String(name), token: token(12) };
  state.judges.push(j);
  return j;
}

// Punteggio di un singolo voto: media pesata dei criteri.
function weightedScore(scores) {
  let sum = 0, w = 0;
  for (const c of state.event.criteria) {
    sum += (Number(scores[c.id]) || 0) * c.weight;
    w += c.weight;
  }
  return w ? Math.round((sum / w) * 100) / 100 : 0;
}

function ranking() {
  const rows = state.competitors.map((c) => {
    const vs = state.votes.filter((v) => v.competitorId === c.id);
    const total = vs.reduce((a, v) => a + v.total, 0);
    const perCriterion = {};
    for (const cr of state.event.criteria) {
      perCriterion[cr.id] = vs.length
        ? Math.round((vs.reduce((a, v) => a + (Number(v.scores[cr.id]) || 0), 0) / vs.length) * 100) / 100
        : 0;
    }
    return {
      number: c.number,
      name: c.name,
      votes: vs.length,
      total: Math.round(total * 100) / 100,
      average: vs.length ? Math.round((total / vs.length) * 100) / 100 : 0,
      perCriterion,
    };
  });
  rows.sort((a, b) => b.total - a.total || b.average - a.average);
  let pos = 0, prev = null;
  rows.forEach((r, i) => {
    if (r.total !== prev) pos = i + 1;
    r.position = pos;
    prev = r.total;
  });
  return rows;
}

// ---------- Helpers HTTP ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const adminSessions = new Set();
function isAdmin(req) {
  return adminSessions.has(cookies(req).admin);
}
function judgeFromReq(req) {
  const t = cookies(req).judge;
  return t ? state.judges.find((j) => j.token === t) : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
function serveFile(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return state.event.baseUrl || `${proto}://${req.headers.host}`;
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  try {
    // --- Pagine ---
    if (m === 'GET' && (p === '/' || p === '/admin')) return serveFile(res, 'admin.html');
    if (m === 'GET' && p === '/classifica') return serveFile(res, 'classifica.html');
    if (m === 'GET' && p === '/stampa') return serveFile(res, 'stampa.html');
    if (m === 'GET' && (p === '/giudice' || p.startsWith('/v/'))) return serveFile(res, 'giudice.html');

    // Il giudice inquadra il proprio QR personale: viene "registrato" sul telefono.
    if (m === 'GET' && p.startsWith('/j/')) {
      const j = state.judges.find((x) => x.token === p.slice(3));
      if (!j) return send(res, 404, 'Badge giudice non valido');
      return send(res, 302, '', {
        'Set-Cookie': `judge=${j.token}; Path=/; Max-Age=${60 * 60 * 24 * 7}; SameSite=Lax; HttpOnly`,
        Location: '/giudice',
      });
    }

    if (m === 'GET' && !p.startsWith('/api/')) return serveFile(res, p.slice(1));

    // --- API pubbliche ---
    if (m === 'GET' && p === '/api/info') {
      return send(res, 200, { name: state.event.name, eventStatus: state.event.status });
    }
    if (m === 'GET' && p === '/api/results') {
      if (state.event.status !== 'revealed') return send(res, 403, { error: 'Classifica non ancora rivelata', eventStatus: state.event.status });
      return send(res, 200, { name: state.event.name, criteria: state.event.criteria, ranking: ranking() });
    }

    // --- API giudice ---
    if (p.startsWith('/api/judge/')) {
      const judge = judgeFromReq(req);
      if (!judge) return send(res, 401, { error: 'Telefono non registrato: inquadra prima il tuo badge giudice.' });

      if (m === 'GET' && p === '/api/judge/me') {
        const mine = state.votes.filter((v) => v.judgeId === judge.id).map((v) => v.competitorId);
        return send(res, 200, {
          name: judge.name,
          event: { name: state.event.name, status: state.event.status },
          competitors: state.competitors.map((c) => ({ number: c.number, name: c.name, code: c.code, voted: mine.includes(c.id) })),
        });
      }
      if (m === 'GET' && p.startsWith('/api/judge/competitor/')) {
        const c = state.competitors.find((x) => x.code === p.split('/').pop());
        if (!c) return send(res, 404, { error: 'QR concorrente non valido' });
        const voted = state.votes.some((v) => v.judgeId === judge.id && v.competitorId === c.id);
        return send(res, 200, {
          competitor: { number: c.number, name: c.name, code: c.code },
          voted,
          eventStatus: state.event.status,
          criteria: state.event.criteria.map(({ id, label }) => ({ id, label })),
          scaleMin: state.event.scaleMin,
          scaleMax: state.event.scaleMax,
        });
      }
      if (m === 'POST' && p === '/api/judge/vote') {
        const body = await readBody(req);
        if (state.event.status !== 'open') return send(res, 409, { error: 'La votazione è chiusa.' });
        const c = state.competitors.find((x) => x.code === body.code);
        if (!c) return send(res, 404, { error: 'Concorrente non trovato' });
        if (state.votes.some((v) => v.judgeId === judge.id && v.competitorId === c.id)) {
          return send(res, 409, { error: 'Hai già votato questo concorrente. Il voto è definitivo.' });
        }
        const scores = {};
        const { scaleMin: lo, scaleMax: hi } = state.event;
        for (const cr of state.event.criteria) {
          const n = Number(body.scores && body.scores[cr.id]);
          if (!Number.isFinite(n) || n < lo || n > hi) return send(res, 400, { error: `Voto mancante o fuori scala per "${cr.label}"` });
          scores[cr.id] = n;
        }
        state.votes.push({ judgeId: judge.id, competitorId: c.id, scores, total: weightedScore(scores), at: new Date().toISOString() });
        save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // --- API admin ---
    if (m === 'POST' && p === '/api/admin/login') {
      const body = await readBody(req);
      if (body.password !== state.adminPassword) return send(res, 401, { error: 'Password errata' });
      const s = token(16);
      adminSessions.add(s);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `admin=${s}; Path=/; SameSite=Lax; HttpOnly` });
    }
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Accesso admin richiesto' });
      const body = m === 'POST' ? await readBody(req) : {};
      const ev = state.event;

      if (m === 'GET' && p === '/api/admin/state') {
        // Finché la classifica non è rivelata l'admin vede SOLO chi ha votato, mai i punteggi.
        const progress = state.competitors.map((c) => ({
          ...c,
          judgesVoted: state.judges.filter((j) => state.votes.some((v) => v.judgeId === j.id && v.competitorId === c.id)).map((j) => j.id),
        }));
        return send(res, 200, {
          event: ev,
          base: baseUrl(req),
          suggestedBase: `http://${lanAddress()}:${PORT}`,
          competitors: progress,
          judges: state.judges,
          votesCount: state.votes.length,
          expectedVotes: state.judges.length * state.competitors.length,
          ranking: ev.status === 'revealed' ? ranking() : null,
        });
      }
      if (m === 'POST' && p === '/api/admin/settings') {
        if (typeof body.name === 'string') ev.name = body.name.trim() || ev.name;
        if (typeof body.baseUrl === 'string') ev.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
        if (Array.isArray(body.criteria)) {
          if (state.votes.length) return send(res, 409, { error: 'Non puoi cambiare i criteri dopo che sono arrivati voti.' });
          ev.criteria = body.criteria
            .filter((c) => c && String(c.label || '').trim())
            .map((c, i) => ({ id: 'c' + (i + 1), label: String(c.label).trim(), weight: Number(c.weight) > 0 ? Number(c.weight) : 1 }));
        }
        if (body.scaleMin != null || body.scaleMax != null) {
          if (state.votes.length) return send(res, 409, { error: 'Non puoi cambiare la scala dopo che sono arrivati voti.' });
          const lo = Number(body.scaleMin), hi = Number(body.scaleMax);
          if (!(hi > lo)) return send(res, 400, { error: 'Scala non valida' });
          ev.scaleMin = lo; ev.scaleMax = hi;
        }
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/competitor') {
        if (!String(body.name || '').trim()) return send(res, 400, { error: 'Nome obbligatorio' });
        const number = String(body.number || '').trim() || String(state.competitors.length + 1).padStart(2, '0');
        addCompetitor(number, String(body.name).trim());
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/judge') {
        if (!String(body.name || '').trim()) return send(res, 400, { error: 'Nome obbligatorio' });
        addJudge(String(body.name).trim());
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && (p === '/api/admin/competitor/delete' || p === '/api/admin/judge/delete')) {
        const isJudge = p.includes('judge');
        if (state.votes.some((v) => (isJudge ? v.judgeId : v.competitorId) === body.id)) {
          return send(res, 409, { error: 'Ha già dei voti registrati: non si può eliminare.' });
        }
        const list = isJudge ? state.judges : state.competitors;
        const i = list.findIndex((x) => x.id === body.id);
        if (i >= 0) list.splice(i, 1);
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/status') {
        const order = ['open', 'closed', 'revealed'];
        if (!order.includes(body.status)) return send(res, 400, { error: 'Stato non valido' });
        ev.status = body.status;
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/reset') {
        const keep = state.adminPassword;
        state = defaultState();
        state.adminPassword = keep;
        if (body.demo) seedDemo();
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'GET' && p === '/api/admin/export.csv') {
        if (ev.status !== 'revealed') return send(res, 403, 'Disponibile solo dopo la rivelazione');
        const head = ['Posizione', 'Numero', 'Concorrente', 'Voti', 'Totale', 'Media', ...ev.criteria.map((c) => c.label)];
        const lines = [head, ...ranking().map((r) => [r.position, r.number, r.name, r.votes, r.total, r.average, ...ev.criteria.map((c) => r.perCriterion[c.id])])];
        const csv = lines.map((l) => l.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n');
        return send(res, 200, '﻿' + csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="classifica.csv"' });
      }
      return send(res, 404, { error: 'Not found' });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Errore interno' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = `http://${lanAddress()}:${PORT}`;
  console.log('\n  🍕 Voto Pizza avviato\n');
  console.log(`  Pannello admin (su questo computer): http://localhost:${PORT}/admin`);
  console.log(`  Indirizzo per i telefoni (stessa Wi-Fi): ${lan}`);
  console.log(`  Password admin: ${state.adminPassword}\n`);
});
