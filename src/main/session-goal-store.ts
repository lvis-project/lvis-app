/**
 * SessionGoalStore — the goal one chat session is working towards, keyed by
 * ChatSession id so renderer pushes route to the right tile. Sibling of
 * SessionTasksStore: the tasks are the steps, the goal is what the steps are
 * for and what keeps the session going after a turn ends.
 *
 * Durability: the goal is a field of the session's metadata sidecar
 * (`<id>.meta.json`), written through {@link SessionGoalPersistence} on every
 * mutation and read back lazily the first time a session is read after boot.
 * The revival counter lives inside that record, so a restart continues the
 * same budget instead of granting a fresh one.
 */
import { createLogger } from "../lib/logger.js";
import {
  MAX_SESSION_GOAL_CHARS,
  SESSION_GOAL_CEILING,
  type SessionGoal,
} from "../shared/session-goal.js";
const log = createLogger("lvis");

export type SessionGoalListener = (sessionId: string, goal: SessionGoal | null) => void;

/** Where a session's goal lives when this process is not holding it. */
export interface SessionGoalPersistence {
  load(sessionId: string): SessionGoal | null;
  save(sessionId: string, goal: SessionGoal | null): Promise<void>;
}

/** Goal text that names no goal — empty, blank, or past the stored bound. */
export class SessionGoalTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGoalTextError";
  }
}

/** A status change asked of a session that has no goal to change. */
export class SessionGoalMissingError extends Error {
  constructor() {
    super("this session has no goal yet: set one first");
    this.name = "SessionGoalMissingError";
  }
}

function normalizeText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new SessionGoalTextError("goal text is empty");
  }
  if (text.length > MAX_SESSION_GOAL_CHARS) {
    throw new SessionGoalTextError(
      `goal text is longer than ${MAX_SESSION_GOAL_CHARS} characters`,
    );
  }
  return text;
}

export class SessionGoalStore {
  private readonly sessions = new Map<string, SessionGoal | null>();
  private readonly listeners = new Set<SessionGoalListener>();

  constructor(
    private readonly persistence: SessionGoalPersistence,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get(sessionId: string): SessionGoal | null {
    const held = this.current(sessionId);
    return held === null ? null : { ...held };
  }

  /**
   * Upsert: no goal yet sets one with a fresh budget, an existing goal has its
   * text replaced and its revival counter kept. Registering a new text does
   * not refund rounds already spent — the budget belongs to the session, not
   * to the wording of the goal.
   *
   * The result is always `running`: naming an objective is an instruction to
   * work on it. A caller that means "register this but do not start" says so
   * with the `pause` verb, which is applied after this one.
   */
  set(sessionId: string, text: string): Promise<SessionGoal> {
    const normalized = normalizeText(text);
    const held = this.current(sessionId);
    const timestamp = this.now();
    const next: SessionGoal = held === null
      ? {
          text: normalized,
          status: "running",
          round: 0,
          ceiling: SESSION_GOAL_CEILING,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
      : { ...held, text: normalized, status: "running", updatedAt: timestamp };
    return this.commit(sessionId, next);
  }

  /**
   * `resume` on a goal whose budget is already spent would be a resume that
   * revives nothing, so it extends the ceiling by one more allowance — the
   * same answer the user gives the chip when it asks whether to continue.
   */
  resume(sessionId: string): Promise<SessionGoal> {
    const held = this.require(sessionId);
    const ceiling = held.round >= held.ceiling
      ? held.round + SESSION_GOAL_CEILING
      : held.ceiling;
    return this.commit(sessionId, {
      ...held,
      status: "running",
      ceiling,
      updatedAt: this.now(),
    });
  }

  pause(sessionId: string): Promise<SessionGoal> {
    return this.commit(sessionId, {
      ...this.require(sessionId),
      status: "paused",
      updatedAt: this.now(),
    });
  }

  complete(sessionId: string): Promise<SessionGoal> {
    return this.commit(sessionId, {
      ...this.require(sessionId),
      status: "complete",
      updatedAt: this.now(),
    });
  }

  /**
   * Spend one revival. Persisted BEFORE the revival turn runs, so a turn that
   * crashes or is interrupted still consumed its round — the alternative is a
   * failing goal that revives forever.
   */
  recordRevival(sessionId: string): Promise<SessionGoal> {
    const held = this.require(sessionId);
    return this.commit(sessionId, {
      ...held,
      round: held.round + 1,
      updatedAt: this.now(),
    });
  }

  /** Manual dismiss: drop the goal (memory + sidecar) and emit the absence. */
  async clear(sessionId: string): Promise<void> {
    await this.persistence.save(sessionId, null);
    this.sessions.set(sessionId, null);
    this.emit(sessionId, null);
  }

  onChange(listener: SessionGoalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private require(sessionId: string): SessionGoal {
    const held = this.current(sessionId);
    if (held === null) throw new SessionGoalMissingError();
    return held;
  }

  private current(sessionId: string): SessionGoal | null {
    const held = this.sessions.get(sessionId);
    if (held !== undefined) return held;
    const loaded = this.persistence.load(sessionId);
    this.sessions.set(sessionId, loaded);
    return loaded;
  }

  /**
   * Sidecar first, memory second: a failed write leaves the held goal as it
   * was, so the chip's round count never runs ahead of what a restart brings
   * back.
   */
  private async commit(sessionId: string, next: SessionGoal): Promise<SessionGoal> {
    await this.persistence.save(sessionId, next);
    this.sessions.set(sessionId, next);
    this.emit(sessionId, next);
    return { ...next };
  }

  private emit(sessionId: string, goal: SessionGoal | null): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, goal === null ? null : { ...goal });
      } catch (err) {
        log.warn("session-goal listener threw: %s", (err as Error).message);
      }
    }
  }
}
