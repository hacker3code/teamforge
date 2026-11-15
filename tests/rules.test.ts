import { it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../src/db";
import * as T from "../src/teams";
import { reset, mkUser, mkTeam, size } from "./helpers";

beforeEach(reset);
afterAll(() => pool.end());
const leaderOf = async (id: number) => (await pool.query("SELECT leader_id FROM teams WHERE id=$1", [id])).rows[0]?.leader_id;

it("creating a team puts the creator in it, and nobody can be on two teams", async () => {
  const u = await mkUser();
  const a: any = await T.createTeam(u, "Alpha");
  expect(a.ok).toBe(true);
  expect(await size(a.teamId)).toBe(1);
  const b: any = await T.createTeam(u, "Beta");
  expect(b).toEqual({ ok: false, reason: "already_in_team" });
  expect((await pool.query("SELECT count(*)::int n FROM teams")).rows[0].n).toBe(1);
});

it("an expired invite code is rejected", async () => {
  const team = await mkTeam(await mkUser());
  await pool.query("UPDATE teams SET invite_expires = now() - interval '1 second' WHERE id=$1", [team.id]);
  expect(await T.joinByCode(await mkUser(), team.code)).toEqual({ ok: false, reason: "code_expired" });
});

it("rotating the invite kills the old code", async () => {
  const leader = await mkUser();
  const team = await mkTeam(leader);
  const r: any = await T.rotateInvite(leader, team.id);
  expect((await T.joinByCode(await mkUser(), team.code)) as any).toEqual({ ok: false, reason: "invalid_code" });
  expect((await T.joinByCode(await mkUser(), r.code)).ok).toBe(true);
});

it("a leader who leaves hands leadership to the longest-standing member", async () => {
  const [l, m1, m2] = [await mkUser(), await mkUser(), await mkUser()];
  const team = await mkTeam(l, [m1, m2]);
  expect((await T.leaveTeam(l, team.id)).ok).toBe(true);
  expect(await leaderOf(team.id)).toBe(m1);
  expect(await size(team.id)).toBe(2);
});

it("a normal member leaving does not change the leader", async () => {
  const [l, m1] = [await mkUser(), await mkUser()];
  const team = await mkTeam(l, [m1]);
  await T.leaveTeam(m1, team.id);
  expect(await leaderOf(team.id)).toBe(l);
});

it("the last member leaving deletes the team", async () => {
  const l = await mkUser();
  const team = await mkTeam(l);
  await T.leaveTeam(l, team.id);
  expect(await leaderOf(team.id)).toBeUndefined();
});

it("only the leader can accept a request", async () => {
  const [l, m1, applicant] = [await mkUser(), await mkUser(), await mkUser()];
  const team = await mkTeam(l, [m1]);
  const rq: any = await T.requestJoin(applicant, team.id);
  expect(await T.decide(m1, rq.requestId, true)).toEqual({ ok: false, reason: "not_leader" });
  expect((await T.decide(l, rq.requestId, true)).ok).toBe(true);
  expect(await size(team.id)).toBe(3);
});

it("accepting into a full team fails and the request stays pending", async () => {
  const [l, applicant] = [await mkUser(), await mkUser()];
  const team = await mkTeam(l, [await mkUser()], 2);
  const rq: any = await T.requestJoin(applicant, team.id);
  expect(await T.decide(l, rq.requestId, true)).toEqual({ ok: false, reason: "full" });
  expect((await pool.query("SELECT status FROM join_requests WHERE id=$1", [rq.requestId])).rows[0].status).toBe("pending");
});

it("two leaders accepting the same person at the same instant: exactly one succeeds", async () => {
  const [l1, l2, p] = [await mkUser(), await mkUser(), await mkUser()];
  const [t1, t2] = [await mkTeam(l1), await mkTeam(l2)];
  const r1: any = await T.requestJoin(p, t1.id), r2: any = await T.requestJoin(p, t2.id);
  const res: any[] = await Promise.all([T.decide(l1, r1.requestId, true), T.decide(l2, r2.requestId, true)]);
  expect(res.filter((r) => r.ok)).toHaveLength(1);
  expect((await pool.query("SELECT count(*)::int n FROM team_members WHERE user_id=$1", [p])).rows[0].n).toBe(1);
  expect((await T.verify()).ok).toBe(true);
});

it("a request that is accepted cancels the person's other pending requests", async () => {
  const [l1, l2, p] = [await mkUser(), await mkUser(), await mkUser()];
  const [t1, t2] = [await mkTeam(l1), await mkTeam(l2)];
  const r1: any = await T.requestJoin(p, t1.id), r2: any = await T.requestJoin(p, t2.id);
  await T.decide(l1, r1.requestId, true);
  expect(await T.decide(l2, r2.requestId, true)).toEqual({ ok: false, reason: "already_decided" });
});

it("only the leader can remove a member", async () => {
  const [l, m1, m2] = [await mkUser(), await mkUser(), await mkUser()];
  const team = await mkTeam(l, [m1, m2]);
  expect(await T.removeMember(m1, team.id, m2)).toEqual({ ok: false, reason: "not_leader" });
  expect((await T.removeMember(l, team.id, m2)).ok).toBe(true);
  expect(await size(team.id)).toBe(2);
});

it("a duplicate pending request is refused, and so is a request from someone already in a team", async () => {
  const [l, p] = [await mkUser(), await mkUser()];
  const team = await mkTeam(l);
  expect((await T.requestJoin(p, team.id)).ok).toBe(true);
  expect(await T.requestJoin(p, team.id)).toEqual({ ok: false, reason: "already_requested" });
  expect(await T.requestJoin(l, team.id)).toEqual({ ok: false, reason: "already_in_team" });
});

it("the audit log records who did what", async () => {
  const [l, p] = [await mkUser(), await mkUser()];
  const team = await mkTeam(l);
  await T.joinByCode(p, team.code);
  await T.leaveTeam(p, team.id);
  const log: any = await T.auditLog(l, team.id);
  expect(log.entries.map((e: any) => e.action)).toEqual(["left", "joined"]);
  expect(log.entries[1].actor).toBeTruthy();
});

it("suggestions rank a missing skill above a duplicate skill, and explain the score", async () => {
  const l = await mkUser(["backend"]);
  const team = await mkTeam(l, [], 4, ["design"]);
  const dup = await mkUser(["backend"]), designer = await mkUser(["design"]);
  const r: any = await T.suggestions(l, team.id);
  expect(r.suggestions[0].userId).toBe(designer);
  expect(r.suggestions.find((s: any) => s.userId === dup).score).toBeLessThan(r.suggestions[0].score);
  expect(r.suggestions[0].breakdown.weights).toEqual({ skills: 0.7, timezone: 0.3 });
  expect(r.suggestions[0].why).toContain("design");
});

it("the integrity checker catches corruption", async () => {
  const [l, a, b] = [await mkUser(), await mkUser(), await mkUser()];
  const team = await mkTeam(l, [a], 2);
  expect((await T.verify()).ok).toBe(true);
  await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) VALUES($1,$2,1)", [team.id, b]); // sneak in a 3rd person
  const v = await T.verify();
  expect(v.ok).toBe(false);
  expect(v.checks.find((c) => c.name.startsWith("Teams over"))!.violations).toBe(1);
});

it("minimum size: a team below its minimum cannot be finalized, at the minimum it can", async () => {
  const [l, m] = [await mkUser(), await mkUser()];
  const team = await mkTeam(l, [], 4); // min_size defaults to 2
  expect(await T.finalizeTeam(l, team.id)).toEqual({ ok: false, reason: "too_small" });
  await T.joinByCode(m, team.code);
  expect((await T.finalizeTeam(l, team.id)).ok).toBe(true);
});

it("a finalized team is closed to new joiners, and only the leader can finalize", async () => {
  const [l, m, late] = [await mkUser(), await mkUser(), await mkUser()];
  const team = await mkTeam(l, [m], 4);
  expect(await T.finalizeTeam(m, team.id)).toEqual({ ok: false, reason: "not_leader" });
  await T.finalizeTeam(l, team.id);
  expect(await T.joinByCode(late, team.code)).toEqual({ ok: false, reason: "team_closed" });
});

it("a finalized team that falls below the minimum opens again", async () => {
  const [l, m] = [await mkUser(), await mkUser()];
  const team = await mkTeam(l, [m], 4);
  await T.finalizeTeam(l, team.id);
  await T.leaveTeam(m, team.id);
  expect((await pool.query("SELECT looking FROM teams WHERE id=$1", [team.id])).rows[0].looking).toBe(true);
});
