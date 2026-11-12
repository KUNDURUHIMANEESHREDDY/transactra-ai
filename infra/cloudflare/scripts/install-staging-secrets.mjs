import { spawn } from "node:child_process";

const config = "infra/cloudflare/wrangler.staging.toml";
const secrets = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
];

function installSecret(name, value) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(
      command,
      ["dlx", "wrangler@4", "secret", "put", name, "--config", config],
      {
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Wrangler failed to install staging secret " + name + " (exit " + code + ")."));
    });
    // Send the exact secret bytes. PowerShell native-command pipelines can
    // append a newline, causing the Worker to reject the webhook header.
    child.stdin.end(value, "utf8");
  });
}

for (const name of secrets) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error("Missing staging secret: " + name);
  if (value !== value.trim()) throw new Error("Staging secret " + name + " contains surrounding whitespace; update the GitHub environment secret.");
  await installSecret(name, value);
  console.log("Installed " + name + " on the staging Worker.");
}
