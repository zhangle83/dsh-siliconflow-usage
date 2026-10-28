/**
 * Host half of dsh-siliconflow-usage.
 *
 * Registers two local JSON routes:
 *   GET /api/siliconflow-pricing  current model price, band and countdown
 *   GET /api/siliconflow-usage    one session's SiliconFlow token usage and
 *                                 estimated CNY cost, priced at each message's
 *                                 time-of-day band
 *
 * The API key is read from the credentials service per request and never
 * leaves this process; the client only receives derived numbers and statuses.
 */

import { loadPricing, priceAtModel, summarizeModels } from './lib/pricing.js';
import { aggregateEvents, roundCost } from './lib/usage.js';

const DEFAULT_PROVIDER = 'siliconflow';
const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_KEY_REF = 'SILICONFLOW_API_KEY';

export const inject = ['webServer', 'credentials', 'sessions', 'sessionQuery', 'agentDefaultModel'];

let keyCache = { at: 0, key: '', value: null };

function settings() {
  return {
    providerId: DEFAULT_PROVIDER,
    baseURL: (process.env.SILICONFLOW_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKeyRef: DEFAULT_KEY_REF,
    pricingURL: 'https://www.siliconflow.cn/pricing',
    priceCacheMs: 6 * 3_600_000,
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function keyStatus(ctx, cfg) {
  let resolved;
  try {
    resolved = await ctx.credentials.resolve(cfg.apiKeyRef);
  } catch {
    resolved = undefined;
  }
  if (!resolved || !resolved.value) return { configured: false, status: 'missing' };
  const now = Date.now();
  if (keyCache.value && keyCache.key === resolved.value && now - keyCache.at < 60_000) return keyCache.value;

  let status = 'unknown';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${cfg.baseURL}/models?sub_type=chat`, {
        headers: { authorization: `Bearer ${resolved.value}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) status = 'ok';
      else if (response.status === 401 || response.status === 403) status = 'invalid';
      else status = 'unknown';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    status = 'unknown';
  }
  const value = { configured: true, status };
  keyCache = { at: now, key: resolved.value, value };
  return value;
}

function selectionOf(ctx) {
  try {
    const selection = ctx.agentDefaultModel.currentSelection();
    return { provider: String(selection?.provider || ''), model: String(selection?.model || '') };
  } catch {
    return { provider: '', model: '' };
  }
}

async function readEvents(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  if (live) return live.ownEvents();
  const snapshot = await ctx.sessionQuery.readSession(sessionId);
  return snapshot.events;
}

export function apply(ctx) {
  const cfg = settings();

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/siliconflow-pricing',
      handler: async (req, res) => {
        try {
          const selection = selectionOf(ctx);
          if (selection.provider !== cfg.providerId) {
            return json(res, 200, {
              ok: true,
              supported: false,
              provider: selection.provider,
              model: selection.model,
              reason: 'provider-mismatch',
            });
          }
          const pricing = await loadPricing(cfg);
          const now = Date.now();
          const entry = pricing.models[selection.model];
          const price = entry ? priceAtModel(entry, now) : null;
          const key = await keyStatus(ctx, cfg);
          return json(res, 200, {
            ok: true,
            supported: true,
            provider: selection.provider,
            model: selection.model,
            currency: 'CNY',
            source: pricing.source,
            asOf: pricing.asOf,
            error: pricing.error,
            key,
            current: price
              ? {
                  input: price.input,
                  output: price.output,
                  cache: price.cache,
                  label: price.label,
                  windows: price.windows,
                  tiered: price.tiered,
                  tierLabel: price.tierLabel,
                  nextChangeAt: price.nextChangeAt,
                }
              : null,
            models: summarizeModels(pricing.models, now),
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
    'dsh-siliconflow-usage: pricing route',
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/siliconflow-usage',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const sessionId = url.searchParams.get('sessionId') || '';
          const selection = selectionOf(ctx);
          if (selection.provider !== cfg.providerId) {
            return json(res, 200, {
              ok: true,
              supported: false,
              provider: selection.provider,
              model: selection.model,
              reason: 'provider-mismatch',
            });
          }
          if (!sessionId) {
            return json(res, 400, { ok: false, error: 'missing-session' });
          }

          let events;
          try {
            events = await readEvents(ctx, sessionId);
          } catch {
            return json(res, 404, { ok: false, error: 'session-not-found' });
          }

          const pricing = await loadPricing(cfg);
          const now = Date.now();
          const totals = aggregateEvents(events, selection.provider, pricing.models);
          const entry = pricing.models[selection.model];
          const price = entry ? priceAtModel(entry, now) : null;
          const key = await keyStatus(ctx, cfg);

          return json(res, 200, {
            ok: true,
            supported: true,
            provider: selection.provider,
            model: selection.model,
            currency: 'CNY',
            source: pricing.source,
            asOf: pricing.asOf,
            error: pricing.error,
            key,
            usage: {
              requests: totals.requests,
              unpricedRequests: totals.unpricedRequests,
              inputTokens: totals.inputTokens,
              cacheReadTokens: totals.cacheReadTokens,
              cacheWriteTokens: totals.cacheWriteTokens,
              outputTokens: totals.outputTokens,
              reasoningTokens: totals.reasoningTokens,
              costCNY: roundCost(totals.costCNY, 6),
              models: totals.models,
            },
            current: price
              ? {
                  input: price.input,
                  output: price.output,
                  cache: price.cache,
                  label: price.label,
                  windows: price.windows,
                  tiered: price.tiered,
                  nextChangeAt: price.nextChangeAt,
                }
              : null,
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String((error && error.message) || error) });
        }
      },
    }),
    'dsh-siliconflow-usage: usage route',
  );
}
