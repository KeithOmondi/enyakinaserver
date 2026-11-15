import { randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { outcomeFromResult, type MpesaProvider, type StkOutcome } from './types';

/**
 * Pretends to be Safaricom so the whole prompt flow can be tried without an account.
 * What happens is decided by the LAST DIGIT of the phone number:
 *   1  the customer cancels the prompt
 *   2  insufficient M-Pesa balance
 *   3  the customer never answers (the prompt times out)
 *   anything else: the customer enters their PIN and pays after a few seconds
 * `deliver` is called like Safaricom's callback would be, so everything downstream is real.
 */
export function createSimulator(deliver: (providerRequestId: string, outcome: StkOutcome) => Promise<void>): MpesaProvider {
  const finished = new Map<string, StkOutcome>();

  return {
    mode: 'simulator',
    timeoutSeconds: env.MPESA_SIM_TIMEOUT_SECONDS,

    async stkPush(input) {
      const providerRequestId = `ws_CO_SIM_${randomBytes(8).toString('hex')}`;
      const last = input.phone.slice(-1);
      const planned: StkOutcome | null =
        last === '3'
          ? null
          : last === '1'
            ? outcomeFromResult(1032, 'Request cancelled by user', null)
            : last === '2'
              ? outcomeFromResult(1, 'The balance is insufficient for the transaction', null)
              : outcomeFromResult(0, 'The service request is processed successfully.', `SIM${randomBytes(4).toString('hex').toUpperCase()}`);

      if (planned) {
        const timer = setTimeout(() => {
          finished.set(providerRequestId, planned);
          deliver(providerRequestId, planned).catch((err: Error) => console.error('[mpesa-sim] callback failed:', err.message));
        }, env.MPESA_SIM_DELAY_MS);
        timer.unref();
      }
      return { providerRequestId, merchantRequestId: `sim-${input.requestId.slice(0, 8)}` };
    },

    async query(providerRequestId) {
      return finished.get(providerRequestId) ?? { state: 'pending' };
    },
  };
}
