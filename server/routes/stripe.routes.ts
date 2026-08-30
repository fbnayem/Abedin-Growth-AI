import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from '../db/index';

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
    const stripe = getStripe();
    if (!stripe) {
      return res.status(400).json({ error: "Stripe is not configured" });
    }

    const { email, leadId } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Enterprise Onboarding',
            },
            unit_amount: 500000, // $5,000.00
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
    res.status(500).json({ error: error.message });
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
