import Fastify from "fastify";
import { z, ZodError } from "zod";
import { readFileSync } from "node:fs";
import { pool, bus } from "./db";
import { hashPw, checkPw, sign, verifyToken, limited } from "./auth";
import * as T from "./teams";

const STATUS: Record<string, number> = {
  invalid_code: 404, no_team: 404, not_found: 404, not_leader: 403, not_member: 403, full: 409,
  code_expired: 410, already_in_team: 409, already_requested: 409, already_decided: 409,
  applicant_unavailable: 409, team_closed: 409, too_small: 409, use_leave: 400, in_progress: 409,
};
const codeFor = (r: any) => (r.ok ? 200 : STATUS[r.reason] ?? 400);
const OPEN = new Set(["/api/register", "/api/login", "/api/health", "/api/verify"]);

const skills = z.array(z.string().trim().min(1).max(30)).max(12);
const Register = z.object({
  name: z.string().trim().min(1).max(60), email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(8).max(100), skills: skills.default([]), utcOffsetMinutes: z.number().int().min(-720).max(840).default(0),
});
const Login = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(100) });
const NewTeam = z.object({
  name: z.string().trim().min(2).max(60), maxSize: z.number().int().min(2).max(10).default(4),
  minSize: z.number().int().min(1).max(10).default(2), needs: skills.default([]),
}).refine((v) => v.minSize <= v.maxSize, { message: "minSize must not exceed maxSize" });
const Code = z.object({ code: z.string().trim().min(8).max(40) });
const Msg = z.object({ message: z.string().trim().max(300).default("") });
const id = (v: any) => z.coerce.number().int().positive().parse(v);

export function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true });
  const page = readFileSync("public/index.html");

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ ok: false, reason: "invalid_input", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ ok: false, reason: "bad_request" });
    console.error(err);
    return reply.code(500).send({ ok: false, reason: "server_error" });
  });

  app.addHook("preHandler", async (req: any, reply) => {
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/") || OPEN.has(path)) return;
    const token = (req.headers.authorization ?? "").replace("Bearer ", "") || req.query?.token;
    const uid = verifyToken(token);
    if (!uid) return reply.code(401).send({ ok: false, reason: "unauthorized" });
    req.uid = uid;
  });

  // Same Idempotency-Key from the same user = same answer, and the action runs once.
  async function idem(req: any, reply: any, run: () => Promise<any>) {
    const key = req.headers["idempotency-key"];
    if (!key) { const r = await run(); return reply.code(codeFor(r)).send(r); }
    if (typeof key !== "string" || key.length > 100) return reply.code(400).send({ ok: false, reason: "invalid_input" });
    const ins = await pool.query("INSERT INTO idempotency_keys(user_id,key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING 1", [req.uid, key]);
    if (!ins.rowCount) {
      const row = (await pool.query("SELECT response FROM idempotency_keys WHERE user_id=$1 AND key=$2", [req.uid, key])).rows[0];
      if (!row?.response) return reply.code(409).send({ ok: false, reason: "in_progress" });
      return reply.header("Idempotent-Replay", "true").code(row.response.status).send(row.response.body);
    }
    try {
      const r = await run();
      await pool.query("UPDATE idempotency_keys SET response=$3 WHERE user_id=$1 AND key=$2", [req.uid, key, { status: codeFor(r), body: r }]);
      return reply.code(codeFor(r)).send(r);
    } catch (e) {
      await pool.query("DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2", [req.uid, key]); // let the client retry
      throw e;
    }
  }

  app.get("/", async (_q, r) => r.type("text/html").send(page));
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/verify", async () => T.verify());

  app.post("/api/register", async (req: any, reply) => {
    if (limited(`reg:${req.ip}`, 20, 60_000)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const b = Register.parse(req.body);
    try {
      const r = await pool.query(
        "INSERT INTO users(name,email,password_hash,skills,utc_offset_minutes) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [b.name, b.email, hashPw(b.password), b.skills, b.utcOffsetMinutes]);
      return { ok: true, token: sign(r.rows[0].id) };
    } catch (e: any) {
      if (e.code === "23505") return reply.code(409).send({ ok: false, reason: "email_taken" });
      throw e;
    }
  });
  app.post("/api/login", async (req: any, reply) => {
    if (limited(`login:${req.ip}`, 30, 60_000)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const b = Login.parse(req.body);
    const u = (await pool.query("SELECT id,password_hash FROM users WHERE email=$1", [b.email])).rows[0];
    if (!u || !checkPw(b.password, u.password_hash)) return reply.code(401).send({ ok: false, reason: "bad_credentials" });
    return { ok: true, token: sign(u.id) };
  });

  app.get("/api/me", async (req: any, reply) => {
    const u = await T.me(req.uid);
    return u ? { ok: true, user: u } : reply.code(401).send({ ok: false, reason: "unauthorized" });
  });
  app.get("/api/board", async (req: any) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).max(100000).default(0) }).parse(req.query);
    return { ok: true, teams: await T.board(q.limit, q.offset) };
  });

  app.get("/api/stats", async () => {
    const r = (await pool.query(
      `SELECT count(*) FILTER (WHERE looking AND member_count<max_size)::int AS teams,
              coalesce(sum(max_size-member_count) FILTER (WHERE looking AND member_count<max_size),0)::int AS seats
       FROM teams WHERE hackathon_id=1`)).rows[0];
    return { ok: true, teams: r.teams, openSeats: r.seats };
  });

  app.post("/api/teams", (req: any, reply) => {
    const b = NewTeam.parse(req.body);
    return idem(req, reply, () => T.createTeam(req.uid, b.name, b.maxSize, b.minSize, b.needs));
  });
  app.get("/api/teams/:id", async (req: any, reply) => {
    const r: any = await T.getTeam(req.uid, id(req.params.id));
    return reply.code(codeFor(r)).send(r);
  });
  app.get("/api/teams/:id/audit", async (req: any, reply) => {
    const r: any = await T.auditLog(req.uid, id(req.params.id));
    return reply.code(codeFor(r)).send(r);
  });
  app.get("/api/teams/:id/suggestions", async (req: any, reply) => {
    const r: any = await T.suggestions(req.uid, id(req.params.id));
    return reply.code(codeFor(r)).send(r);
  });
  app.post("/api/teams/:id/requests", (req: any, reply) => {
    const teamId = id(req.params.id), b = Msg.parse(req.body ?? {});
    return idem(req, reply, () => T.requestJoin(req.uid, teamId, b.message));
  });
  app.post("/api/teams/:id/leave", (req: any, reply) => {
    const teamId = id(req.params.id);
    return idem(req, reply, () => T.leaveTeam(req.uid, teamId));
  });
  app.post("/api/teams/:id/finalize", (req: any, reply) => {
    const teamId = id(req.params.id);
    return idem(req, reply, () => T.finalizeTeam(req.uid, teamId));
  });
  app.post("/api/teams/:id/invite", (req: any, reply) => {
    const teamId = id(req.params.id);
    return idem(req, reply, () => T.rotateInvite(req.uid, teamId));
  });
  app.delete("/api/teams/:id/members/:userId", (req: any, reply) => {
    const teamId = id(req.params.id), uid = id(req.params.userId);
    return idem(req, reply, () => T.removeMember(req.uid, teamId, uid));
  });
  app.post("/api/requests/:id/:verb", (req: any, reply) => {
    const rid = id(req.params.id), verb = z.enum(["accept", "decline"]).parse(req.params.verb);
    return idem(req, reply, () => T.decide(req.uid, rid, verb === "accept"));
  });

  // Brute-force guard: 10 tries a minute per user and 40 per IP, plus 72-bit codes.
  app.post("/api/join", (req: any, reply) => {
    if (limited(`join:u${req.uid}`, 10, 60_000) || limited(`join:ip${req.ip}`, 40, 60_000))
      return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const b = Code.parse(req.body);
    return idem(req, reply, () => T.joinByCode(req.uid, b.code));
  });

  app.post("/api/arena", async (req: any, reply) => {
    if (limited(`arena:${req.ip}`, 12, 60_000)) return reply.code(429).send({ ok: false, reason: "rate_limited" });
    const b = z.object({ mode: z.enum(["safe", "unsafe"]) }).parse(req.body);
    return T.arena(b.mode === "unsafe");
  });

  // Server-sent events. Browsers cannot set headers on EventSource, so the token travels in the query string.
  app.get("/api/stream", (req: any, reply) => {
    const topics = String(req.query.topics ?? "board").split(",").slice(0, 5);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    const on = (m: { topic: string }) => { if (topics.includes(m.topic)) res.write(`data: ${JSON.stringify(m)}\n\n`); };
    bus.on("msg", on);
    const hb = setInterval(() => res.write(": hb\n\n"), 25_000);
    req.raw.on("close", () => { bus.off("msg", on); clearInterval(hb); });
  });

  return app;
}
