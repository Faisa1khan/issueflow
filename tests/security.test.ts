import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { documentDepth } from "../src/depthLimit.js";
import { parse } from "graphql";

const SIGN_UP = `mutation($input: SignUpInput!) { signUp(input: $input) { token refreshToken user { id } } }`;
const REFRESH = `mutation($t: String!) { refreshSession(token: $t) { token refreshToken user { id } } }`;
const SIGN_OUT = `mutation($t: String!) { signOut(token: $t) }`;

let app: Express;

async function signUp(email: string) {
  const res = await request(app)
    .post("/graphql")
    .send({ query: SIGN_UP, variables: { input: { email, name: "Security User", password: "correct-horse" } } });
  expect(res.body.errors).toBeUndefined();
  return res.body.data.signUp as { token: string; refreshToken: string; user: { id: string } };
}

beforeAll(async () => {
  app = await createApp({ rateLimit: false });
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "Comment", "Issue", "Membership", "Workspace", "User" RESTART IDENTITY CASCADE',
  );
});

describe("query depth protection", () => {
  it("counts depth through named and inline fragments", () => {
    const doc = parse(`
      query Deep { issues(workspaceId: "x") { edges { node { author { issues { edges { node { id } } } } } } } }
    `);
    // issues(1) edges(2) node(3) author(4) issues(5) edges(6) node(7) id(8)
    expect(documentDepth(doc)).toBe(8);
  });

  it("ignores __typename, which appears at every level and costs nothing", () => {
    const doc = parse(`query { __typename me { __typename id } }`);
    expect(documentDepth(doc)).toBe(2);
  });

  it("rejects a query deeper than the configured limit before execution", async () => {
    const shallow = await createApp({ rateLimit: false, maxDepth: 3 });
    const res = await request(shallow)
      .post("/graphql")
      .send({ query: `query { issues(workspaceId: "x") { edges { node { id } } } }` });
    expect(res.body.errors?.[0]?.extensions?.code).toBe("QUERY_TOO_DEEP");
    expect(res.body.data).toBeUndefined();
  });
});

describe("rate limiting", () => {
  it("allows the budget, then returns 429 with Retry-After", async () => {
    const limited = await createApp({ rateLimit: { points: 3, durationSeconds: 60, blockSeconds: 2 } });
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(limited).post("/graphql").send({ query: "{ __typename }" });
      expect(ok.status).toBe(200);
      expect(ok.headers["x-ratelimit-remaining"]).toBe(String(2 - i));
    }
    const blocked = await request(limited).post("/graphql").send({ query: "{ __typename }" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.body.errors[0].extensions.code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("refresh token rotation", () => {
  it("rotates on use and revokes the presented token", async () => {
    const session = await signUp("rotate@example.com");

    const first = await request(app).post("/graphql").send({ query: REFRESH, variables: { t: session.refreshToken } });
    expect(first.body.errors).toBeUndefined();
    const rotated = first.body.data.refreshSession;
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    const reuse = await request(app).post("/graphql").send({ query: REFRESH, variables: { t: session.refreshToken } });
    expect(reuse.body.errors?.[0]?.extensions?.code).toBe("REFRESH_REUSED");
  });

  it("kills the whole family when a rotated token is replayed", async () => {
    const session = await signUp("family@example.com");
    const first = await request(app).post("/graphql").send({ query: REFRESH, variables: { t: session.refreshToken } });
    const rotated = first.body.data.refreshSession.refreshToken;

    // Attacker replays the stolen original: the legitimate rotated token must die with it.
    await request(app).post("/graphql").send({ query: REFRESH, variables: { t: session.refreshToken } });
    const legit = await request(app).post("/graphql").send({ query: REFRESH, variables: { t: rotated } });
    expect(legit.body.errors?.[0]?.extensions?.code).toBe("REFRESH_REUSED");
  });

  it("revokes the family on sign out", async () => {
    const session = await signUp("logout@example.com");
    const out = await request(app).post("/graphql").send({ query: SIGN_OUT, variables: { t: session.refreshToken } });
    expect(out.body.data.signOut).toBe(true);
    const after = await request(app).post("/graphql").send({ query: REFRESH, variables: { t: session.refreshToken } });
    expect(after.body.errors?.[0]?.extensions?.code).toBe("REFRESH_REUSED");
  });

  it("stores only a hash of the refresh token", async () => {
    const session = await signUp("hash@example.com");
    const rows = await prisma.refreshToken.findMany({ where: { user: { email: "hash@example.com" } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(session.refreshToken);
    expect(rows[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
