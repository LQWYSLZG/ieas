import { useState, useCallback } from "react";

/**
 * Structured error returned by the API client for both HTTP errors
 * and network/timeout failures.
 */
export interface ApiError {
  status: number | null; // null for network errors
  message: string;
  body?: unknown;
  isNetworkError: boolean;
}

/**
 * State shape returned by the useApi hook.
 */
export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  isLoading: boolean;
}

/** Default timeout for all requests (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Constructs a full URL by joining the base URL and path,
 * ensuring no double slashes between them.
 */
export function buildUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Returns the configured API base URL from environment variables,
 * defaulting to `/api/v1` if not set.
 */
function getBaseUrl(): string {
  return (
    (typeof import.meta !== "undefined" &&
      import.meta.env?.VITE_API_BASE_URL) ||
    "/api/v1"
  );
}

/**
 * Core API request function used by all App_Modules to communicate
 * with the backend API_Server.
 *
 * - Prefixes paths with VITE_API_BASE_URL (defaults to `/api/v1`)
 * - 30-second timeout on all requests (configurable via options.timeout)
 * - Returns structured ApiError for HTTP errors and network failures
 * - Ensures no double slashes in constructed URLs
 */
export async function apiRequest<T>(
  method: string,
  path: string,
  options?: { body?: FormData | object; timeout?: number }
): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = buildUrl(baseUrl, path);
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: HeadersInit = {};
    let requestBody: BodyInit | undefined;

    if (options?.body) {
      if (options.body instanceof FormData) {
        // Let the browser set Content-Type with boundary for FormData
        requestBody = options.body;
      } else {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(options.body);
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }

      const error: ApiError = {
        status: response.status,
        message:
          response.statusText || `HTTP error ${response.status}`,
        body,
        isNetworkError: false,
      };
      throw error;
    }

    // Parse successful response
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return (await response.json()) as T;
    }

    // For non-JSON responses, return the text as unknown cast to T
    return (await response.text()) as unknown as T;
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    // If it's already an ApiError we threw above, re-throw it
    if (isApiError(err)) {
      throw err;
    }

    // Network error or abort (timeout)
    const isTimeout =
      err instanceof DOMException && err.name === "AbortError";

    const error: ApiError = {
      status: null,
      message: isTimeout
        ? "Request timed out"
        : "Network error: unable to connect",
      isNetworkError: true,
    };
    throw error;
  }
}

/**
 * Type guard to check if an error is an ApiError.
 */
export function isApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "isNetworkError" in err &&
    "message" in err &&
    typeof (err as ApiError).isNetworkError === "boolean" &&
    typeof (err as ApiError).message === "string"
  );
}

/**
 * React hook that wraps apiRequest with loading, data, and error state.
 * Exposes an `execute` function to trigger the request.
 *
 * Usage:
 * ```tsx
 * const { data, error, isLoading, execute } = useApi<MyData>();
 *
 * useEffect(() => {
 *   execute("GET", "/inventory-assistant/items");
 * }, [execute]);
 * ```
 */
export function useApi<T>(): ApiState<T> & {
  execute: (
    method: string,
    path: string,
    options?: { body?: FormData | object; timeout?: number }
  ) => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const execute = useCallback(
    async (
      method: string,
      path: string,
      options?: { body?: FormData | object; timeout?: number }
    ) => {
      setIsLoading(true);
      setError(null);
      setData(null);

      try {
        const result = await apiRequest<T>(method, path, options);
        setData(result);
      } catch (err: unknown) {
        if (isApiError(err)) {
          setError(err);
        } else {
          setError({
            status: null,
            message: "An unexpected error occurred",
            isNetworkError: true,
          });
        }
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return { data, error, isLoading, execute };
}
