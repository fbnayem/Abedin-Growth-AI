export class CanaryRolloutService {
  isFeatureEnabled(featureName: string, accountId: string, rolloutPercentage: number = 0): boolean {
    // Simple deterministic hash based on accountId
    let hash = 0;
    for (let i = 0; i < accountId.length; i++) {
        hash = ((hash << 5) - hash) + accountId.charCodeAt(i);
        hash |= 0;
    }
    const normalized = Math.abs(hash) % 100;
    return normalized < rolloutPercentage;
  }
}
