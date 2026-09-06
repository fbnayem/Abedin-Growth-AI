import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import type { Request } from 'express';
import { verifyDocuSignSignature, verifyPubSubToken } from '../services/webhookVerification.service';

/**
 * INVARIANT (addendum §33 / P0.14): a webhook endpoint that skips authentication because the
 * caller is a machine MUST verify authenticity by other means, and must refuse when it cannot.
 *
 * These endpoints are exempt from requireAuth, so the signature is the only gate. Before
 * P0.14 the DocuSign handler carried the comment "In a real app we verify the HMAC signature
 * from DocuSign here" and did not — so anyone who could reach the URL could mark any meeting
 * CONFIRMED. The Gmail push endpoint drove an uncapped paid-AI loop with no verification at
 * all.
 */

const ORIGINAL = { ...process.env };

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

beforeEach(() => {
  delete process.env.DOCUSIGN_WEBHOOK_SECRET;
  delete process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('DocuSign HMAC verification', () => {
  const SECRET = 'test-shared-secret';
  const body = Buffer.from(JSON.stringify({ event: 'envelope-completed' }), 'utf8');

  function sign(b: Buffer, secret: string) {
    return crypto.createHmac('sha256', secret).update(b).digest('base64');
  }

  it('FAILS CLOSED when the secret is not configured', () => {
    // The critical case: an unconfigured deployment must refuse, not skip verification.
    const result = verifyDocuSignSignature(
      mockReq({ headers: { 'x-docusign-signature-1': sign(body, SECRET) } }),
      body
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it('accepts a correctly signed body', () => {
    process.env.DOCUSIGN_WEBHOOK_SECRET = SECRET;
    const result = verifyDocuSignSignature(
      mockReq({ headers: { 'x-docusign-signature-1': sign(body, SECRET) } }),
      body
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a signature produced with the wrong secret', () => {
    process.env.DOCUSIGN_WEBHOOK_SECRET = SECRET;
    const result = verifyDocuSignSignature(
      mockReq({ headers: { 'x-docusign-signature-1': sign(body, 'attacker-secret') } }),
      body
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it('rejects when the body has been tampered with after signing', () => {
    process.env.DOCUSIGN_WEBHOOK_SECRET = SECRET;
    const signature = sign(body, SECRET);
    const tampered = Buffer.from(JSON.stringify({ event: 'envelope-completed', evil: true }), 'utf8');
    const result = verifyDocuSignSignature(
      mockReq({ headers: { 'x-docusign-signature-1': signature } }),
      tampered
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when no signature header is present', () => {
    process.env.DOCUSIGN_WEBHOOK_SECRET = SECRET;
    const result = verifyDocuSignSignature(mockReq(), body);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('rejects when the raw body is unavailable, naming the parser-ordering cause', () => {
    // This is the failure mode that made the endpoint return 400 for every genuine event:
    // express.json() consumed the stream before express.raw() could capture the bytes.
    process.env.DOCUSIGN_WEBHOOK_SECRET = SECRET;
    const result = verifyDocuSignSignature(
      mockReq({ headers: { 'x-docusign-signature-1': sign(body, SECRET) } }),
      undefined
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/raw request body/i);
  });

  it('rejects an empty body rather than verifying a signature over nothing', () => {
    process.env.DOCUSIGN_WEBHOOK_SECRET = SECRET;
    const empty = Buffer.alloc(0);
    const result = verifyDocuSignSignature(
      mockReq({ headers: { 'x-docusign-signature-1': sign(empty, SECRET) } }),
      empty
    );
    expect(result.ok).toBe(false);
  });
});

describe('Google Pub/Sub push token verification', () => {
  const TOKEN = 'pubsub-shared-token';

  it('FAILS CLOSED when the token is not configured', () => {
    const result = verifyPubSubToken(mockReq({ query: { token: TOKEN } as any }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it('accepts the correct token as a query parameter', () => {
    process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN = TOKEN;
    const result = verifyPubSubToken(mockReq({ query: { token: TOKEN } as any }));
    expect(result.ok).toBe(true);
  });

  it('accepts the correct token as a bearer header', () => {
    process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN = TOKEN;
    const result = verifyPubSubToken(
      mockReq({ headers: { authorization: `Bearer ${TOKEN}` } })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong token', () => {
    process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN = TOKEN;
    const result = verifyPubSubToken(mockReq({ query: { token: 'wrong' } as any }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it('rejects when no token is supplied at all', () => {
    process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN = TOKEN;
    const result = verifyPubSubToken(mockReq());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('does not accept a token that merely starts with the expected value', () => {
    // Guards against a prefix/startsWith comparison creeping in.
    process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN = TOKEN;
    const result = verifyPubSubToken(mockReq({ query: { token: TOKEN + 'extra' } as any }));
    expect(result.ok).toBe(false);
  });
});
