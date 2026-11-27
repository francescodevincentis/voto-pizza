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
const STANDARD = 'gusto: Gusto | Cottura | Presentazione\nforno: Etica professionale | Pulizia';
const DEFAULT_RULES = [
  ...['Classica', 'Gourmet', 'Contemporanea', 'Chef', 'Senza Glutine', 'In pala', 'Amatoriale', 'Genio e follia']
    .map((n) => `# ${n}\n${STANDARD}`),
  `# Napoletana
forno ±5: Impasto | Divisa | Pomodoro 60/80 gr | Mozzarella 80/100 gr
forno ±5: Mozzarella tagliata a listelli
forno ±5: Sale sul pomodoro | Basilico in cottura | Oliera | Cottura 90 secondi | Stesura con schiaffo | Infornata con rotatoria senza fuoriuscita | Panetto 180/250 gr | Bordo da 1 a 2 cm (oltre: penalità) | Straccio per pulire la pizza | La pizza non deve superare 35 cm ø
forno ±5: Monili e gioielli
gusto: Gusto | Cottura | Presentazione`,
  `# Ruota di carro
forno: Etica professionale | Pulizia
forno -5: Diametro inferiore a 35 cm ø
gusto: Gusto | Cottura | Presentazione`,
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
      weighted: true, // voto ponderato: scarta il voto più alto e il più basso per criterio (con almeno 3 giudici)
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
    overrides: [], // { competitorId, categoryId, total, at }  totale voti corretto a mano dalla regia
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
if (!Array.isArray(state.overrides)) state.overrides = [];
if (typeof state.event.weighted !== 'boolean') state.event.weighted = true;
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
// Napoletana: "Monili e gioielli" e "Mozzarella tagliata a listelli" passano da sola penalità a ±5 (Tutto ok +5, Penalità −5). Stesso id, i voti restano validi.
if (typeof state.event.rules === 'string' && /forno -5: (Monili e gioielli|Mozzarella tagliata a listelli)/.test(state.event.rules)) {
  state.event.rules = state.event.rules.replace('forno -5: Monili e gioielli', 'forno ±5: Monili e gioielli').replace('forno -5: Mozzarella tagliata a listelli', 'forno ±5: Mozzarella tagliata a listelli');
  state.event.categories = parseRules(state.event.rules).categories;
  save();
}
// Napoletana e Ruota di carro: votano anche i giudici di gusto (Gusto, Cottura, Presentazione). La riga va in fondo alla categoria,
// così gli id dei criteri di forno non cambiano e i voti già dati restano validi.
if (typeof state.event.rules === 'string') {
  const blocks = state.event.rules.split(/\n(?=#)/);
  let changed = false;
  for (const name of ['Napoletana', 'Ruota di carro']) {
    const i = blocks.findIndex((b) => new RegExp('^#\\s*' + name + '\\s*$', 'im').test(b.split('\n')[0]));
    if (i >= 0 && !/^gusto\s*:/im.test(blocks[i])) {
      blocks[i] = blocks[i].replace(/\s*$/, '') + '\ngusto: Gusto | Cottura | Presentazione' + (i < blocks.length - 1 ? '\n' : '');
      changed = true;
    }
  }
  if (changed) {
    state.event.rules = blocks.join('\n');
    state.event.categories = parseRules(state.event.rules).categories;
    save();
  }
}
// Numeri di pettorina senza zeri davanti ("03" -> "3"), se non creano doppioni.
{
  let changed = false;
  for (const c of state.competitors) {
    const n = /^0+\d+$/.test(c.number) ? String(parseInt(c.number, 10)) : null;
    if (n && !state.competitors.some((x) => x !== c && x.number === n)) { c.number = n; changed = true; }
  }
  if (changed) save();
}
// Etica professionale e Pulizia diventano due voti separati (stesso ordine: Etica resta k4, Pulizia è il nuovo k5).
if (typeof state.event.rules === 'string' && /forno:\s*Etica professionale e pulizia/i.test(state.event.rules)) {
  state.event.rules = state.event.rules.replace(/forno:\s*Etica professionale e pulizia/gi, 'forno: Etica professionale | Pulizia');
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
  if (typeof c.teamCategoryId !== 'string') c.teamCategoryId = '';
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
  for (let i = 0; i < 12; i++) addCompetitor(String(i + 1), '', [cats[i % cats.length].id]);
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
  return String(max + 1);
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
// cats: gare del concorrente. Se nessuna conta per la squadra (es. solo Chef, Amatoriale, Genio e follia, Napoletana)
// non può entrare in un team.
function teamError(teamId, exceptId, cats) {
  if (!teamId) return null;
  const t = state.event.teams.find((x) => x.id === teamId);
  if (!t) return 'Team non trovato';
  if (cats && !cats.some((id) => teamCats().includes(id))) return 'Le gare di questo concorrente non contano per la classifica a squadre: non può entrare in un team.';
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
// Punteggio di un concorrente in una gara.
// Voto ponderato (event.weighted, formula di Francesco 27/11): per ogni criterio media ponderata con i pesi di weightsFor;
// totale = somma dei criteri (gusto + forno). Senza ponderazione: somma piena dei punti di tutti i giudici.
// Pesi per n voti ordinati dal più basso al più alto (somma = 1).
// Voto ponderato con almeno 3 giudici: il più basso e il più alto pesano 1, ciascun voto centrale 6 (stesso rapporto 5%/30%).
// 5 giudici: 5% · 30% · 30% · 30% · 5%;  4: 7,14% · 42,86% · 42,86% · 7,14%;  3: 12,5% · 75% · 12,5%.
// Con 1–2 giudici, o ponderazione spenta: media semplice.
function weightsFor(n) {
  if (!state.event.weighted || n < 3) return Array(n).fill(1 / n);
  const raw = Array.from({ length: n }, (_, i) => (i === 0 || i === n - 1 ? 1 : 6));
  const tot = raw.reduce((a, x) => a + x, 0);
  return raw.map((x) => x / tot);
}
function scoreOf(competitorId, catId) {
  const cat = catById(catId);
  const vs = state.votes.filter((v) => v.competitorId === competitorId && v.categoryId === catId);
  const byRole = { gusto: 0, forno: 0 };
  const perCriterion = {};
  if (!state.event.weighted) {
    for (const v of vs) byRole[v.role] = (byRole[v.role] || 0) + v.total;
  }
  for (const cr of cat ? cat.criteria : []) {
    let vals = vs.filter((v) => cr.id in v.scores).map((v) => points(cr, v.scores[cr.id])).sort((a, b) => a - b);
    if (!vals.length) { perCriterion[cr.id] = null; continue; }
    const w = weightsFor(vals.length);
    const val = vals.reduce((a, x, i) => a + x * w[i], 0); // media ponderata (pesi che sommano a 1)
    perCriterion[cr.id] = r2(val);
    if (state.event.weighted) byRole[cr.role] += val;
  }
  return { vs, byRole, perCriterion, total: r2(byRole.gusto + byRole.forno) };
}
const overrideOf = (competitorId, categoryId) => state.overrides.find((o) => o.competitorId === competitorId && o.categoryId === categoryId);

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
    const { vs, byRole, perCriterion, total: computed } = scoreOf(c.id, catId);
    const ov = overrideOf(c.id, catId);
    const votesTotal = ov ? ov.total : computed;
    const bonus = state.adjustments.filter((a) => a.competitorId === c.id && a.categoryId === catId).reduce((a, x) => a + x.delta, 0);
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
function teamCats() {
  return state.event.categories.filter((k) => !state.event.teamExcluded.includes(k.id)).map((k) => k.id);
}
// Gara che il concorrente porta alla squadra: una sola, tra quelle valide per la squadra.
// Se non è stata scelta e ne fa una sola valida, si usa quella.
// I compagni dello stesso team devono portare gare diverse. Prima valgono le scelte esplicite; chi fa una sola
// gara valida la prende in automatico, se nessun compagno (prima di lui nell'elenco) la porta già.
function teamAssignments(teamId) {
  const members = state.competitors.filter((x) => teamId && x.teamId === teamId);
  const out = {};
  const used = new Set();
  for (const m of members) {
    const valid = teamCats().filter((id) => m.categoryIds.includes(id));
    if (m.teamCategoryId && valid.includes(m.teamCategoryId) && !used.has(m.teamCategoryId)) { out[m.id] = m.teamCategoryId; used.add(m.teamCategoryId); }
  }
  for (const m of members) {
    if (out[m.id]) continue;
    const valid = teamCats().filter((id) => m.categoryIds.includes(id));
    if (valid.length === 1 && !used.has(valid[0])) { out[m.id] = valid[0]; used.add(valid[0]); } else out[m.id] = '';
  }
  return out;
}
function teamCatOf(c) {
  return c.teamId ? teamAssignments(c.teamId)[c.id] || '' : '';
}
function teamRanking() {
  const totals = {}; // numero|gara -> totale
  for (const g of ranking()) for (const r of g.rows) totals[r.number + '|' + g.id] = r.total;
  const rows = state.event.teams.map((t) => {
    const members = state.competitors.filter((c) => c.teamId === t.id).map((c) => {
      const cat = teamCatOf(c);
      return { number: c.number, name: c.name, category: cat ? catById(cat).name : '', total: r2(cat ? totals[c.number + '|' + cat] || 0 : 0) };
    });
    return { name: t.name, members, total: r2(members.reduce((a, m) => a + m.total, 0)) };
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
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
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
          // I giudici vedono numero, nome e categoria (scelta dell'organizzatore, 26/11).
          // Una riga per ogni gara del concorrente che spetta a questo giudice.
          competitors: state.competitors.flatMap((c) => judgeCats(judge, c).map((id) => ({
            number: c.number, name: c.name, code: c.code, categoryId: id, category: catById(id).name, voted: hasVoted(judge, c, id),
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
            competitor: { number: c.number, name: c.name, code: c.code },
            choose: mineCats.map((id) => ({ id, name: catById(id).name, voted: hasVoted(judge, c, id) })),
          });
        }
        const catId = wanted || mineCats[0];
        if (!mineCats.includes(catId)) return send(res, 409, { error: 'Questa gara non va votata da te.' });
        const cat = catById(catId);
        const criteria = criteriaFor(catId, judge);
        const voted = hasVoted(judge, c, catId);
        return send(res, 200, {
          competitor: { number: c.number, name: c.name, code: c.code, category: cat.name, categoryId: catId, otherCats: mineCats.length > 1 },
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
          teamCat: teamCatOf(c),
          teamTaken: state.competitors.filter((x) => x.id !== c.id && c.teamId && x.teamId === c.teamId && teamCatOf(x)).map((x) => ({ id: teamCatOf(x), number: x.number })),
          votedCats: [...new Set(state.votes.filter((v) => v.competitorId === c.id).map((v) => v.categoryId))],
        }));
        // Una riga per iscrizione (concorrente + gara).
        const entries = state.competitors.flatMap((c) => c.categoryIds.filter((id) => catById(id)).map((id) => ({
          competitorId: c.id, number: c.number, name: c.name, categoryId: id, category: catById(id).name,
          judgesExpected: state.judges.filter((j) => criteriaFor(id, j).length).map((j) => j.id),
          judgesVoted: state.judges.filter((j) => hasVoted(j, c, id)).map((j) => j.id),
          bonus: state.adjustments.filter((a) => a.competitorId === c.id && a.categoryId === id).reduce((a, x) => a + x.delta, 0),
          // Totale dei voti dei giudici (senza bonus/malus) e l'eventuale correzione manuale.
          votesTotal: scoreOf(c.id, id).total,
          override: overrideOf(c.id, id) ? overrideOf(c.id, id).total : null,
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
          nextNumber: nextNumber(),
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
        if (typeof body.weighted === 'boolean') ev.weighted = body.weighted;
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
      if (m === 'POST' && p === '/api/admin/competitor/renumber') {
        // Numeri di pettorina in sequenza 1, 2, 3… nell'ordine attuale. Un concorrente = un numero, in tutte le sue gare.
        const sorted = [...state.competitors].sort((a, b) => (parseInt(a.number, 10) || 1e9) - (parseInt(b.number, 10) || 1e9) || String(a.number).localeCompare(String(b.number)));
        sorted.forEach((c, i) => { c.number = String(i + 1); });
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/competitor') {
        // Il nome è facoltativo: l'abbinamento numero → nome può stare su un foglio Excel a parte.
        const number = String(body.number || '').trim() || nextNumber();
        const ex = state.competitors.find((c) => c.number === number);
        const teamId = String(body.teamId || '');
        if (ex && teamId && teamId !== ex.teamId) {
          const err = teamError(teamId, ex.id, [...ex.categoryIds, ...validCats(body.categoryId)]);
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
        const err = teamError(teamId, undefined, validCats(body.categoryId));
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
            if (teamId && teamId !== ex.teamId) { if (teamError(teamId, ex.id, ex.categoryIds)) skipped.push(num); else { ex.teamId = teamId; changed = true; } }
            if (changed) updated++;
          } else {
            if (teamId && teamError(teamId, undefined, validCats(catIds))) { skipped.push(num); teamId = ''; }
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
        if (typeof body.teamCategoryId === 'string') {
          const id = body.teamCategoryId;
          if (id && !teamCats().includes(id)) return send(res, 400, { error: 'Questa gara non conta per la squadra.' });
          const mate = id && state.competitors.find((x) => x.id !== c.id && c.teamId && x.teamId === c.teamId && teamCatOf(x) === id);
          if (mate) return send(res, 409, { error: `${catById(id).name} la porta già il #${mate.number} in questo team: scegli un'altra gara.` });
          if (id && !c.categoryIds.includes(id)) c.categoryIds.push(id); // la gara per la squadra è anche una sua gara
          c.teamCategoryId = id;
        }
        if (typeof body.teamId === 'string' && body.teamId !== c.teamId) {
          const err = teamError(body.teamId, c.id, c.categoryIds);
          if (err) return send(res, 409, { error: err });
          c.teamId = body.teamId;
          // Nel nuovo team la sua gara per la squadra potrebbe essere già presa: va scelta di nuovo.
          if (c.teamCategoryId && state.competitors.some((x) => x.id !== c.id && x.teamId === c.teamId && teamCatOf(x) === c.teamCategoryId)) c.teamCategoryId = '';
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
      if (m === 'POST' && p === '/api/admin/override') {
        // Correzione manuale del totale voti di un concorrente in una gara. total vuoto = torna al calcolo automatico.
        const c = state.competitors.find((x) => x.id === body.competitorId);
        if (!c) return send(res, 404, { error: 'Concorrente non trovato' });
        if (!c.categoryIds.includes(body.categoryId)) return send(res, 400, { error: 'Gara non valida per questo concorrente' });
        state.overrides = state.overrides.filter((o) => !(o.competitorId === c.id && o.categoryId === body.categoryId));
        if (body.total !== null && body.total !== '' && body.total !== undefined) {
          const total = Number(body.total);
          if (!Number.isFinite(total) || Math.abs(total) > 100000) return send(res, 400, { error: 'Valore non valido' });
          state.overrides.push({ competitorId: c.id, categoryId: body.categoryId, total: r2(total), at: new Date().toISOString() });
        }
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
        if (!isJudge) state.overrides = state.overrides.filter((o) => o.competitorId !== body.id);
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
      if (m === 'POST' && p === '/api/admin/reset-votes') {
        // Per le prove: toglie voti, bonus/malus e correzioni manuali; concorrenti, giudici, team e regolamento restano.
        // Prima salva una copia di sicurezza accanto a data.json.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backup = path.join(__dirname, `data-backup-${stamp}.json`);
        fs.writeFileSync(backup, JSON.stringify(state, null, 2));
        const removed = state.votes.length;
        state.votes = [];
        state.adjustments = [];
        state.overrides = [];
        state.event.status = 'open';
        save();
        return send(res, 200, { ok: true, removed, backup: path.basename(backup) });
      }
      if (m === 'POST' && p === '/api/admin/reset') {
        const keep = state.adminPassword;
        state = defaultState();
        state.adminPassword = keep;
        if (body.demo) seedDemo();
        save();
        return send(res, 200, { ok: true });
      }
      if (m === 'GET' && p === '/api/admin/export-voti.csv') {
        // Dettaglio per verificare i conti: ogni voto di ogni giudice (dal più basso al più alto), con il peso usato.
        if (ev.status !== 'revealed') return send(res, 403, 'Disponibile solo dopo la rivelazione');
        const lines = [['Gara', 'Numero', 'Concorrente', 'Criterio', 'Giudice', 'Voto (punti)', 'Peso', 'Punti contati (voto × peso)']];
        for (const c of [...state.competitors].sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0))) {
          for (const catId of c.categoryIds) {
            const cat = catById(catId);
            if (!cat) continue;
            const vs = state.votes.filter((v) => v.competitorId === c.id && v.categoryId === catId);
            if (!vs.length) continue;
            const sc = scoreOf(c.id, catId);
            for (const cr of cat.criteria) {
              const given = vs.filter((v) => cr.id in v.scores).map((v) => ({ judge: (state.judges.find((j) => j.id === v.judgeId) || { name: '?' }).name, pts: points(cr, v.scores[cr.id]) }));
              const order = [...given].sort((a, b) => a.pts - b.pts);
              const ws = weightsFor(order.length);
              const pct = (x) => String(r2(x * 100)).replace('.', ',') + '%';
              order.forEach((g, k) => lines.push([cat.name, c.number, c.name, cr.label, g.judge, g.pts, pct(ws[k]), String(r2(g.pts * ws[k])).replace('.', ',')]));
              if (given.length) lines.push([cat.name, c.number, c.name, cr.label + ' (voto del criterio)', '', '', '', String(sc.perCriterion[cr.id]).replace('.', ',')]);
            }
            lines.push([cat.name, c.number, c.name, 'TOTALE', '', '', '', String(sc.total).replace('.', ',')], []);
          }
        }
        const csv = lines.map((l) => l.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n');
        return send(res, 200, '\ufeff' + csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="voti-dettaglio.csv"' });
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
          lines.push([], ['CLASSIFICA A SQUADRE'], ['Posizione', 'Team', 'Totale', 'Concorrenti (gara per la squadra, punti)']);
          for (const t of tr) lines.push([t.position, t.name, t.total, t.members.map((x) => `#${x.number}${x.name ? ' ' + x.name : ''} (${x.category || 'gara non scelta'}, ${x.total})`).join(', ')]);
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
