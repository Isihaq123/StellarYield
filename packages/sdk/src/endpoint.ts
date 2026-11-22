import type { ApiRetryConfig, ApiCacheStore } from "./types";
import {
  SdkDiagnostic,
  SdkDiagnosticCode,
  SdkStage,
  buildSdkFailureDiagnostics,
  areDiagnosticsPrivacySafe,
} from "./diagnostics";

/**
 * Diagnostic context optionally provided when configuring an endpoint or
 * issuing requests.
 */
export interface EndpointDiagnosticContext {
  /** Optional correlation or request ID for distributed tracing. */
  correlationId?: string;
  /** Environment or client tier identifier (e.g. 'production', 'testnet'). */
  environment?: string;
  /** Whether state preservation should be explicitly attached to diagnostics. Defaults to true. */
  preserveState?: boolean;
}

/**
 * Enhanced configuration for SDK endpoints.
 */
export interface SdkEndpointConfig extends ApiRetryConfig {
  /** Primary base URL for API or RPC requests (e.g. 'https://api.stellaryield.com'). */
  baseUrl: string;
  /** Optional backup/fallback URLs to use when the primary endpoint is degraded or unavailable. */
  fallbackUrls?: string[];
  /** Optional diagnostic context. */
  diagnosticContext?: EndpointDiagnosticContext;
  /** Cache store for offline fallback. */
  cacheStore?: ApiCacheStore;
}

/**
 * Documented numeric boundaries for endpoint configuration.
 * All bounds are inclusive. Values outside them are rejected before any state changes.
 */
export const ENDPOINT_LIMITS = {
  /** Smallest accepted per-request timeout (ms). Zero is rejected. */
  MIN_TIMEOUT_MS: 1,
  /** Largest accepted timeout (ms). Matches the 32-bit signed limit of setTimeout, above which timers fire immediately. */
  MAX_TIMEOUT_MS: 2_147_483_647,
  /** Largest accepted retry count. Zero (no retries) is valid. */
  MAX_RETRIES: 10,
  /** Largest accepted base retry delay (ms). Zero is valid. */
  MAX_RETRY_DELAY_MS: 60_000,
  /** Upper cap applied to any computed exponential backoff delay (ms). */
  MAX_BACKOFF_MS: 300_000,
} as const;

/**
 * Computes exponential backoff `baseMs * 2^attempt` with checked arithmetic.
 * Rounding: result is rounded down to a whole millisecond and saturates at
 * `ENDPOINT_LIMITS.MAX_BACKOFF_MS`. Invalid input (negative, NaN, non-finite)
 * yields 0, so the result is never NaN or Infinity.
 */
export function computeBackoffDelayMs(baseMs: number, attempt: number): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  if (!Number.isInteger(attempt) || attempt < 0) return 0;
  const cap = ENDPOINT_LIMITS.MAX_BACKOFF_MS;
  // 2^attempt would overflow the cap long before attempt 53; short-circuit.
  if (attempt >= 31) return cap;
  const raw = baseMs * 2 ** attempt;
  if (!Number.isFinite(raw)) return cap;
  return Math.min(Math.floor(raw), cap);
}

export interface EndpointValidationResult {
  valid: boolean;
  errors: string[];
  diagnostics: SdkDiagnostic[];
}

/**
 * Validates a single endpoint URL.
 * Rejects empty strings, non-http/https protocols, malformed URLs, and URLs with embedded user credentials.
 */
export function validateEndpointUrl(url: unknown): { valid: boolean; error?: string } {
  if (typeof url !== "string" || url.trim() === "") {
    return { valid: false, error: "Endpoint URL must be a non-empty string." };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Endpoint URL protocol must be 'http:' or 'https:'." };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, error: "Endpoint URL must not contain embedded user credentials." };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Endpoint URL is not a valid absolute URL." };
  }
}

/**
 * Normalizes an endpoint URL (trims trailing slashes).
 */
export function normalizeEndpointUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Validates an SDK endpoint configuration object.
 * Returns privacy-safe diagnostics when validation fails, identifying the
 * `endpoint-configuration` stage and confirming that existing state and balances
 * were preserved.
 */
export function validateEndpointConfig(config: unknown): EndpointValidationResult {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
      stage: "endpoint-configuration",
      summary: "Endpoint configuration must be a valid non-null object.",
      remediation: "Provide a valid configuration object with a valid 'baseUrl'; prior state was preserved.",
    });
    return {
      valid: false,
      errors: ["Configuration must be a non-null object."],
      diagnostics,
    };
  }

  const errors: string[] = [];
  const cfg = config as Partial<SdkEndpointConfig>;

  const baseResult = validateEndpointUrl(cfg.baseUrl);
  if (!baseResult.valid) {
    errors.push(`baseUrl: ${baseResult.error}`);
  }

  if (cfg.fallbackUrls !== undefined) {
    if (!Array.isArray(cfg.fallbackUrls)) {
      errors.push("fallbackUrls must be an array of URL strings.");
    } else {
      for (let i = 0; i < cfg.fallbackUrls.length; i++) {
        const fallbackRes = validateEndpointUrl(cfg.fallbackUrls[i]);
        if (!fallbackRes.valid) {
          errors.push(`fallbackUrls[${i}]: ${fallbackRes.error}`);
        }
      }
    }
  }

  if (
    cfg.timeoutMs !== undefined &&
    (typeof cfg.timeoutMs !== "number" || !Number.isFinite(cfg.timeoutMs) ||
      cfg.timeoutMs < ENDPOINT_LIMITS.MIN_TIMEOUT_MS ||
      cfg.timeoutMs > ENDPOINT_LIMITS.MAX_TIMEOUT_MS)
  ) {
    errors.push(
      `timeoutMs must be a finite number between ${ENDPOINT_LIMITS.MIN_TIMEOUT_MS} and ${ENDPOINT_LIMITS.MAX_TIMEOUT_MS}.`
    );
  }

  if (
    cfg.maxRetries !== undefined &&
    (typeof cfg.maxRetries !== "number" || !Number.isInteger(cfg.maxRetries) ||
      cfg.maxRetries < 0 ||
      cfg.maxRetries > ENDPOINT_LIMITS.MAX_RETRIES)
  ) {
    errors.push(`maxRetries must be an integer between 0 and ${ENDPOINT_LIMITS.MAX_RETRIES}.`);
  }

  if (
    cfg.retryDelayMs !== undefined &&
    (typeof cfg.retryDelayMs !== "number" || !Number.isFinite(cfg.retryDelayMs) ||
      cfg.retryDelayMs < 0 ||
      cfg.retryDelayMs > ENDPOINT_LIMITS.MAX_RETRY_DELAY_MS)
  ) {
    errors.push(`retryDelayMs must be a finite number between 0 and ${ENDPOINT_LIMITS.MAX_RETRY_DELAY_MS}.`);
  }

  if (errors.length > 0) {
    const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
      stage: "endpoint-configuration",
      summary: "Endpoint configuration rejected during parameter validation.",
      remediation: "Correct the invalid endpoint parameters; existing state and balances are unchanged.",
    });
    return { valid: false, errors, diagnostics };
  }

  return { valid: true, errors: [], diagnostics: [] };
}

/**
 * Safely resolves or enriches error diagnostics when diagnostic context is
 * missing, incomplete, or malformed.
 */
export function resolveSafeDiagnostics(
  error: unknown,
  fallbackStage: SdkStage = "network-dispatch",
  isExecution = false
): SdkDiagnostic[] {
  // If the error already carries privacy-safe diagnostics, check and return them
  if (
    typeof error === "object" &&
    error !== null &&
    "diagnostics" in error &&
    Array.isArray((error as any).diagnostics) &&
    (error as any).diagnostics.length > 0 &&
    areDiagnosticsPrivacySafe((error as any).diagnostics)
  ) {
    return (error as any).diagnostics;
  }

  // If error has a response body carrying diagnostics (e.g. returned from server routes)
  if (
    typeof error === "object" &&
    error !== null &&
    "responseBody" in error &&
    typeof (error as any).responseBody === "object" &&
    Array.isArray((error as any).responseBody?.diagnostics) &&
    areDiagnosticsPrivacySafe((error as any).responseBody.diagnostics)
  ) {
    return (error as any).responseBody.diagnostics;
  }

  // When context is insufficient (opaque error, empty string, or unclassifiable response)
  const code: SdkDiagnosticCode = isExecution ? "RETRY_UNSAFE" : "CONTEXT_INSUFFICIENT";
  return buildSdkFailureDiagnostics(code, {
    stage: fallbackStage,
    preserveState: true,
  });
}