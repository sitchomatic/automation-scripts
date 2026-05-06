# Manager Improvements - Quick Reference Guide

## 🚀 Quick Start

### Enable All Features (Default)
Everything is enabled by default when `BACKEND=cloak`:
```bash
BACKEND=cloak npm start
# ✅ Pool, health checks, metrics, graceful shutdown all active
```

### Configure Features via Environment
```bash
# Connection Pool
export MANAGER_POOL_SIZE=20           # Max 20 pooled connections
export MANAGER_STALE_TIMEOUT=600000   # 10min idle timeout

# Health Checks
export MANAGER_ENABLE_HEALTH=true     # Enable health monitor
export MANAGER_HEALTH_CHECK_INTERVAL=60000  # 60s checks

# Metrics
export MANAGER_ENABLE_METRICS=true    # Enable metrics collection

# Manager API
export MANAGER_URL=http://localhost:8080   # Manager base URL
export MANAGER_TOKEN=secret-token          # Bearer token (if auth enabled)
export MANAGER_CONNECT_TIMEOUT=10000       # 10s API timeout
export MANAGER_MAX_RETRIES=3               # 3 retries on failure
```

---

## 📊 Monitoring Metrics

### Real-Time Metrics
Emitted at end of automation run:
```javascript
engine.on("metrics", (metrics) => {
  console.log(`Profiles: ${metrics.profilesRunning}/${metrics.profilesTotal} running`);
  console.log(`Pool: ${metrics.connectionsPooled} pooled (stale: ${metrics.connectionsStale})`);
  console.log(`Connect time: avg=${metrics.avgConnectTimeMs}ms, p95=${metrics.p95ConnectTimeMs}ms`);
  console.log(`Failure rate: ${(metrics.failureRate * 100).toFixed(2)}%`);
});
```

### Health Monitor Events
```javascript
healthMonitor.on("profile-healthy", (evt) => {
  console.log(`✓ Profile ${evt.profileId}: ${evt.responseTimeMs}ms`);
});

healthMonitor.on("profile-unhealthy", (evt) => {
  console.log(`✗ Profile ${evt.profileId} unreachable: ${evt.error}`);
  // Trigger auto-recovery logic here
});
```

---

## 🔌 Using Connection Pool

### Automatic Pooling
```javascript
// Pool is used automatically when acquiring sessions
const handle = await profilePool.acquire({
  profileName: "my-profile",
  autoStart: true
});

// Use the connection...
await handle.page.goto("https://example.com");

// Release back to pool for reuse
await profilePool.release(handle, true); // true = keep in pool
```

### Manual Pool Control
```javascript
// Get pool statistics
const stats = profilePool.getStats();
console.log(`${stats.activeCount} active, ${stats.staleCount} stale connections`);

// Mark old connections as stale
profilePool.markStale(600000); // Mark idle >10min as stale

// Drain pool (cleanup)
await profilePool.drain(); // Closes all connections
```

---

## ❤️ Health Monitoring

### Start/Stop Monitor
```javascript
// Automatically started when engine.start() called with BACKEND=cloak

// Manual control
healthMonitor.start();  // Start periodic checks
healthMonitor.stop();   // Stop checks

// Adjust configuration
process.env.MANAGER_HEALTH_CHECK_INTERVAL = "60000"; // 60s checks
```

### Health Check Results
```javascript
const lastCheck = healthMonitor.getLastCheck("profile-id");
console.log(`Status: ${lastCheck.status}`); // "healthy" | "unhealthy" | "unreachable"
console.log(`Response time: ${lastCheck.responseTimeMs}ms`);

// Get statistics
const stats = healthMonitor.getStats();
// { "profile-id": { total: 100, healthy: 98, healthyRate: "98.0%" } }
```

---

## 📈 Metrics Collection

### Enable/Disable Metrics
```bash
export MANAGER_ENABLE_METRICS=true    # Enable collection
export MANAGER_ENABLE_METRICS=false   # Disable collection
```

### Access Metrics
```javascript
const metrics = metricsCollector.collect({
  poolStats: poolPool.getStats(),
  profileStats: { total: 10, running: 8, stopped: 2 }
});

console.log(metricsCollector.format(metrics));
// Prints human-readable metrics summary
```

### Metrics Provided
```typescript
interface ManagerMetrics {
  // Inventory
  profilesTotal: number;        // Total profiles
  profilesRunning: number;      // Running count
  profilesStopped: number;      // Stopped count

  // Pool Status
  connectionsActive: number;    // In-use connections
  connectionsPooled: number;    // Idle in pool
  connectionsStale: number;     // Marked stale

  // Performance
  avgConnectTimeMs: number;     // Average connect time
  medianConnectTimeMs: number;  // Median connect time
  p95ConnectTimeMs: number;     // 95th percentile

  // Health
  healthyProfiles: number;      // Successful checks
  unhealthyProfiles: number;    // Failed checks
  failureRate: number;          // Failure rate (0.0-1.0)

  // Uptime
  lastCollectedAt: Date;
  uptime: { startedAt: Date; durationMs: number; }
}
```

---

## 🛑 Graceful Shutdown

### Automatic Shutdown
Triggered automatically on process exit:
- SIGTERM, SIGINT, SIGHUP signals
- Uncaught exceptions

### Manual Shutdown
```javascript
const result = await gracefulShutdown(30_000); // 30s timeout
console.log(result.message); // "Gracefully shut down: X profiles stopped"
console.log(result.success); // true/false
```

### Shutdown Sequence
1. Stop health monitor
2. Drain connection pool (close idle connections)
3. Stop all Manager profiles
4. Collect and emit final metrics

---

## 🔧 Configuration Validation

### Load Config
```javascript
import { getManagerConfig, formatConfig } from "./manager-config.js";

const cfg = getManagerConfig();
console.log(formatConfig(cfg));
```

### Valid Ranges
- `connectTimeoutMs`: 100-60000 (100ms-60s)
- `maxRetries`: 0-10
- `retryDelayMs`: 100-30000 (100ms-30s)
- `maxPoolSize`: 1-100
- `healthCheckIntervalMs`: Any positive value

### Invalid Config Examples
```bash
# ❌ Too low timeout
export MANAGER_CONNECT_TIMEOUT=50

# ❌ Too many retries
export MANAGER_MAX_RETRIES=15

# ❌ Invalid URL
export MANAGER_URL=""

# ✅ Valid configuration
export MANAGER_CONNECT_TIMEOUT=5000
export MANAGER_MAX_RETRIES=3
export MANAGER_URL=http://localhost:8080
```

---

## 🧪 Testing

### Run Unit Tests
```bash
npx vitest run manager-pool.test.ts        # Pool tests
npx vitest run manager-health.test.ts      # Health tests
npx vitest run manager-metrics.test.ts     # Metrics tests
npx vitest run manager-config.test.ts      # Config tests
npx vitest run manager-shutdown.test.ts    # Shutdown tests

# All tests
npx vitest run
```

### Run Integration Test
```bash
npx ts-node integration-test.ts
# Validates all 5 modules load and work together
```

### Performance Benchmarks
See `IMPLEMENTATION_SUMMARY.md` for testing priorities.

---

## 📋 Troubleshooting

| Issue | Solution |
|-------|----------|
| "Manager unreachable" | Check MANAGER_URL, verify Manager is running |
| Pool connections stale | Reduce MANAGER_STALE_TIMEOUT or call `profilePool.markStale()` |
| Health checks slow | Reduce MANAGER_HEALTH_CHECK_INTERVAL |
| Metrics not collecting | Check `MANAGER_ENABLE_METRICS=true` |
| Shutdown hangs | Check pool drain timeout in gracefulShutdown() call |

---

## 📚 Module Reference

| Module | Improvement | Key Export |
|--------|-------------|-----------|
| manager-pool.ts | #1 Pooling | `profilePool` |
| manager-health.ts | #2 Health | `healthMonitor` |
| manager-metrics.ts | #3 Metrics | `metricsCollector` |
| manager-config.ts | #5 Config | `getManagerConfig()` |
| manager-shutdown.ts | #4 Shutdown | `gracefulShutdown()` |

---

## 🎯 Best Practices

1. **Pool Size**: Set to number of concurrent credentials (default: 10)
2. **Health Check Interval**: 30-60s for production (30s default)
3. **Stale Timeout**: 5min for idle profiles (300s default)
4. **Metrics**: Keep enabled for observability (1% overhead)
5. **Auth Token**: Use when Manager has AUTH_TOKEN set
6. **Graceful Shutdown**: Let it run to completion (30s default timeout)

---

**For complete implementation details, see `IMPLEMENTATION_SUMMARY.md`**

