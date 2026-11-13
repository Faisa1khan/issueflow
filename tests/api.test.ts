import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";

let app: Express;

type GqlOptions = { token?: string; variables?: Record<string, unknown> };

async function gql(query: string, { token, variables }: GqlOptions = {}) {
  const req = request(app).post("/graphql");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send({ query, variables });
}

const SIGN_UP = `mutation($input: SignUpInput!) { signUp(input: $input) { token user { id email name } } }`;

async function signUp(email: string) {
  const res = await gql(SIGN_UP, { variables: { input: { email, name: "Test User", password: "correct-horse" } } });
  expect(res.body.errors).toBeUndefined();
  return res.body.data.signUp.token as string;
}

beforeAll(async () => {
  app = await createApp();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Comment", "Issue", "Membership", "Workspace", "User" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("auth boundary", () => {
  it("serves health without a token", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects an unauthenticated issues query with UNAUTHENTICATED", async () => {
    const res = await gql(`query { issues(workspaceId: "nope") { edges { node { id } } } }`);
    expect(res.body.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
  });

  it("signs up, signs in and resolves the current user", async () => {
    const token = await signUp("owner@example.com");
    const res = await gql(`query { me { email name } }`, { token });
    expect(res.body.data.me).toEqual({ email: "owner@example.com", name: "Test User" });

    const signIn = await gql(
      `mutation($input: SignInInput!) { signIn(input: $input) { token } }`,
      { variables: { input: { email: "owner@example.com", password: "correct-horse" } } },
    );
    expect(signIn.body.data.signIn.token).toBeTruthy();
  });

  it("refuses a duplicate email", async () => {
    const res = await gql(SIGN_UP, {
      variables: { input: { email: "owner@example.com", name: "Copy", password: "correct-horse" } },
    });
    expect(res.body.errors?.[0]?.extensions?.code).toBe("CONFLICT");
  });
});

describe("multi-tenant isolation", () => {
  it("lets a member paginate issues and blocks a non-member", async () => {
    const owner = await signUp("owner2@example.com");
    const outsider = await signUp("outsider@example.com");

    const ws = await gql(`mutation { createWorkspace(name: "Platform Team") { id slug role } }`, { token: owner });
    expect(ws.body.data.createWorkspace.role).toBe("OWNER");
    const workspaceId = ws.body.data.createWorkspace.id as string;

    for (const title of ["First issue", "Second issue", "Third issue"]) {
      const created = await gql(
        `mutation($input: CreateIssueInput!) { createIssue(input: $input) { id title status } }`,
        { token: owner, variables: { input: { workspaceId, title, body: "Details" } } },
      );
      expect(created.body.data.createIssue.status).toBe("OPEN");
    }

    const page = await gql(
      `query($id: ID!) { issues(workspaceId: $id, first: 2) {
          edges { cursor node { id title author { email } commentCount } }
          pageInfo { hasNextPage endCursor } } }`,
      { token: owner, variables: { id: workspaceId } },
    );
    expect(page.body.data.issues.edges).toHaveLength(2);
    expect(page.body.data.issues.pageInfo.hasNextPage).toBe(true);
    expect(page.body.data.issues.edges[0].node.author.email).toBe("owner2@example.com");

    const next = await gql(
      `query($id: ID!, $after: String) { issues(workspaceId: $id, first: 2, after: $after) {
          edges { node { id } } pageInfo { hasNextPage } } }`,
      { token: owner, variables: { id: workspaceId, after: page.body.data.issues.pageInfo.endCursor } },
    );
    expect(next.body.data.issues.edges).toHaveLength(1);
    expect(next.body.data.issues.pageInfo.hasNextPage).toBe(false);

    const blocked = await gql(
      `query($id: ID!) { issues(workspaceId: $id) { edges { node { id } } } }`,
      { token: outsider, variables: { id: workspaceId } },
    );
    expect(blocked.body.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  it("counts comments and loads authors without N+1 queries", async () => {
    const token = await signUp("commenter@example.com");
    const ws = await gql(`mutation { createWorkspace(name: "Support") { id } }`, { token });
    const workspaceId = ws.body.data.createWorkspace.id as string;
    const issue = await gql(
      `mutation($input: CreateIssueInput!) { createIssue(input: $input) { id } }`,
      { token, variables: { input: { workspaceId, title: "Login fails", body: "Repro steps" } } },
    );
    const issueId = issue.body.data.createIssue.id as string;

    await gql(`mutation($id: ID!) { addComment(issueId: $id, body: "Reproduced on staging") { id } }`, {
      token,
      variables: { id: issueId },
    });

    const res = await gql(
      `query($id: ID!) { issue(id: $id) { commentCount comments { body author { name } } } }`,
      { token, variables: { id: issueId } },
    );
    expect(res.body.data.issue.commentCount).toBe(1);
    expect(res.body.data.issue.comments[0]).toMatchObject({ body: "Reproduced on staging", author: { name: "Test User" } });
  });

  it("scopes reads to membership: an added member gains access", async () => {
    const owner = await signUp("inviter@example.com");
    const member = await signUp("invitee@example.com");
    const ws = await gql(`mutation { createWorkspace(name: "Growth") { id slug } }`, { token: owner });
    const workspaceId = ws.body.data.createWorkspace.id as string;

    const before = await gql(`query($s: String!) { workspace(slug: $s) { id } }`, {
      token: member,
      variables: { s: ws.body.data.createWorkspace.slug },
    });
    expect(before.body.data.workspace).toBeNull();

    const added = await gql(
      `mutation($id: ID!) { addMember(workspaceId: $id, email: "invitee@example.com") { id } }`,
      { token: owner, variables: { id: workspaceId } },
    );
    expect(added.body.errors).toBeUndefined();

    const after = await gql(`query($s: String!) { workspace(slug: $s) { id } }`, {
      token: member,
      variables: { s: ws.body.data.createWorkspace.slug },
    });
    expect(after.body.data.workspace.id).toBe(workspaceId);
  });
});
