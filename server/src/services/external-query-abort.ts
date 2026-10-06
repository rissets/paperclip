export function createExternalQueryAbortError(): Error {
  const error = new Error("External database query was canceled because the client disconnected");
  error.name = "AbortError";
  return error;
}

export function isExternalQueryAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfExternalQueryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createExternalQueryAbortError();
}
