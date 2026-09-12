import { listServiceableOrgIds } from '../tenancy/organizations';
import { campaignScheduler as schedulerConfig } from '../config/environment';
import { runCampaignTick, relationalConversationState } from '../services/campaignEngine.service';

/**
 * S26 — the campaign scheduler: one tick per serviceable organisation, on an interval.
 *
 * OFF BY DEFAULT. `CAMPAIGN_SCHEDULER_ENABLED` must be exactly "true" for the loop to start;
 * otherwise `start()` records that it is disabled and does nothing, the way every production
 * action flag in this system fails closed. A tick can still be run on demand through
 * `POST /api/autopilot/run-cycle-now`, which is how an operator watches one happen.
 *
 * Even when enabled, nothing here sends: a tick enqueues outbox jobs, and the outbox worker
 * dispatches them through the gateway, where the consent, suppression, capability and Safe
 * Rebuild Mode checks are — and `REAL_EMAIL_SEND_ENABLED` is false.
 */
export class CampaignScheduler {
  public isRunning = false;
  public disabledReason: string | null = null;
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;
  public lastTickAt: number | null = null;

  start(): void {
    if (this.isRunning) return;
    const config = schedulerConfig();
    if (!config.enabled) {
      this.disabledReason = 'CAMPAIGN_SCHEDULER_ENABLED is not "true"; campaign steps are dispatched only by an operator running a tick.';
      console.log(`[campaignScheduler] Not started: ${this.disabledReason}`);
      return;
    }
    this.isRunning = true;
    this.disabledReason = null;
    console.log(`[campaignScheduler] Started; a tick every ${config.intervalMs}ms.`);
    this.interval = setInterval(() => {
      void this.tickAll();
    }, config.intervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Re-entrancy guarded, like the outbox worker: a slow tick must not overlap the next. */
  async tickAll(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const orgIds = await listServiceableOrgIds();
      for (const orgId of orgIds) {
        try {
          const report = await runCampaignTick(orgId, { conversationState: relationalConversationState }, new Date(), 'scheduler');
          if (report.dispatched.length > 0 || report.refused.length > 0 || report.errors.length > 0) {
            console.log(
              `[campaignScheduler] ${orgId}: ${report.dispatched.length} enqueued, ${report.refused.length} refused, ` +
                `${report.stopped.length} stopped, ${report.errors.length} error(s).`
            );
          }
        } catch (e: unknown) {
          console.error(`[campaignScheduler] tick failed for ${orgId}:`, e);
        }
      }
      this.lastTickAt = Date.now();
    } finally {
      this.ticking = false;
    }
  }
}

export const campaignScheduler = new CampaignScheduler();
