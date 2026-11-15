# TeamForge: design doc (fill in the bracketed parts with your own numbers)

## Data model
users, teams (invite code, expiry, denormalised `member_count`), team_members, join_requests, audit_log, idempotency_keys. See `schema.sql`.

## How races are prevented
`FOR UPDATE` on the team row, taken first in every operation. DB constraints as a second net. Details in README.

## Trade-offs
- Pessimistic lock instead of optimistic retry: simple and correct, serialises only per team, so different teams never wait on each other.
- `member_count` is stored, not counted, so the board query is fast. Cost: it must be updated under the lock. The integrity checker verifies it.
- Rate limiting and SSE live in memory: fine for one instance. With several I would move limits into Postgres and fan events out with LISTEN/NOTIFY.
- Idempotency keys are written before the action. A crash between the two leaves a key with no response; the client sees "in progress". A cleanup job would fix this.

## Results (replace with yours)
- Unsafe join: [N] winners, team ended with [X] of 4 (from `npm test` output).
- Safe join: 1 winner, team size 4.
- Load test, 100 users on GET /api/board: p95 [__] ms (from `load-report.md`).

## Bugs I hit (write the real ones)
- [e.g. pasted code into the terminal, missing import, anything you actually ran into]

## With one more week
Chaos test (kill the server mid-join, then run `/api/verify`), audit-log replay, optimistic UI with rollback, Postgres-backed rate limits.
