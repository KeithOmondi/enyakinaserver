import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in config: the real Daraja client is exercised against a fake Safaricom.
const cfg = vi.hoisted(() => ({
  MPESA_CONSUMER_KEY: 'key',
  MPESA_CONSUMER_SECRET: 'secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'passkey123',
  MPESA_PARTY_B: undefined as string | undefined,
  MPESA_TRANSACTION_TYPE: 'till' as 'till' | 'paybill',
  MPESA_ENV: 'sandbox' as 'sandbox' | 'production',
}));
vi.mock('../src/config/env', () => ({ env: cfg, isProduction: false, isTest: true }));

import { createDaraja, darajaPassword, darajaTimestamp } from '../src/services/mpesa/daraja';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const push = { requestId: 'r1', phone: '254712345678', amountKes: 350, accountRef: 'Enyakin Enterprises', description: 'Payment for goods', callbackUrl: 'https://api.test/api/payments/mpesa/callback/r1/sig' };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const bodyOf = (call: number) => JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string);

describe('Daraja client', () => {
  it('builds the timestamp and password the way Safaricom specifies', () => {
    expect(darajaTimestamp(new Date('2026-11-14T18:51:07Z'))).toBe('20261114215107'); // East Africa Time = UTC+3
    expect(darajaPassword('174379', 'pk', '20261114215107')).toBe(Buffer.from('174379pk20261114215107').toString('base64'));
  });

  it('sends a Buy Goods (till) prompt with the right fields, using the sandbox host', async () => {
    cfg.MPESA_PARTY_B = '5551234';
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tok', expires_in: '3599' }));
    fetchMock.mockResolvedValueOnce(json({ MerchantRequestID: 'mer-1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0' }));

    const res = await createDaraja().stkPush(push);
    expect(res).toEqual({ providerRequestId: 'ws_CO_1', merchantRequestId: 'mer-1' });

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect((tokenInit as RequestInit).headers).toEqual({ Authorization: `Basic ${Buffer.from('key:secret').toString('base64')}` });

    expect(fetchMock.mock.calls[1]![0]).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
    const b = bodyOf(1);
    expect(b).toMatchObject({
      BusinessShortCode: '174379', TransactionType: 'CustomerBuyGoodsOnline', Amount: 350,
      PartyA: '254712345678', PartyB: '5551234', PhoneNumber: '254712345678', CallBackURL: push.callbackUrl,
    });
    expect(b.AccountReference.length).toBeLessThanOrEqual(12);
    expect(b.TransactionDesc.length).toBeLessThanOrEqual(13);
    expect(b.Password).toBe(darajaPassword('174379', 'passkey123', b.Timestamp));
    expect((fetchMock.mock.calls[1]![1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok');
  });

  it('sends a Pay Bill prompt to the shortcode itself, and reuses the access token', async () => {
    cfg.MPESA_TRANSACTION_TYPE = 'paybill';
    fetchMock.mockResolvedValueOnce(json({ MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_2', ResponseCode: '0' }));
    await createDaraja().stkPush(push);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second token request: the first one is cached
    expect(bodyOf(0)).toMatchObject({ TransactionType: 'CustomerPayBillOnline', PartyB: '174379' });
  });

  it('turns a Safaricom rejection into a clear error', async () => {
    fetchMock.mockResolvedValueOnce(json({ errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' }, 400));
    await expect(createDaraja().stkPush(push)).rejects.toThrow(/Invalid PhoneNumber/);
  });

  it('reads the outcome of a prompt', async () => {
    const q = (res: unknown, status = 200) => fetchMock.mockResolvedValueOnce(json(res, status));
    const daraja = createDaraja();
    q({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }, 500);
    expect(await daraja.query('ws_CO_1')).toEqual({ state: 'pending' });
    q({ ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
    expect(await daraja.query('ws_CO_1')).toMatchObject({ state: 'paid', receipt: null });
    q({ ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
    expect(await daraja.query('ws_CO_1')).toMatchObject({ state: 'cancelled' });
    q({ ResponseCode: '0', ResultCode: '2001', ResultDesc: 'The initiator information is invalid.' });
    expect(await daraja.query('ws_CO_1')).toMatchObject({ state: 'failed', resultDesc: 'Wrong M-Pesa PIN entered' });
  });
});
