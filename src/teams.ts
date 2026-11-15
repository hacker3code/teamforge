import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, tx, audit, notify } from "./db";

export type Fail = { ok: false; reason: string };
const fail = (reason: string): Fail => ({ ok: false, reason });
const HID = 1; // the one hackathon this demo runs
const newCode = () => randomBytes(9).toString("base64url"); // 72 bits of entropy

// If two requests race past a check, the UNIQUE (hackathon_id, user_id) constraint still stops the second.
async function guard<T>(fn: () => Promise<T>): Promise<T | Fail> {
  try { return await fn(); } catch (e: any) { if (e.code === "23505") return fail("already_in_team"); throw e; }
}

// Every mutation locks the team row FIRST (never a user row first), so lock order is always the same: no deadlocks.
const lockTeam = async (c: PoolClient, id: number) =>
  (await c.query("SELECT id,hackathon_id,max_size,min_size,member_count,looking,leader_id FROM teams WHERE id=$1 FOR UPDATE", [id])).rows[0];

async function addMember(c: PoolClient, t: any, userId: number) {
  if (t.member_count >= t.max_size) return false;
  await c.query("INSERT INTO team_members(team_id,user_id,hackathon_id) VALUES($1,$2,$3)", [t.id, userId, t.hackathon_id]);
  await c.query("UPDATE teams SET member_count=member_count+1 WHERE id=$1", [t.id]);
  return true;
}

// A finalized team that drops below its minimum size opens again.
async function reopenIfSmall(c: PoolClient, t: any, actor: number) {
  if (!t.looking && t.member_count - 1 < t.min_size) {
    await c.query("UPDATE teams SET looking=true WHERE id=$1", [t.id]);
    await audit(c, t.id, actor, "reopened", { reason: "below minimum size" });
  }
}

export const createTeam = (userId: number, name: string, maxSize = 4, minSize = 2, needs: string[] = []) =>
  guard(async () => {
    const r = await tx(async (c) => {
      const t = await c.query(
        `INSERT INTO teams(hackathon_id,name,leader_id,min_size,max_size,member_count,needs,invite_code,invite_expires)
         VALUES($1,$2,$3,$4,$5,1,$6,$7, now()+interval '48 hours') RETURNING id,invite_code`,
        [HID, name, userId, minSize, maxSize, needs, newCode()]);
      const id = t.rows[0].id;
      await c.query("INSERT INTO team_members(team_id,user_id,hackathon_id) VALUES($1,$2,$3)", [id, userId, HID]);
      await audit(c, id, userId, "team_created", { name });
      return { ok: true as const, teamId: id as number, code: t.rows[0].invite_code as string };
    });
    notify(r.teamId);
    return r;
  });

// THE race-proof join. FOR UPDATE makes everyone targeting this team queue up one by one.
// If the code is rotated while a request waits, Postgres re-checks the WHERE after the lock and the row no longer matches.
export const joinByCode = (userId: number, code: string) =>
  guard(async () => {
    const r = await tx<any>(async (c) => {
      const q = await c.query(
        `SELECT id,hackathon_id,max_size,member_count,looking, invite_expires > now() AS live
         FROM teams WHERE invite_code=$1 FOR UPDATE`, [code]);
      if (!q.rowCount) return fail("invalid_code");
      const t = q.rows[0];
      if (!t.live) return fail("code_expired");
      if (!t.looking) return fail("team_closed");
      if (!(await addMember(c, t, userId))) return fail("full");
      await audit(c, t.id, userId, "joined", { via: "invite_code" });
      return { ok: true, teamId: t.id as number, hid: t.hackathon_id as number };
    });
    if (r.ok && r.hid === HID) notify(r.teamId); // the Race Arena (hackathon 999) must not trigger page refreshes
    return r;
  });

// Deliberately broken twin used by the Race Arena and one test: check, pause, insert, no lock.
export async function joinByCodeUnsafe(userId: number, code: string) {
  const c = await pool.connect();
  try {
    const t = (await c.query("SELECT id,hackathon_id,max_size FROM teams WHERE invite_code=$1", [code])).rows[0];
    if (!t) return fail("invalid_code");
    const n = (await c.query("SELECT count(*)::int n FROM team_members WHERE team_id=$1", [t.id])).rows[0].n;
    if (n >= t.max_size) return fail("full");
    await c.query("SELECT pg_sleep(0.05)"); // widens the gap between check and insert
    await c.query("INSERT INTO team_members(team_id,user_id,hackathon_id) VALUES($1,$2,$3)", [t.id, userId, t.hackathon_id]);
    return { ok: true as const };
  } catch (e: any) {
    if (e.code === "23505") return fail("already_in_team");
    throw e;
  } finally { c.release(); }
}

export const requestJoin = (userId: number, teamId: number, message = "") =>
  tx<any>(async (c) => {
    const t = await c.query("SELECT id FROM teams WHERE id=$1", [teamId]);
    if (!t.rowCount) return fail("no_team");
    const mine = await c.query("SELECT 1 FROM team_members WHERE user_id=$1 AND hackathon_id=$2", [userId, HID]);
    if (mine.rowCount) return fail("already_in_team");
    const r = await c.query(
      "INSERT INTO join_requests(team_id,user_id,message) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
      [teamId, userId, message]);
    if (!r.rowCount) return fail("already_requested");
    await audit(c, teamId, userId, "requested", { requestId: r.rows[0].id });
    return { ok: true, requestId: r.rows[0].id as number };
  }).then((r) => { if (r.ok) notify(teamId); return r; });

export const decide = (leaderId: number, requestId: number, accept: boolean) =>
  guard(async () => {
    const r = await tx<any>(async (c) => {
      const rq = await c.query("SELECT team_id FROM join_requests WHERE id=$1", [requestId]);
      if (!rq.rowCount) return fail("not_found");
      const t = await lockTeam(c, rq.rows[0].team_id);
      if (!t) return fail("not_found");
      if (t.leader_id !== leaderId) return fail("not_leader");
      const cur = (await c.query("SELECT user_id,status FROM join_requests WHERE id=$1 FOR UPDATE", [requestId])).rows[0];
      if (!cur) return fail("not_found");
      if (cur.status !== "pending") return fail("already_decided");
      if (accept) {
        if (!t.looking) return fail("team_closed");
        const busy = await c.query("SELECT 1 FROM team_members WHERE user_id=$1 AND hackathon_id=$2", [cur.user_id, HID]);
        if (busy.rowCount) {
          await c.query("UPDATE join_requests SET status='cancelled' WHERE id=$1", [requestId]);
          return fail("applicant_unavailable");
        }
        if (!(await addMember(c, t, cur.user_id))) return fail("full");
        await c.query("UPDATE join_requests SET status='accepted' WHERE id=$1", [requestId]);
        await c.query("UPDATE join_requests SET status='cancelled' WHERE user_id=$1 AND status='pending'", [cur.user_id]);
        await audit(c, t.id, leaderId, "accepted", { user: cur.user_id });
      } else {
        await c.query("UPDATE join_requests SET status='declined' WHERE id=$1", [requestId]);
        await audit(c, t.id, leaderId, "declined", { user: cur.user_id });
      }
      return { ok: true, teamId: t.id as number };
    });
    if (r.ok) notify(r.teamId);
    return r;
  });

export const removeMember = (leaderId: number, teamId: number, userId: number) =>
  tx<any>(async (c) => {
    const t = await lockTeam(c, teamId);
    if (!t) return fail("no_team");
    if (t.leader_id !== leaderId) return fail("not_leader");
    if (userId === leaderId) return fail("use_leave");
    const d = await c.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [teamId, userId]);
    if (!d.rowCount) return fail("not_member");
    await c.query("UPDATE teams SET member_count=member_count-1 WHERE id=$1", [teamId]);
    await audit(c, teamId, leaderId, "removed", { user: userId });
    await reopenIfSmall(c, t, leaderId);
    return { ok: true };
  }).then((r) => { if (r.ok) notify(teamId); return r; });

export const leaveTeam = (userId: number, teamId: number) =>
  tx<any>(async (c) => {
    const t = await lockTeam(c, teamId);
    if (!t) return fail("no_team");
    const d = await c.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [teamId, userId]);
    if (!d.rowCount) return fail("not_member");
    await audit(c, teamId, userId, "left");
    const next = await c.query("SELECT user_id FROM team_members WHERE team_id=$1 ORDER BY joined_at,user_id LIMIT 1", [teamId]);
    if (!next.rowCount) {
      await c.query("DELETE FROM teams WHERE id=$1", [teamId]); // last one out deletes the team
      await audit(c, teamId, userId, "team_deleted");
    } else {
      await c.query("UPDATE teams SET member_count=member_count-1 WHERE id=$1", [teamId]);
      await reopenIfSmall(c, t, userId);
      if (t.leader_id === userId) { // leadership passes to the longest-standing member
        await c.query("UPDATE teams SET leader_id=$1 WHERE id=$2", [next.rows[0].user_id, teamId]);
        await audit(c, teamId, userId, "leader_changed", { newLeader: next.rows[0].user_id });
      }
    }
    return { ok: true };
  }).then((r) => { if (r.ok) notify(teamId); return r; });

// The minimum-size rule: a team can only be finalized (closed to newcomers) when min_size <= size <= max_size.
export const finalizeTeam = (leaderId: number, teamId: number) =>
  tx<any>(async (c) => {
    const t = await lockTeam(c, teamId);
    if (!t) return fail("no_team");
    if (t.leader_id !== leaderId) return fail("not_leader");
    if (t.member_count < t.min_size) return fail("too_small");
    await c.query("UPDATE teams SET looking=false WHERE id=$1", [teamId]);
    await audit(c, teamId, leaderId, "finalized", { size: t.member_count });
    return { ok: true };
  }).then((r) => { if (r.ok) notify(teamId); return r; });

export const rotateInvite = (leaderId: number, teamId: number) =>
  tx<any>(async (c) => {
    const t = await lockTeam(c, teamId);
    if (!t) return fail("no_team");
    if (t.leader_id !== leaderId) return fail("not_leader");
    const code = newCode();
    await c.query("UPDATE teams SET invite_code=$1, invite_expires=now()+interval '48 hours' WHERE id=$2", [code, teamId]);
    await audit(c, teamId, leaderId, "invite_rotated");
    return { ok: true, code };
  });

// ---------- reads ----------
export const board = async (limit = 30, offset = 0) =>
  (await pool.query(
    `SELECT t.id,t.name,t.max_size,t.member_count,t.needs,u.name AS leader_name,u.skills AS leader_skills
     FROM teams t JOIN users u ON u.id=t.leader_id
     WHERE t.looking AND t.member_count<t.max_size AND t.hackathon_id=$3
     ORDER BY t.created_at DESC, t.id DESC LIMIT $1 OFFSET $2`, [limit, offset, HID])).rows;

export async function me(uid: number) {
  const r = await pool.query(
    `SELECT u.id,u.name,u.email,u.skills,u.utc_offset_minutes,m.team_id
     FROM users u LEFT JOIN team_members m ON m.user_id=u.id AND m.hackathon_id=$2 WHERE u.id=$1`, [uid, HID]);
  return r.rows[0] ?? null;
}

export async function getTeam(uid: number, teamId: number) {
  const t = (await pool.query(
    "SELECT id,name,min_size,max_size,member_count,looking,needs,leader_id,invite_code,invite_expires FROM teams WHERE id=$1", [teamId])).rows[0];
  if (!t) return fail("no_team");
  const members = (await pool.query(
    "SELECT u.id,u.name,u.skills,m.joined_at FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 ORDER BY m.joined_at,u.id", [teamId])).rows;
  const { invite_code, invite_expires, ...pub } = t;
  const out: any = { ok: true, team: pub, members, isMember: members.some((m) => m.id === uid), isLeader: t.leader_id === uid };
  if (out.isLeader) {
    out.invite = { code: invite_code, expires: invite_expires }; // only the leader ever sees the code
    out.requests = (await pool.query(
      `SELECT r.id,r.message,r.created_at,u.id AS user_id,u.name,u.skills FROM join_requests r
       JOIN users u ON u.id=r.user_id WHERE r.team_id=$1 AND r.status='pending' ORDER BY r.id`, [teamId])).rows;
  }
  return out;
}

export async function auditLog(uid: number, teamId: number) {
  const mem = await pool.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2", [teamId, uid]);
  if (!mem.rowCount) return fail("not_member");
  const rows = (await pool.query(
    `SELECT a.id,a.action,a.detail,a.at,u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
     WHERE a.team_id=$1 ORDER BY a.id DESC LIMIT 50`, [teamId])).rows;
  return { ok: true as const, entries: rows };
}

// Score = 0.7 * skills + 0.3 * timezone, with the breakdown returned so it can be explained.
//  skills:   half "skills your team lacks", half "skills on your team's wanted list"
//  timezone: 1 when the same offset as the team's average, falling linearly to 0 at 12 hours apart
export async function suggestions(leaderId: number, teamId: number) {
  const team = (await pool.query("SELECT leader_id,needs FROM teams WHERE id=$1", [teamId])).rows[0];
  if (!team) return fail("no_team");
  if (team.leader_id !== leaderId) return fail("not_leader");
  const mem = (await pool.query(
    "SELECT u.skills,u.utc_offset_minutes o FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1", [teamId])).rows;
  const have = new Set<string>(mem.flatMap((m) => m.skills));
  const tz = mem.reduce((a, m) => a + m.o, 0) / Math.max(1, mem.length);
  const cands = (await pool.query(
    `SELECT id,name,skills,utc_offset_minutes o FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM team_members m WHERE m.user_id=u.id AND m.hackathon_id=$1) ORDER BY id LIMIT 2000`, [HID])).rows;
  const needs: string[] = team.needs;
  const out = cands.map((c) => {
    const sk: string[] = c.skills;
    const lacks = sk.filter((s) => !have.has(s));
    const hits = sk.filter((s) => needs.includes(s));
    const skills = sk.length ? Math.min(1, (0.5 * lacks.length) / sk.length + (0.5 * hits.length) / Math.max(1, needs.length)) : 0;
    const hrs = Math.abs(c.o - tz) / 60;
    const timezone = Math.max(0, 1 - hrs / 12);
    const why =
      (hits.length ? `Has ${hits.join(", ")}, which you want. ` : lacks.length ? `Adds ${lacks.join(", ")} that your team lacks. ` : "Skills overlap with your team. ") +
      `${Math.round(hrs)}h from your team's time zone.`;
    return {
      userId: c.id, name: c.name, skills: sk, score: +(0.7 * skills + 0.3 * timezone).toFixed(3),
      breakdown: { skills: +skills.toFixed(3), timezone: +timezone.toFixed(3), weights: { skills: 0.7, timezone: 0.3 } }, why,
    };
  }).sort((a, b) => b.score - a.score).slice(0, 10);
  return { ok: true as const, suggestions: out };
}

// Invariant checker: run it after a load test or a crash. Every number must be 0.
export async function verify() {
  const checks: [string, string][] = [
    ["Teams over their max size", "SELECT t.id FROM teams t JOIN team_members m ON m.team_id=t.id GROUP BY t.id,t.max_size HAVING count(*)>t.max_size"],
    ["People on more than one team", "SELECT user_id FROM team_members GROUP BY hackathon_id,user_id HAVING count(*)>1"],
    ["Stored member count differs from real count", "SELECT t.id FROM teams t WHERE t.member_count <> (SELECT count(*) FROM team_members m WHERE m.team_id=t.id)"],
    ["Teams with no members", "SELECT t.id FROM teams t WHERE NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id)"],
    ["Teams whose leader is not a member", "SELECT t.id FROM teams t WHERE NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=t.leader_id)"],
  ];
  const results = [];
  for (const [name, sql] of checks) results.push({ name, violations: (await pool.query(sql)).rowCount });
  return { ok: results.every((r) => r.violations === 0), checks: results };
}

// Race Arena: 50 people go for the last seat. Runs the safe or the broken join, reports, then cleans up after itself.
export async function arena(unsafe: boolean) {
  const tag = randomBytes(4).toString("hex");
  const ids: number[] = (await pool.query(
    "INSERT INTO users(name,email,password_hash) SELECT 'Arena '||g,'arena-'||$1||'-'||g||'@arena.local','x' FROM generate_series(1,53) g RETURNING id", [tag])).rows.map((r) => r.id);
  const [leader, m2, m3, ...contenders] = ids;
  const code = newCode();
  const teamId = (await pool.query(
    `INSERT INTO teams(hackathon_id,name,leader_id,max_size,member_count,invite_code,invite_expires)
     VALUES(999,'Arena team',$1,4,3,$2,now()+interval '1 hour') RETURNING id`, [leader, code])).rows[0].id;
  await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) SELECT $1,x,999 FROM unnest($2::bigint[]) x", [teamId, [leader, m2, m3]]);
  const join = unsafe ? joinByCodeUnsafe : joinByCode;
  const t0 = Date.now();
  const results: any[] = await Promise.all(contenders.map((id) => join(id, code)));
  const ms = Date.now() - t0;
  const finalSize = (await pool.query("SELECT count(*)::int n FROM team_members WHERE team_id=$1", [teamId])).rows[0].n;
  await pool.query("DELETE FROM teams WHERE id=$1", [teamId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::bigint[])", [ids]);
  const reasons: Record<string, number> = {};
  for (const r of results) if (!r.ok) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return {
    mode: unsafe ? "unsafe" : "safe", attempts: contenders.length, winners: results.filter((r) => r.ok).length,
    outcomes: results.map((r) => !!r.ok), reasons, startedWith: 3, maxSize: 4, finalSize, overfilled: finalSize > 4, ms,
  };
}
