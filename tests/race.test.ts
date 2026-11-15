import { it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "../src/db";
import { joinByCode, joinByCodeUnsafe, verify } from "../src/teams";
import { reset, mkUser, mkUsers, mkTeam, size } from "./helpers";

beforeEach(reset);
afterAll(() => pool.end());

it("50 people race for the last seat: exactly one wins", async () => {
  const leader = await mkUser();
  const team = await mkTeam(leader, [await mkUser(), await mkUser()], 4);
  const people = await mkUsers(50);
  const results = await Promise.all(people.map((u) => joinByCode(u, team.code)));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(await size(team.id)).toBe(4);
  expect(results.filter((r: any) => !r.ok && r.reason === "full")).toHaveLength(49);
  expect((await verify()).ok).toBe(true);
});

it("with 2 seats left and 50 contenders, exactly two win", async () => {
  const team = await mkTeam(await mkUser(), [await mkUser()], 4);
  const results = await Promise.all((await mkUsers(50)).map((u) => joinByCode(u, team.code)));
  expect(results.filter((r) => r.ok)).toHaveLength(2);
  expect(await size(team.id)).toBe(4);
});

it("the same person firing 10 joins at once is added only once", async () => {
  const team = await mkTeam(await mkUser(), [], 4);
  const u = await mkUser();
  const results = await Promise.all(Array.from({ length: 10 }, () => joinByCode(u, team.code)));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(await size(team.id)).toBe(2);
});

it("the broken join without a lock overfills the team (this is the bug the lock prevents)", async () => {
  const team = await mkTeam(await mkUser(), [await mkUser(), await mkUser()], 4);
  const results = await Promise.all((await mkUsers(50)).map((u) => joinByCodeUnsafe(u, team.code)));
  const final = await size(team.id);
  console.log(`UNSAFE join: ${results.filter((r) => r.ok).length} winners, final team size ${final} (max 4)`);
  expect(final).toBeGreaterThan(4);
});
