import { it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../src/db";
import { buildApp } from "../src/app";
import { resetLimits } from "../src/auth";
import { reset } from "./helpers";

const app = buildApp();
beforeEach(async () => { await reset(); resetLimits(); });
afterAll(async () => { await app.close(); await pool.end(); });

const json = (res: any) => res.json();
async function register(email = "a@t.dev", ip = "10.0.0.1") {
  const res = await app.inject({ method: "POST", url: "/api/register", remoteAddress: ip,
    payload: { name: "Ada", email, password: "longenough1", skills: ["backend"], utcOffsetMinutes: 330 } });
  return json(res).token as string;
}
const authed = (token: string, method: any, url: string, payload?: any, headers: any = {}) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...headers } });

it("register, log in and read your profile", async () => {
  await register("ada@t.dev");
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { email: "ada@t.dev", password: "longenough1" } });
  expect(login.statusCode).toBe(200);
  const me = json(await authed(json(login).token, "GET", "/api/me"));
  expect(me.user.email).toBe("ada@t.dev");
  expect(me.user.team_id).toBeNull();
});

it("a wrong password is refused and requests without a token get 401", async () => {
  await register("ada@t.dev");
  const bad = await app.inject({ method: "POST", url: "/api/login", payload: { email: "ada@t.dev", password: "nope-nope" } });
  expect(bad.statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/board" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/board", headers: { authorization: "Bearer forged.token" } })).statusCode).toBe(401);
});

it("invalid input is rejected with 400", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/register", payload: { name: "", email: "not-an-email", password: "short" } });
  expect(bad.statusCode).toBe(400);
  const token = await register();
  expect((await authed(token, "POST", "/api/teams", { name: "x", maxSize: 99 })).statusCode).toBe(400);
});

it("a retried create-team request with the same Idempotency-Key makes one team", async () => {
  const token = await register();
  const h = { "idempotency-key": "abc-123" };
  const first = await authed(token, "POST", "/api/teams", { name: "Rockets" }, h);
  const second = await authed(token, "POST", "/api/teams", { name: "Rockets" }, h);
  expect(first.statusCode).toBe(200);
  expect(second.headers["idempotent-replay"]).toBe("true");
  expect(json(second).teamId).toBe(json(first).teamId);
  expect((await pool.query("SELECT count(*)::int n FROM teams")).rows[0].n).toBe(1);
});

it("guessing invite codes gets rate limited", async () => {
  const token = await register();
  const codes = Array.from({ length: 12 }, (_, i) => `guess-number-${i}`);
  const statuses: number[] = [];
  for (const code of codes) statuses.push((await authed(token, "POST", "/api/join", { code })).statusCode);
  expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
  expect(statuses.slice(10)).toEqual([429, 429]);
});

it("only the leader ever sees the invite code, and outsiders cannot read the audit log", async () => {
  const lead = await register("lead@t.dev", "10.0.0.2"), other = await register("other@t.dev", "10.0.0.3");
  const teamId = json(await authed(lead, "POST", "/api/teams", { name: "Secret" })).teamId;
  expect(json(await authed(lead, "GET", `/api/teams/${teamId}`)).invite.code).toBeTruthy();
  const seen = json(await authed(other, "GET", `/api/teams/${teamId}`));
  expect(seen.invite).toBeUndefined();
  expect((await authed(other, "GET", `/api/teams/${teamId}/audit`)).statusCode).toBe(403);
  expect((await authed(other, "GET", `/api/teams/${teamId}/suggestions`)).statusCode).toBe(403);
});

it("the Race Arena endpoint shows 1 winner on the safe join and an overfilled team on the unsafe one", async () => {
  const token = await register();
  const safe = json(await authed(token, "POST", "/api/arena", { mode: "safe" }));
  expect(safe.winners).toBe(1);
  expect(safe.finalSize).toBe(4);
  const unsafe = json(await authed(token, "POST", "/api/arena", { mode: "unsafe" }));
  expect(unsafe.overfilled).toBe(true);
  expect(json(await app.inject({ method: "GET", url: "/api/verify" })).ok).toBe(true); // arena cleans up after itself
});
