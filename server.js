'use strict';
/*
 * Roni Arena - game server (zero dependencies: only Node built-ins)
 * HTTP static files + a tiny WebSocket implementation + all game logic.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- config ----------
const PORT = +process.env.PORT || 3000;
const TARGET = +process.env.TARGET_SCORE || 20;          // score needed to win
const SCORE_MODE = process.env.SCORE_MODE === 'hits' ? 'hits' : 'kills'; // 'kills' or 'hits'
const WIN_COINS = 100;                                    // coins for each winner
const MIN_PLAYERS = +process.env.MIN_PLAYERS || 2;
const RESPAWN_MS = +process.env.RESPAWN_MS || 3000;
const TOPUP_TEST = process.env.TOPUP_TEST !== '0';        // demo topup (no real payment)
const FB_APP_ID = process.env.FB_APP_ID || '';
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';
const MAX_LV = 5;
const ARENA = 58;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');

const GUNS = {
  mg:     { name: 'Machine Gun', dmg: 12, rate: 8,   range: 120, price: 0,    upg: 100 },
  smg:    { name: 'SMG',         dmg: 9,  rate: 14,  range: 90,  price: 400,  upg: 150 },
  lmg:    { name: 'LMG',         dmg: 16, rate: 10,  range: 130, price: 1400, upg: 250 },
  rifle:  { name: 'Rifle',       dmg: 24, rate: 6,   range: 160, price: 900,  upg: 200 },
  sniper: { name: 'Sniper',      dmg: 75, rate: 1.2, range: 250, price: 1800, upg: 350 },
};
const PACKS = { p50: { coins: 500, taka: 50 }, p100: { coins: 1100, taka: 100 }, p200: { coins: 2400, taka: 200 } };
const MODE_MAX = { solo: 10, duo: 10, squad: 8 };
const dmgOf = (gun, lv) => Math.round(GUNS[gun].dmg * (1 + 0.1 * lv));
const upgCost = (gun, lv) => GUNS[gun].upg * (lv + 1);

const SPAWNS = [];
for (let i = 0; i < 10; i++) {
  const a = (i / 10) * Math.PI * 2;
  SPAWNS.push({ x: +(Math.sin(a) * 44).toFixed(2), z: +(Math.cos(a) * 44).toFixed(2) });
}

// ---------- database (JSON file) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, nextId: 100001 };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* new db */ }
const identIndex = {};
const tokenIndex = {};
for (const u of Object.values(db.users)) {
  identIndex[u.ident] = u.id;
  for (const t of u.tokens || []) tokenIndex[t] = u.id;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}

// ---------- helpers ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const num = (v, lim) => { v = +v; if (!isFinite(v)) return 0; return Math.max(-lim, Math.min(lim, v)); };
const r2 = v => Math.round(v * 100) / 100;
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);

function normIdent(s) {
  s = String(s || '').trim();
  if (s.includes('@')) {
    s = s.toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 80 ? s : null;
  }
  let d = s.replace(/[\s\-()]/g, '');
  if (d.startsWith('+880')) d = '0' + d.slice(4);
  else if (d.startsWith('880')) d = '0' + d.slice(3);
  return /^\+?\d{10,15}$/.test(d) ? d : null;
}

function publicUser(u) {
  return { id: u.id, name: u.name, coins: u.coins, guns: u.guns, equipped: u.equipped, wins: u.wins || 0 };
}

function createUser(ident, name, pw) {
  const id = String(db.nextId++);
  const u = { id, ident, name: cleanName(name) || 'Player' + id, coins: 0, guns: { mg: 0 }, equipped: 'mg',
    wins: 0, friends: [], reqs: [], tokens: [], created: Date.now() };
  if (pw) { u.salt = rnd(16); u.pw = hashPw(pw, u.salt); }
  db.users[id] = u;
  identIndex[ident] = id;
  save();
  return u;
}

// ---------- minimal WebSocket ----------
const sessions = new Map();  // uid -> Sock
const H = {};                // event handlers: H[event] = (sock, data, ack)

function wsFrame(str) {
  const p = Buffer.from(str);
  const n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}

class Sock {
  constructor(raw) {
    this.raw = raw; this.uid = null; this.buf = Buffer.alloc(0); this.frag = [];
    this.alive = true; this.fails = 0; this.winStart = Date.now(); this.winCount = 0;
    raw.on('data', c => this.onData(c));
    raw.on('close', () => this.onClose());
    raw.on('error', () => this.onClose());
  }
  emit(e, d) { if (this.alive) { try { this.raw.write(wsFrame(JSON.stringify({ e, d }))); } catch (x) { /* ignore */ } } }
  close() { if (this.alive) { this.raw.destroy(); } this.onClose(); }
  onClose() {
    if (!this.alive) return;
    this.alive = false;
    onDisconnect(this);
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > (1 << 20)) return this.close();
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > (1 << 20)) return this.close();
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), need));
      if (masked) { const m = b.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(need);
      if (op === 8) return this.close();
      if (op === 9) { if (payload.length < 126) this.raw.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 1 || op === 0) {
        this.frag.push(payload);
        if (fin) { const s = Buffer.concat(this.frag).toString('utf8'); this.frag = []; this.handle(s); }
      }
    }
  }
  handle(s) {
    const now = Date.now();
    if (now - this.winStart > 1000) { this.winStart = now; this.winCount = 0; }
    if (++this.winCount > 150) return;                       // flood guard
    let m; try { m = JSON.parse(s); } catch (e) { return; }
    if (!m || typeof m.e !== 'string' || !Object.prototype.hasOwnProperty.call(H, m.e)) return;
    const ack = r => { if (m.i != null && this.alive) { try { this.raw.write(wsFrame(JSON.stringify({ a: m.i, d: r }))); } catch (x) { /* ignore */ } } };
    if (!m.e.startsWith('auth:') && !this.uid) return ack({ ok: false, err: 'Login required' });
    try { H[m.e](this, m.d || {}, ack); } catch (err) { console.error('handler error', m.e, err); ack({ ok: false, err: 'Server error' }); }
  }
}

// ---------- HTTP (static files + config) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ fbAppId: FB_APP_ID && FB_APP_SECRET ? FB_APP_ID : '' }));
  }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.url || '').split('?')[0] !== '/ws') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  new Sock(socket);
});

setInterval(() => { for (const s of sessions.values()) if (s.alive) s.raw.write(Buffer.from([0x89, 0x00])); }, 25000);

// ---------- auth ----------
function login(sock, u, cb) {
  const old = sessions.get(u.id);
  if (old && old !== sock) { old.emit('kicked', { msg: 'Logged in from another place' }); old.uid = null; old.close(); }
  sock.uid = u.id;
  sessions.set(u.id, sock);
  const t = rnd(24);
  u.tokens = (u.tokens || []).slice(-4);
  u.tokens.push(sha(t));
  tokenIndex[sha(t)] = u.id;
  save();
  cb({ ok: true, token: t });
  sock.emit('init', { me: publicUser(u), guns: GUNS, packs: PACKS, target: TARGET, maxLv: MAX_LV, topupTest: TOPUP_TEST, scoreMode: SCORE_MODE });
  sendFriends(u.id);
  notifyPresence(u.id);
  const code = userRoom.get(u.id);
  if (code && rooms.get(code)) { sock.emit('room:update', roomPayload(rooms.get(code))); }
}
function failAuth(sock, cb, err) { sock.fails++; cb({ ok: false, err }); if (sock.fails > 10) sock.close(); }

H['auth:register'] = (sock, d, ack) => {
  const ident = normIdent(d.id);
  if (!ident) return failAuth(sock, ack, 'Valid email or mobile number din');
  const pw = String(d.password || '');
  if (pw.length < 6 || pw.length > 64) return failAuth(sock, ack, 'Password kom pokkhe 6 character');
  if (identIndex[ident]) return failAuth(sock, ack, 'Ei email/number age theke ache');
  login(sock, createUser(ident, d.name, pw), ack);
};
H['auth:login'] = (sock, d, ack) => {
  const ident = normIdent(d.id);
  const u = ident && db.users[identIndex[ident]];
  if (!u || !u.pw) return failAuth(sock, ack, 'Email/number ba password bhul');
  const a = Buffer.from(hashPw(String(d.password || ''), u.salt), 'hex'), b = Buffer.from(u.pw, 'hex');
  if (!crypto.timingSafeEqual(a, b)) return failAuth(sock, ack, 'Email/number ba password bhul');
  login(sock, u, ack);
};
H['auth:token'] = (sock, d, ack) => {
  const uid = tokenIndex[sha(String(d.token || ''))];
  const u = uid && db.users[uid];
  if (!u) return failAuth(sock, ack, 'Session sesh, abar login korun');
  login(sock, u, ack);
};
H['auth:facebook'] = async (sock, d, ack) => {
  if (!FB_APP_ID || !FB_APP_SECRET) return ack({ ok: false, err: 'Facebook login server-e set kora nei (FB_APP_ID + FB_APP_SECRET dorkar)' });
  try {
    const tok = String(d.token || '');
    const dbg = await (await fetch('https://graph.facebook.com/debug_token?input_token=' + encodeURIComponent(tok) +
      '&access_token=' + encodeURIComponent(FB_APP_ID + '|' + FB_APP_SECRET))).json();
    if (!dbg.data || !dbg.data.is_valid || String(dbg.data.app_id) !== FB_APP_ID) throw new Error('bad token');
    const me = await (await fetch('https://graph.facebook.com/me?fields=id,name&access_token=' + encodeURIComponent(tok))).json();
    if (!me.id) throw new Error('no id');
    const ident = 'fb:' + me.id;
    const u = db.users[identIndex[ident]] || createUser(ident, me.name, null);
    login(sock, u, ack);
  } catch (e) { ack({ ok: false, err: 'Facebook login fail hoyeche' }); }
};

// ---------- friends ----------
function sendMe(uid) { const s = sessions.get(uid), u = db.users[uid]; if (s && u) s.emit('me', publicUser(u)); }
function sendFriends(uid) {
  const s = sessions.get(uid), u = db.users[uid];
  if (!s || !u) return;
  s.emit('friends', {
    list: u.friends.map(f => ({ id: f, name: db.users[f].name, online: sessions.has(f), inRoom: !!userRoom.get(f) })),
    requests: u.reqs.map(f => ({ id: f, name: db.users[f].name })),
  });
}
function notifyPresence(uid) { const u = db.users[uid]; if (u) for (const f of u.friends) sendFriends(f); }

H['friends:request'] = (sock, d, ack) => {
  const me = db.users[sock.uid], t = db.users[String(d.id || '').trim()];
  if (!t) return ack({ ok: false, err: 'Ei ID-te kono player nai' });
  if (t.id === me.id) return ack({ ok: false, err: 'Nijeke add kora jay na' });
  if (me.friends.includes(t.id)) return ack({ ok: false, err: 'Age theke friend' });
  if (me.reqs.includes(t.id)) { return H['friends:accept'](sock, { id: t.id }, ack); }
  if (!t.reqs.includes(me.id)) t.reqs.push(me.id);
  save();
  sendFriends(t.id);
  const ts = sessions.get(t.id); if (ts) ts.emit('toast', { msg: me.name + ' apnake friend request pathiyeche' });
  ack({ ok: true, msg: 'Request pathano hoyeche: ' + t.name });
};
H['friends:accept'] = (sock, d, ack) => {
  const me = db.users[sock.uid], t = db.users[String(d.id || '')];
  if (!t || !me.reqs.includes(t.id)) return ack({ ok: false, err: 'Request pawa jayni' });
  me.reqs = me.reqs.filter(x => x !== t.id);
  if (!me.friends.includes(t.id)) me.friends.push(t.id);
  if (!t.friends.includes(me.id)) t.friends.push(me.id);
  t.reqs = t.reqs.filter(x => x !== me.id);
  save(); sendFriends(me.id); sendFriends(t.id);
  ack({ ok: true, msg: t.name + ' ekhon apnar friend' });
};
H['friends:decline'] = (sock, d, ack) => {
  const me = db.users[sock.uid];
  me.reqs = me.reqs.filter(x => x !== String(d.id));
  save(); sendFriends(me.id); ack({ ok: true });
};
H['friends:remove'] = (sock, d, ack) => {
  const me = db.users[sock.uid], t = db.users[String(d.id || '')];
  me.friends = me.friends.filter(x => x !== String(d.id));
  if (t) t.friends = t.friends.filter(x => x !== me.id);
  save(); sendFriends(me.id); if (t) sendFriends(t.id); ack({ ok: true });
};

// ---------- rooms ----------
const rooms = new Map();     // code -> room
const userRoom = new Map();  // uid -> code
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function teamsOf(r) {
  const m = {};
  r.players.forEach((uid, i) => { m[uid] = r.mode === 'solo' ? i : r.mode === 'duo' ? Math.floor(i / 2) : i % 2; });
  return m;
}
function roomPayload(r) {
  const t = teamsOf(r);
  return { code: r.code, host: r.host, mode: r.mode, max: r.max, state: r.game ? 'playing' : 'lobby', min: MIN_PLAYERS,
    players: r.players.map(uid => ({ id: uid, name: db.users[uid].name, team: t[uid] })) };
}
function toRoom(r, e, d) { for (const uid of r.players) { const s = sessions.get(uid); if (s) s.emit(e, d); } }
function emitRoom(r) { toRoom(r, 'room:update', roomPayload(r)); }

function joinRoom(uid, r) {
  r.players.push(uid);
  userRoom.set(uid, r.code);
  emitRoom(r);
  notifyPresence(uid);
}
function leaveRoom(uid) {
  const code = userRoom.get(uid);
  if (!code) return;
  userRoom.delete(uid);
  const s = sessions.get(uid);
  if (s) s.emit('room:left', {});
  const r = rooms.get(code);
  if (!r) return;
  r.players = r.players.filter(x => x !== uid);
  if (r.game) {
    delete r.game.players[uid];
    const teams = new Set(Object.values(r.game.players).map(p => p.team));
    if (teams.size < 2) endGame(r, teams.size ? [...teams][0] : null, true);
  }
  if (!r.players.length) { if (r.game) clearInterval(r.game.timer); rooms.delete(code); }
  else { if (r.host === uid) r.host = r.players[0]; emitRoom(r); }
  notifyPresence(uid);
}

H['room:create'] = (sock, d, ack) => {
  const mode = MODE_MAX[d.mode] ? d.mode : 'solo';
  const max = Math.max(2, Math.min(MODE_MAX[mode], Math.floor(+d.max) || MODE_MAX[mode]));
  leaveRoom(sock.uid);
  const r = { code: newCode(), host: sock.uid, mode, max, players: [], game: null };
  rooms.set(r.code, r);
  joinRoom(sock.uid, r);
  ack({ ok: true, code: r.code });
};
H['room:join'] = (sock, d, ack) => {
  const r = rooms.get(String(d.code || '').trim().toUpperCase());
  if (!r) return ack({ ok: false, err: 'Room paoa jayni' });
  if (r.players.includes(sock.uid)) return ack({ ok: true });
  if (r.game) return ack({ ok: false, err: 'Match cholche, pore join korun' });
  if (r.players.length >= r.max) return ack({ ok: false, err: 'Room full' });
  leaveRoom(sock.uid);
  joinRoom(sock.uid, r);
  ack({ ok: true });
};
H['room:leave'] = (sock, d, ack) => { leaveRoom(sock.uid); ack({ ok: true }); };
H['room:config'] = (sock, d, ack) => {
  const r = rooms.get(userRoom.get(sock.uid));
  if (!r || r.host !== sock.uid || r.game) return ack({ ok: false, err: 'Shudhu host lobby-te change korte pare' });
  const mode = MODE_MAX[d.mode] ? d.mode : r.mode;
  const max = Math.max(2, Math.min(MODE_MAX[mode], Math.floor(+d.max) || r.max));
  if (max < r.players.length) return ack({ ok: false, err: 'Ekhon ' + r.players.length + ' jon ache, kom kora jabe na' });
  r.mode = mode; r.max = max;
  emitRoom(r); ack({ ok: true });
};
H['room:invite'] = (sock, d, ack) => {
  const me = db.users[sock.uid], r = rooms.get(userRoom.get(sock.uid));
  const fid = String(d.id || '');
  if (!r) return ack({ ok: false, err: 'Age room banan' });
  if (!me.friends.includes(fid)) return ack({ ok: false, err: 'Friend noy' });
  const fs_ = sessions.get(fid);
  if (!fs_) return ack({ ok: false, err: 'Friend offline' });
  if (r.players.includes(fid)) return ack({ ok: false, err: 'Already room-e ache' });
  fs_.emit('invite', { from: { id: me.id, name: me.name }, code: r.code });
  ack({ ok: true, msg: 'Invite pathano hoyeche' });
};
H['room:start'] = (sock, d, ack) => {
  const r = rooms.get(userRoom.get(sock.uid));
  if (!r || r.host !== sock.uid || r.game) return ack({ ok: false, err: 'Shudhu host start korte pare' });
  if (r.players.length < MIN_PLAYERS) return ack({ ok: false, err: 'Kom pokkhe ' + MIN_PLAYERS + ' jon lagbe' });
  if (new Set(Object.values(teamsOf(r))).size < 2) return ack({ ok: false, err: 'Duo mode-e kom pokkhe 3 jon lagbe' });
  startGame(r);
  ack({ ok: true });
};

// ---------- match ----------
function startGame(r) {
  const teams = teamsOf(r);
  const g = { players: {}, scores: {}, ended: false, timer: null };
  const seen = {};
  r.players.forEach((uid, i) => {
    const u = db.users[uid];
    const t = teams[uid];
    const k = seen[t] = (seen[t] || 0) + (seen[t] === undefined ? 0 : 1);
    const sp = SPAWNS[r.mode === 'solo' ? i % 10 : ((t % 2) * 5 + k) % 10];
    const gun = u.guns[u.equipped] !== undefined ? u.equipped : 'mg';
    g.players[uid] = { uid, name: u.name, team: t, gun, level: u.guns[gun] || 0, hp: 100, alive: true,
      x: sp.x, y: 0, z: sp.z, ry: 0, pitch: 0, lastHit: 0, kills: 0, deaths: 0, hits: 0 };
    g.scores[t] = 0;
  });
  r.game = g;
  toRoom(r, 'game:start', {
    mode: r.mode, target: TARGET, scoreMode: SCORE_MODE,
    players: Object.values(g.players).map(p => ({ id: p.uid, name: p.name, team: p.team, gun: p.gun, level: p.level,
      dmg: dmgOf(p.gun, p.level), rate: GUNS[p.gun].rate, range: GUNS[p.gun].range, x: p.x, z: p.z })),
  });
  emitRoom(r);
  g.timer = setInterval(() => {
    toRoom(r, 'game:snap', {
      p: Object.values(g.players).map(p => ({ id: p.uid, x: r2(p.x), y: r2(p.y), z: r2(p.z), ry: r2(p.ry), pt: r2(p.pitch), hp: p.hp, a: p.alive ? 1 : 0 })),
      s: g.scores,
    });
  }, 66);
  notifyPresence(r.host);
}

function pickSpawn(g, p) {
  let best = SPAWNS[0], bd = -1;
  for (const s of SPAWNS) {
    let d = 1e9;
    for (const o of Object.values(g.players)) {
      if (o.uid === p.uid || !o.alive || o.team === p.team) continue;
      d = Math.min(d, Math.hypot(o.x - s.x, o.z - s.z));
    }
    d += Math.random() * 10;
    if (d > bd) { bd = d; best = s; }
  }
  return best;
}

function checkWin(r) {
  const g = r.game;
  for (const [team, sc] of Object.entries(g.scores)) if (sc >= TARGET) return endGame(r, +team, false);
}

function endGame(r, winTeam, aborted) {
  const g = r.game;
  if (!g || g.ended) return;
  g.ended = true;
  clearInterval(g.timer);
  const players = Object.values(g.players);
  const winners = winTeam == null ? [] : players.filter(p => p.team === winTeam);
  const reward = aborted ? 0 : WIN_COINS;
  if (!aborted) {
    for (const p of winners) { const u = db.users[p.uid]; if (u) { u.coins += WIN_COINS; u.wins = (u.wins || 0) + 1; } }
    save();
  }
  toRoom(r, 'game:end', {
    winTeam, aborted: !!aborted, reward, scores: g.scores,
    winners: winners.map(p => ({ id: p.uid, name: p.name })),
    stats: players.map(p => ({ id: p.uid, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, hits: p.hits })),
  });
  r.game = null;
  for (const p of winners) sendMe(p.uid);
  if (r.players.length) emitRoom(r);
}

H['game:state'] = (sock, d) => {
  const r = rooms.get(userRoom.get(sock.uid)), g = r && r.game;
  const p = g && g.players[sock.uid];
  if (!p || !p.alive) return;
  p.x = num(d.x, ARENA); p.y = num(d.y, 20); p.z = num(d.z, ARENA);
  p.ry = num(d.ry, 1000); p.pitch = num(d.pitch, 3);
};
H['game:shoot'] = (sock, d) => {
  const r = rooms.get(userRoom.get(sock.uid)), g = r && r.game;
  const p = g && g.players[sock.uid];
  if (!p || !p.alive || !Array.isArray(d.a) || !Array.isArray(d.b)) return;
  const pack = { id: p.uid, a: d.a.slice(0, 3).map(v => r2(num(v, 500))), b: d.b.slice(0, 3).map(v => r2(num(v, 500))) };
  for (const uid of r.players) if (uid !== sock.uid) { const s = sessions.get(uid); if (s) s.emit('game:shoot', pack); }
};
H['game:hit'] = (sock, d) => {
  const r = rooms.get(userRoom.get(sock.uid)), g = r && r.game;
  if (!g || g.ended) return;
  const s = g.players[sock.uid], t = g.players[String(d.target)];
  if (!s || !t || !s.alive || !t.alive || s.team === t.team) return;
  const gun = GUNS[s.gun], now = Date.now();
  if (now - s.lastHit < (1000 / gun.rate) * 0.7) return;          // fire-rate limit
  if (Math.hypot(s.x - t.x, s.z - t.z) > gun.range + 10) return;   // range check
  s.lastHit = now;
  const dmg = dmgOf(s.gun, s.level);
  t.hp = Math.max(0, t.hp - dmg);
  s.hits++;
  if (SCORE_MODE === 'hits') g.scores[s.team]++;
  toRoom(r, 'game:dmg', { from: s.uid, to: t.uid, hp: t.hp, dmg });
  if (t.hp <= 0) {
    t.alive = false; t.deaths++; s.kills++;
    if (SCORE_MODE === 'kills') g.scores[s.team]++;
    toRoom(r, 'game:kill', { killer: s.uid, victim: t.uid, killerName: s.name, victimName: t.name, scores: g.scores });
    setTimeout(() => {
      if (g.ended || !g.players[t.uid]) return;
      const sp = pickSpawn(g, t);
      t.hp = 100; t.alive = true; t.x = sp.x; t.y = 0; t.z = sp.z;
      toRoom(r, 'game:respawn', { id: t.uid, x: sp.x, z: sp.z });
    }, RESPAWN_MS);
  }
  checkWin(r);
};

// ---------- shop ----------
H['shop:buy'] = (sock, d, ack) => {
  const u = db.users[sock.uid], g = GUNS[d.gun];
  if (!g) return ack({ ok: false, err: 'Gun nai' });
  if (u.guns[d.gun] !== undefined) return ack({ ok: false, err: 'Age theke ache' });
  if (u.coins < g.price) return ack({ ok: false, err: 'Coin kom (' + g.price + ' lagbe)' });
  u.coins -= g.price; u.guns[d.gun] = 0; save(); sendMe(u.id);
  ack({ ok: true, msg: g.name + ' kena hoyeche' });
};
H['shop:upgrade'] = (sock, d, ack) => {
  const u = db.users[sock.uid], g = GUNS[d.gun];
  if (!g || u.guns[d.gun] === undefined) return ack({ ok: false, err: 'Gun apnar nai' });
  const lv = u.guns[d.gun];
  if (lv >= MAX_LV) return ack({ ok: false, err: 'Max level' });
  const c = upgCost(d.gun, lv);
  if (u.coins < c) return ack({ ok: false, err: 'Coin kom (' + c + ' lagbe)' });
  u.coins -= c; u.guns[d.gun] = lv + 1; save(); sendMe(u.id);
  ack({ ok: true, msg: g.name + ' Lv' + (lv + 1) + ' hoyeche' });
};
H['shop:equip'] = (sock, d, ack) => {
  const u = db.users[sock.uid];
  if (!GUNS[d.gun] || u.guns[d.gun] === undefined) return ack({ ok: false, err: 'Gun apnar nai' });
  u.equipped = d.gun; save(); sendMe(u.id); ack({ ok: true });
};
H['shop:topup'] = (sock, d, ack) => {
  const u = db.users[sock.uid], p = PACKS[d.pack];
  if (!p) return ack({ ok: false, err: 'Pack nai' });
  if (!TOPUP_TEST) return ack({ ok: false, err: 'Payment gateway (bKash/Nagad) ekhono connect kora nai' });
  u.coins += p.coins; save(); sendMe(u.id);
  ack({ ok: true, msg: '[TEST MODE] +' + p.coins + ' coin' });
};

// ---------- disconnect ----------
function onDisconnect(sock) {
  const uid = sock.uid;
  if (!uid || sessions.get(uid) !== sock) return;
  sessions.delete(uid);
  leaveRoom(uid);
  notifyPresence(uid);
}

if (require.main === module) {
  server.listen(PORT, () => console.log('Roni Arena running on http://localhost:' + PORT +
    ' | target=' + TARGET + ' mode=' + SCORE_MODE + ' topupTest=' + TOPUP_TEST));
}
module.exports = { server };
