/**
 * Centralized configuration for CloakBrowser Manager connections.
 * Validates and provides retry/connection policies.
 */

import "dotenv/config";

export interface ManagerConfig {
  /** Base URL of the Manager API. */
  url: string;

  /** Optional bearer token for authentication. */
  token?: string;

  /** Max time in ms to wait for a Manager API response. */
  connectTimeoutMs: number;

  /** Max number of retries for failed API calls. */
  maxRetries: number;

  /** Delay in ms between retry attempts. */
  retryDelayMs: number;

  /** Profile stale timeout (idle profiles marked stale after this). */
  staleTimeoutMs: number;

  /** Max connections to keep in the pool. */
  maxPoolSize: number;

  /** Health check interval in ms. */
  healthCheckIntervalMs: number;

  /** Enable metrics collection. */
  enableMetrics: boolean;

  /** Enable health monitoring. */
  enableHealthMonitor: boolean;
}

/**
 * Load and validate Manager configuration from environment variables.
 */
export function loadManagerConfig(): ManagerConfig {
  const cfg: ManagerConfig = {
    url: (process.env.MANAGER_URL || "http://localhost:8080").replace(/\/+$/, ""),
    token: (process.env.MANAGER_TOKEN || "").trim() || undefined,
    connectTimeoutMs: parseInt(process.env.MANAGER_CONNECT_TIMEOUT || "10000"),
    maxRetries: parseInt(process.env.MANAGER_MAX_RETRIES || "3"),
    retryDelayMs: parseInt(process.env.MANAGER_RETRY_DELAY || "2000"),
    staleTimeoutMs: parseInt(process.env.MANAGER_STALE_TIMEOUT || "300000"),
    maxPoolSize: parseInt(process.env.MANAGER_POOL_SIZE || "10"),
    healthCheckIntervalMs: parseInt(process.env.MANAGER_HEALTH_CHECK_INTERVAL || "30000"),
    enableMetrics: process.env.MANAGER_ENABLE_METRICS !== "false",
    enableHealthMonitor: process.env.MANAGER_ENABLE_HEALTH !== "false",
  };

  validateConfig(cfg);
  return cfg;
}

/**
 * Validate configuration values.
 */
function validateConfig(cfg: ManagerConfig): void {
  const errors: string[] = [];

  if (!cfg.url) {
    errors.push("MANAGER_URL is required");
  }

  if (cfg.connectTimeoutMs < 100 || cfg.connectTimeoutMs > 60000) {
    errors.push("MANAGER_CONNECT_TIMEOUT must be between 100 and 60000");
  }

  if (cfg.maxRetries < 0 || cfg.maxRetries > 10) {
    errors.push("MANAGER_MAX_RETRIES must be between 0 and 10");
  }

  if (cfg.retryDelayMs < 100 || cfg.retryDelayMs > 30000) {
    errors.push("MANAGER_RETRY_DELAY must be between 100 and 30000");
  }

  if (cfg.maxPoolSize < 1 || cfg.maxPoolSize > 100) {
    errors.push("MANAGER_POOL_SIZE must be between 1 and 100");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid Manager configuration:\n${errors.join("\n")}`);
  }
}

/**
 * Singleton configuration instance.
 */
let cachedConfig: ManagerConfig | null = null;

export function getManagerConfig(): ManagerConfig {
  if (!cachedConfig) {
    cachedConfig = loadManagerConfig();
  }
  return cachedConfig;
}

/**
 * Reset cached configuration (useful for tests).
 */
export function resetManagerConfig(): void {
  cachedConfig = null;
}

/**
 * Format config as a readable string.
 */
export function formatConfig(cfg: ManagerConfig): string {
  return `
  === Manager Configuration ===
  URL: ${cfg.url}
  Auth: ${cfg.token ? "enabled (token provided)" : "disabled"}
  Timeouts: connect=${cfg.connectTimeoutMs}ms, health-check=${cfg.healthCheckIntervalMs}ms
  Retries: max=${cfg.maxRetries}, delay=${cfg.retryDelayMs}ms
  Pool: max-size=${cfg.maxPoolSize}, stale-timeout=${cfg.staleTimeoutMs}ms
  Features: metrics=${cfg.enableMetrics}, health-monitor=${cfg.enableHealthMonitor}
  `;
}

