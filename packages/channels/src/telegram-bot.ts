import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { OrganizationStore } from "../../storage/src/organization.js";
import { NotificationDispatcher } from "../../organization/src/notifications.js";
import { ControlSurface } from "./control-surface.js";

interface TelegramMessage {
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
}
interface TelegramUpdate { update_id: number; message?: TelegramMessage; }
interface TelegramResponse<T> { ok: boolean; result: T; description?: string; }

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(name + " is required");
  return value.trim();
}

export class TelegramControlBot {
  readonly #pool: Pool;
  readonly #token: string;
  readonly #allowedUsers: ReadonlySet<string>;
  readonly #surface: ControlSurface;
  readonly #organization: OrganizationStore;
  readonly #dispatcher: NotificationDispatcher;

  constructor(input: {
    connectionString: string; botToken: string; allowedUserIds: readonly string[];
    controlPlaneUrl: string; apiToken: string; approvalToken: string; ownerId: string;
  }) {
    if (!input.connectionString.trim() || !input.botToken.trim() || !input.apiToken.trim() || !input.approvalToken.trim()) throw new Error("Telegram and control-plane credentials are required");
    if (input.allowedUserIds.length === 0 || input.allowedUserIds.some((id) => !/^-?\d+$/.test(id))) throw new Error("At least one numeric Telegram chat ID must be allowlisted");
    this.#pool = new Pool({ connectionString: input.connectionString, max: 2, application_name: "transactra-telegram" });
    this.#token = input.botToken;
    this.#allowedUsers = new Set(input.allowedUserIds);
    this.#surface = new ControlSurface({
      controlPlaneUrl: input.controlPlaneUrl,
      apiToken: input.apiToken,
      approvalToken: input.approvalToken
    });
    this.#organization = new OrganizationStore(input.connectionString);
    this.#dispatcher = new NotificationDispatcher({
      store: this.#organization,
      ownerId: input.ownerId,
      workerId: "telegram-" + randomUUID(),
      channels: ["telegram","owner"],
      sender: async (notification) => {
        for (const chatId of this.#allowedUsers) {
          await this.#send(chatId,"Transactra " + notification.kind + "\n\n" + notification.message);
        }
      }
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#organization.close(),this.#pool.end()]);
  }

  async run(_signal: AbortSignal): Promise<void> {
    throw new Error("Telegram long polling is disabled: production delivery is owned exclusively by the transactra-edge Cloudflare Worker.");
  }

  async #getOffset(): Promise<number | null> {
    const result = await this.#pool.query<{ state_value: string }>("SELECT state_value FROM channel_state WHERE channel='telegram' AND state_key='update_offset'");
    if (!result.rows[0]) return null;
    const value = Number(result.rows[0].state_value);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async #setOffset(offset: number): Promise<void> {
    await this.#pool.query(
      "INSERT INTO channel_state(channel,state_key,state_value) VALUES('telegram','update_offset',$1) ON CONFLICT(channel,state_key) DO UPDATE SET state_value=EXCLUDED.state_value,updated_at=now()",
      [String(offset)]
    );
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    if (message.chat.type !== "private" || !message.from || String(message.from.id) !== chatId || !this.#allowedUsers.has(chatId) || typeof message.text !== "string") return;
    const [rawCommand,...args] = message.text.trim().split(/\s+/);
    const command = (rawCommand ?? "").split("@")[0]?.toLowerCase() ?? "";
    try {
      const reply = await this.#surface.execute(command,args);
      await this.#send(chatId,reply ?? "Unknown command. Send /help for available commands.");
    } catch {
      await this.#send(chatId,"Transactra could not complete that request. Check the control-plane logs and approval status.");
    }
  }

  async #send(chatId: string, text: string): Promise<void> {
    const body = { chat_id: chatId, text: text.slice(0,3900), disable_web_page_preview: true };
    const response = await fetch("https://api.telegram.org/bot" + this.#token + "/sendMessage",{
      method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify(body),signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("Telegram sendMessage failed with HTTP " + response.status);
    const payload = await response.json() as TelegramResponse<unknown>;
    if (!payload.ok) throw new Error("Telegram sendMessage was rejected");
  }

  async #delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done,ms);
      function done(): void { signal.removeEventListener("abort",abort); resolve(); }
      function abort(): void { clearTimeout(timer); done(); }
      signal.addEventListener("abort",abort,{ once: true });
    });
  }
}

export function createTelegramControlBot(): TelegramControlBot {
  return new TelegramControlBot({
    connectionString: required("DATABASE_URL"),
    botToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: required("TELEGRAM_ALLOWED_USER_IDS").split(",").map((value) => value.trim()).filter(Boolean),
    controlPlaneUrl: required("CONTROL_PLANE_URL"),
    apiToken: required("CONTROL_PLANE_API_TOKEN"),
    approvalToken: required("CONTROL_PLANE_APPROVAL_TOKEN"),
    ownerId: required("TRANSACTRA_OWNER_ID")
  });
}
