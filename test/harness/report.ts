/**
 * Gate/assertion reporter. `npm run verify` prints a detailed pass/fail report,
 * gate by gate, assertion by assertion (mission §6).
 *
 * Statuses:
 *   PASS                 - assertion held
 *   FAIL                 - assertion violated (=> exit 1, run is NOT done)
 *   BLOCKED_ON_AUTH      - a live check could not run because the session is down
 *                          (TRANSITORY; allowed offline, NOT allowed to terminate
 *                          a live acceptance run)
 *   EMPIRICALLY_BLOCKED  - proven unavailable via the session, with evidence
 *   SKIP                 - not applicable in this mode
 */
export type Status = "PASS" | "FAIL" | "BLOCKED_ON_AUTH" | "EMPIRICALLY_BLOCKED" | "SKIP";

export interface Assertion {
  name: string;
  status: Status;
  detail?: string;
}

const COLORS: Record<Status, string> = {
  PASS: "\x1b[32m",
  FAIL: "\x1b[31m",
  BLOCKED_ON_AUTH: "\x1b[33m",
  EMPIRICALLY_BLOCKED: "\x1b[35m",
  SKIP: "\x1b[90m",
};
const RESET = "\x1b[0m";

export class GateRun {
  readonly assertions: Assertion[] = [];
  constructor(readonly name: string) {}

  private push(a: Assertion) {
    this.assertions.push(a);
    const c = COLORS[a.status];
    process.stderr.write(`  ${c}${a.status.padEnd(19)}${RESET} ${a.name}${a.detail ? `  — ${a.detail}` : ""}\n`);
  }

  /** Run an assertion fn; throwing => FAIL. fn may return a detail string. */
  async assert(name: string, fn: () => Promise<string | void> | string | void): Promise<boolean> {
    try {
      const detail = await fn();
      this.push({ name, status: "PASS", detail: detail || undefined });
      return true;
    } catch (e) {
      this.push({ name, status: "FAIL", detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  check(name: string, cond: boolean, detail?: string): boolean {
    this.push({ name, status: cond ? "PASS" : "FAIL", detail });
    return cond;
  }

  blocked(name: string, reason: string): void {
    this.push({ name, status: "BLOCKED_ON_AUTH", detail: reason });
  }

  empiricallyBlocked(name: string, evidence: string): void {
    this.push({ name, status: "EMPIRICALLY_BLOCKED", detail: evidence });
  }

  skip(name: string, reason: string): void {
    this.push({ name, status: "SKIP", detail: reason });
  }
}

export class Reporter {
  readonly gates: GateRun[] = [];

  async gate(name: string, fn: (g: GateRun) => Promise<void> | void): Promise<GateRun> {
    process.stderr.write(`\n\x1b[1m${name}\x1b[0m\n`);
    const g = new GateRun(name);
    this.gates.push(g);
    try {
      await fn(g);
    } catch (e) {
      g.check(`${name} crashed`, false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    }
    return g;
  }

  counts(): Record<Status, number> {
    const c: Record<Status, number> = { PASS: 0, FAIL: 0, BLOCKED_ON_AUTH: 0, EMPIRICALLY_BLOCKED: 0, SKIP: 0 };
    for (const g of this.gates) for (const a of g.assertions) c[a.status]++;
    return c;
  }

  /**
   * Final exit code.
   *  - any FAIL          => 1
   *  - live mode + any BLOCKED_ON_AUTH => 2 (run not done; re-auth required)
   *  - otherwise         => 0
   */
  finish(live: boolean): number {
    const c = this.counts();
    process.stderr.write(`\n\x1b[1mSummary\x1b[0m  PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED_ON_AUTH=${c.BLOCKED_ON_AUTH} EMPIRICALLY_BLOCKED=${c.EMPIRICALLY_BLOCKED} SKIP=${c.SKIP}\n`);
    if (c.FAIL > 0) {
      process.stderr.write(`\x1b[31mRESULT: FAIL — fix root causes and re-run.\x1b[0m\n`);
      return 1;
    }
    if (c.BLOCKED_ON_AUTH > 0) {
      if (live) {
        process.stderr.write(`\x1b[33mRESULT: BLOCKED_ON_AUTH — run \`npx mcp-ado-browser authenticate\`, then re-run verify:live. (run NOT done)\x1b[0m\n`);
        return 2;
      }
      process.stderr.write(`\x1b[33mRESULT: offline gates GREEN. Live acceptance still pending (BLOCKED_ON_AUTH) — provide config + authenticate to finish.\x1b[0m\n`);
      return 0;
    }
    process.stderr.write(`\x1b[32mRESULT: ALL GREEN.\x1b[0m\n`);
    return 0;
  }
}
