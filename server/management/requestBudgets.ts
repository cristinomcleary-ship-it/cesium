import { ManagementError } from "./domain.ts";

/** In-memory protection only; expiry also frees abandoned username keys. */
export class LoginAttemptBudget {
  private readonly failures = new Map<string, { count: number; since: number }>();
  private sweptAt = 0;
  constructor(
    private readonly clock = () => Date.now(),
    private readonly maxKeys = 10_000,
    private readonly windowMs = 300_000,
    private readonly maxFailures = 10,
  ) {}

  private current(key: string) {
    const now = this.clock();
    if (now - this.sweptAt >= this.windowMs || this.failures.size >= this.maxKeys) {
      for (const [entryKey, entry] of this.failures) {
        if (now - entry.since >= this.windowMs) this.failures.delete(entryKey);
      }
      this.sweptAt = now;
    }
    const entry = this.failures.get(key);
    if (entry && now - entry.since >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }

  check(key: string) {
    const entry = this.current(key);
    if (entry ? entry.count >= this.maxFailures : this.failures.size >= this.maxKeys) {
      throw new ManagementError(429, "LOGIN_RATE_LIMIT", "登录尝试过多，请稍后重试");
    }
  }

  fail(key: string) {
    const entry = this.current(key);
    // check() runs immediately before synchronous password verification.
    if (entry) entry.count++;
    else if (this.failures.size < this.maxKeys) this.failures.set(key, { count: 1, since: this.clock() });
  }

  clear(key?: string) {
    if (key === undefined) this.failures.clear();
    else this.failures.delete(key);
  }
}

export type UploadBudgetOptions = { maxConcurrent?: number; maxBufferedBytes?: number };

/** Includes both the incoming chunks and the final Buffer.concat allocation. */
export class BufferedUploadBudget {
  private active = 0;
  private buffered = 0;
  private readonly maxConcurrent: number;
  private readonly maxBufferedBytes: number;

  constructor(options: UploadBudgetOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 200 * 1024 * 1024;
    for (const value of [this.maxConcurrent, this.maxBufferedBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Upload budgets must be positive integers");
    }
  }

  acquire() {
    if (this.active >= this.maxConcurrent) throw new ManagementError(429, "UPLOAD_BUSY", "附件上传繁忙，请稍后重试");
    this.active++;
    let reserved = 0, released = false;
    return {
      reserve: (bytes: number) => {
        if (released) throw new Error("Upload reservation already released");
        const memory = bytes * 2;
        if (this.buffered + memory > this.maxBufferedBytes) {
          throw new ManagementError(429, "UPLOAD_MEMORY_LIMIT", "附件上传内存预算已满，请稍后重试");
        }
        reserved += memory;
        this.buffered += memory;
      },
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.buffered -= reserved;
      },
    };
  }
}
