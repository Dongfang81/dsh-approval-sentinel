/**
 * dsh-approval-sentinel (帮我批准) — type declarations.
 * The runtime implementation is plain ESM in lib/; these types describe the
 * public surface for editors and packagers.
 */

export interface AssessorVerdict {
  verdict: "allow" | "reject" | "wait";
  riskLevel: "low" | "medium" | "high" | "critical" | "unknown";
  rationale: string;
}

export interface SentinelConfig {
  /** Master switch; false delegates every request to the human channel. */
  enabled: boolean;
  /** Wait for the human before the assessor steps in (ms). Default 120000. */
  graceMs: number;
  /** Extra wait when no human answerer exists at all (headless, ms). Default 0. */
  headlessGraceMs: number;
  /** End-to-end deadline for one assessor run (ms). Default 90000. */
  assessTimeoutMs: number;
  /** `wait` rounds before failing closed to `rejected`. Default 2. */
  maxWaits: number;
  /** Max concurrently running assessor agents. Default 3. */
  maxConcurrentAssessments: number;
  /** Reviewer model override; empty = inherit the requesting agent's route. */
  assessorModel: string;
  /** Reviewer provider override; empty = inherit the requesting agent's route. */
  assessorProvider: string;
  /** `wait` hands an assessor failure back to the human; `reject` denies immediately. */
  onAssessError: "reject" | "wait";
  /** Deterministic quick-deny regexes. */
  denyPatterns: string[];
  /** Deterministic quick-allow regexes (deny wins). */
  allowPatterns: string[];
  /** Inject a user-visible decision notice into the session. */
  notifyUser: boolean;
  /** Extra info-level logging. */
  verbose: boolean;
}

/** The approval request shape this plugin consumes. */
export interface SentinelApprovalRequest {
  agent: any;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export function quickCheck(toolName: string, reason: string | undefined, cfg: Pick<SentinelConfig, "denyPatterns" | "allowPatterns">): "allow" | "reject" | undefined;

export function buildSessionContext(events: readonly any[], options?: { maxEvents?: number; maxEventChars?: number; maxTotalChars?: number }): string;

export function runApprovalFlow(input: {
  req: SentinelApprovalRequest;
  next: () => Promise<ApprovalOutcome>;
  cfg: SentinelConfig;
  deps: {
    assess: (input: { req: SentinelApprovalRequest; cfg: SentinelConfig; headless: boolean; waitRound: number }) => Promise<AssessorVerdict>;
    sleep: (ms: number) => Promise<void>;
    log?: (level: string, ...args: any[]) => void;
    notify?: (agent: any, text: string) => void;
  };
}): Promise<ApprovalOutcome>;

export function createGate(max: number): <T>(task: () => Promise<T>) => Promise<T>;
