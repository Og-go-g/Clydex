import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "prisma/history.prisma",
  migrations: {
    path: "prisma/history-migrations",
  },
  datasource: {
    url: process.env["HISTORY_DATABASE_URL"],
  },
});
