import { firestore } from '../firebase';
import { collection, addDoc } from 'firebase/firestore';

export interface SLOEvent {
  metric: 'INBOUND_LATENCY' | 'AI_DECISION_LATENCY' | 'DUPLICATE_RATE' | 'POLICY_BLOCK' | 'AI_COST' | 'SEND_SUCCESS';
  value: number;
  tags: Record<string, string>;
  timestamp: number;
}

export class MetricsService {
  // Z. OPERATING SLOS & ALERTS
  async recordMetric(orgId: string, event: SLOEvent) {
    if (!firestore) return;
    try {
      await addDoc(collection(firestore, `organizations/${orgId}/metrics`), {
        ...event,
        timestamp: event.timestamp || Date.now()
      });
      
      // In production this would also flush to Datadog/Prometheus
      console.log(`[SLO Metric recorded] ${event.metric}: ${event.value} (${JSON.stringify(event.tags)})`);
    } catch (e) {
      console.error("Failed to record metric", e);
    }
  }

  async recordAiCost(orgId: string, conversationId: string, cost: number) {
    await this.recordMetric(orgId, {
      metric: 'AI_COST',
      value: cost,
      tags: { conversationId },
      timestamp: Date.now()
    });
  }

  async recordLatency(orgId: string, metricName: 'INBOUND_LATENCY' | 'AI_DECISION_LATENCY', ms: number) {
    await this.recordMetric(orgId, {
      metric: metricName,
      value: ms,
      tags: {},
      timestamp: Date.now()
    });
  }
}

export const metricsService = new MetricsService();
