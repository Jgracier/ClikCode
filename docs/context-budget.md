# Agent context budgets

ClikCode's own agent, used by Gateway and local models, builds a bounded view before each model step. CLI and VS Code use this shared agent path. Vendor harnesses continue to own their native context handling.

The durable transcript stays intact. The current user request and system instructions stay verbatim in every working view; earlier user requests remain intact in the durable transcript and are selected by relevance when space allows. The latest work step stays in view; older steps are selected by task relevance and recency. Calls, results and signed reasoning stay together. Oversized evidence has an explicit retrieval reference. `read_context` searches the current conversation or its original handoff record; it cannot open another session's record. Large tool outputs are saved in private session artifacts and can be read or searched using the existing file tools.

Ordinary coding tools remain available up front. Browser, desktop and specialist schemas load through `load_tools`. At 8K tokens or below, coding schemas also load on demand. MCP catalogs use the existing loader and the same small eager budget in every profile. Loading changes advertised schemas, never the execution registry, argument validation or permissions. Subagents get their own retrieval scope and loaders.

Budgets include UTF-8 text, schemas, framing, image estimates, response headroom and a margin. Reported model windows outrank stale caller values; a newly selected model missing from the saved catalog triggers a catalog refresh. Server usage calibrates the estimate during the turn. A model change resets that calibration. Output headroom travels with the request so an adapter cannot unknowingly spend it twice. Without model metadata the fallback window is 32K; it is an estimate, not a promise of server capacity.

Fitting requests keep their original items and schema order, preserving prefix caches. Selection costs are calculated incrementally rather than repeatedly serializing the selected conversation. No summarizing model call, transcript rewrite or hidden model fallback is involved. If essential instructions cannot fit, the turn reports the limit instead of silently deleting them. Server request limits likewise cannot truncate system instructions or discard declared tools.

## Continued execution within capacity

A capacity-busy response means healthy resources are occupied. The turn waits with cancellation available, using the same model, rather than treating it as exhausted account usage. ClikDeploy enforces each capacity replica's declared workload concurrency with a renewable lease held until its response body ends or is cancelled. Legacy model placements default to one full-context inference at a time. Future llama.cpp launches explicitly use one parallel slot to match that memory plan.

A runtime context refusal triggers a smaller view, preserving the saved transcript and current request. Refits are bounded to three per step and never resend the refused payload unchanged. Transient stream failures save partial text and ask the same model to continue. Only fully received tool calls execute; incomplete calls are regenerated. Productive output-limit continuations are not capped at three chunks; empty continuations and outages remain bounded.

Background execution no longer implies Git isolation. A background research task can run outside a repository. Agents sharing a working directory share a mutation queue for individual write and exec tool calls; explicit worktrees provide independent branches. A process launched into the background can outlive its tool call, so this queue is not filesystem isolation.

## Validation

The deterministic 20-step coding fixture verifies the actual pager fix, added test and helper renames. It does not evaluate model intelligence. With the same fixture on baseline `9576ad2d` and this patch:

| Scenario | Before | After |
| --- | ---: | ---: |
| Initial request, default tools | 12,358 | 4,833 |
| Initial request, full profile, 76 MCP tools, 30 skills | 23,255 | 7,069 |
| Default session uncached tokens | 26,832 | 13,552 |
| Transitions reusing the complete previous prefix | 19/19 | 19/19 |

These benchmark counts use characters divided by four for comparison, not exact provider tokenization or billing. Request-fit tests cover 4K, 8K, 16K, 32K and 128K windows, Unicode, images, signed reasoning, call/result pairing, 1,000 silent tool steps, scope isolation, retrieval of omitted evidence, metadata changes and pre-HTTP rejection of impossible requests.

No implementation can guarantee equal answer quality across models or fit essential instructions larger than a model's window. Exact tokenization and image costs remain model-specific; conservative estimates and reported usage reduce, but cannot eliminate, that uncertainty.
