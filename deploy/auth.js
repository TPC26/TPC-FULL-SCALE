/* ============================================================
   TRIBAL PUNK CUSTOMS — Members + Requests, on Supabase
   ------------------------------------------------------------
   Real accounts (work across every device) + a real leads
   database the owner reviews in the on-site inbox.

   • Members  → Supabase Auth (auth.users) + public.profiles
   • Leads    → public.requests  (signup / build / enquiry / callback)
   • Owner    → any email listed in public.admins (RLS-enforced)

   "MISS ZERO" RESILIENCE: if a submit can't reach Supabase
   (flaky network), the lead is queued in localStorage and
   retried automatically — so a request is never lost.

   Requires the Supabase JS SDK loaded BEFORE this file:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
   ============================================================ */
(function () {
  'use strict';

  // ── CONFIG ─────────────────────────────────────────────
  const SUPABASE_URL = 'https://fpyqmpnaqoczsaqcsmny.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZweXFtcG5hcW9jenNhcWNzbW55Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MzUwMDAsImV4cCI6MjA5NjQxMTAwMH0.wLH9XWuxWQhxtwg0-Ng7OhRCr8JrEUAMICZXjPHrNQw';

  // The owner sees the Requests Inbox. Must also be a row in public.admins.
  const OWNER_EMAILS = ['wishwas@rawexpeditions.com'];

  // OPTIONAL — instant email alerts on every new lead.
  // Get a free key at web3forms.com (uses the address you verify there).
  // Leave '' to skip; leads still land in Supabase regardless.
  const WEB3FORMS_KEY = '5adebfd2-fa8e-41d5-a47c-a3519a022c27';

  // OPTIONAL — mirror every new lead into a Google Sheet.
  // 1. Make a Sheet → Extensions → Apps Script, paste the doPost() code from
  //    GOOGLE-SHEET-SETUP.md, Deploy → New deployment → Web app
  //    (Execute as: Me, Who has access: Anyone), copy the /exec URL.
  // 2. Paste that URL between the quotes below. Leave '' to skip.
  //    Leads still land in Supabase + email regardless.
  const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyXEZ_YgHbd0XkUOHINdnNsknIhfgYygCwMGYY43NyINNUJFeToz5c04RXtiuMnn794Jw/exec';

  // ── CLIENT ─────────────────────────────────────────────
  if (!window.supabase || !window.supabase.createClient) {
    console.error('[TPC] Supabase SDK not loaded before auth.js');
    return;
  }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ── LOCAL HELPERS ──────────────────────────────────────
  const getLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const setLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const isOwnerEmail = e => OWNER_EMAILS.map(x => x.toLowerCase()).includes((e || '').toLowerCase());

  // session cache (kept current by onAuthStateChange so the rest
  // of the UI can stay synchronous)
  let _user = null;
  let _newCount = 0;

  function mapUser(session) {
    if (!session || !session.user) return null;
    const u = session.user;
    const md = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email,
      name: md.name || u.email,
      phone: md.phone || '',
      role: isOwnerEmail(u.email) ? 'owner' : 'member'
    };
  }

  function currentUser() { return _user; }
  const isLoggedIn = () => !!_user;
  const isOwner = () => !!_user && _user.role === 'owner';

  // ── AUTH ───────────────────────────────────────────────
  async function signup({ name, email, phone, pass }) {
    email = (email || '').trim().toLowerCase();
    const { data, error } = await sb.auth.signUp({
      email, password: pass,
      options: { data: { name: (name || '').trim(), phone: (phone || '').trim() } }
    });
    if (error) return { ok: false, err: friendly(error.message) };
    // record the signup as a lead (+ email alert), even if confirmation pending
    saveRequest('signup', { name: (name || '').trim(), email, phone: (phone || '').trim() });
    if (!data.session) return { ok: true, pending: true, user: null };
    _user = mapUser(data.session);
    return { ok: true, user: _user };
  }

  async function login({ email, pass }) {
    email = (email || '').trim().toLowerCase();
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) return { ok: false, err: 'Wrong email or password.' };
    _user = mapUser(data.session);
    return { ok: true, user: _user };
  }

  async function logout() {
    await sb.auth.signOut();
    _user = null; _newCount = 0;
    renderNav();
    if (window.showPage) window.showPage('home');
  }

  function friendly(msg) {
    msg = msg || '';
    if (/already registered|already exists/i.test(msg)) return 'An account with that email already exists. Try signing in.';
    if (/password/i.test(msg) && /6/.test(msg)) return 'Password must be at least 6 characters.';
    return msg;
  }

  // ── REQUESTS (write) ───────────────────────────────────
  function rowFrom(type, data) {
    const clean = v => (v && String(v).trim() && v !== '—') ? v : null;
    return {
      type, status: 'New',
      name: clean(data.name),
      email: clean(data.email) || (_user ? _user.email : null),
      phone: clean(data.phone),
      vehicle: clean(data.vehicle),
      message: clean(data.message) || clean(data.goal),
      data: data,
      user_id: _user ? _user.id : null
    };
  }

  async function saveRequest(type, data) {
    const row = rowFrom(type, data);
    if (window.tpcTrack) tpcTrack(type === 'signup' ? 'sign_up' : 'generate_lead', { lead_type: type, vehicle: (data && (data.vehicle || data.model)) || undefined, city: (data && data.city) || undefined });
    try {
      const { error } = await sb.from('requests').insert(row);
      if (error) throw error;
      pushAlert(type, row);
      pushSheet(type, row);
    } catch (e) {
      // never lose a lead — queue and retry on next load
      const o = getLS('tpc_outbox', []); o.push(row); setLS('tpc_outbox', o);
      console.warn('[TPC] request queued for retry:', e.message || e);
    }
    refreshNewCount();
  }

  async function flushOutbox() {
    let o = getLS('tpc_outbox', []);
    if (!o.length) return;
    const keep = [];
    for (const row of o) {
      try { const { error } = await sb.from('requests').insert(row); if (error) throw error; pushAlert(row.type, row); pushSheet(row.type, row); }
      catch (e) { keep.push(row); }
    }
    setLS('tpc_outbox', keep);
  }

  function pushAlert(type, row) {
    if (!WEB3FORMS_KEY) return;
    const d = row.data || {};
    const LABELS = {
      vehicle: 'Vehicle', brand: 'Brand', model: 'Model', variant: 'Variant', year: 'Year',
      body: 'Body Type', fuel: 'Fuel', cc: 'Engine (cc)', trans: 'Transmission', reg: 'Registration',
      kms: 'Odometer', condition: 'Condition', mods: 'Existing Mods', mission: 'Build Type',
      goal: 'Build Goal', issues: 'Known Issues', use: 'Primary Use', terrain: 'Terrain',
      budget: 'Budget', timeline: 'Timeline', event: 'Event / Deadline',
      name: 'Name', phone: 'Phone', email: 'Email', city: 'City', source: 'Referred By', message: 'Message'
    };
    // For a build brief, show EVERY field (empty ones render as —) so nothing is ever dropped.
    const BUILD_ORDER = ['vehicle', 'brand', 'model', 'variant', 'year', 'body', 'fuel', 'cc', 'trans', 'reg',
      'kms', 'condition', 'mods', 'mission', 'goal', 'issues', 'use', 'terrain', 'budget', 'timeline', 'event',
      'name', 'phone', 'email', 'city', 'source'];
    const show = v => (v == null || String(v).trim() === '') ? '—' : String(v).trim();
    const fields = {};
    const lines = [];
    if (type === 'build') {
      BUILD_ORDER.forEach(k => { const val = show(d[k]); fields[LABELS[k] || k] = val; lines.push((LABELS[k] || k) + ': ' + val); });
    } else {
      Object.entries(d).forEach(([k, v]) => { if (v != null && String(v).trim() !== '') { const L = LABELS[k] || k; fields[L] = String(v).trim(); lines.push(L + ': ' + String(v).trim()); } });
    }
    const who = row.name || d.name || row.email || d.email || '';
    const payload = {
      access_key: WEB3FORMS_KEY,
      subject: 'TPC ' + (TYPE_LABEL[type] || type) + (who ? ' — ' + who : ''),
      from_name: 'Tribal Punk Customs Site',
      'Request Type': TYPE_LABEL[type] || type,
      'Submitted': new Date().toLocaleString('en-IN'),
      ...fields,
      message: lines.join('\n')
    };
    fetch('https://api.web3forms.com/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  // ── GOOGLE SHEET MIRROR ────────────────────────────────
  // Appends one row per lead to a Google Sheet via an Apps Script Web App.
  // Uses a flat payload so the Apps Script can map keys → columns. Sent as
  // text/plain to dodge the CORS preflight Apps Script can't answer (no-cors).
  function pushSheet(type, row) {
    if (!SHEETS_URL) return;
    const d = row.data || {};
    // The 5 base fields below are sent as their own top-level keys, so DON'T
    // also repeat them inside `fields` (that caused duplicate columns).
    const BASE = ['name', 'phone', 'email', 'vehicle', 'message'];
    const flat = {};
    Object.entries(d).forEach(([k, v]) => {
      if (BASE.indexOf(k) !== -1) return;
      if (v != null && String(v).trim() !== '') flat[k] = String(v).trim();
    });
    const payload = {
      submitted: new Date().toISOString(),
      type: TYPE_LABEL[type] || type,
      status: row.status || 'New',
      name: row.name || d.name || '',
      phone: row.phone || d.phone || '',
      email: row.email || d.email || '',
      vehicle: row.vehicle || d.vehicle || '',
      message: row.message || d.message || d.goal || '',
      fields: flat
    };
    fetch(SHEETS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  async function refreshNewCount() {
    if (!isOwner()) { _newCount = 0; return; }
    try {
      const { count } = await sb.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'New');
      _newCount = count || 0;
    } catch (e) { _newCount = 0; }
    renderNav();
  }

  // ── UI: STYLES (unchanged) ─────────────────────────────
  function injectStyles() {
    if (document.getElementById('tpc-auth-css')) return;
    const s = document.createElement('style');
    s.id = 'tpc-auth-css';
    s.textContent = `
    .tpc-acct{display:flex;align-items:center;gap:10px;margin-left:6px}
    .tpc-acct .btn-auth{font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:600;letter-spacing:2px;text-transform:uppercase;padding:9px 18px;background:transparent;color:var(--patina-light);border:1.5px solid var(--patina);cursor:pointer;transition:.18s;clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%)}
    .tpc-acct .btn-auth:hover{background:var(--patina-metal);color:#0c130f;border-color:var(--patina-light)}
    .tpc-chip{display:flex;align-items:center;gap:8px;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px;color:var(--bone);background:var(--carbon);border:1px solid var(--iron);padding:6px 12px 6px 8px;cursor:pointer;position:relative}
    .tpc-chip:hover{border-color:var(--patina)}
    .tpc-chip .av{width:26px;height:26px;border-radius:50%;background:var(--patina-metal);color:#0c130f;font-family:'Bebas Neue',sans-serif;font-size:15px;display:flex;align-items:center;justify-content:center}
    .tpc-chip .nm{font-size:13px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tpc-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:188px;background:var(--charcoal);border:1px solid var(--iron);box-shadow:0 18px 40px rgba(0,0,0,.55);z-index:1200;display:none}
    .tpc-menu.show{display:block}
    .tpc-menu a{display:flex;align-items:center;gap:10px;padding:11px 16px;font-family:'Barlow',sans-serif;font-size:14px;color:var(--bone);cursor:pointer;border-bottom:1px solid rgba(255,255,255,.04)}
    .tpc-menu a:hover{background:rgba(56,130,97,.12);color:var(--patina-light)}
    .tpc-menu a svg{width:15px;height:15px}
    .tpc-menu .ix{color:var(--gold)}
    .tpc-badge-n{background:var(--rust);color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;border-radius:10px;padding:1px 7px;margin-left:auto}

    .tpc-overlay{position:fixed;inset:0;z-index:2000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(4,5,4,.78);backdrop-filter:blur(6px)}
    .tpc-overlay.show{display:flex}
    .tpc-modal{width:100%;max-width:440px;background:linear-gradient(180deg,#12160f,#0c0f0c);border:1px solid var(--iron);border-top:3px solid var(--patina);position:relative;max-height:92vh;overflow:auto}
    .tpc-modal::before{content:'';position:absolute;right:-90px;top:50%;transform:translateY(-50%);width:300px;height:300px;background:url('assets/tpc-emblem.png') center/contain no-repeat;opacity:.05;pointer-events:none}
    .tpc-x{position:absolute;top:14px;right:14px;width:34px;height:34px;border:1px solid var(--iron);background:transparent;color:var(--fog);font-size:18px;cursor:pointer;z-index:2;display:flex;align-items:center;justify-content:center}
    .tpc-x:hover{border-color:var(--rust);color:var(--rust)}
    .tpc-mhead{padding:30px 32px 0;position:relative;z-index:1}
    .tpc-mhead .tag{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:var(--patina-light);display:flex;align-items:center;gap:9px}
    .tpc-mhead .tag::before{content:'';width:24px;height:3px;background:var(--patina-metal)}
    .tpc-mhead h3{font-family:'Bebas Neue',sans-serif;font-size:38px;letter-spacing:2px;color:var(--white);margin:10px 0 4px;line-height:1}
    .tpc-mhead p{font-family:'Barlow',sans-serif;font-size:14px;color:var(--fog);line-height:1.5;margin:0 0 4px}
    .tpc-tabs{display:flex;gap:0;margin:20px 32px 0;border-bottom:1px solid var(--iron)}
    .tpc-tab{flex:1;font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:600;letter-spacing:2px;text-transform:uppercase;padding:12px 0;background:none;border:none;color:var(--fog);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
    .tpc-tab.on{color:var(--patina-light);border-bottom-color:var(--patina)}
    .tpc-form{padding:22px 32px 32px;position:relative;z-index:1}
    .tpc-field{margin-bottom:16px}
    .tpc-field label{display:block;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--fog);margin-bottom:7px}
    .tpc-field input{width:100%;background:var(--black);border:1px solid var(--iron);color:var(--bone);font-family:'Barlow',sans-serif;font-size:15px;padding:12px 14px;outline:none;transition:.18s}
    .tpc-field input:focus{border-color:var(--patina);box-shadow:0 0 0 2px var(--patina-glow)}
    .tpc-err{font-family:'Barlow',sans-serif;font-size:13px;color:#e57373;background:rgba(229,57,53,.08);border:1px solid rgba(229,57,53,.5);padding:9px 12px;margin-bottom:14px;display:none}
    .tpc-err.show{display:block}
    .tpc-err.ok{color:var(--patina-light);background:rgba(56,130,97,.1);border-color:rgba(56,130,97,.5)}
    .tpc-submit{width:100%;font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:15px;background:var(--rust);color:#fff;border:none;cursor:pointer;transition:.18s;clip-path:polygon(7px 0,100% 0,calc(100% - 7px) 100%,0 100%)}
    .tpc-submit:hover{background:var(--amber);color:var(--black)}
    .tpc-submit:disabled{opacity:.6;cursor:wait}
    .tpc-alt{text-align:center;font-family:'Barlow',sans-serif;font-size:13px;color:var(--fog);margin-top:16px}
    .tpc-alt b{color:var(--patina-light);cursor:pointer}
    .tpc-forgot{text-align:right;margin:-4px 0 16px}
    .tpc-forgot b{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--patina-light);cursor:pointer}
    .tpc-forgot b:hover{color:var(--gold);text-decoration:underline}
    .tpc-gate-note{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1px;color:var(--gold);background:rgba(245,184,48,.07);border:1px solid rgba(245,184,48,.3);padding:9px 12px;margin:0 32px;display:flex;align-items:center;gap:8px}
    .tpc-gate-note svg{width:15px;height:15px;flex-shrink:0}

    #nav-build .tpc-lock{display:inline-block;width:11px;height:11px;margin-left:5px;vertical-align:-1px;opacity:.7}

    .tpc-inbox{position:fixed;inset:0;z-index:1900;display:none;background:#0a0c0a}
    .tpc-inbox.show{display:flex;flex-direction:column}
    .tpc-ib-top{display:flex;align-items:center;gap:16px;padding:16px 26px;border-bottom:1px solid var(--iron);background:var(--charcoal);flex-wrap:wrap}
    .tpc-ib-top .ttl{font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:2px;color:var(--white)}
    .tpc-ib-top .ttl em{color:var(--patina-light);font-style:normal}
    .tpc-ib-stats{display:flex;gap:18px;margin-left:8px}
    .tpc-ib-stat{font-family:'Barlow Condensed',sans-serif;letter-spacing:1px;color:var(--fog);font-size:13px}
    .tpc-ib-stat b{font-family:'Bebas Neue',sans-serif;font-size:20px;color:var(--bone);margin-right:5px}
    .tpc-ib-actions{margin-left:auto;display:flex;gap:8px}
    .tpc-ib-btn{font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;padding:9px 14px;background:transparent;color:var(--bone);border:1px solid var(--iron);cursor:pointer}
    .tpc-ib-btn:hover{border-color:var(--patina);color:var(--patina-light)}
    .tpc-ib-btn.danger:hover{border-color:var(--rust);color:var(--rust)}
    .tpc-ib-filters{display:flex;gap:6px;padding:12px 26px;border-bottom:1px solid var(--iron);flex-wrap:wrap;background:#0d100d}
    .tpc-fchip{font-family:'Barlow Condensed',sans-serif;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:6px 13px;border:1px solid var(--iron);color:var(--fog);background:transparent;cursor:pointer}
    .tpc-fchip.on{background:var(--patina);border-color:var(--patina);color:#0c130f;font-weight:700}
    .tpc-ib-body{flex:1;overflow:auto;padding:18px 26px 60px}
    .tpc-ib-empty{text-align:center;color:var(--fog);font-family:'Barlow',sans-serif;padding:80px 20px}
    .tpc-card{border:1px solid var(--iron);background:var(--charcoal);margin-bottom:12px;border-left:3px solid var(--iron)}
    .tpc-card[data-status="New"]{border-left-color:var(--gold)}
    .tpc-card[data-status="Contacted"]{border-left-color:var(--patina)}
    .tpc-card[data-status="Closed"]{border-left-color:var(--iron);opacity:.62}
    .tpc-card-head{display:flex;align-items:center;gap:14px;padding:14px 18px;cursor:pointer}
    .tpc-type{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:3px 9px;border:1px solid var(--iron)}
    .tpc-type.build{color:var(--amber);border-color:rgba(232,121,10,.4);background:rgba(232,121,10,.07)}
    .tpc-type.enquiry{color:var(--patina-light);border-color:rgba(56,130,97,.4);background:rgba(56,130,97,.07)}
    .tpc-type.callback{color:var(--gold);border-color:rgba(245,184,48,.4);background:rgba(245,184,48,.07)}
    .tpc-type.signup{color:var(--fog)}
    .tpc-card-who{font-family:'Barlow',sans-serif;font-weight:600;color:var(--bone);font-size:15px}
    .tpc-card-sub{font-family:'Barlow Condensed',sans-serif;font-size:13px;color:var(--fog);letter-spacing:.5px}
    .tpc-card-meta{margin-left:auto;text-align:right;font-family:'Barlow Condensed',sans-serif;font-size:12px;color:var(--fog);letter-spacing:1px}
    .tpc-pill{font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:2px 8px;border-radius:10px}
    .tpc-pill.New{background:rgba(245,184,48,.15);color:var(--gold)}
    .tpc-pill.Contacted{background:rgba(56,130,97,.15);color:var(--patina-light)}
    .tpc-pill.Closed{background:var(--iron);color:var(--fog)}
    .tpc-card-detail{display:none;padding:4px 18px 18px;border-top:1px solid rgba(255,255,255,.04)}
    .tpc-card.open .tpc-card-detail{display:block}
    .tpc-dl{display:grid;grid-template-columns:150px 1fr;gap:4px 16px;font-family:'Barlow',sans-serif;font-size:13.5px;margin:12px 0}
    .tpc-dl dt{color:var(--fog);font-family:'Barlow Condensed',sans-serif;letter-spacing:1px;text-transform:uppercase;font-size:11px;padding-top:2px}
    .tpc-dl dd{color:var(--bone);margin:0}
    .tpc-detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
    .tpc-sbtn{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;padding:7px 12px;border:1px solid var(--iron);background:transparent;color:var(--fog);cursor:pointer}
    .tpc-sbtn:hover,.tpc-sbtn.on{border-color:var(--patina);color:var(--patina-light)}
    .tpc-sbtn.del:hover{border-color:var(--rust);color:var(--rust)}
    .tpc-sbtn.reply{color:var(--bone)}
    .tpc-ib-loading{text-align:center;color:var(--fog);font-family:'Barlow Condensed',sans-serif;letter-spacing:2px;text-transform:uppercase;padding:70px 20px}
    @media(max-width:640px){
      .tpc-ib-stats{width:100%;margin:6px 0 0}
      .tpc-ib-actions{margin:8px 0 0}
      .tpc-dl{grid-template-columns:1fr}
      .tpc-card-meta{display:none}
    }`;
    document.head.appendChild(s);
  }

  // ── UI: AUTH MODAL ─────────────────────────────────────
  let authMode = 'login', gateThen = null;
  function buildAuthDom() {
    if (document.getElementById('tpcAuth')) return;
    const o = document.createElement('div');
    o.className = 'tpc-overlay'; o.id = 'tpcAuth';
    o.innerHTML = `
      <div class="tpc-modal" role="dialog" aria-modal="true">
        <button class="tpc-x" aria-label="Close" onclick="TPC.closeAuth()">✕</button>
        <div class="tpc-mhead">
          <div class="tag">Members</div>
          <h3 id="tpcAuthTitle">Garage Access</h3>
          <p id="tpcAuthSub">Sign in to open the Build Your Vehicle bay.</p>
        </div>
        <div class="tpc-gate-note" id="tpcGateNote" style="display:none"><i data-lucide="lock"></i><span>Build Your Vehicle is members-only. Create a free account or sign in to continue. Direct link: <b style="user-select:all;color:var(--bone)">tribalpunkcustoms.com/#build</b></span></div>
        <div class="tpc-tabs" id="tpcTabs">
          <button class="tpc-tab on" id="tpcTabLogin" onclick="TPC.setAuthMode('login')">Sign In</button>
          <button class="tpc-tab" id="tpcTabSignup" onclick="TPC.setAuthMode('signup')">Create Account</button>
        </div>
        <form class="tpc-form" id="tpcForm" onsubmit="return TPC.submitAuth(event)">
          <div class="tpc-err" id="tpcErr"></div>
          <div class="tpc-field" id="fld-name"><label>Full Name</label><input id="au-name" type="text" autocomplete="name" placeholder="e.g. Arjun Mehta"></div>
          <div class="tpc-field" id="fld-phone"><label>Phone</label><input id="au-phone" type="tel" autocomplete="tel" placeholder="+91 …"></div>
          <div class="tpc-field" id="fld-email"><label>Email</label><input id="au-email" type="email" autocomplete="email" placeholder="you@email.com"></div>
          <div class="tpc-field"><label id="lbl-pass">Password</label><input id="au-pass" type="password" autocomplete="current-password" placeholder="••••••••"></div>
          <div class="tpc-field" id="fld-confirm" style="display:none"><label>Confirm Password</label><input id="au-confirm" type="password" autocomplete="new-password" placeholder="••••••••"></div>
          <div class="tpc-forgot" id="tpcForgot"><b onclick="TPC.forgotPassword()">Forgot password?</b></div>
          <button class="tpc-submit" type="submit" id="tpcSubmitBtn">Sign In →</button>
          <div class="tpc-alt" id="tpcAlt"></div>
        </form>
      </div>`;
    document.body.appendChild(o);
    o.addEventListener('click', e => { if (e.target === o) closeAuth(); });
  }

  function openAuth(mode, opts) {
    buildAuthDom();
    opts = opts || {};
    gateThen = opts.then || null;
    document.getElementById('tpcGateNote').style.display = opts.gate ? 'flex' : 'none';
    setAuthMode(mode || 'login');
    document.getElementById('tpcAuth').classList.add('show');
    if (window.renderIcons) renderIcons();
    setTimeout(() => document.getElementById(mode === 'signup' ? 'au-name' : 'au-email')?.focus(), 60);
  }
  function closeAuth() {
    document.getElementById('tpcAuth')?.classList.remove('show');
    const wasGate = !!gateThen; gateThen = null;
    // Dismissing the gate without signing in must never leave the Build page exposed.
    if (wasGate && !isLoggedIn() && document.getElementById('page-build')?.classList.contains('active') && window.showPage) window.showPage('home', { fromHash: true });
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    const reset = mode === 'reset';
    document.getElementById('tpcTabs').style.display = reset ? 'none' : 'flex';
    document.getElementById('tpcTabLogin').classList.toggle('on', !signup && !reset);
    document.getElementById('tpcTabSignup').classList.toggle('on', signup);
    document.getElementById('fld-name').style.display = signup ? 'block' : 'none';
    document.getElementById('fld-phone').style.display = signup ? 'block' : 'none';
    document.getElementById('fld-email').style.display = reset ? 'none' : 'block';
    document.getElementById('fld-confirm').style.display = reset ? 'block' : 'none';
    document.getElementById('tpcForgot').style.display = (signup || reset) ? 'none' : 'block';
    document.getElementById('lbl-pass').textContent = reset ? 'New Password' : 'Password';
    document.getElementById('tpcAuthTitle').textContent = reset ? 'Set New Password' : (signup ? 'Join the Garage' : 'Garage Access');
    document.getElementById('tpcAuthSub').textContent = reset
      ? 'Choose a new password for your account.'
      : (signup
        ? 'Create a free account to brief your build and track requests.'
        : 'Sign in to open the Build Your Vehicle bay.');
    document.getElementById('tpcSubmitBtn').textContent = reset ? 'Update Password →' : (signup ? 'Create Account →' : 'Sign In →');
    document.getElementById('au-pass').setAttribute('autocomplete', (signup || reset) ? 'new-password' : 'current-password');
    document.getElementById('tpcAlt').innerHTML = reset
      ? ''
      : (signup
        ? `Already a member? <b onclick="TPC.setAuthMode('login')">Sign in</b>`
        : `New here? <b onclick="TPC.setAuthMode('signup')">Create an account</b>`);
    showErr('');
  }

  async function forgotPassword() {
    const email = document.getElementById('au-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('Enter your email above first, then tap “Forgot password.”');
    const btn = document.getElementById('tpcForgot').querySelector('b');
    const lbl = btn.textContent; btn.textContent = 'Sending…'; showErr('');
    try {
      const redirectTo = location.origin + location.pathname;
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      showErr('Reset link sent — check your email inbox (and spam).', true);
    } catch (e) { showErr('Couldn’t send the reset email — try again.'); }
    btn.textContent = lbl;
  }
  function showErr(msg, ok) { const e = document.getElementById('tpcErr'); if (!e) return; e.textContent = msg; e.classList.toggle('show', !!msg); e.classList.toggle('ok', !!ok); }

  function submitAuth(ev) {
    ev.preventDefault();
    doSubmitAuth();
    return false;
  }
  async function doSubmitAuth() {
    if (authMode === 'reset') return doResetPassword();
    const email = document.getElementById('au-email').value.trim();
    const pass = document.getElementById('au-pass').value;
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return showErr('Enter a valid email address.');
    if (pass.length < 6) return showErr('Password must be at least 6 characters.');
    const btn = document.getElementById('tpcSubmitBtn');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Please wait…'; showErr('');
    let res;
    try {
      if (authMode === 'signup') {
        const name = document.getElementById('au-name').value.trim();
        if (!name) { btn.disabled = false; btn.textContent = label; return showErr('Please enter your name.'); }
        res = await signup({ name, email, phone: document.getElementById('au-phone').value, pass });
      } else {
        res = await login({ email, pass });
      }
    } catch (e) { res = { ok: false, err: 'Network error — please try again.' }; }
    btn.disabled = false; btn.textContent = label;
    if (!res.ok) return showErr(res.err);
    if (res.pending) {
      showErr('Account created — check your email to confirm, then sign in.', true);
      setAuthMode('login');
      return;
    }
    const then = gateThen;
    closeAuth();
    renderNav();
    refreshNewCount();
    if (res.user && res.user.role === 'owner') openInbox();
    else if (then) then();
  }

  async function doResetPassword() {
    const p1 = document.getElementById('au-pass').value;
    const p2 = document.getElementById('au-confirm').value;
    if (p1.length < 6) return showErr('Password must be at least 6 characters.');
    if (p1 !== p2) return showErr('Passwords don\u2019t match.');
    const btn = document.getElementById('tpcSubmitBtn');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Please wait…'; showErr('');
    try {
      const { error } = await sb.auth.updateUser({ password: p1 });
      if (error) throw error;
      // strip the recovery hash so a refresh doesn't re-trigger the flow
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      showErr('Password updated — you\u2019re signed in.', true);
      setTimeout(() => {
        closeAuth();
        renderNav();
        refreshNewCount();
        if (isOwner()) openInbox();
      }, 900);
    } catch (e) {
      showErr('Couldn\u2019t update password — the reset link may have expired. Request a new one.');
    }
    btn.disabled = false; btn.textContent = label;
  }

  // ── UI: NAV ────────────────────────────────────────────
  function renderNav() {
    const links = document.getElementById('navLinks');
    if (!links) return;
    let host = document.getElementById('tpcAcct');
    if (!host) {
      const li = document.createElement('li');
      li.id = 'tpcAcctLi'; li.style.listStyle = 'none';
      host = document.createElement('div');
      host.id = 'tpcAcct'; host.className = 'tpc-acct';
      li.appendChild(host); links.appendChild(li);
    }
    const u = currentUser();
    if (!u) {
      host.innerHTML = `<button class="btn-auth" onclick="TPC.openAuth('login')">Sign In</button>`;
    } else {
      const initial = (u.name || u.email)[0].toUpperCase();
      const ownerRow = u.role === 'owner'
        ? `<a class="ix" onclick="TPC.openInbox()"><i data-lucide="inbox"></i> Requests Inbox ${_newCount ? `<span class="tpc-badge-n">${_newCount}</span>` : ''}</a>` : '';
      host.innerHTML = `
        <div class="tpc-chip" onclick="TPC.toggleMenu(event)">
          <span class="av">${initial}</span><span class="nm">${u.name || u.email}</span>
          <div class="tpc-menu" id="tpcMenu">
            ${u.role !== 'owner' ? `<a onclick="showPage('build')"><i data-lucide="wrench"></i> Build Your Vehicle</a>` : ''}
            ${ownerRow}
            <a onclick="TPC.logout()"><i data-lucide="log-out"></i> Sign Out</a>
          </div>
        </div>`;
    }
    const buildLink = document.getElementById('nav-build');
    if (buildLink) {
      const hasLock = buildLink.querySelector('.tpc-lock');
      if (!u && !hasLock) {
        const i = document.createElement('i'); i.setAttribute('data-lucide', 'lock'); i.className = 'tpc-lock';
        buildLink.appendChild(i);
      } else if (u && hasLock) { hasLock.remove(); }
    }
    if (window.renderIcons) renderIcons();
  }
  function toggleMenu(ev) { ev.stopPropagation(); document.getElementById('tpcMenu')?.classList.toggle('show'); }
  document.addEventListener('click', () => document.getElementById('tpcMenu')?.classList.remove('show'));

  // ── UI: INBOX ──────────────────────────────────────────
  let ibFilter = 'all', _reqCache = [];
  function buildInboxDom() {
    if (document.getElementById('tpcInbox')) return;
    const d = document.createElement('div');
    d.className = 'tpc-inbox'; d.id = 'tpcInbox';
    d.innerHTML = `
      <div class="tpc-ib-top">
        <div class="ttl">Requests <em>Inbox</em></div>
        <div class="tpc-ib-stats" id="tpcIbStats"></div>
        <div class="tpc-ib-actions">
          <button class="tpc-ib-btn" onclick="TPC.renderInbox()"><i data-lucide="refresh-cw"></i> Refresh</button>
          <button class="tpc-ib-btn" onclick="TPC.exportCSV()"><i data-lucide="download"></i> Export CSV</button>
          <button class="tpc-ib-btn danger" onclick="TPC.closeInbox()">Close ✕</button>
        </div>
      </div>
      <div class="tpc-ib-filters" id="tpcIbFilters"></div>
      <div class="tpc-ib-body" id="tpcIbBody"></div>`;
    document.body.appendChild(d);
  }
  function openInbox() {
    if (!isOwner()) { openAuth('login', { gate: false }); const sub = document.getElementById('tpcAuthSub'); if (sub) sub.textContent = 'Owner sign-in required to view the requests inbox.'; return; }
    buildInboxDom();
    document.getElementById('tpcInbox').classList.add('show');
    renderInbox();
  }
  function closeInbox() { document.getElementById('tpcInbox')?.classList.remove('show'); }

  const TYPE_LABEL = { build: 'Build Brief', enquiry: 'Enquiry', callback: 'Callback', signup: 'New Member' };
  async function renderInbox() {
    const body = document.getElementById('tpcIbBody');
    if (!body) return;
    body.innerHTML = `<div class="tpc-ib-loading">Loading requests…</div>`;
    let reqs = [];
    try {
      const { data, error } = await sb.from('requests').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      reqs = data || [];
    } catch (e) {
      body.innerHTML = `<div class="tpc-ib-empty"><p>Couldn't load requests.<br><span style="color:var(--fog);font-size:13px">${(e.message || e)}</span></p><p style="font-size:13px;margin-top:10px">Make sure the database SQL has been run and your email is in the <b>admins</b> table.</p></div>`;
      return;
    }
    _reqCache = reqs;
    const counts = { all: reqs.length, New: 0, build: 0, enquiry: 0, callback: 0, signup: 0 };
    reqs.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; counts[r.type] = (counts[r.type] || 0) + 1; });
    document.getElementById('tpcIbStats').innerHTML =
      `<span class="tpc-ib-stat"><b>${counts.all}</b>Total</span>
       <span class="tpc-ib-stat"><b>${counts.New || 0}</b>New</span>
       <span class="tpc-ib-stat"><b>${counts.build || 0}</b>Builds</span>
       <span class="tpc-ib-stat"><b>${(counts.enquiry || 0) + (counts.callback || 0)}</b>Enquiries</span>`;
    const filters = [['all', 'All'], ['New', 'New'], ['build', 'Builds'], ['enquiry', 'Enquiries'], ['callback', 'Callbacks'], ['signup', 'Members']];
    document.getElementById('tpcIbFilters').innerHTML = filters.map(([k, l]) =>
      `<button class="tpc-fchip ${ibFilter === k ? 'on' : ''}" onclick="TPC.setFilter('${k}')">${l}${counts[k] ? ' · ' + counts[k] : ''}</button>`).join('');
    const list = reqs.filter(r => ibFilter === 'all' ? true : (r.status === ibFilter || r.type === ibFilter));
    if (!list.length) { body.innerHTML = `<div class="tpc-ib-empty"><i data-lucide="inbox" style="width:40px;height:40px;opacity:.4"></i><p>No requests here yet.</p></div>`; if (window.renderIcons) renderIcons(); return; }
    body.innerHTML = list.map(cardHTML).join('');
    if (window.renderIcons) renderIcons();
    _newCount = counts.New || 0; renderNav();
  }
  function setFilter(k) { ibFilter = k; renderInbox(); }

  function cardHTML(r) {
    const d = r.data || {};
    const who = r.name || d.name || r.email || 'Unknown';
    const when = new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    let sub = '';
    if (r.type === 'build') sub = r.vehicle || d.vehicle || '';
    else if (r.type === 'enquiry' || r.type === 'callback') sub = r.vehicle || d.vehicle || r.message || d.message || '';
    else sub = r.email || d.email || '';
    const rows = Object.entries(d).filter(([k, v]) => v && String(v).trim() && v !== '—' && k !== 'admin_notes' && k !== 'followup')
      .map(([k, v]) => `<dt>${labelize(k)}</dt><dd>${esc(String(v))}</dd>`).join('');
    const mail = (r.email || d.email) ? `<a class="tpc-sbtn reply" href="mailto:${r.email || d.email}?subject=Tribal%20Punk%20Customs%20—%20your%20${r.type}">Reply by Email</a>` : '';
    const ph = r.phone || d.phone;
    const tel = ph ? `<a class="tpc-sbtn reply" href="tel:${String(ph).replace(/\s/g, '')}">Call</a>` : '';
    const wa = ph ? `<a class="tpc-sbtn reply" target="_blank" href="https://wa.me/${String(ph).replace(/[^0-9]/g, '')}">WhatsApp</a>` : '';
    return `
      <div class="tpc-card" data-status="${r.status}" id="card-${r.id}">
        <div class="tpc-card-head" onclick="TPC.toggleCard('${r.id}')">
          <span class="tpc-type ${r.type}">${TYPE_LABEL[r.type] || r.type}</span>
          <div>
            <div class="tpc-card-who">${esc(who)}</div>
            <div class="tpc-card-sub">${esc(sub).slice(0, 80)}</div>
          </div>
          <span class="tpc-pill ${r.status}">${r.status}</span>
          <div class="tpc-card-meta">${when}<br>${String(r.id).slice(0, 8)}</div>
        </div>
        <div class="tpc-card-detail">
          <dl class="tpc-dl">${rows}</dl>
          <div class="tpc-detail-actions">
            <span style="font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:1.5px;color:var(--fog);align-self:center;text-transform:uppercase">Status:</span>
            ${['New', 'Contacted', 'Closed'].map(s => `<button class="tpc-sbtn ${r.status === s ? 'on' : ''}" onclick="TPC.setStatus('${r.id}','${s}')">${s}</button>`).join('')}
            ${mail} ${tel} ${wa}
            <button class="tpc-sbtn del" onclick="TPC.removeReq('${r.id}')"><i data-lucide="trash-2" style="width:12px;height:12px;vertical-align:-1px"></i> Delete</button>
          </div>
        </div>
      </div>`;
  }
  function toggleCard(id) { document.getElementById('card-' + id)?.classList.toggle('open'); }
  async function setStatus(id, s) {
    try { await sb.from('requests').update({ status: s }).eq('id', id); } catch (e) {}
    const r = _reqCache.find(x => String(x.id) === String(id)); if (r) r.status = s;
    renderInbox();
  }
  async function removeReq(id) {
    if (!confirm('Delete this request permanently?')) return;
    try { await sb.from('requests').delete().eq('id', id); } catch (e) {}
    renderInbox();
  }

  function exportCSV() {
    const reqs = _reqCache;
    if (!reqs.length) return alert('No requests to export.');
    const keys = new Set(['id', 'type', 'status', 'submitted', 'email']);
    reqs.forEach(r => Object.keys(r.data || {}).forEach(k => keys.add(k)));
    const cols = [...keys];
    const rows = reqs.map(r => cols.map(c => {
      let v = c === 'submitted' ? new Date(r.created_at).toLocaleString()
        : (['id', 'type', 'status', 'email'].includes(c) ? r[c] : (r.data || {})[c]);
      v = v == null ? '' : String(v).replace(/"/g, '""');
      return `"${v}"`;
    }).join(','));
    const csv = cols.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tpc-requests-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }

  // helpers
  function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function labelize(k) { return k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).replace(/_/g, ' '); }

  // ── GATE: wrap showPage ────────────────────────────────
  function installGate() {
    const orig = window.showPage;
    if (typeof orig !== 'function' || orig.__tpcWrapped) return;
    const wrapped = function (id, opts) {
      if (id === 'build' && !isLoggedIn()) {
        if (!(opts && opts.fromHash)) history.pushState({ page: 'build' }, '', location.pathname + '#build');
        if (document.getElementById('page-build')?.classList.contains('active')) orig('home', { fromHash: true });
        openAuth('login', { gate: true, then: () => { orig('build', { fromHash: true }); prefillBuild(); } });
        return;
      }
      orig(id, opts);
      if (id === 'build') prefillBuild();
    };
    wrapped.__tpcWrapped = true;
    window.showPage = wrapped;
  }
  function prefillBuild() {
    const u = currentUser(); if (!u) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && !el.value && v) el.value = v; };
    set('bf-name', u.name); set('bf-email', u.email); set('bf-phone', u.phone);
  }

  // ── INIT ───────────────────────────────────────────────
  async function init() {
    injectStyles();
    buildAuthDom();
    try {
      const { data: { session } } = await sb.auth.getSession();
      _user = mapUser(session);
    } catch (e) { _user = null; }
    sb.auth.onAuthStateChange((_e, session) => {
      _user = mapUser(session);
      if (_e === 'PASSWORD_RECOVERY') openAuth('reset');
      renderNav();
      refreshNewCount();
    });
    renderNav();
    installGate();
    // If the raw router already opened Build before the gate existed (deep link /#build), re-run it through the gate.
    if (location.hash === '#build' && !isLoggedIn()) window.showPage('build', { fromHash: true });
    else if (document.getElementById('page-build')?.classList.contains('active') && !isLoggedIn()) window.showPage('build', { fromHash: true });
    else if (/^#(services|build|about|testimonials|blog|contact)$/.test(location.hash)) window.showPage(location.hash.slice(1), { fromHash: true });
    flushOutbox();
    refreshNewCount();
    if (/type=recovery/.test(location.hash) || /[?&]type=recovery/.test(location.search)) openAuth('reset');
    if (location.hash === '#inbox') openInbox();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ── PUBLIC API ─────────────────────────────────────────
  window.TPC = {
    currentUser, isLoggedIn, isOwner,
    openAuth, closeAuth, setAuthMode, submitAuth, forgotPassword, logout, toggleMenu,
    openInbox, closeInbox, renderInbox, setFilter, toggleCard, setStatus, removeReq, exportCSV,
    saveRequest, renderNav
  };
})();
