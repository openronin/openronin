import { readdirSync, readFileSync } from "node:fs";

// Memory footprint of a process tree, sampled from /proc (Linux only).
//
// Used to size the host for parallel drain slots: an engine run is not just
// the Claude Code process but everything the agent spawns underneath it
// (test suites, static analysers, package managers, builds). We sum PSS —
// proportional set size — rather than RSS so shared pages (the same binary
// or library mapped by several processes) are counted once across the tree
// instead of once per process. Falls back to RSS when smaps_rollup is
// unreadable.
//
// Processes that daemonize away from the tree (setsid + parent exit) are
// reparented and drop out of the measurement — the number is a lower bound
// for such cases, which agent runs practically never produce.

const PROC = "/proc";

function readKb(text: string, field: string): number | undefined {
  const m = text.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m"));
  return m ? Number(m[1]) : undefined;
}

// Memory of a single process in bytes; undefined if it vanished mid-read.
function processBytes(pid: number): number | undefined {
  try {
    const kb = readKb(readFileSync(`${PROC}/${pid}/smaps_rollup`, "utf8"), "Pss");
    if (kb !== undefined) return kb * 1024;
  } catch {
    // fall through to RSS
  }
  try {
    const kb = readKb(readFileSync(`${PROC}/${pid}/status`, "utf8"), "VmRSS");
    return kb !== undefined ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

// Parent pid from /proc/<pid>/stat. The command name (field 2) is wrapped
// in parentheses and may itself contain spaces or ')', so parse from the
// LAST ')' rather than splitting the whole line.
function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`${PROC}/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    return Number.isFinite(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

// Total memory of `rootPid` and all of its descendants, in bytes.
// Returns undefined when /proc is unavailable or the root is gone.
export function sampleTreeBytes(rootPid: number): number | undefined {
  let entries: string[];
  try {
    entries = readdirSync(PROC);
  } catch {
    return undefined;
  }
  const children = new Map<number, number[]>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const ppid = parentPid(pid);
    if (ppid === undefined) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const rootBytes = processBytes(rootPid);
  if (rootBytes === undefined) return undefined;
  let total = rootBytes;
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    total += processBytes(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

export interface PeakMemorySampler {
  // Stop sampling; returns the peak observed, or undefined if no sample
  // ever succeeded (non-Linux host, process exited before the first tick).
  stop(): number | undefined;
}

// Sample the tree every `intervalMs` and keep the maximum. Short spikes
// between ticks are missed, so this is a slight underestimate; the heavy
// phases of an agent run (test suites, analysers, builds) last seconds to
// minutes and are captured.
export function startPeakMemorySampler(rootPid: number, intervalMs = 2000): PeakMemorySampler {
  let peak: number | undefined;
  const sample = () => {
    const bytes = sampleTreeBytes(rootPid);
    if (bytes !== undefined && (peak === undefined || bytes > peak)) peak = bytes;
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return peak;
    },
  };
}
