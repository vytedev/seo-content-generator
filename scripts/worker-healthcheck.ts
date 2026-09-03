import { z } from "zod";

const { WORKER_PID_FILE } = z
  .object({ WORKER_PID_FILE: z.string().min(1).default("/tmp/mm03-worker.pid") })
  .parse(process.env);

try {
  const text = await import("node:fs/promises").then(({ readFile }) =>
    readFile(WORKER_PID_FILE, "utf8"),
  );
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(1);
  process.kill(pid, 0);
  process.exit(0);
} catch {
  process.exit(1);
}
