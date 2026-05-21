import "dotenv/config";
import { config as loadDotenv } from "dotenv";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { AllocatorConfig, RiskConfig, ScreenerConfig } from "./types.js";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((val) =>
      val == null ? def : ["1", "true", "yes", "on"].includes(val.toLowerCase()),
    );

/** A numeric env var with a default. */
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((val) => (val == null || val === "" ? def : Number(val)))
    .pipe(z.number());

/** A comma-separated list -> trimmed non-empty string[]. */
const list = z
  .string()
  .optional()
  .transform((val) =>
    (val ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
  KAMINO_API_URL: z.url().default("https://api.kamino.finance"),

  ASSET: z.string().min(1).default("USDC"),
  PINNED_VAULTS: list,

  // APY arrives as a fraction (0.085); we work in percent. Flip if observed otherwise.
  APY_IS_FRACTION: bool(true),
  /** Pretend idle cash for paper-trade demos. 0 = off. */
  SIM_IDLE_USD: num(0),
  /** Default 1 is correct for stablecoin underlyings; set for non-stable assets. */
  ASSET_PRICE_USD: num(1),
  SCREEN_MAX_VAULTS: num(40),

  MAX_WEIGHT_PCT: num(40),
  /** -1 => derive as MAX_WEIGHT_PCT/2 ("trim, don't exit"). */
  RISK_REDUCED_MAX_WEIGHT_PCT: num(-1),
  /** util-trend weight (0..1); APY weight = 1 - this. One knob, can't desync. */
  UTIL_WEIGHT: num(0.2),
  IMPROVEMENT_THRESHOLD_BPS: num(50),
  MIN_MOVE_USD: num(25),
  EST_MOVE_COST_USD: num(0.05),

  MIN_AUM_USD: num(1_000_000),
  MAX_FEE_BPS: num(2_000),
  MIN_APY_PCT: num(2),
  STABILITY_FLOOR: num(0.7),
  TRUSTED_CURATORS: list,

  AUM_DROP_PCT: num(30),
  ALLOC_SHIFT_PCT: num(40),
  /** ≥ this for MAX_UTIL_SUSTAIN_MS of consecutive polls → block. 99.9 ≈ 100% with float headroom. */
  MAX_UTIL_PCT: num(99.9),
  MAX_UTIL_SUSTAIN_MS: num(300_000),

  /** Lookback window for curator-instruction flagging (also bounds restart re-flag). */
  CURATOR_ACTION_LOOKBACK_MS: num(900_000),
  POLL_INTERVAL_MS: num(60_000),
  SCREEN_INTERVAL_MS: num(86_400_000),
  HISTORY_PATH: z.string().default("data/history.json"),
  HISTORY_MAX: num(240),

  LOG_FORMAT: z.enum(["pretty", "json"]).default("pretty"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = {
  rpcUrl: string;
  kaminoApiUrl: string;
  asset: string;
  pinnedVaults: string[];
  apyIsFraction: boolean;
  simIdleUsd: number;
  assetPriceUsd: number;
  screenMaxVaults: number;
  curatorActionLookbackMs: number;
  pollIntervalMs: number;
  screenIntervalMs: number;
  historyPath: string;
  historyMax: number;
  logFormat: "pretty" | "json";
  logLevel: "debug" | "info" | "warn" | "error";
  allocator: AllocatorConfig;
  screener: ScreenerConfig;
  risk: RiskConfig;
};

export function loadConfig(processEnv: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(processEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration (see .env.example for the documented values):\n${issues}`,
    );
  }
  const env = parsed.data;

  if (env.MAX_WEIGHT_PCT <= 0 || env.MAX_WEIGHT_PCT > 100) {
    throw new Error("MAX_WEIGHT_PCT must be in (0, 100].");
  }
  // Cap below 1/N makes a fully-invested portfolio impossible.
  const numVaults = env.PINNED_VAULTS.length;
  if (numVaults > 0 && env.MAX_WEIGHT_PCT < 100 / numVaults) {
    throw new Error(
      `MAX_WEIGHT_PCT=${env.MAX_WEIGHT_PCT} is below 100/${numVaults}=${(100 / numVaults).toFixed(
        1,
      )} — capital could never be fully deployed across ${numVaults} pinned vaults.`,
    );
  }

  return {
    rpcUrl: env.RPC_URL,
    kaminoApiUrl: env.KAMINO_API_URL,
    asset: env.ASSET.toUpperCase(),
    pinnedVaults: env.PINNED_VAULTS,
    apyIsFraction: env.APY_IS_FRACTION,
    simIdleUsd: env.SIM_IDLE_USD,
    assetPriceUsd: env.ASSET_PRICE_USD,
    screenMaxVaults: env.SCREEN_MAX_VAULTS,
    curatorActionLookbackMs: env.CURATOR_ACTION_LOOKBACK_MS,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    screenIntervalMs: env.SCREEN_INTERVAL_MS,
    historyPath: env.HISTORY_PATH,
    historyMax: env.HISTORY_MAX,
    logFormat: env.LOG_FORMAT,
    logLevel: env.LOG_LEVEL,
    allocator: {
      maxWeightPct: env.MAX_WEIGHT_PCT,
      riskReducedMaxWeightPct:
        env.RISK_REDUCED_MAX_WEIGHT_PCT >= 0
          ? env.RISK_REDUCED_MAX_WEIGHT_PCT
          : env.MAX_WEIGHT_PCT / 2,
      // Derived so the blend always sums to 1 — no desync possible.
      wUtil: Math.min(1, Math.max(0, env.UTIL_WEIGHT)),
      wApy: 1 - Math.min(1, Math.max(0, env.UTIL_WEIGHT)),
      improvementThresholdBps: env.IMPROVEMENT_THRESHOLD_BPS,
      minMoveUsd: new Decimal(env.MIN_MOVE_USD),
      estMoveCostUsd: new Decimal(env.EST_MOVE_COST_USD),
    },
    screener: {
      asset: env.ASSET.toUpperCase(),
      minAumUsd: new Decimal(env.MIN_AUM_USD),
      maxFeeBps: env.MAX_FEE_BPS,
      minApyPct: new Decimal(env.MIN_APY_PCT),
      stabilityFloor: env.STABILITY_FLOOR,
      trustedCurators: env.TRUSTED_CURATORS,
    },
    risk: {
      minAumUsd: new Decimal(env.MIN_AUM_USD),
      aumDropPct: env.AUM_DROP_PCT,
      allocShiftPct: env.ALLOC_SHIFT_PCT,
      // 5× poll: past rate-limit backoffs but well under "bot off overnight".
      maxSampleAgeMs: env.POLL_INTERVAL_MS * 5,
      maxUtilPct: env.MAX_UTIL_PCT,
      // ≥2 polls so we have an actual window, not a single point.
      maxUtilPolls: Math.max(2, Math.ceil(env.MAX_UTIL_SUSTAIN_MS / env.POLL_INTERVAL_MS)),
    },
  };
}

export function reloadConfig(): Config {
  loadDotenv({ override: true });
  return loadConfig();
}

/** Fields that need rebuilding the Kamino client / RPC / signer slot. */
const RESTART_REQUIRED: ReadonlyArray<keyof Config> = [
  "rpcUrl",
  "kaminoApiUrl",
  "pinnedVaults",
  "asset",
  "historyPath",
  "historyMax",
  "pollIntervalMs",
];

export function applyHotReload(
  running: Config,
  fresh: Config,
): { next: Config; hotApplied: string[]; restartRequired: string[] } {
  const hotApplied: string[] = [];
  const restartRequired: string[] = [];

  const next: Config = { ...fresh };
  for (const key of RESTART_REQUIRED) {
    if (JSON.stringify((running as Record<string, unknown>)[key]) !==
        JSON.stringify((fresh as Record<string, unknown>)[key])) {
      restartRequired.push(key);
    }
    (next as Record<string, unknown>)[key] = (running as Record<string, unknown>)[key];
  }

  for (const key of Object.keys(running) as Array<keyof Config>) {
    if (RESTART_REQUIRED.includes(key)) continue;
    if (JSON.stringify((running as Record<string, unknown>)[key]) !==
        JSON.stringify((fresh as Record<string, unknown>)[key])) {
      hotApplied.push(key);
    }
  }

  return { next, hotApplied, restartRequired };
}

export function requirePinnedVaults(cfg: Config, expected = 3): string[] {
  if (cfg.pinnedVaults.length !== expected) {
    throw new Error(
      `Expected exactly ${expected} pinned vaults in PINNED_VAULTS, got ${cfg.pinnedVaults.length}. ` +
        `Run \`npm run screen\` to get a ranked shortlist, then set PINNED_VAULTS in .env.`,
    );
  }
  return cfg.pinnedVaults;
}
