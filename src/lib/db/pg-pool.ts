import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

let pool: pg.Pool | null = null;

export function getPgPool(): pg.Pool {
  if (!pool) {
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL environment variable is required for PostgreSQL connection pool.",
      );
    }
    pool = new pg.Pool({
      connectionString,
      ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 10,
    });
  }
  return pool;
}
