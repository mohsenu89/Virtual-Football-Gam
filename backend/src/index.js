import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" }
});
const fail = (message, status = 400) => json({ error: message }, status);
const hashText = (value) => { let h = 2166136261; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function makeToken(id, secret) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const body = id + "." + exp;
  return body + "." + await sign(body, secret);
}
async function readToken(request, env) {
  const raw = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = raw.split(".");
  if (parts.length !== 3 || !env.GUEST_SECRET) return null;
  const body = parts[0] + "." + parts[1];
  if (Number(parts[1]) < Math.floor(Date.now() / 1000)) return null;
  const expected = await sign(body, env.GUEST_SECRET);
  if (expected !== parts[2]) return null;
  return parts[0];
}
async function room(env, id) {
  const stub = env.MATCH_ROOMS.getByName(id);
  return stub;
}
function roundRobin() {
  let list = [1,2,3,4,5,6,7,8,9,10];
  const rounds = [];
  for (let r = 0; r < 9; r++) {
    const games = [];
    for (let i = 0; i < 5; i++) {
      let home = list[i], away = list[9-i];
      if (r % 2) { const t = home; home = away; away = t; }
      games.push([home, away]);
    }
    rounds.push(games);
    list = [list[0], list[9], ...list.slice(1, 9)];
  }
  return rounds;
}
async function ensureSchedule(env) {
  const rounds = roundRobin();
  const now = new Date();
  for (let offset = 0; offset < 3; offset++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    const key = day.toISOString().slice(0,10).replace(/-/g, "");
    const dayNumber = Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 86400000);
    const round = rounds[dayNumber % 9];
    for (let i = 0; i < round.length; i++) {
      const starts = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 8 + i * 3, 0, 0);
      const id = key + "-r" + (dayNumber % 9 + 1) + "-m" + (i + 1);
      const seed = hashText(id);
      const homeOdds = 1.75 + (seed % 90) / 100;
      const awayOdds = 1.85 + ((seed >>> 7) % 110) / 100;
      await env.DB.prepare("INSERT OR IGNORE INTO matches(id,round_no,home_team_id,away_team_id,starts_at,status,seed,odds_home,odds_draw,odds_away,created_at) VALUES(?,?,?,?,?,'scheduled',?,?,?,?,?)")
        .bind(id, dayNumber % 9 + 1, round[i][0], round[i][1], starts, seed, homeOdds, 3.0 + ((seed >>> 13) % 80) / 100, awayOdds, Date.now()).run();
    }
  }
  const upcoming = await env.DB.prepare("SELECT id FROM matches WHERE status='scheduled' AND starts_at BETWEEN ? AND ? ORDER BY starts_at LIMIT 20")
    .bind(Date.now(), Date.now() + 3 * 86400000).all();
  for (const item of upcoming.results || []) {
    const stub = await room(env, item.id);
    await stub.fetch("https://room/arm", { method: "POST" });
  }
}
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true, service: "virtual-football-online", now: Date.now() });
      if (path === "/api/guest" && request.method === "POST") {
        if (!env.GUEST_SECRET) return fail("السيرفر يحتاج ضبط GUEST_SECRET أولاً", 503);
        const body = await request.json();
        const nickname = String(body.nickname || "").trim().replace(/[<>]/g, "").slice(0, 18);
        if (nickname.length < 2) return fail("اكتب اسماً من حرفين على الأقل");
        const id = crypto.randomUUID();
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO users(id,nickname,created_at) VALUES(?,?,?)").bind(id, nickname, now),
          env.DB.prepare("INSERT INTO wallets(user_id,balance,updated_at) VALUES(?,1000,?)").bind(id, now)
        ]);
        return json({ token: await makeToken(id, env.GUEST_SECRET), user: { id, nickname, balance: 1000 } }, 201);
      }
      if (path === "/api/me" && request.method === "GET") {
        const userId = await readToken(request, env);
        if (!userId) return fail("انتهت جلسة الزائر؛ سجّل الدخول باسمك مرة أخرى", 401);
        const row = await env.DB.prepare("SELECT u.id,u.nickname,w.balance FROM users u JOIN wallets w ON w.user_id=u.id WHERE u.id=?").bind(userId).first();
        return row ? json({ user: row }) : fail("المستخدم غير موجود", 401);
      }
      if (path === "/api/matches" && request.method === "GET") {
        const now = Date.now();
        const rows = await env.DB.prepare("SELECT m.id,m.round_no,m.starts_at,m.status,m.home_score,m.away_score,m.odds_home,m.odds_draw,m.odds_away,ht.name home_name,ht.logo_path home_logo,at.name away_name,at.logo_path away_logo FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.starts_at BETWEEN ? AND ? ORDER BY m.starts_at LIMIT 60")
          .bind(now - 86400000, now + 7 * 86400000).all();
        return json({ matches: rows.results || [] });
      }
      if (path === "/api/wallet" && request.method === "GET") {
        const userId = await readToken(request, env);
        if (!userId) return fail("سجّل الدخول أولاً", 401);
        const row = await env.DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(userId).first();
        return row ? json(row) : fail("المحفظة غير موجودة", 404);
      }
      const matchRoute = path.match(/^\/api\/matches\/([^/]+)(?:\/(bets|live))?$/);
      if (matchRoute) {
        const id = decodeURIComponent(matchRoute[1]);
        const action = matchRoute[2] || "snapshot";
        const stub = await room(env, id);
        if (action === "live") {
          if (request.headers.get("Upgrade") !== "websocket") return fail("WebSocket upgrade مطلوب", 426);
          return stub.fetch("https://room/connect", request);
        }
        if (action === "bets" && request.method === "POST") {
          const userId = await readToken(request, env);
          if (!userId) return fail("سجّل الدخول أولاً", 401);
          const body = await request.json();
          return stub.fetch("https://room/bet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, pick: body.pick, stake: body.stake }) });
        }
        if (request.method === "GET") return stub.fetch("https://room/snapshot");
      }
      return fail("المسار غير موجود", 404);
    } catch (error) {
      return fail(error && error.message ? error.message : "حدث خطأ في السيرفر", 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(ensureSchedule(env));
  }
};

export class MatchRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }
  async loadState() {
    let state = await this.ctx.storage.get("state");
    if (state) return state;
    const match = await this.env.DB.prepare("SELECT m.*,ht.name home_name,ht.logo_path home_logo,ht.color home_color,at.name away_name,at.logo_path away_logo,at.color away_color FROM matches m JOIN teams ht ON ht.id=m.home_team_id JOIN teams at ON at.id=m.away_team_id WHERE m.id=?")
      .bind(this.ctx.id.name).first();
    if (!match) throw new Error("المباراة غير موجودة");
    let seed = match.seed >>> 0;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const count = Math.floor(rand() * 5);
    const goals = [];
    for (let i = 0; i < count; i++) goals.push({ minute: 5 + Math.floor(rand() * 81), team: rand() < 0.5 ? 0 : 1 });
    goals.sort((a,b) => a.minute - b.minute);
    state = { id: match.id, status: match.status, startsAt: match.starts_at, seed: match.seed, home: { id: match.home_team_id, name: match.home_name, logo: match.home_logo, color: match.home_color }, away: { id: match.away_team_id, name: match.away_name, logo: match.away_logo, color: match.away_color }, score: [match.home_score, match.away_score], goals, goalIndex: 0, events: [], minute: 0, updatedAt: Date.now() };
    await this.ctx.storage.put("state", state);
    return state;
  }
  playersFor(state, minute) {
    const base = [[.05,.5],[.2,.16],[.2,.38],[.2,.62],[.2,.84],[.39,.17],[.39,.39],[.39,.61],[.39,.83],[.62,.36],[.62,.64]];
    const players = [];
    for (let team = 0; team < 2; team++) for (let i = 0; i < 11; i++) {
      const p = base[i], dir = team === 0 ? 1 : -1;
      const x0 = team === 0 ? p[0] : 1 - p[0];
      const wave = Math.sin(minute * .19 + i * 1.73 + team * 2.1 + state.seed % 31) * .022;
      const push = Math.sin(minute * .055 + state.seed % 17) * .07 * dir;
      players.push({ team, keeper: i === 0, x: Math.max(.025, Math.min(.975, x0 + wave + push)), y: Math.max(.04, Math.min(.96, p[1] + Math.cos(minute * .13 + i * 1.31 + team) * .035)) });
    }
    return players;
  }
  snapshot(state) {
    const phase = state.status === "scheduled" ? "قبل المباراة" : state.status === "live" ? (state.minute >= 45 ? "الشوط الثاني" : "الشوط الأول") : "انتهت المباراة";
    const t = state.minute;
    return { matchId: state.id, status: state.status, startsAt: state.startsAt, minute: state.minute, phase, score: state.score, home: state.home, away: state.away, players: this.playersFor(state, t), ball: { x: .5 + Math.sin(t * .09 + state.seed % 9) * .24, y: .5 + Math.cos(t * .12 + state.seed % 7) * .22 }, events: state.events, updatedAt: state.updatedAt };
  }
  async arm() {
    const state = await this.loadState();
    if (state.status === "scheduled" && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, state.startsAt));
  }
  async handleBet(body) {
    const state = await this.loadState();
    const stake = Math.floor(Number(body.stake));
    const pick = String(body.pick || "");
    if (state.status !== "scheduled" || Date.now() >= state.startsAt) throw new Error("انتهى وقت الرهان؛ المباراة بدأت أو اقترب موعدها");
    if (!["home","draw","away"].includes(pick)) throw new Error("اختيار الرهان غير صحيح");
    if (!Number.isInteger(stake) || stake < 1 || stake > 500) throw new Error("قيمة الرهان من 1 إلى 500 نقطة");
    const odds = pick === "home" ? 2.1 : pick === "draw" ? 3.2 : 2.8;
    const debit = await this.env.DB.prepare("UPDATE wallets SET balance=balance-?,updated_at=? WHERE user_id=? AND balance>=? RETURNING balance")
      .bind(stake, Date.now(), body.userId, stake).first();
    if (!debit) throw new Error("رصيدك التجريبي غير كافٍ");
    try {
      await this.env.DB.prepare("INSERT INTO bets(id,user_id,match_id,pick,stake,odds,status,created_at) VALUES(?,?,?,?,?,?,'open',?)")
        .bind(crypto.randomUUID(), body.userId, state.id, pick, stake, odds, Date.now()).run();
    } catch (error) {
      await this.env.DB.prepare("UPDATE wallets SET balance=balance+?,updated_at=? WHERE user_id=?").bind(stake, Date.now(), body.userId).run();
      throw new Error("لديك رهان مسجل بالفعل على هذه المباراة");
    }
    await this.ctx.storage.put("state", state);
    return json({ ok: true, balance: debit.balance, odds, message: "تم تسجيل الرهان التجريبي" });
  }
  async advance() {
    const state = await this.loadState();
    const now = Date.now();
    if (state.status === "scheduled" && now < state.startsAt) return state;
    if (state.status === "scheduled") {
      state.status = "live";
      state.updatedAt = now;
      await this.env.DB.prepare("UPDATE matches SET status='live' WHERE id=? AND status='scheduled'").bind(state.id).run();
      state.events.push({ minute: 0, text: "انطلاق المباراة" });
    }
    if (state.status !== "live") return state;
    state.minute = Math.min(90, Math.floor(Math.max(0, now - state.startsAt) / 2000));
    const inserts = [];
    while (state.goalIndex < state.goals.length && state.goals[state.goalIndex].minute <= state.minute) {
      const goal = state.goals[state.goalIndex];
      const team = goal.team === 0 ? state.home : state.away;
      state.score[goal.team]++;
      state.events.unshift({ minute: goal.minute, text: "هدف لـ " + team.name });
      inserts.push(this.env.DB.prepare("INSERT OR IGNORE INTO match_events(id,match_id,minute,event_type,team_id,description,created_at) VALUES(?,?,?,'goal',?,?,?)")
        .bind(state.id + "-goal-" + state.goalIndex, state.id, goal.minute, team.id, "هدف لـ " + team.name, now));
      state.goalIndex++;
    }
    if (inserts.length) {
      inserts.push(this.env.DB.prepare("UPDATE matches SET home_score=?,away_score=? WHERE id=?").bind(state.score[0], state.score[1], state.id));
      await this.env.DB.batch(inserts);
    }
    state.updatedAt = now;
    if (now >= state.startsAt + 180000) {
      state.minute = 90;
      const outcome = state.score[0] > state.score[1] ? "home" : state.score[0] < state.score[1] ? "away" : "draw";
      const payoutWallets = this.env.DB.prepare("UPDATE wallets SET balance=balance+COALESCE((SELECT SUM(CAST(b.stake*b.odds AS INTEGER)) FROM bets b WHERE b.user_id=wallets.user_id AND b.match_id=? AND b.pick=? AND b.status='open'),0),updated_at=? WHERE user_id IN (SELECT user_id FROM bets WHERE match_id=? AND status='open')")
        .bind(state.id, outcome, now, state.id);
      const settleBets = this.env.DB.prepare("UPDATE bets SET payout=CASE WHEN pick=? THEN CAST(stake*odds AS INTEGER) ELSE 0 END,status='settled',settled_at=? WHERE match_id=? AND status='open'")
        .bind(outcome, now, state.id);
      const finishMatch = this.env.DB.prepare("UPDATE matches SET status='finished',home_score=?,away_score=? WHERE id=?")
        .bind(state.score[0], state.score[1], state.id);
      await this.env.DB.batch([payoutWallets, settleBets, finishMatch]);
      state.status = "finished";
      state.events.unshift({ minute: 90, text: "نهاية المباراة" });
    }
    await this.ctx.storage.put("state", state);
    return state;
  }
  async broadcast(state) {
    const message = JSON.stringify(this.snapshot(state));
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch (_) { try { ws.close(1011, "broadcast error"); } catch (_) {} }
    }
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/arm") { await this.arm(); return json({ ok: true }); }
    if (path === "/bet" && request.method === "POST") {
      try { return await this.handleBet(await request.json()); } catch (error) { return fail(error.message || "تعذر تسجيل الرهان", 409); }
    }
    if (path === "/connect") {
      if (request.headers.get("Upgrade") !== "websocket") return fail("WebSocket upgrade مطلوب", 426);
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      const state = await this.advance();
      server.send(JSON.stringify(this.snapshot(state)));
      if (state.status === "scheduled") await this.arm();
      else if (state.status === "live" && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/snapshot") {
      const state = await this.advance();
      if (state.status === "scheduled") await this.arm();
      return json(this.snapshot(state));
    }
    return fail("المسار غير موجود", 404);
  }
  async alarm() {
    const state = await this.advance();
    await this.broadcast(state);
    if (state.status === "scheduled") await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, state.startsAt));
    else if (state.status === "live") await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async webSocketMessage() {}
  async webSocketClose() {}
}
