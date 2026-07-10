# Latency chart render benchmarks

Fixture: **7 days × 1 min × 2 resolvers × 8 domains ≈ 161,280 rows**  
Harness: `npm run bench` (vitest bench, happy-dom)

## Before / After (same machine)

| Case | Before (mean) | After (mean) | Speedup |
|------|--------------:|-------------:|--------:|
| `collectTimelineTimestamps` @ 24h | 3.2 ms | 3.2 ms | ~1× |
| `buildRollingEnvelope` ×2 @ 24h | **925 ms** | **26 ms** | **~36×** |
| `buildRollingEnvelope` ×2 @ 30m | **5,060 ms** | **24 ms** | **~210×** |
| `computeStats` (full history) | 25 ms | 24 ms | ~1× |
| **`buildLatencyChart` full @ 24h** | **6,021 ms** | **538 ms** | **~11×** |
| **`buildLatencyChart` full @ 30m** | **9,600 ms** | **1,516 ms** | **~6.3×** |

- **Before**: chart code on `master` before this change (boxplot windows + full-history scatter).
- **After**: this branch (binary-search windows, O(n) moments, visible-window scatter).

Absolute times depend on CPU; use the speedup column for comparison. Re-run with `npm run bench` after code changes.
