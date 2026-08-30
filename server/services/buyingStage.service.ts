import { BuyingStage } from '../domain/models';

export class BuyingStageService {
  calculateNextStage(currentStage: BuyingStage, intent: string, purchaseReadiness: number, meetingReadiness: number): BuyingStage {
    if (intent === 'NOT_INTERESTED' || intent === 'COMPLAINT') {
      return BuyingStage.CLOSED_LOST;
    }

    if (intent === 'UNSUBSCRIBE') {
      return BuyingStage.UNSUBSCRIBED;
    }

    if (purchaseReadiness >= 80) {
      return BuyingStage.PURCHASE_READY;
    }

    if (intent === 'MEETING_CONFIRMED') {
      return BuyingStage.DEMO_BOOKED;
    }

    if (meetingReadiness >= 80) {
      return BuyingStage.DEMO_READY;
    }

    if (intent === 'TECHNICAL_QUESTION' || intent === 'INTEGRATION_QUESTION') {
      return BuyingStage.TECHNICAL_EVALUATION;
    }

    if (intent === 'PRICING_QUESTION' || intent === 'CUSTOM_PRICING_REQUEST') {
      return BuyingStage.COMMERCIAL_EVALUATION;
    }

    if (currentStage === BuyingStage.NEW && intent) {
      return BuyingStage.REPLIED;
    }

    return currentStage;
  }
}

export const buyingStageService = new BuyingStageService();
