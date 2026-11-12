import type { OrganizationStore, NotificationRecord } from "../../storage/src/organization.js";

export type NotificationSender = (notification: NotificationRecord) => Promise<void>;

/**
 * Claims and delivers queued owner notifications for one channel surface.
 *
 * `channels` is the ordered set of notification channels this surface is allowed to drain.
 * Every real surface claims its own channel plus the shared `owner` channel, so an alert
 * addressed to `owner` is delivered exactly once (row locks) through whichever surface is
 * actually running, while channel-targeted alerts stay with their own surface.
 */
export class NotificationDispatcher {
  readonly #store: OrganizationStore;
  readonly #ownerId: string;
  readonly #workerId: string;
  readonly #channels: readonly string[];
  readonly #sender: NotificationSender;
  readonly #batchSize: number;

  constructor(input: {
    store: OrganizationStore;
    ownerId: string;
    workerId: string;
    sender: NotificationSender;
    channels: readonly string[];
    batchSize?: number;
  }) {
    if (!input.ownerId.trim()) throw new Error("Notification dispatcher requires an owner ID");
    if (!input.workerId.trim()) throw new Error("Notification dispatcher requires a worker ID");
    if (input.channels.length === 0) throw new Error("Notification dispatcher requires at least one channel");
    for (const channel of input.channels) {
      if (!/^[a-z][a-z0-9._-]{1,40}$/.test(channel)) throw new Error("Notification channel names must be lowercase identifiers");
    }
    this.#store = input.store;
    this.#ownerId = input.ownerId;
    this.#workerId = input.workerId;
    this.#channels = [...new Set(input.channels)];
    this.#sender = input.sender;
    this.#batchSize = input.batchSize ?? 10;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1 || this.#batchSize > 50) throw new Error("Notification batch size must be between 1 and 50");
  }

  get channels(): readonly string[] { return this.#channels; }

  async dispatchOnce(signal?: AbortSignal): Promise<{ sent: number; failed: number }> {
    if (signal?.aborted) return { sent: 0, failed: 0 };
    const notifications = await this.#store.claimNotifications(this.#ownerId,this.#workerId,this.#batchSize,this.#channels);
    let sent = 0;
    let failed = 0;
    for (const notification of notifications) {
      if (signal?.aborted) break;
      try {
        await this.#sender(notification);
        await this.#store.completeNotification(notification.id,this.#workerId);
        sent += 1;
      } catch (error) {
        await this.#store.failNotification(notification.id,this.#workerId,error instanceof Error ? error.message : "notification_delivery_failed");
        failed += 1;
      }
    }
    return { sent, failed };
  }
}
