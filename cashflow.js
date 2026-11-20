/* Cash-flow engine. Plain JS, no dependencies. Exposes window.CashFlow (or module.exports in Node).
   All money is whole cents (integers). Dates are whole day numbers (days since 1 Jan 1970, UTC).
   Pots: {id,name,price,due,repeat,priority,firm,saved,payFreq}  Income: {amount,every,days,next,reliable}
   Rules in plain words are in the comments next to each step. */
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

  /* ---------- cleaning ---------- */
  function clean(st) {
    const inc = st.income || {}, every = ['weekly', 'fortnightly', 'monthly', 'custom'].includes(inc.every) ? inc.every : 'fortnightly';
    const income = { amount: Math.max(0, cents(+inc.amount || 0)), every, days: Math.max(1, Math.round(+inc.days || 14)), next: parseDate(inc.next), reliable: inc.reliable !== false };
    const pots = (st.pots || []).map((p, i) => ({
      id: p.id != null ? String(p.id) : 'p' + i, name: String(p.name || 'Pot ' + (i + 1)), price: Math.max(0, cents(+p.price || 0)), due: parseDate(p.due),
      repeat: STEP[p.repeat] ? p.repeat : 'none', priority: Math.min(5, Math.max(1, Math.round(+p.priority || 3))), firm: !!p.firm,
      saved: Math.max(0, cents(+p.saved || 0)), payFreq: STEP[p.payFreq] && p.payFreq !== 'quarterly' && p.payFreq !== 'yearly' ? p.payFreq : 'pay'
    }));
    const b = st.buffer || {};
    return { income, pots, buffer: { auto: b.auto !== false, amount: Math.max(0, cents(+b.amount || 0)), saved: Math.max(0, cents(+b.saved || 0)) } };
  }
  /* default buffer = 2 weeks of firm repeating pots, whole cents */
  function bufferTarget(c) {
    if (!c.buffer.auto) return c.buffer.amount;
    let t = 0; c.pots.forEach(p => { if (p.firm && p.repeat !== 'none' && p.price > 0) t += Math.round(p.price * 14 / AVG[p.repeat]); }); return t;
  }

  /* ---------- pace: remaining / time left, per day, shown per pay ---------- */
  function paceOf(p, today, days) {
    const rem = Math.max(0, p.price - p.saved), dl = Math.max(1, p.due - today);
    let perDay = rem / dl; if (p.repeat !== 'none') perDay = Math.max(perDay, p.price / AVG[p.repeat]);
    perDay = Math.min(perDay, rem > 0 ? Infinity : 0);
    return { remaining: rem, daysLeft: dl, perDay, perPay: rem > 0 ? Math.min(rem, Math.round(perDay * days)) : 0 };
  }

  /* ---------- the payday-by-payday simulation ---------- */
  function simulate(st, o) {
    o = o || {}; const c = clean(st), today = o.today, extra = o.extra || 0, horizon = today + (o.days || HORIZON);
    const inc = c.income, idays = incDays(inc), ist = incStep(inc), pay = Math.max(0, plannedPay(inc) + extra);
    const pots = [];
    c.pots.forEach((p, idx) => {
      if (p.due == null || p.price <= 0) return;
      const rep = p.repeat !== 'none' ? STEP[p.repeat] : null, base = p.due; let cyc = 0, due = base;
      if (rep) while (due < today) { cyc++; due = stepAt(base, rep, cyc); }   // a repeating pot rolls forward to its next due date
      pots.push({ id: p.id, name: p.name, idx, price: p.price, saved: p.saved, due, base, rep, cyc, cycleDays: rep ? AVG[p.repeat] : 0, prio: p.priority, firm: p.firm,
        own: p.payFreq === 'pay' ? 0 : AVG[p.payFreq], last: -1e9, done: false, overdue: false, c0: true, firstFull: p.saved >= p.price ? today : null, firstDue: due,
        paidOut: 0, lost: 0, cycles: 0, misses: [], got: 0 });
    });
    const bt = bufferTarget(c), buf = bt > 0 ? { id: 'buffer', name: 'Safety buffer', buffer: true, price: bt, saved: c.buffer.saved, firm: true, prio: 0, got: 0 } : null;
    if (buf) pots.push(buf);
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
      let avail = pay; const cand = [];
      pots.forEach((p, order) => {
        if (p.done) return; const rem = p.price - p.saved; if (rem <= 0) return;
        const dl = p.buffer ? Infinity : Math.max(0, p.due - pd);
        if (p.own && pd < p.last + p.own - Math.floor(idays / 2) && pd + idays <= p.due) return;      // own, slower payment rhythm
        const step = Math.max(idays, p.own || 0);
        let ask;
        if (p.buffer) ask = ceilI(rem * step / Math.max(step, BUF_DAYS));
        else { ask = dl <= step || p.overdue ? rem : ceilI(rem * step / dl); if (p.cycleDays) ask = Math.max(ask, ceilI(p.price * step / p.cycleDays)); }
        ask = Math.min(ask, rem);
        const risk = !p.buffer && p.firm && (p.overdue || dl <= step * 1.5);
        cand.push({ p, ask, rem, order, grp: p.buffer ? 2 : p.firm ? (risk ? 0 : 1) : 3 });
      });
      /* order: firm pots whose deadline is close, other firm pots, the buffer, then everything else by priority (1 first), then earliest date */
      cand.sort((a, b) => a.grp - b.grp || a.p.prio - b.p.prio || (a.p.due || 0) - (b.p.due || 0) || a.order - b.order);
      const gives = {};
      cand.forEach(x => { const g = Math.min(x.ask, avail); gives[x.p.id] = g; avail -= g; });
      cand.forEach(x => { if (x.p.buffer) return; const g = Math.min(x.rem - gives[x.p.id], avail); gives[x.p.id] += g; avail -= g; });   // cascade: spare money moves on down the line
      cand.forEach(x => {
        const g = gives[x.p.id], p = x.p; if (!g) return; p.saved += g; p.got += g; p.last = pd;
        if (!p.buffer && p.saved >= p.price) { if (p.c0 && p.firstFull == null) p.firstFull = pd; if (p.overdue) { p.paidOut += p.price; ledger.paidOut += p.price; p.saved -= p.price; p.done = true; p.cycles++; } }
      });
      ledger.unassigned += avail;
      if (o.log) log.push({ day: pd, pay, gives, left: avail, asks: cand.map(x => [x.p.id, x.ask]) });
      pi++; pd = stepAt(inc.next, ist, pi);
    }
    resolve(horizon + 1);
    ledger.end = pots.reduce((a, p) => a + p.saved, 0);
    return { pots, buffer: buf, misses, ledger, log, today, pay, idays, bufferTarget: bt };
  }

  /* ---------- the answer: green, amber or red ---------- */
  function assess(state, o) {
    o = o || {}; const today = o.today != null ? o.today : todayDay(), c = clean(state);
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
        fullOn: s.firstFull, slipDays: late, status, misses: s.misses.length, firstMiss: s.misses[0] || null, laterMisses: s.misses.filter(m => m.cycle > 0).length };
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
    return T;
  }

  root.CashFlow = { eq, solve, simulate, assess, clean, paceOf, bufferTarget, selfTest, parseDate, fmtISO, addMonths, todayDay, toDay, AVG, VARY, BUF_DAYS, HORIZON };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CashFlow;
})(typeof window !== 'undefined' ? window : globalThis);
