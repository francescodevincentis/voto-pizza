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

// ---------- Regolamento ----------
// Il regolamento è un testo semplice, modificabile dalla Regia:
//   # Nome categoria
//   gusto: Criterio | Criterio | ...      -> voto da scaleMin a scaleMax (es. 1–100)
//   forno ±5: Voce | Voce | ...           -> spunta: rispettata +5, non rispettata −5
//   forno -5: Voce | ...                   -> solo penalità: rispettata 0, non rispettata −5
const STANDARD = 'gusto: Gusto | Cottura | Presentazione\nforno: Etica professionale e pulizia';
const DEFAULT_RULES = [
  ...['Classica', 'Gourmet', 'Contemporanea', 'Chef', 'Senza Glutine', 'In pala', 'Amatoriale', 'Genio e follia']
    .map((n) => `# ${n}\n${STANDARD}`),
  `# Napoletana
forno ±5: Impasto | Divisa | Pomodoro 60/80 gr | Mozzarella 80/100 gr
forno -5: Mozzarella tagliata a listelli
forno ±5: Sale sul pomodoro | Basilico in cottura | Oliera | Cottura 90 secondi | Stesura con schiaffo | Infornata con rotatoria senza fuoriuscita | Panetto 180/250 gr | Bordo da 1 a 2 cm (oltre: penalità) | Straccio per pulire la pizza | La pizza non deve superare 35 cm ø
forno -5: Monili e gioielli`,
  `# Ruota di carro
forno: Etica professionale | Pulizia
forno -5: Diametro inferiore a 35 cm ø`,
].join('\n\n');

const DEFAULT_TEAMS = [
  'Margherita', 'Marinara', 'Diavola', 'Capricciosa', 'Quattro Stagioni', 'Bufalina', 'Cornicione', 'Lievito Madre',
  'Forno a Legna', "Pala d'Oro", 'Fior di Latte', 'Basilico', 'San Marzano', 'Oliera', 'Biga', 'Poolish',
  'Vesuvio', 'Partenope', 'Mozzarella', 'Pomodorino',
];
const defaultTeams = () => DEFAULT_TEAMS.map((name, i) => ({ id: 't' + (i + 1), name: 'Team ' + name }));

const ROLES = { gusto: 'Giudice di gusto', forno: 'Giudice di forno' };

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cat';
}

function parseRules(text) {
  const categories = [];
  const errors = [];
  let cur = null;
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    const m = line.match(/^(gusto|forno)\s*(±\s*\d+|\+\/?-\s*\d+|[-−]\s*\d+|penalit[aà]|spunta|check)?\s*:\s*(.*)$/i);
    if (m) {
      if (!cur) { errors.push(`Riga ${i + 1}: prima dei criteri scrivi il nome della categoria (es. "# Classica").`); return; }
      const role = m[1].toLowerCase();
      const type = !m[2] ? 'score' : /^([-−]|penal)/i.test(m[2]) ? 'penalty' : 'check';
      const labels = m[3].split('|').map((s) => s.trim()).filter(Boolean);
      if (!labels.length) errors.push(`Riga ${i + 1}: nessun criterio dopo i due punti.`);
      for (const label of labels) cur.criteria.push({ id: 'k' + (cur.criteria.length + 1), label, role, type });
      return;
    }
    const name = line.replace(/^#+\s*/, '').trim();
    if (!name) return;
    const id = slug(name);
    if (categories.some((c) => c.id === id)) { errors.push(`Riga ${i + 1}: la categoria "${name}" è ripetuta.`); cur = null; return; }
    cur = { id, name, criteria: [] };
    categories.push(cur);
  });
  for (const c of categories) if (!c.criteria.length) errors.push(`La categoria "${c.name}" non ha criteri.`);
  if (!categories.length) errors.push('Nessuna categoria trovata.');
  return { categories, errors };
}

// ---------- Stato persistente ----------
function token(n = 8) {
  return crypto.randomBytes(n).toString('base64url');
}

function defaultState() {
  return {
    adminPassword: process.env.ADMIN_PASSWORD || 'pizza2026',
    event: {
      name: 'Pizza 2026',
      status: 'open', // open | closed | revealed
      baseUrl: '',
      scaleMin: 1,
      scaleMax: 100,
      checkPoints: 5,
      teamSize: 4, // massimo concorrenti per team
      teams: defaultTeams(),
      teamExcluded: ['chef', 'genio-e-follia', 'napoletana', 'amatoriale'], // gare che non contano per la squadra
      rules: DEFAULT_RULES,
      categories: parseRules(DEFAULT_RULES).categories,
    },
    competitors: [], // { id, number, name, categoryIds: [...], code }  un concorrente può iscriversi a più gare
    judges: [], // { id, name, role: 'gusto'|'forno', token }
    votes: [], // { judgeId, competitorId, categoryId, role, scores: {criterio: numero | true/false}, total, at }
    adjustments: [], // { id, competitorId, categoryId, delta, note, at }  bonus/malus dell'organizzatore
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

if (!Array.isArray(state.adjustments)) state.adjustments = [];
// Regolamento predefinito della versione precedente: "Mozzarella tagliata a listelli", "Monili e gioielli"
// e il diametro della Ruota di carro diventano sole penalità (−5). Le voci restano nello stesso ordine,
// così i voti già dati non cambiano significato.
if (typeof state.event.rules === 'string' && state.event.rules.includes('forno ±5: Diametro 35–40 cm ø')) {
  state.event.rules = state.event.rules
    .replace('Mozzarella 80/100 gr | Mozzarella tagliata a listelli | ', 'Mozzarella 80/100 gr\nforno -5: Mozzarella tagliata a listelli\nforno ±5: ')
    .replace('La pizza non deve superare 35 cm ø', 'La pizza non deve superare 35 cm ø\nforno -5: Monili e gioielli')
    .replace('forno ±5: Diametro 35–40 cm ø', 'forno -5: Diametro inferiore a 35 cm ø');
  state.event.categories = parseRules(state.event.rules).categories;
  save();
}
if (!Array.isArray(state.event.teams)) { state.event.teams = defaultTeams(); state.event.teamSize = 4; }
if (!Array.isArray(state.event.teamExcluded)) state.event.teamExcluded = ['chef', 'genio-e-follia', 'napoletana', 'amatoriale'];
else if (state.event.teamExcluded.join() === 'chef,genio-e-follia,napoletana') state.event.teamExcluded.push('amatoriale');
for (const j of state.judges) if (!ROLES[j.role]) j.role = 'gusto';
// Versione con una sola categoria per concorrente -> elenco di gare.
for (const c of state.competitors) {
  if (!Array.isArray(c.categoryIds)) c.categoryIds = c.categoryId ? [c.categoryId] : [];
  if (typeof c.teamId !== 'string') c.teamId = '';
  delete c.categoryId;
}
for (const v of state.votes || []) if (!('categoryId' in v)) v.categoryId = (state.competitors.find((c) => c.id === v.competitorId) || { categoryIds: [''] }).categoryIds[0] || '';
for (const a of state.adjustments) if (!('categoryId' in a)) a.categoryId = (state.competitors.find((c) => c.id === a.competitorId) || { categoryIds: [''] }).categoryIds[0] || '';
// Dati della versione precedente (5 criteri, scala 1–10): passa al regolamento 2026.
if (!Array.isArray(state.event.categories)) {
  const d = defaultState().event;
  Object.assign(state.event, { scaleMin: d.scaleMin, scaleMax: d.scaleMax, checkPoints: d.checkPoints, rules: d.rules, categories: d.categories });
  delete state.event.criteria;
  if (state.votes.length) { state.legacyVotes = state.votes; state.votes = []; }
  save();
}

function save() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

function seedDemo() {
  const cats = state.event.categories;
  for (let i = 0; i < 12; i++) addCompetitor(String(i + 1).padStart(2, '0'), '', [cats[i % cats.length].id]);
  // Due concorrenti iscritti a più gare, per provare il caso.
  state.competitors[0].categoryIds.push('napoletana');
  state.competitors[2].categoryIds.push('genio-e-follia', 'ruota-di-carro');
  state.competitors.forEach((c, i) => { c.teamId = state.event.teams[i % 3].id; });
  ['Gusto 1', 'Gusto 2', 'Gusto 3'].forEach((n) => addJudge(n, 'gusto'));
  ['Forno 1', 'Forno 2'].forEach((n) => addJudge(n, 'forno'));
}

function addCompetitor(number, name, categoryIds, teamId = '') {
  const c = { id: token(6), number: String(number), name: String(name || ''), categoryIds: validCats(categoryIds), teamId, code: token(6) };
  state.competitors.push(c);
  return c;
}

function nextNumber() {
  const max = state.competitors.reduce((a, c) => Math.max(a, parseInt(c.number, 10) || 0), 0);
  return String(max + 1).padStart(2, '0');
}

function addJudge(name, role) {
  const j = { id: token(6), name: String(name), role: ROLES[role] ? role : 'gusto', token: token(12) };
  state.judges.push(j);
  return j;
}

// Team: ogni concorrente in un solo team, al massimo teamSize concorrenti per team.
function teamCount(teamId, exceptId) {
  return state.competitors.filter((c) => c.teamId === teamId && c.id !== exceptId).length;
}
function teamError(teamId, exceptId) {
  if (!teamId) return null;
  const t = state.event.teams.find((x) => x.id === teamId);
  if (!t) return 'Team non trovato';
  if (teamCount(teamId, exceptId) >= state.event.teamSize) return `${t.name} è già al completo (${state.event.teamSize} concorrenti): scegli un altro team.`;
  return null;
}
function teamByName(s) {
  const k = slug(String(s).replace(/^team\s+/i, ''));
  return state.event.teams.find((t) => slug(t.name.replace(/^team\s+/i, '')) === k) || null;
}

function validCats(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : [ids]) if (state.event.categories.some((k) => k.id === id) && !out.includes(id)) out.push(id);
  return out;
}
function catById(id) {
  return state.event.categories.find((k) => k.id === id) || null;
}
// Criteri che un giudice deve valutare per un concorrente in una gara (dipendono da categoria e tipo di giudice).
function criteriaFor(catId, judge) {
  const cat = catById(catId);
  return cat ? cat.criteria.filter((k) => k.role === judge.role) : [];
}
// Gare di un concorrente che un giudice deve votare.
function judgeCats(judge, c) {
  return c.categoryIds.filter((id) => criteriaFor(id, judge).length > 0);
}
function hasVoted(judge, c, catId) {
  return state.votes.some((v) => v.judgeId === judge.id && v.competitorId === c.id && v.categoryId === catId);
}
function points(cr, v) {
  if (cr.type === 'penalty') return v ? 0 : -state.event.checkPoints;
  return cr.type === 'check' ? (v ? state.event.checkPoints : -state.event.checkPoints) : Number(v) || 0;
}
const r2 = (n) => Math.round(n * 100) / 100;

// Classifica separata per categoria. Totale = somma dei punti di tutti i giudici + bonus/malus.
function ranking() {
  const groups = state.event.categories.map((cat) => ({ id: cat.id, name: cat.name, criteria: cat.criteria, rows: [] }));
  const orphan = { id: '', name: 'Senza categoria', criteria: [], rows: [] };
  const entries = [];
  for (const c of state.competitors) {
    const ids = c.categoryIds.filter((id) => catById(id));
    if (!ids.length) entries.push([c, '']);
    for (const id of ids) entries.push([c, id]);
  }
  for (const [c, catId] of entries) {
    const g = groups.find((x) => x.id === catId) || orphan;
    const vs = state.votes.filter((v) => v.competitorId === c.id && v.categoryId === catId);
    const votesTotal = vs.reduce((a, v) => a + v.total, 0);
    const byRole = { gusto: 0, forno: 0 };
    for (const v of vs) byRole[v.role] = (byRole[v.role] || 0) + v.total;
    const bonus = state.adjustments.filter((a) => a.competitorId === c.id && a.categoryId === catId).reduce((a, x) => a + x.delta, 0);
    const perCriterion = {};
    for (const cr of g.criteria) {
      const given = vs.filter((v) => cr.id in v.scores);
      perCriterion[cr.id] = given.length ? r2(given.reduce((a, v) => a + points(cr, v.scores[cr.id]), 0) / given.length) : null;
    }
    g.rows.push({
      number: c.number,
      name: c.name,
      votes: vs.length,
      gusto: r2(byRole.gusto),
      forno: r2(byRole.forno),
      votesTotal: r2(votesTotal),
      bonus,
      total: r2(votesTotal + bonus),
      perCriterion,
    });
  }
  const out = orphan.rows.length ? [...groups, orphan] : groups;
  for (const g of out) {
    g.rows.sort((a, b) => b.total - a.total || b.gusto - a.gusto);
    let pos = 0, prev = null;
    g.rows.forEach((r, i) => {
      if (r.total !== prev) pos = i + 1;
      r.position = pos;
      prev = r.total;
    });
  }
  return out.filter((g) => g.rows.length);
}

// Classifica a squadre: punteggio del team = somma dei totali dei suoi concorrenti nelle gare che contano
// per la squadra (Chef, Genio e follia, Napoletana e Amatoriale sono escluse di default).
function teamRanking() {
  const totals = {};
  for (const g of ranking()) {
    if (!g.id || state.event.teamExcluded.includes(g.id)) continue;
    for (const r of g.rows) totals[r.number] = (totals[r.number] || 0) + r.total;
  }
  const rows = state.event.teams.map((t) => {
    const members = state.competitors.filter((c) => c.teamId === t.id);
    return {
      name: t.name,
      members: members.map((c) => ({ number: c.number, name: c.name, total: r2(totals[c.number] || 0) })),
      total: r2(members.reduce((a, c) => a + (totals[c.number] || 0), 0)),
    };
  }).filter((t) => t.members.length);
  rows.sort((a, b) => b.total - a.total);
  let pos = 0, prev = null;
  rows.forEach((r, i) => { if (r.total !== prev) pos = i + 1; r.position = pos; prev = r.total; });
  return rows;
}

// Il bonus/malus conta nel totale ma non si mostra mai: niente colonna bonus né subtotali gusto/forno
// (da cui si potrebbe ricavare per differenza).
function publicRanking() {
  return ranking().map((g) => ({
    ...g,
    rows: g.rows.map(({ number, name, votes, total, perCriterion, position }) => ({ number, name, votes, total, perCriterion, position })),
  }));
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
// Sul computer che fa girare l'app la regia si apre senza password (sia da localhost sia dal suo
// indirizzo Wi-Fi, che è quello aperto da avvia.command). Da altri dispositivi e sul sito online
// la password resta, altrimenti chiunque potrebbe rivelare o azzerare.
function ownAddresses() {
  const out = new Set(['localhost']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.add(a.address);
  return out;
}
function isLocalRequest(req) {
  const own = ownAddresses();
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const proxied = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-host'] || req.headers.forwarded;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !!ip && own.has(ip) && !proxied && own.has(host);
}
function isAdmin(req) {
  return isLocalRequest(req) || adminSessions.has(cookies(req).admin);
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
      return send(res, 200, { name: state.event.name, categories: publicRanking(), teams: teamRanking() });
    }

    // --- API giudice ---
    if (p.startsWith('/api/judge/')) {
      const judge = judgeFromReq(req);
      if (!judge) return send(res, 401, { error: 'Telefono non registrato: inquadra prima il tuo badge giudice.' });

      if (m === 'GET' && p === '/api/judge/me') {
        return send(res, 200, {
          name: judge.name,
          role: judge.role,
          roleLabel: ROLES[judge.role],
          event: { name: state.event.name, status: state.event.status },
          // I giudici vedono solo numero e categoria: il nome del concorrente non esce mai da qui.
          // Una riga per ogni gara del concorrente che spetta a questo giudice.
          competitors: state.competitors.flatMap((c) => judgeCats(judge, c).map((id) => ({
            number: c.number, code: c.code, categoryId: id, category: catById(id).name, voted: hasVoted(judge, c, id),
          }))),
        });
      }
      if (m === 'GET' && p.startsWith('/api/judge/competitor/')) {
        const c = state.competitors.find((x) => x.code === p.split('/').pop());
        if (!c) return send(res, 404, { error: 'QR concorrente non valido' });
        const mineCats = judgeCats(judge, c);
        if (!mineCats.length) {
          return send(res, 409, {
            error: c.categoryIds.length
              ? `Il concorrente #${c.number} gareggia in categorie che non prevedono voti dei ${ROLES[judge.role].toLowerCase()}i: non va votato da te.`
              : `Il concorrente #${c.number} non ha ancora una categoria: avvisa la regia.`,
          });
        }
        const wanted = url.searchParams.get('cat');
        // Più gare: il giudice sceglie quale sta valutando.
        if (!wanted && mineCats.length > 1) {
          return send(res, 200, {
            competitor: { number: c.number, code: c.code },
            choose: mineCats.map((id) => ({ id, name: catById(id).name, voted: hasVoted(judge, c, id) })),
          });
        }
        const catId = wanted || mineCats[0];
        if (!mineCats.includes(catId)) return send(res, 409, { error: 'Questa gara non va votata da te.' });
        const cat = catById(catId);
        const criteria = criteriaFor(catId, judge);
        const voted = hasVoted(judge, c, catId);
        return send(res, 200, {
          competitor: { number: c.number, code: c.code, category: cat.name, categoryId: catId, otherCats: mineCats.length > 1 },
          voted,
          eventStatus: state.event.status,
          criteria: criteria.map(({ id, label, type }) => ({ id, label, type })),
          scaleMin: state.event.scaleMin,
          scaleMax: state.event.scaleMax,
          checkPoints: state.event.checkPoints,
        });
      }
      if (m === 'POST' && p === '/api/judge/vote') {
        const body = await readBody(req);
        if (state.event.status !== 'open') return send(res, 409, { error: 'La votazione è chiusa.' });
        const c = state.competitors.find((x) => x.code === body.code);
        if (!c) return send(res, 404, { error: 'Concorrente non trovato' });
        const catId = String(body.categoryId || '');
        if (!judgeCats(judge, c).includes(catId)) return send(res, 409, { error: 'Questa gara non va votata da te.' });
        if (hasVoted(judge, c, catId)) {
          return send(res, 409, { error: 'Hai già votato questo concorrente in questa gara. Il voto è definitivo.' });
        }
        const criteria = criteriaFor(catId, judge);
        const scores = {};
        const { scaleMin: lo, scaleMax: hi } = state.event;
        const given = body.scores || {};
        let total = 0;
        for (const cr of criteria) {
          if (cr.type === 'check' || cr.type === 'penalty') {
            if (typeof given[cr.id] !== 'boolean') return send(res, 400, { error: `Indica se "${cr.label}" è rispettato o no` });
            scores[cr.id] = given[cr.id];
          } else {
            const n = Number(given[cr.id]);
            if (!Number.isInteger(n) || n < lo || n > hi) return send(res, 400, { error: `Voto mancante o fuori scala (${lo}–${hi}) per "${cr.label}"` });
            scores[cr.id] = n;
          }
          total += points(cr, scores[cr.id]);
        }
        state.votes.push({ judgeId: judge.id, competitorId: c.id, categoryId: catId, role: judge.role, scores, total, at: new Date().toISOString() });
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
        const competitors = state.competitors.map((c) => ({
          ...c,
          votedCats: [...new Set(state.votes.filter((v) => v.competitorId === c.id).map((v) => v.categoryId))],
        }));
        // Una riga per iscrizione (concorrente + gara).
        const entries = state.competitors.flatMap((c) => c.categoryIds.filter((id) => catById(id)).map((id) => ({
          competitorId: c.id, number: c.number, name: c.name, categoryId: id, category: catById(id).name,
          judgesExpected: state.judges.filter((j) => criteriaFor(id, j).length).map((j) => j.id),
          judgesVoted: state.judges.filter((j) => hasVoted(j, c, id)).map((j) => j.id),
          bonus: state.adjustments.filter((a) => a.competitorId === c.id && a.categoryId === id).reduce((a, x) => a + x.delta, 0),
        })));
        const expectedVotes = entries.reduce((a, e) => a + e.judgesExpected.length, 0);
        return send(res, 200, {
          event: ev,
          base: baseUrl(req),
          suggestedBase: `http://${lanAddress()}:${PORT}`,
          competitors,
          entries,
          judges: state.judges.map((j) => ({ ...j, roleLabel: ROLES[j.role], hasVotes: state.votes.some((v) => v.judgeId === j.id) })),
          roles: ROLES,
          adjustments: state.adjustments,
          votesCount: state.votes.length,
          expectedVotes,
          ranking: ev.status === 'revealed' ? publicRanking() : null,
          teamRanking: ev.status === 'revealed' ? teamRanking() : null,
        });
      }
      if (m === 'POST' && p === '/api/admin/settings') {
        if (typeof body.name === 'string') ev.name = body.name.trim() || ev.name;
        if (typeof body.baseUrl === 'string') ev.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
        if (Array.isArray(body.teams)) {
          // Rinomina i team (stesso ordine = stesso team). Si possono aggiungere, non togliere quelli con concorrenti.
          const names = body.teams.map((x) => String(x || '').trim()).filter(Boolean);
          const used = ev.teams.filter((t, i) => i >= names.length && state.competitors.some((c) => c.teamId === t.id));
          if (used.length) return send(res, 409, { error: `${used[0].name} ha concorrenti: non si può togliere.` });
          ev.teams = names.map((name, i) => ({ id: (ev.teams[i] || {}).id || 't' + token(4), name }));
        }
        if (Array.isArray(body.teamExcluded)) ev.teamExcluded = body.teamExcluded.map(String);
        if (body.teamSize != null) {
          const n = Number(body.teamSize);
          if (!Number.isInteger(n) || n < 1) return send(res, 400, { error: 'Numero massimo per team non valido' });
          const over = ev.teams.find((t) => teamCount(t.id) > n);
          if (over) return send(res, 409, { error: `${over.name} ha già più di ${n} concorrenti.` });
          ev.teamSize = n;
        }
        if (typeof body.rules === 'string' || body.scaleMin != null || body.scaleMax != null || body.checkPoints != null) {
          if (state.votes.length) return send(res, 409, { error: 'Non puoi cambiare il regolamento dopo che sono arrivati voti.' });
          const lo = Number(body.scaleMin ?? ev.scaleMin), hi = Number(body.scaleMax ?? ev.scaleMax), cp = Number(body.checkPoints ?? ev.checkPoints);
          if (!Number.isInteger(lo) || !Number.isInteger(hi) || !(hi > lo)) return send(res, 400, { error: 'Scala non valida' });
          if (!(cp > 0)) return send(res, 400, { error: 'Punti della lista di controllo non validi' });
          if (typeof body.rules === 'string') {
            const parsed = parseRules(body.rules);
            if (parsed.errors.length) return send(res, 400, { error: parsed.errors.join(' ') });
            ev.rules = body.rules.trim();
            ev.categories = parsed.categories;
          }
          ev.scaleMin = lo; ev.scaleMax = hi; ev.checkPoints = cp;
        }
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/competitor') {
        // Il nome è facoltativo: l'abbinamento numero → nome può stare su un foglio Excel a parte.
        const number = String(body.number || '').trim() || nextNumber();
        const ex = state.competitors.find((c) => c.number === number);
        const teamId = String(body.teamId || '');
        if (ex && teamId && teamId !== ex.teamId) {
          const err = teamError(teamId, ex.id);
          if (err) return send(res, 409, { error: err });
        }
        if (ex) {
          if (teamId && teamId !== ex.teamId) { ex.teamId = teamId; if (!validCats(body.categoryId).filter((id) => !ex.categoryIds.includes(id)).length) { save(); return send(res, 200, { ok: true }); } }
          // Stesso numero con un'altra gara: si aggiunge la gara al concorrente esistente.
          const add = validCats(body.categoryId).filter((id) => !ex.categoryIds.includes(id));
          if (!add.length) return send(res, 409, { error: `Il numero ${number} esiste già${body.categoryId ? ' in questa gara' : ''}.` });
          ex.categoryIds.push(...add);
          if (String(body.name || '').trim()) ex.name = String(body.name).trim();
          save();
          return send(res, 200, { ok: true });
        }
        const err = teamError(teamId);
        if (err) return send(res, 409, { error: err });
        addCompetitor(number, String(body.name || '').trim(), body.categoryId ? [body.categoryId] : [], teamId);
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/competitor/import') {
        // Righe incollate da Excel/CSV: "numero<TAB>nome", "numero;nome" o solo "numero".
        // Una colonna che coincide con il nome di una categoria viene usata come categoria.
        let added = 0, updated = 0;
        const skipped = [];
        for (const line of String(body.text || '').split(/\r?\n/)) {
          const [num, ...rest] = line.split(/[\t;]/).map((x) => x.trim().replace(/^"|"$/g, ''));
          if (!num || /^(n|n°|num|numero|#)$/i.test(num)) continue;
          const catIds = [];
          const nameParts = [];
          let teamId = '';
          for (const f of rest) {
            // Anche più gare nella stessa cella, separate da virgola o "+".
            const parts = f ? f.split(/\s*[,+\/]\s*/) : [];
            const ids = parts.map((x) => (state.event.categories.find((k) => k.id === slug(x)) || {}).id);
            const team = f && teamByName(f);
            if (parts.length && ids.every(Boolean)) catIds.push(...ids);
            else if (team && !teamId) teamId = team.id;
            else if (f) nameParts.push(f);
          }
          const name = nameParts.join(' ').trim();
          const ex = state.competitors.find((c) => c.number === num);
          if (ex) {
            let changed = false;
            if (name && ex.name !== name) { ex.name = name; changed = true; }
            for (const id of validCats(catIds)) if (!ex.categoryIds.includes(id)) { ex.categoryIds.push(id); changed = true; }
            if (teamId && teamId !== ex.teamId) { if (teamError(teamId, ex.id)) skipped.push(num); else { ex.teamId = teamId; changed = true; } }
            if (changed) updated++;
          } else {
            if (teamId && teamError(teamId)) { skipped.push(num); teamId = ''; }
            addCompetitor(num, name, catIds, teamId); added++;
          }
        }
        save();
        return send(res, 200, { ok: true, added, updated, teamFull: skipped });
      }
      if (m === 'POST' && p === '/api/admin/competitor/update') {
        const c = state.competitors.find((x) => x.id === body.id);
        if (!c) return send(res, 404, { error: 'Concorrente non trovato' });
        if (Array.isArray(body.categoryIds)) {
          const next = validCats(body.categoryIds);
          const locked = c.categoryIds.filter((id) => !next.includes(id) &&
            (state.votes.some((v) => v.competitorId === c.id && v.categoryId === id) || state.adjustments.some((a) => a.competitorId === c.id && a.categoryId === id)));
          if (locked.length) return send(res, 409, { error: `Non puoi togliere la gara "${catById(locked[0]).name}": ha già voti o bonus.` });
          c.categoryIds = next;
        }
        if (typeof body.teamId === 'string' && body.teamId !== c.teamId) {
          const err = teamError(body.teamId, c.id);
          if (err) return send(res, 409, { error: err });
          c.teamId = body.teamId;
        }
        if (typeof body.name === 'string') c.name = body.name.trim();
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/adjust') {
        // Bonus/malus dell'organizzatore (es. +2 / -2), sommato al totale dei giudici.
        const c = state.competitors.find((x) => x.id === body.competitorId);
        if (!c) return send(res, 404, { error: 'Concorrente non trovato' });
        if (!c.categoryIds.includes(body.categoryId)) return send(res, 400, { error: 'Gara non valida per questo concorrente' });
        const delta = Number(body.delta);
        if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 100) return send(res, 400, { error: 'Valore non valido' });
        state.adjustments.push({ id: token(6), competitorId: c.id, categoryId: body.categoryId, delta, note: String(body.note || '').trim().slice(0, 200), at: new Date().toISOString() });
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/adjust/delete') {
        const i = state.adjustments.findIndex((a) => a.id === body.id);
        if (i >= 0) state.adjustments.splice(i, 1);
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/judge') {
        if (!String(body.name || '').trim()) return send(res, 400, { error: 'Nome obbligatorio' });
        addJudge(String(body.name).trim(), body.role);
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && (p === '/api/admin/competitor/delete' || p === '/api/admin/judge/delete')) {
        const isJudge = p.includes('judge');
        const votes = state.votes.filter((v) => (isJudge ? v.judgeId : v.competitorId) === body.id).length;
        const adj = isJudge ? 0 : state.adjustments.filter((a) => a.competitorId === body.id).length;
        // Con voti o bonus serve una seconda conferma: vengono cancellati insieme.
        if ((votes || adj) && !body.force) {
          return send(res, 409, { needsForce: true, votes, adjustments: adj, error: 'Ha già dei voti registrati.' });
        }
        state.votes = state.votes.filter((v) => (isJudge ? v.judgeId : v.competitorId) !== body.id);
        if (!isJudge) state.adjustments = state.adjustments.filter((a) => a.competitorId !== body.id);
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
        // Una sezione per categoria, ognuna con le sue colonne di criteri (media dei giudici).
        const lines = [];
        for (const g of publicRanking()) {
          if (lines.length) lines.push([]);
          lines.push([g.name.toUpperCase()]);
          lines.push(['Posizione', 'Numero', 'Concorrente', 'Voti', 'Totale', ...g.criteria.map((c) => c.label + ' (media)')]);
          for (const r of g.rows) lines.push([r.position, r.number, r.name, r.votes, r.total, ...g.criteria.map((c) => r.perCriterion[c.id] ?? '')]);
        }
        const tr = teamRanking();
        if (tr.length) {
          lines.push([], ['CLASSIFICA A SQUADRE'], ['Posizione', 'Team', 'Totale', 'Concorrenti']);
          for (const t of tr) lines.push([t.position, t.name, t.total, t.members.map((x) => `#${x.number}${x.name ? ' ' + x.name : ''} (${x.total})`).join(', ')]);
        }
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
  console.log(`  Password admin (solo da altri dispositivi): ${state.adminPassword}\n`);
});
