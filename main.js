'use strict';
/* =====================================================================
   Gemstone Market – main.js
   Modules: Config · Gems · Api (+ optional Mock server) · Toast · Auth
            Profile · Portfolio · Inventory · Shop · Preview3D · boot
   ===================================================================== */

/* ---------- Config ---------- */
const CONFIG = {
  // >>> PUT YOUR REAL BACKEND URL HERE (no trailing slash) <<<
  API_BASE: 'https://YOUR-BACKEND.example.com/api',
  // true = built-in in-memory fake server so the game runs without a backend.
  // Data is lost on reload. Set to false once API_BASE points to a real server.
  USE_MOCK: true,
  TOKEN_KEY: 'gm_token',            // the ONLY thing stored in localStorage
  CHEST_PRICE: 3000,
  POTION_PRICE: 10000,
  START_CASH: 5000,
  // Endpoints – change paths here only.
  EP: {
    register: '/auth/register', login: '/auth/login',
    profile: '/player/profile', claim: '/player/claim-free-chest',
    open: '/player/open-chest', sell: '/player/sell-gem',
  },
};

/* ---------- Gem data & rolling (client rolls, server records/validates) ---------- */
const TIERS = [
  { id: 'common', name: 'Common', chance: 40, base: 100, color: '#9aa4b2', gems: ['Quartz','Amethyst','Citrine','Rose Quartz','Smoky Quartz','Agate','Jasper','Carnelian','Onyx','Obsidian','Hematite','Malachite','Turquoise','Lapis Lazuli',"Tiger's Eye",'Bloodstone','Aventurine','Moonstone','Sunstone','Labradorite','Fluorite','Garnet','Peridot','Howlite','Sodalite','Chalcedony','Amazonite','Apatite','Calcite','Pyrite','Rhodonite','Serpentine','Selenite','Sard','Chrysoprase',"Hawk's Eye",'Unakite','Amber','Jet','Opalite'] },
  { id: 'rare', name: 'Rare', chance: 30, base: 400, color: '#4aa3ff', gems: ['Aquamarine','Topaz','Tourmaline','Iolite','Kunzite','Morganite','Zircon','Spinel','Tanzanite','Chrome Diopside','Sphene','Hiddenite','Rhodolite','Tsavorite','Demantoid','Pearl','Opal','Larimar','Charoite','Sugilite','Heliodor','Danburite','Kyanite','Andalusite','Scapolite','Prehnite','Chrysocolla','Rainbow Moonstone','Spessartine','Axinite'] },
  { id: 'epic', name: 'Epic', chance: 19, base: 1500, color: '#b174ff', gems: ['Emerald','Ruby','Sapphire','Alexandrite','Paraiba Tourmaline','Black Opal','Fire Opal','Padparadscha','Star Sapphire','Star Ruby',"Cat's Eye Chrysoberyl",'Imperial Topaz','Benitoite','Jadeite','Golden Beryl'] },
  { id: 'mythic', name: 'Mythic', chance: 10, base: 6000, color: '#ff6a8a', gems: ['Diamond','Pigeon Blood Ruby','Kashmir Sapphire','Colombian Emerald','Red Beryl','Musgravite','Grandidierite','Taaffeite','Jeremejevite','Poudretteite'] },
  { id: 'legendary', name: 'Legendary', chance: 1, base: 30000, color: '#ffc247', gems: ['Red Diamond','Blue Diamond','Pink Diamond','Painite','Serendibite'] },
];
const TIER = Object.fromEntries(TIERS.map((t, i) => [t.id, { ...t, rank: i }]));
const STATUS = ['Rough','Chipped','Worn','Fair','Good','Polished','Fine','Brilliant','Flawless','Perfect']; // by tens

const Gems = {
  uid: () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)),
  rollTier() {
    let r = Math.random() * 100;
    for (const t of TIERS) { if ((r -= t.chance) < 0) return t; }
    return TIERS[0];
  },
  /** Rarity roll → gem pick → float 0–1 → status 1–100. Luck = best of 3 rarity rolls. */
  roll(luck) {
    let tier = Gems.rollTier();
    if (luck) for (let i = 0; i < 2; i++) { const t = Gems.rollTier(); if (TIER[t.id].rank > TIER[tier.id].rank) tier = t; }
    const name = tier.gems[Math.floor(Math.random() * tier.gems.length)];
    const float = +Math.random().toFixed(4);
    const status = 1 + Math.floor(Math.random() * 100);
    return { id: Gems.uid(), name, tier: tier.id, float, status,
             statusName: STATUS[Math.floor((status - 1) / 10)],
             worth: Gems.worth(tier.base, float, status), acquiredAt: new Date().toISOString() };
  },
  // Final worth = baseRarityValue × (float + 1) × (1 + statusNumber / 100)
  worth: (base, float, status) => Math.round(base * (float + 1) * (1 + status / 100)),
  hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; },
  /** Colour grading: higher float = richer, brighter colour. */
  color(g) { return `hsl(${Gems.hue(g.name)} ${Math.round(35 + g.float * 55)}% ${Math.round(34 + g.float * 26)}%)`; },
};

/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = n => '$' + Math.round(n).toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const Toast = {
  show(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + type; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  },
  ok: m => Toast.show(m, 'ok'), err: m => Toast.show(m, 'error'),
};

/** Disable a button and show a spinner while an async action runs. */
async function busy(btn, fn) {
  if (btn.classList.contains('loading')) return;
  btn.classList.add('loading'); btn.disabled = true;
  try { return await fn(); }
  catch (e) { if (e.status !== 401) Toast.err(e.message || 'Something went wrong.'); }
  finally { btn.classList.remove('loading'); btn.disabled = false; Shop.refresh(); }
}

/* ---------- API layer: every persistence call goes through here ---------- */
const Api = {
  token: localStorage.getItem(CONFIG.TOKEN_KEY),
  setToken(t) { Api.token = t; t ? localStorage.setItem(CONFIG.TOKEN_KEY, t) : localStorage.removeItem(CONFIG.TOKEN_KEY); },

  async request(path, method = 'GET', body) {
    if (CONFIG.USE_MOCK) return Mock.handle(path, method, body, Api.token);
    let res;
    try {
      res = await fetch(CONFIG.API_BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(Api.token ? { Authorization: 'Bearer ' + Api.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('Network error. Check your connection and try again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      if (res.status === 401 && Api.token) { Auth.logout(true); }   // expired / invalid session
      throw err;
    }
    return data;
  },

  register: (username, email, password) => Api.request(CONFIG.EP.register, 'POST', { username, email, password }),
  login: (usernameOrEmail, password) => Api.request(CONFIG.EP.login, 'POST', { usernameOrEmail, password }),
  getProfile: () => Api.request(CONFIG.EP.profile),
  putProfile: patch => Api.request(CONFIG.EP.profile, 'PUT', patch),
  claimFreeChest: gem => Api.request(CONFIG.EP.claim, 'POST', { gem }),
  openChest: (gem, paid, potionUsed) => Api.request(CONFIG.EP.open, 'POST', { gem, paid, potionUsed }),
  sellGem: gemId => Api.request(CONFIG.EP.sell, 'POST', { gemId }),
};
/* Expected profile shape from the server:
   { username, email, cash, inventory:[gem], portfolioHistory:[{t:ms, v:netWorth}],
     lastFreeChestClaim, nextFreeChestAt (ISO, Berlin midnight), freeChestAvailable, activeLuckPotion }
   Mutating endpoints (claim, open, sell, PUT profile) should return the updated profile. */

/* ---------- Optional mock server (in-memory; mirrors the endpoints above) ---------- */
const Mock = {
  users: {}, sessions: {},
  berlinDay: d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d),
  msToBerlinMidnight() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date()).map(x => [x.type, +x.value]));
    return 86400000 - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
  },
  net: u => u.cash + u.inventory.reduce((s, g) => s + g.worth, 0),
  snap(u) { u.portfolioHistory.push({ t: Date.now(), v: Mock.net(u) }); },
  view(u) {
    const avail = !u.lastClaim || Mock.berlinDay(new Date(u.lastClaim)) !== Mock.berlinDay(new Date());
    return { username: u.username, email: u.email, cash: u.cash, inventory: u.inventory, portfolioHistory: u.portfolioHistory,
      lastFreeChestClaim: u.lastClaim, freeChestAvailable: avail,
      nextFreeChestAt: avail ? null : new Date(Date.now() + Mock.msToBerlinMidnight()).toISOString(), activeLuckPotion: u.luck };
  },
  async handle(path, method, b, token) {
    await new Promise(r => setTimeout(r, 180));
    const E = CONFIG.EP, fail = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };
    if (path === E.register) {
      const k = b.username.toLowerCase();
      if (Mock.users[k]) fail('Username is already taken.');
      if (Object.values(Mock.users).some(u => u.email.toLowerCase() === b.email.toLowerCase())) fail('Email is already registered.');
      const now = Date.now();
      Mock.users[k] = { username: b.username, email: b.email, password: b.password, cash: CONFIG.START_CASH, inventory: [], luck: false, lastClaim: null,
        portfolioHistory: [4, 3, 2, 1].map(d => ({ t: now - d * 86400000, v: CONFIG.START_CASH })).concat({ t: now, v: CONFIG.START_CASH }) };
      return { ok: true };
    }
    if (path === E.login) {
      const id = b.usernameOrEmail.toLowerCase();
      const u = Object.values(Mock.users).find(x => x.username.toLowerCase() === id || x.email.toLowerCase() === id);
      if (!u || u.password !== b.password) fail('Wrong username/email or password.', 401);
      const t = Gems.uid(); Mock.sessions[t] = u.username.toLowerCase();
      return { token: t, user: Mock.view(u) };
    }
    const u = Mock.users[Mock.sessions[token]];
    if (!u) fail('Session expired. Please log in again.', 401);
    if (path === E.profile && method === 'GET') return Mock.view(u);
    if (path === E.profile) {
      if (typeof b.cash === 'number' && b.cash >= 0) u.cash = b.cash;
      if (typeof b.activeLuckPotion === 'boolean') u.luck = b.activeLuckPotion;
      Mock.snap(u); return Mock.view(u);
    }
    if (path === E.claim) {
      if (!Mock.view(u).freeChestAvailable) fail('Free chest already claimed today.');
      u.lastClaim = new Date().toISOString(); u.inventory.push(b.gem);
      u.luck = false;   // a luck potion is consumed by the next chest, free or paid
      Mock.snap(u); return Mock.view(u);
    }
    if (path === E.open) {
      if (b.paid) { if (u.cash < CONFIG.CHEST_PRICE) fail('Not enough cash.'); u.cash -= CONFIG.CHEST_PRICE; }
      u.inventory.push(b.gem); if (b.potionUsed) u.luck = false; Mock.snap(u); return Mock.view(u);
    }
    if (path === E.sell) {
      const i = u.inventory.findIndex(g => g.id === b.gemId);
      if (i < 0) fail('Gem not found.', 404);
      u.cash += u.inventory.splice(i, 1)[0].worth; Mock.snap(u); return Mock.view(u);
    }
    fail('Unknown endpoint.', 404);
  },
};

/* ---------- App state ---------- */
const S = { user: null, range: 'week', filter: 'all', sort: 'acquiredAt', dir: -1 };
const netWorth = u => u.cash + u.inventory.reduce((s, g) => s + g.worth, 0);

function applyProfile(p) {            // single entry point for server → local cache
  S.user = p; Profile.render(); Portfolio.render(); Inventory.render(); Shop.refresh();
}

/* ---------- Auth ---------- */
const Auth = {
  init() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.toggle('active', x === t));
      $('#login-form').classList.toggle('hidden', t.dataset.tab !== 'login');
      $('#register-form').classList.toggle('hidden', t.dataset.tab !== 'register');
    }));
    $('#login-form').addEventListener('submit', e => { e.preventDefault(); const f = e.target;
      busy($('button', f), async () => { await Auth.doLogin(f.id.value.trim(), f.password.value); f.reset(); }); });
    $('#register-form').addEventListener('submit', e => { e.preventDefault(); const f = e.target;
      busy($('button', f), async () => {
        if (f.password.value !== f.confirm.value) throw new Error('Passwords do not match.');
        await Api.register(f.username.value.trim(), f.email.value.trim(), f.password.value);
        Toast.ok('Account created. Logging you in…');
        await Auth.doLogin(f.username.value.trim(), f.password.value); f.reset();
      }); });
    $('#logout').addEventListener('click', () => Auth.logout());
  },
  async doLogin(id, pw) {
    const { token } = await Api.login(id, pw);
    Api.setToken(token);
    await Auth.enter();
  },
  /** Load the full profile from the databank and show the dashboard. */
  async enter() {
    applyProfile(await Api.getProfile());
    $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
    Portfolio.init();
    Portfolio.render();
  },
  logout(expired) {
    Api.setToken(null); S.user = null;
    $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden'); $('#modal').classList.add('hidden');
    Preview3D.dispose();
    Toast.show(expired ? 'Session expired. Please log in again.' : 'Logged out.');
  },
};

/* ---------- Profile panel + daily chest countdown ---------- */
const Profile = {
  render() {
    const u = S.user; if (!u) return;
    $('#p-name').textContent = u.username;
    $('#p-net').textContent = money(netWorth(u));
    $('#p-cash').textContent = money(u.cash);
    $('#p-count').textContent = u.inventory.length;
    $('#p-luck').textContent = u.activeLuckPotion ? 'Active' : 'None';
    Profile.tick();
  },
  tick() {
    const u = S.user; if (!u) return;
    const next = u.nextFreeChestAt ? new Date(u.nextFreeChestAt).getTime() : 0;
    if (!u.freeChestAvailable && next && Date.now() >= next) u.freeChestAvailable = true; // server re-checks on claim
    const s = Math.max(0, Math.floor((next - Date.now()) / 1000));
    const txt = u.freeChestAvailable ? 'Ready to claim'
      : [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
    $('#p-daily').textContent = txt;
    $('#claim').disabled = $('#shop-free').disabled = !u.freeChestAvailable;
  },
};

/* ---------- Portfolio chart ---------- */
const Portfolio = {
  chart: null,
  init() {
    if (Portfolio.chart) return;
    Portfolio.chart = new Chart($('#chart'), {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: '#d6a84f', backgroundColor: 'rgba(214,168,79,.12)', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + money(c.parsed.y) } } },
        scales: { x: { ticks: { color: '#8c95ad', maxTicksLimit: 6 }, grid: { display: false } },
                  y: { ticks: { color: '#8c95ad', callback: v => money(v) }, grid: { color: 'rgba(255,255,255,.06)' } } },
      },
    });
    $$('#range button').forEach(b => b.addEventListener('click', () => {
      S.range = b.dataset.r; $$('#range button').forEach(x => x.classList.toggle('active', x === b)); Portfolio.render();
    }));
  },
  render() {
    if (!Portfolio.chart || !S.user) return;
    const span = { day: 864e5, week: 6048e5, year: 31536e6, all: Infinity }[S.range];
    const now = Date.now();
    let pts = (S.user.portfolioHistory || []).filter(p => now - p.t <= span);
    if (!pts.length) pts = (S.user.portfolioHistory || []).slice(-1);
    const fmt = S.range === 'day' ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' };
    Portfolio.chart.data.labels = pts.map(p => new Date(p.t).toLocaleString('en-GB', fmt));
    Portfolio.chart.data.datasets[0].data = pts.map(p => p.v);
    Portfolio.chart.update();
  },
};

/* ---------- Inventory ---------- */
const Inventory = {
  init() {
    $('#f-tier').innerHTML = '<option value="all">All rarities</option>' + TIERS.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    $('#f-tier').addEventListener('change', e => { S.filter = e.target.value; Inventory.render(); });
    $('#s-key').addEventListener('change', e => { S.sort = e.target.value; Inventory.render(); });
    $('#s-dir').addEventListener('click', e => { S.dir *= -1; e.target.textContent = S.dir < 0 ? '↓' : '↑'; Inventory.render(); });
    $('#inv').addEventListener('click', e => {
      const el = e.target.closest('.gem'); if (!el) return;
      const g = S.user.inventory.find(x => x.id === el.dataset.id); if (g) Preview3D.open(g);
    });
  },
  render() {
    if (!S.user) return;
    const val = g => S.sort === 'tier' ? TIER[g.tier].rank : S.sort === 'acquiredAt' ? Date.parse(g.acquiredAt) : g[S.sort];
    const list = S.user.inventory.filter(g => S.filter === 'all' || g.tier === S.filter).sort((a, b) => (val(a) - val(b)) * S.dir);
    $('#inv').innerHTML = list.length ? list.map(g => `
      <button class="gem" data-id="${esc(g.id)}" style="--tc:${TIER[g.tier].color};--gc:${Gems.color(g)}">
        <div class="sw"></div><b>${esc(g.name)}</b>
        <small>${TIER[g.tier].name} · ${esc(g.statusName)}</small><span class="w">${money(g.worth)}</span>
      </button>`).join('')
      : '<p class="empty">No gems here yet. Claim your free chest to start.</p>';
  },
};

/* ---------- Shop ---------- */
const Shop = {
  init() {
    const free = btn => busy(btn, async () => {
      const luck = S.user.activeLuckPotion, gem = Gems.roll(luck);
      applyProfile(await Api.claimFreeChest(gem));
      Preview3D.open(gem, true);
    });
    $('#claim').addEventListener('click', e => free(e.currentTarget));
    $('#shop-free').addEventListener('click', e => free(e.currentTarget));
    $('#buy-chest').addEventListener('click', e => busy(e.currentTarget, async () => {
      if (S.user.cash < CONFIG.CHEST_PRICE) throw new Error('Not enough cash for a chest.');
      const luck = S.user.activeLuckPotion, gem = Gems.roll(luck);
      applyProfile(await Api.openChest(gem, true, luck));
      Preview3D.open(gem, true);
    }));
    $('#buy-potion').addEventListener('click', e => busy(e.currentTarget, async () => {
      if (S.user.activeLuckPotion) throw new Error('You already have a luck potion active.');
      if (S.user.cash < CONFIG.POTION_PRICE) throw new Error('Not enough cash for a potion.');
      applyProfile(await Api.putProfile({ cash: S.user.cash - CONFIG.POTION_PRICE, activeLuckPotion: true }));
      Toast.ok('Luck potion active for your next chest.');
    }));
  },
  refresh() {
    const u = S.user; if (!u) return;
    $('#buy-chest').disabled = u.cash < CONFIG.CHEST_PRICE;
    $('#buy-potion').disabled = u.cash < CONFIG.POTION_PRICE || u.activeLuckPotion;
    Profile.tick();
  },
};

/* ---------- 3D preview modal (Three.js, manual drag rotation) ---------- */
const Preview3D = {
  r: null, raf: 0, gem: null,
  init() {
    $('#m-close').addEventListener('click', Preview3D.close);
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') Preview3D.close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') Preview3D.close(); });
    $('#m-sell').addEventListener('click', e => busy(e.currentTarget, async () => {
      const g = Preview3D.gem;
      applyProfile(await Api.sellGem(g.id));
      Toast.ok(`Sold ${g.name} for ${money(g.worth)}.`);
      Preview3D.close();
    }));
  },
  open(g, isNew) {
    Preview3D.gem = g;
    const t = TIER[g.tier];
    $('#m-title').textContent = g.name;
    $('#m-tier').textContent = t.name + ' gemstone';
    $('#m-tier').style.color = t.color;
    $('#m-flag').classList.toggle('hidden', !isNew);
    $('#m-sell').textContent = 'Sell for ' + money(g.worth);
    $('#m-stats').innerHTML = [
      ['Float', g.float.toFixed(4)], ['Status', `${esc(g.statusName)} (${g.status})`], ['Base value', money(t.base)],
      ['Worth', money(g.worth)], ['Acquired', new Date(g.acquiredAt).toLocaleDateString('en-GB')],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#modal').classList.remove('hidden');
    Preview3D.start(g);
  },
  start(g) {
    Preview3D.dispose();
    if (!window.THREE) return;
    const box = $('#m-3d'), w = box.clientWidth || 380, h = box.clientHeight || 340;
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(45, w / h, .1, 50);
    cam.position.set(0, 0, 4.2);
    const rend = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    rend.setSize(w, h); rend.setPixelRatio(Math.min(devicePixelRatio, 2)); box.appendChild(rend.domElement);
    const col = new THREE.Color(Gems.color(g));
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(1.25, 0).scale(1, 1.2, 1),
      new THREE.MeshPhysicalMaterial({ color: col, metalness: .1, roughness: .08 + (1 - g.float) * .3, clearcoat: 1, flatShading: true,
        emissive: col, emissiveIntensity: .12 + g.float * .2 }));
    scene.add(mesh, new THREE.AmbientLight(0xffffff, .5));
    const l1 = new THREE.PointLight(0xffffff, 1.2); l1.position.set(3, 3, 4);
    const l2 = new THREE.PointLight(0xd6a84f, .8); l2.position.set(-3, -2, 3);
    scene.add(l1, l2);
    let drag = false, px = 0, py = 0, vx = .008;
    const el = rend.domElement;
    el.addEventListener('pointerdown', e => { drag = true; px = e.clientX; py = e.clientY; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => drag = false);
    el.addEventListener('pointermove', e => { if (!drag) return; mesh.rotation.y += (e.clientX - px) * .01; mesh.rotation.x += (e.clientY - py) * .01; px = e.clientX; py = e.clientY; });
    const loop = () => { if (!drag) mesh.rotation.y += vx; rend.render(scene, cam); Preview3D.raf = requestAnimationFrame(loop); };
    Preview3D.r = rend; loop();
  },
  dispose() {
    cancelAnimationFrame(Preview3D.raf);
    if (Preview3D.r) { Preview3D.r.dispose(); Preview3D.r.domElement.remove(); Preview3D.r = null; }
  },
  close() { $('#modal').classList.add('hidden'); Preview3D.dispose(); },
};

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  Auth.init(); Inventory.init(); Shop.init(); Preview3D.init();
  setInterval(Profile.tick, 1000);
  if (Api.token) {                       // resume session from stored token
    try { await Auth.enter(); } catch { Api.setToken(null); }
  }
});
