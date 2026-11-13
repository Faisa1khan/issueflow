# Review Guide

Read in this order. Each file answers one question, and the whole thing is ~708 lines.

### 1. `src/schema.graphql` — what the API can do
The contract. Queries: `me`, `workspaces`, `workspace(slug)`, `issues(workspaceId, first, after, status)`,
`issue(id)`. Mutations: sign up/in, create workspace, add member, create issue, set status, comment.
Notice there is no `deleteWorkspace` and no "list all issues" — the surface is deliberately small.

### 2. `prisma/schema.prisma` — what the data can be
`User —< Membership >— Workspace —< Issue —< Comment`. The join table is the security model:
a user reaches a workspace only through a membership row, and the role lives on that row, not on the user.

### 3. `src/context.ts` — where authorization lives
- `requireMembership(ctx, workspaceId)` is the only gate. Every resolver that touches workspace data
  calls it first. Grep for it: six call sites, no exceptions.
- `makeLoaders()` batches authors, comment counts and comment lists. Without it,
  `issues(first: 20)` is 1 + 20 + 20 queries; with it, 3.

### 4. `src/resolvers.ts` — the logic
Read `issues` first (cursor pagination), then `addMember` (role check), then `createIssue`
(membership check). Note `take: first + 1` — that is how `hasNextPage` is computed without a count query.

### 5. `src/auth.ts` — identity
bcrypt for passwords, HS256 JWT for sessions, 7-day expiry, no refresh rotation (stated as a limit).

### 6. `tests/api.test.ts` — what is guaranteed
Seven tests, each pinning one promise:
1. health endpoint needs no token
2. an unauthenticated query returns `UNAUTHENTICATED`
3. sign up → sign in → `me`
4. duplicate email returns `CONFLICT`
5. two pages of cursor pagination, and a non-member gets `FORBIDDEN`
6. comment count and author resolve correctly (the DataLoader path)
7. adding a member grants access; before that, the workspace is invisible

### 7. `client/src/App.tsx` — the consumer
A thin React + Apollo Client app: auth form, workspace switcher, issue list with status transitions.
It exists to prove the API is consumable, not to be a product.

---

## The five questions you should be able to answer after reading

1. **Why cursor pagination instead of `OFFSET`?**
   New issues arriving between page loads make offset pagination skip or duplicate rows.
   The cursor is the row id ordered by `(createdAt desc, id desc)`.

2. **Where is tenant isolation enforced, and could a resolver forget it?**
   In `requireMembership`, and only there. Every workspace-scoped resolver calls it. A new resolver
   that forgets it fails the cross-tenant test only if a test covers that field — which is why the
   test exists.

3. **What is the N+1 problem here, and what fixes it?**
   Listing 20 issues and resolving each author and comment count = 41 queries. `DataLoader`
   batches by field within a request, so it is 3.

4. **Why is the role on `Membership` and not on `User`?**
   Roles are per workspace. A user can be an owner of one team and a member of another.

5. **What would you change before real traffic?**
   Rate limiting, query depth/complexity limits, refresh-token rotation, and a structured log with
   request ids. All four are named in the README as limits.

## If something looks wrong

Open an issue on the repo or tell me the file and line. This is meant to be reviewed, not admired —
a claim that does not survive your reading should come off before it ever reaches a CV.
