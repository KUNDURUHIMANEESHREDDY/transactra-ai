import { spawn } from "node:child_process";

const config = "infra/cloudflare/wrangler.staging.toml";
const requiredSecrets = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
];
const optionalSecrets = [
  "CLOUDFLARE_READONLY_API_TOKEN",
  "TAVILY_API_KEY",
  "BACKEND_SHARED_SECRET",
  "TRANSACTRA_API_BASE_URL",
];

function installSecret(name, value) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(
      command,
      ["exec", "wrangler", "secret", "put", name, "--config", config],
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

for (const name of requiredSecrets) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error("Missing staging secret: " + name);
  if (value !== value.trim()) throw new Error("Staging secret " + name + " contains surrounding whitespace; update the GitHub environment secret.");
  await installSecret(name, value);
  console.log("Installed required secret " + name + " on the staging Worker.");
}
for (const name of optionalSecrets) {
  const value = process.env[name];
  if (!value || !value.trim()) continue;
  if (value !== value.trim()) throw new Error("Optional staging secret " + name + " contains surrounding whitespace; update the GitHub environment secret.");
  await installSecret(name, value);
  console.log("Installed optional secret " + name + " on the staging Worker.");
}
