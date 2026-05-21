/**
 * Per-vault rolling history persisted to JSON. Bounded by `maxPerVault`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HistorySample } from '../types.js';

export class History {
  private samples: HistorySample[] = [];

  private constructor(
    private readonly path: string,
    private readonly maxPerVault: number,
  ) {}

  /** Missing/corrupt file → start empty. */
  static async load(path: string, maxPerVault: number): Promise<History> {
    const history = new History(path, maxPerVault);
    try {
      const txt = await readFile(path, 'utf8');
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed?.samples)) history.samples = parsed.samples;
    } catch {
      /* first run or unreadable — begin fresh */
    }
    return history;
  }

  /** Oldest first. */
  forVault(vaultId: string): HistorySample[] {
    return this.samples.filter((sample) => sample.vaultId === vaultId);
  }

  /** Oldest first. */
  all(): HistorySample[] {
    return [...this.samples];
  }

  append(newSamples: HistorySample[]): void {
    this.samples.push(...newSamples);
    const byVault = new Map<string, HistorySample[]>();
    for (const sample of this.samples) {
      const list = byVault.get(sample.vaultId) ?? [];
      list.push(sample);
      byVault.set(sample.vaultId, list);
    }
    const trimmed: HistorySample[] = [];
    for (const list of byVault.values()) {
      trimmed.push(...list.slice(-this.maxPerVault));
    }
    this.samples = trimmed.sort((left, right) => left.ts - right.ts);
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ samples: this.samples }, null, 2));
  }
}
