/**
 * Client half of dsh-siliconflow-usage.
 *
 * Two surfaces, both fed by the Host's local JSON routes:
 *   sidebar.footer.action   current model unit prices + billing-window countdown
 *   conversation.input.dock this session's token totals and estimated cost
 *
 * The module is loaded through window.__ModuleLoader__; React comes from the
 * browser module table, and every visible string goes through the locale service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-siliconflow-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-siliconflow-usage';
    const PRICING_PATH = '/api/siliconflow-pricing';
    const USAGE_PATH = '/api/siliconflow-usage';
    const PRICING_POLL_MS = 30_000;
    const USAGE_POLL_MS = 15_000;

    const ZH = {
      metaTitle: 'SiliconFlow 用量',
      metaDescription: '在侧边栏显示当前 SiliconFlow 模型的单价与谷时倒计时，并在输入框上方显示本会话的 token 用量与估算花费。',
      input: '输入',
      output: '输出',
      cache: '缓存',
      session: '本会话',
      estimate: '估算',
      calls: '次调用',
      noUsage: '暂无用量',
      loading: '读取中…',
      valley: '谷时',
      standard: '标准价',
      remaining: '剩',
      snapshot: '价格快照',
      keyMissing: '未配置 API Key',
      keyInvalid: 'API Key 无效',
      keyUnknown: '密钥状态未知',
      free: '免费',
      unpriced: '部分调用未定价',
      notSiliconFlow: '当前不是 SiliconFlow 路由',
      refresh: '点击刷新',
      perMillion: '元 / 百万 tokens',
      unit: '元/M',
      priceUnavailable: '未收录该模型价格',
      tiered: '按输入长度分档，按首档估算',
      error: '读取失败',
      day: '天',
      hour: '时',
      minute: '分',
    };

    const EN = {
      metaTitle: 'SiliconFlow Usage',
      metaDescription: 'Shows the current SiliconFlow model price and off-peak countdown in the sidebar, and this session’s token usage and estimated cost above the composer.',
      input: 'in',
      output: 'out',
      cache: 'cache',
      session: 'Session',
      estimate: '~',
      calls: 'calls',
      noUsage: 'No usage yet',
      loading: 'Loading…',
      valley: 'Off-peak',
      standard: 'Standard',
      remaining: 'in',
      snapshot: 'price snapshot',
      keyMissing: 'No API key',
      keyInvalid: 'API key invalid',
      keyUnknown: 'Key status unknown',
      free: 'free',
      unpriced: 'Some calls unpriced',
      notSiliconFlow: 'Current route is not SiliconFlow',
      refresh: 'Click to refresh',
      perMillion: 'CNY / M tokens',
      unit: 'CNY/M',
      priceUnavailable: 'No price for this model',
      tiered: 'Input-length tiers; first tier estimated',
      error: 'Failed to load',
      day: 'd',
      hour: 'h',
      minute: 'm',
    };

    const FALLBACK_LOCALE = { active: 'zh', locales: [], revision: 0 };

    function useLocale(ctx) {
      const locale = ctx && ctx.locale;
      const snapshot = React.useSyncExternalStore(
        (cb) => (locale && typeof locale.subscribe === 'function' ? locale.subscribe(cb) : () => {}),
        () => (locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : FALLBACK_LOCALE),
      );
      const lang = snapshot && snapshot.active === 'en' ? 'en' : 'zh';
      const bound = locale && typeof locale.bind === 'function' ? locale.bind(NS) : null;
      const t = (key) => {
        try {
          if (bound) {
            const value = bound(key);
            if (typeof value === 'string' && value !== key) return value;
          }
        } catch {
          /* dictionary unavailable: fall back to the local table */
        }
        return (lang === 'en' ? EN : ZH)[key] || key;
      };
      return { lang, t };
    }

    function fmtMoney(value, t) {
      if (value == null) return '—';
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (n === 0) return t('free');
      if (n >= 1) return `¥${n.toFixed(2).replace(/\.00$/, '')}`;
      return `¥${String(n)}`;
    }

    function fmtTokens(value) {
      const n = Number(value) || 0;
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
      return String(n);
    }

    function fmtCost(value) {
      const n = Number(value) || 0;
      if (n <= 0) return '¥0';
      if (n < 0.001) return '<¥0.001';
      if (n < 0.1) return `¥${n.toFixed(4)}`;
      if (n < 10) return `¥${n.toFixed(3)}`;
      return `¥${n.toFixed(2)}`;
    }

    function fmtCountdown(ms, t) {
      if (!(ms > 0)) return '';
      const totalMinutes = Math.floor(ms / 60_000);
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return `${days}${t('day')} ${hours}${t('hour')}`;
      if (hours > 0) return `${hours}${t('hour')} ${minutes}${t('minute')}`;
      return `${minutes}${t('minute')}`;
    }

    function bandText(price, t) {
      if (!price || !Array.isArray(price.windows) || price.windows.length === 0) return '';
      const label = String(price.label || '');
      const valley = /2点\s*[～~-]\s*8点/.test(label) && !label.includes('/');
      return valley ? t('valley') : t('standard');
    }

    function keyColor(key) {
      if (!key || key.status === 'unknown') return 'var(--dsw-alias-state-idle-primary)';
      if (key.status === 'ok') return 'var(--dsw-alias-state-success-primary)';
      return 'var(--dsw-alias-state-error-primary)';
    }

    function useJson(path, intervalMs, lang) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [nonce, setNonce] = React.useState(0);
      const mounted = React.useRef(true);
      const sequence = React.useRef(0);

      const load = React.useCallback(async () => {
        if (!path) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const mine = ++sequence.current;
        try {
          const response = await fetch(path, { cache: 'no-store' });
          const body = await response.json();
          if (!mounted.current || mine !== sequence.current) return;
          setData(body);
          setError('');
        } catch (err) {
          if (!mounted.current || mine !== sequence.current) return;
          setError(String((err && err.message) || err));
        }
      }, [path]);

      React.useEffect(() => {
        mounted.current = true;
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          mounted.current = false;
          clearInterval(timer);
        };
      }, [load, intervalMs, nonce, lang]);

      const refresh = React.useCallback(() => setNonce((n) => n + 1), []);
      return { data, error, refresh };
    }

    // ---- sidebar footer: current model price ------------------------------
    function PriceCard(props) {
      const ctx = props.ctx;
      const wide = !!props.wide;
      const { t } = useLocale(ctx);
      const { data, error, refresh } = useJson(PRICING_PATH, PRICING_POLL_MS, '');
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 30_000);
        return () => clearInterval(timer);
      }, []);

      if (!data) {
        if (!wide) return null;
        return h('div', {
          title: error ? `${t('error')}: ${error}` : t('loading'),
          style: {
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
            borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
          },
        }, h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-idle-primary)' } }),
          `SiliconFlow · ${error ? t('error') : t('loading')}`);
      }
      if (data.ok !== true) return null;
      if (data.supported !== true) return null;

      const current = data.current;
      const dot = keyColor(data.key);
      const model = String(data.model || '');
      const shortModel = model.includes('/') ? model.split('/').slice(-1)[0] : model;
      const band = current ? bandText(current, t) : '';
      const countdown = current && current.nextChangeAt ? fmtCountdown(current.nextChangeAt - Date.now(), t) : '';
      const sourceNote = data.source === 'snapshot' ? t('snapshot') : '';

      if (!wide) {
        return h('div', {
          onClick: refresh,
          title: `${t('metaTitle')} · ${model}${band ? ` · ${band}` : ''}${countdown ? ` · ${t('remaining')} ${countdown}` : ''}`,
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
            color: dot, fontSize: 14, fontWeight: 700,
          },
        }, '¥');
      }

      return h('button', {
        type: 'button',
        onClick: refresh,
        title: error ? `${t('error')}: ${error}` : (current ? `${shortModel} · ${t('perMillion')}` : t('priceUnavailable')),
        style: {
          all: 'unset', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          gap: 3, width: '100%', minWidth: 0, padding: '6px 8px', borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', { style: { width: 6, height: 6, flex: '0 0 auto', borderRadius: '50%', background: dot } }),
          h('span', {
            style: {
              fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, `SiliconFlow · ${shortModel}`),
        ),
        current
          ? h('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
                color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
              },
            },
            h('span', null, `${t('input')} ${fmtMoney(current.input, t)}`),
            h('span', null, `${t('output')} ${fmtMoney(current.output, t)}`),
            h('span', null, `${t('cache')} ${fmtMoney(current.cache, t)}`),
            h('span', { style: { marginLeft: 'auto', opacity: 0.7 } }, t('unit')),
          )
          : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('priceUnavailable')),
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 10,
            color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
          },
        },
          band ? h('span', null, band) : null,
          countdown ? h('span', null, `· ${t('remaining')} ${countdown}`) : null,
          sourceNote ? h('span', { title: error || '' }, `· ${sourceNote}`) : null,
          current && current.tiered ? h('span', { title: t('tiered') }, '· *') : null,
        ),
      );
    }

    // ---- composer dock: this session's usage ------------------------------
    function UsageStrip(props) {
      const ctx = props.ctx;
      const sessionId = props.sessionId
        || (props.session && (props.session.id || props.session.sessionId))
        || null;
      const { t } = useLocale(ctx);
      const path = sessionId ? `${USAGE_PATH}?sessionId=${encodeURIComponent(String(sessionId))}` : null;
      const { data, error, refresh } = useJson(path, USAGE_POLL_MS, '');

      if (!path || error || !data || data.ok !== true || data.supported !== true) return null;
      const usage = data.usage;
      if (!usage || usage.requests === 0) return null;

      const band = data.current ? bandText(data.current, t) : '';
      const countdown = data.current && data.current.nextChangeAt
        ? fmtCountdown(data.current.nextChangeAt - Date.now(), t)
        : '';
      const dot = keyColor(data.key);

      return h('div', {
        onClick: refresh,
        title: `${t('metaTitle')} · ${t('refresh')}`,
        style: {
          display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
          padding: '2px 6px 4px', cursor: 'pointer', whiteSpace: 'nowrap',
          overflow: 'hidden', fontSize: 11, color: 'var(--dsw-alias-label-secondary)',
        },
      },
        h('span', { style: { width: 6, height: 6, flex: '0 0 auto', borderRadius: '50%', background: dot } }),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, t('session')),
        h('span', null, `${t('input')} ${fmtTokens(usage.inputTokens)}`),
        usage.cacheReadTokens > 0 ? h('span', null, `${t('cache')} ${fmtTokens(usage.cacheReadTokens)}`) : null,
        h('span', null, `${t('output')} ${fmtTokens(usage.outputTokens)}`),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, `${t('estimate')} ${fmtCost(usage.costCNY)}`),
        h('span', null, `${usage.requests} ${t('calls')}`),
        usage.unpricedRequests > 0 ? h('span', { title: t('unpriced') }, `· ${usage.unpricedRequests} ?`) : null,
        band ? h('span', null, `· ${band}${countdown ? ` ${countdown}` : ''}`) : null,
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-siliconflow-usage: dictionaries');
      } catch {
        try { ctx.locale.register(NS, { zh: ZH, en: EN }); } catch { /* cards fall back to local text */ }
      }
      // Match the shipped usage card: the footer row wraps so a multi-line card
      // can own its line instead of squeezing Settings and sibling actions.
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-siliconflow-usage';
          style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-siliconflow-usage: footer layout');
      }
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'siliconflow-usage', order: 90, label: 'SiliconFlow' },
        (props) => h(PriceCard, { wide: props.wide, ctx }),
      ));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'siliconflow-usage-dock', order: 40, label: 'SiliconFlow' },
        (props) => h(UsageStrip, { sessionId: props.sessionId, ctx }),
      ));
    }

    return { inject, apply };
  },
});
