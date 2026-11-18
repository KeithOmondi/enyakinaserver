import { afterEach, describe, expect, it } from 'vitest';
import { credsFor, mpesaModeFor, prefixFor } from '../src/services/mpesa/credentials';

const KEYS = [
  'MPESA_MODE',
  'MPESA_GO_FISH_SHORTCODE', 'MPESA_GO_FISH_PASSKEY', 'MPESA_GO_FISH_CONSUMER_KEY', 'MPESA_GO_FISH_CONSUMER_SECRET', 'MPESA_GO_FISH_PARTY_B', 'MPESA_GO_FISH_TRANSACTION_TYPE',
  'MPESA_ENYAKIN_SHORTCODE', 'MPESA_ENYAKIN_PASSKEY', 'MPESA_ENYAKIN_PARTY_B',
  'MPESA_ENYAKIN_CONSUMER_KEY', 'MPESA_ENYAKIN_CONSUMER_SECRET',
];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('per-business M-Pesa credentials', () => {
  it('builds the environment prefix from the business code', () => {
    expect(prefixFor('go-fish')).toBe('GO_FISH');
    expect(prefixFor('enyakin')).toBe('ENYAKIN');
  });

  it('gives each business its own Till, never mixing passkeys or party numbers', () => {
    // The shared consumer key/secret is not set in tests, so each business brings its own app here.
    process.env.MPESA_GO_FISH_SHORTCODE = '111111';
    process.env.MPESA_GO_FISH_PASSKEY = 'fish-passkey';
    process.env.MPESA_GO_FISH_PARTY_B = '9000001';
    process.env.MPESA_ENYAKIN_SHORTCODE = '222222';
    process.env.MPESA_ENYAKIN_PASSKEY = 'eny-passkey';
    process.env.MPESA_ENYAKIN_CONSUMER_KEY = 'k';
    process.env.MPESA_ENYAKIN_CONSUMER_SECRET = 's';
    const eny = credsFor('enyakin')!;
    expect(eny).toMatchObject({ shortcode: '222222', passkey: 'eny-passkey', partyB: '222222', type: 'till' });
    // Go-fish has no consumer key of its own and there is no shared one: not usable yet.
    expect(credsFor('go-fish')).toBeNull();
    process.env.MPESA_GO_FISH_TRANSACTION_TYPE = 'paybill';
    process.env.MPESA_GO_FISH_SHORTCODE = '111111';
    expect(credsFor('unknown-business')).toBeNull();
  });

  it('never sends a business without its own Till to the other business Paybill', () => {
    process.env.MPESA_GO_FISH_SHORTCODE = '600111';
    process.env.MPESA_GO_FISH_PASSKEY = 'fish-passkey';
    process.env.MPESA_GO_FISH_TRANSACTION_TYPE = 'paybill';
    process.env.MPESA_GO_FISH_CONSUMER_KEY = 'k';
    process.env.MPESA_GO_FISH_CONSUMER_SECRET = 's';
    const fish = credsFor('go-fish')!;
    expect(fish).toMatchObject({ shortcode: '600111', partyB: '600111', type: 'paybill' });
    expect(credsFor('enyakin')).toBeNull();
  });

  it('turns prompts off for a business whose Till is not set up, even in daraja mode', () => {
    process.env.MPESA_MODE = 'daraja';
    process.env.MPESA_ENYAKIN_SHORTCODE = '222222';
    process.env.MPESA_ENYAKIN_PASSKEY = 'eny-passkey';
    process.env.MPESA_ENYAKIN_CONSUMER_KEY = 'k';
    process.env.MPESA_ENYAKIN_CONSUMER_SECRET = 's';
    expect(mpesaModeFor('enyakin')).toBe('daraja');
    expect(mpesaModeFor('go-fish')).toBe('off');
  });
});
