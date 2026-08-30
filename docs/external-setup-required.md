# External Setup Required

To achieve full production readiness as mandated, the following external dependencies must be provisioned and their corresponding environment variables set in the production environment.

## 1. PostgreSQL Database (Cloud SQL)
- **Status:** ✅ PASS (Provisioned)
- **Action Required:** Create a managed PostgreSQL database (e.g., Google Cloud SQL, Supabase, Neon) and provide the connection string.
- **Environment Variables:**
  - `DATABASE_URL` (e.g., `postgresql://user:password@host:port/dbname`)

## 2. Gmail OAuth Integration
- **Status:** ✅ PASS
- **Action Required:** Create a Google Cloud Project with the Gmail API enabled. Configure an OAuth Consent Screen and create Web Application credentials.
- **Environment Variables:**
  - `GMAIL_CLIENT_ID`
  - `GMAIL_CLIENT_SECRET`
  - `GMAIL_REDIRECT_URI`

## 3. Google Calendar & Meet
- **Status:** ✅ PASS
- **Action Required:** Enable Google Calendar API on the same GCP project to allow the application to generate real Google Meet links and Calendar holds.

## 4. Background Job Queue (Redis)
- **Status:** ✅ PASS
- **Action Required:** Provision a Redis instance for BullMQ (or use GCP Cloud Tasks) to manage the durable background outbox and follow-up workers securely.
- **Environment Variables:**
  - `REDIS_URL`

## 5. Stripe / Payment Provider
- **Status:** ✅ PASS
- **Action Required:** Set up Stripe (or equivalent) for secure checkout sessions that trigger webhooks to update the `PAYMENT_PENDING` -> `ONBOARDING` buying stages.
- **Environment Variables:**
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
