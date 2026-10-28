/**
 * SiliconFlow price table: one snapshot shipped with the plugin, plus a parser
 * for the public pricing page at www.siliconflow.cn/pricing.
 *
 * Prices are CNY per million tokens. A model may declare time-of-day bands
 * (deepseek-ai/DeepSeek-V4.1-Flash is cheaper 02:00–08:00 Beijing time) and/or
 * input-length tiers. Tiered models have no time bands; the first tier is used
 * as the base price and `tiered` marks the estimate as approximate.
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const PRICE_PAGE = 'https://www.siliconflow.cn/pricing';

/** Hours are Beijing time (UTC+8, no DST). */
export function shanghaiHour(ms) {
  const hours = Math.floor((ms + SHANGHAI_OFFSET_MS) / 3_600_000);
  return ((hours % 24) + 24) % 24;
}

function parseMoney(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  if (s === '－' || s === '-' || s === '—' || s === '--' || s === '−') return null;
  if (s.includes('免费')) return 0;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseWindows(label) {
  const body = String(label).replace(/费用发生时段[:：]\s*/, '');
  const windows = [];
  for (const segment of body.split('/')) {
    const m = segment.replace(/[～~]/g, '-').replace(/点/g, '').match(/(\d{1,2})\s*-\s*(\d{1,2})/);
    if (!m) continue;
    let from = Number(m[1]);
    let to = Number(m[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (to === 0) to = 24;
    if (from === to) continue;
    windows.push({ from, to });
  }
  return windows;
}

function parseTier(label) {
  const m = String(label).match(/\[([^,]+),\s*([^)]+)\)/);
  if (!m) return null;
  const toNumber = (s) => {
    const t = s.trim();
    if (/∞/.test(t)) return Infinity;
    const k = /\d\s*k$/i.test(t);
    const n = Number(t.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? (k ? n * 1024 : n) : null;
  };
  const min = toNumber(m[1]);
  const max = toNumber(m[2]);
  if (min == null || max == null) return null;
  return { min, max };
}

/**
 * Parse one pricing page into `{ [modelId]: entry }`.
 * The page renders one row per model; each price cell repeats its band label
 * (time window or input tier) next to the price.
 */
export function parsePricingHtml(html) {
  const models = {};
  if (typeof html !== 'string' || !html.length) return models;

  const pairs = /<span class="block">([^<]*)<\/span><\/span><span[^>]*>([^<]*)<\/span>/g;
  const plainPrices = /<span class="inline-flex[^>]*>([^<]*)<\/span>/g;
  const rows = html.split(/<div id="pricing-row-text-/).slice(1);

  for (const row of rows) {
    const title = row.match(/title="([^"]+)"/);
    if (!title) continue;
    const id = title[1].trim();
    if (!id) continue;

    const groups = [];
    const index = new Map();
    pairs.lastIndex = 0;
    let m;
    while ((m = pairs.exec(row))) {
      const label = m[1].trim();
      if (!index.has(label)) {
        const group = { label, prices: [] };
        index.set(label, group);
        groups.push(group);
      }
      index.get(label).prices.push(parseMoney(m[2]));
    }

    const bands = [];
    const tiers = [];
    for (const group of groups) {
      const price = {
        input: group.prices[0] ?? null,
        output: group.prices[1] ?? null,
        cache: group.prices[2] ?? null,
      };
      if (/^费用发生时段/.test(group.label)) {
        const windows = parseWindows(group.label);
        bands.push({ label: group.label, windows, ...price });
      } else if (/^输入\s*\[/.test(group.label)) {
        const tier = parseTier(group.label);
        if (tier) tiers.push({ label: group.label, ...tier, ...price });
      } else {
        bands.push({ label: group.label, windows: null, ...price });
      }
    }

    if (!bands.length && !tiers.length) {
      plainPrices.lastIndex = 0;
      const prices = [];
      let p;
      while ((p = plainPrices.exec(row))) prices.push(parseMoney(p[1]));
      if (prices.length >= 3) {
        bands.push({ label: '', windows: null, input: prices[0], output: prices[1], cache: prices[2] });
      }
    }

    if (!bands.length && !tiers.length) continue;
    models[id] = {
      id,
      currency: 'CNY',
      tiered: tiers.length > 0,
      bands,
      tiers,
    };
  }
  return models;
}

function selectBand(entry, hour) {
  const bands = Array.isArray(entry.bands) ? entry.bands : [];
  const timed = bands.filter((b) => Array.isArray(b.windows) && b.windows.length > 0);
  let selected = null;
  if (timed.length) {
    selected = timed.find((b) => b.windows.some((w) => hour >= w.from && hour < w.to)) || null;
  }
  if (!selected) selected = bands.find((b) => !b.windows || b.windows.length === 0) || null;
  if (!selected && entry.tiers && entry.tiers.length) selected = entry.tiers[0];
  return selected;
}

/**
 * The price in effect at `ms`, or null when the model has no table entry.
 * `nextChangeAt` is the next moment the effective band changes — boundaries
 * where the band stays the same (for example 00:00 inside a standard band that
 * spans 08:00–24:00 and 00:00–02:00) are skipped.
 */
export function priceAtModel(entry, ms) {
  if (!entry) return null;
  const hour = shanghaiHour(ms);
  const selected = selectBand(entry, hour);
  if (!selected) return null;
  return {
    input: selected.input ?? null,
    output: selected.output ?? null,
    cache: selected.cache ?? null,
    label: selected.label || '',
    windows: selected.windows || null,
    tiered: !!entry.tiered,
    tierLabel: entry.tiered ? selected.label || '' : null,
    nextChangeAt: nextChangeAt(entry, ms, selected),
  };
}

function boundaries(entry) {
  const hours = new Set();
  for (const band of entry.bands || []) {
    for (const window of band.windows || []) {
      hours.add(window.from);
      hours.add(window.to);
    }
  }
  return [...hours].filter((h) => h >= 0 && h <= 24);
}

export function nextChangeAt(entry, ms, currentBand) {
  const hours = boundaries(entry);
  if (!hours.length) return null;
  const current = currentBand || selectBand(entry, shanghaiHour(ms));
  if (!current || !current.windows || !current.windows.length) return null;
  const local = new Date(ms + SHANGHAI_OFFSET_MS);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const candidates = [];
  for (const h of hours) {
    for (let add = 0; add <= 1; add += 1) {
      // Date.UTC normalizes hour 24 into the next day.
      const t = Date.UTC(y, mo, d + add, h, 0, 0, 0) - SHANGHAI_OFFSET_MS;
      if (t > ms) candidates.push(t);
    }
  }
  candidates.sort((a, b) => a - b);
  for (const t of candidates) {
    const band = selectBand(entry, shanghaiHour(t));
    if (band && (band.label || '') !== (current.label || '')) return t;
  }
  return null;
}

export const SNAPSHOT_AS_OF = '2026-10-28';

/** Fallback table, collected 2026-10-28 from www.siliconflow.cn/pricing. */
export const SNAPSHOT = {
  'deepseek-ai/DeepSeek-V4.1-Flash': {
    id: 'deepseek-ai/DeepSeek-V4.1-Flash',
    currency: 'CNY',
    tiered: false,
    bands: [
      {
        label: '费用发生时段: 0点～2点/8点～24点',
        windows: [{ from: 0, to: 2 }, { from: 8, to: 24 }],
        input: 2,
        output: 8,
        cache: 0.04,
      },
      {
        label: '费用发生时段: 2点～8点',
        windows: [{ from: 2, to: 8 }],
        input: 1,
        output: 4,
        cache: 0.02,
      },
    ],
    tiers: [],
  },
  'deepseek-ai/DeepSeek-V4-Flash': {
    id: 'deepseek-ai/DeepSeek-V4-Flash',
    currency: 'CNY',
    tiered: false,
    bands: [
      {
        label: '费用发生时段: 2点～8点',
        windows: [{ from: 2, to: 8 }],
        input: 1.5,
        output: 4.5,
        cache: 0.15,
      },
      {
        label: '费用发生时段: 0点～2点/8点～24点',
        windows: [{ from: 0, to: 2 }, { from: 8, to: 24 }],
        input: 3,
        output: 9,
        cache: 0.3,
      },
    ],
    tiers: [],
  },
  'Qwen/Qwen3.8-27B': {
    id: 'Qwen/Qwen3.8-27B',
    currency: 'CNY',
    tiered: false,
    bands: [{ label: '', windows: null, input: 3, output: 12, cache: null }],
    tiers: [],
  },
};

let cache = { expiresAt: 0, value: null };

/**
 * Load the live price table (cached for `priceCacheMs`), falling back to the
 * shipped snapshot. The resolved value never throws: callers always get a table
 * plus `source`/`error` so the UI can tell live from snapshot.
 */
export async function loadPricing(cfg, options = {}) {
  const ttl = Number(cfg.priceCacheMs) > 0 ? Number(cfg.priceCacheMs) : 6 * 3_600_000;
  const now = Date.now();
  if (!options.force && cache.value && now < cache.expiresAt) return cache.value;

  const url = cfg.pricingURL || PRICE_PAGE;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let text = '';
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'dsh-siliconflow-usage/0.1 (+https://www.siliconflow.cn/pricing)', accept: 'text/html' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`pricing page HTTP ${response.status}`);
      text = await response.text();
    } finally {
      clearTimeout(timer);
    }
    const models = parsePricingHtml(text);
    if (!Object.keys(models).length) throw new Error('pricing page produced no models');
    const value = { models, source: 'live', asOf: new Date().toISOString(), error: null };
    cache = { expiresAt: now + ttl, value };
    return value;
  } catch (error) {
    const value = {
      models: SNAPSHOT,
      source: 'snapshot',
      asOf: SNAPSHOT_AS_OF,
      error: String((error && error.message) || error),
    };
    // A transient failure should not pin the snapshot for the full TTL.
    cache = { expiresAt: now + Math.min(ttl, 10 * 60_000), value };
    return value;
  }
}

/** Compact per-model view for the client: the price in effect right now. */
export function summarizeModels(models, now) {
  const out = [];
  for (const [id, entry] of Object.entries(models || {})) {
    const price = priceAtModel(entry, now);
    if (!price) continue;
    out.push({
      id,
      input: price.input,
      output: price.output,
      cache: price.cache,
      label: price.label,
      tiered: price.tiered,
      nextChangeAt: price.nextChangeAt,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
