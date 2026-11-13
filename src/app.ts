import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express, { type Express, type RequestHandler } from "express";
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
  app.set("trust proxy", true);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

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
