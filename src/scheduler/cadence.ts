import type { CadenceSchema } from "../config/schema.js";
import { z } from "zod";

export type Cadence = z.infer<typeof CadenceSchema>;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(input: string): number {
  const match = input.match(/^(\d+)([smhd])$/i);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const n = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const factor = UNIT_MS[unit];
  if (!factor) throw new Error(`Invalid duration unit: ${unit}`);
  return n * factor;
}

const HOT_AGE_DAYS = 30;
const DEFAULT_AGE_DAYS = 90;

export type Bucket = "hot" | "default" | "cold";

export function bucketFor(createdAt: string, now = new Date()): Bucket {
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  if (ageMs < HOT_AGE_DAYS * UNIT_MS.d!) return "hot";
  if (ageMs < DEFAULT_AGE_DAYS * UNIT_MS.d!) return "default";
  return "cold";
}

// Compute when this item should next be reviewed, based on its age bucket.
export function computeNextDueAt(createdAt: string, cadence: Cadence, now = new Date()): string {
  const bucket = bucketFor(createdAt, now);
  const intervalMs = parseDurationMs(cadence[bucket]);
  return new Date(now.getTime() + intervalMs).toISOString();
}

export function isDue(nextDueAt: string | null, now = new Date()): boolean {
  if (!nextDueAt) return true;
  return new Date(nextDueAt).getTime() <= now.getTime();
}
