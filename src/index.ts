/**
 * CLI entry point.
 *   npm run screen        — ranked shortlist to pin
 *   npm start             — loop (simulation-only)
 *   npm start -- --once   — single cycle
 */
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { runLoop, runOnceCli, runScreenCli } from './orchestrator.js';

const ansi = { reset: '\x1b[0m', greenBold: '\x1b[1;32m', dim: '\x1b[2m' };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'run';
  const has = (flag: string) => argv.includes(flag);

  const cfg = loadConfig();

  if (command === 'screen') {
    const log = createLogger(cfg.logFormat, cfg.logLevel);
    await runScreenCli(cfg, log);
    return;
  }
  if (command !== 'run') {
    throw new Error(`Unknown command "${command}". Use: screen | run [--once]`);
  }

  const log = createLogger(cfg.logFormat, cfg.logLevel);

  console.log(
    `\n${ansi.greenBold} MODE: SIMULATION-ONLY — builds & simulates against mainnet, never signs ${ansi.reset}\n`,
  );
  console.log(
    `${ansi.dim}rpc=${cfg.rpcUrl}  asset=${cfg.asset}  pinned=${cfg.pinnedVaults.length}` +
      `  maxWeight=${cfg.allocator.maxWeightPct}%  poll=${Math.round(cfg.pollIntervalMs / 1000)}s${ansi.reset}\n`,
  );

  if (has('--once')) await runOnceCli(cfg, log);
  else await runLoop(cfg, log);
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
