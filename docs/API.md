# API reference

Endpoint: `POST /graphql` (and `GET /graphql` for the Apollo sandbox in development).
Auth: `Authorization: Bearer <accessToken>`.

## Auth flow

```graphql
mutation {
  signUp(input: { email: "priya@example.com", name: "Priya", password: "correct-horse" }) {
    token
    refreshToken
    user { id email name }
  }
}
```

- `token` — 15-minute access token. Send it on every request.
- `refreshToken` — 30-day opaque token. Store it; never send it as a bearer token.

Rotate when the access token expires:

```graphql
mutation($t: String!) {
  refreshSession(token: $t) { token refreshToken user { id } }
}
```

The presented refresh token is revoked and replaced. Presenting it again returns
`REFRESH_REUSED` **and revokes every token in the family** — that is deliberate: replay means the
token leaked, so the safe answer is to end all descendant sessions.

Sign out:

```graphql
mutation($t: String!) { signOut(token: $t) }
```

## Queries

```graphql
query {
  me { id email name }
  workspaces { id name slug role issueCount }
}
```

```graphql
query($id: ID!, $after: String) {
  issues(workspaceId: $id, first: 20, after: $after, status: OPEN) {
    edges {
      cursor
      node { id title status priority commentCount author { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

Pagination: pass `pageInfo.endCursor` as `after`. `first` is clamped to 1-100; the default is 20.

## Mutations

```graphql
mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { id title status }
}
# variables: { "input": { "workspaceId": "...", "title": "Login fails", "body": "...", "priority": 2 } }
```

```graphql
mutation { setIssueStatus(id: "...", status: DONE) { id status } }
mutation { addComment(issueId: "...", body: "Reproduced on staging") { id body author { name } } }
mutation { addMember(workspaceId: "...", email: "new@example.com", role: MEMBER) { id } }
```

`priority` is 1-4. `addMember` requires `OWNER` or `ADMIN`.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 200 (GraphQL) | missing, invalid or expired access token |
| `FORBIDDEN` | 200 | authenticated but not a member of that workspace |
| `BAD_USER_INPUT` | 200 | validation failure (short password, bad priority) |
| `CONFLICT` | 200 | duplicate email |
| `NOT_FOUND` | 200 | issue or user does not exist |
| `REFRESH_EXPIRED` | 200 | refresh token past its 30-day life |
| `REFRESH_REUSED` | 200 | rotated token replayed; family revoked |
| `TOO_MANY_REQUESTS` | **429** | rate limit, see `Retry-After` |
| `QUERY_TOO_DEEP` | 200 | selection depth above `MAX_QUERY_DEPTH` |

Rate limit headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (epoch seconds).

## Depth limit

The limit counts field nesting, including named and inline fragments, and ignores `__typename`.
Default 8. The query below is depth 5 and allowed; wrapping the author in another `issues` level
would exceed the default.

```graphql
{
  issues(workspaceId: "x") {   # 1
    edges {                    # 2
      node {                   # 3
        author { name }        # 4, 5
      }
    }
  }
}
```
