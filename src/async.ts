import { AsyncLocalStorage } from "node:async_hooks";

/** One operation budget shared by requests, retries and observation sleeps. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Absolute deadline, in milliseconds since the Unix epoch. */
  deadline?: number;
  /** Maximum total duration in milliseconds, including retries. */
  timeout?: number;
}

const requestOptionsStorage = new AsyncLocalStorage<RequestOptions>();

/** Propagate the MCP caller's cancellation context through ordinary handlers. */
export function withRequestOptions<T>(options: RequestOptions, callback: () => T): T {
  return requestOptionsStorage.run(options, callback);
}

export function currentRequestOptions(): RequestOptions {
  return requestOptionsStorage.getStore() ?? {};
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Operation aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Race even libraries that swallow AbortError or do not honor the signal. */
export function withAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    Promise.resolve(work).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function createRequestContext(options: RequestOptions = {}, defaultTimeout = 120_000) {
  const inherited = currentRequestOptions();
  options = {
    signal: options.signal ?? inherited.signal,
    deadline: options.deadline ?? inherited.deadline,
    timeout: options.timeout ?? inherited.timeout,
  };
  const timeout = options.timeout ?? defaultTimeout;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new RangeError("timeout must be a positive finite duration no greater than 2147483647ms");
  }
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new RangeError("deadline must be a finite Unix timestamp in milliseconds");
  }
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + timeout);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  const expire = () => controller.abort(new DOMException("Operation deadline exceeded", "TimeoutError"));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const remaining = deadline - Date.now();
  const timer = remaining > 0 ? setTimeout(expire, remaining) : undefined;
  if (remaining <= 0) expire();
  return {
    signal: controller.signal,
    deadline,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
  };
}

export function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(abortReason(signal!)); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
