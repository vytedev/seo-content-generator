import { stdin, stdout } from "node:process";
import { encodePassword } from "../src/server/auth/crypto.js";

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/[\r\n]+$/, "");
  }
  stdout.write("Operator password: ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      resolve(value);
    };
    const onData = (key: string) => {
      if (key === "\r" || key === "\n") return finish();
      if (key === "\u0003") {
        stdin.setRawMode(false);
        reject(new Error("Password entry cancelled"));
        return;
      }
      if (key === "\u007f") value = value.slice(0, -1);
      else value += key;
    };
    stdin.on("data", onData);
  });
}

const password = await readPassword();
if (password.length < 12) {
  console.error("Password must contain at least 12 characters.");
  process.exitCode = 1;
} else {
  process.stdout.write(`${await encodePassword(password)}\n`);
}
