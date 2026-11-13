import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * Refresh tokens are opaque random strings, stored only as a SHA-256 hash.
 * A database leak therefore does not hand out sessions, and the raw token exists
 * only in the client's storage and the response that created it.
 */
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS ?? 30);

export const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export type IssuedRefresh = { token: string; familyId: string; expiresAt: Date };

export async function issueRefreshToken(
  prisma: PrismaClient,
  userId: string,
  familyId = randomBytes(16).toString("hex"),
): Promise<IssuedRefresh> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(token), familyId, expiresAt },
  });
  return { token, familyId, expiresAt };
}

export type RotationResult =
  | { ok: true; userId: string; refresh: IssuedRefresh }
  | { ok: false; reason: "unknown" | "expired" | "reused" };

/**
 * Rotate on every use. If a token that was already rotated is presented again, the whole
 * family is revoked: that is the signature of a stolen token being replayed, and the only
 * safe response is to kill every descendant session.
 */
export async function rotateRefreshToken(prisma: PrismaClient, raw: string): Promise<RotationResult> {
  const tokenHash = hashToken(raw);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) return { ok: false, reason: "unknown" };

  if (existing.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: false, reason: "reused" };
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    await prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
    return { ok: false, reason: "expired" };
  }

  await prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  const refresh = await issueRefreshToken(prisma, existing.userId, existing.familyId);
  return { ok: true, userId: existing.userId, refresh };
}

export async function revokeFamily(prisma: PrismaClient, raw: string): Promise<void> {
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!existing) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: existing.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
