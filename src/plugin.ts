/** Wiring: http.request interception, refresh (awaited on first sight), stats collection. */

import { Plugin } from "@opencode/plugin";
import {
	DEFAULT_OPTIONS,
	type OptimizerOptions,
	resolveOptions,
} from "./config";
import {
	OptimizerDb,
	type RoutingSnapshot,
	type RoutingState,
	routingStateFromRow,
} from "./db";
import {
	fetchModelEndpoints,
	fetchOpenRouterProfile,
	fetchToolCallErrorRate,
	permaslugFromEndpoints,
} from "./openrouter";
import {
	composeRouting,
	type ProviderRank,
	providerSlug,
	rankProviders,
} from "./ranking";
import { type LocalProfile, mergeProfile, OpenCodeStats } from "./stats";

interface HttpEventLike {
	request?: Request;
	model?: { providerID?: string; modelID?: string };
	sessionID?: string;
}

const LOG_PREFIX = "[openrouter-optimizer]";

/**
 * Metadata key the server part stamps on routing-failure synthetic messages so the
 * TUI part (src/tui.ts) can recognize them without parsing message text. Duplicated
 * as a literal there on purpose: the TUI part must not import server code, which
 * would pull bun:sqlite into the TUI process.
 */
const ROUTING_FAILURE_METADATA_KEY = "openrouter-optimizer";

/** Failure backoff: 30s doubling to 1h, with 50-100% jitter. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 3_600_000;

function backoffMs(attempts: number): number {
	const exponent = Math.min(Math.max(attempts - 1, 0), 10);
	const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
	return Math.round(base * (0.5 + Math.random() * 0.5));
}

function emptyState(model: string): RoutingState {
	return {
		model,
		lastFetched: null,
		lastAttempt: null,
		attempts: 0,
		retryAfter: null,
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Resolve when the task settles or when the wait budget runs out. Never rejects:
 * a refresh failure must fail open (request passes through) instead of failing it.
 */
function waitForTask(task: Promise<void>, ms: number): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve();
		};
		timer = setTimeout(finish, Math.max(0, ms));
		// Never keep the process alive just to expire a wait cap.
		(timer as unknown as { unref?: () => void }).unref?.();
		task.then(finish, finish);
	});
}

export function definePlugin(overrides: Partial<OptimizerOptions> = {}) {
	return Plugin.define({
		id: "openrouter-optimizer",
		async setup(ctx) {
			let options: OptimizerOptions;
			try {
				options = resolveOptions({
					...DEFAULT_OPTIONS,
					...overrides,
					...((ctx.options ?? {}) as Record<string, unknown>),
				});
			} catch (error) {
				// Invalid configuration must stop the plugin instead of silently falling back
				// to defaults: a typo like "topn" or "injectSort: 0" would otherwise change
				// routing without the user knowing.
				console.error(
					LOG_PREFIX,
					error instanceof Error ? error.message : error,
				);
				throw error;
			}
			const debug = (...parts: unknown[]) => {
				if (options.debug) console.log(LOG_PREFIX, ...parts);
			};
			const warn = (...parts: unknown[]) => console.warn(LOG_PREFIX, ...parts);

			const db = new OptimizerDb(options.dbPath);
			const ttlMs = options.ttlHours * 3_600_000;
			const inflight = new Map<string, Promise<void>>();
			const controller = new AbortController();
			let statsWarned = false;
			const stats = new OpenCodeStats({
				command: options.statsCommand,
				days: options.statsDays,
				ttlMs: options.statsCacheMinutes * 60_000,
				run: options.statsRun,
				// A broken stats CLI silently degrades every profile to fallbacks, which can
				// rank the wrong providers cheapest. The first failure is therefore a real
				// warning; repeats stay quiet (debug) until the process restarts.
				log: (message) => {
					if (statsWarned) {
						debug(message);
						return;
					}
					statsWarned = true;
					warn(
						`opencode stats unavailable, ranking falls back to defaults until it recovers: ${message}`,
					);
				},
			});

			// Read per refresh: the key may be exported after the plugin loaded.
			const managementKey = () => process.env[options.managementKeyEnv];

			// One-time notices per model: a ranking with zero survivors passes requests
			// through unrouted, which must not be invisible.
			const unroutedWarned = new Set<string>();

			// One-time notice per model: the keepAtLeastN floor relaxed the filters, so
			// providers that failed them are being routed to. That must not be invisible.
			const rescueWarned = new Set<string>();

			// One-time notices per session/model for requests that could not be routed and
			// went out unfiltered. Synthetic messages make the failure visible in the TUI.
			const notifiedFailures = new Set<string>();

			/**
			 * Tell the session that a request could not be routed and was sent unfiltered.
			 * Synthetic messages appear in the TUI, unlike console warnings buried in logs.
			 * Fire-and-forget: a notification must never delay or fail the request.
			 */
			function notifyRoutingFailure(
				evt: HttpEventLike,
				reason: string,
				error?: unknown,
			): void {
				const sessionID = evt.sessionID;
				if (!sessionID) return;
				const model =
					typeof evt.model?.modelID === "string"
						? evt.model.modelID
						: "unknown";
				const key = `${sessionID}:${model}:${reason}`;
				if (notifiedFailures.has(key)) return;
				notifiedFailures.add(key);
				const detail =
					error instanceof Error ? error.message : error ? String(error) : "";
				const text = `OpenRouter optimizer could not route ${model} (${reason}); the request was sent unfiltered.${detail ? ` ${detail}` : ""}`;
				void ctx.session
					.synthetic({
						sessionID,
						text,
						description: "Routing failure",
						// Machine-readable flag so the TUI part can raise a toast without
						// sniffing message text.
						metadata: {
							[ROUTING_FAILURE_METADATA_KEY]: { kind: "routing-failure" },
						},
					})
					.catch((notifyError: unknown) => {
						warn(
							"failed to notify session about routing failure:",
							notifyError instanceof Error ? notifyError.message : notifyError,
						);
					});
			}

			// Same notice class: a ranking persisted with no usage data at all prices
			// endpoints with a guessed token profile, which can rank the wrong
			// providers cheapest. One notice per model keeps a fresh install quiet
			// after its first refresh.
			const unprofiledWarned = new Set<string>();

			// Activity data silently disappears when the management key is unset; one
			// notice explains where the ranking's numbers come from instead.
			let activityKeyWarned = false;

			// Non-JSON bodies and optional stats probes are skipped by design; each skip must
			// still surface once instead of disappearing into debug logs.
			let bodyFormatWarned = false;
			const toolRateWarned = new Set<string>();

			// Hot path state: warm the cache once, then every request is a map lookup.
			// The DB stays durable; another process may refresh behind us, which is bounded
			// by the same TTL the routing decisions already use.
			const routes = new Map<string, RoutingState>();

			/**
			 * A row that claims a fresh ranking but carries no readable one is damage:
			 * a fetch was recorded without its ranking. Repair it instead of only
			 * reporting it. Without the repair the notice repeats on every start for
			 * a model that is never requested again, because the re-rank it promises
			 * needs a request that never comes.
			 */
			function adoptState(state: RoutingState): RoutingState {
				if (state.lastFetched !== null && !state.routing) {
					try {
						db.resetUnreadableRanking(state.model);
					} catch (error) {
						warn(
							`could not reset the unreadable ranking for ${state.model}:`,
							error instanceof Error ? error.message : error,
						);
					}
					// Mirror the reset in memory: the row no longer looks fresh, so the
					// next request re-ranks it instead of skipping the refresh.
					state.lastFetched = null;
					state.attempts = 0;
					state.retryAfter = null;
					warn(
						`${state.model}: stored ranking is unreadable, it was discarded; the next request re-ranks`,
					);
				}
				return state;
			}

			for (const state of db.loadRoutingStates(options.debug)) {
				routes.set(state.model, adoptState(state));
			}

			/** Resolve one model's state, reading the DB at most once per process. */
			function stateFor(model: string, now: number): RoutingState {
				const cached = routes.get(model);
				if (cached) return cached;
				const state = adoptState(
					routingStateFromRow(db.ensureFetchRow(model, now), options.debug),
				);
				routes.set(model, state);
				return state;
			}

			/** Build the merged request profile: OpenCode stats CLI + OpenRouter activity (+ fallbacks). */
			async function buildProfile(model: string) {
				// Both sources run concurrently in the background task; both snapshots are
				// cached and single-flighted across models.
				const key = managementKey();
				if (!key && !activityKeyWarned) {
					activityKeyWarned = true;
					warn(
						`${options.managementKeyEnv} is not set: OpenRouter activity data is unused, ranking relies on OpenCode stats and defaults`,
					);
				}
				const [statsResult, remoteResult] = await Promise.allSettled([
					stats.get(),
					key
						? fetchOpenRouterProfile(model, key, { signal: controller.signal })
						: Promise.resolve(undefined),
				]);
				let local: LocalProfile | undefined;
				if (statsResult.status === "fulfilled") local = stats.pick(model);
				else {
					// get() never rejects today; if that guarantee ever breaks, say so
					// instead of silently ranking from defaults.
					warn(
						`opencode stats lookup failed for ${model}:`,
						statsResult.reason instanceof Error
							? statsResult.reason.message
							: statsResult.reason,
					);
				}
				let remote;
				if (key) {
					if (remoteResult.status === "fulfilled") remote = remoteResult.value;
					else {
						warn(
							`activity fetch failed for ${model}:`,
							remoteResult.reason instanceof Error
								? remoteResult.reason.message
								: remoteResult.reason,
						);
					}
				}
				return mergeProfile(
					local,
					remote,
					{
						avgInput: options.fallbackAvgInput,
						avgOutput: options.fallbackAvgOutput,
						cacheHitRate: options.fallbackCacheHitRate,
					},
					(message, data) => debug(message, data),
				);
			}

			async function refreshModel(model: string): Promise<void> {
				try {
					debug("refreshing", model);
					// Endpoint prices and the request profile are independent: start both now.
					const [endpoints, profile] = await Promise.all([
						fetchModelEndpoints(model, { signal: controller.signal }),
						buildProfile(model),
					]);
					// buildProfile swallows aborts (Promise.allSettled inside), so a shutdown
					// mid-profile would otherwise persist a fallback-profile ranking as fresh
					// for the whole TTL. A completed endpoints fetch does not make it valid.
					if (controller.signal.aborted) return;

					// A ranking computed from zero usage data prices every endpoint with
					// the default token profile. Endpoints are still real, so the routing
					// is kept, but the guesswork must not be invisible.
					if (profile.numRequests === 0 && !unprofiledWarned.has(model)) {
						unprofiledWarned.add(model);
						warn(
							`${model}: no usage data available, ranking uses the default token profile`,
						);
					}

					// Tool Call Error Rate: optional data, fetched only when the filter is on.
					// A failure or an empty result means the filter cannot run. That is allowed,
					// but it must not be silent: warn once per model instead of ranking as if
					// every provider were below the cap. The permaslug comes from the endpoints
					// payload itself (its name tails), so no extra resolution request is needed.
					if (options.maxToolCallErrorRate < 100) {
						const permaslug = permaslugFromEndpoints(endpoints.endpoints);
						if (permaslug) {
							try {
								const rates = await fetchToolCallErrorRate(permaslug, {
									signal: controller.signal,
									timeRange: "1w",
								});
								if (rates.size === 0) {
									if (!toolRateWarned.has(model)) {
										toolRateWarned.add(model);
										warn(
											`${model}: tool call error rate data is empty, ranking without the filter`,
										);
									}
								} else {
									for (const endpoint of endpoints.endpoints) {
										endpoint.toolCallErrorRate = rates.get(
											providerSlug(endpoint),
										);
									}
								}
							} catch (error) {
								if (isAbortError(error)) throw error;
								if (!toolRateWarned.has(model)) {
									toolRateWarned.add(model);
									warn(
										`tool call error rate unavailable for ${model}, ranking without it:`,
										error instanceof Error ? error.message : error,
									);
								} else {
									debug(
										"tool call error rate unavailable, ranking without it:",
										error,
									);
								}
							}
						} else {
							if (!toolRateWarned.has(model)) {
								toolRateWarned.add(model);
								warn(
									`tool call error rate skipped for ${model}: the endpoints payload carries no permaslug`,
								);
							} else {
								debug(
									"tool call error rate skipped: the endpoints payload carries no permaslug",
								);
							}
						}
					}

					const ranking = rankProviders(endpoints.endpoints, profile, options);
					const now = Date.now();
					const routing: RoutingSnapshot = {
						survivors: ranking.survivors,
						blacklist: ranking.blacklist,
						computedAt: ranking.computedAt,
						mode: ranking.mode,
					};
					// One write per refresh. Full rankings are debug-only payload; blacklist
					// reasons are always stored so the debug option works on any ranking.
					db.saveRefresh(
						model,
						routing,
						now,
						options.debug ? ranking.rankings : undefined,
						ranking.blacklistReasons,
					);

					const state = routes.get(model) ?? emptyState(model);
					state.lastFetched = now;
					state.lastAttempt = now;
					state.attempts = 0;
					state.retryAfter = null;
					state.routing = routing;
					if (options.debug) state.details = ranking.rankings;
					state.blacklistReasons = ranking.blacklistReasons;
					routes.set(model, state);
					if (
						routing.survivors.length === 0 &&
						routing.blacklist.length === 0
					) {
						// Nothing is enforced and requests pass through unrouted; make that
						// visible once per model per process instead of debug-only.
						if (!unroutedWarned.has(model)) {
							unroutedWarned.add(model);
							warn(
								`${model}: no endpoint passed the filters, requests pass through unrouted`,
							);
						}
					} else if (ranking.rescued.length > 0 && !rescueWarned.has(model)) {
						// The floor kept providers that failed the filters, so the requests now
						// go to providers the filters rejected. Say which ones and why.
						rescueWarned.add(model);
						const details = ranking.rescued
							.map((slug) => {
								const failed =
									ranking.rankings.find((entry) => entry.slug === slug)
										?.failedReasons ?? [];
								return failed.length > 0
									? `${slug} (${failed.join(", ")})`
									: slug;
							})
							.join(", ");
						warn(
							`${model}: the filters left too few providers standing, so ${ranking.rescued.length} provider(s) that failed them are used anyway: ${details}`,
						);
					}

					const debugParts = [
						`ranked ${model} (${routing.mode}): top ${routing.survivors.length} = [${routing.survivors.join(", ")}]`,
						`blacklist size ${routing.blacklist.length}`,
					];
					if (ranking.rescued.length > 0)
						debugParts.push(
							`rescued (failed the filters): [${ranking.rescued.join(", ")}]`,
						);
					debug(...debugParts);
				} catch (error) {
					// A shutdown abort cancels the refresh; it is not a refresh failure and the
					// DB may already be closing, so skip failure bookkeeping entirely.
					if (controller.signal.aborted || isAbortError(error)) return;
					const failedAt = Date.now();
					const state = routes.get(model) ?? emptyState(model);
					try {
						// Other processes record failures into the same row: the DB is the shared
						// truth for the attempt count that drives backoff duration. Read it before
						// recording, or the first failure after startup would overwrite a longer
						// accumulated backoff with a short attempts=1 deadline.
						let sharedAttempts = state.attempts;
						const row = db.getFetch(model);
						if (row && row.attempts > sharedAttempts)
							sharedAttempts = row.attempts;
						const attempts = sharedAttempts + 1;
						state.attempts = attempts;
						state.lastAttempt = failedAt;
						state.retryAfter = failedAt + backoffMs(attempts);
						db.recordFailure(model, failedAt, state.retryAfter);
						// Another process may have recorded a failure between the read and the
						// write; the read-back keeps the in-memory count aligned with the row.
						const fresh = db.getFetch(model);
						if (fresh) {
							state.attempts = fresh.attempts;
							state.lastAttempt = fresh.last_attempt ?? failedAt;
							state.retryAfter = fresh.retry_after ?? state.retryAfter;
						}
					} catch (dbError) {
						warn(
							`failure bookkeeping failed for ${model}:`,
							dbError instanceof Error ? dbError.message : dbError,
						);
					}
					routes.set(model, state);
					warn(
						`refresh failed for ${model}:`,
						error instanceof Error ? error.message : error,
					);
				}
			}

			/**
			 * Start or join the refresh for a model. Returns the in-flight task so a request
			 * with no ranking yet can wait for it. Undefined means no refresh was started:
			 * the ranking is fresh enough or the model is backing off after a failure.
			 */
			function ensureFresh(
				state: RoutingState,
				now: number,
				force = false,
			): Promise<void> | undefined {
				const model = state.model;
				const running = inflight.get(model);
				if (running) return running;
				const fresh =
					!force &&
					state.lastFetched !== null &&
					now - state.lastFetched <= ttlMs;
				if (fresh) return undefined;
				if (state.retryAfter !== null && now < state.retryAfter)
					return undefined;
				const task = refreshModel(model).finally(() => inflight.delete(model));
				// refreshModel handles its own errors, but its failure bookkeeping can still
				// reject (locked/closed DB): never leave an unhandled rejection behind.
				task.catch(() => {});
				inflight.set(model, task);
				return task;
			}

			/**
			 * Wait for a model's first ranking. Sending the first prompt through an arbitrary
			 * provider and switching after the ranking arrives would pay that provider's
			 * cache-write charge twice. Fails open: a failed or slow refresh releases the
			 * request unmodified instead of hanging it.
			 */
			async function awaitRanking(
				state: RoutingState,
				now: number,
			): Promise<RoutingState> {
				if (state.routing) return state;
				const task = ensureFresh(state, now, true);
				if (!task) return routes.get(state.model) ?? state;
				// 0 means "do not wait": the refresh still runs in the background, but this
				// request goes out immediately.
				if (options.rankingWaitMs <= 0) return routes.get(state.model) ?? state;
				await waitForTask(task, options.rankingWaitMs);
				return routes.get(state.model) ?? state;
			}

			/**
			 * Every refresh stores blacklist reasons, but a ranking persisted before this
			 * feature shipped has none. When the debug option is on, a ranking without
			 * reasons is treated as incomplete for debug purposes: one bounded re-rank makes
			 * the output meaningful instead of printing "?" for every provider. Fails open:
			 * a failed or slow refresh keeps the stored ranking and the "?" fallback.
			 */
			async function awaitBlacklistReasons(
				state: RoutingState,
				now: number,
			): Promise<RoutingState> {
				if (
					!options.debugBlacklistReasons ||
					!state.routing ||
					state.blacklistReasons
				)
					return state;
				const task = ensureFresh(state, now, true);
				if (!task) return state;
				if (options.rankingWaitMs > 0)
					await waitForTask(task, options.rankingWaitMs);
				return routes.get(state.model) ?? state;
			}

			/**
			 * Whether a ranking gives the request path anything to inject: a blacklist to
			 * enforce, or (with injectSort on) a price sort backed by at least one survivor.
			 * With zero survivors there is no known-good route, so sort is never injected -
			 * it would steer OpenRouter straight to the providers the filters excluded.
			 */
			function hasInjection(routing: RoutingSnapshot): boolean {
				if (routing.blacklist.length > 0) return true;
				return options.injectSort && routing.survivors.length > 0;
			}

			/** Route one model for debug output: only evaluated when debug is enabled. */
			function logRouting(
				model: string,
				state: RoutingState | undefined,
			): void {
				if (!options.debug) return;
				const routing = state?.routing;
				if (!routing) {
					debug(`routing ${model}: no ranking yet, passing through`);
					return;
				}
				if (routing.survivors.length === 0) {
					debug(
						`routing ${model}: no endpoint passed the filters, passing through unrouted`,
					);
					return;
				}
				if (routing.blacklist.length === 0) {
					if (options.injectSort) {
						debug(
							`routing ${model} (${routing.mode ?? "cheapest"}): nothing to block, injecting sort: "price"`,
						);
					} else {
						debug(`routing ${model}: nothing to block, passing through`);
					}
					return;
				}
				const allowed = new Set(routing.survivors);
				const details = state?.details as ProviderRank[] | undefined;
				const selected = details
					? details
							.filter((entry) => entry && allowed.has(entry.slug))
							.map((entry) => {
								const price = `$${Number(entry.perRequest ?? 0).toFixed(6)}`;
								// A rescued provider stands although it failed the filters: say so.
								if (!entry.rescued) return `${entry.slug} (${price})`;
								const failed = entry.failedReasons ?? [];
								return failed.length > 0
									? `${entry.slug} (${price}, rescued: failed ${failed.join(", ")})`
									: `${entry.slug} (${price}, rescued)`;
							})
					: routing.survivors;
				debug(
					`routing ${model} (${routing.mode ?? "cheapest"}): keeping ${selected.length} = [${selected.join(", ")}]`,
					`blocking ${routing.blacklist.length}`,
				);
				// Per-provider block reasons, only with debugBlacklistReasons. Providers whose
				// full reason sets are identical are grouped, one group per line so a repeated
				// cause reads once; a slug without recorded reasons is called out explicitly.
				if (options.debugBlacklistReasons) {
					const reasons = state?.blacklistReasons;
					const groups = new Map<string, { list: string[]; slugs: string[] }>();
					for (const slug of routing.blacklist) {
						const list = reasons?.[slug];
						const sorted = list && list.length > 0 ? [...list].sort() : [];
						const key = sorted.join("+");
						const group = groups.get(key);
						if (group) group.slugs.push(slug);
						else groups.set(key, { list: sorted, slugs: [slug] });
					}
					debug(`  providers blocked for ${model}:`);
					for (const group of groups.values()) {
						const reasonsText =
							group.list.length > 0 ? group.list.join(" + ") : "unknown";
						debug(`    ${reasonsText}: ${group.slugs.join(", ")}`);
					}
				}
			}

			/** The full routing pass for one request; throws bubble to the hook guard below. */
			async function routeRequest(evt: HttpEventLike): Promise<void> {
				const request = evt.request;
				if (!request) return;
				const url = request.url ?? "";
				const providerID = evt.model?.providerID;
				if (request.method !== "POST") return;
				// Only OpenRouter traffic is ours to route. A provider explicitly configured as
				// something else (ollama, codex subscriptions, ...) is left untouched even if
				// its URL happens to contain openrouter.ai. When the provider ID is missing,
				// fall back to the request URL.
				const isOpenRouter =
					providerID === "openrouter" ||
					(providerID === undefined && /openrouter\.ai/.test(url));
				if (!isOpenRouter) return;

				const now = Date.now();
				const refModel =
					typeof evt.model?.modelID === "string" ? evt.model.modelID : "";

				// Fast path: the event already names the model. If its ranking has nothing to
				// inject (no blacklist, and sort injection is off or unsupported), the request
				// body is never read, parsed or rebuilt. With injectSort on, an empty blacklist
				// still needs the provider block: composeRouting injects sort: "price".
				let state: RoutingState | undefined;
				if (refModel) {
					state = stateFor(refModel, now);
					// Start (or join) the refresh before reading the body. If the body turns out
					// to be non-JSON, routing cannot run for this request, but the ranking for
					// later requests must still be built instead of being skipped forever.
					ensureFresh(state, now);
					if (state.routing && !hasInjection(state.routing)) {
						if (options.debugBlacklistReasons && !state.blacklistReasons) {
							state = await awaitBlacklistReasons(state, now);
						}
						logRouting(refModel, state);
						if (state.routing?.survivors.length === 0) {
							notifyRoutingFailure(evt, "no endpoint passed the filters");
						}
						return;
					}
					// No ranking yet: read the body first. It may name a variant with its own
					// ranking, and it decides which model actually needs to be ranked.
				}

				// The body is a one-shot stream. Inspect a clone so an untouched request keeps
				// its original body; only a real routing change needs a replacement Request.
				let raw: string;
				try {
					raw = await request.clone().text();
				} catch (error) {
					warn(
						"request body unreadable:",
						error instanceof Error ? error.message : error,
					);
					notifyRoutingFailure(evt, "request body unreadable", error);
					return;
				}

				let body: unknown;
				let model = "";
				try {
					body = JSON.parse(raw) as { model?: unknown };
					model =
						typeof (body as { model?: unknown }).model === "string"
							? ((body as { model?: string }).model ?? "")
							: "";
				} catch (error) {
					// A non-JSON body cannot carry routing. Leave the original request untouched,
					// but say so once: at default log levels a silent skip looks exactly like a
					// plugin that is not installed. The refresh already started above.
					const message =
						error instanceof Error ? error.message : String(error);
					if (!bodyFormatWarned) {
						bodyFormatWarned = true;
						warn("request body is not JSON, routing skipped:", message);
					} else {
						debug("request body is not JSON, routing skipped:", message);
					}
					notifyRoutingFailure(evt, "request body is not JSON", error);
					return;
				}

				if (typeof body !== "object" || body === null || !model.includes("/")) {
					notifyRoutingFailure(evt, "invalid request body");
					return;
				}

				if (model !== refModel) {
					state = stateFor(model, now);
					if (state.routing) ensureFresh(state, now);
					else state = await awaitRanking(state, now);
				} else if (state && !state.routing) {
					// The event ref had no ranking and the body names the same model: wait for the
					// first ranking before sending, so the session keeps one provider's cache and
					// does not pay the cache-write charge twice after a provider switch.
					state = await awaitRanking(state, now);
				}
				if (
					state?.routing &&
					options.debugBlacklistReasons &&
					!state.blacklistReasons
				) {
					state = await awaitBlacklistReasons(state, now);
				}
				const routing = state?.routing;
				if (!routing) {
					logRouting(model, state);
					notifyRoutingFailure(evt, "no ranking available");
					return;
				}
				if (routing.survivors.length === 0) {
					logRouting(model, state);
					notifyRoutingFailure(evt, "no endpoint passed the filters");
					return;
				}
				if (!hasInjection(routing)) {
					logRouting(model, state);
					return;
				}

				logRouting(model, state);
				const mutated = body as Record<string, unknown>;
				// Zero survivors means no known-good route: apply only the user's extraIgnore
				// (it is explicit) and never inject sort, matching the ranking contract.
				mutated.provider = composeRouting(
					mutated.provider,
					routing.blacklist,
					routing.survivors.length > 0
						? options
						: { ...options, injectSort: false },
				);

				const finalBody = JSON.stringify(mutated);
				const headers = new Headers(request.headers);
				headers.delete("content-length");
				try {
					evt.request = new Request(request.url, {
						method: request.method,
						headers,
						body: finalBody,
						signal: request.signal,
					});
				} catch (error) {
					warn(
						"request rebuild failed:",
						error instanceof Error ? error.message : error,
					);
					return;
				}
			}

			await ctx.session.hook("http.request", async (event) => {
				const evt = event as unknown as HttpEventLike;
				// Any hook error is caught and the request continues unmodified: a DB hiccup
				// (SQLITE_BUSY, closed DB) must never fail a user request. First-sight waits are
				// bounded by rankingWaitMs and fail open on their own.
				try {
					await routeRequest(evt);
				} catch (error) {
					warn(
						"routing skipped, request passes through:",
						error instanceof Error ? error.message : error,
					);
					notifyRoutingFailure(evt, "routing error", error);
				}
			});

			return async () => {
				controller.abort();
				const pending = [...inflight.values()];
				inflight.clear();
				// Wait for in-flight refreshes so their failure bookkeeping never races the
				// DB close below (aborted refreshes are not recorded as failures).
				await Promise.allSettled(pending);
				routes.clear();
				db.close();
			};
		},
	});
}
