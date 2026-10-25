import * as THREE from 'three';

/* =====================================================================
 * Roni Arena - client (UI + networking + 3D game)
 * ===================================================================== */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');

const TEAM_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#94a3b8'];
const TEAM_NAMES = ['Blue', 'Red', 'Green', 'Amber', 'Purple', 'Cyan', 'Pink', 'Lime', 'Orange', 'Grey'];
const MODE_MAX = { solo: 10, duo: 10, squad: 8 };
const ARENA = 58;

let me = null, cfg = null, room = null, friends = { list: [], requests: [] }, screen = 'auth';
let authMode = 'login';

/* ---------------------------------------------------------------- net */
const net = { ws: null, open: false, handlers: {}, acks: {}, seq: 1 };
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = net.ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => {
    net.open = true;
    const t = localStorage.getItem('ra_token');
    if (t) emit('auth:token', { token: t }, r => { if (!r.ok) { localStorage.removeItem('ra_token'); show('auth'); } });
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.a != null) { const cb = net.acks[m.a]; delete net.acks[m.a]; if (cb) cb(m.d); }
    else if (m.e && net.handlers[m.e]) net.handlers[m.e](m.d);
  };
  ws.onclose = () => {
    net.open = false;
    if (G) { cleanupGame(); }
    toast('Connection nai, abar connect hocche...');
    setTimeout(connect, 1500);
  };
}
function emit(e, d, cb) {
  if (!net.open) { if (cb) cb({ ok: false, err: 'Server-er sathe connection nai' }); return; }
  const m = { e, d };
  if (cb) { m.i = net.seq++; net.acks[m.i] = cb; }
  net.ws.send(JSON.stringify(m));
}
const on = (e, fn) => { net.handlers[e] = fn; };

/* ---------------------------------------------------------------- ui helpers */
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2800);
}
function show(name) {
  for (const id of ['auth', 'home', 'lobby']) $(id).classList.toggle('on', id === name);
  $('game').classList.toggle('on', name === 'game');
  screen = name;
}
function fillMax(sel, mode, val) {
  const max = MODE_MAX[mode]; let h = '';
  for (let i = 2; i <= max; i++) h += `<option value="${i}">${i} jon</option>`;
  sel.innerHTML = h;
  sel.value = String(Math.min(Math.max(2, val || max), max));
}
const act = (e, d, okMsg) => emit(e, d, r => toast(r.ok ? (r.msg || okMsg || 'Done') : (r.err || 'Error')));

/* ---------------------------------------------------------------- auth screen */
function setAuthMode(m) {
  authMode = m;
  $('tabLogin').classList.toggle('on', m === 'login');
  $('tabReg').classList.toggle('on', m === 'reg');
  $('aName').style.display = m === 'reg' ? 'block' : 'none';
  $('aGo').textContent = m === 'reg' ? 'Account banan' : 'Login';
  $('aPw').autocomplete = m === 'reg' ? 'new-password' : 'current-password';
  $('aErr').textContent = '';
}
$('tabLogin').onclick = () => setAuthMode('login');
$('tabReg').onclick = () => setAuthMode('reg');
$('aGo').onclick = () => {
  $('aErr').textContent = '';
  emit(authMode === 'reg' ? 'auth:register' : 'auth:login',
    { id: $('aId').value, name: $('aName').value, password: $('aPw').value },
    r => { if (r.ok) { localStorage.setItem('ra_token', r.token); $('aPw').value = ''; } else $('aErr').textContent = r.err; });
};
[$('aId'), $('aName'), $('aPw')].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') $('aGo').click(); }));

let fbReady = false;
fetch('/api/config').then(r => r.json()).then(c => {
  if (!c.fbAppId) return;
  window.fbAsyncInit = () => { FB.init({ appId: c.fbAppId, version: 'v19.0', xfbml: false }); fbReady = true; };
  const s = document.createElement('script'); s.src = 'https://connect.facebook.net/en_US/sdk.js'; s.async = true;
  document.body.appendChild(s);
}).catch(() => {});
$('aFb').onclick = () => {
  if (!fbReady) { $('aErr').textContent = 'Facebook login ekhono set up kora nai (server-e FB_APP_ID + FB_APP_SECRET dite hobe). Email/mobile diye login korun.'; return; }
  FB.login(resp => {
    if (!resp.authResponse) return;
    emit('auth:facebook', { token: resp.authResponse.accessToken }, r => { if (r.ok) localStorage.setItem('ra_token', r.token); else $('aErr').textContent = r.err; });
  }, { scope: 'public_profile' });
};

/* add-link: /?add=ID */
const addParam = new URLSearchParams(location.search).get('add');
if (addParam) { localStorage.setItem('ra_pendingAdd', addParam); history.replaceState(null, '', location.pathname); }

/* ---------------------------------------------------------------- server events */
on('init', d => {
  cfg = d; me = d.me;
  fillMax($('mMax'), $('mMode').value);
  renderMe(); renderShop();
  if (screen === 'auth' || screen === 'game' || !room) show('home');
  const pend = localStorage.getItem('ra_pendingAdd');
  if (pend) {
    localStorage.removeItem('ra_pendingAdd');
    if (pend !== me.id) act('friends:request', { id: pend });
  }
});
on('kicked', d => { toast(d.msg); localStorage.removeItem('ra_token'); show('auth'); });
on('me', d => { me = d; renderMe(); renderShop(); });
on('toast', d => toast(d.msg));
on('friends', d => { friends = d; renderFriends(); renderLobby(); });
on('room:update', d => {
  room = d;
  if (screen === 'game' || (G && !G.ended)) { renderLobby(); return; }
  if (screen !== 'lobby') show('lobby');
  renderLobby();
});
on('room:left', () => {
  room = null;
  if (G) cleanupGame();
  show('home');
});
let invTimer;
on('invite', d => {
  $('invTxt').textContent = d.from.name + ' apnake room-e invite korse (' + d.code + ')';
  $('invite').style.display = 'block';
  $('invYes').onclick = () => { $('invite').style.display = 'none'; emit('room:join', { code: d.code }, r => { if (!r.ok) toast(r.err); }); };
  clearTimeout(invTimer); invTimer = setTimeout(() => { $('invite').style.display = 'none'; }, 20000);
});
$('invNo').onclick = () => { $('invite').style.display = 'none'; };

/* ---------------------------------------------------------------- home */
function renderMe() {
  if (!me) return;
  $('hName').textContent = me.name + '  •  ' + me.wins + ' win';
  $('hId').textContent = '#' + me.id;
  for (const id of ['hCoin', 'lCoin', 'sCoin']) $(id).textContent = me.coins + ' coin';
}
$('mMode').onchange = () => fillMax($('mMax'), $('mMode').value);
$('mCreate').onclick = () => emit('room:create', { mode: $('mMode').value, max: +$('mMax').value }, r => { if (!r.ok) toast(r.err); });
$('mJoin').onclick = () => emit('room:join', { code: $('mCode').value }, r => { if (!r.ok) toast(r.err); });
$('fAdd').onclick = () => { act('friends:request', { id: $('fId').value }); $('fId').value = ''; };
$('copyLink').onclick = () => {
  const link = location.origin + '/?add=' + me.id;
  if (navigator.share) { navigator.share({ title: 'Roni Arena', text: 'Amar sathe Roni Arena khelo!', url: link }).catch(() => {}); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('Link copy hoyeche'), () => prompt('Link:', link));
  else prompt('Link:', link);
};
$('logout').onclick = () => { localStorage.removeItem('ra_token'); if (room) emit('room:leave', {}); location.reload(); };

function renderFriends() {
  $('reqs').innerHTML = friends.requests.map(r =>
    `<div><span class="nm">${esc(r.name)} <span class="pill">#${r.id} request</span></span>
     <button class="btn ok sm" data-acc="${r.id}">Accept</button><button class="btn alt sm" data-dec="${r.id}">No</button></div>`).join('');
  $('fList').innerHTML = friends.list.length ? friends.list.map(f =>
    `<div><span class="dot ${f.online ? 'on' : ''}"></span><span class="nm">${esc(f.name)} <span class="pill">#${f.id}${f.inRoom ? ' • room-e' : ''}</span></span>
     ${room && f.online ? `<button class="btn sm" data-inv="${f.id}">Invite</button>` : ''}
     <button class="btn alt sm" data-rm="${f.id}">✕</button></div>`).join('')
    : '<div class="pill">Ekhono kono friend nai. Upore ID diye add korun.</div>';
}
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.acc) act('friends:accept', { id: d.acc });
  else if (d.dec) act('friends:decline', { id: d.dec });
  else if (d.rm) { if (confirm('Friend list theke soriye dibo?')) act('friends:remove', { id: d.rm }); }
  else if (d.inv) act('room:invite', { id: d.inv });
});

/* ---------------------------------------------------------------- lobby */
function renderLobby() {
  if (!room || !me) return;
  const host = room.host === me.id;
  $('lCode').textContent = room.code;
  const mname = { solo: 'Solo', duo: 'Duo (2 jon team)', squad: 'Squad 4 vs 4' }[room.mode];
  $('lInfo').textContent = mname + ' • ' + room.players.length + '/' + room.max + ' jon • ' + (cfg ? cfg.target : 20) + ' ' + (cfg && cfg.scoreMode === 'hits' ? 'hit' : 'kill') + ' hole jit';
  $('lCfg').style.display = host && room.state === 'lobby' ? 'flex' : 'none';
  if ($('lMode').value !== room.mode) $('lMode').value = room.mode;
  fillMax($('lMax'), room.mode, room.max);
  $('lPlayers').innerHTML = room.players.map(p => {
    const tl = room.mode === 'solo' ? '' : `<span class="tag" style="background:${TEAM_COLORS[p.team % 10]}">${TEAM_NAMES[p.team % 10]}</span>`;
    return `<div><span class="nm">${esc(p.name)} ${p.id === room.host ? '👑' : ''}</span>${tl}</div>`;
  }).join('');
  $('lFriends').innerHTML = friends.list.filter(f => f.online && !room.players.some(p => p.id === f.id)).map(f =>
    `<div><span class="dot on"></span><span class="nm">${esc(f.name)}</span><button class="btn sm" data-inv="${f.id}">Invite</button></div>`).join('')
    || '<div class="pill">Online friend nai</div>';
  $('lStart').style.display = host ? 'block' : 'none';
}
$('lMode').onchange = () => emit('room:config', { mode: $('lMode').value, max: +$('lMax').value }, r => { if (!r.ok) { toast(r.err); renderLobby(); } });
$('lMax').onchange = () => emit('room:config', { mode: $('lMode').value, max: +$('lMax').value }, r => { if (!r.ok) { toast(r.err); renderLobby(); } });
$('lStart').onclick = () => emit('room:start', {}, r => { $('lErr').textContent = r.ok ? '' : r.err; });
$('lLeave').onclick = () => emit('room:leave', {});

/* ---------------------------------------------------------------- shop */
function renderShop() {
  if (!cfg || !me) return;
  $('sGuns').innerHTML = Object.entries(cfg.guns).map(([k, g]) => {
    const owned = me.guns[k] !== undefined, lv = me.guns[k] || 0;
    const dmg = Math.round(g.dmg * (1 + 0.1 * lv));
    let btns = '';
    if (!owned) btns = `<button class="btn sm" data-buy="${k}">Kino ${g.price}</button>`;
    else {
      if (lv < cfg.maxLv) btns += `<button class="btn alt sm" data-upg="${k}">Upgrade ${g.upg * (lv + 1)}</button> `;
      btns += me.equipped === k ? '<span class="pill">Equipped</span>' : `<button class="btn ok sm" data-eq="${k}">Equip</button>`;
    }
    return `<div class="shopgun"><div class="info"><b>${esc(g.name)} ${owned ? '• Lv' + lv : ''}</b><span class="pill">Damage ${dmg} • Speed ${g.rate}/s • Range ${g.range}</span></div><div>${btns}</div></div>`;
  }).join('');
  $('sTopNote').textContent = cfg.topupTest
    ? 'TEST MODE: ekhon payment lage na, coin free pabe. Real bKash/Nagad payment pore connect hobe.'
    : 'Payment gateway ekhono connect kora nai.';
  $('sPacks').innerHTML = Object.entries(cfg.packs).map(([k, p]) =>
    `<div class="shopgun"><div class="info"><b>${p.coins} coin</b><span class="pill">৳${p.taka}</span></div><button class="btn sm" data-top="${k}">Topup</button></div>`).join('');
}
$('shop').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.buy) act('shop:buy', { gun: d.buy });
  else if (d.upg) act('shop:upgrade', { gun: d.upg });
  else if (d.eq) act('shop:equip', { gun: d.eq }, 'Equipped');
  else if (d.top) act('shop:topup', { pack: d.top });
});
$('shopBtn').onclick = () => { renderShop(); $('shop').classList.add('on'); };
$('sClose').onclick = () => $('shop').classList.remove('on');

/* =====================================================================
 * 3D GAME
 * ===================================================================== */
let G = null;            // current match
let T = null;            // three.js world (lazy)
const P = { x: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true, team: 0, dmg: 12, rate: 8, range: 120, lastFire: 0, team_: 0 };
const keys = {};
const joy = { x: 0, y: 0, id: null };
let firing = false, locked = false, kick = 0;

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function init3D() {
  if (T) return;
  const canvas = $('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8ec5ff);
  scene.fog = new THREE.Fog(0x8ec5ff, 50, 170);
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 400);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(30, 60, 20); scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2 * ARENA + 20, 2 * ARENA + 20), new THREE.MeshLambertMaterial({ color: 0x4f8a50 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.GridHelper(2 * ARENA, 29, 0x2d5a2f, 0x3d6f3f); grid.position.y = 0.02; scene.add(grid);

  const obstacles = [], solid = [];
  const R = rng(1337);
  const cols = [0x8a8f9c, 0x9a7b55, 0x6f7a8a, 0xa08a6a];
  for (let i = 0; i < 26; i++) {
    const a = R() * Math.PI * 2, rad = 8 + R() * 26, w = 2 + R() * 4, d = 2 + R() * 4, h = 1.8 + R() * 3.2;
    const x = Math.sin(a) * rad, z = Math.cos(a) * rad;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: cols[i % cols.length] }));
    m.position.set(x, h / 2, z); scene.add(m);
    obstacles.push({ x, z, w, d }); solid.push(m);
  }
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
  for (const [x, z, w, d] of [[0, ARENA + 1, 2 * ARENA + 4, 2], [0, -ARENA - 1, 2 * ARENA + 4, 2], [ARENA + 1, 0, 2, 2 * ARENA], [-ARENA - 1, 0, 2, 2 * ARENA]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 6, d), wallMat); m.position.set(x, 3, z); scene.add(m); solid.push(m);
  }

  // first-person gun
  const gun = new THREE.Group();
  const gm = new THREE.MeshLambertMaterial({ color: 0x222831 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.55), gm); gun.add(body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), new THREE.MeshLambertMaterial({ color: 0x111418 })); barrel.position.set(0, 0.02, -0.4); gun.add(barrel);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.08), gm); grip.position.set(0, -0.13, 0.12); gun.add(grip);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.02, -0.58); gun.add(muzzle);
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd34d })); flash.position.copy(muzzle.position); flash.visible = false; gun.add(flash);
  gun.position.set(0.22, -0.2, -0.5);
  camera.add(gun);

  T = { renderer, scene, camera, obstacles, solid, gun, muzzle, flash, tracers: [], raycaster: new THREE.Raycaster() };
  resize();
}
function resize() {
  if (!T) return;
  T.renderer.setSize(innerWidth, innerHeight, false);
  T.camera.aspect = innerWidth / innerHeight; T.camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function makeLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = '#000'; g.strokeText(text, 128, 32);
  g.fillStyle = color; g.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(2.4, 0.6, 1); s.position.y = 2.35; s.renderOrder = 10;
  return s;
}
function makeAvatar(p, friendly) {
  const g = new THREE.Group();
  const col = new THREE.Color(TEAM_COLORS[p.team % 10]);
  const hit = [];
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.userData.pid = p.id; g.add(m); hit.push(m); return m; };
  add(new THREE.BoxGeometry(0.8, 0.9, 0.45), new THREE.MeshLambertMaterial({ color: col }), 0, 1.15, 0);
  add(new THREE.BoxGeometry(0.6, 0.75, 0.4), new THREE.MeshLambertMaterial({ color: col.clone().multiplyScalar(0.55) }), 0, 0.38, 0);
  add(new THREE.SphereGeometry(0.26, 10, 8), new THREE.MeshLambertMaterial({ color: 0xf1c9a0 }), 0, 1.8, 0);
  const gunm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.7), new THREE.MeshLambertMaterial({ color: 0x1b1f27 })); gunm.position.set(0.4, 1.2, -0.4); g.add(gunm);
  g.add(makeLabel(p.name, friendly ? '#7dff9a' : '#ff8a8a'));
  T.scene.add(g);
  return { group: g, hit, team: p.team, name: p.name, alive: true, tx: p.x, tz: p.z, ty: 0, try: 0 };
}

/* ---- start / end ---- */
on('game:start', d => {
  init3D();
  if (G) cleanupGame();
  const mine = d.players.find(p => p.id === me.id);
  if (!mine) return;
  G = { mode: d.mode, target: d.target, scoreMode: d.scoreMode, players: {}, remotes: {}, scores: {}, ended: false, lastSend: 0, feed: [] };
  for (const p of d.players) {
    G.players[p.id] = p;
    G.scores[p.team] = 0;
    if (p.id !== me.id) { const r = makeAvatar(p, p.team === mine.team); r.group.position.set(p.x, 0, p.z); G.remotes[p.id] = r; }
  }
  Object.assign(P, { x: mine.x, z: mine.z, yaw: Math.atan2(-mine.x, -mine.z), pitch: 0, hp: 100, alive: true, team: mine.team,
    dmg: mine.dmg, rate: mine.rate, range: mine.range, lastFire: 0 });
  firing = false; kick = 0; hideCenter(); setMsg('');
  $('feed').innerHTML = '';
  show('game'); resize(); updHud();
  if (!isTouch) showCenter(`<h2>Match shuru!</h2><p>${d.target} ${d.scoreMode === 'hits' ? 'hit' : 'kill'} age korle jit.</p><p class="pill">WASD = cholo • Mouse = ghurao • Click = gooli • Esc = pause</p><button class="btn full" id="goBtn">Click to play</button>`);
  if (!isTouch) $('goBtn').onclick = () => { hideCenter(); lockPointer(); };
});

function cleanupGame() {
  if (T && G) for (const r of Object.values(G.remotes)) T.scene.remove(r.group);
  G = null; firing = false;
  if (document.pointerLockElement) document.exitPointerLock();
  hideCenter(); setMsg('');
}

function showCenter(html) { $('centerBox').innerHTML = html; $('center').classList.add('on'); }
function hideCenter() { $('center').classList.remove('on'); }
let msgEl = null;
function setMsg(t) {
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.style.cssText = 'position:absolute;left:0;right:0;top:22%;text-align:center;font-size:24px;font-weight:800;text-shadow:0 2px 6px #000;pointer-events:none';
    $('hud').appendChild(msgEl);
  }
  msgEl.textContent = t;
}
function teamLabel(t) {
  if (!G) return '';
  if (G.mode === 'solo') { const p = Object.values(G.players).find(x => x.team === t); return p ? p.name : '?'; }
  return TEAM_NAMES[t % 10];
}
function updHud() {
  if (!G) return;
  const arr = Object.entries(G.scores).map(([t, s]) => [+t, s]).sort((a, b) => b[1] - a[1]);
  let top = arr.slice(0, 4);
  if (!top.some(x => x[0] === P.team)) top.push([P.team, G.scores[P.team] || 0]);
  $('score').innerHTML = `<span style="background:#000a">🎯 ${G.target}</span>` + top.map(([t, s]) =>
    `<span class="${t === P.team ? 'me' : ''}" style="background:${TEAM_COLORS[t % 10]}cc">${esc(teamLabel(t))} ${s}</span>`).join('');
  $('hpBar').style.width = Math.max(0, P.hp) + '%';
  $('hpBar').style.background = P.hp > 50 ? '#3ddc84' : P.hp > 25 ? '#ffb020' : '#ff5d6c';
  $('hpTxt').textContent = 'HP ' + Math.max(0, Math.round(P.hp));
}
function feed(html) {
  const d = document.createElement('div'); d.innerHTML = html; $('feed').appendChild(d);
  setTimeout(() => d.remove(), 4500);
  while ($('feed').children.length > 5) $('feed').firstChild.remove();
}

/* ---- network events during match ---- */
on('game:snap', d => {
  if (!G) return;
  for (const p of d.p) {
    if (p.id === me.id) { P.hp = p.hp; continue; }
    const r = G.remotes[p.id]; if (!r) continue;
    r.tx = p.x; r.tz = p.z; r.ty = p.y; r.try = p.ry; r.alive = !!p.a; r.group.visible = r.alive;
  }
  G.scores = d.s; updHud();
});
on('game:dmg', d => {
  if (!G) return;
  if (d.to === me.id) { P.hp = d.hp; kick += 0.02; updHud(); flashScreen(); }
  if (d.from === me.id) { const h = $('hitm'); h.style.opacity = 1; setTimeout(() => { h.style.opacity = 0; }, 120); }
});
on('game:kill', d => {
  if (!G) return;
  G.scores = d.scores;
  const kn = d.killer === me.id ? 'Apni' : esc(d.killerName), vn = d.victim === me.id ? 'apnake' : esc(d.victimName);
  feed(`<b>${kn}</b> ➜ ${vn}`);
  if (d.victim === me.id) { P.alive = false; P.hp = 0; firing = false; setMsg('Apni mara gechen... respawn hocche'); }
  else if (G.remotes[d.victim]) { G.remotes[d.victim].alive = false; G.remotes[d.victim].group.visible = false; }
  updHud();
});
on('game:respawn', d => {
  if (!G) return;
  if (d.id === me.id) { P.x = d.x; P.z = d.z; P.hp = 100; P.alive = true; P.yaw = Math.atan2(-d.x, -d.z); setMsg(''); updHud(); }
  else { const r = G.remotes[d.id]; if (r) { r.group.position.set(d.x, 0, d.z); r.tx = d.x; r.tz = d.z; r.alive = true; r.group.visible = true; } }
});
on('game:shoot', d => { if (G && T) addTracer(new THREE.Vector3(...d.a), new THREE.Vector3(...d.b), 0xffe08a); });
on('game:end', d => {
  if (!G) return;
  G.ended = true; firing = false; setMsg('');
  if (document.pointerLockElement) document.exitPointerLock();
  const won = !d.aborted && d.winners.some(w => w.id === me.id);
  const rows = d.stats.sort((a, b) => b.kills - a.kills).map(s =>
    `<tr><td>${esc(s.name)}</td><td>${s.kills}</td><td>${s.deaths}</td></tr>`).join('');
  let title, sub;
  if (d.aborted) { title = 'Match shesh'; sub = 'Onnora chole geche, ei match-e coin nai.'; }
  else if (won) { title = '🏆 Apni jitechen!'; sub = '+' + d.reward + ' coin pelen'; }
  else { title = 'Haren giyechen'; sub = d.winners.length ? 'Winner: ' + d.winners.map(w => esc(w.name)).join(', ') : ''; }
  showCenter(`<h2 style="font-size:24px">${title}</h2><p>${sub}</p><table><tr><th>Player</th><th>Kill</th><th>Death</th></tr>${rows}</table><button class="btn full" id="backLobby">Lobby-te phiro</button>`);
  $('backLobby').onclick = () => { cleanupGame(); show(room ? 'lobby' : 'home'); renderLobby(); };
});
$('gLeave').onclick = () => { if (confirm('Match chhere debe?')) emit('room:leave', {}); };

/* ---- flash / tracers ---- */
function flashScreen() {
  let f = $('hud').querySelector('.dmgflash');
  if (!f) { f = document.createElement('div'); f.className = 'dmgflash'; f.style.cssText = 'position:absolute;inset:0;background:radial-gradient(transparent 40%,#ff0000aa);opacity:0;transition:opacity .25s;pointer-events:none'; $('hud').prepend(f); }
  f.style.opacity = 1; setTimeout(() => { f.style.opacity = 0; }, 120);
}
function addTracer(a, b, color) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  T.scene.add(line); T.tracers.push({ line, until: performance.now() + 70 });
}

/* ---- input ---- */
function lockPointer() { if (!isTouch && G && !G.ended) $('gl').requestPointerLock(); }
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === $('gl');
  if (!locked && G && !G.ended && !isTouch) {
    firing = false;
    showCenter('<h2>Pause</h2><button class="btn full" id="resumeBtn">Resume</button><button class="btn full alt" id="pauseLeave">Match chharo</button>');
    $('resumeBtn').onclick = () => { hideCenter(); lockPointer(); };
    $('pauseLeave').onclick = () => emit('room:leave', {});
  }
});
document.addEventListener('mousemove', e => {
  if (!locked || !G) return;
  P.yaw -= e.movementX * 0.0024;
  P.pitch = Math.max(-1.45, Math.min(1.45, P.pitch - e.movementY * 0.0024));
});
$('gl').addEventListener('mousedown', e => { if (locked && e.button === 0) firing = true; });
document.addEventListener('mouseup', e => { if (e.button === 0) firing = false; });
addEventListener('keydown', e => { keys[e.code] = true; });
addEventListener('keyup', e => { keys[e.code] = false; });

if (isTouch) {
  const opt = { passive: false };
  const joyEl = $('joy'), knob = joyEl.querySelector('i');
  const setJoy = t => {
    const r = joyEl.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = (t.clientX - cx) / 50, dy = (t.clientY - cy) / 50;
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    joy.x = dx; joy.y = dy; knob.style.transform = `translate(${dx * 40}px,${dy * 40}px)`;
  };
  joyEl.addEventListener('touchstart', e => { e.preventDefault(); joy.id = e.changedTouches[0].identifier; setJoy(e.changedTouches[0]); }, opt);
  joyEl.addEventListener('touchmove', e => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === joy.id) setJoy(t); }, opt);
  const endJoy = e => { for (const t of e.changedTouches) if (t.identifier === joy.id) { joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; } };
  joyEl.addEventListener('touchend', endJoy, opt); joyEl.addEventListener('touchcancel', endJoy, opt);

  let lookId = null, lx = 0, ly = 0;
  const lookEl = $('look');
  lookEl.addEventListener('touchstart', e => { e.preventDefault(); const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; }, opt);
  lookEl.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === lookId) {
      P.yaw -= (t.clientX - lx) * 0.006;
      P.pitch = Math.max(-1.45, Math.min(1.45, P.pitch - (t.clientY - ly) * 0.005));
      lx = t.clientX; ly = t.clientY;
    }
  }, opt);
  const endLook = e => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; };
  lookEl.addEventListener('touchend', endLook, opt); lookEl.addEventListener('touchcancel', endLook, opt);

  const fireEl = $('fire');
  fireEl.addEventListener('touchstart', e => { e.preventDefault(); firing = true; }, opt);
  fireEl.addEventListener('touchend', e => { e.preventDefault(); firing = false; }, opt);
  fireEl.addEventListener('touchcancel', () => { firing = false; }, opt);
}

/* ---- simulation ---- */
function collide(x, z) {
  const r = 0.5;
  for (const o of T.obstacles) {
    const hx = o.w / 2 + r, hz = o.d / 2 + r, dx = x - o.x, dz = z - o.z;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
      if (px < pz) x += (dx < 0 ? -1 : 1) * px; else z += (dz < 0 ? -1 : 1) * pz;
    }
  }
  const lim = ARENA - 1;
  return [Math.max(-lim, Math.min(lim, x)), Math.max(-lim, Math.min(lim, z))];
}

const _v = new THREE.Vector3(), _o = new THREE.Vector3(), _e = new THREE.Vector3(), _c = new THREE.Vector2(0, 0);
function tryFire(now) {
  if (!P.alive || !firing || now - P.lastFire < 1000 / P.rate) return;
  P.lastFire = now;
  const { camera, raycaster, muzzle, solid } = T;
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera(_c, camera);
  raycaster.far = P.range;
  const targets = solid.slice();
  for (const r of Object.values(G.remotes)) if (r.alive) targets.push(...r.hit);
  const hits = raycaster.intersectObjects(targets, false);
  muzzle.getWorldPosition(_o);
  if (hits.length) {
    _e.copy(hits[0].point);
    const pid = hits[0].object.userData.pid;
    if (pid && G.remotes[pid] && G.remotes[pid].team !== P.team) emit('game:hit', { target: pid });
  } else {
    _e.copy(raycaster.ray.direction).multiplyScalar(P.range).add(raycaster.ray.origin);
  }
  addTracer(_o.clone(), _e.clone(), 0xfff2a8);
  emit('game:shoot', { a: [_o.x, _o.y, _o.z], b: [_e.x, _e.y, _e.z] });
  kick = Math.min(0.12, kick + 0.05);
  P.pitch = Math.min(1.45, P.pitch + 0.004);
  T.flash.visible = true; setTimeout(() => { if (T) T.flash.visible = false; }, 45);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!G || !T || screen !== 'game') return;

  if (P.alive && !G.ended) {
    let ix = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + joy.x;
    let iz = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0) + joy.y;
    const l = Math.hypot(ix, iz);
    if (l > 1) { ix /= l; iz /= l; }
    const sp = (keys.ShiftLeft ? 10 : 7) * dt;
    const s = Math.sin(P.yaw), c = Math.cos(P.yaw);
    // forward = (-s,-c) ; right = (c,-s) ; iz>0 means backward
    const nx = P.x + (ix * c + iz * s) * sp, nz = P.z + (-ix * s + iz * c) * sp;
    [P.x, P.z] = collide(nx, nz);
    tryFire(now);
    if (now - G.lastSend > 66) { G.lastSend = now; emit('game:state', { x: P.x, y: 0, z: P.z, ry: P.yaw, pitch: P.pitch }); }
  }
  kick *= Math.pow(0.001, dt);
  T.gun.position.z = -0.5 + kick;

  T.camera.position.set(P.x, 1.6, P.z);
  T.camera.rotation.set(P.pitch, P.yaw, 0);

  const k = Math.min(1, dt * 12);
  for (const r of Object.values(G.remotes)) {
    const g = r.group;
    g.position.x += (r.tx - g.position.x) * k;
    g.position.z += (r.tz - g.position.z) * k;
    let dy = r.try - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    g.rotation.y += dy * k;
  }
  for (let i = T.tracers.length - 1; i >= 0; i--) {
    if (now > T.tracers[i].until) { const t = T.tracers[i]; T.scene.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); T.tracers.splice(i, 1); }
  }
  T.renderer.render(T.scene, T.camera);
}
requestAnimationFrame(frame);

/* ---------------------------------------------------------------- start */
setAuthMode('login');
connect();
