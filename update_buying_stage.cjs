const fs = require('fs');
let code = fs.readFileSync('shared/domain/models.ts', 'utf8');

const anchorStart = 'export enum BuyingStage {';
const anchorEnd = '}';
const startIndex = code.indexOf(anchorStart);
if (startIndex !== -1) {
    const endIndex = code.indexOf(anchorEnd, startIndex);
    if (endIndex !== -1) {
        const replacement = `export enum BuyingStage {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  ENGAGED = 'ENGAGED',
  DISCOVERY = 'DISCOVERY',
  SOLUTION_EVALUATION = 'SOLUTION_EVALUATION',
  SOLUTION_EXPLORING = 'SOLUTION_EXPLORING',
  PRODUCT_EVALUATING = 'PRODUCT_EVALUATING',
  TECHNICAL_EVALUATION = 'TECHNICAL_EVALUATION',
  COMMERCIAL_EVALUATION = 'COMMERCIAL_EVALUATION',
  DEMO_READY = 'DEMO_READY',
  DEMO_BOOKED = 'DEMO_BOOKED',
  TRIAL_READY = 'TRIAL_READY',
  TRIAL_ACTIVE = 'TRIAL_ACTIVE',
  PURCHASE_READY = 'PURCHASE_READY',
  NEGOTIATION = 'NEGOTIATION',
  CONTRACT_PENDING = 'CONTRACT_PENDING',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  ONBOARDING = 'ONBOARDING',
  CUSTOMER = 'CUSTOMER',
  FOLLOW_UP_LATER = 'FOLLOW_UP_LATER',
  NOT_INTERESTED = 'NOT_INTERESTED',
  UNSUBSCRIBED = 'UNSUBSCRIBED',
  CLOSED_LOST = 'CLOSED_LOST'
}`;
        code = code.substring(0, startIndex) + replacement + code.substring(endIndex + 1);
        fs.writeFileSync('shared/domain/models.ts', code);
    }
}
