# MCP turn performance

Production tool handlers + production API client; simulated backend, no LLM, no real network. Baseline already parallelizes independent calls within each dependency phase. HTTP OAuth validation is outside this harness.

Runtime v22.23.3. Each API request has a simulated 10 ms delay; timings are medians of 3 runs.
A round is a scripted model/server dependency phase, not an observed LLM turn. Tool calls are separate invocations; independent calls in a baseline round run concurrently.

| Scenario | Tool calls before → after | Dependency rounds before → after | API requests before → after | Median ms before → after |
|---|---:|---:|---:|---:|
| Routine removal, unit conversion and measurement | 3 → 1 | 3 → 1 | 6 → 2 | 76.5 → 27.9 |
| Six-part training overview | 6 → 1 | 1 → 1 | 12 → 2 | 14.3 → 12.5 |
| Resolve three exercise names | 3 → 1 | 1 → 1 | 3 → 1 | 15.2 → 13.8 |
| Find exercises, create and schedule routine | 5 → 1 | 2 → 1 | 6 → 2 | 38 → 28.5 |
| Find exercises, log workout and weigh-in | 5 → 1 | 2 → 1 | 6 → 2 | 46.6 → 27.3 |
| Create routine, schedule and preview | 6 → 1 | 3 → 1 | 8 → 4 | 51 → 36.9 |
| Discover and execute configuration API | 3 → 1 | 3 → 1 | 1 → 1 | 11.8 → 11.4 |
| Pair code creation and redemption | 2 → 1 | 2 → 1 | 2 → 2 | 22.9 → 23.4 |
| Repeated configuration reads | 6 → 1 | 1 → 1 | 6 → 1 | 12.5 → 12 |
| Atomic weigh-in plus settings update | 2 → 1 | 2 → 1 | 3 → 2 | 34 → 22.5 |
| Search and append exercise to routine | 3 → 1 | 2 → 1 | 4 → 2 | 34.7 → 22.9 |
| Assign routine by name plus rest day | 2 → 1 | 2 → 1 | 3 → 2 | 34.2 → 23.6 |

The optimized server advertises 91 tools; its JSON tool metadata is 83,099 bytes. Named API tools remove discovery turns at the cost of a larger initial tool catalogue. Their descriptions are summaries; full endpoint documentation remains on-demand.

Read batching reduces duplicated backend requests, not the minimum model round count for reads that a client could already issue in parallel. Combined writes and result references remove genuine dependency rounds. Timings exclude inference, OAuth validation, TLS, real providers, payload-scale effects and network variability; do not interpret them as measured ChatGPT latency.

Re-run: `npm run benchmark:turns` from `mcp/`. The regression suite asserts call/request/round counts and concurrency bounds instead of fragile wall-clock thresholds.
