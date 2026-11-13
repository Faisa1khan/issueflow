import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // One process: the suite truncates shared tables between files.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: "test",
      JWT_SECRET: "test-secret-not-for-production",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://issueflow:issueflow@localhost:5433/issueflow_test?schema=public",
    },
  },
});
