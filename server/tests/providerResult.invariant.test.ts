import { describe, it, expect } from 'vitest';
import { isFabricatedProviderId, FABRICATED_PROVIDER_ID } from '../gateway/actionGateway';

/**
 * INVARIANT (addendum §3): A message cannot become SENT without a real provider result.
 *
 * This is the single most important invariant in the system, and it was inverted before P0.8:
 * the ActionGateway returned `{ success: true, providerResult: { messageId: 'sim_email_' +
 * Date.now() } }` whenever the stored credential was the literal 'mock_token' — which
 * server.ts wrote on every Gmail "connect". So 100% of sends were simulated and 100% were
 * recorded as SENT.
 *
 * The guard tested here is the last line of defence: whatever a provider adapter returns, an
 * id that was minted locally must never be accepted as evidence that an external action
 * occurred. These tests cover the shape of the guard; the worker-level enforcement that
 * consumes it is exercised in outboxWorker.invariant.test.ts.
 */
describe('§3 — fabricated provider ids are never accepted as proof of a send', () => {
  describe('rejects locally-minted ids', () => {
    const fabricated = [
      'sim_email_1730000000000',
      'sim_1730000000000',
      'sim_thread_1730000000000',
      'sim_evt_1730000000000',
      'mock_token',
      'mock_12345',
      'test_message_id',
      'fake_abc',
      'stub_xyz',
      // Case must not be an escape hatch.
      'SIM_EMAIL_123',
      'Mock_Token',
      'TEST_ID',
      // Hyphen separator as well as underscore.
      'sim-email-123',
      'mock-token',
    ];

    it.each(fabricated)('rejects %s', (id) => {
      expect(isFabricatedProviderId(id)).toBe(true);
    });
  });

  describe('accepts ids that could plausibly come from a provider', () => {
    const real = [
      // Gmail message ids are hex-ish opaque strings.
      '18c9f2a4b5d6e7f8',
      'CADnq6Z8s9Kk1mN2pQrStUvWxYz',
      // Stripe-style.
      'cs_test_a1b2c3', // note: starts with "cs_", not "test_"
      'evt_1PabcdEFGH',
      // Google Calendar event id.
      '6h8k2m4n6p8r0t2v4x6z8b0d',
    ];

    it.each(real)('accepts %s', (id) => {
      expect(isFabricatedProviderId(id)).toBe(false);
    });
  });

  it('only matches at the START of the id, so a legitimate id containing "sim" survives', () => {
    // Guarding against an over-broad regex that would reject real provider ids.
    expect(isFabricatedProviderId('a_simulation_id')).toBe(false);
    expect(isFabricatedProviderId('msg_simple_123')).toBe(false);
    expect(isFabricatedProviderId('CAsimtest123')).toBe(false);
  });

  it('treats absent or non-string ids as not-a-string rather than throwing', () => {
    // The worker calls this on `result.providerResult?.messageId`, which is frequently
    // undefined. It must answer, not crash — the worker separately treats a missing id as a
    // failure, and that distinction is tested in the worker suite.
    expect(isFabricatedProviderId(undefined)).toBe(false);
    expect(isFabricatedProviderId(null)).toBe(false);
    expect(isFabricatedProviderId(123)).toBe(false);
    expect(isFabricatedProviderId({})).toBe(false);
  });

  it('the exported pattern is anchored, so it cannot be defeated by a prefix', () => {
    // If the anchor were ever dropped, 'x_sim_1' would match and real ids would be rejected;
    // more dangerously, a future edit could unanchor it in the permissive direction.
    expect(FABRICATED_PROVIDER_ID.source.startsWith('^')).toBe(true);
  });

  it('rejects the exact literal that caused the original defect', () => {
    // Regression guard: 'mock_token' is what server.ts persisted on every Gmail connect.
    expect(isFabricatedProviderId('mock_token')).toBe(true);
  });
});
