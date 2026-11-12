import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { OrganizationStore } from "../../storage/src/organization.js";
import { NotificationDispatcher } from "../../organization/src/notifications.js";
import { ControlSurface } from "./control-surface.js";

interface WhatsAppTextMessage { id: string; from: string; type: string; text?: { body?: string }; }
interface WhatsAppPayload { entry?: Array<{ changes?: Array<{ value?: { messages?: WhatsAppTextMessage[] } }> }>; }

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value.trim();
}

export class WhatsAppCloudControl {
  readonly #pool: Pool;
  readonly #appSecret: string;
  readonly #verifyToken: string;
  readonly #accessToken: string;
  readonly #phoneNumberId: string;
  readonly #graphVersion: string;
  readonly #allowedUsers: ReadonlySet<string>;
  readonly #surface: ControlSurface;
  readonly #organization: OrganizationStore;
  readonly #dispatcher: NotificationDispatcher;
  readonly #webhookPath: string;
  readonly #workerId = randomUUID();
  readonly #server = createServer((request,response) => { void this.#handleHttp(request,response); });

  constructor(input: {
    connectionString: string; appSecret: string; verifyToken: string; accessToken: string;
    phoneNumberId: string; graphVersion: string; allowedUsers: readonly string[];
    controlPlaneUrl: string; apiToken: string; approvalToken: string; ownerId: string; webhookPath?: string;
  }) {
    if ([input.connectionString,input.appSecret,input.verifyToken,input.accessToken,input.phoneNumberId,input.apiToken,input.approvalToken].some((value) => !value.trim())) throw new Error("WhatsApp and control-plane credentials are required");
    if (!/^v\d+\.\d+$/.test(input.graphVersion)) throw new Error("WHATSAPP_GRAPH_API_VERSION must look like vNN.0");
    if (!/^\d+$/.test(input.phoneNumberId)) throw new Error("WHATSAPP_PHONE_NUMBER_ID must be numeric");
    if (input.allowedUsers.length === 0 || input.allowedUsers.some((value) => !/^\d{8,15}$/.test(value))) throw new Error("At least one E.164 WhatsApp sender ID must be allowlisted as digits");
    this.#pool = new Pool({ connectionString: input.connectionString, max: 2, application_name: "transactra-whatsapp" });
    this.#appSecret = input.appSecret;
    this.#verifyToken = input.verifyToken;
    this.#accessToken = input.accessToken;
    this.#phoneNumberId = input.phoneNumberId;
    this.#graphVersion = input.graphVersion;
    this.#allowedUsers = new Set(input.allowedUsers);
    this.#surface = new ControlSurface({
      controlPlaneUrl: input.controlPlaneUrl,
      apiToken: input.apiToken,
      approvalToken: input.approvalToken
    });
    this.#organization = new OrganizationStore(input.connectionString);
    this.#dispatcher = new NotificationDispatcher({
      store: this.#organization,
      ownerId: input.ownerId,
      workerId: "whatsapp-" + this.#workerId,
      channels: ["whatsapp","owner"],
      sender: async (notification) => {
        for (const recipient of this.#allowedUsers) {
          await this.#send(recipient,"Transactra " + notification.kind + "\n\n" + notification.message);
        }
      }
    });
    this.#webhookPath = input.webhookPath ?? "/webhook";
    if (!this.#webhookPath.startsWith("/") || this.#webhookPath.includes("..")) throw new Error("Invalid WhatsApp webhook path");
  }

  async close(): Promise<void> {
    if (this.#server.listening) await new Promise<void>((resolve,reject) => this.#server.close((error) => error ? reject(error) : resolve()));
    await Promise.allSettled([this.#organization.close(),this.#pool.end()]);
  }

  async run(signal: AbortSignal,port: number,host = "127.0.0.1"): Promise<void> {
    await this.listen(port,host);
    while (!signal.aborted) {
      try {
        await this.#dispatcher.dispatchOnce(signal);
        const processed = await this.#processNext();
        if (!processed) await this.#delay(1000,signal);
      } catch {
        if (!signal.aborted) await this.#delay(5000,signal);
      }
    }
  }

  async listen(port: number, host = "127.0.0.1"): Promise<void> {
    await new Promise<void>((resolve,reject) => {
      this.#server.once("error",reject);
      this.#server.listen(port,host,() => { this.#server.off("error",reject); resolve(); });
    });
  }

  async #handleHttp(request: IncomingMessage,response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== this.#webhookPath) { response.writeHead(404).end(); return; }
    if (request.method === "GET") {
      const valid = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === this.#verifyToken;
      const challenge = url.searchParams.get("hub.challenge");
      if (!valid || challenge === null) { response.writeHead(403).end("Forbidden"); return; }
      response.writeHead(200,{"content-type":"text/plain"}).end(challenge);
      return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    try {
      const raw = await this.#readBody(request,1024 * 1024);
      if (!this.#verifySignature(raw,request.headers["x-hub-signature-256"])) { response.writeHead(401).end("Invalid signature"); return; }
      const payload = JSON.parse(raw) as WhatsAppPayload;
      await this.#enqueuePayload(payload);
      response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({ received: true }));
    } catch (error) {
      const status = error instanceof Error && error.message === "Payload too large" ? 413 : 400;
      if (!response.headersSent) response.writeHead(status).end(status === 413 ? "Payload too large" : "Invalid webhook payload");
    }
  }

  async #readBody(request: IncomingMessage,limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw new Error("Payload too large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  #verifySignature(raw: string,header: string | string[] | undefined): boolean {
    if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const expected = "sha256=" + createHmac("sha256",this.#appSecret).update(raw).digest("hex");
    const receivedBuffer = Buffer.from(header);
    const expectedBuffer = Buffer.from(expected);
    return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer,expectedBuffer);
  }

  async #enqueuePayload(payload: WhatsAppPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          if (!message.id || !message.from || !this.#allowedUsers.has(message.from)) continue;
          const safeMessage: WhatsAppTextMessage = {
            id: message.id, from: message.from, type: message.type,
            ...(message.text?.body ? { text: { body: message.text.body.slice(0,4000) } } : {})
          };
          await this.#pool.query(
            "INSERT INTO whatsapp_inbox(message_id,sender,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT(message_id) DO NOTHING",
            [safeMessage.id,safeMessage.from,JSON.stringify(safeMessage)]
          );
        }
      }
    }
  }

  async #processNext(): Promise<boolean> {
    const client = await this.#pool.connect();
    let message: WhatsAppTextMessage | undefined;
    let attempt = 0;
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ message_id: string; sender: string; payload: WhatsAppTextMessage; attempts: number }>(
        "SELECT message_id,sender,payload,attempts FROM whatsapp_inbox WHERE (status='queued' AND available_at<=now()) OR (status='processing' AND lease_until<now()) ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
      );
      const row = selected.rows[0];
      if (!row) { await client.query("COMMIT"); return false; }
      message = row.payload;
      attempt = row.attempts + 1;
      await client.query(
        "UPDATE whatsapp_inbox SET status='processing',attempts=$2,lease_owner=$3,lease_until=now()+interval '60 seconds',updated_at=now() WHERE message_id=$1",
        [row.message_id,attempt,this.#workerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!message) return false;
    try {
      if (message.type === "text" && typeof message.text?.body === "string") await this.#handleText(message.from,message.text.body);
      else await this.#send(message.from,"Transactra currently accepts text commands only. Send /help.");
      await this.#pool.query("UPDATE whatsapp_inbox SET status='succeeded',lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE message_id=$1 AND lease_owner=$2",[message.id,this.#workerId]);
    } catch {
      const delaySeconds = Math.min(300,5 * (2 ** Math.min(attempt,6)));
      await this.#pool.query(
        "UPDATE whatsapp_inbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,available_at=now()+($3 * interval '1 second'),lease_owner=NULL,lease_until=NULL,last_error='message_processing_failed',updated_at=now() WHERE message_id=$1 AND lease_owner=$2",
        [message.id,this.#workerId,delaySeconds]
      );
    }
    return true;
  }

  async #delay(ms: number,signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done,ms);
      function done(): void { signal.removeEventListener("abort",abort); resolve(); }
      function abort(): void { clearTimeout(timer); done(); }
      signal.addEventListener("abort",abort,{ once: true });
    });
  }

  async #handleText(sender: string,text: string): Promise<void> {
    const [rawCommand,...args] = text.trim().split(/\s+/);
    const command = (rawCommand ?? "").toLowerCase();
    try {
      const reply = await this.#surface.execute(command,args);
      await this.#send(sender,reply ?? "Unknown command. Send /help.");
    } catch {
      await this.#send(sender,"Transactra could not complete that request. Check the control-plane logs and approval status.");
    }
  }

  async #send(to: string,body: string): Promise<void> {
    const response = await fetch("https://graph.facebook.com/" + this.#graphVersion + "/" + this.#phoneNumberId + "/messages",{
      method: "POST",
      headers: { authorization: "Bearer " + this.#accessToken,"content-type":"application/json" },
      body: JSON.stringify({ messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{ preview_url:false,body:body.slice(0,3900) } }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("WhatsApp Cloud API send failed with HTTP " + response.status);
  }
}

export function createWhatsAppCloudControl(): WhatsAppCloudControl {
  return new WhatsAppCloudControl({
    connectionString: required("DATABASE_URL"),
    appSecret: required("WHATSAPP_APP_SECRET"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    graphVersion: required("WHATSAPP_GRAPH_API_VERSION"),
    allowedUsers: required("WHATSAPP_ALLOWED_USERS").split(",").map((value) => value.replace(/\D/g,"")).filter(Boolean),
    controlPlaneUrl: required("CONTROL_PLANE_URL"),
    apiToken: required("CONTROL_PLANE_API_TOKEN"),
    approvalToken: required("CONTROL_PLANE_APPROVAL_TOKEN"),
    ownerId: required("TRANSACTRA_OWNER_ID"),
    webhookPath: process.env.WHATSAPP_WEBHOOK_PATH ?? "/webhook"
  });
}
