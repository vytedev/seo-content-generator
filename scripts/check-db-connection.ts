// One-off diagnostic: verifies DATABASE_URL connectivity WITHOUT printing its value.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("RESULT: DATABASE_URL missing");
  process.exit(0);
}
try {
  const parsed = new URL(url);
  console.log(
    `host=${parsed.hostname} port=${parsed.port || "5432"} db=${parsed.pathname.replace(/^\//, "")} user=${parsed.username || "(none)"} ssl=${parsed.searchParams.get("sslmode") ?? "(default)"}`,
  );
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const r = await client.query("select count(*)::int as n from runs");
  console.log(`RESULT: connected OK, runs table rows=${r.rows[0].n}`);
  await client.end();
} catch (err) {
  console.log(
    `RESULT: FAILED code=${err.code ?? "n/a"} name=${err.name} message="${err.message.split("\n")[0].slice(0, 120)}"`,
  );
}
