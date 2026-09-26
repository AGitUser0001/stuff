/** @param {unknown} error @returns {number | undefined} */
export function httpStatus(error) {
  if (!error || typeof error !== "object") return undefined;
  const value = /** @type {any} */ (error);
  const status = value.status ?? value.status_code ?? value.statusCode ?? value.response?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  // youtubei.js HTTPClient includes the code in the message, not a status field.
  const match = /\bfailed with status code (\d{3})\b/.exec(String(value.message || ""));
  return match ? Number(match[1]) : undefined;
}

/** @param {unknown} error */
export function isTransientNetworkError(error) {
  const status = httpStatus(error);
  if (status !== undefined && (status >= 500 || status === 408 || status === 429)) return true;
  if (!(error instanceof Error)) return false;
  return (
    (error instanceof TypeError && error.message === "fetch failed") ||
    error.name === "TimeoutError" ||
    error.name === "AbortError"
  );
}
