import { NextBestAction, BuyingStage } from '../domain/models';

export interface NextBestActionInput {
  intent: string;
  buyingStage: BuyingStage;
  meetingReadiness: number; // 0-100
  purchaseReadiness: number; // 0-100
  unansweredQuestions: string[];
  category: string;
  isUnsubscribed: boolean;
  isOutOfOffice: boolean;
}

export class NextBestActionService {
  public determineAction(input: NextBestActionInput): NextBestAction {
    if (input.isUnsubscribed) {
      return NextBestAction.SUPPRESS;
    }
    if (input.isOutOfOffice) {
      return NextBestAction.NO_REPLY;
    }

    if (input.intent === 'NOT_INTERESTED' || input.intent === 'COMPLAINT') {
      return NextBestAction.CLOSE_LOST;
    }

    if (input.intent === 'FOLLOW_UP_LATER') {
      return NextBestAction.FOLLOW_UP_LATER;
    }

    if (input.purchaseReadiness >= 80) {
      return NextBestAction.SEND_PAYMENT_LINK; // or SEND_AGREEMENT / START_ONBOARDING based on category
    }

    if (input.meetingReadiness >= 80) {
      if (input.intent === 'MEETING_CONFIRMED' || input.intent === 'EXPLICIT_TIME_PROVIDED') {
        return NextBestAction.CREATE_CONFIRMED_MEETING;
      }
      return NextBestAction.SEND_BOOKING_LINK;
    }

    if (input.unansweredQuestions.length > 0) {
      // Need to answer questions first
      const hasTechnical = input.unansweredQuestions.some(q => q.toLowerCase().includes('integration') || q.toLowerCase().includes('technical'));
      const hasPricing = input.unansweredQuestions.some(q => q.toLowerCase().includes('cost') || q.toLowerCase().includes('price'));
      
      if (hasPricing) return NextBestAction.PROVIDE_PRICING;
      if (hasTechnical) return NextBestAction.PROVIDE_TECHNICAL_INFORMATION;
      
      return NextBestAction.ANSWER_AND_QUALIFY;
    }

    if (input.buyingStage === BuyingStage.NEW || input.buyingStage === BuyingStage.CONTACTED) {
      return NextBestAction.ASK_ONE_CLARIFYING_QUESTION;
    }

    return NextBestAction.ANSWER_ONLY;
  }
}

export const nextBestActionService = new NextBestActionService();
