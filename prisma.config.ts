import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Load .env.local first (Next.js convention), fallback to .env
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
