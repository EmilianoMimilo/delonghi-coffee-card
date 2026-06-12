/* ============================================================
   DelonghiCoffeeCard — V2
   Cafetière DeLonghi Eletta Explore ECAM450.86.T (Coffee Link)
   V1 → V2 :
     - catalogue complet : 17 boissons (liste configurable `drinks:`)
     - bouton Stop pendant la préparation, bouton Wake (réveil machine)
     - état via sensor.connection_status (plus fiable que l'availability)
     - stats : total boissons, espresso, bac à marc, dureté d'eau
     - compteurs par boisson au tap sur la stat (more-info)
   NB : pas de capteur de niveau d'eau — non exposé par le cloud DeLonghi.
   ============================================================ */

console.info('%cDelonghiCoffeeCard V2.1', 'color:#b5651d;font-weight:800;');

function addTapListener(el, fn) {
  if (!el) return;
  let lastTouch = 0;
  el.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
  el.addEventListener('touchend', (e) => { lastTouch = Date.now(); e.preventDefault(); fn(e); }, { passive: false });
  el.addEventListener('click', (e) => { if (Date.now() - lastTouch < 500) return; fn(e); });
}

/* Catalogue complet des boissons (clé = nom config, entité button.${ENT}_<key>) */
const DRINKS = {
  espresso:           { icon: '☕', label: 'Espresso' },
  coffee:             { icon: '☕', label: 'Café' },
  long_coffee:        { icon: '🫖', label: 'Café long' },
  double_espresso:    { icon: '☕', label: 'Double espresso' },
  doppio:             { icon: '☕', label: 'Doppio+' },
  americano:          { icon: '🇺🇸', label: 'Americano' },
  long_black:         { icon: '🖤', label: 'Long black' },
  cortado:            { icon: '🥃', label: 'Cortado' },
  cappuccino:         { icon: '🥛', label: 'Cappuccino' },
  cappuccino_doppio:  { icon: '🥛', label: 'Cappu. doppio+' },
  cappuccino_reverse: { icon: '🥛', label: 'Cappu. reverse' },
  latte_macchiato:    { icon: '🥛', label: 'Latte macchiato' },
  caffe_latte:        { icon: '🥛', label: 'Caffè latte' },
  flat_white:         { icon: '🤍', label: 'Flat white' },
  espresso_macchiato: { icon: '🥛', label: 'Espresso macch.' },
  hot_milk:           { icon: '🥛', label: 'Lait chaud' },
  hot_water:          { icon: '💧', label: 'Eau chaude' },
  tea:                { icon: '🍵', label: 'Thé' },
  coffee_pot:         { icon: '🍶', label: 'Pot de café' },
  mug_to_go:          { icon: '🥤', label: 'Mug to go' },
  brew_over_ice:      { icon: '🧊', label: 'Over ice' },
};

class DelonghiCoffeeCard extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._initialized = false;
    this._armed = null;
    this._armTimer = null;
    this._brewing = null;
    this._brewTimer = null;
  }

  setConfig(config) {
    // `device` = préfixe des entités créées par delonghi_coffeelink,
    // en minuscules (ex: ac000w012345678 → button.ac000w012345678_espresso)
    if (!config.device) throw new Error('"device" est requis (ex: ac000w012345678)');
    const ENT = config.device.toLowerCase();
    this._ent = ENT;
    this._config = {
      drinks: config.drinks || ['espresso', 'coffee', 'long_coffee', 'cappuccino', 'latte_macchiato', 'hot_water'],
      connection: config.connection || `sensor.${ENT}_connection_status`,
      stop:       config.stop       || `button.${ENT}_stop`,
      wake:       config.wake       || `button.${ENT}_wake`,
      counter:    config.counter    || `sensor.${ENT}_total_beverages`,
      espresso_counter: config.espresso_counter || `sensor.${ENT}_total_espresso`,
      grounds:    config.grounds    || `sensor.${ENT}_grounds_counter`,
      hardness:   config.hardness   || `sensor.${ENT}_water_hardness`,
      update:     config.update     || 'update.de_longhi_coffee_link_update',
      sun:        config.sun        || 'sun.sun',
      title:      config.title      || 'Cafetière',
      brew_seconds: config.brew_seconds || 45,
      ...config,
    };
    this._drinks = this._config.drinks
      .filter((k) => DRINKS[k])
      .map((k) => ({ key: k, ...DRINKS[k], entity: `button.${this._ent}_${k}` }));
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._render();
      this._initialized = true;
    }
    this._update();
  }

  getCardSize() { return 5; }

  /* ── Helpers ─────────────────────────────────────────────── */
  _st(id)  { return this._hass?.states?.[id]; }
  _val(id) { const s = this._st(id); return s && !['unknown', 'unavailable'].includes(s.state) ? s.state : null; }
  _fireMoreInfo(id) { if (!id) return; this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: id }, bubbles: true, composed: true })); }

  _isDay() {
    const sun = this._st(this._config.sun);
    if (!sun) {
      const h = new Date().getHours();
      return h >= 7 && h < 21;
    }
    return sun.state === 'above_horizon';
  }

  _online() {
    const conn = this._val(this._config.connection);
    if (conn !== null) return conn.toLowerCase() === 'online';
    const s = this._st(this._drinks[0]?.entity);
    return !!s && s.state !== 'unavailable';
  }

  _lastBrew() {
    let best = null;
    for (const d of this._drinks) {
      const v = this._val(d.entity);
      if (!v) continue;
      const t = Date.parse(v);
      if (isFinite(t) && (best === null || t > best)) best = t;
    }
    return best;
  }

  _ago(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1)   return "à l'instant";
    if (mins < 60)  return `il y a ${mins} min`;
    const h = Math.floor(mins / 60);
    if (h < 24)     return `il y a ${h} h`;
    return `il y a ${Math.floor(h / 24)} j`;
  }

  /* ── Actions ─────────────────────────────────────────────── */
  _disarm() {
    clearTimeout(this._armTimer);
    this._armed = null;
    this._update();
  }

  _tapDrink(drink) {
    if (this._brewing || !this._online()) return;
    if (this._armed !== drink.key) {
      clearTimeout(this._armTimer);
      this._armed = drink.key;
      this._armTimer = setTimeout(() => this._disarm(), 5000);
      this._update();
      return;
    }
    clearTimeout(this._armTimer);
    this._armed = null;
    this._hass.callService('button', 'press', { entity_id: drink.entity });
    this._brewing = drink.key;
    this._update();
    clearTimeout(this._brewTimer);
    this._brewTimer = setTimeout(() => { this._brewing = null; this._update(); }, this._config.brew_seconds * 1000);
  }

  _tapStop() {
    if (!this._brewing) return;
    this._hass.callService('button', 'press', { entity_id: this._config.stop });
    clearTimeout(this._brewTimer);
    this._brewing = null;
    this._update();
  }

  _tapWake() {
    if (!this._online()) return;
    this._hass.callService('button', 'press', { entity_id: this._config.wake });
  }

  /* ── Render initial ──────────────────────────────────────── */
  _render() {
    const btns = this._drinks.map((d) => `
      <button class="drink-btn" data-key="${d.key}">
        <span class="drink-icon">${d.icon}</span>
        <span class="drink-label">${d.label}</span>
      </button>`).join('');

    this.shadowRoot.innerHTML = `<style>${this._css()}</style>
      <div class="card" data-day="1">
        <div class="head">
          <div class="title-wrap">
            <span class="title">${this._config.title}</span>
            <span class="subtitle">Eletta Explore</span>
          </div>
          <div class="head-right">
            <button class="wake-btn" title="Réveiller la machine">⏰</button>
            <span class="status-badge"></span>
          </div>
        </div>

        <div class="cup-zone">
          <svg viewBox="0 0 120 110" class="cup-svg" aria-hidden="true">
            <g class="steam-g">
              <path class="steam s1" d="M48 30 q-4 -8 0 -14 q4 -6 0 -12" fill="none" stroke-width="3" stroke-linecap="round"/>
              <path class="steam s2" d="M62 30 q-4 -8 0 -14 q4 -6 0 -12" fill="none" stroke-width="3" stroke-linecap="round"/>
              <path class="steam s3" d="M76 30 q-4 -8 0 -14 q4 -6 0 -12" fill="none" stroke-width="3" stroke-linecap="round"/>
            </g>
            <path class="cup-body" d="M30 40 h64 v28 a22 22 0 0 1 -22 22 h-20 a22 22 0 0 1 -22 -22 z"/>
            <path class="cup-handle" d="M94 46 h6 a12 12 0 0 1 0 24 h-6" fill="none" stroke-width="6"/>
            <clipPath id="cup-clip"><path d="M32 42 h60 v26 a20 20 0 0 1 -20 20 h-20 a20 20 0 0 1 -20 -20 z"/></clipPath>
            <rect class="coffee-fill" clip-path="url(#cup-clip)" x="30" y="90" width="66" height="50"/>
            <ellipse class="saucer" cx="61" cy="96" rx="42" ry="6"/>
          </svg>
          <div class="brew-status"></div>
          <button class="stop-btn" hidden>⏹ Stop</button>
        </div>

        <div class="drinks">${btns}</div>

        <div class="stats">
          <button class="stat" data-entity="${this._config.counter}">
            <span class="stat-val" id="st-total">—</span><span class="stat-label">boissons</span>
          </button>
          <button class="stat" data-entity="${this._config.espresso_counter}">
            <span class="stat-val" id="st-espresso">—</span><span class="stat-label">espressos</span>
          </button>
          <button class="stat" data-entity="${this._config.grounds}">
            <span class="stat-val" id="st-grounds">—</span><span class="stat-label">bac à marc</span>
          </button>
          <button class="stat" data-entity="${this._config.hardness}">
            <span class="stat-val" id="st-hardness">—</span><span class="stat-label">dureté eau</span>
          </button>
        </div>

        <div class="foot">
          <span class="lastbrew"></span>
          <span class="update-badge" hidden>⬆️ MAJ firmware dispo</span>
        </div>
      </div>`;
    this._bindEvents();
  }

  _bindEvents() {
    this.shadowRoot.querySelectorAll('.drink-btn').forEach((btn) => {
      const drink = this._drinks.find((d) => d.key === btn.dataset.key);
      addTapListener(btn, () => this._tapDrink(drink));
    });
    addTapListener(this.shadowRoot.querySelector('.stop-btn'), () => this._tapStop());
    addTapListener(this.shadowRoot.querySelector('.wake-btn'), () => this._tapWake());
    this.shadowRoot.querySelectorAll('.stat').forEach((el) => {
      addTapListener(el, () => this._fireMoreInfo(el.dataset.entity));
    });
  }

  /* ── Update ──────────────────────────────────────────────── */
  _update() {
    const r = this.shadowRoot;
    const card = r.querySelector('.card');
    if (!card) return;

    const isDay  = this._isDay();
    const online = this._online();
    card.dataset.day = isDay ? '1' : '0';
    card.dataset.online = online ? '1' : '0';
    card.dataset.brewing = this._brewing ? '1' : '0';

    const badge = r.querySelector('.status-badge');
    if (this._brewing) {
      badge.textContent = '☕ En préparation…';
      badge.className = 'status-badge brewing';
    } else if (online) {
      badge.textContent = '● Connectée';
      badge.className = 'status-badge online';
    } else {
      badge.textContent = '○ Injoignable';
      badge.className = 'status-badge offline';
    }

    const brewStatus = r.querySelector('.brew-status');
    if (this._brewing) {
      const d = this._drinks.find((x) => x.key === this._brewing) || DRINKS[this._brewing] || {};
      brewStatus.textContent = `${d.label || 'Boisson'} en cours — tasse sous le bec !`;
    } else if (!online) {
      brewStatus.textContent = 'Machine éteinte ou hors-ligne';
    } else if (this._armed) {
      brewStatus.textContent = 'Appuie à nouveau pour confirmer';
    } else {
      brewStatus.textContent = '';
    }

    r.querySelector('.stop-btn').hidden = !this._brewing;
    r.querySelector('.wake-btn').disabled = !online;

    r.querySelectorAll('.drink-btn').forEach((btn) => {
      const key = btn.dataset.key;
      const drink = this._drinks.find((d) => d.key === key);
      btn.dataset.armed = this._armed === key ? '1' : '0';
      btn.disabled = !online || !!this._brewing;
      btn.querySelector('.drink-label').textContent = this._armed === key ? 'Confirmer ?' : drink.label;
    });

    // Stats
    const set = (id, val, suffix = '') => {
      const el = r.querySelector(id);
      if (el) el.textContent = val !== null ? val + suffix : '—';
    };
    set('#st-total',    this._val(this._config.counter));
    set('#st-espresso', this._val(this._config.espresso_counter));
    set('#st-grounds',  this._val(this._config.grounds));
    set('#st-hardness', this._val(this._config.hardness));

    const last = this._lastBrew();
    r.querySelector('.lastbrew').textContent = last ? `Dernière boisson ${this._ago(last)}` : '';
    r.querySelector('.update-badge').hidden = this._val(this._config.update) !== 'on';
  }

  /* ── Styles ──────────────────────────────────────────────── */
  _css() { return `
    :host { display: block; }
    .card {
      border-radius: 22px; padding: 18px 18px 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
      background: linear-gradient(160deg, #fdf6ee, #f3e6d8);
      border: 1px solid rgba(181, 101, 29, 0.18);
      transition: background 0.4s;
      user-select: none; -webkit-user-select: none;
    }
    .card[data-day="0"] {
      background: linear-gradient(160deg, #1d1814, #120e0b);
      border-color: rgba(181, 101, 29, 0.25);
    }

    .head { display: flex; justify-content: space-between; align-items: flex-start; }
    .title { font-size: 17px; font-weight: 800; color: #4a2f18; display: block; }
    .subtitle { font-size: 11px; font-weight: 600; color: #b5651d; letter-spacing: 0.4px; }
    .card[data-day="0"] .title { color: #f0e3d4; }
    .head-right { display: flex; align-items: center; gap: 8px; }

    .wake-btn {
      width: 30px; height: 30px; border-radius: 50%; font-size: 14px; cursor: pointer;
      background: rgba(181, 101, 29, 0.1); border: 1px solid rgba(181, 101, 29, 0.22);
      font-family: inherit; line-height: 1;
    }
    .wake-btn:disabled { opacity: 0.4; cursor: default; }
    .card[data-day="0"] .wake-btn { background: rgba(255, 255, 255, 0.05); }

    .status-badge { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
    .status-badge.online  { color: #16a34a; background: rgba(22, 163, 74, 0.12); }
    .status-badge.offline { color: #9ca3af; background: rgba(156, 163, 175, 0.15); }
    .status-badge.brewing { color: #b5651d; background: rgba(181, 101, 29, 0.15); animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.55; } }

    .cup-zone { text-align: center; padding: 2px 0; }
    .cup-svg { width: 96px; height: 88px; }
    .cup-body { fill: #fff; stroke: #b5651d; stroke-width: 4; }
    .card[data-day="0"] .cup-body { fill: #2a211a; stroke: #c97b35; }
    .cup-handle { stroke: #b5651d; }
    .card[data-day="0"] .cup-handle { stroke: #c97b35; }
    .saucer { fill: rgba(181, 101, 29, 0.25); }

    .coffee-fill { fill: #6f4423; transform: translateY(0); }
    .card[data-brewing="1"] .coffee-fill { animation: fill-cup ${this._config.brew_seconds}s linear forwards; }
    @keyframes fill-cup { from { transform: translateY(0); } to { transform: translateY(-40px); } }

    .steam { stroke: rgba(181, 101, 29, 0.45); opacity: 0; }
    .card[data-day="0"] .steam { stroke: rgba(240, 227, 212, 0.35); }
    .card[data-brewing="1"] .steam { animation: steam-rise 2.2s ease-in-out infinite; }
    .steam.s2 { animation-delay: 0.4s !important; }
    .steam.s3 { animation-delay: 0.8s !important; }
    @keyframes steam-rise {
      0%   { opacity: 0; transform: translateY(4px); }
      35%  { opacity: 1; }
      100% { opacity: 0; transform: translateY(-7px); }
    }
    .card[data-online="0"] .cup-svg { opacity: 0.4; filter: grayscale(0.8); }

    .brew-status { min-height: 16px; font-size: 12px; font-weight: 600; color: #b5651d; }
    .card[data-online="0"] .brew-status { color: #9ca3af; }

    .stop-btn {
      margin-top: 6px; padding: 8px 22px; border-radius: 999px; cursor: pointer;
      font-family: inherit; font-size: 13px; font-weight: 800;
      color: #fff; background: #dc2626; border: none;
      box-shadow: 0 4px 16px rgba(220, 38, 38, 0.4);
    }

    .drinks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
    .drink-btn {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 10px 4px; border-radius: 14px; cursor: pointer;
      background: rgba(181, 101, 29, 0.08); border: 1px solid rgba(181, 101, 29, 0.18);
      transition: transform 0.15s, background 0.25s, border-color 0.25s, box-shadow 0.25s;
      font-family: inherit;
    }
    .card[data-day="0"] .drink-btn { background: rgba(255, 255, 255, 0.04); border-color: rgba(201, 123, 53, 0.2); }
    .drink-btn:disabled { opacity: 0.45; cursor: default; }
    .drink-btn:not(:disabled):hover { transform: translateY(-2px); }
    .drink-btn[data-armed="1"] {
      background: rgba(181, 101, 29, 0.22) !important;
      border-color: #b5651d !important;
      box-shadow: 0 4px 18px rgba(181, 101, 29, 0.35);
      animation: pulse 1s ease-in-out infinite;
    }
    .drink-icon  { font-size: 21px; }
    .drink-label { font-size: 10px; font-weight: 700; color: #4a2f18; letter-spacing: 0.2px; text-align: center; }
    .card[data-day="0"] .drink-label { color: #d9c4ab; }
    .drink-btn[data-armed="1"] .drink-label { color: #b5651d; }

    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
    .stat {
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      padding: 8px 2px; border-radius: 12px; cursor: pointer;
      background: rgba(181, 101, 29, 0.06); border: 1px solid rgba(181, 101, 29, 0.12);
      font-family: inherit;
    }
    .card[data-day="0"] .stat { background: rgba(255, 255, 255, 0.03); border-color: rgba(201, 123, 53, 0.14); }
    .stat-val   { font-size: 15px; font-weight: 800; color: #4a2f18; }
    .card[data-day="0"] .stat-val { color: #f0e3d4; }
    .stat-label { font-size: 9px; font-weight: 600; color: #8a6a48; text-transform: uppercase; letter-spacing: 0.4px; }
    .card[data-day="0"] .stat-label { color: #8a7a66; }

    .foot {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 10px; font-size: 11px; font-weight: 600; color: #8a6a48;
    }
    .card[data-day="0"] .foot { color: #8a7a66; }
    .update-badge { color: #2563eb; }

    @media (prefers-reduced-motion: reduce) {
      .steam, .status-badge.brewing, .drink-btn[data-armed="1"] { animation: none !important; opacity: 1; }
    }
  `; }
}

customElements.define('delonghi-coffee-card', DelonghiCoffeeCard);
