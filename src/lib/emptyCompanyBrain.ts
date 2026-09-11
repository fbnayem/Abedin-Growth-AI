import type { CompanyBrain } from '../types';

/**
 * The company brain before the server has supplied one.
 *
 * `App.tsx` initialised this state with a hand-written brain — "Deploying across UK clinics with
 * 98.4% call resolution rate", personas and objection answers — and replaced it only when
 * `GET /api/company-brain` succeeded. Until then, and permanently if that request failed, every view
 * rendered the template as though it were this organisation's record. It also carried four fields
 * `CompanyBrain` does not have and lacked eleven it requires, which nothing reported while React's
 * types were missing and every component's props were `any`.
 *
 * Empty is the honest value for "not loaded": views already render empty lists and blank fields.
 */
export const EMPTY_COMPANY_BRAIN: CompanyBrain = {
  workspaceId: 'default',
  companyName: '',
  companyUrl: '',
  productName: '',
  productUrl: '',
  tagline: '',
  description: '',
  targetIndustries: [],
  targetCountries: [],
  customerProblems: [],
  coreFeatures: [],
  primaryBenefits: [],
  differentiators: [],
  targetPersonas: [],
  customerUseCases: [],
  salesAngles: [],
  objectionsAndAnswers: [],
  investorNarrative: { vision: '', marketOpportunity: '', moat: '', tractionHighlights: '' },
  partnerNarrative: { partnerValueProposition: '', revenueSharingModel: '', idealPartnerProfile: '' },
  updatedAt: '',
};
