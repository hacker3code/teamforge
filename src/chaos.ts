// Chaos test: hammer the server with joins, KILL it mid-flight, restart it, hammer again, then check the data.
// Run with: npm run chaos   (needs the database running; it wipes it)
import { spawn, type ChildProcess } from "node:child_process";
import { pool } from "./db";
import { sign } from "./auth";
import { verify } from "./teams";

const PORT = 3100, BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const start = (): ChildProcess =>
  spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env, PORT: String(PORT), DISABLE_RATE_LIMIT: "1" }, stdio: "ignore" });
async function waitUp() { for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/api/health")).ok) return; } catch {} await sleep(250); } throw new Error("server did not start"); }

await pool.query("TRUNCATE audit_log,idempotency_keys,join_requests,team_members,teams,users RESTART IDENTITY CASCADE");
const TEAMS = 20, PEOPLE = 400;
const leaders = (await pool.query("INSERT INTO users(name,email,password_hash) SELECT 'L'||g,'l'||g||'@chaos.dev','x' FROM generate_series(1,$1) g RETURNING id", [TEAMS])).rows.map((r) => r.id);
const people = (await pool.query("INSERT INTO users(name,email,password_hash) SELECT 'P'||g,'p'||g||'@chaos.dev','x' FROM generate_series(1,$1) g RETURNING id", [PEOPLE])).rows.map((r) => r.id);
const codes: string[] = [];
for (let i = 0; i < TEAMS; i++) {
  codes.push("chaos-code-" + i);
  const t = (await pool.query("INSERT INTO teams(hackathon_id,name,leader_id,max_size,member_count,invite_code,invite_expires) VALUES(1,$1,$2,4,1,$3,now()+interval '1 hour') RETURNING id", ["Chaos " + i, leaders[i], codes[i]])).rows[0];
  await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) VALUES($1,$2,1)", [t.id, leaders[i]]);
}
const fire = (users: number[]) => Promise.allSettled(users.map((u, i) =>
  fetch(BASE + "/api/join", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + sign(u) }, body: JSON.stringify({ code: codes[i % TEAMS] }) })));

let server = start(); await waitUp();
console.log("round 1: firing", PEOPLE, "joins at", TEAMS, "teams (60 free seats). Killing the server once ~20 joins are saved...");
const round1 = fire(people);
const joined = async () => (await pool.query("SELECT count(*)::int n FROM team_members")).rows[0].n - TEAMS;
const t0 = Date.now();
while ((await joined()) < 20 && Date.now() - t0 < 5000) await sleep(3);
server.kill("SIGKILL");
const before = await joined();
const r1 = await round1;
const cut = r1.filter((x) => x.status === "rejected" || (x as any).value?.status >= 500).length;
console.log(`  server killed with ${before} joins saved; ${cut} of ${PEOPLE} requests were cut off mid-flight`);
await sleep(500);
server = start(); await waitUp();
console.log("server restarted. round 2: everyone tries again (people already in a team get 'already_in_team')");
await fire(people);
server.kill("SIGKILL");

const v = await verify();
const sizes = (await pool.query("SELECT max(member_count) AS biggest, count(*)::int AS teams FROM teams")).rows[0];
const total = (await pool.query("SELECT count(*)::int n FROM team_members")).rows[0].n;
const filled = total === TEAMS * 4; // every team ends with exactly 4: all seats filled, none twice, none lost
console.log("\nIntegrity checks after the crash:");
for (const c of v.checks) console.log(`  ${c.violations === 0 ? "PASS" : "FAIL"}  ${c.name}: ${c.violations}`);
console.log(`  ${filled ? "PASS" : "FAIL"}  Every seat filled exactly once after the retry: ${total} members, expected ${TEAMS * 4}`);
console.log(`Biggest team: ${sizes.biggest} (max 4), teams: ${sizes.teams}`);
const ok = v.ok && filled;
console.log(ok ? "\nCHAOS TEST PASSED: nothing was corrupted, nothing was lost." : "\nCHAOS TEST FAILED.");
await pool.end();
process.exit(ok ? 0 : 1);
