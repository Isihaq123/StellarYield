import { describe, expect, it } from "vitest";
import {
  ApiClient,
  ENDPOINT_LIMITS,
  SdkEndpointError,
  computeBackoffDelayMs,
  validateEndpointConfig,
} from "../src";

const base = "https://api.stellaryield.com";

describe("endpoint boundary values", () => {
  it("accepts documented minimum and maximum values", () => {
    expect(
      validateEndpointConfig({
        baseUrl: base,
        timeoutMs: ENDPOINT_LIMITS.MIN_TIMEOUT_MS,
        maxRetries: 0,
        retryDelayMs: 0,
      }).valid
    ).toBe(true);
    expect(
      validateEndpointConfig({
        baseUrl: base,
        timeoutMs: ENDPOINT_LIMITS.MAX_TIMEOUT_MS,
        maxRetries: ENDPOINT_LIMITS.MAX_RETRIES,
        retryDelayMs: ENDPOINT_LIMITS.MAX_RETRY_DELAY_MS,
      }).valid
    ).toBe(true);
  });

  it("rejects zero timeout and values just past each limit", () => {
    for (const bad of [
      { timeoutMs: 0 },
      { timeoutMs: ENDPOINT_LIMITS.MAX_TIMEOUT_MS + 1 },
      { timeoutMs: Number.NaN },
      { timeoutMs: Infinity },
      { maxRetries: ENDPOINT_LIMITS.MAX_RETRIES + 1 },
      { maxRetries: -1 },
      { maxRetries: 1.5 },
      { retryDelayMs: ENDPOINT_LIMITS.MAX_RETRY_DELAY_MS + 1 },
      { retryDelayMs: -1 },
    ]) {
      const res = validateEndpointConfig({ baseUrl: base, ...bad });
      expect(res.valid, JSON.stringify(bad)).toBe(false);
      expect(res.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("computeBackoffDelayMs is checked, floored and capped", () => {
    expect(computeBackoffDelayMs(250, 0)).toBe(250);
    expect(computeBackoffDelayMs(250, 2)).toBe(1000);
    expect(computeBackoffDelayMs(0, 5)).toBe(0);
    expect(computeBackoffDelayMs(1.9, 0)).toBe(1);
    expect(computeBackoffDelayMs(ENDPOINT_LIMITS.MAX_RETRY_DELAY_MS, 10)).toBe(ENDPOINT_LIMITS.MAX_BACKOFF_MS);
    expect(computeBackoffDelayMs(250, 1024)).toBe(ENDPOINT_LIMITS.MAX_BACKOFF_MS);
    expect(computeBackoffDelayMs(Number.NaN, 1)).toBe(0);
    expect(computeBackoffDelayMs(100, -1)).toBe(0);
    expect(computeBackoffDelayMs(Infinity, 1)).toBe(0);
  });

  it("failed configureEndpoint leaves config and retry settings untouched; retry is safe", () => {
    const client = new ApiClient({ baseUrl: base, timeoutMs: 1000, maxRetries: 1 });
    const before = client.getConfig();
    expect(() => client.configureEndpoint({ timeoutMs: 0 })).toThrow(SdkEndpointError);
    expect(() => client.configureEndpoint({ maxRetries: 999 })).toThrow(SdkEndpointError);
    expect(client.getConfig()).toEqual(before);
    client.configureEndpoint({ timeoutMs: 2000, maxRetries: 3 });
    expect(client.getConfig().timeoutMs).toBe(2000);
    expect(client.getConfig().maxRetries).toBe(3);
  });
});
