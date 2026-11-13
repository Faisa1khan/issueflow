import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "./context.js";
import { makeLoaders } from "./context.js";
import { prisma } from "./db.js";
import { readToken } from "./auth.js";
import { resolvers } from "./resolvers.js";
import { depthLimitPlugin } from "./depthLimit.js";
import { createRateLimit, type RateLimitOptions } from "./rateLimit.js";

const typeDefs = readFileSync(fileURLToPath(new URL("./schema.graphql", import.meta.url)), "utf8");

export type AppOptions = {
  /** false disables the limiter (the test suite does this except where it is under test). */
  rateLimit?: RateLimitOptions | false;
  maxDepth?: number;
};

export async function createApp(options: AppOptions = {}): Promise<Express> {
  const server = new ApolloServer<Context>({
    typeDefs,
    resolvers,
    plugins: [depthLimitPlugin(options.maxDepth)],
    // A production client should never see a stack trace; the error code is the contract.
    includeStacktraceInErrorResponses: process.env.NODE_ENV !== "production",
    formatError: (formatted) => {
      // Authorization failures leave the resolver as plain Errors; give clients a stable code.
      if (formatted.message === "UNAUTHENTICATED" || formatted.message === "FORBIDDEN") {
        return { ...formatted, extensions: { ...formatted.extensions, code: formatted.message } };
      }
      return formatted;
    },
  });
  await server.start();

  const app = express();
  app.disable("x-powered-by");

  // Configure 'trust proxy' based on TRUST_PROXY environment variable:
  // - unset: false in development, 1 (single reverse proxy hop) in production
  // - integer string: parse as Number
  // - otherwise: pass the raw string
  const rawTrustProxy = process.env.TRUST_PROXY;
  if (rawTrustProxy === undefined) {
    app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
  } else if (/^\d+$/.test(rawTrustProxy.trim())) {
    app.set("trust proxy", Number(rawTrustProxy.trim()));
  } else {
    app.set("trust proxy", rawTrustProxy);
  }

  // /healthz endpoint is open to any origin
  app.use("/healthz", cors());
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // CORS middleware: allowlist from CLIENT_ORIGIN (comma separated, default http://localhost:5173),
  // credentials true, OPTIONS preflight answered before the /graphql chain and before the rate limiter.
  const clientOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: clientOrigins,
      credentials: true,
    }),
  );

  const graphqlChain: RequestHandler[] = [];
  if (options.rateLimit !== false) graphqlChain.push(createRateLimit(options.rateLimit ?? {}));
  graphqlChain.push(
    express.json({ limit: "128kb" }),
    expressMiddleware(server, {
      context: async ({ req }): Promise<Context> => ({
        prisma,
        userId: readToken(req.headers.authorization),
        loaders: makeLoaders(prisma),
      }),
    }) as unknown as RequestHandler,
  );
  app.use("/graphql", ...graphqlChain);
  return app;
}
