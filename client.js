/**
 * Browser half of the market watching plugin.
 *
 * Two surfaces share one watchlist, which lives on the host side:
 *
 *   - `sidebar.footer.action` renders the quote card that polls `/api/market.ticker`.
 *   - `settings.section` renders the editor that reads and writes `/api/market.settings`,
 *     and `/api/market.resolve` validates a code the operator typed before it joins the
 *     watchlist.
 *
 * Every colour comes from a `--dsw-alias-*` token so the card follows the active theme,
 * and every upstream call is same-origin: the browser never talks to East Money or
 * Gate.io, only to the host route that does.
 */

window.__ModuleLoader__.load({
  id: 'dsh-market-watching',
  factory: (require) => {
    var exports = {}
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    const h = React.createElement

    /** Host routes; `index.js` owns the matching registrations. */
    const TICKER_ENDPOINT = '/api/market.ticker'
    const SETTINGS_ENDPOINT = '/api/market.settings'
    const RESOLVE_ENDPOINT = '/api/market.resolve'

    /** Slot ids, spelled exactly as the UI packages declare them. */
    const SIDEBAR_SLOT = 'sidebar.footer.action'
    const SETTINGS_SLOT = 'settings.section'
    const SETTINGS_ICON_SLOT = 'settings.section.icon'

    const CARD_ID = 'market-watching'
    const SETTINGS_ID = 'market-watching-settings'
    const STYLE_ID = 'dsh-market-watching-style'

    /** Locale namespace this plugin owns; `apply` registers the dictionaries below. */
    const LOCALE_NAMESPACE = 'marketTicker'

    /**
     * Copy for every surface.
     *
     * DSH ships two languages and resolves an unregistered tag through its
     * declared fallback chain, so Chinese readers get `zh` even from a `zh-Hant`
     * host language pack, and every other language lands on `en`. That is the
     * split this plugin follows instead of sniffing `navigator.language`.
     */
    const MESSAGES = {
      zh: {
        'market.crypto': '加密货币',
        'market.cryptoHint': '如 BTC、ETH、SOL',
        'market.stock': '股票',
        'market.stockHint': '填写股票代码',
        'market.fx': '外汇',
        'market.fxHint': '如 EURUSD、USDCNH、XAUUSD',
        'badge.crypto': '币',
        'badge.stock': '股',
        'badge.fx': '汇',
        'card.title': '行情',
        'card.loading': '载入中',
        'card.refresh': '刷新行情',
        'card.expand': '展开行情',
        'card.collapse': '收起行情',
        'card.empty': '尚未选择标的，去设置里添加',
        'side.long': '买入',
        'side.short': '做空',
        'side.longTag': '多',
        'side.shortTag': '空',
        'side.hintEmpty': '填写成本价后可用：买入看涨、做空看跌',
        'side.hintLong': '当前买入：涨了才盈利，点一下改成做空',
        'side.hintShort': '当前做空：跌了才盈利，点一下改成买入',
        'tip.change': '24 小时涨跌幅',
        'tip.cost': '{side}成本 {price}',
        'tip.changeValue': '24 小时 {percent}',
        'tip.qty': '数量 {qty}',
        'tip.pnl': '浮动盈亏 {amount}',
        'page.title': '行情卡片',
        'page.subtitle': '侧边栏底部显示的价格、涨跌幅与盈亏。标的、顺序与刷新间隔都在这里决定，改动立即生效。',
        'page.loading': '正在读取自选列表…',
        'page.failed': '读取自选列表失败，请重开设置页。',
        'page.footer': '数据来自东方财富与 Gate.io 的公开接口，无需账号与密钥；网络不通时卡片保留上一次报价并淡化显示。',
        'panel.master': '总开关',
        'panel.masterHint': '关闭后侧边栏不再显示卡片，也不再请求行情',
        'panel.add': '添加标的',
        'panel.selected': '已选 {count} 个',
        'panel.selectedHint': '成本价置空时默认显示 24 小时涨幅',
        'panel.display': '显示',
        'list.empty': '列表为空，卡片会显示提示文字。',
        'field.enabled': '启用行情卡片',
        'field.price': '成本价',
        'field.priceAria': '{name} 成本价',
        'field.qty': '数量',
        'field.qtyTitle': '持有数量，最低 {min}',
        'field.qtyAria': '{name} 持有数量',
        'field.schedule': '刷新间隔',
        'field.scheduleHint': '宿主会缓存几秒，密集刷新不会打穿上游',
        'field.scheme': '涨跌配色',
        'field.schemeHint': 'A 股习惯红涨绿跌，美股习惯相反',
        'field.showNames': '显示名称',
        'field.showNamesHint': '关闭后只显示代码，一行更紧凑',
        'scheme.redUp': '红涨绿跌',
        'scheme.greenUp': '绿涨红跌',
        'state.on': '当前开启',
        'state.off': '当前关闭',
        'state.namesOn': '当前显示名称',
        'state.namesOff': '当前只显示代码',
        'action.turnOn': '点击开启',
        'action.turnOff': '点击关闭',
        'action.querying': '查询中…',
        'action.add': '添加',
        'action.confirm': '确定',
        'action.commit': '保存这一行的成本价与数量',
        'action.moveUp': '上移',
        'action.moveDown': '下移',
        'action.remove': '移除',
        'note.added': '已添加 {name}',
        'note.duplicate': '{name} 已在列表中',
        'note.costCleared': '已清除 {name} 的成本',
        'note.costSaved': '已记录 {name} 的{side}成本',
        'note.unchanged': '{name} 没有改动',
        'note.saved': '已保存 {name}：{held}',
        'note.removed': '已移除 {name}',
        'held.cost': '成本',
        'error.save': '保存失败',
        'error.saveDetail': '保存失败：{detail}',
        'error.query': '查询失败：{detail}',
        'error.limit': '最多 24 个标的',
        'error.notFound': '没有找到这个标的',
        'error.price': '成本价要是大于 0 的数字',
        'error.qty': '数量最低 {min}',
        'error.badJson': '请求体格式不对，刷新页面再试一次。',
        'error.writeFailed': '设置没写进磁盘，检查 DSH_HOME 的写入权限。',
        'error.unknownCode': '认不出这个代码，换成 600519 / hk00700 / AAPL / USTEC / EURUSD / XAUUSD / BTC 试试。',
        'error.noQuote': '上游这会儿没有这个标的的报价。',
        'hint.setPriceFirst': '先在输入框填成本价，再点确定，然后就能切换买入/做空',
      },
      en: {
        'market.crypto': 'Crypto',
        'market.cryptoHint': 'e.g. BTC, ETH, SOL',
        'market.stock': 'Stocks',
        'market.stockHint': 'Enter a ticker symbol',
        'market.fx': 'FX',
        'market.fxHint': 'e.g. EURUSD, USDCNH, XAUUSD',
        'badge.crypto': 'C',
        'badge.stock': 'S',
        'badge.fx': 'F',
        'card.title': 'Market',
        'card.loading': 'Loading',
        'card.refresh': 'Refresh quotes',
        'card.expand': 'Expand',
        'card.collapse': 'Collapse',
        'card.empty': 'No symbols yet — add them in Settings',
        'side.long': 'long',
        'side.short': 'short',
        'side.longTag': 'L',
        'side.shortTag': 'S',
        'side.hintEmpty': 'Set a cost first: long profits from a rise, short from a fall',
        'side.hintLong': 'Long: profits when price rises. Click to go short.',
        'side.hintShort': 'Short: profits when price falls. Click to go long.',
        'tip.change': '24h change',
        'tip.cost': '{side} at {price}',
        'tip.changeValue': '24h {percent}',
        'tip.qty': 'size {qty}',
        'tip.pnl': 'unrealized {amount}',
        'page.title': 'Market card',
        'page.subtitle': 'Price, change and P&L at the bottom of the sidebar. Symbols, order and refresh rate are all decided here, and every change applies at once.',
        'page.loading': 'Reading the watchlist…',
        'page.failed': 'Could not read the watchlist. Reopen Settings.',
        'page.footer': 'Quotes come from the public East Money and Gate.io endpoints — no account, no API key. When a network call fails the card keeps the last quote and fades it.',
        'panel.master': 'Master switch',
        'panel.masterHint': 'When off the sidebar card disappears and no quotes are fetched',
        'panel.add': 'Add a symbol',
        'panel.selected': '{count} selected',
        'panel.selectedHint': 'With no cost set, the 24h change is shown instead',
        'panel.display': 'Display',
        'list.empty': 'The list is empty, so the card shows a hint instead.',
        'field.enabled': 'Enable the quote card',
        'field.price': 'Cost',
        'field.priceAria': '{name} cost',
        'field.qty': 'Size',
        'field.qtyTitle': 'Holding size, minimum {min}',
        'field.qtyAria': '{name} holding size',
        'field.schedule': 'Refresh interval',
        'field.scheduleHint': 'The host caches for a few seconds, so quick refreshes never hammer upstreams',
        'field.scheme': 'Up/down colours',
        'field.schemeHint': 'Chinese markets paint gains red; US markets do the opposite',
        'field.showNames': 'Show names',
        'field.showNamesHint': 'Turn off to keep only the code on one tighter line',
        'scheme.redUp': 'Red up',
        'scheme.greenUp': 'Green up',
        'state.on': 'On',
        'state.off': 'Off',
        'state.namesOn': 'Names are shown',
        'state.namesOff': 'Codes only',
        'action.turnOn': 'Click to turn on',
        'action.turnOff': 'Click to turn off',
        'action.querying': 'Looking up…',
        'action.add': 'Add',
        'action.confirm': 'Save',
        'action.commit': 'Save this row’s cost and size',
        'action.moveUp': 'Move up',
        'action.moveDown': 'Move down',
        'action.remove': 'Remove',
        'note.added': 'Added {name}',
        'note.duplicate': '{name} is already on the list',
        'note.costCleared': 'Cleared the cost for {name}',
        'note.costSaved': 'Recorded the {side} cost for {name}',
        'note.unchanged': '{name} is unchanged',
        'note.saved': 'Saved {name}: {held}',
        'note.removed': 'Removed {name}',
        'held.cost': 'cost',
        'error.save': 'Could not save',
        'error.saveDetail': 'Could not save: {detail}',
        'error.query': 'Lookup failed: {detail}',
        'error.limit': 'Up to 24 symbols',
        'error.notFound': 'No symbol matches that',
        'error.price': 'The cost must be a number above 0',
        'error.qty': 'The size must be at least {min}',
        'error.badJson': 'That request did not look like JSON. Reload the page and try again.',
        'error.writeFailed': 'The settings file could not be written. Check write access to DSH_HOME.',
        'error.unknownCode': 'Unrecognised code. Try 600519 / hk00700 / AAPL / USTEC / EURUSD / XAUUSD / BTC.',
        'error.noQuote': 'The upstream has no quote for this symbol right now.',
        'hint.setPriceFirst': 'Type a cost and press Save first, then the long/short switch works',
      },
    }

    /** Bound host translator, installed by `apply` once the locale service exists. */
    let translate = null

    /** Locale service, kept so a language switch re-renders without a reload. */
    let localeService = null

    /**
     * Fill `{name}` slots. Duplicated from the host service so the pre-mount
     * fallback path and the bound path render identically.
     * @param template - dictionary entry.
     * @param params - substitution values.
     * @returns the rendered string.
     */
    function interpolate(template, params) {
      const text = String(template)
      if (params === undefined || params === null) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /**
     * Translate one key.
     * @param key - dictionary key.
     * @param params - optional `{name}` substitutions.
     * @returns the active language's copy, or the key itself when untranslated.
     */
    function t(key, params) {
      if (translate !== null) return translate(key, params)
      const tag = String(globalThis.navigator?.language ?? 'en').toLowerCase()
      const table = tag.startsWith('zh') ? MESSAGES.zh : MESSAGES.en
      return interpolate(table[key] ?? key, params)
    }

    /**
     * Subscribe the calling component to language switches.
     * The bound translator reads the live locale on every call, so a re-render is
     * all it takes to repaint in the new language.
     */
    function useLocaleRevision() {
      const service = localeService
      const [revision, setRevision] = useState(() => (service === null ? 0 : service.getLocale().revision))
      useEffect(() => {
        if (service === null) return undefined
        const sync = () => setRevision(service.getLocale().revision)
        sync()
        return service.subscribe(sync)
      }, [service])
      return revision
    }

    /**
     * Keys for the coded errors the host returns, so a failed save reads in the
     * shell's language instead of falling back to the host's Chinese message.
     */
    const HOST_ERRORS = {
      badJson: 'error.badJson',
      writeFailed: 'error.writeFailed',
      unknownCode: 'error.unknownCode',
      noQuote: 'error.noQuote',
    }

    /**
     * Turn a host error payload into copy.
     * @param body - parsed response body.
     * @param fallbackKey - key used when the host sent neither a known code nor a message.
     * @returns the line to show in the settings note.
     */
    function hostMessage(body, fallbackKey) {
      const mapped = typeof body?.code === 'string' ? HOST_ERRORS[body.code] : undefined
      if (mapped !== undefined) return t(mapped)
      if (typeof body?.message === 'string' && body.message !== '') return body.message
      return t(fallbackKey)
    }

    /** Markets the editor offers, in display order. */
    const MARKETS = [
      { kind: 'crypto', labelKey: 'market.crypto', hintKey: 'market.cryptoHint', placeholder: 'BTC' },
      { kind: 'stock', labelKey: 'market.stock', hintKey: 'market.stockHint', placeholder: '600519' },
      { kind: 'fx', labelKey: 'market.fx', hintKey: 'market.fxHint', placeholder: 'EURUSD' },
    ]

    /** One-tap instruments per market, so a fresh editor is usable without typing. */
    const SHORTCUTS = {
      crypto: ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE'],
      stock: ['600519', '000001', 'hk00700', 'AAPL', 'NVDA', 'USTEC', '100.NDX100', 'US30', '100.HSI'],
      fx: ['EURUSD', 'USDJPY', 'USDCNH', 'XAUUSD', 'XAGUSD'],
    }

    /** Poll cadence choices offered in Settings. */
    const SCHEDULES = [5, 10, 15, 30, 60]

    /** Badge text per market, shown next to every watchlist row. */
    const BADGES = { crypto: 'badge.crypto', stock: 'badge.stock', fx: 'badge.fx' }

    /** Must match `MIN_QTY` in index.js: the smallest holding size the host will store. */
    const MIN_QTY = 0.001

    /**
     * Resolve a same-origin route to a path the browser can fetch.
     * The host serves the Web UI from `/`, so a plain relative fetch would resolve
     * against the current route instead of the server root.
     * @param path - route path beginning with `/`.
     * @returns the absolute path component.
     */
    function apiUrl(path) {
      try {
        return new URL(String(path).replace(/^\/+/, ''), document.baseURI).pathname
      } catch {
        return path
      }
    }

    /* ---------------------------------------------------------------------- *
     * formatting
     * ---------------------------------------------------------------------- */

    /**
     * Drop trailing zeros so `1.2300` reads as `1.23` without losing `1.0000`.
     * @param text - fixed-point number.
     * @returns the trimmed number.
     */
    function trimZeros(text) {
      return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
    }

    /**
     * Group the integer half of a fixed-point string with thousands separators.
     * @param text - fixed-point number, optionally signed.
     * @returns the grouped number.
     */
    function group(text) {
      const negative = text.startsWith('-')
      const body = negative ? text.slice(1) : text
      const dot = body.indexOf('.')
      const whole = dot === -1 ? body : body.slice(0, dot)
      const rest = dot === -1 ? '' : body.slice(dot)
      return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${rest}`
    }

    /**
     * Render a price at a precision that suits its market: coins need significant
     * digits, FX needs five, equities need two.
     * @param value - price, or null when the upstream had no answer.
     * @param kind - the instrument's market.
     * @returns the display string.
     */
    function formatPrice(value, kind) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      const abs = Math.abs(value)
      if (kind === 'crypto') {
        if (abs >= 1000) return group(value.toFixed(2))
        if (abs >= 1) return group(trimZeros(value.toFixed(4)))
        if (abs >= 0.01) return group(trimZeros(value.toFixed(6)))
        if (abs === 0) return '0'
        // Sub-cent coins: keep four significant digits instead of a wall of zeros.
        const digits = Math.max(0, Math.min(12, 3 - Math.floor(Math.log10(abs))))
        return group(trimZeros(value.toFixed(digits)))
      }
      // Metals quote in the thousands and read best with cents, like an equity.
      if (kind === 'fx') {
        if (abs >= 1000) return group(value.toFixed(2))
        return abs >= 20 ? group(value.toFixed(3)) : group(value.toFixed(5))
      }
      return group(value.toFixed(2))
    }

    /**
     * Render a signed percentage with its sign always visible.
     * @param value - percentage, or null.
     * @returns the display string.
     */
    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      const sign = value > 0 ? '+' : ''
      return `${sign}${value.toFixed(2)}%`
    }

    /**
     * Classify a change so CSS can colour it, honouring the configured convention.
     * @param value - change percentage, or null.
     * @param scheme - `red-up` (mainland) or `green-up`.
     * @returns `up`, `down` or `flat`.
     */
    function trendOf(value, scheme) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 'flat'
      const rising = value > 0
      const redUp = scheme !== 'green-up'
      return rising === redUp ? 'up' : 'down'
    }

    /**
     * Render a signed cash amount in the quote's own currency.
     * @param value - amount, or null.
     * @param kind - the instrument's market, for decimal places.
     * @returns the display string.
     */
    function formatAmount(value, kind) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      const sign = value > 0 ? '+' : value < 0 ? '-' : ''
      return `${sign}${formatPrice(Math.abs(value), kind)}`
    }

    /**
     * Pick the percentage the row's last column shows. A stored cost basis wins over the
     * 24h move; without one the card behaves exactly as before.
     * @param item - one row of the ticker payload.
     * @returns `{ value, pnl }` where `pnl` is null when no basis was set.
     */
    function percentCell(item) {
      const raw = item?.pnlPercent
      const pnl = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
      if (pnl !== null) return { value: pnl, pnl }
      const change = item?.changePercent
      return { value: typeof change === 'number' && Number.isFinite(change) ? change : null, pnl: null }
    }

    /**
     * `14:03:22` in the operator's locale, or an empty string before the first poll.
     * @param at - epoch milliseconds.
     * @returns the clock label.
     */
    function formatClock(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const date = new Date(at)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /* ---------------------------------------------------------------------- *
     * styles
     * ---------------------------------------------------------------------- */

    const CSS = `
.dmt-root { flex: 1 0 100%; order: -990; min-width: 0; }

.dmt-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 4px 0 6px;
  padding: 7px 9px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.05));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}

.dmt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
  font-size: 11px;
  letter-spacing: 0.02em;
}

.dmt-mark {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #30a46c);
  flex: none;
}

.dmt-mark[data-stale="1"] {
  background: var(--dsw-alias-state-warn-primary, #f5a524);
}

.dmt-mark[data-loading="1"] {
  background: var(--dsw-alias-state-idle-primary, rgba(128, 128, 128, 0.6));
  animation: dmt-pulse 1.4s ease-in-out infinite;
}

@keyframes dmt-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.dmt-title { font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.dmt-clock { margin-left: auto; font-variant-numeric: tabular-nums; }

.dmt-refresh {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  line-height: 1;
  border-radius: 4px;
}

.dmt-refresh:hover { color: var(--dsw-alias-label-primary, inherit); }
.dmt-refresh[data-busy="1"] { opacity: 0.45; cursor: default; }

.dmt-rows { display: flex; flex-direction: column; gap: 3px; }

.dmt-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: baseline;
  gap: 7px;
}

.dmt-label { min-width: 0; display: flex; align-items: baseline; gap: 4px; }

.dmt-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, inherit);
}

.dmt-code {
  flex: none;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.85));
  letter-spacing: 0.02em;
}

.dmt-price { flex: none; font-weight: 600; letter-spacing: -0.01em; }

.dmt-chg {
  flex: none;
  min-width: 54px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  text-align: right;
  font-weight: 600;
  font-size: 11px;
}

/* Position amount, shown only when both a cost basis and a quantity are set. */
.dmt-amt { font-size: 10px; font-weight: 600; opacity: 0.9; }

.dmt-chg[data-trend="up"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dmt-chg[data-trend="down"] { color: var(--dsw-alias-state-success-primary, #30a46c); }
.dmt-chg[data-trend="flat"] { color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9)); }

.dmt-row[data-stale="1"] .dmt-price,
.dmt-row[data-stale="1"] .dmt-chg { opacity: 0.55; }

.dmt-empty {
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
  font-size: 11px;
  padding: 2px 0 1px;
}

.dmt-fold {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0 2px;
  font-size: 10px;
  line-height: 1;
  border-radius: 4px;
}

.dmt-fold:hover { color: var(--dsw-alias-label-primary, inherit); }

/* Minimised: the card keeps its title and the fold button, nothing else. */
.dmt-card[data-collapsed="1"] { gap: 0; padding: 5px 8px; }
.dmt-card[data-collapsed="1"] .dmt-mark,
.dmt-card[data-collapsed="1"] .dmt-clock,
.dmt-card[data-collapsed="1"] .dmt-refresh,
.dmt-card[data-collapsed="1"] .dmt-rows { display: none; }
/* With the clock gone, the fold button takes over the push to the right edge. */
.dmt-card[data-collapsed="1"] .dmt-fold { margin-left: auto; }

/* Collapsed sidebar: the card narrows to one column of bare numbers. */
.dmt-card[data-narrow="1"] { padding: 6px 4px; align-items: center; gap: 4px; }
.dmt-card[data-narrow="1"] .dmt-head { width: 100%; justify-content: center; }
.dmt-card[data-narrow="1"] .dmt-title,
.dmt-card[data-narrow="1"] .dmt-clock { display: none; }
.dmt-card[data-narrow="1"] .dmt-refresh { display: none; }
.dmt-card[data-narrow="1"] .dmt-fold { display: none; }
.dmt-card[data-narrow="1"] .dmt-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.dmt-card[data-narrow="1"] .dmt-name,
.dmt-card[data-narrow="1"] .dmt-code { display: none; }
.dmt-card[data-narrow="1"] .dmt-price { font-size: 11px; font-weight: 600; }
.dmt-card[data-narrow="1"] .dmt-chg { min-width: 0; text-align: center; font-size: 10px; }
.dmt-card[data-narrow="1"] .dmt-amt { display: none; }
/* The rail has no fold button and is already one column, so a stored fold must not
   leave it showing nothing at all. */
.dmt-card[data-narrow="1"][data-collapsed="1"] .dmt-mark { display: inline-block; }
.dmt-card[data-narrow="1"][data-collapsed="1"] .dmt-rows {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* ---------- settings page ---------- */

.dmt-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px 24px;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
}

.dmt-page-title { font-size: 15px; font-weight: 650; margin: 0; }
.dmt-page-sub { color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95)); font-size: 12px; margin: 4px 0 0; }

.dmt-panel {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.04));
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dmt-panel-head { display: flex; align-items: baseline; gap: 8px; }
.dmt-panel-title { font-size: 13px; font-weight: 600; }
.dmt-panel-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95)); }

.dmt-tabs { display: flex; gap: 4px; flex-wrap: wrap; }

.dmt-tab {
  appearance: none;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
}

.dmt-tab:hover { background: var(--dsw-alias-button-floating-hover, rgba(128, 128, 128, 0.12)); }

.dmt-tab[data-active="1"] {
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.16));
  border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
}

.dmt-add { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }

.dmt-input {
  flex: 1 1 180px;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, transparent);
  color: inherit;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.dmt-input:focus { border-color: var(--dsw-alias-brand-primary, #4d7cfe); }

.dmt-btn {
  appearance: none;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.14));
  color: var(--dsw-alias-label-primary, inherit);
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
}

.dmt-btn:hover:not(:disabled) { background: var(--dsw-alias-button-floating-hover, rgba(128, 128, 128, 0.22)); }
.dmt-btn:disabled { opacity: 0.45; cursor: default; }

.dmt-btn[data-tone="primary"] {
  background: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: transparent;
  color: #fff;
}

.dmt-chips { display: flex; flex-wrap: wrap; gap: 6px; }

.dmt-chip {
  appearance: none;
  cursor: pointer;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.32));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  padding: 3px 9px;
  font-size: 11px;
  font-family: inherit;
}

.dmt-chip:hover { border-style: solid; color: var(--dsw-alias-label-primary, inherit); }

.dmt-list { display: flex; flex-direction: column; gap: 6px; }

.dmt-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
  padding: 6px 9px;
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.1));
}

.dmt-badge {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  background: var(--dsw-alias-bg-base, rgba(128, 128, 128, 0.18));
  color: var(--dsw-alias-label-secondary, inherit);
}

.dmt-item-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmt-item-code { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95)); }
.dmt-item-main { min-width: 140px; flex: 1; display: flex; flex-direction: column; gap: 1px; }

/* Cost basis and size: a side toggle plus two boxes, one group per instrument. */
.dmt-cost { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 4px; flex: none; }

.dmt-side {
  appearance: none;
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.28));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 11px;
  line-height: 1.3;
}

.dmt-side[data-side="long"] { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: currentColor; }
.dmt-side[data-side="short"] { color: var(--dsw-alias-state-success-primary, #30a46c); border-color: currentColor; }
/* No basis stored yet: neither side is real, so neither gets a colour. */
.dmt-side[data-on="0"] {
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95));
  border-color: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.28));
}

.dmt-cost-input {
  width: 88px;
  box-sizing: border-box;
  padding: 3px 7px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.28));
  background: var(--dsw-alias-bg-base, transparent);
  color: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.dmt-cost-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4b8bf5); }
.dmt-cost-input::placeholder { color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9)); }

.dmt-qty-input { width: 76px; }

/* Per-row commit: the only thing that writes a cost basis or a size. */
.dmt-ok-btn {
  appearance: none;
  cursor: pointer;
  flex: none;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-brand-primary, #4b8bf5);
  background: transparent;
  color: var(--dsw-alias-brand-primary, #4b8bf5);
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
}

.dmt-ok-btn:hover:not(:disabled) { background: var(--dsw-alias-button-floating-hover, rgba(128, 128, 128, 0.18)); }
.dmt-ok-btn:disabled { opacity: 0.35; cursor: default; }

.dmt-item-actions { display: flex; gap: 2px; flex: none; }

.dmt-icon-btn {
  appearance: none;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95));
  border-radius: 6px;
  width: 24px;
  height: 24px;
  font-size: 13px;
  line-height: 1;
}

.dmt-icon-btn:hover:not(:disabled) {
  background: var(--dsw-alias-button-floating-hover, rgba(128, 128, 128, 0.18));
  color: var(--dsw-alias-label-primary, inherit);
}

.dmt-icon-btn:disabled { opacity: 0.25; cursor: default; }
.dmt-icon-btn[data-tone="danger"]:hover { color: var(--dsw-alias-state-error-primary, #e5484d); }

.dmt-note { font-size: 11px; }
.dmt-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dmt-note[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #30a46c); }
.dmt-note[data-tone="muted"] { color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95)); }

.dmt-choice { display: flex; gap: 6px; flex-wrap: wrap; }

.dmt-row-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.dmt-field-label { font-size: 12px; font-weight: 600; }
.dmt-field-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.95)); }

.dmt-toggle {
  appearance: none;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  border-radius: 999px;
  width: 40px;
  height: 22px;
  padding: 2px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.16));
  display: flex;
  align-items: center;
  transition: background 120ms ease;
}

.dmt-toggle::after {
  content: "";
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
  transition: transform 140ms ease, background 140ms ease;
}

.dmt-toggle[data-on="1"] { background: var(--dsw-alias-brand-primary, #4d7cfe); border-color: transparent; }
.dmt-toggle[data-on="1"]::after { transform: translateX(18px); background: #fff; }
`

    /** Inject the stylesheet once per document. */
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ---------------------------------------------------------------------- *
     * transport
     * ---------------------------------------------------------------------- */

    /**
     * Read one JSON route.
     * @param path - host route.
     * @param init - fetch init, for POST bodies.
     * @returns the parsed body regardless of status, so callers can read `message`.
     */
    async function requestJson(path, init) {
      const response = await fetch(apiUrl(path), {
        ...init,
        headers: { accept: 'application/json', ...(init && init.headers ? init.headers : {}) },
      })
      try {
        return await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
    }

    /* ---------------------------------------------------------------------- *
     * sidebar card
     * ---------------------------------------------------------------------- */

    /**
     * The quote card. Polls the host route on the interval the host reports, keeps
     * the previous table on screen while a refresh is in flight, and dims rows the
     * upstream failed to answer instead of dropping them.
     * @param props - the slot passes `wide`; false means the sidebar is collapsed.
     */
    const FOLD_KEY = 'dsh-market-watching.collapsed'

    /** Read the persisted fold state; storage may be unavailable in a sandboxed frame. */
    function readFold() {
      try {
        return window.localStorage.getItem(FOLD_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeFold(value) {
      try {
        window.localStorage.setItem(FOLD_KEY, value ? '1' : '0')
      } catch {
        // The preference is a nicety; losing it must not break the card.
      }
    }

    function MarketCard(props) {
      const wide = props.wide !== false
      const [payload, setPayload] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [collapsed, setCollapsed] = useState(readFold)
      const aliveRef = useRef(true)
      const timerRef = useRef(0)
      const busyRef = useRef(false)
      const containerRef = useRef(null)
      // The host owns the poll interval; mirroring it through a ref keeps `load`
      // stable so a re-render never re-arms the timer chain.
      const scheduleRef = useRef(15)
      // Mirrors the host's master switch so the poll chain can be slowed without
      // re-arming it on every render.
      const enabledRef = useRef(true)

      // Repaint when the host language changes; the copy below is read through `t`.
      useLocaleRevision()

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          window.clearTimeout(timerRef.current)
        }
      }, [])

      /** Load one snapshot; `force` skips the host cache when the operator asked. */
      const load = useCallback(async (force) => {
        if (busyRef.current) return
        busyRef.current = true
        window.clearTimeout(timerRef.current)
        if (aliveRef.current) setPhase((current) => (current === 'ready' ? 'refreshing' : 'loading'))
        try {
          const body = await requestJson(force === true ? `${TICKER_ENDPOINT}?refresh=1` : TICKER_ENDPOINT)
          if (!aliveRef.current) return
          if (body && body.ok === false) {
            setPhase('error')
          } else {
            if (typeof body?.schedule === 'number') scheduleRef.current = body.schedule
            enabledRef.current = body?.enabled !== false
            setPayload(body)
            setPhase('ready')
          }
        } catch {
          if (aliveRef.current) setPhase('error')
        } finally {
          busyRef.current = false
          if (!aliveRef.current) return
          // Switched off, the host answers without touching any upstream, so the card
          // keeps a slow heartbeat purely to notice being switched back on.
          const delay = enabledRef.current ? scheduleRef.current : 30
          timerRef.current = window.setTimeout(() => { void load(false) }, delay * 1000)
        }
      }, [])

      useEffect(() => {
        void load(false)
        return () => window.clearTimeout(timerRef.current)
      }, [load])

      const toggleFold = useCallback(() => {
        setCollapsed((current) => {
          writeFold(!current)
          return !current
        })
      }, [])

      useEffect(() => {
        ensureStyle()
        // The slot renders inside a nowrap flex row; without this the card cannot
        // take a full line of its own and squeezes beside the footer buttons.
        let node = containerRef.current
        while (node !== null && node !== undefined) {
          const style = window.getComputedStyle(node)
          if (style.display === 'flex' || style.display === 'inline-flex') {
            node.style.flexWrap = 'wrap'
            break
          }
          node = node.parentElement
        }
      }, [])

      // The host's master switch removes the card entirely; the slot keeps polling on a
      // slow beat so flipping it back on brings the card back without a reload.
      if (payload !== null && payload.enabled === false) return null

      const items = Array.isArray(payload?.items) ? payload.items : []
      const scheme = payload?.colorScheme
      const showNames = payload?.showNames !== false
      const stale = phase === 'error' || payload?.degraded === true

      return h(
        'div',
        { className: 'dmt-root', ref: containerRef },
        h(
          'div',
          { className: 'dmt-card', 'data-narrow': wide ? '0' : '1', 'data-collapsed': collapsed ? '1' : '0' },
          h(
            'div',
            { className: 'dmt-head' },
            h('span', {
              className: 'dmt-mark',
              'data-stale': stale ? '1' : '0',
              'data-loading': phase === 'loading' || phase === 'refreshing' ? '1' : '0',
            }),
            h('span', { className: 'dmt-title' }, t('card.title')),
            h('span', { className: 'dmt-clock' }, phase === 'loading' ? t('card.loading') : formatClock(payload?.updatedAt)),
            h(
              'button',
              {
                type: 'button',
                className: 'dmt-refresh',
                'data-busy': phase === 'refreshing' ? '1' : '0',
                title: t('card.refresh'),
                onClick: () => { void load(true) },
              },
              '⟳',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dmt-fold',
                'data-collapsed': collapsed ? '1' : '0',
                title: collapsed ? t('card.expand') : t('card.collapse'),
                'aria-label': collapsed ? t('card.expand') : t('card.collapse'),
                'aria-expanded': collapsed ? 'false' : 'true',
                onClick: toggleFold,
              },
              collapsed ? '▸' : '▾',
            ),
          ),
          h(
            'div',
            { className: 'dmt-rows' },
            items.length === 0
              ? h('div', { className: 'dmt-empty' }, t('card.empty'))
              : items.map((item) => {
                const cell = percentCell(item)
                const basis = item.entry ?? null
                const amount = typeof item.pnlAmount === 'number' && Number.isFinite(item.pnlAmount) ? item.pnlAmount : null
                const side = basis === null ? null : (basis.side === 'short' ? t('side.short') : t('side.long'))
                const parts = [
                  basis === null
                    ? `${item.name} · ${t('tip.change')}`
                    : `${item.name} · ${t('tip.cost', { side, price: formatPrice(basis.price, item.kind) })} · ${t('tip.changeValue', { percent: formatPercent(item.changePercent) })}`,
                ]
                if (typeof item.qty === 'number' && Number.isFinite(item.qty)) parts.push(t('tip.qty', { qty: item.qty }))
                if (amount !== null) parts.push(t('tip.pnl', { amount: formatAmount(amount, item.kind) }))
                const hint = parts.join(' · ')
                return h(
                  'div',
                  { key: item.id, className: 'dmt-row', 'data-stale': item.stale ? '1' : '0' },
                  h(
                    'span',
                    { className: 'dmt-label', title: `${item.name} ${item.code}` },
                    showNames && wide ? h('span', { className: 'dmt-name' }, item.name) : null,
                    h('span', { className: 'dmt-code' }, item.code),
                  ),
                  h('span', { className: 'dmt-price' }, formatPrice(item.price, item.kind)),
                  h(
                    'span',
                    {
                      className: 'dmt-chg',
                      'data-pnl': cell.pnl === null ? '0' : '1',
                      'data-trend': trendOf(cell.value, scheme),
                      title: hint,
                    },
                    h('span', { className: 'dmt-pct' }, formatPercent(cell.value)),
                    // The amount only exists when both a cost basis and a size are set.
                    amount === null ? null : h('span', { className: 'dmt-amt' }, formatAmount(amount, item.kind)),
                  ),
                )
              }),
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------------- *
     * settings page
     * ---------------------------------------------------------------------- */

    /**
     * Reorder the watchlist immutably.
     * @param list - current items.
     * @param from - index to move.
     * @param to - destination index.
     * @returns a new array, or the original when the move is out of range.
     */
    function move(list, from, to) {
      if (to < 0 || to >= list.length || from === to) return list
      const next = list.slice()
      const [entry] = next.splice(from, 1)
      next.splice(to, 0, entry)
      return next
    }

    /**
     * The watchlist editor. Every mutation is written straight through to the host,
     * so the card reflects an edit without a save step.
     */
    function SettingsPage() {
      const [settings, setSettings] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [market, setMarket] = useState('crypto')
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const aliveRef = useRef(true)
      /** Row containers, so the row button can read both boxes without making them controlled. */
      const rowRefs = useRef(new Map())

      // Repaint when the host language changes; every string below goes through `t`.
      useLocaleRevision()

      useEffect(() => {
        ensureStyle()
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      useEffect(() => {
        let cancelled = false
        requestJson(SETTINGS_ENDPOINT)
          .then((body) => {
            if (cancelled) return
            setSettings(body.settings)
            setPhase('ready')
          })
          .catch(() => { if (!cancelled) setPhase('error') })
        return () => { cancelled = true }
      }, [])

      /**
       * Persist a whole settings object and adopt what the host echoed back.
       * @param next - the settings to write.
       * @param message - optional confirmation line.
       */
      const persist = useCallback(async (next, message) => {
        setBusy(true)
        try {
          const body = await requestJson(SETTINGS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          })
          if (!aliveRef.current) return
          if (body.ok !== true) {
            setNote({ tone: 'error', text: hostMessage(body, 'error.save') })
            return
          }
          setSettings(body.settings)
          setNote(message === undefined ? null : { tone: 'ok', text: message })
        } catch (error) {
          if (aliveRef.current) setNote({ tone: 'error', text: t('error.saveDetail', { detail: String(error.message ?? error) }) })
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [])

      /** Append an instrument, ignoring the duplicate the host would drop anyway. */
      const addItem = useCallback((item) => {
        if (settings === null) return
        if (settings.items.some((entry) => entry.id === item.id)) {
          setNote({ tone: 'muted', text: t('note.duplicate', { name: item.name }) })
          return
        }
        if (settings.items.length >= 24) {
          setNote({ tone: 'error', text: t('error.limit') })
          return
        }
        void persist({ ...settings, items: [...settings.items, item] }, t('note.added', { name: item.name }))
      }, [persist, settings])

      /** Resolve whatever the operator typed, then add the instrument it names. */
      const submit = useCallback(async () => {
        const text = query.trim()
        if (text === '') return
        setBusy(true)
        setNote(null)
        try {
          const body = await requestJson(RESOLVE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: text, kind: market }),
          })
          if (!aliveRef.current) return
          if (body.ok !== true || body.item === undefined) {
            setNote({ tone: 'error', text: hostMessage(body, 'error.notFound') })
            return
          }
          setQuery('')
          addItem(body.item)
        } catch (error) {
          if (aliveRef.current) setNote({ tone: 'error', text: t('error.query', { detail: String(error.message ?? error) }) })
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }, [addItem, market, query])

      /** Write or clear one instrument's cost basis. */
      const setEntry = useCallback((item, entry) => {
        if (settings === null) return
        const items = settings.items.map((current) => {
          if (current.id !== item.id) return current
          const next = { ...current }
          if (entry === null) delete next.entry
          else next.entry = entry
          return next
        })
        const message = entry === null
          ? t('note.costCleared', { name: item.name })
          : t('note.costSaved', { name: item.name, side: entry.side === 'short' ? t('side.short') : t('side.long') })
        void persist({ ...settings, items }, message)
      }, [persist, settings])

      /**
       * Read both boxes of one row and write them in a single request. This is what the
       * row's confirm button and the Enter key call: typing alone changes nothing, so an
       * abandoned edit can never turn into a stored position.
       * @param item - the row being edited.
       */
      const commitRow = useCallback((item) => {
        if (settings === null) return
        const row = rowRefs.current.get(item.id)
        const priceText = String(row?.querySelector('[data-field="price"]')?.value ?? '').trim()
        const qtyText = String(row?.querySelector('[data-field="qty"]')?.value ?? '').trim()

        const next = { ...item }
        if (priceText === '') {
          delete next.entry
        } else {
          const price = Number(priceText)
          if (!Number.isFinite(price) || price <= 0) {
            setNote({ tone: 'error', text: t('error.price') })
            return
          }
          next.entry = { side: item.entry?.side ?? 'long', price }
        }
        if (qtyText === '') {
          delete next.qty
        } else {
          const qty = Number(qtyText)
          if (!Number.isFinite(qty) || qty < MIN_QTY) {
            setNote({ tone: 'error', text: t('error.qty', { min: MIN_QTY }) })
            return
          }
          next.qty = qty
        }

        if (next.entry?.price === item.entry?.price && next.entry?.side === item.entry?.side && next.qty === item.qty) {
          setNote({ tone: 'muted', text: t('note.unchanged', { name: item.name }) })
          return
        }
        const items = settings.items.map((current) => (current.id === item.id ? next : current))
        const held = next.entry === undefined
          ? t('held.cost')
          : `${next.entry.side === 'short' ? t('side.short') : t('side.long')} ${next.entry.price}`
        void persist({ ...settings, items }, t('note.saved', { name: item.name, held: `${held}${next.qty === undefined ? '' : ` × ${next.qty}`}` }))
      }, [persist, settings])

      /** Flip long/short on an existing basis; without one there is nothing to flip. */
      const flipSide = useCallback((item) => {
        if (item.entry === undefined) {
          setNote({ tone: 'muted', text: t('hint.setPriceFirst') })
          return
        }
        setEntry(item, {
          side: item.entry.side === 'short' ? 'long' : 'short',
          price: item.entry.price,
        })
      }, [setEntry])

      if (phase === 'loading') {
        return h('div', { className: 'dmt-page' }, h('p', { className: 'dmt-page-sub' }, t('page.loading')))
      }
      if (phase === 'error' || settings === null) {
        return h('div', { className: 'dmt-page' }, h('p', { className: 'dmt-page-sub' }, t('page.failed')))
      }

      const active = MARKETS.find((entry) => entry.kind === market) ?? MARKETS[0]

      return h(
        'div',
        { className: 'dmt-page' },
        h(
          'div',
          null,
          h('h2', { className: 'dmt-page-title' }, t('page.title')),
          h('p', { className: 'dmt-page-sub' }, t('page.subtitle')),
        ),

        h(
          'div',
          { className: 'dmt-panel' },
          h(
            'div',
            { className: 'dmt-panel-head' },
            h('span', { className: 'dmt-panel-title' }, t('panel.master')),
            h('span', { className: 'dmt-panel-hint' }, t('panel.masterHint')),
          ),
          h(
            'div',
            { className: 'dmt-row-line' },
            h(
              'span',
              null,
              h('div', { className: 'dmt-field-label' }, t('field.enabled')),
              h('div', { className: 'dmt-field-hint' }, settings.enabled ? t('state.on') : t('state.off')),
            ),
            h('button', {
              type: 'button',
              className: 'dmt-toggle',
              'data-on': settings.enabled ? '1' : '0',
              title: settings.enabled ? t('action.turnOff') : t('action.turnOn'),
              disabled: busy,
              onClick: () => { void persist({ ...settings, enabled: !settings.enabled }) },
            }),
          ),
        ),

        h(
          'div',
          { className: 'dmt-panel' },
          h(
            'div',
            { className: 'dmt-panel-head' },
            h('span', { className: 'dmt-panel-title' }, t('panel.add')),
            h('span', { className: 'dmt-panel-hint' }, t(active.hintKey)),
          ),
          h(
            'div',
            { className: 'dmt-tabs' },
            MARKETS.map((entry) => h(
              'button',
              {
                key: entry.kind,
                type: 'button',
                className: 'dmt-tab',
                'data-active': entry.kind === market ? '1' : '0',
                onClick: () => { setMarket(entry.kind); setNote(null) },
              },
              t(entry.labelKey),
            )),
          ),
          h(
            'div',
            { className: 'dmt-add' },
            h('input', {
              className: 'dmt-input',
              value: query,
              placeholder: active.placeholder,
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              },
            }),
            h(
              'button',
              { type: 'button', className: 'dmt-btn dmt-btn-primary', 'data-tone': 'primary', disabled: busy, onClick: () => { void submit() } },
              busy ? t('action.querying') : t('action.add'),
            ),
          ),
          h(
            'div',
            { className: 'dmt-chips' },
            (SHORTCUTS[market] ?? []).map((code) => h(
              'button',
              {
                key: code,
                type: 'button',
                className: 'dmt-chip',
                disabled: busy,
                onClick: () => { setQuery(code) },
              },
              code,
            )),
          ),
          note === null ? null : h('div', { className: 'dmt-note', 'data-tone': note.tone }, note.text),
        ),

        h(
          'div',
          { className: 'dmt-panel' },
          h(
            'div',
            { className: 'dmt-panel-head' },
            h('span', { className: 'dmt-panel-title' }, t('panel.selected', { count: settings.items.length })),
            h('span', { className: 'dmt-panel-hint' }, t('panel.selectedHint')),
          ),
          settings.items.length === 0
            ? h('div', { className: 'dmt-note', 'data-tone': 'muted' }, t('list.empty'))
            : h(
              'div',
              { className: 'dmt-list' },
              settings.items.map((item, index) => h(
                'div',
                {
                  key: item.id,
                  className: 'dmt-item',
                  // Kept in a ref map rather than a callback per row: hooks cannot be
                  // called inside the map, and the row button needs to read both boxes.
                  ref: (node) => {
                    if (node === null) rowRefs.current.delete(item.id)
                    else rowRefs.current.set(item.id, node)
                  },
                },
                h('span', { className: 'dmt-badge' }, t(BADGES[item.kind] ?? '?')),
                h(
                  'span',
                  { className: 'dmt-item-main' },
                  h('span', { className: 'dmt-item-name' }, item.name),
                  h('span', { className: 'dmt-item-code' }, item.code),
                ),
                h(
                  'span',
                  { className: 'dmt-cost' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dmt-side',
                      'data-side': item.entry?.side ?? 'long',
                      'data-on': item.entry === undefined ? '0' : '1',
                      title: item.entry === undefined
                        ? t('side.hintEmpty')
                        : (item.entry.side === 'short' ? t('side.hintShort') : t('side.hintLong')),
                      disabled: busy,
                      onClick: () => { flipSide(item) },
                    },
                    item.entry?.side === 'short' ? t('side.shortTag') : t('side.longTag'),
                  ),
                  h('input', {
                    className: 'dmt-cost-input',
                    type: 'number',
                    inputMode: 'decimal',
                    min: '0',
                    step: 'any',
                    'data-field': 'price',
                    defaultValue: item.entry === undefined ? '' : String(item.entry.price),
                    placeholder: t('field.price'),
                    'aria-label': t('field.priceAria', { name: item.name }),
                    disabled: busy,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRow(item)
                      }
                    },
                  }),
                  h('input', {
                    className: 'dmt-cost-input dmt-qty-input',
                    type: 'number',
                    inputMode: 'decimal',
                    min: String(MIN_QTY),
                    step: 'any',
                    'data-field': 'qty',
                    defaultValue: item.qty === undefined ? '' : String(item.qty),
                    placeholder: t('field.qty'),
                    title: t('field.qtyTitle', { min: MIN_QTY }),
                    'aria-label': t('field.qtyAria', { name: item.name }),
                    disabled: busy,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitRow(item)
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dmt-ok-btn',
                      title: t('action.commit'),
                      disabled: busy,
                      onClick: () => { commitRow(item) },
                    },
                    t('action.confirm'),
                  ),
                ),
                h(
                  'span',
                  { className: 'dmt-item-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dmt-icon-btn',
                      title: t('action.moveUp'),
                      disabled: busy || index === 0,
                      onClick: () => { void persist({ ...settings, items: move(settings.items, index, index - 1) }) },
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dmt-icon-btn',
                      title: t('action.moveDown'),
                      disabled: busy || index === settings.items.length - 1,
                      onClick: () => { void persist({ ...settings, items: move(settings.items, index, index + 1) }) },
                    },
                    '↓',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dmt-icon-btn',
                      'data-tone': 'danger',
                      title: t('action.remove'),
                      disabled: busy,
                      onClick: () => {
                        void persist(
                          { ...settings, items: settings.items.filter((entry) => entry.id !== item.id) },
                          t('note.removed', { name: item.name }),
                        )
                      },
                    },
                    '×',
                  ),
                ),
              )),
            ),
        ),

        h(
          'div',
          { className: 'dmt-panel' },
          h('div', { className: 'dmt-panel-head' }, h('span', { className: 'dmt-panel-title' }, t('panel.display'))),
          h(
            'div',
            { className: 'dmt-row-line' },
            h(
              'span',
              null,
              h('div', { className: 'dmt-field-label' }, t('field.schedule')),
              h('div', { className: 'dmt-field-hint' }, t('field.scheduleHint')),
            ),
            h(
              'div',
              { className: 'dmt-choice' },
              SCHEDULES.map((seconds) => h(
                'button',
                {
                  key: seconds,
                  type: 'button',
                  className: 'dmt-tab',
                  'data-active': settings.schedule === seconds ? '1' : '0',
                  disabled: busy,
                  onClick: () => { void persist({ ...settings, schedule: seconds }) },
                },
                `${seconds}s`,
              )),
            ),
          ),
          h(
            'div',
            { className: 'dmt-row-line' },
            h(
              'span',
              null,
              h('div', { className: 'dmt-field-label' }, t('field.scheme')),
              h('div', { className: 'dmt-field-hint' }, t('field.schemeHint')),
            ),
            h(
              'div',
              { className: 'dmt-choice' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dmt-tab',
                  'data-active': settings.colorScheme !== 'green-up' ? '1' : '0',
                  disabled: busy,
                  onClick: () => { void persist({ ...settings, colorScheme: 'red-up' }) },
                },
                t('scheme.redUp'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dmt-tab',
                  'data-active': settings.colorScheme === 'green-up' ? '1' : '0',
                  disabled: busy,
                  onClick: () => { void persist({ ...settings, colorScheme: 'green-up' }) },
                },
                t('scheme.greenUp'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dmt-row-line' },
            h(
              'span',
              null,
              h('div', { className: 'dmt-field-label' }, t('field.showNames')),
              h('div', { className: 'dmt-field-hint' }, t('field.showNamesHint')),
            ),
            h('button', {
              type: 'button',
              className: 'dmt-toggle',
              'data-on': settings.showNames ? '1' : '0',
              title: settings.showNames ? t('state.namesOn') : t('state.namesOff'),
              disabled: busy,
              onClick: () => { void persist({ ...settings, showNames: !settings.showNames }) },
            }),
          ),
        ),

        h('p', { className: 'dmt-page-sub' }, t('page.footer')),
      )
    }

    /** Navigation glyph: a rising line inside a frame. */
    function MarketIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2 13h12' }),
        h('path', { d: 'M3 10.5 6.2 7.2l2.3 2.1L13 4.5' }),
        h('path', { d: 'M9.8 4.5H13v3.1' }),
      )
    }

    /**
     * Register the dictionaries, then both surfaces. `slots` and `locale` are the two
     * services these components need, so they are the only ones injected — injecting
     * an absent service would park the fiber.
     */
    function apply(ctx) {
      ensureStyle()

      ctx.effect(() => {
        try {
          return ctx.locale.register(LOCALE_NAMESPACE, MESSAGES)
        } catch (error) {
          // A hot-reloaded plugin registers the same namespace twice; the first table
          // is still bound and correct, so this must not tear the fiber down.
          console.warn('[market-watching] locale table already registered', error)
          return undefined
        }
      })
      translate = ctx.locale.bind(LOCALE_NAMESPACE)
      localeService = ctx.locale

      ctx.slots.inject(SIDEBAR_SLOT, () => ctx.slots.register(
        { name: SIDEBAR_SLOT, id: CARD_ID, order: -991 },
        MarketCard,
      ))

      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register(
        { name: SETTINGS_SLOT, id: SETTINGS_ID, order: 63, label: () => t('page.title') },
        SettingsPage,
      ))

      ctx.slots.inject(SETTINGS_ICON_SLOT, () => ctx.slots.register(
        { name: SETTINGS_ICON_SLOT, id: SETTINGS_ID },
        MarketIcon,
      ))
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.percentCell = percentCell
    exports.formatPrice = formatPrice
    exports.formatAmount = formatAmount
    return exports
  },
})
