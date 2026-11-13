import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET ?? "";
if (!SECRET) {
  // Fail loudly in production, allow local dev and tests to run with an explicit fallback.
  if (process.env.NODE_ENV === "production") throw new Error("JWT_SECRET is required in production");
}

const secret = () => SECRET || "dev-only-secret";

export type TokenClaims = { sub: string };

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, secret(), { expiresIn: "7d" });
}

export function readToken(header?: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    const claims = jwt.verify(token, secret()) as TokenClaims;
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}
