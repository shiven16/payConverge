import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

const sql = await readFile(join(process.cwd(), "migrations", "001_init.sql"), "utf8");
await pool.query(sql);
await pool.end();
console.log("migrations applied");
