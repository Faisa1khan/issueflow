# Interview defence: L1 to L4

Four levels, because that is how a senior interview actually descends.

- **L1** what it is.
- **L2** why this design instead of the obvious alternative.
- **L3** what breaks in practice, and how you would see it.
- **L4** what changes at 10× or with a team.

Nothing here claims a production incident that did not happen. L3 answers describe failure modes
this design can produce and where the code would show them.

---

## 1. Authorization: membership as the primitive

**L1** Gating `User` in a workspace through a `Membership` row; `requireMembership` is the only check.

**L2** Role on `User` would be wrong the moment someone belongs to two teams, and "is logged in" is
not authorization. One row per (user, workspace) also makes removal atomic: delete the row, every
read path closes.

**L3** The failure is a resolver that forgets the call. That is why the cross-tenant test exists: it
asserts `FORBIDDEN`, not just a null. If a new field ships without a test, the gap is invisible —
the answer is a rule that every workspace-scoped resolver starts with the call, and a review
checklist item, not just a test.

**L4** At 10×, memberships become the hot join. Cache `(userId, workspaceId) → role` per request
(the context already lives per request), and move to a policy layer if roles become attribute-based.
The invariant stays: one gate.

## 2. Cursor pagination

**L1** Cursor is the row id; order is `(createdAt desc, id desc)`; `take: first + 1` decides
`hasNextPage`.

**L2** Offset pagination duplicates and skips rows when new rows arrive between pages, which is
exactly what a busy tracker does. A count query for `total` is another full scan.

**L3** The real trap is non-unique ordering: ordering by `createdAt` alone makes two issues created
in the same millisecond unstable across pages. The tiebreaker on `id` is what makes the cursor
deterministic. The second trap is deleting the row a cursor points at; Prisma returns an error on a
missing cursor, so a client holding a stale cursor must restart from the top.

**L4** At 10×, add a covering index on `(workspaceId, createdAt desc, id desc)` — the model already
declares it — and consider keyset pagination with a composite cursor value if ids stop correlating
with time.

## 3. DataLoader and N+1

**L1** Per-request batchers for authors, comment counts and comment lists; a 20-issue page costs 3
queries.

**L2** GraphQL resolves field by field, so the naive resolver issues one query per parent. Batching
belongs in context because loaders must be per request: sharing them across requests leaks cache
between users.

**L3** The failure is silent. Nothing errors; p95 latency just tracks page size. You see it with
query logging or a `$on('query')` counter, and the fix is a batch function with a stable key order.
A second trap: `commentCount` resolved with `comments.length` pulls every comment body to count it.

**L4** At 10×, the groupBy becomes the cost. Precompute counts on write or move to a materialized
view; keep the loader interface so resolvers do not change.

## 4. Refresh rotation and reuse detection

**L1** Access token 15 minutes; refresh token 32 random bytes, stored as SHA-256, rotated on use,
grouped in a family.

**L2** A long-lived stateless token cannot be revoked. Rotation gives two properties: a stolen token
is only useful until the legitimate client refreshes, and a replay is detectable because the token
was already consumed.

**L3** The failure is a race: two tabs refresh at the same moment, the second presents a token the
first already rotated, and the family dies for a legitimate user. That is why the client keeps one
refresh in flight (`client/src/client.ts`). Server-side, the same shape appears under retries; a
grace window or a per-family mutex is the usual fix.

**L4** At 10×, family revocation becomes a write amplification problem and sessions need device
identity (one family per device, revocation by device). The invariant: never store the raw token.

## 5. Query depth limit

**L1** A plugin computes selection depth after the document resolves and rejects anything above 8
before execution.

**L2** Depth grows exponentially through relationships (`issues → author → issues`). A resolver-level
guard still pays parsing cost and can be dodged with fragments; the plugin sees the resolved
document.

**L3** The failure mode is a legitimate query rejected. Deeply nested client queries are usually a
sign of over-fetching, but an introspection query can also trip it if `__typename` is counted — which
is why it is excluded. The second failure is alias-based breadth: depth controls nesting, not the
number of aliased fields, so a complexity score is the next control.

**L4** At 10×, replace or complement with cost analysis (fields × expected cardinality) and a
per-client budget, because depth alone does not price a wide query.

## 6. Rate limiting

**L1** 120 points/minute per caller, keyed by user id when authenticated, IP otherwise; Redis when
configured, in-memory otherwise.

**L2** Per-IP punishes shared NATs and lets one tenant spend another's budget. Redis is required for
correctness across replicas; memory is the fallback so local development needs no service.

**L3** The failure is trusting the wrong key: behind a proxy without `trust proxy`, every request
looks like the same IP and the whole world shares one bucket. The app sets `trust proxy` for exactly
that reason. A second failure is counting only successes: a brute-force login attempt must consume
points even when it fails.

**L4** At 10×, split buckets by operation cost (a mutation costs more than a query), add a login
endpoint limiter keyed by email + IP, and emit the 429 rate as a metric.

## 7. Testing against a real database

**L1** 15 Vitest + Supertest tests against PostgreSQL; the suite truncates and rebuilds state.

**L2** The failures that matter here are relational: cross-tenant reads, cursor boundaries, unique
membership. Mocking Prisma would remove exactly the behaviour under test.

**L3** The failure is test interdependence: shared tables plus parallel files produce flakes. The
config runs files sequentially in one fork and each file truncates in `beforeAll`. The second trap
is disconnecting the shared client between files, which breaks the next file in the same process.

**L4** At 10×, move to a template database per worker and run files in parallel; keep the truncate
path for local runs.

## 8. Schema-first GraphQL

**L1** One SDL file is the contract; resolvers are hand-written against it.

**L2** The schema is what a client team reads and what a diff reviewer can check. Code-first
generates the same SDL but hides the contract inside decorators and build steps.

**L3** The cost is type drift: resolver shapes are not generated from SDL, so a renamed field compiles
and fails at runtime. `tsc --noEmit` catches the TypeScript half, not the GraphQL half; schema tests
or codegen would close it.

**L4** At 10×, generate resolver types from the SDL and add a breaking-change check in CI.

## 9. Docker and deployment

**L1** Multi-stage build, production dependencies only, non-root user, health check, image published
to GHCR.

**L2** Multi-stage keeps compilers and dev dependencies out of the runtime; non-root limits blast
radius; a health endpoint is what a platform uses to decide whether to route traffic.

**L3** The failure I actually hit: `chown -R` after copying re-wrote every layer and duplicated the
whole `node_modules`, taking the image from 831MB to 1.23GB. `COPY --chown` avoids it. The second:
`prisma db push` in the entrypoint is fine for a demo, but it is not a migration story — production
wants versioned migrations and a separate release step.

**L4** At 10×, migrations as a release job, a read replica, and the image immutable per commit (the
publish workflow already tags by SHA).

---

## The 90-second project story

> "IssueFlow is a multi-tenant issue tracker. The interesting part is not the CRUD, it is the three
> places GraphQL goes wrong: authorization, pagination and N+1. Authorization is one membership
> check every resolver calls, so there is no second read path. Pagination is a cursor on
> `(createdAt, id)` because offset breaks under writes. N+1 is handled with per-request DataLoaders,
> which is a 20-issue page in three queries instead of forty-one. Auth is a short access token plus
> rotating refresh tokens with reuse detection: replay a rotated token and the whole family is
> revoked. There are 20 integration tests against real Postgres, a depth limit, and a rate limiter
> that holds across replicas when Redis is present. The image is published to GHCR; the live
> deployment is pending and will be linked here once it is verified."
