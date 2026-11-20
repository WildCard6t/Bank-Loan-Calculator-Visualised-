/* Cash-flow engine. Plain JS, no dependencies. Exposes window.CashFlow (or module.exports in Node).
   The engine reads and changes a state object. It never touches the page.

   ALL MONEY IS WHOLE CENTS (integers). DATES are ISO text "YYYY-MM-DD" in the state and whole day numbers inside the maths.

   THE STATE (saved in localStorage "cashFlow.v1" and included in the Settings backup), version 2:
   {
     version: 2,
     settings: { mode:'guided'|'free', bufferAuto:true, bufferAmount:0 (cents, used when bufferAuto is false),
                 reward:'subtle'|'celebratory', view:'list'|'vessels' },
     income:   { amount, every:'weekly'|'fortnightly'|'monthly'|'custom', days (for custom), next (the next payday not yet dealt),
                 anchor (the payday the rhythm counts from), reliable:true|false },
     sources:  [ { id:'spare',  name:'Unassigned money', kind:'spare',  balance },       // income not yet given to a pot
                 { id:'buffer', name:'Safety buffer',    kind:'buffer', balance } ],    // room for named accounts later
     pots:     [ { id, name, price, due (the date it is wanted by; for a repeating pot, this cycle's date), repeat:'none'|'weekly'|...|'yearly',
                   priority 1-5, firm, saved (banked cents), valveRate (cents per payday, or null = automatic),
                   payFreq:'pay'|'weekly'|..., createdAt (ms), startSaved, lastDeal (day number), status:'active'|'full'|'harvested' } ],
     ledger:   [ { id, ts (ms), type:'payday'|'deal'|'topup'|'withdraw'|'harvest'|'edit'|'guardian', potId?, sourceId?, cents, note } ],
     lastSeen: ms timestamp of the last time the page was open,
     achieved: [ { potId, name, price, saved, harvestedAt (ms), due, daysEarly (negative = late) } ]
   }
   THE LEDGER is append-only. Every cent that moves is an event, so replay(ledger) rebuilds every pot level, the buffer and the
   unassigned money exactly. Signs: payday +spare; deal -spare +pot (or +buffer); topup -source +pot; withdraw +source -pot;
   harvest -pot (the price); edit +/- the change (opening balances and changes made by hand). "guardian" notes never move money.
   MIGRATION: migrate(raw) turns version 1 (phase 0) or an empty/damaged value into version 2. Add a step there for each new version. */
(function (root) {
  'use strict';
  const DAY = 864e5, HORIZON = 1826;          // plan up to 5 years ahead
  const BUF_DAYS = 183;                        // the safety buffer is built up over about 6 months
  const VARY = 0.85;                           // "income varies": plan on 85% of the stated amount
  const AVG = { weekly: 7, fortnightly: 14, monthly: 365.25 / 12, quarterly: 365.25 / 4, yearly: 365.25 };
  const STEP = { weekly: { d: 7 }, fortnightly: { d: 14 }, monthly: { m: 1 }, quarterly: { m: 3 }, yearly: { m: 12 } };

  /* ---------- dates ---------- */
  const toDay = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY);
  const parseDate = s => { if (typeof s === 'number' && isFinite(s)) return Math.round(s); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null; const d = toDay(+m[1], +m[2], +m[3]), t = new Date(d * DAY); return t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3] ? d : null; };
  const fmtISO = d => new Date(d * DAY).toISOString().slice(0, 10);
  const addMonths = (d, n) => { const t = new Date(d * DAY), y = t.getUTCFullYear(), mo = t.getUTCMonth() + n, day = t.getUTCDate(), last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); return toDay(y, mo + 1, Math.min(day, last)); };
  const stepAt = (base, st, k) => st.d ? base + st.d * k : addMonths(base, st.m * k);
  const todayDay = () => { const n = new Date(); return toDay(n.getFullYear(), n.getMonth() + 1, n.getDate()); };

  /* ---------- helpers ---------- */
  const cents = x => Math.round(x);                      // already whole cents; rounds any float that sneaks in
  const incStep = inc => inc.every === 'custom' ? { d: Math.max(1, Math.round(inc.days || 1)) } : (STEP[inc.every] || STEP.fortnightly);
  const incDays = inc => inc.every === 'custom' ? Math.max(1, Math.round(inc.days || 1)) : (AVG[inc.every] || 14);
  const plannedPay = inc => inc.reliable === false ? Math.round(inc.amount * VARY) : inc.amount;
  const ceilI = x => Math.ceil(x - 1e-9);

  /* ---------- the savings equation (money in any one unit, e.g. dollars) ----------
     k=(1+r)^n, r=i/f, n=t*f.  G=S*k+P*(k-1)/r.  If r=0 then G=S+P*n. */
  const kk = (r, n) => Math.pow(1 + r, n);
  const eq = {
    G: (S, P, r, n) => r === 0 ? S + P * n : S * kk(r, n) + P * (kk(r, n) - 1) / r,
    P: (G, S, r, n) => r === 0 ? (G - S) / n : (G - S * kk(r, n)) * r / (kk(r, n) - 1),
    S: (G, P, r, n) => r === 0 ? G - P * n : (G - P * (kk(r, n) - 1) / r) / kk(r, n),
    n: (G, S, P, r) => { if (r === 0) return P === 0 ? null : (G - S) / P; const a = (G + P / r) / (S + P / r); return a > 0 && isFinite(a) ? Math.log(a) / Math.log(1 + r) : null; }
  };
  const bisect = (fn, lo, hi, target) => {            // fn must rise with its input
    let a = fn(lo), b = fn(hi); if (!isFinite(a) || !isFinite(b) || target < a || target > b) return null;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2, v = fn(mid); if (v < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  /* solve({G,S,P,i,f,t}, 'P') etc. i = yearly rate as a fraction (0.05 = 5%). Money is rounded to the cent. Returns null if no answer. */
  function solve(k, find) {
    const c2 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
    const r = k.i != null && k.f ? k.i / k.f : k.r, n = k.n != null ? k.n : (k.t != null && k.f ? k.t * k.f : null);
    switch (find) {
      case 'G': return c2(eq.G(k.S, k.P, r, n));
      case 'P': return c2(eq.P(k.G, k.S, r, n));
      case 'S': return c2(eq.S(k.G, k.P, r, n));
      case 'n': return eq.n(k.G, k.S, k.P, r);
      case 't': { const v = eq.n(k.G, k.S, k.P, r); return v == null ? null : v / k.f; }
      case 'r': return bisect(x => eq.G(k.S, k.P, x, n), -0.5, 1, k.G);
      case 'i': { const x = bisect(y => eq.G(k.S, k.P, y, n), -0.5, 1, k.G); return x == null ? null : x * k.f; }
      case 'f': return bisect(f => eq.G(k.S, k.P, k.i / f, k.t * f), 0.1, 366, k.G);
    }
    return null;
  }

  /* ---------- cleaning (reads version 2 and the older phase-0 shape) ---------- */
  const srcBal = (st, id) => { const s = (st.sources || []).find(x => x.id === id); return s ? cents(+s.balance || 0) : 0; };
  function clean(st) {
    const inc = st.income || {}, every = ['weekly', 'fortnightly', 'monthly', 'custom'].includes(inc.every) ? inc.every : 'fortnightly';
    const income = { amount: Math.max(0, cents(+inc.amount || 0)), every, days: Math.max(1, Math.round(+inc.days || 14)), next: parseDate(inc.next), anchor: parseDate(inc.anchor != null ? inc.anchor : inc.next), reliable: inc.reliable !== false };
    const pots = (st.pots || []).map((p, i) => ({
      id: p.id != null ? String(p.id) : 'p' + i, name: String(p.name || 'Pot ' + (i + 1)), price: Math.max(0, cents(+p.price || 0)), due: parseDate(p.due),
      repeat: STEP[p.repeat] ? p.repeat : 'none', priority: Math.min(5, Math.max(1, Math.round(+p.priority || 3))), firm: !!p.firm,
      saved: Math.max(0, cents(+p.saved || 0)), payFreq: STEP[p.payFreq] && p.payFreq !== 'quarterly' && p.payFreq !== 'yearly' ? p.payFreq : 'pay',
      valve: (p.valveRate != null ? p.valveRate : p.valve) == null ? null : Math.max(0, cents(+(p.valveRate != null ? p.valveRate : p.valve))), status: p.status === 'harvested' ? 'harvested' : 'active', lastDeal: p.lastDeal == null ? null : +p.lastDeal
    }));
    let buffer;
    if ((st.version || 1) >= 2) { const g = st.settings || {}; buffer = { auto: g.bufferAuto !== false, amount: Math.max(0, cents(+g.bufferAmount || 0)), saved: Math.max(0, srcBal(st, 'buffer')) }; }
    else { const b = st.buffer || {}; buffer = { auto: b.auto !== false, amount: Math.max(0, cents(+b.amount || 0)), saved: Math.max(0, cents(+b.saved || 0)) }; }
    return { income, pots, buffer };
  }
  /* default buffer = 2 weeks of firm repeating pots, whole cents */
  function bufferTarget(c) {
    if (!c.buffer.auto) return c.buffer.amount;
    let t = 0; c.pots.forEach(p => { if (p.status !== 'harvested' && p.firm && p.repeat !== 'none' && p.price > 0) t += Math.round(p.price * 14 / AVG[p.repeat]); }); return t;
  }

  /* ---------- pace: remaining / time left, per day, shown per pay ---------- */
  function paceOf(p, today, days) {
    const rem = Math.max(0, p.price - p.saved), dl = Math.max(1, p.due - today);
    let perDay = rem / dl; if (p.repeat !== 'none') perDay = Math.max(perDay, p.price / AVG[p.repeat]);
    perDay = Math.min(perDay, rem > 0 ? Infinity : 0);
    return { remaining: rem, daysLeft: dl, perDay, perPay: rem > 0 ? Math.min(rem, Math.round(perDay * days)) : 0 };
  }

  /* ---------- shared by the plan and by real paydays: the pots in play, and one payday's deal ---------- */
  function initPots(c, today) {
    const pots = [];
    c.pots.forEach((p, idx) => {
      if (p.status === 'harvested' || p.due == null || p.price <= 0) return;
      const rep = p.repeat !== 'none' ? STEP[p.repeat] : null, base = p.due; let cyc = 0, due = base;
      if (rep && p.saved < p.price) while (due < today) { cyc++; due = stepAt(base, rep, cyc); }   // an unfilled repeating pot rolls forward to its next date; a full one waits to be harvested
      pots.push({ id: p.id, name: p.name, idx, price: p.price, saved: p.saved, due, base, rep, cyc, cycleDays: rep ? AVG[p.repeat] : 0, prio: p.priority, firm: p.firm, valve: p.valve,
        own: p.payFreq === 'pay' ? 0 : AVG[p.payFreq], last: p.lastDeal != null ? p.lastDeal : -1e9, done: false, overdue: false, c0: true, firstFull: p.saved >= p.price ? today : null, firstDue: due,
        paidOut: 0, lost: 0, cycles: 0, misses: [], got: 0 });
    });
    const bt = bufferTarget(c), buf = bt > 0 ? { id: 'buffer', name: 'Safety buffer', buffer: true, price: bt, saved: c.buffer.saved, firm: true, prio: 0, got: 0 } : null;
    if (buf) pots.push(buf);
    return { pots, buf, bt };
  }
  function dealCore(pots, pd, pay, idays) {
    let avail = pay; const cand = [];
    pots.forEach((p, order) => {
      if (p.done) return; const rem = p.price - p.saved; if (rem <= 0) return;
      const dl = p.buffer ? Infinity : Math.max(0, p.due - pd);
      if (p.own && pd < p.last + p.own - Math.floor(idays / 2) && pd + idays <= p.due) return;      // own, slower payment rhythm
      const step = Math.max(idays, p.own || 0);
      let ask;
      if (p.buffer) ask = ceilI(rem * step / Math.max(step, BUF_DAYS));
      else if (p.valve != null) ask = p.valve;                                                          // the valve: an exact amount each payday
      else { ask = dl <= step || p.overdue ? rem : ceilI(rem * step / dl); if (p.cycleDays) ask = Math.max(ask, ceilI(p.price * step / p.cycleDays)); }
      ask = Math.min(ask, rem);
      const risk = !p.buffer && p.firm && (p.overdue || dl <= step * 1.5);
      cand.push({ p, ask, rem, order, grp: p.buffer ? 2 : p.firm ? (risk ? 0 : 1) : 3 });
    });
    /* order: firm pots whose deadline is close, other firm pots, the buffer, then everything else by priority (1 first), then earliest date */
    cand.sort((a, b) => a.grp - b.grp || a.p.prio - b.p.prio || (a.p.due || 0) - (b.p.due || 0) || a.order - b.order);
    const gives = {};
    cand.forEach(x => { const g = Math.min(x.ask, avail); gives[x.p.id] = g; avail -= g; });
    cand.forEach(x => { if (x.p.buffer || x.p.valve != null) return; const g = Math.min(x.rem - gives[x.p.id], avail); gives[x.p.id] += g; avail -= g; });   // cascade: spare money moves on down the line
    return { cand, gives, left: avail };
  }

  /* ---------- the payday-by-payday simulation ---------- */
  function simulate(st, o) {
    o = o || {}; const c = clean(st), today = o.today, extra = o.extra || 0, horizon = today + (o.days || HORIZON);
    const inc = c.income, idays = incDays(inc), ist = incStep(inc), pay = Math.max(0, plannedPay(inc) + extra);
    const ip = initPots(c, today), pots = ip.pots, buf = ip.buf, bt = ip.bt;
    let pi = 0, pd = stepAt(inc.next == null ? today : inc.next, ist, 0);
    while (pd < today) { pi++; pd = stepAt(inc.next, ist, pi); }
    const ledger = { start: pots.reduce((a, p) => a + p.saved, 0), income: 0, paidOut: 0, lost: 0, unassigned: 0 };
    const log = [], misses = [];
    const resolve = limit => pots.forEach(p => {
      if (p.buffer) return;
      while (!p.done && p.due < limit && !p.overdue) {
        if (p.saved >= p.price) { p.saved -= p.price; p.paidOut += p.price; ledger.paidOut += p.price; p.cycles++; if (p.c0) p.c0 = false; if (p.rep) { p.cyc++; p.due = stepAt(p.base, p.rep, p.cyc); } else p.done = true; }
        else {
          const m = { id: p.id, name: p.name, firm: p.firm, due: p.due, short: p.price - p.saved, cycle: p.cyc }; p.misses.push(m); misses.push(m);
          if (p.rep) { p.lost += p.saved; ledger.lost += p.saved; p.saved = 0; p.c0 = false; p.cyc++; p.due = stepAt(p.base, p.rep, p.cyc); } else p.overdue = true;   // a one-off keeps filling, late
        }
      }
    });
    while (pd <= horizon && pay >= 0) {
      resolve(pd); ledger.income += pay;
      const dr = dealCore(pots, pd, pay, idays), cand = dr.cand, gives = dr.gives;
      cand.forEach(x => {
        const g = gives[x.p.id], p = x.p; if (!g) return; p.saved += g; p.got += g; p.last = pd;
        if (!p.buffer && p.saved >= p.price) { if (p.c0 && p.firstFull == null) p.firstFull = pd; if (p.overdue) { p.paidOut += p.price; ledger.paidOut += p.price; p.saved -= p.price; p.done = true; p.cycles++; } }
      });
      ledger.unassigned += dr.left;
      if (o.log) log.push({ day: pd, pay, gives, left: dr.left, asks: cand.map(x => [x.p.id, x.ask]) });
      pi++; pd = stepAt(inc.next, ist, pi);
    }
    resolve(horizon + 1);
    ledger.end = pots.reduce((a, p) => a + p.saved, 0);
    return { pots, buffer: buf, misses, ledger, log, today, pay, idays, bufferTarget: bt };
  }

  /* ---------- the state: real paydays, the ledger, harvest ---------- */
  const localDay = ms => { const d = new Date(ms); return toDay(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  const localF = ms => (ms - new Date(ms).getTimezoneOffset() * 6e4) / DAY;          // fractional local day number
  const addMonthsA = (d, n, anchor) => { const t = new Date(d * DAY), y = t.getUTCFullYear(), mo = t.getUTCMonth() + n, last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(), ad = anchor != null ? new Date(anchor * DAY).getUTCDate() : t.getUTCDate(); return toDay(y, mo + 1, Math.min(ad, last)); };
  const payStep = (inc, d, dir) => { const st = incStep(inc); return st.d ? d + dir * st.d : addMonthsA(d, dir * st.m, inc.anchor); };
  const potById = (st, id) => st.pots.find(p => p.id === id);
  const src = (st, id) => st.sources.find(s => s.id === id);
  function emit(st, type, o, ts) { o = o || {}; const e = { id: 'e' + (st.ledger.length + 1), ts: ts != null ? ts : Date.now(), type, cents: o.cents || 0 }; if (o.potId != null) e.potId = o.potId; if (o.sourceId != null) e.sourceId = o.sourceId; if (o.note) e.note = o.note; st.ledger.push(e); return e; }
  const refresh = st => st.pots.forEach(p => { if (p.status !== 'harvested') p.status = p.saved >= p.price && p.price > 0 ? 'full' : 'active'; });

  function newState(today) {
    today = today != null ? today : todayDay();
    const t = today, iso = fmtISO, now = Date.now();
    const mk = (id, name, price, due, repeat, priority, firm, saved) => ({ id, name, price, due: iso(due), repeat, priority, firm, saved: 0, valveRate: null, payFreq: 'pay', createdAt: now, startSaved: saved, lastDeal: null, status: 'active', _open: saved });
    const st = { version: 2, settings: { mode: 'guided', bufferAuto: true, bufferAmount: 0, reward: 'subtle', view: 'vessels' },
      income: { amount: 150000, every: 'fortnightly', days: 14, next: iso(t + 4), anchor: iso(t + 4), reliable: true },
      sources: [{ id: 'spare', name: 'Unassigned money', kind: 'spare', balance: 0 }, { id: 'buffer', name: 'Safety buffer', kind: 'buffer', balance: 0 }],
      pots: [mk('p1', 'Rent', 70000, t + 18, 'fortnightly', 1, true, 0), mk('p2', 'Bills', 15000, t + 18, 'fortnightly', 1, true, 0),
        mk('p3', 'Car', 1000000, addMonths(t, 18), 'none', 2, false, 100000), mk('p4', 'Holiday', 300000, addMonths(t, 9), 'none', 4, false, 0)],
      ledger: [], lastSeen: now, achieved: [] };
    st.pots.forEach(p => { const o = p._open; delete p._open; emit(st, 'edit', { potId: p.id, cents: o, note: 'created' }, now); p.saved = o; });
    const sp = 30000; src(st, 'spare').balance = sp; emit(st, 'edit', { potId: 'spare', cents: sp, note: 'opening balance' }, now);
    refresh(st); return st;
  }
  /* turn anything (nothing, damaged, version 1 from phase 0) into a clean version 2 state */
  function migrate(raw, today) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pots)) return newState(today);
    if (raw.version >= 2) {
      const st = raw; st.settings = Object.assign({ mode: 'guided', bufferAuto: true, bufferAmount: 0, reward: 'subtle', view: 'vessels' }, st.settings || {});
      st.income = st.income || {}; if (!st.income.anchor) st.income.anchor = st.income.next;
      st.sources = Array.isArray(st.sources) ? st.sources : []; ['spare', 'buffer'].forEach(id => { if (!src(st, id)) st.sources.push({ id, name: id === 'spare' ? 'Unassigned money' : 'Safety buffer', kind: id, balance: 0 }); });
      st.ledger = Array.isArray(st.ledger) ? st.ledger : []; st.achieved = Array.isArray(st.achieved) ? st.achieved : []; st.lastSeen = +st.lastSeen || Date.now();
      return st;
    }
    /* version 1 -> 2 */
    const now = Date.now(), st = { version: 2, settings: { mode: raw.mode === 'free' ? 'free' : 'guided', bufferAuto: !(raw.buffer && raw.buffer.auto === false), bufferAmount: cents(+(raw.buffer && raw.buffer.amount) || 0), reward: 'subtle', view: 'vessels' },
      income: Object.assign({}, raw.income || {}), sources: [{ id: 'spare', name: 'Unassigned money', kind: 'spare', balance: 0 }, { id: 'buffer', name: 'Safety buffer', kind: 'buffer', balance: 0 }], pots: [], ledger: [], lastSeen: now, achieved: [] };
    st.income.anchor = st.income.next;
    (raw.pots || []).forEach((p, i) => { const q = { id: p.id != null ? String(p.id) : 'p' + i, name: String(p.name || 'Pot'), price: cents(+p.price || 0), due: p.due, repeat: STEP[p.repeat] ? p.repeat : 'none', priority: Math.min(5, Math.max(1, Math.round(+p.priority || 3))), firm: !!p.firm, saved: 0, valveRate: null, payFreq: p.payFreq || 'pay', createdAt: now, startSaved: cents(+p.saved || 0), lastDeal: null, status: 'active' }; st.pots.push(q); emit(st, 'edit', { potId: q.id, cents: q.startSaved, note: 'created' }, now); q.saved = q.startSaved; });
    const bs = cents(+(raw.buffer && raw.buffer.saved) || 0); if (bs) { src(st, 'buffer').balance = bs; emit(st, 'edit', { potId: 'buffer', cents: bs, note: 'opening balance' }, now); }
    refresh(st); return st;
  }
  const previewDeal = (st, day) => { const c = clean(st), ip = initPots(c, day); return dealCore(ip.pots, day, plannedPay(c.income), incDays(c.income)); };
  /* flow: how much the valves (or automatic paces) ask for each payday, against the spare income */
  function flowCheck(st, day) {
    const c = clean(st), idays = incDays(c.income), pay = plannedPay(c.income), ip = initPots(c, day), dr = dealCore(ip.pots, day, pay, idays);
    let bufferAsk = 0, committed = 0; const asks = {};
    dr.cand.forEach(x => { if (x.p.buffer) bufferAsk = x.ask; else { committed += x.ask; asks[x.p.id] = x.ask; } });
    const spare = pay - bufferAsk; return { pay, bufferAsk, spare, committed, over: Math.max(0, committed - spare), asks };
  }
  const valveRoom = (fc, id) => Math.max(0, fc.spare - (fc.committed - (fc.asks[id] || 0)));

  /* every payday that has come round since the page was last open: the income arrives, then the deal */
  function advance(st, nowMs) {
    const today = localDay(nowMs); let n = 0;
    while (n < 800) {
      const next = parseDate(st.income.next); if (next == null || next > today || !(st.income.amount > 0)) break;
      const c = clean(st), pay = plannedPay(c.income), ts = next * DAY + 12 * 36e5, ip = initPots(c, next), dr = dealCore(ip.pots, next, pay, incDays(c.income));
      emit(st, 'payday', { cents: pay, note: fmtISO(next) }, ts); src(st, 'spare').balance += pay;
      dr.cand.forEach(x => { const g = dr.gives[x.p.id]; if (!g) return; src(st, 'spare').balance -= g;
        if (x.p.buffer) { src(st, 'buffer').balance += g; emit(st, 'deal', { potId: 'buffer', cents: g }, ts); }
        else { const p = potById(st, x.p.id); p.saved += g; p.lastDeal = next; emit(st, 'deal', { potId: p.id, cents: g }, ts); } });
      refresh(st); st.income.next = fmtISO(payStep(c.income, next, 1)); n++;
    }
    st.lastSeen = nowMs; return n;
  }
  /* what each pot looks like right now: banked (solid), accruing towards the next payday (shimmer), and where it "should" be */
  function levelsAt(st, nowMs) {
    const c = clean(st), out = {}, nowF = localF(nowMs), next = c.income.next; if (next == null) return out;
    const prev = payStep(c.income, next, -1), span = Math.max(1, next - prev), f = Math.min(1, Math.max(0, (nowF - prev) / span)), dr = previewDeal(st, next);
    c.pots.forEach((p, i) => {
      if (p.status === 'harvested') return; const raw = st.pots[i], g = dr.gives[p.id] || 0, rem = Math.max(0, p.price - p.saved), cycle = p.repeat !== 'none' ? AVG[p.repeat] : 0;
      const startDay = cycle ? (p.due || 0) - cycle : localDay(raw.createdAt || nowMs), s0 = raw.startSaved || 0, span2 = Math.max(1, (p.due || 0) - startDay);
      const tickFrac = p.due == null ? 0 : Math.min(1, Math.max(0, (nowF - startDay) / span2));
      out[p.id] = { banked: p.saved, accruing: Math.min(rem, Math.round(g * f)), perPayday: g, perDay: g / span, tick: cycle ? Math.round(p.price * tickFrac) : Math.round(s0 + (p.price - s0) * tickFrac), ready: p.saved >= p.price, remaining: rem, price: p.price };
    });
    const bt = bufferTarget(c); if (bt > 0) { const g = dr.gives.buffer || 0, rem = Math.max(0, bt - c.buffer.saved); out.buffer = { banked: c.buffer.saved, accruing: Math.min(rem, Math.round(g * f)), perPayday: g, perDay: g / span, tick: -1, ready: false, remaining: rem, price: bt, buffer: true }; }
    return out;
  }
  function transfer(st, o, nowMs) {                                                // o: {potId, sourceId, cents, dir:'in'|'out'}
    const p = potById(st, o.potId), s = src(st, o.sourceId);
    if (!p || p.status === 'harvested' || !s || !(o.cents > 0)) return { ok: false, msg: 'Enter an amount first.' };
    if (o.dir === 'out') { if (o.cents > p.saved) return { ok: false, msg: 'That pot only holds ' + o.cents + ' cents.', max: p.saved }; p.saved -= o.cents; s.balance += o.cents; emit(st, 'withdraw', { potId: p.id, sourceId: s.id, cents: o.cents }, nowMs); }
    else { const room = Math.max(0, p.price - p.saved); if (o.cents > room) return { ok: false, msg: 'That pot only needs more.', max: room }; p.saved += o.cents; s.balance -= o.cents; emit(st, 'topup', { potId: p.id, sourceId: s.id, cents: o.cents }, nowMs); }
    refresh(st); return { ok: true };
  }
  /* Harvest: the pot is full and the money is spent on the thing. The level drops, the event is logged, a one-off goes to the shelf, a repeating pot starts its next cycle empty. */
  function harvest(st, potId, nowMs) {
    const p = potById(st, potId); if (!p || p.status === 'harvested' || p.price <= 0 || p.saved < p.price) return { ok: false };
    const today = localDay(nowMs), dueDay = parseDate(p.due), early = dueDay == null ? 0 : dueDay - today;
    p.saved -= p.price; emit(st, 'harvest', { potId: p.id, cents: p.price, note: fmtISO(today) }, nowMs);
    if (p.repeat !== 'none') { let d = stepAt(dueDay == null ? today : dueDay, STEP[p.repeat], 1); while (d <= today) d = stepAt(d, STEP[p.repeat], 1); p.due = fmtISO(d); p.lastDeal = null; refresh(st); return { ok: true, repeating: true }; }
    p.status = 'harvested'; st.achieved.push({ potId: p.id, name: p.name, price: p.price, saved: p.price, harvestedAt: nowMs, due: p.due, daysEarly: early });
    return { ok: true, repeating: false };
  }
  /* write the changes a person made by hand (new pot, deleted pot, changed amounts) into the ledger */
  function reconcile(prev, next, nowMs) {
    const pm = {}; prev.pots.forEach(p => pm[p.id] = p);
    next.pots.forEach(p => { const o = pm[p.id];
      if (!o) { if (p.createdAt == null) p.createdAt = nowMs; if (p.startSaved == null) p.startSaved = p.saved; emit(next, 'edit', { potId: p.id, cents: p.saved, note: 'created ' + p.name }, nowMs); return; }
      if (o.saved !== p.saved) emit(next, 'edit', { potId: p.id, cents: p.saved - o.saved, note: 'saved changed by hand' }, nowMs);
      ['name', 'price', 'due', 'repeat', 'priority', 'firm', 'valveRate', 'payFreq'].forEach(k => { if (o[k] !== p[k]) emit(next, 'edit', { potId: p.id, cents: 0, note: k + ': ' + o[k] + ' → ' + p[k] }, nowMs); });
      delete pm[p.id]; });
    Object.keys(pm).forEach(id => emit(next, 'edit', { potId: id, cents: -pm[id].saved, note: 'deleted ' + pm[id].name }, nowMs));
    ['spare', 'buffer'].forEach(id => { const a = src(prev, id), b = src(next, id); if (a && b && a.balance !== b.balance) emit(next, 'edit', { potId: id, cents: b.balance - a.balance, note: id + ' changed by hand' }, nowMs); });
    ['amount', 'every', 'days', 'next', 'reliable'].forEach(k => { if (prev.income[k] !== next.income[k]) emit(next, 'edit', { cents: 0, note: 'income ' + k + ': ' + prev.income[k] + ' → ' + next.income[k] }, nowMs); });
  }
  /* rebuild every level from the ledger alone */
  function replay(ledger) {
    const pots = {}, s = { spare: 0, buffer: 0 }, add = (id, c) => { pots[id] = (pots[id] || 0) + c; };
    ledger.forEach(e => { const c = e.cents || 0;
      switch (e.type) {
        case 'payday': s.spare += c; break;
        case 'deal': s.spare -= c; if (e.potId === 'buffer') s.buffer += c; else add(e.potId, c); break;
        case 'topup': add(e.potId, c); s[e.sourceId] -= c; break;
        case 'withdraw': add(e.potId, -c); s[e.sourceId] += c; break;
        case 'harvest': add(e.potId, -c); break;
        case 'edit': if (e.potId === 'spare' || e.potId === 'buffer') s[e.potId] += c; else if (e.potId != null) add(e.potId, c); break;
      } });
    return { pots, spare: s.spare, buffer: s.buffer };
  }
  const replayMatches = st => { const r = replay(st.ledger); return st.pots.every(p => (r.pots[p.id] || 0) === p.saved) && r.spare === src(st, 'spare').balance && r.buffer === src(st, 'buffer').balance; };

  /* ---------- the answer: green, amber or red ---------- */
  function assess(state, o) {
    o = o || {}; const today = o.today != null ? o.today : todayDay(), c = clean(state); c.pots = c.pots.filter(p => p.status !== 'harvested');
    const res = { state: c, today, verdict: 'green', lines: [], option: null, rows: [], totals: null, ready: true };
    if (!c.income.amount || c.income.next == null) { res.ready = false; res.verdict = 'none'; res.headline = 'Enter your income and your next payday to see the plan.'; return res; }
    const idays = incDays(c.income), pay = plannedPay(c.income), sim = simulate(c, { today, log: o.log });
    const bt = bufferTarget(c), bufTop = bt > c.buffer.saved ? ceilI((bt - c.buffer.saved) * idays / Math.max(idays, BUF_DAYS)) : 0;
    const bad = c.pots.filter(p => p.due == null || p.price <= 0);
    res.rows = c.pots.map(p => {
      const s = sim.pots.find(x => x.id === p.id);
      if (!s) return { id: p.id, name: p.name, invalid: true, firm: p.firm, note: p.due == null ? 'Needs a due date' : 'Needs a price' };
      const pc = paceOf({ price: s.price, saved: p.saved, due: s.firstDue, repeat: p.repeat }, today, idays);
      const missed0 = s.misses.find(m => m.cycle === 0), late = s.firstFull != null ? s.firstFull - s.firstDue : null;
      let status = 'ontrack'; if (p.saved >= p.price && !s.misses.length) status = 'full'; else if (missed0 || (late != null && late > 0) || (s.firstFull == null)) status = 'behind';
      return { id: p.id, name: p.name, firm: p.firm, priority: p.priority, repeat: p.repeat, price: p.price, saved: p.saved, due: s.firstDue, remaining: pc.remaining, perDay: pc.perDay, perPay: pc.perPay,
        fullOn: s.firstFull, slipDays: late, valve: p.valve, status, misses: s.misses.length, firstMiss: s.misses[0] || null, laterMisses: s.misses.filter(m => m.cycle > 0).length };
    });
    const live = res.rows.filter(r => !r.invalid);
    const paceTotal = live.reduce((a, r) => a + r.perPay, 0), spare = pay - bufTop;
    res.totals = { income: pay, bufferTarget: bt, bufferTopUp: bufTop, spare, paceTotal, left: spare - paceTotal, idays, varies: c.income.reliable === false };
    if (bad.length) res.lines.push('Some pots are missing a due date or a price, so they are left out: ' + bad.map(p => p.name).join(', ') + '.');
    const firmMiss = sim.misses.filter(m => m.firm).sort((a, b) => a.due - b.due), flexLate = live.filter(r => !r.firm && r.status === 'behind');
    if (firmMiss.length || spare < 0) {
      res.verdict = 'red'; res.firmMiss = firmMiss[0] || null;
      const m = firmMiss[0], firmNeed = live.filter(r => r.firm).reduce((a, r) => a + r.perPay, 0);
      if (m) res.why = { pot: m.name, due: m.due, short: m.short, firmNeed, income: pay, count: firmMiss.length };
      else res.why = { pot: null, firmNeed, income: pay, count: 0 };
      /* nearest workable option: the smallest extra income per pay that stops every firm miss */
      const fits = x => !simulate(c, { today, extra: x }).misses.some(q => q.firm);
      let hi = 100, cap = Math.max(pay, 100000) * 20; while (!fits(hi) && hi < cap) hi *= 2;
      if (fits(hi)) { let lo = 0; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) hi = mid; else lo = mid; } res.option = { extra: hi }; }
      else res.option = { extra: null };
    } else if (flexLate.length || sim.misses.length) {
      res.verdict = 'amber';
      res.slips = flexLate.map(r => ({ id: r.id, name: r.name, due: r.due, fullOn: r.fullOn, slipDays: r.slipDays, short: r.firstMiss ? r.firstMiss.short : null, repeat: r.repeat }));
      res.option = { moves: res.slips.filter(s => s.fullOn != null && s.repeat === 'none').map(s => ({ name: s.name, to: s.fullOn })) };
    }
    res.sim = sim; return res;
  }

  /* ---------- self-checks ---------- */
  function selfTest() {
    const T = []; const ok = (name, v) => T.push([name, !!v]); const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);
    const day = parseDate('2026-01-02');
    const base = (over) => Object.assign({ income: { amount: 150000, every: 'fortnightly', next: '2026-01-02', reliable: true }, pots: [], buffer: { auto: false, amount: 0, saved: 0 } }, over || {});
    const pot = (o) => Object.assign({ id: 'x', name: 'X', price: 0, due: '2027-01-02', repeat: 'none', priority: 3, firm: false, saved: 0, payFreq: 'pay' }, o);
    /* equations */
    const g = eq.G(1000, 100, 0.01, 12);
    ok('Goal G from start, payment, rate and count', near(g, 1000 * Math.pow(1.01, 12) + 100 * (Math.pow(1.01, 12) - 1) / 0.01, 1e-6) && Math.abs(g - 2395.07) < 0.01);
    ok('Solve P gives the payment back', near(eq.P(g, 1000, 0.01, 12), 100, 1e-6));
    ok('Solve S gives the start back', near(eq.S(g, 100, 0.01, 12), 1000, 1e-6));
    ok('Solve n gives the number of payments back', near(eq.n(g, 1000, 100, 0.01), 12, 1e-6));
    ok('Solve r by search gives the rate back', near(solve({ G: g, S: 1000, P: 100, n: 12 }, 'r'), 0.01, 1e-9));
    ok('Solve f by search gives payments per year back', near(solve({ G: eq.G(1000, 100, 0.06 / 12, 2 * 12), S: 1000, P: 100, i: 0.06, t: 2 }, 'f'), 12, 1e-6));
    ok('r = 0: G = S + P·n, and P and n invert it', eq.G(1000, 100, 0, 12) === 2200 && eq.P(2200, 1000, 0, 12) === 100 && eq.n(2200, 1000, 100, 0) === 12 && eq.S(2200, 100, 0, 12) === 1000);
    ok('Money answers are rounded to whole cents', solve({ G: 1000, S: 0, i: 0, f: 3, t: 1 }, 'P') === 333.33);
    /* pace */
    const pc = paceOf({ price: 1000000, saved: 100000, due: day + 546, repeat: 'none' }, day, 14);
    ok('Pace = remaining ÷ days left, shown per payday', pc.remaining === 900000 && near(pc.perDay, 900000 / 546, 1e-9) && pc.perPay === Math.round(900000 / 546 * 14));
    /* deal order and cents */
    const sc = base({ income: { amount: 100000, every: 'fortnightly', next: '2026-01-02', reliable: true }, pots: [
      pot({ id: 'a', name: 'Flex', price: 100000, due: '2026-01-16', priority: 1 }), pot({ id: 'b', name: 'Rent', price: 100000, due: '2026-01-16', priority: 5, firm: true })] });
    const s1 = simulate(sc, { today: day, log: true, days: 20 });
    ok('Deal order: a firm pot is paid before a flexible one, even at lower priority', s1.log[0].gives.b === 100000 && !s1.log[0].gives.a);
    const l = simulate(base({ income: { amount: 100001, every: 'fortnightly', next: '2026-01-02', reliable: true }, pots: [pot({ id: 'a', price: 33333, due: '2027-01-02' }), pot({ id: 'b', price: 77777, due: '2027-01-02', priority: 2 })] }), { today: day, days: 400 });
    ok('Whole cents: no cent is created or lost', l.ledger.start + l.ledger.income === l.ledger.paidOut + l.ledger.lost + l.ledger.unassigned + l.ledger.end);
    /* cascade */
    const cs = simulate(base({ pots: [pot({ id: 'a', name: 'Small', price: 20000, due: '2026-02-13', priority: 1 }), pot({ id: 'b', name: 'Big', price: 900000, due: '2027-01-02', priority: 2 })] }), { today: day, log: true, days: 60 });
    const first = cs.log[0].gives, second = cs.log[1].gives;
    ok('Cascade: when a pot is full its share moves on to the next pot', cs.pots[0].firstFull === day && (second.b || 0) > 0 && first.b >= 20000 && (second.a || 0) === 0);
    /* squeeze */
    const sq = simulate(base({ income: { amount: 100000, every: 'fortnightly', next: '2026-01-02', reliable: true }, pots: [
      pot({ id: 'r', name: 'Rent', price: 70000, due: '2026-01-16', repeat: 'fortnightly', firm: true, priority: 1 }),
      pot({ id: 'c', name: 'Car', price: 1000000, due: '2026-07-02', priority: 2 }), pot({ id: 'h', name: 'Holiday', price: 300000, due: '2026-07-02', priority: 4 })] }), { today: day, log: true, days: 120 });
    const w = sq.log[2];
    ok('Squeeze: firm pots are never cut, lower priority slows first', !sq.misses.some(m => m.firm) && w.gives.r === 70000 && (w.gives.c || 0) >= (w.gives.h || 0) && (w.gives.h || 0) <= w.asks.find(a => a[0] === 'h')[1]);
    /* the seeded example is green; the red case is red and the fix works */
    const seed = { income: { amount: 150000, every: 'fortnightly', next: '2026-01-06', reliable: true }, pots: [
      pot({ id: 'rent', name: 'Rent', price: 70000, due: '2026-01-20', repeat: 'fortnightly', firm: true, priority: 1 }), pot({ id: 'bills', name: 'Bills', price: 15000, due: '2026-01-20', repeat: 'fortnightly', firm: true, priority: 1 }),
      pot({ id: 'car', name: 'Car', price: 1000000, due: '2027-07-02', priority: 2, saved: 100000 }), pot({ id: 'hol', name: 'Holiday', price: 300000, due: '2026-10-02', priority: 4 })], buffer: { auto: true, amount: 0, saved: 0 } };
    ok('The example budget comes out green', assess(seed, { today: day }).verdict === 'green');
    const tight = JSON.parse(JSON.stringify(seed)); tight.income.amount = 80000;
    const ra = assess(tight, { today: day });
    ok('A red case: firm costs above income are red, name the pot, and offer a fix that works', ra.verdict === 'red' && ra.why && ra.why.pot && ra.option && ra.option.extra > 0 &&
      (() => { const t2 = JSON.parse(JSON.stringify(tight)); t2.income.amount += ra.option.extra; return assess(t2, { today: day }).verdict !== 'red'; })());
    const am = JSON.parse(JSON.stringify(seed)); am.income.amount = 108000;
    ok('An amber case: only flexible pots slip, and it says which', (() => { const a = assess(am, { today: day }); return a.verdict === 'amber' && a.slips && a.slips.length > 0 && !a.slips.some(s => s.name === 'Rent'); })());
    /* ---- phase 1: ledger, valves, fast-forward, harvest ---- */
    const ts = (y, m, d, h) => new Date(y, m - 1, d, h == null ? 12 : h).getTime(), clone = o => JSON.parse(JSON.stringify(o));
    const s0 = newState(localDay(ts(2026, 1, 2)));
    ok('Ledger replay: rebuilding from the ledger matches the saved levels', (() => {
      const s = clone(s0); advance(s, ts(2026, 3, 30)); const prev = clone(s);
      s.pots.push({ id: 't', name: 'T', price: 5000, due: '2026-12-01', repeat: 'none', priority: 3, firm: false, saved: 4000, valveRate: null, payFreq: 'pay', createdAt: ts(2026, 3, 30), startSaved: 4000, lastDeal: null, status: 'active' });
      potById(s, 'p3').saved += 2500; reconcile(prev, s, ts(2026, 3, 30));
      transfer(s, { potId: 't', sourceId: 'spare', cents: 1000, dir: 'in' }, ts(2026, 3, 30)); transfer(s, { potId: 'p4', sourceId: 'buffer', cents: 5000, dir: 'in' }, ts(2026, 3, 30)); transfer(s, { potId: 'p4', sourceId: 'spare', cents: 2000, dir: 'out' }, ts(2026, 3, 30));
      harvest(s, 't', ts(2026, 3, 30)); advance(s, ts(2026, 6, 30)); return replayMatches(s) && s.ledger.filter(e => e.type === 'harvest').length === 1;
    })());
    const fc = flowCheck(s0, localDay(ts(2026, 1, 6)));
    ok('Valve cap: valves past the spare income are flagged, and the room left is exact', (() => {
      const s = clone(s0); potById(s, 'p4').valveRate = 10000000; const f1 = flowCheck(s, fc.pay ? localDay(ts(2026, 1, 6)) : 0), room = valveRoom(f1, 'p4');
      potById(s, 'p4').valveRate = Math.min(room, potById(s, 'p4').price); const f2 = flowCheck(s, localDay(ts(2026, 1, 6)));
      return f1.over > 0 && f2.over === 0 && room === f2.spare - (f2.committed - f2.asks.p4) + 0 && fc.over === 0;
    })());
    ok('A valve gives exactly its amount each payday', (() => { const s = clone(s0); potById(s, 'p4').valveRate = 20000; const r = simulate(s, { today: localDay(ts(2026, 1, 2)), log: true, days: 40 }); return r.log.length >= 2 && r.log.every(l => l.gives.p4 === 20000); })());
    ok('Fast-forward: catching up in one go equals living it payday by payday', (() => {
      const a = clone(s0), b = clone(s0); advance(a, ts(2026, 2, 5)); [ts(2026, 1, 6), ts(2026, 1, 20), ts(2026, 2, 3), ts(2026, 2, 5)].forEach(t => advance(b, t));
      return a.ledger.length === b.ledger.length && a.pots.every((p, i) => p.saved === b.pots[i].saved) && src(a, 'spare').balance === src(b, 'spare').balance && a.income.next === b.income.next && replayMatches(a);
    })());
    ok('Live creep: halfway between paydays, half of the next deal is shimmering', (() => {
      const a = clone(s0); advance(a, ts(2026, 2, 5)); const half = new Date(2026, 1, 10, 0, 0).getTime(), L = levelsAt(a, half), g = previewDeal(a, parseDate(a.income.next)).gives.p3;
      return L.p3.banked === potById(a, 'p3').saved && Math.abs(L.p3.accruing - Math.round(g / 2)) <= 1 && g > 0;
    })());
    ok('Harvest: a full repeating pot empties and starts its next cycle; a one-off goes to the shelf', (() => {
      const s = clone(s0), day = ts(2026, 1, 3), rent = potById(s, 'p1'); const early = harvest(s, 'p1', day); rent.saved = rent.price + 500; refresh(s);
      const due0 = parseDate(rent.due), r1 = harvest(s, 'p1', day), car = potById(s, 'p3'); car.saved = car.price; const r2 = harvest(s, 'p3', day);
      return !early.ok && r1.ok && rent.saved === 500 && parseDate(rent.due) === due0 + 14 && r2.ok && car.status === 'harvested' && s.achieved.length === 1 && s.achieved[0].name === 'Car' && !simulate(s, { today: localDay(day) }).pots.some(p => p.id === 'p3') && s.ledger.filter(e => e.type === 'harvest').length === 2;
    })());
    ok('Migration: a phase-0 save becomes version 2 with the same pots and a matching ledger', (() => {
      const old = { v: 1, mode: 'free', income: seed.income, pots: seed.pots.map(p => Object.assign({}, p)), buffer: { auto: true, amount: 0, saved: 1234 }, log: [] };
      const m = migrate(old, day); return m.version === 2 && m.settings.mode === 'free' && m.pots.length === 4 && m.pots[2].saved === 100000 && src(m, 'buffer').balance === 1234 && replayMatches(m);
    })());
    return T;
  }

  root.CashFlow = { note: (st, text) => emit(st, 'guardian', { note: text }), eq, solve, simulate, assess, newState, migrate, advance, levelsAt, previewDeal, flowCheck, valveRoom, transfer, harvest, reconcile, replay, replayMatches, localDay, refresh, clean, paceOf, bufferTarget, selfTest, parseDate, fmtISO, addMonths, todayDay, toDay, AVG, VARY, BUF_DAYS, HORIZON };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CashFlow;
})(typeof window !== 'undefined' ? window : globalThis);
