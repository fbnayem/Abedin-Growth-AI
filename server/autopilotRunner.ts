import { outboxWorker } from "./workers/outbox.worker";

export const autopilotRunner = {
  startBackgroundLoop() {
    outboxWorker.start();
  },
  stopBackgroundLoop() {
    outboxWorker.stop();
  },
  get status() {
    return outboxWorker.isRunning ? "ACTIVE" : "IDLE";
  },
  get isActive() {
    return outboxWorker.isRunning;
  },
  get progressPercent() {
    return 100;
  },
  get currentLiveTask() {
    return "Event-Driven Core Active";
  },
  get stageDetail() {
    return "Awaiting Webhooks & Processing Outbox";
  }
};
