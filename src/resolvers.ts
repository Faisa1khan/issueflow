import { GraphQLError } from "graphql";
import { randomBytes } from "node:crypto";
import type { Context } from "./context.js";
import { requireMembership } from "./context.js";
import { hashPassword, signToken, verifyPassword } from "./auth.js";
import { issueRefreshToken, revokeFamily, rotateRefreshToken } from "./tokens.js";

const bad = (code: string, message: string) =>
  new GraphQLError(message, { extensions: { code } });

const emailOf = (raw: string) => raw.trim().toLowerCase();

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

function clampFirst(first: number | null | undefined): number {
  const n = first ?? 20;
  if (n < 1 || n > 100) throw bad("BAD_USER_INPUT", "first must be between 1 and 100");
  return n;
}

export const resolvers = {
  Query: {
    me: (_: unknown, __: unknown, ctx: Context) =>
      ctx.userId ? ctx.loaders.user.load(ctx.userId) : null,

    workspaces: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) throw bad("UNAUTHENTICATED", "Sign in first");
      const rows = await ctx.prisma.workspace.findMany({
        where: { memberships: { some: { userId: ctx.userId } } },
        include: { memberships: { where: { userId: ctx.userId }, select: { role: true } } },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((w) => ({ ...w, role: w.memberships[0]?.role ?? "MEMBER" }));
    },

    workspace: async (_: unknown, args: { slug: string }, ctx: Context) => {
      if (!ctx.userId) throw bad("UNAUTHENTICATED", "Sign in first");
      const row = await ctx.prisma.workspace.findUnique({
        where: { slug: args.slug },
        include: { memberships: { where: { userId: ctx.userId }, select: { role: true } } },
      });
      if (!row || row.memberships.length === 0) return null;
      return { ...row, role: row.memberships[0].role };
    },

    issues: async (
      _: unknown,
      args: { workspaceId: string; first?: number; after?: string; status?: "OPEN" | "IN_PROGRESS" | "DONE" },
      ctx: Context,
    ) => {
      await requireMembership(ctx, args.workspaceId);
      const take = clampFirst(args.first);
      const rows = await ctx.prisma.issue.findMany({
        where: { workspaceId: args.workspaceId, ...(args.status ? { status: args.status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        ...(args.after ? { cursor: { id: args.after }, skip: 1 } : {}),
      });
      const hasNextPage = rows.length > take;
      const page = hasNextPage ? rows.slice(0, take) : rows;
      return {
        edges: page.map((node) => ({ cursor: node.id, node })),
        pageInfo: { hasNextPage, endCursor: page.at(-1)?.id ?? null },
      };
    },

    issue: async (_: unknown, args: { id: string }, ctx: Context) => {
      const issue = await ctx.prisma.issue.findUnique({ where: { id: args.id } });
      if (!issue) return null;
      await requireMembership(ctx, issue.workspaceId);
      return issue;
    },
  },

  Mutation: {
    signUp: async (
      _: unknown,
      args: { input: { email: string; name: string; password: string } },
      ctx: Context,
    ) => {
      const email = emailOf(args.input.email);
      const name = args.input.name.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("BAD_USER_INPUT", "A valid email is required");
      if (name.length < 2) throw bad("BAD_USER_INPUT", "Name is too short");
      if (args.input.password.length < 8) throw bad("BAD_USER_INPUT", "Password must be at least 8 characters");
      const exists = await ctx.prisma.user.findUnique({ where: { email } });
      if (exists) throw bad("CONFLICT", "That email is already registered");
      const user = await ctx.prisma.user.create({
        data: { email, name, passwordHash: await hashPassword(args.input.password) },
        select: { id: true, email: true, name: true },
      });
      const refresh = await issueRefreshToken(ctx.prisma, user.id);
      return { token: signToken(user.id), refreshToken: refresh.token, user };
    },

    signIn: async (_: unknown, args: { input: { email: string; password: string } }, ctx: Context) => {
      const user = await ctx.prisma.user.findUnique({ where: { email: emailOf(args.input.email) } });
      if (!user || !(await verifyPassword(args.input.password, user.passwordHash))) {
        throw bad("UNAUTHENTICATED", "Email or password is incorrect");
      }
      const refresh = await issueRefreshToken(ctx.prisma, user.id);
      return {
        token: signToken(user.id),
        refreshToken: refresh.token,
        user: { id: user.id, email: user.email, name: user.name },
      };
    },

    /**
     * Rotation, not renewal. The presented token is revoked and a new one is issued in the
     * same family; presenting a revoked token again means it leaked, so the family dies.
     */
    refreshSession: async (_: unknown, args: { token: string }, ctx: Context) => {
      const result = await rotateRefreshToken(ctx.prisma, args.token);
      if (!result.ok) {
        const code =
          result.reason === "expired" ? "REFRESH_EXPIRED"
          : result.reason === "reused" ? "REFRESH_REUSED"
          : "UNAUTHENTICATED";
        throw bad(code, "Refresh token is not valid");
      }
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: result.userId },
        select: { id: true, email: true, name: true },
      });
      return { token: signToken(user.id), refreshToken: result.refresh.token, user };
    },

    signOut: async (_: unknown, args: { token: string }, ctx: Context) => {
      await revokeFamily(ctx.prisma, args.token);
      return true;
    },

    createWorkspace: async (_: unknown, args: { name: string }, ctx: Context) => {
      if (!ctx.userId) throw bad("UNAUTHENTICATED", "Sign in first");
      const name = args.name.trim();
      if (name.length < 2) throw bad("BAD_USER_INPUT", "Workspace name is too short");
      const workspace = await ctx.prisma.workspace.create({
        data: { name, slug: slugify(name), memberships: { create: { userId: ctx.userId, role: "OWNER" } } },
      });
      return { ...workspace, role: "OWNER" };
    },

    addMember: async (
      _: unknown,
      args: { workspaceId: string; email: string; role?: "OWNER" | "ADMIN" | "MEMBER" },
      ctx: Context,
    ) => {
      const role = await requireMembership(ctx, args.workspaceId);
      if (role === "MEMBER") throw bad("FORBIDDEN", "Only owners and admins can add members");
      const user = await ctx.prisma.user.findUnique({ where: { email: emailOf(args.email) } });
      if (!user) throw bad("NOT_FOUND", "No account with that email. Ask them to sign up first.");

      const existingMembership = await ctx.prisma.membership.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: args.workspaceId } },
      });

      const newRole = args.role ?? "MEMBER";

      if (newRole === "OWNER" && role !== "OWNER") {
        throw bad("FORBIDDEN", "Only an owner may grant the OWNER role");
      }

      if (existingMembership?.role === "OWNER" && role !== "OWNER") {
        throw bad("FORBIDDEN", "Only an owner may change an existing owner");
      }

      if (role === "ADMIN" && existingMembership?.role === "ADMIN") {
        throw bad("FORBIDDEN", "Admins may not modify other admins");
      }

      if (existingMembership?.role === "OWNER" && newRole !== "OWNER") {
        const ownerCount = await ctx.prisma.membership.count({
          where: { workspaceId: args.workspaceId, role: "OWNER" },
        });
        if (ownerCount <= 1) {
          throw bad("BAD_USER_INPUT", "The last owner cannot be demoted");
        }
      }

      if (ctx.userId === user.id) {
        throw bad("FORBIDDEN", "Cannot modify your own membership through addMember");
      }

      await ctx.prisma.membership.upsert({
        where: { userId_workspaceId: { userId: user.id, workspaceId: args.workspaceId } },
        create: { userId: user.id, workspaceId: args.workspaceId, role: newRole },
        update: { role: newRole },
      });
      const workspace = await ctx.prisma.workspace.findUniqueOrThrow({ where: { id: args.workspaceId } });
      return { ...workspace, role };
    },

    createIssue: async (
      _: unknown,
      args: { input: { workspaceId: string; title: string; body: string; priority?: number } },
      ctx: Context,
    ) => {
      await requireMembership(ctx, args.input.workspaceId);
      const title = args.input.title.trim();
      if (title.length < 3) throw bad("BAD_USER_INPUT", "Title is too short");
      const priority = args.input.priority ?? 2;
      if (priority < 1 || priority > 4) throw bad("BAD_USER_INPUT", "Priority must be 1 to 4");
      return ctx.prisma.issue.create({
        data: {
          workspaceId: args.input.workspaceId,
          authorId: ctx.userId!,
          title,
          body: args.input.body.trim(),
          priority,
        },
      });
    },

    setIssueStatus: async (
      _: unknown,
      args: { id: string; status: "OPEN" | "IN_PROGRESS" | "DONE" },
      ctx: Context,
    ) => {
      const issue = await ctx.prisma.issue.findUnique({ where: { id: args.id } });
      if (!issue) throw bad("NOT_FOUND", "Issue not found");
      await requireMembership(ctx, issue.workspaceId);
      return ctx.prisma.issue.update({ where: { id: args.id }, data: { status: args.status } });
    },

    addComment: async (_: unknown, args: { issueId: string; body: string }, ctx: Context) => {
      const issue = await ctx.prisma.issue.findUnique({ where: { id: args.issueId } });
      if (!issue) throw bad("NOT_FOUND", "Issue not found");
      await requireMembership(ctx, issue.workspaceId);
      const body = args.body.trim();
      if (!body) throw bad("BAD_USER_INPUT", "Comment cannot be empty");
      return ctx.prisma.comment.create({ data: { issueId: args.issueId, authorId: ctx.userId!, body } });
    },
  },

  Workspace: {
    role: (parent: { role?: string; memberships?: Array<{ role: string }> }) =>
      parent.role ?? parent.memberships?.[0]?.role ?? "MEMBER",
    issueCount: async (
      parent: { id: string },
      args: { status?: string },
      ctx: Context,
    ) => {
      await requireMembership(ctx, parent.id);
      return ctx.prisma.issue.count({
        where: { workspaceId: parent.id, ...(args.status ? { status: args.status as never } : {}) },
      });
    },
  },

  Issue: {
    author: (parent: { authorId: string }, _: unknown, ctx: Context) => ctx.loaders.user.load(parent.authorId),
    commentCount: (parent: { id: string }, _: unknown, ctx: Context) => ctx.loaders.commentCount.load(parent.id),
    comments: (parent: { id: string }, _: unknown, ctx: Context) => ctx.loaders.comments.load(parent.id),
    createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
  },

  Comment: {
    author: (parent: { authorId: string }, _: unknown, ctx: Context) => ctx.loaders.user.load(parent.authorId),
    createdAt: (parent: { createdAt: Date }) => parent.createdAt.toISOString(),
  },
};
