import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../db/index';
import { isRealActionEnabled } from '../config/safeMode';
import { getCircuitBreakerState } from '../services/circuitBreaker.service';
import { checkoutPriceFrom } from '../domain/checkoutPrice';
import { sendCaught, sendError } from '../lib/errors';

const stripeRouter = express.Router();

let stripeClient: Stripe | null = null;
const getStripe = () => {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      console.warn("STRIPE_SECRET_KEY not set. Payments will not work.");
      return null;
    }
    stripeClient = new Stripe(key);
  }
  return stripeClient;
};

stripeRouter.post('/create-checkout-session', async (req: Request, res: Response) => {
  try {
    // P0.15 — Payment creation previously bypassed the ActionGateway entirely: no Safe Mode
    // flag, no kill switch, no audit record. Taking money is an irreversible external action
    // and must respect the same gates as sending mail. Both are checked here, before any
    // call to Stripe.
    if (!isRealActionEnabled('REAL_PAYMENT_ENABLED')) {
      console.warn('[stripe] Checkout refused: REAL_PAYMENT_ENABLED is not true (Safe Rebuild Mode).');
      return sendError(
        req,
        res,
        'POLICY_BLOCKED',
        'Real payments are disabled in Safe Rebuild Mode (REAL_PAYMENT_ENABLED is not "true").',
        { status: 403 }
      );
    }

    const cb = await getCircuitBreakerState();
    if (!cb.globalAutonomousSendEnabled) {
      console.warn('[stripe] Checkout refused: circuit breaker engaged.');
      return sendError(
        req,
        res,
        'POLICY_BLOCKED',
        `Payments are halted: ${cb.pausedReason || 'circuit breaker engaged.'}`,
        { status: 403 }
      );
    }

    const stripe = getStripe();
    if (!stripe) {
      return sendError(req, res, 'PROVIDER_UNAVAILABLE', 'Stripe is not configured.', {
        status: 400,
      });
    }

    // S25 — THE AMOUNT IS CONFIGURATION, AND THERE IS NO DEFAULT.
    //
    // This was `currency: 'usd', unit_amount: 500000` — a hardcoded USD $5,000 for a product
    // the rest of this system prices at £499/mo, in a currency `shared/domain/pricing.ts` does
    // not even model (`CURRENCIES` is `['GBP']`). `check-single-price-source` could not see it,
    // because its detector is `/£\s?\d/` — so the guardrail caught every prose price and was
    // blind to the only figure that can move money.
    //
    // It is not simply corrected here because the right number is not mine to choose:
    // "Enterprise Onboarding" at $5,000 may be a legitimate one-off unrelated to the
    // subscription tier, or a leftover from a template. Inventing one would be the exact
    // failure the price book exists to prevent — a figure that looks authoritative because it
    // is in code.
    //
    // This refusal is INDEPENDENT of `REAL_PAYMENT_ENABLED`, checked above. The failure being
    // prevented is somebody enabling payments — the one deliberate act that turns this on — and
    // thereby charging a stranger an amount nobody chose. A flag flip must not be able to do
    // that by itself.
    const priced = checkoutPriceFrom();
    if (priced.ok === false) {
      console.warn(`[stripe] Checkout refused: ${priced.reason}`);
      return sendError(req, res, 'CONFIGURATION_ERROR', priced.reason, { status: 503 });
    }

    const { email, leadId } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: priced.price.currency,
            product_data: {
              name: 'Enterprise Onboarding',
            },
            unit_amount: priced.price.minorUnits,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${req.headers.origin}/?success=true`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      customer_email: email,
      client_reference_id: leadId,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error: any) {
    // The Stripe SDK's message can name the account, the price object and the API version.
    // It belongs in the log, correlated by request id, not in the response.
    sendCaught(req, res, error);
  }
});

stripeRouter.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe) return res.status(400).send("Stripe not configured");

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig as string,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;
    const leadId = session.client_reference_id;
    console.log(`Payment successful for lead: ${leadId}`);

    // We would update the DB or globalStore here.
    // For now we just log it since the system will use it.
  }

  res.json({ received: true });
});

export { stripeRouter };
