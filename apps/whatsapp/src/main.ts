import { createWhatsAppCloudControl } from "../../../packages/channels/src/whatsapp-cloud.js";

const channel = createWhatsAppCloudControl();
const controller = new AbortController();
process.on("SIGINT", () => controller.abort(new Error("SIGINT")));
process.on("SIGTERM", () => controller.abort(new Error("SIGTERM")));
const port = Number(process.env.WHATSAPP_PORT ?? process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WHATSAPP_PORT must be a valid TCP port");

try {
  process.stdout.write(JSON.stringify({ event: "whatsapp_cloud_control_started", port }) + "\n");
  await channel.run(controller.signal,port);
} catch (error) {
  process.stderr.write(JSON.stringify({ event: "whatsapp_cloud_control_failed", message: error instanceof Error ? error.message : "unknown" }) + "\n");
  process.exitCode = 1;
} finally {
  await channel.close();
}
