/* ============================================================
   DelonghiCoffeeCard — V3
   Carte Lovelace pour cafetières DeLonghi Coffee Link (intégration
   actabi/delonghi_coffeelink). Générique : `device` = préfixe des entités.

   V2 → V3 :
     - bouton FAVORI en grand (défaut: espresso) — le geste quotidien en un tap
     - préparation : barre de progression + compte à rebours en secondes
     - "Dernière boisson" indique laquelle (icône + nom + heure)
     - bac à marc en % + alertes maintenance (bac plein / détartrage)  [optionnel]
     - sélecteurs de réglage (profil, température, arrêt auto…)          [optionnel]
     - interrupteurs on/off (éco d'énergie, bip…)                       [optionnel]
     - wake fiable via un service custom (firmwares au wake natif KO)    [optionnel]
     - polish : ombre douce, chiffres formatés, états affinés
   NB : pas de capteur de niveau d'eau — non exposé par le cloud DeLonghi.
   ============================================================ */

console.info('%cDelonghiCoffeeCard V3', 'color:#b5651d;font-weight:800;');

function addTapListener(el, fn) {
  if (!el) return;
  let lastTouch = 0;
  el.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
  el.addEventListener('touchend', (e) => { lastTouch = Date.now(); e.preventDefault(); fn(e); }, { passive: false });
  el.addEventListener('click', (e) => { if (Date.now() - lastTouch < 500) return; fn(e); });
}

/* Catalogue complet des boissons (clé = nom config, entité button.<device>_<key>) */
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

function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return v;
  return n.toLocaleString('fr-FR');
}

class DelonghiCoffeeCard extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._initialized = false;
    this._armed = null;
    this._armTimer = null;
    this._brewing = null;
    this._brewTimer = null;
    this._brewStart = 0;
    this._tickTimer = null;
  }

  setConfig(config) {
    // `device` = préfixe des entités créées par delonghi_coffeelink, en
    // minuscules (ex: ac000w012345678 → button.ac000w012345678_espresso)
    if (!config.device) throw new Error('"device" est requis (ex: ac000w012345678)');
    const ENT = config.device.toLowerCase();
    this._ent = ENT;
    this._config = {
      drinks: config.drinks || ['espresso', 'coffee', 'long_coffee', 'cappuccino', 'latte_macchiato', 'hot_water'],
      favorite:   config.favorite   || 'espresso',
      connection: config.connection || `sensor.${ENT}_connection_status`,
      stop:       config.stop       || `button.${ENT}_stop`,
      wake:       config.wake       || `button.${ENT}_wake`,
      // Optionnel : si le wake natif n'allume pas la machine (certains firmwares),
      // pointe vers un service custom, ex: "shell_command.cafe_wake".
      wake_service: config.wake_service || null,
      counter:    config.counter    || `sensor.${ENT}_total_beverages`,
      espresso_counter: config.espresso_counter || `sensor.${ENT}_total_espresso`,
      grounds:    config.grounds    || `sensor.${ENT}_grounds_counter`,
      // Optionnel : capteur % du bac à marc (jauge + alerte). Sinon, compteur brut.
      grounds_pct: config.grounds_pct || null,
      grounds_warn: config.grounds_warn || 80,
      // Optionnel : capteur texte détartrage (état "Requis" → alerte).
      descale:    config.descale    || null,
      hardness:   config.hardness   || `sensor.${ENT}_water_hardness`,
      update:     config.update     || 'update.de_longhi_coffee_link_update',
      sun:        config.sun        || 'sun.sun',
      title:      config.title      || 'Cafetière',
      subtitle:   config.subtitle   || '',
      brew_seconds: config.brew_seconds || 45,
      // Optionnels : sélecteurs (input_select) et interrupteurs (input_boolean).
      // Vides par défaut → la section réglages n'apparaît pas. Voir le README.
      settings: config.settings || [],
      toggles:  config.toggles  || [],
      ...config,
    };
    this._drinks = this._config.drinks
      .filter((k) => DRINKS[k])
      .map((k) => ({ key: k, ...DRINKS[k], entity: `button.${ENT}_${k}` }));
    const fk = this._config.favorite;
    this._favorite = (fk && DRINKS[fk] && fk !== false)
      ? { key: fk, ...DRINKS[fk], entity: `button.${ENT}_${fk}` }
      : null;
    this._hasSettings = (this._config.settings.length + this._config.toggles.length) > 0;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._render();
      this._initialized = true;
    }
    this._update();
  }

  getCardSize() { return 6; }

  /* ── Helpers ─────────────────────────────────────────────── */
  _st(id)  { return id ? this._hass?.states?.[id] : undefined; }
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

  /* Dernière boisson réellement servie (parmi TOUTES les entités button) */
  _lastBrew() {
    let best = null, bestKey = null;
    for (const key of Object.keys(DRINKS)) {
      const v = this._val(`button.${this._ent}_${key}`);
      if (!v) continue;
      const t = Date.parse(v);
      if (isFinite(t) && (best === null || t > best)) { best = t; bestKey = key; }
    }
    return best ? { ts: best, drink: { key: bestKey, ...DRINKS[bestKey] } } : null;
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
    if (!drink || this._brewing || !this._online()) return;
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
    this._brewStart = Date.now();
    this._update();
    clearTimeout(this._brewTimer);
    clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => this._update(), 1000);
    this._brewTimer = setTimeout(() => {
      this._brewing = null;
      clearInterval(this._tickTimer);
      this._update();
    }, this._config.brew_seconds * 1000);
  }

  _tapStop() {
    if (!this._brewing) return;
    this._hass.callService('button', 'press', { entity_id: this._config.stop });
    clearTimeout(this._brewTimer);
    clearInterval(this._tickTimer);
    this._brewing = null;
    this._update();
  }

  _tapWake() {
    if (!this._online()) return;
    // Si un service custom est configuré (wake natif KO sur certains firmwares),
    // on l'utilise ; sinon on presse le bouton wake natif de l'intégration.
    if (this._config.wake_service) {
      const [domain, service] = this._config.wake_service.split('.');
      this._hass.callService(domain, service, {});
    } else {
      this._hass.callService('button', 'press', { entity_id: this._config.wake });
    }
  }

  _brewRemaining() {
    if (!this._brewing) return 0;
    const left = this._config.brew_seconds - Math.floor((Date.now() - this._brewStart) / 1000);
    return Math.max(0, left);
  }

  /* ── Render initial ──────────────────────────────────────── */
  _render() {
    const btns = this._drinks.map((d) => `
      <button class="drink-btn" data-key="${d.key}">
        <span class="drink-icon">${d.icon}</span>
        <span class="drink-label">${d.label}</span>
      </button>`).join('');

    const fav = this._favorite ? `
      <button class="fav-btn" data-key="${this._favorite.key}">
        <span class="fav-icon">${this._favorite.icon}</span>
        <span class="fav-text">
          <span class="fav-label">${this._favorite.label}</span>
          <span class="fav-hint">Favori — un tap</span>
        </span>
        <span class="fav-go">›</span>
      </button>` : '';

    const subtitle = this._config.subtitle
      ? `<span class="subtitle">${this._config.subtitle}</span>` : '';

    const settingsZone = this._hasSettings ? `<div class="settings-zone">${
      this._config.settings.map((s, i) => `
        <label class="setting-row">
          <span class="setting-name">${s.icon || ''} ${s.label}</span>
          <select class="setting-select" data-entity="${s.entity}" data-idx="${i}"></select>
        </label>`).join('')
    }${
      this._config.toggles.map((t) => `
        <div class="setting-row">
          <span class="setting-name">${t.icon || ''} ${t.label}</span>
          <button class="toggle-btn" data-entity="${t.entity}" data-on="0" role="switch"><span class="knob"></span></button>
        </div>`).join('')
    }</div>` : '';

    this.shadowRoot.innerHTML = `<style>${this._css()}</style>
      <div class="card" data-day="1">
        <div class="head">
          <div class="title-wrap">
            <span class="title">${this._config.title}</span>
            ${subtitle}
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
          <div class="progress" hidden><span class="progress-bar"></span></div>
          <button class="stop-btn" hidden>⏹ Stop</button>
        </div>

        ${fav}

        <div class="drinks">${btns}</div>

        <div class="stats">
          <button class="stat" data-entity="${this._config.counter}">
            <span class="stat-val" id="st-total">—</span><span class="stat-label">boissons</span>
          </button>
          <button class="stat" data-entity="${this._config.espresso_counter}">
            <span class="stat-val" id="st-espresso">—</span><span class="stat-label">espressos</span>
          </button>
          <button class="stat stat-grounds" data-entity="${this._config.grounds_pct || this._config.grounds}" data-warn="0">
            <span class="stat-val" id="st-grounds">—</span><span class="stat-label">bac à marc</span>
          </button>
          <button class="stat" data-entity="${this._config.hardness}">
            <span class="stat-val" id="st-hardness">—</span><span class="stat-label">dureté eau</span>
          </button>
        </div>

        ${settingsZone}

        <div class="maint" hidden></div>

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
    const favBtn = this.shadowRoot.querySelector('.fav-btn');
    if (favBtn) addTapListener(favBtn, () => this._tapDrink(this._favorite));
    addTapListener(this.shadowRoot.querySelector('.stop-btn'), () => this._tapStop());
    addTapListener(this.shadowRoot.querySelector('.wake-btn'), () => this._tapWake());
    this.shadowRoot.querySelectorAll('.stat').forEach((el) => {
      addTapListener(el, () => this._fireMoreInfo(el.dataset.entity));
    });
    this.shadowRoot.querySelectorAll('.setting-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const entity = sel.dataset.entity;
        const option = sel.value;
        if (this._val(entity) === option) return; // pas de changement réel
        this._hass.callService('input_select', 'select_option', { entity_id: entity, option });
      });
    });
    this.shadowRoot.querySelectorAll('.toggle-btn').forEach((btn) => {
      addTapListener(btn, () => {
        if (btn.disabled) return;
        this._hass.callService('input_boolean', 'toggle', { entity_id: btn.dataset.entity });
      });
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
    const progress = r.querySelector('.progress');
    const progBar = r.querySelector('.progress-bar');
    if (this._brewing) {
      const d = this._drinks.find((x) => x.key === this._brewing) || DRINKS[this._brewing] || {};
      const left = this._brewRemaining();
      brewStatus.textContent = `${d.label || 'Boisson'} — ${left} s · tasse sous le bec !`;
      progress.hidden = false;
      const pct = 100 * (this._config.brew_seconds - left) / this._config.brew_seconds;
      progBar.style.width = `${Math.min(100, pct)}%`;
    } else {
      progress.hidden = true;
      progBar.style.width = '0%';
      if (!online) {
        brewStatus.textContent = 'Machine éteinte ou hors-ligne';
      } else if (this._armed) {
        brewStatus.textContent = 'Appuie à nouveau pour confirmer';
      } else {
        brewStatus.textContent = '';
      }
    }

    r.querySelector('.stop-btn').hidden = !this._brewing;
    r.querySelector('.wake-btn').disabled = !online;

    // Bouton favori
    const favBtn = r.querySelector('.fav-btn');
    if (favBtn && this._favorite) {
      const armed = this._armed === this._favorite.key;
      favBtn.dataset.armed = armed ? '1' : '0';
      favBtn.disabled = !online || !!this._brewing;
      favBtn.querySelector('.fav-label').textContent = armed ? 'Confirmer ?' : this._favorite.label;
      favBtn.querySelector('.fav-hint').textContent = armed ? 'Appuie encore pour lancer' : 'Favori — un tap';
    }

    r.querySelectorAll('.drink-btn').forEach((btn) => {
      const key = btn.dataset.key;
      const drink = this._drinks.find((d) => d.key === key);
      btn.dataset.armed = this._armed === key ? '1' : '0';
      btn.disabled = !online || !!this._brewing;
      btn.querySelector('.drink-label').textContent = this._armed === key ? 'Confirmer ?' : drink.label;
    });

    // Stats (chiffres formatés)
    const set = (id, val, fmt = (x) => x) => {
      const el = r.querySelector(id);
      if (el) el.textContent = val !== null ? fmt(val) : '—';
    };
    set('#st-total',    this._val(this._config.counter), fmtNum);
    set('#st-espresso', this._val(this._config.espresso_counter), fmtNum);
    set('#st-hardness', this._val(this._config.hardness));

    // Bac à marc : % si capteur dédié configuré, sinon compteur brut
    const gPctRaw = this._val(this._config.grounds_pct);
    const gPct = gPctRaw !== null ? parseInt(gPctRaw, 10) : null;
    const gStat = r.querySelector('.stat-grounds');
    if (gPct !== null) {
      set('#st-grounds', gPct, (v) => `${v}%`);
      gStat.dataset.warn = gPct >= this._config.grounds_warn ? '2' : (gPct >= 60 ? '1' : '0');
    } else {
      set('#st-grounds', this._val(this._config.grounds));
      gStat.dataset.warn = '0';
    }

    // Alerte maintenance (bac plein / détartrage requis)
    const alerts = [];
    if (gPct !== null && gPct >= this._config.grounds_warn) alerts.push('🗑️ Bac à marc plein — à vider');
    if (this._val(this._config.descale) === 'Requis') alerts.push('🧼 Détartrage requis');
    const maint = r.querySelector('.maint');
    if (alerts.length) { maint.hidden = false; maint.textContent = alerts.join(' · '); }
    else { maint.hidden = true; maint.textContent = ''; }

    // Réglages (sélecteurs) — peuple options + valeur courante depuis input_select
    r.querySelectorAll('.setting-select').forEach((sel) => {
      const st = this._st(sel.dataset.entity);
      const opts = st?.attributes?.options || [];
      const cur = st?.state;
      const sig = opts.join('|');
      if (sel.dataset.sig !== sig) {
        sel.innerHTML = opts.map((o) => `<option value="${o}">${o}</option>`).join('');
        sel.dataset.sig = sig;
      }
      if (cur && sel.value !== cur) sel.value = cur;
      sel.disabled = !st || !this._online();
    });
    r.querySelectorAll('.toggle-btn').forEach((btn) => {
      const st = this._st(btn.dataset.entity);
      btn.dataset.on = st && st.state === 'on' ? '1' : '0';
      btn.disabled = !st || !this._online();
    });

    const last = this._lastBrew();
    r.querySelector('.lastbrew').textContent = last
      ? `${last.drink.icon} ${last.drink.label} ${this._ago(last.ts)}`
      : '';
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
      box-shadow: 0 8px 24px rgba(74, 47, 24, 0.10), 0 1px 0 rgba(255,255,255,0.6) inset;
      transition: background 0.4s, box-shadow 0.4s;
      user-select: none; -webkit-user-select: none;
    }
    .card[data-day="0"] {
      background: linear-gradient(160deg, #1d1814, #120e0b);
      border-color: rgba(181, 101, 29, 0.25);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255,255,255,0.04) inset;
    }

    .head { display: flex; justify-content: space-between; align-items: flex-start; }
    .title { font-size: 17px; font-weight: 800; color: #4a2f18; display: block; }
    .subtitle { font-size: 11px; font-weight: 600; color: #b5651d; letter-spacing: 0.4px; }
    .card[data-day="0"] .title { color: #f0e3d4; }
    .head-right { display: flex; align-items: center; gap: 8px; }

    .wake-btn {
      width: 30px; height: 30px; border-radius: 50%; font-size: 14px; cursor: pointer;
      background: rgba(181, 101, 29, 0.1); border: 1px solid rgba(181, 101, 29, 0.22);
      font-family: inherit; line-height: 1; transition: transform 0.15s;
    }
    .wake-btn:not(:disabled):active { transform: scale(0.9); }
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

    .progress {
      height: 5px; border-radius: 999px; margin: 7px auto 0; max-width: 220px;
      background: rgba(181, 101, 29, 0.15); overflow: hidden;
    }
    .progress-bar {
      display: block; height: 100%; width: 0%; border-radius: 999px;
      background: linear-gradient(90deg, #b5651d, #d98a3d);
      transition: width 1s linear;
    }

    .stop-btn {
      margin-top: 8px; padding: 8px 22px; border-radius: 999px; cursor: pointer;
      font-family: inherit; font-size: 13px; font-weight: 800;
      color: #fff; background: #dc2626; border: none;
      box-shadow: 0 4px 16px rgba(220, 38, 38, 0.4);
    }

    /* ── Bouton favori ── */
    .fav-btn {
      display: flex; align-items: center; gap: 12px; width: 100%;
      margin-top: 6px; padding: 12px 16px; border-radius: 16px; cursor: pointer;
      font-family: inherit; text-align: left;
      color: #fff; border: none;
      background: linear-gradient(135deg, #b5651d, #8a4a14);
      box-shadow: 0 6px 18px rgba(181, 101, 29, 0.35);
      transition: transform 0.15s, box-shadow 0.25s, filter 0.2s;
    }
    .fav-btn:not(:disabled):hover { transform: translateY(-2px); }
    .fav-btn:not(:disabled):active { transform: scale(0.98); }
    .fav-btn:disabled { opacity: 0.45; cursor: default; box-shadow: none; }
    .fav-btn[data-armed="1"] {
      background: linear-gradient(135deg, #16a34a, #0f7a37);
      box-shadow: 0 6px 20px rgba(22, 163, 74, 0.45);
      animation: pulse 1s ease-in-out infinite;
    }
    .fav-icon { font-size: 26px; line-height: 1; }
    .fav-text { display: flex; flex-direction: column; flex: 1; }
    .fav-label { font-size: 15px; font-weight: 800; }
    .fav-hint { font-size: 11px; font-weight: 600; opacity: 0.85; }
    .fav-go { font-size: 24px; font-weight: 800; opacity: 0.7; }

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
    .drink-btn:not(:disabled):active { transform: scale(0.95); }
    .drink-btn[data-armed="1"] {
      background: rgba(22, 163, 74, 0.18) !important;
      border-color: #16a34a !important;
      box-shadow: 0 4px 18px rgba(22, 163, 74, 0.3);
      animation: pulse 1s ease-in-out infinite;
    }
    .drink-icon  { font-size: 21px; }
    .drink-label { font-size: 10px; font-weight: 700; color: #4a2f18; letter-spacing: 0.2px; text-align: center; }
    .card[data-day="0"] .drink-label { color: #d9c4ab; }
    .drink-btn[data-armed="1"] .drink-label { color: #16a34a; }

    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
    .stat {
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      padding: 8px 2px; border-radius: 12px; cursor: pointer;
      background: rgba(181, 101, 29, 0.06); border: 1px solid rgba(181, 101, 29, 0.12);
      font-family: inherit; transition: transform 0.15s;
    }
    .stat:active { transform: scale(0.95); }
    .card[data-day="0"] .stat { background: rgba(255, 255, 255, 0.03); border-color: rgba(201, 123, 53, 0.14); }
    .stat-val   { font-size: 15px; font-weight: 800; color: #4a2f18; }
    .card[data-day="0"] .stat-val { color: #f0e3d4; }
    .stat-label { font-size: 9px; font-weight: 600; color: #8a6a48; text-transform: uppercase; letter-spacing: 0.4px; }
    .card[data-day="0"] .stat-label { color: #8a7a66; }

    /* Bac à marc : niveaux de remplissage */
    .stat-grounds[data-warn="1"] { background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.4); }
    .stat-grounds[data-warn="1"] .stat-val { color: #d97706; }
    .stat-grounds[data-warn="2"] { background: rgba(220, 38, 38, 0.15); border-color: rgba(220, 38, 38, 0.5); animation: pulse 1.4s ease-in-out infinite; }
    .stat-grounds[data-warn="2"] .stat-val { color: #dc2626; }

    /* ── Réglages (sélecteurs + interrupteurs) ── */
    .settings-zone { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 6px 10px; border-radius: 12px;
      background: rgba(181, 101, 29, 0.06); border: 1px solid rgba(181, 101, 29, 0.12);
    }
    .card[data-day="0"] .setting-row { background: rgba(255, 255, 255, 0.03); border-color: rgba(201, 123, 53, 0.14); }
    .setting-name { font-size: 12px; font-weight: 700; color: #4a2f18; }
    .card[data-day="0"] .setting-name { color: #d9c4ab; }
    .setting-select {
      font-family: inherit; font-size: 12px; font-weight: 700;
      color: #4a2f18; background: rgba(255,255,255,0.6);
      border: 1px solid rgba(181, 101, 29, 0.3); border-radius: 8px;
      padding: 4px 8px; cursor: pointer; max-width: 55%;
    }
    .card[data-day="0"] .setting-select { color: #f0e3d4; background: rgba(0,0,0,0.3); border-color: rgba(201,123,53,0.35); }
    .setting-select:disabled { opacity: 0.45; cursor: default; }

    .toggle-btn {
      width: 44px; height: 26px; border-radius: 999px; border: none; cursor: pointer;
      padding: 0; position: relative; flex: 0 0 auto;
      background: rgba(120, 113, 108, 0.4); transition: background 0.25s;
    }
    .toggle-btn[data-on="1"] { background: #16a34a; }
    .toggle-btn:disabled { opacity: 0.45; cursor: default; }
    .toggle-btn .knob {
      position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
      border-radius: 50%; background: #fff; transition: transform 0.25s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .toggle-btn[data-on="1"] .knob { transform: translateX(18px); }

    .maint {
      margin-top: 10px; padding: 8px 12px; border-radius: 12px;
      font-size: 12px; font-weight: 700; text-align: center;
      color: #b45309; background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.35);
    }

    .foot {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 10px; font-size: 11px; font-weight: 600; color: #8a6a48;
    }
    .card[data-day="0"] .foot { color: #8a7a66; }
    .update-badge { color: #2563eb; }

    @media (prefers-reduced-motion: reduce) {
      .steam, .status-badge.brewing, .drink-btn[data-armed="1"], .fav-btn[data-armed="1"],
      .coffee-fill { animation: none !important; opacity: 1; }
    }
  `; }
}

customElements.define('delonghi-coffee-card', DelonghiCoffeeCard);
