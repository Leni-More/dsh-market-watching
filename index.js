/**
 * Host half of the market watching plugin.
 *
 * Publishes exact Fetch routes on Connection's `/api` channel so the browser half
 * can read a watchlist the operator edits in Settings:
 *
 *   GET  /api/market.ticker    quotes for every configured instrument
 *   GET  /api/market.settings  the persisted watchlist and display options
 *   POST /api/market.settings  replace them
 *   POST /api/market.resolve   turn a typed code into a canonical instrument
 *
 * Two upstreams cover the three markets, and neither needs an account or a key:
 *
 *   - East Money's push2 batch endpoint answers A-share, Hong Kong, US, index and
 *     FX symbols in a single request, so a twenty-row watchlist costs one round
 *     trip. Fields arrive pre-scaled because the request asks for `fltt=2`.
 *   - Gate.io's spot tickers serve crypto. It is the only exchange that answered
 *     from this network without a proxy — Binance, OKX, Bybit, Coinbase and
 *     CoinGecko all timed out or failed DNS — and its ticker route is public.
 *
 * Nothing here throws into the plugin tree: a failed upstream degrades to the last
 * good quote, which the browser half renders as stale instead of hiding.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { httpsGet } from './http.mjs'

/** Route the browser half polls for quotes. `client.js` carries the same constants. */
export const TICKER_PATH = '/api/market.ticker'

/** Route that reads and writes the watchlist. */
export const SETTINGS_PATH = '/api/market.settings'

/** Route that validates one operator-typed code before it joins the watchlist. */
export const RESOLVE_PATH = '/api/market.resolve'

/** Route that decides whether the post-install thank-you card is due. */
export const NOTICE_PATH = '/api/market.notice'

/** Connection owns the `/api` channel; its exact Fetch registry carries these routes. */
export const inject = ['connection']

export const name = 'market-watching'

/** Log prefix for every warning this plugin emits. */
const LOG_PREFIX = '[market-watching]'

/** Settings document under the Harness home. */
const SETTINGS_FILENAME = 'dsh-market-watching.json'

/** File name the plugin used before it was renamed; adopted once, then left alone. */
const LEGACY_SETTINGS_FILENAME = 'dsh-market-ticker.json'

/** Bumped only when the stored shape changes incompatibly. */
const SETTINGS_VERSION = 1

/**
 * Thank-you card bookkeeping.
 *
 * This lives beside the settings document rather than inside it: settings are
 * normalized on every read and write, so an unknown field would be dropped the
 * moment the operator saved the watchlist.
 */
const NOTICE_FILENAME = 'dsh-market-watching.notice.json'

/**
 * Bumped only when the stored notice shape changes incompatibly, and a record
 * from an older version is dropped: version 1 files carried a show budget and a
 * cooldown, which made a freshly reinstalled plugin inherit "already asked".
 */
const NOTICE_VERSION = 2

/**
 * The browser asks once per page load; a reload storm must not race two writes,
 * so two answers inside this window are served from memory.
 */
const NOTICE_THROTTLE_MS = 30 * 1000

/** An answer body is a single short action, never a payload. */
const NOTICE_MAX_BODY = 2048

/** Answers that mean "do not ask again", as opposed to "not now". */
const NOTICE_FINAL = new Set(['thanks', 'issue'])

/** Every answer the card can send back. */
const NOTICE_ACTIONS = new Set(['thanks', 'issue', 'later'])

/**
 * Upper bound on the watchlist. The sidebar card is the constraint, not the
 * upstreams: sixteen rows already overflow a short window.
 */
const MAX_ITEMS = 24

/**
 * Holding size bounds. The floor is the smallest unit the plugin accepts rather than
 * zero: a position of 0.0001 on a 4,000-dollar metal is not a position, it is a typo.
 */
const MIN_QTY = 0.001
/** Ceiling on the quantity box, so a fat-fingered paste cannot produce nonsense P&L. */
const MAX_QTY = 1e12

/** East Money's batch quote endpoint and the fields this plugin reads. */
const EM_ENDPOINT = 'https://push2.eastmoney.com/api/qt/ulist.np/get'

/**
 * f2 last, f3 change %, f4 change, f12 code, f13 market, f14 name,
 * f15 high, f16 low, f17 open, f18 previous close.
 */
const EM_FIELDS = 'f2,f3,f4,f12,f13,f14,f15,f16,f17,f18'

/** East Money caps a batch well above this; forty keeps the URL short. */
const EM_BATCH = 40

/** Gate.io public spot routes. */
const GATE_TICKERS = 'https://api.gateio.ws/api/v4/spot/tickers'
const GATE_PAIRS = 'https://api.gateio.ws/api/v4/spot/currency_pairs'

/**
 * Sina's global futures feed. East Money carries no spot precious metals, so
 * XAU/USD and XAG/USD — the pairs every trading terminal calls 伦敦金 and 伦敦银 —
 * come from here. The route is public; the referer is the only thing it insists on.
 */
const SINA_ENDPOINT = 'https://hq.sinajs.cn/list='
const SINA_REFERER = 'https://finance.sina.com.cn/'

/**
 * Spot metal symbols, keyed by what an operator might type.
 * @type {Map<string, {code: string, symbol: string, name: string}>}
 */
const SINA_SYMBOLS = new Map([
  ['XAUUSD', { code: 'XAUUSD', symbol: 'hf_xau', name: '伦敦金' }],
  ['XAU', { code: 'XAUUSD', symbol: 'hf_xau', name: '伦敦金' }],
  ['XAGUSD', { code: 'XAGUSD', symbol: 'hf_xag', name: '伦敦银' }],
  ['XAG', { code: 'XAGUSD', symbol: 'hf_xag', name: '伦敦银' }],
])

/**
 * Contract-style names for the instruments a trading terminal lists, mapped to the
 * East Money secid that carries the same thing.
 *
 * A terminal's `USTEC` is the CME Nasdaq-100 future, which trades nearly around the
 * clock on a Sunday-to-Friday week — that is `103.NQ00Y`, the front-month continuous
 * contract. `100.NDX100` is the cash index and only moves during the New York
 * session, so the two are not interchangeable. The cash index keeps its own aliases
 * (`NDX100`, `IXIC`, `SPX`, ...) for when the session-bound number is what you want.
 *
 * Keys are upper-case and stripped of spaces.
 * @type {Map<string, string>}
 */
const INDEX_ALIASES = new Map([
  // Futures: the 5x24 instruments a trading terminal quotes.
  ['USTEC', '103.NQ00Y'], ['US100', '103.NQ00Y'], ['NAS100', '103.NQ00Y'], ['NQ', '103.NQ00Y'],
  ['US30', '103.YM00Y'], ['DOW', '103.YM00Y'], ['YM', '103.YM00Y'],
  ['US500', '103.ES00Y'], ['SPX500', '103.ES00Y'], ['ES', '103.ES00Y'],
  // Cash indices: session-bound.
  ['NDX100', '100.NDX100'], ['NASDAQ100', '100.NDX100'],
  ['NDX', '100.NDX'], ['IXIC', '100.NDX'],
  ['SPX', '100.SPX'], ['SP500', '100.SPX'],
  ['DJI', '100.DJIA'], ['DJIA', '100.DJIA'],
  ['UK100', '100.FTSE'], ['FTSE100', '100.FTSE'], ['FTSE', '100.FTSE'],
  ['GER40', '100.GDAXI'], ['DAX40', '100.GDAXI'], ['DAX', '100.GDAXI'],
  ['JP225', '100.N225'], ['N225', '100.N225'], ['NIKKEI', '100.N225'],
  ['HK50', '100.HSI'], ['HSI', '100.HSI'], ['HSCEI', '100.HSCEI'],
  ['EU50', '100.SX5E'], ['STOXX50', '100.SX5E'],
  ['FRA40', '100.FCHI'], ['CAC40', '100.FCHI'],
  ['AUS200', '100.AS51'], ['ASX200', '100.AS51'],
  ['DXY', '100.UDI'], ['USDX', '100.UDI'],
])

/** The three markets this plugin serves. */
const KINDS = new Set(['crypto', 'stock', 'fx'])

/**
 * Currency codes that can appear on either side of a six-letter FX pair. The set
 * exists to keep `EURUSD` from being mistaken for a US listing: a six-letter
 * ticker that splits into two known currencies is a pair, everything else is a
 * symbol.
 */
const CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNH', 'CNY',
  'HKD', 'SGD', 'MXN', 'ZAR', 'TRY', 'SEK', 'NOK', 'DKK', 'PLN', 'THB',
  'KRW', 'INR', 'RUB', 'BRL',
])

/**
 * @param code - upper-case six-character code.
 * @returns true when both halves name a currency.
 */
function isCurrencyPair(code) {
  return code.length === 6 && CURRENCIES.has(code.slice(0, 3)) && CURRENCIES.has(code.slice(3))
}

/** Display defaults; every one is also a config field on the profile patch. */
const DEFAULTS = {
  /** Master switch: when false the card disappears and no upstream is polled. */
  enabled: true,
  /** Seconds between browser polls. */
  schedule: 15,
  /** How long one quote snapshot is reused before upstream is asked again. */
  cacheMs: 8000,
  /** Budget for one upstream request. */
  upstreamTimeoutMs: 7000,
  /** `red-up` is the mainland convention; `green-up` is the western one. */
  colorScheme: 'red-up',
  /** Whether the card shows the instrument name beside its code. */
  showNames: true,
}

/**
 * The watchlist a fresh install starts with: one instrument per market, so the
 * card demonstrates every code path on first mount instead of one flavour of it.
 */
const DEFAULT_ITEMS = [
  { kind: 'crypto', id: 'crypto:BTC_USDT', code: 'BTC', name: 'Bitcoin', pair: 'BTC_USDT' },
  { kind: 'stock', id: 'stock:1.600519', code: '600519', name: '贵州茅台', secid: '1.600519' },
  { kind: 'stock', id: 'stock:105.AAPL', code: 'AAPL', name: '苹果', secid: '105.AAPL' },
  { kind: 'fx', id: 'fx:119.EURUSD', code: 'EURUSD', name: '欧元兑美元', secid: '119.EURUSD' },
]

/**
 * Everything this plugin throws away on the way in is decided here, so a
 * hand-edited settings file can never turn into a bad upstream URL.
 */

/** @param value - anything parsed out of JSON. @returns a finite number, else undefined. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Coerce a numeric field that may arrive as a string (Gate answers with strings)
 * or as `-` (East Money uses that for a halted instrument).
 * @param value - raw field.
 * @returns a finite number, else undefined.
 */
function looseNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '' && value.trim() !== '-') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** @param value - raw name. @returns a trimmed name, capped for the sidebar. */
function cleanName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 40)
}

/**
 * Resolve the Harness home the same way the rest of the product does.
 * @returns absolute Harness home directory.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

/**
 * Render one JSON response, never cached by the browser or an intermediary.
 * @param payload - serializable body.
 * @param status - HTTP status code.
 * @returns the response handed back to Connection.
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/* -------------------------------------------------------------------------- *
 * instrument identity
 * -------------------------------------------------------------------------- */

/**
 * Turn one operator-typed code into candidate instruments, best first.
 *
 * The list is a hypothesis, not an answer: `000001` is both the Shanghai Composite
 * and Ping An Bank, so several candidates are produced and the caller probes them
 * against the quote endpoint to see which one really trades.
 *
 * @param raw - what the operator typed.
 * @param kind - a forced market, or undefined to let the shape decide.
 * @returns candidate instruments, most likely first; empty when nothing parses.
 */
export function candidatesFor(raw, kind) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return []
  const wanted = KINDS.has(kind) ? kind : undefined
  const out = []
  /** @param entry - candidate to keep when it survives the market filter and is new. */
  const push = (entry) => {
    if (wanted !== undefined && entry.kind !== wanted) return
    if (out.some((item) => item.id === entry.id)) return
    out.push(entry)
  }

  // Contract-style names (`USTEC`, `US30`, `XAUUSD`) are exact lookups, so they are
  // answered before any heuristic can mistake them for a ticker.
  const alias = text.toUpperCase().replace(/\s+/g, '')
  const metal = SINA_SYMBOLS.get(alias)
  if (metal !== undefined) {
    push({
      kind: 'fx',
      id: `fx:sina:${metal.symbol.toUpperCase()}`,
      code: metal.code,
      name: metal.name,
      source: 'sina',
      symbol: metal.symbol,
    })
    return out
  }
  const indexed = INDEX_ALIASES.get(alias)
  if (indexed !== undefined) {
    // The alias is kept as the display code: an operator who typed USTEC expects to
    // see USTEC on the card, not the East Money contract code behind it.
    push({ kind: 'stock', id: `stock:${indexed}`, code: alias, secid: indexed })
    return out
  }

  // A fully qualified East Money id (`1.600519`, `100.HSI`) is unambiguous and skips
  // every guess below — this is the escape hatch for a code the heuristics mis-read.
  const qualified = /^(\d{1,3})\.([A-Za-z0-9.]{1,14})$/.exec(text)
  if (qualified !== null) {
    const secid = `${qualified[1]}.${qualified[2].toUpperCase()}`
    push({ kind: 'stock', id: `stock:${secid}`, code: qualified[2].toUpperCase(), secid })
    return out
  }

  // Crypto: BTC, btc, BTC_USDT, BTCUSDT. A bare ticker only counts when the market
  // is already known: without it `AAPL` would look like a coin pair and win the race.
  const bare = text.toUpperCase().replace(/[\s-]/g, '')
  const cryptoShape = bare.includes('_') || /^[A-Z0-9]{2,10}(USDT|USDC)$/.test(bare)
  if ((wanted === 'crypto' || cryptoShape) && /^[A-Z0-9]{2,12}(_[A-Z0-9]{2,10})?$/.test(bare)) {
    const quoted = /^([A-Z0-9]{2,10})(USDT|USDC|BTC|ETH)$/.exec(bare)
    const pair = bare.includes('_') ? bare : quoted === null ? `${bare}_USDT` : `${quoted[1]}_${quoted[2]}`
    push({ kind: 'crypto', id: `crypto:${pair}`, code: pair.slice(0, pair.indexOf('_')), pair })
  }

  // Equities: sh600519, sz000001, hk00700, usAAPL, 600519, 00700, AAPL.
  // A six-letter pair such as USDCNH starts with `us` but is not a US listing, so
  // the currency test runs before the prefix is read.
  const prefix = isCurrencyPair(text.toUpperCase().replace(/\s+/g, '')) ? null : /^(sh|sz|hk|us)(.+)$/i.exec(text)
  const equity = prefix === null ? text : prefix[2]
  const market = prefix === null ? undefined : prefix[1].toLowerCase()
  const upper = equity.toUpperCase().replace(/\s+/g, '')
  if (/^\d{6}$/.test(upper)) {
    // Shanghai lists 6/9 (and the 5xx ETF block); Shenzhen lists 0/1/2/3. The prefix,
    // when the operator typed one, removes the guesswork entirely.
    const auto = '695'.includes(upper[0]) ? 1 : 0
    const order = market === 'sh' ? [1] : market === 'sz' ? [0] : [auto, 1 - auto]
    for (const marketId of order) {
      push({ kind: 'stock', id: `stock:${marketId}.${upper}`, code: upper, secid: `${marketId}.${upper}` })
    }
  } else if (/^\d{1,5}$/.test(upper)) {
    const code = upper.padStart(5, '0')
    push({ kind: 'stock', id: `stock:116.${code}`, code, secid: `116.${code}` })
  } else if (/^[A-Z][A-Z0-9.]{0,6}$/.test(upper) && !isCurrencyPair(upper)) {
    push({ kind: 'stock', id: `stock:105.${upper}`, code: upper, secid: `105.${upper}` })
  }

  // FX: six letters, market 119 for the dollar bloc and 133 for offshore CNY. A pair
  // written with an underscore is a crypto pair, so it never reaches this branch.
  const fx = text.toUpperCase().replace(/[\s/_-]/g, '')
  if (!text.includes('_') && /^[A-Z]{6}$/.test(fx)) {
    const order = fx.includes('CNH') ? [133, 119] : [119, 133]
    for (const marketId of order) {
      push({ kind: 'fx', id: `fx:${marketId}.${fx}`, code: fx, secid: `${marketId}.${fx}` })
    }
  }

  return out
}

/**
 * Validate an optional cost basis. A position is either long (bought, in profit when
 * the quote rises) or short (sold, in profit when it falls). Anything else is dropped
 * rather than guessed: a wrong sign silently flips what the card is saying.
 * @param raw - the stored watchlist entry.
 * @returns `{ side, price }`, or undefined when no usable basis was set.
 */
export function normalizeEntry(raw) {
  const entry = raw?.entry
  if (entry === null || entry === undefined || typeof entry !== 'object') return undefined
  const price = Number(entry.price)
  if (!Number.isFinite(price) || price <= 0) return undefined
  return { side: entry.side === 'short' ? 'short' : 'long', price }
}

/**
 * Percent gain or loss against a stored cost basis.
 * @param entry - `{ side, price }`, or undefined when no basis was set.
 * @param price - the latest quote, or null when no upstream answered.
 * @returns the percentage, or null when there is nothing to compare against.
 */
export function positionPnl(entry, price) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return null
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null
  const basis = Number(entry.price)
  if (!Number.isFinite(basis) || basis <= 0) return null
  const move = ((price - basis) / basis) * 100
  // Short: the position profits when the quote trades below where it was sold.
  return entry.side === 'short' ? -move : move
}

/**
 * Cash gain or loss on the held quantity, in the quote's own currency.
 * @param entry - `{ side, price }`, or undefined when no basis was set.
 * @param qty - units held, or undefined/null when the quantity was not set.
 * @param price - the latest quote, or null.
 * @returns the amount, or null when either side of the multiplication is missing.
 */
export function positionAmount(entry, qty, price) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return null
  const units = Number(qty)
  if (!Number.isFinite(units) || units < MIN_QTY) return null
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null
  const basis = Number(entry.price)
  if (!Number.isFinite(basis) || basis <= 0) return null
  const move = (price - basis) * units
  return entry.side === 'short' ? -move : move
}

/**
 * Validate an optional holding size. Anything below `MIN_QTY` is treated as unset
 * rather than clamped: silently rounding a typo up to a real position is worse.
 * @param raw - the stored watchlist entry.
 * @returns the quantity, or undefined when none was set.
 */
export function normalizeQty(raw) {
  const qty = Number(raw?.qty)
  if (!Number.isFinite(qty) || qty < MIN_QTY || qty > MAX_QTY) return undefined
  return qty
}

/**
 * Validate one stored watchlist entry and rebuild its identity from scratch.
 * @param raw - entry parsed out of the settings document.
 * @returns the normalized entry, or undefined when it cannot be trusted.
 */
export function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (!KINDS.has(raw.kind)) return undefined
  const name = cleanName(raw.name)
  const entry = normalizeEntry(raw)
  const qty = normalizeQty(raw)
  // Both are optional and independent: a cost without a size still gives a percentage,
  // a size without a cost gives nothing, so each is carried only when it validated.
  const holding = { ...(entry === undefined ? {} : { entry }), ...(qty === undefined ? {} : { qty }) }

  if (raw.kind === 'crypto') {
    const pair = typeof raw.pair === 'string' ? raw.pair.trim().toUpperCase() : ''
    if (!/^[A-Z0-9]{2,12}_[A-Z0-9]{2,10}$/.test(pair)) return undefined
    const code = pair.slice(0, pair.indexOf('_'))
    return { kind: 'crypto', id: `crypto:${pair}`, code, name: name === '' ? code : name, pair, ...holding }
  }

  // Sina-sourced rows carry a feed symbol instead of an East Money secid.
  if (raw.source === 'sina') {
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toLowerCase() : ''
    if (!/^hf_[a-z]{2,10}$/.test(symbol)) return undefined
    const known = [...SINA_SYMBOLS.values()].find((item) => item.symbol === symbol)
    const code = cleanName(raw.code).toUpperCase() || known?.code || symbol.slice(3).toUpperCase()
    return {
      kind: raw.kind,
      id: `${raw.kind}:sina:${symbol.toUpperCase()}`,
      code,
      name: name === '' ? (known?.name ?? code) : name,
      source: 'sina',
      symbol,
      ...holding,
    }
  }

  const secid = typeof raw.secid === 'string' ? raw.secid.trim() : ''
  if (!/^\d{1,3}\.[A-Za-z0-9.]{1,14}$/.test(secid)) return undefined
  const normalized = `${secid.slice(0, secid.indexOf('.'))}.${secid.slice(secid.indexOf('.') + 1).toUpperCase()}`
  // A stored code may be a contract alias (`USTEC`) rather than the secid's own tail.
  const label = cleanName(raw.code).toUpperCase()
  const code = /^[A-Z0-9.]{1,12}$/.test(label) ? label : normalized.slice(normalized.indexOf('.') + 1)
  return {
    kind: raw.kind,
    id: `${raw.kind}:${normalized}`,
    code,
    name: name === '' ? code : name,
    secid: normalized,
    ...holding,
  }
}

/**
 * Validate a whole settings document, filling defaults for anything missing.
 * @param raw - parsed document, or anything else that came over the wire.
 * @param fallback - the settings to keep when the body carries no usable list.
 * @returns a complete settings object safe to persist.
 */
export function normalizeSettings(raw, fallback) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const items = []
  const seen = new Set()
  const incoming = Array.isArray(source.items) ? source.items : []
  for (const entry of incoming) {
    const item = normalizeItem(entry)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
    if (items.length >= MAX_ITEMS) break
  }
  const schedule = Number(source.schedule)
  const colorScheme = source.colorScheme === 'green-up' ? 'green-up' : 'red-up'
  return {
    version: SETTINGS_VERSION,
    enabled: source.enabled === undefined ? DEFAULTS.enabled : source.enabled === true,
    items: items.length > 0 ? items : (fallback ?? DEFAULT_ITEMS).map((item) => ({ ...item })),
    schedule: Number.isFinite(schedule) && schedule >= 5 && schedule <= 300 ? Math.floor(schedule) : DEFAULTS.schedule,
    colorScheme,
    showNames: source.showNames === undefined ? DEFAULTS.showNames : source.showNames === true,
  }
}

/* -------------------------------------------------------------------------- *
 * settings document
 * -------------------------------------------------------------------------- */

/**
 * Read the settings document, falling back to the shipped watchlist.
 * @param path - absolute path of the document.
 * @param log - warning sink for an unreadable file.
 * @returns always a complete settings object.
 */
function readSettings(path, log) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return normalizeSettings(parsed, DEFAULT_ITEMS)
  } catch (error) {
    // A missing file is the normal first run; anything else is worth reporting.
    if (error.code !== 'ENOENT') log.warn(`${LOG_PREFIX} ignoring ${path}: ${String(error.message ?? error)}`)
    return normalizeSettings({}, DEFAULT_ITEMS)
  }
}

/**
 * Persist the settings document atomically, so a crash mid-write cannot leave a
 * half-written watchlist behind.
 * @param path - absolute path of the document.
 * @param settings - already-normalized settings.
 * @param log - warning sink for a failed write.
 * @returns true when the document reached disk.
 */
function writeSettings(path, settings, log) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const staged = `${path}.tmp`
    writeFileSync(staged, `${JSON.stringify(settings, null, 2)}\n`)
    renameSync(staged, path)
    return true
  } catch (error) {
    log.warn(`${LOG_PREFIX} cannot write ${path}: ${String(error.message ?? error)}`)
    return false
  }
}

/* -------------------------------------------------------------------------- *
 * thank-you card
 * -------------------------------------------------------------------------- */

/**
 * Shape written before anything has been shown, so the first decision is a
 * plain `shows === 0` read instead of a special case.
 * @returns a fresh notice document.
 */
function emptyNotice() {
  return { version: NOTICE_VERSION, shows: 0, lastAt: 0, closed: null }
}

/**
 * Read the notice document, tolerating anything on disk.
 *
 * The card is decoration: a corrupt or hand-edited file must degrade to "ask
 * once more", never to a crash on startup.
 * @param path - absolute path of the document.
 * @param log - warning sink for an unreadable file.
 * @returns always a complete notice document.
 */
function readNotice(path, log) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== NOTICE_VERSION) return emptyNotice()
    const shows = Number.isInteger(parsed?.shows) && parsed.shows >= 0 ? parsed.shows : 0
    const lastAt = Number.isFinite(parsed?.lastAt) && parsed.lastAt >= 0 ? parsed.lastAt : 0
    const closed = NOTICE_FINAL.has(parsed?.closed) ? parsed.closed : null
    return { version: NOTICE_VERSION, shows, lastAt, closed }
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn(`${LOG_PREFIX} ignoring ${path}: ${String(error.message ?? error)}`)
    return emptyNotice()
  }
}

/**
 * Persist the notice document atomically, matching the settings writer.
 * @param path - absolute path of the document.
 * @param notice - already-normalized notice document.
 * @param log - warning sink for a failed write.
 * @returns true when the document reached disk.
 */
function writeNotice(path, notice, log) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const staged = `${path}.tmp`
    writeFileSync(staged, `${JSON.stringify(notice, null, 2)}\n`)
    renameSync(staged, path)
    return true
  } catch (error) {
    log.warn(`${LOG_PREFIX} cannot write ${path}: ${String(error.message ?? error)}`)
    return false
  }
}

/**
 * Decide whether the card is due, and say why.
 *
 * Only an answer ends the card: `thanks` and `issue` both mean the message
 * landed. Everything else asks again on the next page load — a budget counted
 * in files outlives the plugin it belongs to, so the second install saw a card
 * it had never been shown.
 * @param notice - stored notice document.
 * @returns `{ show, reason }` with a stable reason string.
 */
export function noticeDecision(notice) {
  if (notice?.closed === 'thanks' || notice?.closed === 'issue') return { show: false, reason: 'answered' }
  return { show: true, reason: (notice?.shows ?? 0) === 0 ? 'first' : 'again' }
}

/* -------------------------------------------------------------------------- *
 * upstream
 * -------------------------------------------------------------------------- */

/**
 * One upstream GET parsed as JSON.
 *
 * Routed through the runtime `fetch` when no proxy is configured: East Money has
 * started answering the hand-rolled TLS client with a 302 and an empty body, while
 * the same URL through `fetch` (HTTP/2, full header set, redirects followed) returns
 * 200. The TLS client stays as the proxy path, where `fetch` cannot be steered.
 *
 * @param url - absolute https URL.
 * @param context - timeout, proxy and log sink shared by every call in a build.
 * @returns the parsed body.
 */
async function fetchJson(url, context) {
  const proxy = typeof context.proxy === 'string' && context.proxy !== '' ? context.proxy : null

  if (proxy === null && typeof globalThis.fetch === 'function') {
    const response = await globalThis.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-market-ticker/0.1' },
      signal: AbortSignal.timeout(context.upstreamTimeoutMs),
    })
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
    }
    return JSON.parse(await response.text())
  }

  const response = await httpsGet(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market-ticker/0.1' },
    timeoutMs: context.upstreamTimeoutMs,
    proxy,
  })
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  }
  return JSON.parse(response.body)
}

/**
 * Read one batch of East Money quotes.
 * @param secids - instruments in `market.code` form.
 * @param context - timeout, proxy and log sink.
 * @returns a map keyed by secid; instruments the upstream did not answer are absent.
 */
async function eastmoneyQuotes(secids, context) {
  const out = new Map()
  const batches = []
  for (let at = 0; at < secids.length; at += EM_BATCH) batches.push(secids.slice(at, at + EM_BATCH))

  await Promise.all(batches.map(async (batch) => {
    const url = `${EM_ENDPOINT}?fltt=2&secids=${batch.join(',')}&fields=${EM_FIELDS}`
    try {
      const body = await fetchJson(url, context)
      const rows = body?.data?.diff
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const secid = `${row.f13}.${row.f12}`
        const price = looseNum(row.f2)
        if (price === undefined) continue
        out.set(secid, {
          price,
          change: looseNum(row.f4),
          changePercent: looseNum(row.f3),
          high: looseNum(row.f15),
          low: looseNum(row.f16),
          open: looseNum(row.f17),
          prevClose: looseNum(row.f18),
          name: cleanName(row.f14),
        })
      }
    } catch (error) {
      context.log.warn(`${LOG_PREFIX} eastmoney batch failed: ${String(error?.message ?? error)}`)
    }
  }))

  return out
}

/**
 * Read one Gate.io spot ticker.
 * @param pair - `BASE_QUOTE`, upper case.
 * @param context - timeout, proxy and log sink.
 * @returns the quote, or undefined when the pair does not trade.
 */
async function gateQuote(pair, context) {
  try {
    const body = await fetchJson(`${GATE_TICKERS}?currency_pair=${encodeURIComponent(pair)}`, context)
    const row = Array.isArray(body) ? body[0] : undefined
    if (row === null || row === undefined) return undefined
    const price = looseNum(row.last)
    if (price === undefined) return undefined
    const changePercent = looseNum(row.change_percentage)
    // Gate publishes the 24 h percentage only, so the absolute change is derived
    // from the close it implies. A missing percentage leaves both fields empty.
    const prevClose = changePercent === undefined ? undefined : price / (1 + changePercent / 100)
    return {
      price,
      changePercent,
      change: prevClose === undefined ? undefined : price - prevClose,
      high: looseNum(row.high_24h),
      low: looseNum(row.low_24h),
      open: undefined,
      prevClose,
      name: '',
    }
  } catch (error) {
    context.log.warn(`${LOG_PREFIX} gate ${pair} failed: ${String(error?.message ?? error)}`)
    return undefined
  }
}

/**
 * Read one Sina feed URL.
 *
 * Sina's edge stalls a hand-rolled TLS request that carries a referer — it answers
 * 403 without one and simply never replies with one — so this upstream goes through
 * the runtime's fetch, whose fingerprint the edge accepts. The body is GBK; every
 * field this plugin keeps is ASCII, but decoding properly costs nothing and keeps
 * the instrument name available.
 *
 * @param url - absolute https URL.
 * @param context - timeout, proxy and log sink.
 * @returns the status and decoded body.
 */
async function sinaGet(url, context) {
  const headers = { accept: '*/*', referer: SINA_REFERER, 'user-agent': 'Mozilla/5.0' }
  if (typeof fetch === 'function' && context.proxy === undefined) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(context.upstreamTimeoutMs),
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    let body
    try {
      body = new TextDecoder('gbk').decode(buffer)
    } catch {
      body = buffer.toString('utf8')
    }
    return { status: response.status, body }
  }
  return httpsGet(url, { headers, timeoutMs: context.upstreamTimeoutMs, proxy: context.proxy })
}

/**
 * Read one batch of Sina global-futures quotes.
 *
 * Field 7 is the previous close: verified against East Money, whose `103.NQ00Y`
 * percentage matches the value derived from it to two decimals.
 *
 * @param symbols - feed symbols such as `hf_xau`, lower case.
 * @param context - timeout, proxy and log sink.
 * @returns a map keyed by symbol; symbols the upstream did not answer are absent.
 */
async function sinaQuotes(symbols, context) {
  const out = new Map()
  if (symbols.length === 0) return out
  try {
    // The feed is case-sensitive: the `hf_` prefix stays lower case, the code must be
    // upper case, and anything else is answered with an empty body.
    const feed = symbols.map((symbol) => `hf_${symbol.slice(3).toUpperCase()}`).join(',')
    const response = await sinaGet(`${SINA_ENDPOINT}${feed}`, context)
    if (response.status !== 200) throw new Error(`HTTP ${response.status} from hq.sinajs.cn`)
    const pattern = /var hq_str_(hf_[A-Za-z]+)="([^"]*)";/g
    let match
    while ((match = pattern.exec(response.body)) !== null) {
      const fields = match[2].split(',')
      const price = looseNum(fields[0])
      if (price === undefined) continue
      const prevClose = looseNum(fields[7])
      const change = prevClose === undefined ? undefined : price - prevClose
      out.set(match[1].toLowerCase(), {
        price,
        change,
        changePercent: change === undefined || prevClose === 0 ? undefined : (change / prevClose) * 100,
        high: looseNum(fields[4]),
        low: looseNum(fields[5]),
        open: looseNum(fields[8]),
        prevClose,
        name: '',
      })
    }
  } catch (error) {
    context.log.warn(`${LOG_PREFIX} sina batch failed: ${String(error?.message ?? error)}`)
  }
  return out
}

/* -------------------------------------------------------------------------- *
 * plugin
 * -------------------------------------------------------------------------- */
/**
 * Register the plugin routes for the lifetime of this plugin.
 * @param ctx - plugin context; `connection` is injected above.
 * @param config - Cordis config from the profile patch; absent fields use {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const context = {
    upstreamTimeoutMs: Number.isFinite(config.upstreamTimeoutMs) && config.upstreamTimeoutMs > 0
      ? config.upstreamTimeoutMs
      : DEFAULTS.upstreamTimeoutMs,
    proxy: typeof config.proxy === 'string' && config.proxy !== '' ? config.proxy : undefined,
    log,
  }
  const cacheMs = Number.isFinite(config.cacheMs) && config.cacheMs >= 0 ? config.cacheMs : DEFAULTS.cacheMs
  const settingsPath = join(harnessHome(), SETTINGS_FILENAME)
  const legacySettingsPath = join(harnessHome(), LEGACY_SETTINGS_FILENAME)
  const noticePath = join(harnessHome(), NOTICE_FILENAME)

  let notice = readNotice(noticePath, log)
  /** Last decision served, so reloads inside the throttle window cannot spend two shows. */
  let noticeAnswer

  let settings = readSettings(settingsPath, log)
  if (!existsSync(settingsPath) && existsSync(legacySettingsPath)) {
    // Carry a pre-rename watchlist over instead of starting from the defaults;
    // the legacy file is left untouched so a rollback still finds it.
    const adopted = readSettings(legacySettingsPath, log)
    if (writeSettings(settingsPath, adopted, log)) {
      settings = adopted
      log.info(`${LOG_PREFIX} adopted ${legacySettingsPath}`)
    }
  }
  /** Last good quote per instrument id, retained so a total outage still renders a price. */
  const lastGood = new Map()
  /** Latest complete snapshot, reused inside the cache window. */
  let cached
  /** Snapshot currently being built, so concurrent tabs share one upstream round. */
  let inflight

  log.info(`${LOG_PREFIX} watching ${settings.items.length} instruments (${[...new Set(settings.items.map((item) => item.kind))].join(', ')})`)

  /**
   * Ask both upstreams for every instrument on the watchlist.
   * @returns a map keyed by instrument id.
   */
  async function collect() {
    const quotes = new Map()
    const eastMoneyItems = settings.items.filter((item) => item.kind !== 'crypto' && item.source !== 'sina')
    const sinaItems = settings.items.filter((item) => item.source === 'sina')
    const crypto = settings.items.filter((item) => item.kind === 'crypto')

    const [eastmoney, sina, gate] = await Promise.all([
      eastMoneyItems.length > 0
        ? eastmoneyQuotes(eastMoneyItems.map((item) => item.secid), context)
        : Promise.resolve(new Map()),
      sinaItems.length > 0
        ? sinaQuotes([...new Set(sinaItems.map((item) => item.symbol))], context)
        : Promise.resolve(new Map()),
      Promise.all(crypto.map(async (item) => [item.id, await gateQuote(item.pair, context)])),
    ])

    for (const item of eastMoneyItems) {
      const quote = eastmoney.get(item.secid)
      if (quote !== undefined) {
        quotes.set(item.id, quote)
        // The upstream knows the display name; a renamed instrument (a stock that
        // changed its short name) should not keep the name it was added under.
        if (quote.name !== '' && quote.name !== item.name) item.name = quote.name
      }
    }
    for (const item of sinaItems) {
      const quote = sina.get(item.symbol)
      if (quote !== undefined) quotes.set(item.id, quote)
    }
    for (const [id, quote] of gate) {
      if (quote !== undefined) quotes.set(id, quote)
    }
    return quotes
  }

  /**
   * Build one full payload: every watchlist row, stale or not.
   * @returns serializable payload for the browser half.
   */
  async function build() {
    // A switched-off card costs nothing: no upstream round, empty row set, and the
    // browser half renders no element at all.
    if (!settings.enabled) {
      return {
        ok: true,
        enabled: false,
        items: [],
        answered: 0,
        total: 0,
        degraded: false,
        updatedAt: Date.now(),
        schedule: settings.schedule,
        colorScheme: settings.colorScheme,
        showNames: settings.showNames,
      }
    }

    const quotes = await collect()
    for (const [id, quote] of quotes) lastGood.set(id, quote)

    const rows = settings.items.map((item) => {
      const fresh = quotes.get(item.id)
      const quote = fresh ?? lastGood.get(item.id)
      const price = quote?.price ?? null
      return {
        id: item.id,
        kind: item.kind,
        code: item.code,
        name: item.name,
        price,
        change: quote?.change ?? null,
        changePercent: quote?.changePercent ?? null,
        high: quote?.high ?? null,
        low: quote?.low ?? null,
        prevClose: quote?.prevClose ?? null,
        entry: item.entry ?? null,
        qty: item.qty ?? null,
        pnlPercent: positionPnl(item.entry, price),
        pnlAmount: positionAmount(item.entry, item.qty, price),
        stale: fresh === undefined,
      }
    })

    const answered = rows.filter((row) => row.price !== null).length
    return {
      ok: true,
      enabled: true,
      items: rows,
      answered,
      total: rows.length,
      degraded: rows.length > 0 && answered === 0,
      updatedAt: Date.now(),
      schedule: settings.schedule,
      colorScheme: settings.colorScheme,
      showNames: settings.showNames,
    }
  }

  /**
   * Serve one snapshot, from cache when it is still warm and one shared build
   * otherwise, so ten open tabs do not mean ten upstream rounds.
   * @param force - bypass the cache window.
   * @returns the payload.
   */
  async function snapshot(force) {
    if (!force && cached !== undefined && Date.now() - cached.at < cacheMs) return cached.payload
    if (inflight !== undefined) return inflight
    inflight = build()
      .then((payload) => {
        if (!payload.degraded) cached = { at: Date.now(), payload }
        return payload
      })
      .finally(() => { inflight = undefined })
    return inflight
  }

  ctx.connection.fetch.register({
    path: TICKER_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const force = new URL(request.url).searchParams.get('refresh') === '1'
      try {
        return jsonResponse(await snapshot(force))
      } catch (error) {
        log.warn(`${LOG_PREFIX} snapshot failed: ${String(error?.stack ?? error)}`)
        if (cached !== undefined) return jsonResponse({ ...cached.payload, degraded: true })
        return jsonResponse({ ok: false, error: 'upstream', message: String(error?.message ?? error) }, 502)
      }
    },
  })

  ctx.connection.fetch.register({
    path: SETTINGS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') return jsonResponse({ ok: true, settings })
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ ok: false, code: 'badJson', message: '请求体不是合法的 JSON' }, 400)
      }
      const next = normalizeSettings(body, settings.items)
      if (!writeSettings(settingsPath, next, log)) {
        return jsonResponse({ ok: false, code: 'writeFailed', message: '设置写入失败，请检查 DSH_HOME 权限' }, 500)
      }
      settings = next
      // The watchlist changed, so the old snapshot no longer describes it.
      cached = undefined
      return jsonResponse({ ok: true, settings })
    },
  })

  ctx.connection.fetch.register({
    path: RESOLVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse({ ok: false, code: 'badJson', message: '请求体不是合法的 JSON' }, 400)
      }
      const query = typeof body?.query === 'string' ? body.query : ''
      const candidates = candidatesFor(query, typeof body?.kind === 'string' ? body.kind : undefined)
      if (candidates.length === 0) {
        return jsonResponse({ ok: false, code: 'unknownCode', message: '无法识别的代码，试试 600519 / hk00700 / AAPL / USTEC / EURUSD / XAUUSD / BTC' }, 404)
      }

      const mie = candidates.find((candidate) => candidate.source === 'sina')
      if (mie !== undefined) {
        const quotes = await sinaQuotes([mie.symbol], context)
        const quote = quotes.get(mie.symbol)
        if (quote !== undefined) {
          return jsonResponse({
            ok: true,
            item: normalizeItem(mie),
            quote: { price: quote.price, changePercent: quote.changePercent },
          })
        }
      }

      // Every non-crypto candidate is probed in one request; the first one the
      // quote endpoint actually answers is the instrument the operator meant.
      const equity = candidates.filter((candidate) => candidate.kind !== 'crypto' && candidate.source !== 'sina')
      if (equity.length > 0) {
        const quotes = await eastmoneyQuotes(equity.map((candidate) => candidate.secid), context)
        for (const candidate of equity) {
          const quote = quotes.get(candidate.secid)
          if (quote === undefined) continue
          return jsonResponse({
            ok: true,
            item: normalizeItem({ ...candidate, name: quote.name === '' ? candidate.code : quote.name }),
            quote: { price: quote.price, changePercent: quote.changePercent },
          })
        }
      }

      // Crypto: the pair metadata carries the coin's full name.
      for (const candidate of candidates.filter((entry) => entry.kind === 'crypto')) {
        try {
          const meta = await fetchJson(`${GATE_PAIRS}/${encodeURIComponent(candidate.pair)}`, context)
          const name = cleanName(meta?.base_name) || candidate.code
          return jsonResponse({ ok: true, item: normalizeItem({ ...candidate, name }) })
        } catch {
          // A pair that does not trade answers 400/404; the next candidate is tried.
        }
      }

      return jsonResponse({ ok: false, code: 'noQuote', message: '上游没有这个标的的报价' }, 404)
    },
  })

  /**
   * The thank-you card. GET answers whether it is due and counts the showing;
   * POST records what the operator did with it.
   *
   * The host owns both halves on purpose: `localStorage` is origin-scoped, and
   * the desktop shell binds a fresh loopback port on every launch, so a browser
   * flag would bring the card back on each restart.
   */
  ctx.connection.fetch.register({
    path: NOTICE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        const now = Date.now()
        if (noticeAnswer !== undefined && now - noticeAnswer.at < NOTICE_THROTTLE_MS) {
          return jsonResponse(noticeAnswer.body)
        }
        const decision = noticeDecision(notice)
        let body
        if (decision.show) {
          notice = { ...notice, shows: notice.shows + 1, lastAt: now }
          writeNotice(noticePath, notice, log)
          body = { ok: true, show: true, reason: decision.reason, shows: notice.shows }
        } else {
          body = { ok: true, show: false, reason: decision.reason, shows: notice.shows }
        }
        noticeAnswer = { at: now, body }
        return jsonResponse(body)
      }

      // The body is one short action, so it is read as text and bounded before parsing.
      let text
      try {
        text = await request.text()
      } catch {
        return jsonResponse({ ok: false, code: 'badJson', message: '请求体不是合法的 JSON' }, 400)
      }
      if (text.length > NOTICE_MAX_BODY) {
        return jsonResponse({ ok: false, code: 'tooLarge', message: '请求体过大' }, 413)
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return jsonResponse({ ok: false, code: 'badJson', message: '请求体不是合法的 JSON' }, 400)
      }
      const action = typeof body?.action === 'string' ? body.action : ''
      if (!NOTICE_ACTIONS.has(action)) {
        return jsonResponse({ ok: false, code: 'badAction', message: 'action 必须是 thanks / issue / later' }, 400)
      }

      // "thanks" and "issue" close the card for good; "later" only notes the visit.
      notice = action === 'later'
        ? { ...notice, lastAt: Date.now() }
        : { ...notice, closed: action }
      if (!writeNotice(noticePath, notice, log)) {
        return jsonResponse({ ok: false, code: 'writeFailed', message: '状态写入失败，请检查 DSH_HOME 权限' }, 500)
      }
      // The cached answer would still say `show: true`, so it is dropped here.
      noticeAnswer = undefined
      return jsonResponse({ ok: true, closed: notice.closed })
    },
  })
}
