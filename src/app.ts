import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "./context.js";
import { makeLoaders } from "./context.js";
import { prisma } from "./db.js";
import { readToken } from "./auth.js";
import { resolvers } from "./resolvers.js";

const typeDefs = readFileSync(fileURLToPath(new URL("./schema.graphql", import.meta.url)), "utf8");

export async function createApp(): Promise<Express> {
  const server = new ApolloServer<Context>({
    typeDefs,
    resolvers,
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
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(
    "/graphql",
    express.json({ limit: "128kb" }),
    expressMiddleware(server, {
      context: async ({ req }): Promise<Context> => ({
        prisma,
        userId: readToken(req.headers.authorization),
        loaders: makeLoaders(prisma),
      }),
    }),
  );
  return app;
}
