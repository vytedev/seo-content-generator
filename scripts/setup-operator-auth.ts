import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { encodePassword } from "../src/server/auth/crypto.js";

const ENV_PATH = ".env";
const emailSchema = z.string().trim().email();

async function ask(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    const onData = (value: string) => {
      stdin.pause();
      stdin.removeListener("data", onData);
      resolve(value.replace(/[\r\n]+$/, ""));
    };
    stdin.on("data", onData);
  });
}

async function askHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
    throw new Error("Run this setup from an interactive terminal.");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const close = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };
    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        close();
        resolve(value);
        return;
      }
      if (key === "\u0003") {
        close();
        reject(new Error("Setup cancelled."));
        return;
      }
      if (key === "\u007f") value = value.slice(0, -1);
      else value += key;
    };
    stdin.on("data", onData);
  });
}

function upsert(source: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const expression = new RegExp(`^${key}=.*$`, "m");
  if (expression.test(source)) return source.replace(expression, line);
  const separator = source.length && !source.endsWith("\n") ? "\n" : "";
  return `${source}${separator}${line}\n`;
}

async function main() {
  const emailResult = emailSchema.safeParse(await ask("Operator email: "));
  if (!emailResult.success) throw new Error("Enter a valid operator email address.");
  const password = await askHidden("Operator password (minimum 12 characters): ");
  const confirmation = await askHidden("Confirm operator password: ");
  if (password.length < 12) throw new Error("Password must contain at least 12 characters.");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  let environment = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  environment = upsert(environment, "OPERATOR_EMAIL", emailResult.data.toLowerCase());
  environment = upsert(environment, "OPERATOR_PASSWORD_HASH", await encodePassword(password));
  environment = upsert(environment, "SESSION_SECRET", randomBytes(32).toString("base64url"));
  environment = upsert(environment, "SESSION_TTL_HOURS", "12");
  writeFileSync(ENV_PATH, environment, { mode: 0o600 });
  stdout.write("Operator authentication configured in the untracked local .env.\n");
  stdout.write("Restart npm run dev, then sign in with the email and password you entered.\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Operator setup failed.");
  process.exitCode = 1;
});
