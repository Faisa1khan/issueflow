import DataLoader from "dataloader";
import type { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";

export type Context = {
  prisma: PrismaClient;
  userId: string | null;
  loaders: {
    user: DataLoader<string, { id: string; email: string; name: string } | null>;
    commentCount: DataLoader<string, number>;
    comments: DataLoader<string, Array<{ id: string; body: string; createdAt: Date; authorId: string }>>;
  };
};

/** Batch the author lookup: N issues on a page must not become N user queries. */
export function makeLoaders(prisma: PrismaClient) {
  const user = new DataLoader<string, { id: string; email: string; name: string } | null>(async (ids) => {
    const rows = await prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, email: true, name: true },
    });
    const byId = new Map(rows.map((u) => [u.id, u]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  const commentCount = new DataLoader<string, number>(async (issueIds) => {
    const grouped = await prisma.comment.groupBy({
      by: ["issueId"],
      where: { issueId: { in: [...issueIds] } },
      _count: { _all: true },
    });
    const byId = new Map(grouped.map((g) => [g.issueId, g._count._all]));
    return issueIds.map((id) => byId.get(id) ?? 0);
  });

  const comments = new DataLoader<string, Array<{ id: string; body: string; createdAt: Date; authorId: string }>>(
    async (issueIds) => {
      const rows = await prisma.comment.findMany({
        where: { issueId: { in: [...issueIds] } },
        orderBy: { createdAt: "asc" },
      });
      const byIssue = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byIssue.get(row.issueId) ?? [];
        list.push(row);
        byIssue.set(row.issueId, list);
      }
      return issueIds.map((id) => byIssue.get(id) ?? []);
    },
  );

  return { user, commentCount, comments };
}

/** One authorization rule for the whole API: membership, not "is logged in". */
export async function requireMembership(ctx: Context, workspaceId: string): Promise<Role> {
  if (!ctx.userId) throw new Error("UNAUTHENTICATED");
  const membership = await ctx.prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId } },
    select: { role: true },
  });
  if (!membership) throw new Error("FORBIDDEN");
  return membership.role;
}
