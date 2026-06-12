import { createHash } from "node:crypto";
import type { Session } from "./server-session.js";
import type { ParsedSummarizeRequest } from "./server-summarize-request.js";

const DAEMON_MAX_ACTIVE_SUMMARIES_DEFAULT = 4;
const DAEMON_MAX_ACTIVE_SUMMARIES_LIMIT = 32;

export function buildActiveSummarizeKey(request: ParsedSummarizeRequest): string {
  const textHash = request.textContent
    ? createHash("sha256").update(request.textContent).digest("hex")
    : "";
  return createHash("sha256")
    .update(
      JSON.stringify({
        pageUrl: request.pageUrl,
        title: request.title,
        textHash,
        truncated: request.truncated,
        modelOverride: request.modelOverride,
        lengthRaw: request.lengthRaw,
        languageRaw: request.languageRaw,
        promptOverride: request.promptOverride,
        noCache: request.noCache,
        mode: request.mode,
        maxCharacters: request.maxCharacters,
        format: request.format,
        overrides: request.overrides,
        slidesSettings: request.slidesSettings,
      }),
    )
    .digest("hex");
}

export function resolveDaemonMaxActiveSummaries(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES?.trim();
  if (!raw) return DAEMON_MAX_ACTIVE_SUMMARIES_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DAEMON_MAX_ACTIVE_SUMMARIES_DEFAULT;
  return Math.min(DAEMON_MAX_ACTIVE_SUMMARIES_LIMIT, Math.max(1, Math.floor(parsed)));
}

async function drainActiveTasks(activeTasks: Set<Promise<void>>): Promise<void> {
  while (activeTasks.size > 0) {
    const tasks = [...activeTasks];
    await Promise.allSettled(tasks);
    for (const task of tasks) {
      activeTasks.delete(task);
    }
  }
}

export async function closeAfterActiveTasks({
  activeTasks,
  timeoutMs,
  close,
}: {
  activeTasks: Set<Promise<void>>;
  timeoutMs: number;
  close: () => void;
}): Promise<boolean> {
  const drainPromise = drainActiveTasks(activeTasks);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drained = false;
  try {
    drained = await Promise.race([
      drainPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (drained) {
    close();
  } else {
    void drainPromise.then(close).catch(() => {});
  }
  return drained;
}

export class DaemonRuntime {
  readonly sessions = new Map<string, Session>();
  readonly refreshSessions = new Map<string, Session>();
  readonly maxActiveSummaries: number;

  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeSummarizeRequests = new Map<string, string>();
  private activeSummarizeCount = 0;
  private currentRefreshSessionId: string | null = null;

  constructor(options: { maxActiveSummaries: number }) {
    this.maxActiveSummaries = options.maxActiveSummaries;
  }

  get activeRefreshSessionId(): string | null {
    return this.currentRefreshSessionId;
  }

  registerRefreshSession(session: Session): void {
    this.refreshSessions.set(session.id, session);
    this.currentRefreshSessionId = session.id;
  }

  finishRefreshSession(sessionId: string): void {
    if (this.currentRefreshSessionId === sessionId) {
      this.currentRefreshSessionId = null;
    }
  }

  findActiveSummarizeSession(key: string): Session | null {
    const sessionId = this.activeSummarizeRequests.get(key);
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && session && !session.done) return session;
    if (sessionId && !session) {
      this.activeSummarizeRequests.delete(key);
    }
    return null;
  }

  registerActiveSummarizeRequest(key: string, sessionId: string): void {
    this.activeSummarizeRequests.set(key, sessionId);
  }

  clearActiveSummarizeRequest(key: string, sessionId: string): void {
    if (this.activeSummarizeRequests.get(key) === sessionId) {
      this.activeSummarizeRequests.delete(key);
    }
  }

  reserveSummarizeSlot(): (() => void) | null {
    if (this.activeSummarizeCount >= this.maxActiveSummaries) return null;
    this.activeSummarizeCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSummarizeCount = Math.max(0, this.activeSummarizeCount - 1);
    };
  }

  trackSummarizeTask(task: Promise<unknown>, releaseSlot: () => void): void {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.activeTasks.add(tracked);
    void tracked.finally(() => {
      this.activeTasks.delete(tracked);
      releaseSlot();
    });
  }

  trackRequestTask(task: Promise<void>): void {
    this.activeTasks.add(task);
    void task.finally(() => this.activeTasks.delete(task));
  }

  closeAfterActiveTasks(options: { timeoutMs: number; close: () => void }): Promise<boolean> {
    return closeAfterActiveTasks({ activeTasks: this.activeTasks, ...options });
  }
}
