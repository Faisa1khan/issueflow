import type { NextFunction, Request, Response } from "express";
import { RateLimiterMemory, RateLimiterRedis } from "rate-limiter-flexible";
import { Redis } from "ioredis";
import { readToken } from "./auth.js";

export type RateLimitOptions = {
  points?: number;
  durationSeconds?: number;
  blockSeconds?: number;
};

/**
 * Per-caller token bucket in front of the GraphQL endpoint.
 *
 * The key is the authenticated user id when a valid access token is present, otherwise the
 * socket address: one noisy tenant should not consume another's budget, and a shared NAT
 * should not become a single bucket. Redis is used when REDIS_URL is set so the limit holds
 * across replicas; the in-memory limiter is the fallback and insurance layer.
 */
export function createRateLimit(opts: RateLimitOptions = {}) {
  const points = opts.points ?? Number(process.env.RATE_LIMIT_POINTS ?? 120);
  const duration = opts.durationSeconds ?? Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
  const blockDuration = opts.blockSeconds ?? Number(process.env.RATE_LIMIT_BLOCK_SECONDS ?? 30);
  const insurance = new RateLimiterMemory({ points, duration, blockDuration });

  const client = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 }) : null;
  const limiter = client
    ? new RateLimiterRedis({ storeClient: client, points, duration, blockDuration, insuranceLimiter: insurance })
    : insurance;

  return async function rateLimit(req: Request, res: Response, next: NextFunction) {
    const userId = readToken(req.headers.authorization);
    const key = userId ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
    try {
      const result = await limiter.consume(key);
      res.setHeader("X-RateLimit-Limit", String(points));
      res.setHeader("X-RateLimit-Remaining", String(result.remainingPoints));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil((Date.now() + result.msBeforeNext) / 1000)));
      next();
    } catch (rejection) {
      const msBeforeNext = typeof rejection === "object" && rejection && "msBeforeNext" in rejection
        ? Number((rejection as { msBeforeNext: number }).msBeforeNext)
        : blockDuration * 1000;
      res.setHeader("Retry-After", String(Math.ceil(msBeforeNext / 1000)));
      res.status(429).json({
        errors: [{
          message: "Too many requests",
          extensions: { code: "TOO_MANY_REQUESTS", retryAfterSeconds: Math.ceil(msBeforeNext / 1000) },
        }],
      });
    }
  };
}
