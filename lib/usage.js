/**
 * Session usage aggregation for one provider.
 *
 * The session log is the source of truth: every committed assistant message
 * carries the provider-reported TokenUsage and the model that produced it.
 * Cost is estimated per message with the price in effect at that message's
 * time, so a session that crosses 02:00/08:00 is billed at both bands.
 */

import { priceAtModel } from './pricing.js';

/** CNY cost of one usage record under one resolved price, or 0 without prices. */
export function costOf(usage, price) {
  if (!usage || !price) return 0;
  const inputTokens = Math.max(0, Number(usage.inputTokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cacheReadTokens) || 0);
  const outputTokens = Math.max(0, Number(usage.outputTokens) || 0);
  const inputPrice = Number(price.input) || 0;
  const cachePrice = price.cache == null ? inputPrice : Number(price.cache) || 0;
  const outputPrice = Number(price.output) || 0;
  const billableInput = Math.max(0, inputTokens - cacheRead);
  return (billableInput * inputPrice + cacheRead * cachePrice + outputTokens * outputPrice) / 1_000_000;
}

function emptyTotals() {
  return {
    requests: 0,
    unpricedRequests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costCNY: 0,
    models: {},
  };
}

/**
 * Fold one session's events. Only assistant messages whose source provider is
 * `providerId` are counted; other routes in the same session are ignored.
 */
export function aggregateEvents(events, providerId, models) {
  const totals = emptyTotals();
  for (const event of events || []) {
    if (!event || event.type !== 'assistant/message') continue;
    const data = event.data || {};
    const message = data.message;
    const source = message && message.source;
    if (!source || source.kind !== 'model' || source.provider !== providerId) continue;
    const usage = data.usage;
    if (!usage) continue;

    const model = String(source.model || '');
    const input = Number(usage.inputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const reasoning = Number(usage.reasoningTokens) || 0;

    totals.requests += 1;
    totals.inputTokens += input;
    totals.cacheReadTokens += cacheRead;
    totals.cacheWriteTokens += cacheWrite;
    totals.outputTokens += output;
    totals.reasoningTokens += reasoning;

    const bucket = totals.models[model] || (totals.models[model] = {
      requests: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costCNY: 0,
      priced: true,
    });
    bucket.requests += 1;
    bucket.inputTokens += input;
    bucket.cacheReadTokens += cacheRead;
    bucket.outputTokens += output;

    const entry = models && models[model];
    const price = entry ? priceAtModel(entry, Number(event.time) || Date.now()) : null;
    if (!price) {
      totals.unpricedRequests += 1;
      bucket.priced = false;
      continue;
    }
    const cost = costOf(usage, price);
    totals.costCNY += cost;
    bucket.costCNY += cost;
  }
  return totals;
}

export function roundCost(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
