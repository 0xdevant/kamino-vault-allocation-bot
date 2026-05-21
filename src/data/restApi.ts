/**
 * Typed client for api.kamino.finance. APY is fractional (0.068 = 6.8%).
 */
import { Decimal } from 'decimal.js';

export interface RestVaultState {
  name: string;
  tokenMint: string;
  tokenMintDecimals: number;
  vaultAdminAuthority: string;
  performanceFeeBps: number;
  managementFeeBps: number;
  /** Raw previous AUM in base units — a cheap size proxy for pre-fetch ranking. */
  prevAum: number;
  vaultAllocationStrategy: { reserve: string; targetAllocationWeight?: string }[];
}

export interface RestVault {
  address: string;
  state: RestVaultState;
}

export interface RestVaultMetrics {
  apy?: Decimal;
  apy7d?: Decimal;
  apy30d?: Decimal;
  apy90d?: Decimal;
  /** Gross, before vault fees. */
  apyTheoretical?: Decimal;
  tokenPrice?: Decimal;
  tokensAvailableUsd?: Decimal;
  tokensInvestedUsd?: Decimal;
  sharePrice?: Decimal;
  tokensPerShare?: Decimal;
  sharesIssued?: Decimal;
  numberOfHolders?: number;
}

export class KaminoRestApi {
  constructor(private readonly baseUrl: string) {}

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      throw new Error(`Kamino API request failed (network) GET ${url}: ${(err as Error).message}`);
    }
    if (res.status === 429) throw new RateLimitError(`Kamino API rate-limited (429) GET ${url}`);
    if (!res.ok) {
      throw new Error(
        `Kamino API GET ${url} -> ${res.status}. Shape may have changed; ` +
          `check https://api.kamino.finance/openapi/json.`,
      );
    }
    return res.json();
  }

  async listVaults(): Promise<RestVault[]> {
    const payload = await this.getJson('/kvaults/vaults');
    // Accept array directly or `{ vaults: [...] }` envelope.
    const items: unknown[] = Array.isArray(payload)
      ? payload
      : isObject(payload) && Array.isArray((payload as JsonObject).vaults)
        ? ((payload as JsonObject).vaults as unknown[])
        : [];
    const vaults: RestVault[] = [];
    for (const item of items) {
      if (!isObject(item)) continue;
      const address = String((item as JsonObject).address ?? '');
      const rawState = (item as JsonObject).state;
      if (!address || !isObject(rawState)) continue;
      const state = rawState as JsonObject;
      vaults.push({
        address,
        state: {
          name: decodeVaultName(state.name),
          tokenMint: String(state.tokenMint ?? ''),
          tokenMintDecimals: Number(state.tokenMintDecimals ?? 0),
          vaultAdminAuthority: String(state.vaultAdminAuthority ?? ''),
          performanceFeeBps: Number(state.performanceFeeBps ?? 0),
          managementFeeBps: Number(state.managementFeeBps ?? 0),
          prevAum: Number(state.prevAum ?? 0),
          vaultAllocationStrategy: Array.isArray(state.vaultAllocationStrategy)
            ? (state.vaultAllocationStrategy as JsonObject[]).map((alloc) => ({
                reserve: String(alloc.reserve ?? ''),
                targetAllocationWeight:
                  alloc.targetAllocationWeight != null ? String(alloc.targetAllocationWeight) : undefined,
              }))
            : [],
        },
      });
    }
    return vaults;
  }

  async vaultMetrics(address: string): Promise<RestVaultMetrics> {
    const payload = await this.getJson(`/kvaults/vaults/${address}/metrics`);
    // Accept inline or `{ metrics: {...} }` envelope.
    const envelope = (isObject(payload) ? payload : {}) as JsonObject;
    const metrics = (isObject(envelope.metrics) ? envelope.metrics : envelope) as JsonObject;
    return {
      apy: toDecimal(metrics.apy),
      apy7d: toDecimal(metrics.apy7d),
      apy30d: toDecimal(metrics.apy30d),
      apy90d: toDecimal(metrics.apy90d),
      apyTheoretical: toDecimal(metrics.apyTheoretical),
      tokenPrice: toDecimal(metrics.tokenPrice),
      tokensAvailableUsd: toDecimal(metrics.tokensAvailableUsd),
      tokensInvestedUsd: toDecimal(metrics.tokensInvestedUsd),
      sharePrice: toDecimal(metrics.sharePrice),
      tokensPerShare: toDecimal(metrics.tokensPerShare),
      sharesIssued: toDecimal(metrics.sharesIssued),
      numberOfHolders: typeof metrics.numberOfHolders === 'number' ? metrics.numberOfHolders : undefined,
    };
  }
}

export class RateLimitError extends Error {}

/** SDK exposes name as `number[]`; REST decodes to string. Accept both. */
export function decodeVaultName(raw: unknown): string {
  if (typeof raw === 'string') return raw.replace(/\0+$/, '').trim();
  if (Array.isArray(raw) || raw instanceof Uint8Array) {
    return Buffer.from(raw as ArrayLike<number>)
      .toString('utf8')
      .replace(/\0+$/, '')
      .trim();
  }
  return '';
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

/** JSON → Decimal | undefined. Handles `{ value: ... }` envelopes for big numbers. */
function toDecimal(value: unknown): Decimal | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number' || typeof value === 'string') {
    try {
      return new Decimal(value);
    } catch {
      return undefined;
    }
  }
  if (isObject(value) && 'value' in value) return toDecimal((value as JsonObject).value);
  return undefined;
}
