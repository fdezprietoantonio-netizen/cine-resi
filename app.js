(() => {
  'use strict';

  // ===================================================================
  //  REGLAS (deben coincidir con las de supabase/schema.sql)
  // ===================================================================
  const RULES = {
    maxDailyMin: 300,      // 5 h por persona y día
    maxAdvanceDays: 7,     // reservar como mucho con 7 días de antelación
    minLenMin: 15,         // reserva mínima
    checkinBeforeMin: 10,  // se puede confirmar desde 10 min antes...
    checkinGraceMin: 15,   // ...hasta 15 min después del inicio; si no, se libera
  };

  const CFG = window.CINE_CONFIG || {};
  const ROOM = CFG.NOMBRE_SALA || 'Sala de cine';
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const MIN = 60000;
  const DAYS_SHOWN = RULES.maxAdvanceDays + 1;
  const PX_PER_MIN = 0.8;
  const ROOM_RE = /^[A-Z0-9ºª./ -]{1,10}$/;

  // ===================================================================
  //  Utilidades
  // ===================================================================
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => dayStart(a).getTime() === dayStart(b).getTime();
  const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const fmtDay = (d) => `${DOW[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
  const fmtDur = (min) => {
    min = Math.round(min);
    const h = Math.floor(min / 60), m = min % 60;
    return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
  };
  const fmtRange = (s, e) => sameDay(s, e) ? `${fmtDay(s)} · ${hm(s)}–${hm(e)}` : `${fmtDay(s)} ${hm(s)} → ${fmtDay(e)} ${hm(e)}`;
  const today = () => dayStart(new Date());
  const norm = (r) => ({ ...r, start: new Date(r.starts_at), end: new Date(r.ends_at) });
  const overlapMin = (aS, aE, bS, bE) => Math.max(0, Math.min(aE, bE) - Math.max(aS, bS)) / MIN;

  // Una reserva cuenta si no está cancelada y es un bloqueo, está confirmada
  // o aún está dentro del margen para confirmar.
  function isActive(r, now = new Date()) {
    return !r.cancelled_at && (r.is_block || !!r.checked_in_at || now.getTime() <= r.start.getTime() + RULES.checkinGraceMin * MIN);
  }

  function usedOnDay(list, uid, day) {
    const d0 = dayStart(day).getTime(), d1 = addDays(dayStart(day), 1).getTime();
    return list
      .filter((r) => r.user_id === uid && !r.is_block && isActive(r))
      .reduce((a, r) => a + overlapMin(r.start.getTime(), r.end.getTime(), d0, d1), 0);
  }

  // Misma validación que hace el servidor (aquí solo para avisar antes)
  function validate(list, uid, start, end, now = new Date()) {
    const len = (end - start) / MIN;
    if (!(end > start)) return 'La hora de fin tiene que ser posterior al inicio.';
    if (len < RULES.minLenMin) return `La reserva mínima es de ${fmtDur(RULES.minLenMin)}.`;
    if (len > RULES.maxDailyMin) return `Como máximo ${fmtDur(RULES.maxDailyMin)} por día.`;
    if (start.getTime() < now.getTime() - 5 * MIN) return 'No se puede reservar en el pasado.';
    if (start.getTime() > now.getTime() + RULES.maxAdvanceDays * 24 * 60 * MIN)
      return `Solo se puede reservar con ${RULES.maxAdvanceDays} días de antelación como máximo.`;
    const clash = list.find((r) => isActive(r, now) && r.start < end && r.end > start);
    if (clash) return `Se solapa con ${clash.is_block ? 'un bloqueo de la sala' : clash.user_id === uid ? 'otra reserva tuya' : 'la reserva de ' + clash.user_name} (${hm(clash.start)}–${hm(clash.end)}).`;
    for (let d = dayStart(start); d < end; d = addDays(d, 1)) {
      const used = usedOnDay(list, uid, d);
      const add = overlapMin(start.getTime(), end.getTime(), d.getTime(), addDays(d, 1).getTime());
      if (used + add > RULES.maxDailyMin)
        return `Superas el máximo de ${fmtDur(RULES.maxDailyMin)} el ${fmtDay(d)}: ya tienes ${fmtDur(used)} reservadas.`;
    }
    return null;
  }

  // ===================================================================
  //  Conexión con Supabase
  // ===================================================================
  function supabaseBackend() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
    const rpc = async (name, args) => ok(await sb.rpc(name, args));
    return {
      demo: false,
      async session() { return (await sb.auth.getSession()).data.session; },
      // setTimeout: no llamar a Supabase dentro del callback (bloquea la sesión; ver docs de supabase-js)
      onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => { setTimeout(() => cb(s), 0); }); },
      signIn() {
        return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
      },
      signOut() { return sb.auth.signOut(); },
      register: () => rpc('register_me'),
      async list(from, to) {
        const data = ok(await sb.from('reservations').select('*')
          .is('cancelled_at', null)
          .lt('starts_at', to.toISOString())
          .gt('ends_at', from.toISOString())
          .order('starts_at'));
        return data.map(norm);
      },
      create: (s, e) => rpc('create_reservation', { p_start: s.toISOString(), p_end: e.toISOString() }),
      cancel: (id) => rpc('cancel_reservation', { p_id: id }),
      checkin: (id) => rpc('check_in', { p_id: id }),
      block: (s, e, note) => rpc('create_block', { p_start: s.toISOString(), p_end: e.toISOString(), p_note: note }),
      async members() { return ok(await sb.from('members').select('*').order('created_at', { ascending: false })); },
      setStatus: (uid, status) => rpc('set_member_status', { p_user: uid, p_status: status }),
      setRoom: (room) => rpc('set_my_room', { p_room: room }),
      async audit() { return ok(await sb.from('audit_log').select('*').order('at', { ascending: false }).limit(150)); },
      subscribe(cb) {
        sb.channel('reservas')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () => cb())
          .subscribe();
      },
    };
  }

  // ===================================================================
  //  MODO DEMO: mismas reglas, datos solo en este navegador
  // ===================================================================
  function demoBackend() {
    const KEY = 'cine-demo-v3';
    const store = {
      get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
      set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
    };
    const seed = () => {
      const t = today();
      const at = (d, h, m = 0) => { const x = addDays(t, d); x.setHours(h, m, 0, 0); return x.toISOString(); };
      const now = new Date().toISOString();
      const res = (id, user_id, user_name, s, e, extra = {}) => ({ id, user_id, user_name, starts_at: s, ends_at: e, is_block: false, note: null, created_at: now, checked_in_at: null, cancelled_at: null, ...extra });
      return {
        current: null,
        nextId: 5,
        members: [
          { user_id: 'u-admin', name: 'Tú (administrador)', email: 'admin@ejemplo.com', status: 'approved', is_admin: true, room: '101', created_at: now },
          { user_id: 'u-lucia', name: 'Lucía', email: 'lucia@ejemplo.com', status: 'approved', room: '214', created_at: now },
          { user_id: 'u-marco', name: 'Marco', email: 'marco@ejemplo.com', status: 'approved', room: 'B-12', created_at: now },
          { user_id: 'u-sara', name: 'Sara (nueva)', email: 'sara@ejemplo.com', status: 'approved', room: null, created_at: now },
        ],
        reservations: [
          res(1, 'u-lucia', 'Lucía', at(0, 21), at(0, 23, 30)),
          res(2, 'u-marco', 'Marco', at(1, 17), at(1, 19, 30)),
          res(3, 'u-lucia', 'Lucía', at(2, 22), at(3, 1)),
          res(4, 'u-admin', 'Administración', at(4, 18), at(4, 22), { is_block: true, note: 'Cinefórum de la resi' }),
        ],
        audit: [],
      };
    };
    let db = store.get() || seed();
    const subs = [];
    const save = () => { store.set(db); subs.forEach((f) => f()); };
    const me = () => db.members.find((m) => m.user_id === db.current);
    const isAdmin = () => !!me()?.is_admin;
    const approved = () => !!me() && (me().status === 'approved' || isAdmin());
    const all = () => db.reservations.map(norm);
    const fail = (m) => { throw new Error(m); };
    const log = (action, r, extra = {}) => db.audit.unshift({
      id: Date.now() + Math.random(), at: new Date().toISOString(), actor_name: me()?.name, action,
      reservation_id: r?.id ?? null,
      details: r ? { quien: r.user_name, inicio: r.starts_at, fin: r.ends_at, nota: r.note, ...extra } : extra,
    });
    let authCb = null;
    window.addEventListener('storage', (e) => { if (e.key === KEY) { db = store.get() || seed(); subs.forEach((f) => f()); } });

    return {
      demo: true,
      users: () => db.members,
      reset() { try { localStorage.removeItem(KEY); } catch { /* nada */ } location.reload(); },
      async session() { return db.current ? { user: { id: db.current } } : null; },
      onAuth(cb) { authCb = cb; },
      async signIn(uid) { db.current = uid; store.set(db); authCb?.({ user: { id: uid } }); },
      async signOut() { db.current = null; store.set(db); authCb?.(null); },
      async register() { const m = me(); return { status: m.is_admin ? 'approved' : m.status, is_admin: !!m.is_admin, name: m.name, room: m.room || null }; },
      async setRoom(room) {
        const v = String(room || '').trim().toUpperCase();
        if (!ROOM_RE.test(v)) fail('Escribe un número de habitación válido (por ejemplo 214 o B-12).');
        me().room = v;
        log('pone habitación', null, { hab: v }); save();
      },
      async list(from, to) {
        if (!approved()) fail('Tu cuenta todavía no está aprobada.');
        return all().filter((r) => !r.cancelled_at && r.start < to && r.end > from).sort((a, b) => a.start - b.start);
      },
      async create(s, e) {
        if (!approved()) fail('Tu cuenta todavía no está aprobada.');
        if (!me().room) fail('Pon tu número de habitación antes de reservar.');
        s = new Date(Math.floor(s / MIN) * MIN); e = new Date(Math.floor(e / MIN) * MIN);
        const err = validate(all(), db.current, s, e);
        if (err) fail(err);
        const r = { id: db.nextId++, user_id: db.current, user_name: me().name, starts_at: s.toISOString(), ends_at: e.toISOString(), is_block: false, note: null, created_at: new Date().toISOString(), checked_in_at: null, cancelled_at: null };
        db.reservations.push(r); log('reserva', r, { hab: me().room }); save();
      },
      async cancel(id) {
        const r = db.reservations.find((x) => x.id === id);
        if (!r) fail('Esa reserva no existe.');
        if (r.cancelled_at) fail('Esa reserva ya estaba cancelada.');
        if (r.user_id !== db.current && !isAdmin()) fail('Solo puedes cancelar tus propias reservas.');
        if (new Date(r.ends_at) <= new Date() && !isAdmin()) fail('Esa reserva ya ha terminado.');
        r.cancelled_at = new Date().toISOString();
        log(r.is_block ? 'quita bloqueo' : 'cancela', r); save();
      },
      async checkin(id) {
        const r = db.reservations.find((x) => x.id === id);
        if (!r) fail('Esa reserva no existe.');
        if (r.user_id !== db.current) fail('Solo puedes confirmar tus propias reservas.');
        if (r.cancelled_at) fail('Esa reserva está cancelada.');
        if (r.checked_in_at) return;
        const s = new Date(r.starts_at).getTime(), now = Date.now();
        if (now < s - RULES.checkinBeforeMin * MIN) fail(`Aún es pronto: podrás confirmar a partir de las ${hm(new Date(s - RULES.checkinBeforeMin * MIN))}.`);
        if (now > s + RULES.checkinGraceMin * MIN) fail('Se pasó el tiempo para confirmar y la sala quedó libre.');
        r.checked_in_at = new Date().toISOString();
        log('confirma llegada', r); save();
      },
      async block(s, e, note) {
        if (!isAdmin()) fail('Solo el administrador puede bloquear la sala.');
        if (!(e > s)) fail('La hora de fin tiene que ser posterior al inicio.');
        const now = new Date();
        db.reservations.forEach((r) => {
          const n = norm(r);
          if (isActive(n, now) && n.start < e && n.end > s) { r.cancelled_at = now.toISOString(); log('cancela (por bloqueo)', r); }
        });
        const r = { id: db.nextId++, user_id: db.current, user_name: 'Administración', starts_at: s.toISOString(), ends_at: e.toISOString(), is_block: true, note: note || null, created_at: now.toISOString(), checked_in_at: null, cancelled_at: null };
        db.reservations.push(r); log('bloquea', r); save();
      },
      async members() { if (!isAdmin()) fail('Sin permiso.'); return db.members; },
      async setStatus(uid, status) {
        if (!isAdmin()) fail('Sin permiso.');
        const m = db.members.find((x) => x.user_id === uid);
        m.status = status;
        log({ approved: 'aprueba a', blocked: 'quita acceso a', pending: 'deja pendiente a' }[status], null, { quien: m.name });
        save();
      },
      async audit() { if (!isAdmin()) fail('Sin permiso.'); return db.audit.slice(0, 150); },
      subscribe(cb) { subs.push(cb); },
    };
  }

  // ===================================================================
  //  Aplicación
  // ===================================================================
  const api = DEMO ? demoBackend() : supabaseBackend();
  const app = $('#app');
  const state = {
    uid: null,
    profile: null,
    dayIdx: 0,
    list: [],
    tab: 'sala',
    members: [],
    audit: [],
    scrolledDay: null,
  };

  // Instalable como app (el móvil ofrece "Instalar" / "Añadir a pantalla de inicio")
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  let toastTimer;
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
  }

  async function run(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await reload();
    } catch (e) {
      toast(e.message || String(e), 'error');
    }
  }

  // ----- Sesión -----
  let lastUid;
  async function handleSession(s) {
    const uid = s?.user?.id || null;
    if (uid === lastUid) return;
    lastUid = uid;
    state.uid = uid;
    state.profile = null;
    if (!uid) return renderLogin();
    await checkProfile();
  }

  async function checkProfile() {
    try {
      state.profile = await api.register();
    } catch (e) {
      app.innerHTML = `<div class="center"><div class="logo">⚠️</div><h1>No se pudo entrar</h1><p>${esc(e.message)}</p><button class="btn" data-action="logout">Salir</button></div>`;
      return;
    }
    if (state.profile.status !== 'approved') return renderPending();
    if (!state.profile.room) return renderRoom(false);
    renderShell();
    await reload();
  }

  // ----- Número de habitación -----
  function renderRoom(editing) {
    app.innerHTML = `${demoBanner()}
      <div class="center">
        <div class="logo">🚪</div>
        <h1>${editing ? 'Cambiar habitación' : `Hola, ${esc(state.profile.name)}`}</h1>
        <p>${editing ? 'Escribe tu número de habitación.' : 'Antes de reservar, dinos tu número de habitación. Solo lo verá el administrador.'}</p>
        <form class="form" id="f-room" autocomplete="off" style="text-align:left">
          <label>Número de habitación<input id="room-input" maxlength="10" required placeholder="Por ejemplo 214" value="${esc(state.profile.room || '')}" autocapitalize="characters" inputmode="text"></label>
          <p class="hint bad" id="room-hint"></p>
          <button class="btn primary" type="submit">Guardar</button>
          ${editing ? '<button class="btn" type="button" data-action="room-cancel">Cancelar</button>' : '<button class="btn ghost" type="button" data-action="logout">Salir</button>'}
        </form>
      </div>`;
    const input = $('#room-input');
    input.focus();
    $('#f-room').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = input.value.trim().toUpperCase();
      if (!ROOM_RE.test(v)) { $('#room-hint').textContent = 'Escribe un número de habitación válido (por ejemplo 214 o B-12).'; return; }
      try {
        await api.setRoom(v);
        toast(`Habitación ${v} guardada`);
        await checkProfile();
      } catch (e) {
        $('#room-hint').textContent = e.message;
      }
    });
  }

  async function reload() {
    if (state.profile?.status !== 'approved') return;
    const from = addDays(today(), -1), to = addDays(today(), DAYS_SHOWN + 1);
    try {
      state.list = await api.list(from, to);
      if (state.profile.is_admin) {
        [state.members, state.audit] = await Promise.all([api.members(), api.audit()]);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
    renderDynamic();
  }

  // ----- Pantallas sin acceso -----
  function demoBanner() {
    return DEMO ? `<div class="demo-banner"><span><b>Modo demostración.</b> Los datos solo se guardan en este navegador. Rellena <code>config.js</code> para usar la versión real.</span><button class="btn small ghost" data-action="demo-reset">Reiniciar demo</button></div>` : '';
  }

  function renderLogin() {
    const loginButtons = DEMO
      ? `<div class="demo-users">${api.users().map((u) =>
          `<button class="btn" data-action="demo-login" data-uid="${esc(u.user_id)}">Entrar como ${esc(u.name)}</button>`).join('')}</div>`
      : `<button class="btn primary big" data-action="login">Entrar con Google</button>`;
    app.innerHTML = `${demoBanner()}
      <div class="center">
        <div class="logo">🎬</div>
        <h1>${esc(ROOM)}</h1>
        <p>Entra con tu cuenta de Google y reserva la sala.</p>
        ${loginButtons}
        <p><a href="privacidad.html" style="color:var(--muted);font-size:.85rem">Privacidad</a></p>
      </div>`;
  }

  function renderPending() {
    const blocked = state.profile.status === 'blocked';
    app.innerHTML = `${demoBanner()}
      <div class="center">
        <div class="logo">${blocked ? '🚫' : '⏳'}</div>
        <h1>${blocked ? 'Sin acceso' : 'Pendiente de aprobación'}</h1>
        <p>${blocked
          ? 'El administrador ha quitado el acceso a esta cuenta. Si crees que es un error, habla con él.'
          : `Hola, ${esc(state.profile.name)}. Tu cuenta está registrada, pero el administrador tiene que aprobarla antes de que puedas reservar.`}</p>
        <div style="display:flex;gap:8px;justify-content:center">
          ${blocked ? '' : '<button class="btn primary" data-action="recheck">Comprobar de nuevo</button>'}
          <button class="btn" data-action="logout">Salir</button>
        </div>
      </div>`;
  }

  // ----- Pantalla principal -----
  function nextHalfHour() {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    return d;
  }

  function renderShell() {
    const p = state.profile;
    const dayOptions = Array.from({ length: DAYS_SHOWN }, (_, i) => {
      const d = addDays(today(), i);
      return `<option value="${i}">${i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : ''} ${fmtDay(d)}</option>`;
    }).join('');
    app.innerHTML = `
      <header class="top">
        <div class="brand"><span class="logo">🎬</span><span>${esc(ROOM)}</span></div>
        <div class="who"><span>${esc(p.name)}${p.is_admin ? ' · administrador' : ''}</span><button class="btn small ghost" data-action="room" title="Cambiar habitación">Hab. ${esc(p.room)}</button><button class="btn small" data-action="logout">Salir</button></div>
      </header>
      ${demoBanner()}
      ${p.is_admin ? `<nav class="tabs" role="tablist">
        <button class="tab" role="tab" data-action="tab" data-tab="sala">Reservas</button>
        <button class="tab" role="tab" data-action="tab" data-tab="admin">Administración</button>
      </nav>` : ''}

      <section id="view-sala">
        <div id="alert"></div>
        <div class="grid">
          <div class="card">
            <div class="days" id="days" role="tablist"></div>
            <div class="legend">
              <span><i style="background:var(--mine)"></i>Tuyas</span>
              <span><i style="background:var(--other)"></i>De otros</span>
              <span><i style="background:var(--block)"></i>Bloqueos</span>
              <span>Borde punteado: falta confirmar llegada</span>
            </div>
            <div class="timeline-wrap" id="timeline-wrap"><div class="timeline" id="timeline" title="Haz clic en un hueco libre para reservarlo"></div></div>
          </div>
          <div class="stack">
            <div class="card">
              <h2>Nueva reserva</h2>
              <p class="quota" id="quota"></p>
              <form class="form" id="f-res" autocomplete="off">
                <label>Día<select id="f-day">${dayOptions}</select></label>
                <div class="row">
                  <label>Desde<input type="time" id="f-start" step="300" required></label>
                  <label>Hasta<input type="time" id="f-end" step="300" required></label>
                </div>
                <p class="hint" id="f-hint"></p>
                <button class="btn primary" type="submit" id="f-submit">Reservar</button>
              </form>
            </div>
            <div class="card"><h2>Mis reservas</h2><div id="mine"></div></div>
            <div class="card"><h2>Próximas reservas</h2><div id="upcoming"></div></div>
            <div class="card rules">
              <h2>Normas</h2>
              <ul>
                <li>Máximo <b>${fmtDur(RULES.maxDailyMin)} al día</b> por persona.</li>
                <li>Se reserva con <b>${RULES.maxAdvanceDays} días</b> de antelación como máximo.</li>
                <li>Al llegar, pulsa <b>«Estoy aquí»</b> (desde ${RULES.checkinBeforeMin} min antes). Si a los <b>${RULES.checkinGraceMin} min</b> del inicio nadie ha confirmado, la sala queda libre.</li>
                <li>Solo puedes cancelar tus reservas. Cancela si no vas a ir.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      ${p.is_admin ? `<section id="view-admin" hidden>
        <div class="admin-grid">
          <div class="stack">
            <div class="card"><h2>Residentes</h2><p class="empty" style="margin-bottom:10px">Cualquiera puede entrar con Google y reservar. Aquí puedes quitar el acceso a quien no deba usar la sala.</p><div id="a-members"></div></div>
          </div>
          <div class="stack">
            <div class="card">
              <h2>Bloquear la sala</h2>
              <form class="form" id="f-block" autocomplete="off">
                <label>Día<input type="date" id="b-day" required></label>
                <div class="row">
                  <label>Desde<input type="time" id="b-start" step="300" required></label>
                  <label>Hasta<input type="time" id="b-end" step="300" required></label>
                </div>
                <label>Motivo<input type="text" id="b-note" maxlength="80" placeholder="Cinefórum, limpieza, reparación…"></label>
                <button class="btn primary" type="submit">Bloquear</button>
                <p class="empty">Las reservas que se solapen se cancelarán. Para quitar un bloqueo, haz clic en él en el calendario.</p>
              </form>
            </div>
            <div class="card"><h2>Historial</h2><ul class="list log" id="a-log"></ul></div>
          </div>
        </div>
      </section>` : ''}`;

    // Valores iniciales del formulario
    const s = nextHalfHour();
    $('#f-day').value = String(Math.round((dayStart(s) - today()) / 864e5));
    $('#f-start').value = hm(s);
    $('#f-end').value = hm(new Date(s.getTime() + 120 * MIN));
    $('#f-res').addEventListener('input', updateHint);
    $('#f-res').addEventListener('submit', onReserve);
    if (p.is_admin) {
      const bd = new Date();
      $('#b-day').value = `${bd.getFullYear()}-${pad(bd.getMonth() + 1)}-${pad(bd.getDate())}`;
      $('#b-start').value = '18:00';
      $('#b-end').value = '22:00';
      $('#f-block').addEventListener('submit', onBlock);
    }
    $('#timeline').addEventListener('click', onTimelineClick);
    state.scrolledDay = null;
    setTab(state.tab);
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    $('#view-sala').hidden = tab !== 'sala';
    if ($('#view-admin')) $('#view-admin').hidden = tab !== 'admin';
  }

  function formRange() {
    const day = addDays(today(), Number($('#f-day').value));
    const [sh, sm] = ($('#f-start').value || '').split(':').map(Number);
    const [eh, em] = ($('#f-end').value || '').split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
    const start = new Date(day); start.setHours(sh, sm, 0, 0);
    let end = new Date(day); end.setHours(eh, em, 0, 0);
    if (end <= start) end = addDays(end, 1); // termina al día siguiente
    return { start, end };
  }

  function updateHint() {
    const hint = $('#f-hint');
    const r = formRange();
    if (!r) { hint.textContent = ''; return; }
    const err = validate(state.list, state.uid, r.start, r.end);
    const len = (r.end - r.start) / MIN;
    if (err) {
      hint.className = 'hint bad';
      hint.textContent = err;
    } else {
      hint.className = 'hint good';
      hint.textContent = `${fmtDur(len)} · ${fmtRange(r.start, r.end)}`;
    }
    $('#f-submit').disabled = !!err;
    // cupo del día elegido
    const day = addDays(today(), Number($('#f-day').value));
    const used = usedOnDay(state.list, state.uid, day);
    const pct = Math.min(100, (used / RULES.maxDailyMin) * 100);
    $('#quota').innerHTML = `El ${fmtDay(day)} llevas <b>${fmtDur(used)}</b> de ${fmtDur(RULES.maxDailyMin)}.<div class="quota-bar"><div style="width:${pct}%"></div></div>`;
  }

  async function onReserve(ev) {
    ev.preventDefault();
    const r = formRange();
    if (!r) return;
    const btn = $('#f-submit');
    btn.disabled = true;
    await run(() => api.create(r.start, r.end), `Reservado: ${fmtRange(r.start, r.end)}`);
    btn.disabled = false;
    updateHint();
  }

  async function onBlock(ev) {
    ev.preventDefault();
    const [y, mo, d] = $('#b-day').value.split('-').map(Number);
    const [sh, sm] = $('#b-start').value.split(':').map(Number);
    const [eh, em] = $('#b-end').value.split(':').map(Number);
    const start = new Date(y, mo - 1, d, sh, sm);
    let end = new Date(y, mo - 1, d, eh, em);
    if (end <= start) end = addDays(end, 1);
    const note = $('#b-note').value.trim();
    const clashes = state.list.filter((r) => isActive(r) && r.start < end && r.end > start);
    const msg = `¿Bloquear la sala el ${fmtRange(start, end)}?` +
      (clashes.length ? `\n\nSe cancelarán ${clashes.length} reserva(s):\n` + clashes.map((c) => `· ${c.user_name} ${hm(c.start)}–${hm(c.end)}`).join('\n') : '');
    if (!confirm(msg)) return;
    await run(() => api.block(start, end, note), 'Sala bloqueada');
    $('#b-note').value = '';
  }

  function onTimelineClick(ev) {
    const slot = ev.target.closest('.slot');
    if (slot) {
      const r = state.list.find((x) => String(x.id) === slot.dataset.id);
      if (!r) return;
      const mine = r.user_id === state.uid && !r.is_block;
      if (!mine && !state.profile.is_admin) return;
      const what = r.is_block ? `el bloqueo «${r.note || 'sin motivo'}»` : mine ? 'tu reserva' : `la reserva de ${r.user_name}`;
      if (confirm(`¿Cancelar ${what} (${fmtRange(r.start, r.end)})?`)) run(() => api.cancel(r.id), 'Cancelada');
      return;
    }
    // Hueco libre: rellenar el formulario
    const tl = $('#timeline');
    const y = ev.clientY - tl.getBoundingClientRect().top;
    let min = Math.floor(y / PX_PER_MIN / 30) * 30;
    const day = addDays(today(), state.dayIdx);
    let start = new Date(day.getTime() + min * MIN);
    if (state.dayIdx === 0 && start < new Date()) start = nextHalfHour();
    $('#f-day').value = String(state.dayIdx);
    $('#f-start').value = hm(start);
    $('#f-end').value = hm(new Date(start.getTime() + 120 * MIN));
    updateHint();
    $('#f-start').focus();
  }

  // Partes que cambian con el tiempo o con los datos
  function renderDynamic() {
    if (!$('#view-sala')) return;
    renderDays();
    renderTimeline();
    renderMine();
    renderUpcoming();
    updateHint();
    if (state.profile.is_admin) renderAdmin();
  }

  // Reservas activas que tocan un día (índice 0 = hoy)
  function onDay(i, now = new Date()) {
    const d0 = addDays(today(), i).getTime(), d1 = addDays(today(), i + 1).getTime();
    return state.list
      .filter((r) => isActive(r, now) && r.start.getTime() < d1 && r.end.getTime() > d0)
      .sort((a, b) => a.start - b.start);
  }

  function renderDays() {
    $('#days').innerHTML = Array.from({ length: DAYS_SHOWN }, (_, i) => {
      const d = addDays(today(), i);
      const label = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : DOW[d.getDay()];
      const n = onDay(i).length;
      return `<button class="day" role="tab" aria-selected="${i === state.dayIdx}" data-action="day" data-idx="${i}">${label}${n ? `<span class="count-dot" title="${n} reserva${n > 1 ? 's' : ''}">${n}</span>` : ''}<small>${d.getDate()}/${d.getMonth() + 1}</small></button>`;
    }).join('');
  }

  function renderUpcoming() {
    const now = new Date();
    const list = state.list
      .filter((r) => isActive(r, now) && r.end > now)
      .sort((a, b) => a.start - b.start)
      .slice(0, 8);
    if (!list.length) { $('#upcoming').innerHTML = '<p class="empty">No hay reservas próximas. La sala está libre.</p>'; return; }
    $('#upcoming').innerHTML = `<ul class="list">${list.map((r) => {
      const idx = Math.round((dayStart(r.start) - today()) / 864e5);
      const dayName = idx <= 0 ? 'Hoy' : idx === 1 ? 'Mañana' : fmtDay(r.start);
      const mine = r.user_id === state.uid && !r.is_block;
      const room = state.profile.is_admin && !r.is_block ? roomOf(r.user_id) : '';
      const who = r.is_block ? `Bloqueada: ${r.note || 'sin motivo'}` : mine ? 'Tú' : r.user_name + (room ? ` · hab. ${room}` : '');
      const nowOn = r.start <= now ? ' <span class="badge ok">Ahora</span>' : '';
      return `<li class="item clickable-item" data-action="goto" data-idx="${Math.max(0, idx)}" role="button" tabindex="0">
        <span class="when">${esc(dayName)} · ${hm(r.start)}–${hm(r.end)}${nowOn}</span>
        <span class="meta">${esc(who)}</span></li>`;
    }).join('')}</ul>`;
  }

  function renderTimeline() {
    const tl = $('#timeline');
    const day = addDays(today(), state.dayIdx);
    const d0 = day.getTime(), d1 = addDays(day, 1).getTime();
    const dayMin = (d1 - d0) / MIN; // 1440 (o 1380/1500 en cambio de hora)
    const now = new Date();
    let html = '';
    for (let h = 0; h < 24; h++) {
      const t = new Date(day); t.setHours(h, 0, 0, 0);
      const top = ((t - d0) / MIN) * PX_PER_MIN;
      html += `<div class="hour" style="top:${top}px"><span>${pad(h)}:00</span></div><div class="half" style="top:${top + 30 * PX_PER_MIN}px"></div>`;
    }
    if (now.getTime() > d0) {
      const pastH = Math.min(dayMin, (now - d0) / MIN) * PX_PER_MIN;
      html += `<div class="past" style="height:${pastH}px"></div>`;
    }
    if (now.getTime() >= d0 && now.getTime() < d1) html += `<div class="now-line" style="top:${((now - d0) / MIN) * PX_PER_MIN}px"></div>`;

    state.list.filter((r) => isActive(r, now) && r.start.getTime() < d1 && r.end.getTime() > d0).forEach((r) => {
      const s = Math.max(r.start.getTime(), d0), e = Math.min(r.end.getTime(), d1);
      const top = ((s - d0) / MIN) * PX_PER_MIN;
      const height = Math.max(18, ((e - s) / MIN) * PX_PER_MIN - 2);
      const mine = r.user_id === state.uid && !r.is_block;
      const cls = r.is_block ? 'block' : mine ? 'mine' : 'other';
      const pending = !r.is_block && !r.checked_in_at && now >= r.start;
      const clickable = mine || state.profile.is_admin;
      const room = state.profile.is_admin && !r.is_block ? roomOf(r.user_id) : '';
      const title = (r.is_block ? `🔒 ${r.note || 'Sala bloqueada'}` : mine ? `Tú` : r.user_name) + (room && !mine ? ` · hab. ${room}` : '');
      html += `<div class="slot ${cls}${pending ? ' pending' : ''}${clickable ? ' clickable' : ''}" data-id="${esc(r.id)}" style="top:${top}px;height:${height}px"
        title="${esc(title)} · ${esc(fmtRange(r.start, r.end))}${clickable ? ' · clic para cancelar' : ''}">
        <b>${esc(title)}</b><span>${hm(r.start)}–${hm(r.end)}${r.checked_in_at ? ' · ✔ en la sala' : pending ? ' · sin confirmar' : ''}</span></div>`;
    });
    tl.style.height = `${dayMin * PX_PER_MIN}px`;
    tl.innerHTML = html;

    if (state.scrolledDay !== state.dayIdx) {
      state.scrolledDay = state.dayIdx;
      // Abrir en la primera reserva del día; si no hay, en "ahora" (hoy) o a las 16:00
      const first = onDay(state.dayIdx, now).find((r) => r.end > now);
      let focusMin;
      if (first) focusMin = Math.max(0, (Math.max(first.start.getTime(), d0, now.getTime() - 60 * MIN) - d0) / MIN - 30);
      else focusMin = state.dayIdx === 0 ? Math.max(0, (now - d0) / MIN - 60) : 16 * 60;
      $('#timeline-wrap').scrollTop = focusMin * PX_PER_MIN;
    }
  }

  function roomOf(uid) {
    return state.members.find((m) => m.user_id === uid)?.room || '';
  }

  function checkinWindow(r) {
    return {
      from: new Date(r.start.getTime() - RULES.checkinBeforeMin * MIN),
      to: new Date(r.start.getTime() + RULES.checkinGraceMin * MIN),
    };
  }

  function renderMine() {
    const now = new Date();
    const mine = state.list
      .filter((r) => r.user_id === state.uid && !r.is_block && isActive(r, now) && r.end > now)
      .sort((a, b) => a.start - b.start);

    // Aviso grande si toca confirmar
    const due = mine.find((r) => { const w = checkinWindow(r); return !r.checked_in_at && now >= w.from && now <= w.to; });
    $('#alert').innerHTML = due
      ? `<div class="alert"><span><strong>¿Ya estás en la sala?</strong> Confirma tu reserva de ${hm(due.start)}–${hm(due.end)} antes de las ${hm(checkinWindow(due).to)} o se liberará.</span>
         <button class="btn ok" data-action="checkin" data-id="${esc(due.id)}">Estoy aquí</button></div>`
      : '';

    if (!mine.length) { $('#mine').innerHTML = '<p class="empty">No tienes reservas próximas.</p>'; return; }
    $('#mine').innerHTML = `<ul class="list">${mine.map((r) => {
      const w = checkinWindow(r);
      let status, btn = '';
      if (r.checked_in_at) status = '<span class="badge ok">✔ Llegada confirmada</span>';
      else if (now < w.from) status = `<span class="meta">Confirma tu llegada entre las ${hm(w.from)} y las ${hm(w.to)}</span>`;
      else { status = `<span class="badge wait">Confirma antes de las ${hm(w.to)}</span>`; btn = `<button class="btn ok small" data-action="checkin" data-id="${esc(r.id)}">Estoy aquí</button>`; }
      return `<li class="item">
        <span class="when">${esc(fmtRange(r.start, r.end))}</span>
        ${status}
        <div class="actions">${btn}<button class="btn small" data-action="cancel" data-id="${esc(r.id)}">Cancelar</button></div>
      </li>`;
    }).join('')}</ul>`;
  }

  function renderAdmin() {
    const others = state.members.filter((m) => m.user_id !== state.uid);

    $('#a-members').innerHTML = others.length
      ? `<ul class="list">${others.map((m) => `<li class="item">
          <span class="when">${esc(m.name)} · ${m.room ? `hab. ${esc(m.room)}` : '<span class="badge wait">Sin habitación</span>'} ${m.status === 'blocked' ? '<span class="badge no">Sin acceso</span>' : '<span class="badge ok">Con acceso</span>'}</span>
          <span class="meta">${esc(m.email)}</span>
          <div class="actions">${m.status !== 'blocked'
            ? `<button class="btn small" data-action="status" data-uid="${esc(m.user_id)}" data-status="blocked">Quitar acceso</button>`
            : `<button class="btn small" data-action="status" data-uid="${esc(m.user_id)}" data-status="approved">Dar acceso</button>`}</div>
        </li>`).join('')}</ul>`
      : '<p class="empty">Todavía no ha entrado nadie más.</p>';

    const fmtWhen = (iso) => { const d = new Date(iso); return `${fmtDay(d)} ${hm(d)}`; };
    $('#a-log').innerHTML = state.audit.length
      ? state.audit.map((a) => {
          const d = a.details || {};
          const range = d.inicio && d.fin ? ` · ${fmtRange(new Date(d.inicio), new Date(d.fin))}` : '';
          const who = d.quien && d.quien !== a.actor_name && d.quien !== 'Administración' ? ` ${esc(d.quien)}` : '';
          const note = d.nota ? ` · «${esc(d.nota)}»` : '';
          const hab = d.hab ? ` · hab. ${esc(d.hab)}` : '';
          return `<li><time>${esc(fmtWhen(a.at))}</time><b>${esc(a.actor_name || '?')}</b> ${esc(a.action)}${who}${esc(range)}${hab}${note}</li>`;
        }).join('')
      : '<li class="empty">Sin actividad todavía.</li>';
  }

  // ----- Clics -----
  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const id = el.dataset.id ? Number(el.dataset.id) : null;
    if (a === 'login') api.signIn().catch((e) => toast(e.message, 'error'));
    else if (a === 'demo-login') api.signIn(el.dataset.uid);
    else if (a === 'demo-reset') api.reset();
    else if (a === 'logout') api.signOut();
    else if (a === 'recheck') checkProfile();
    else if (a === 'room') renderRoom(true);
    else if (a === 'room-cancel') checkProfile();
    else if (a === 'tab') { setTab(el.dataset.tab); if (el.dataset.tab === 'admin') reload(); }
    else if (a === 'day' || a === 'goto') {
      state.dayIdx = Number(el.dataset.idx);
      state.scrolledDay = null;
      if (a === 'goto') $('#timeline-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#f-day').value = String(state.dayIdx);
      renderDays(); renderTimeline(); updateHint();
    }
    else if (a === 'checkin') run(() => api.checkin(id), '¡Disfruta de la peli! 🍿');
    else if (a === 'cancel') {
      const r = state.list.find((x) => x.id === id);
      if (r && confirm(`¿Cancelar tu reserva del ${fmtRange(r.start, r.end)}?`)) run(() => api.cancel(id), 'Reserva cancelada');
    }
    else if (a === 'status') run(() => api.setStatus(el.dataset.uid, el.dataset.status), 'Hecho');
  });

  // ----- Arranque -----
  async function boot() {
    api.onAuth((s) => handleSession(s));
    api.subscribe(() => reload());
    await handleSession(await api.session());
    // El tiempo avanza: refresca la vista cada 30 s y los datos cada 2 min
    setInterval(() => {
      if (state.profile?.status !== 'approved') return;
      // si ha cambiado el día, vuelve a montar la pantalla
      if ($('#f-day') && $('#f-day option')?.textContent.indexOf(fmtDay(today())) === -1) { renderShell(); reload(); return; }
      renderDynamic();
    }, 30000);
    setInterval(() => reload(), 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
  }

  if (!DEMO && !window.supabase) {
    app.innerHTML = '<div class="center"><div class="logo">⚠️</div><h1>Sin conexión</h1><p>No se pudo cargar la librería de Supabase. Comprueba tu conexión a internet.</p></div>';
  } else {
    boot();
  }
})();
