/**
 * Host-half tests: candidate inference and settings validation are pure, the route
 * behaviour reads the real upstreams. Run with `node --test tests/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'market-watching-test-'))

const { apply, candidatesFor, installStamp, normalizeItem, normalizeQty, normalizeSettings, noticeDecision, positionAmount, positionPnl } = await import('../index.js')

/** Collect every route the plugin registers against a fake connection. */
function boot(config = {}) {
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  }
  apply(ctx, config)
  return routes
}

/** Call one registered route the way Connection would. */
async function call(routes, path, init) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} registered`)
  const request = new Request(`http://127.0.0.1${path}`, init)
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

test('candidatesFor infers markets from the code shape', () => {
  assert.deepEqual(candidatesFor('600519').map((c) => c.secid), ['1.600519', '0.600519'])
  assert.deepEqual(candidatesFor('000001').map((c) => c.secid), ['0.000001', '1.000001'])
  assert.deepEqual(candidatesFor('sh000001').map((c) => c.secid), ['1.000001'])
  assert.deepEqual(candidatesFor('00700').map((c) => c.secid), ['116.00700'])
  assert.deepEqual(candidatesFor('AAPL').map((c) => c.secid), ['105.AAPL'])
  assert.deepEqual(candidatesFor('usBRK.B').map((c) => c.secid), ['105.BRK.B'])
  assert.deepEqual(candidatesFor('EURUSD').map((c) => c.secid), ['119.EURUSD', '133.EURUSD'])
  assert.deepEqual(candidatesFor('USDCNH').map((c) => c.secid), ['133.USDCNH', '119.USDCNH'])
  assert.equal(candidatesFor('btc').some((c) => c.kind === 'crypto'), false)
  assert.deepEqual(candidatesFor('btc', 'crypto').map((c) => c.pair), ['BTC_USDT'])
  assert.deepEqual(candidatesFor('BTCUSDT', 'crypto').map((c) => c.pair), ['BTC_USDT'])
  assert.deepEqual(candidatesFor('ETH_BTC').map((c) => c.pair), ['ETH_BTC'])
  assert.deepEqual(candidatesFor('600519', 'crypto').map((c) => c.kind), ['crypto'])
  assert.deepEqual(candidatesFor('XAUUSD').map((c) => c.id), ['fx:sina:HF_XAU'])
  assert.deepEqual(candidatesFor('XAU').map((c) => c.id), ['fx:sina:HF_XAU'])
  assert.deepEqual(candidatesFor('XAGUSD').map((c) => c.symbol), ['hf_xag'])
  // Contract names are the futures a terminal quotes around the clock, not the cash index.
  assert.deepEqual(candidatesFor('USTEC').map((c) => c.secid), ['103.NQ00Y'])
  assert.deepEqual(candidatesFor('USTEC').map((c) => c.code), ['USTEC'])
  assert.deepEqual(candidatesFor('US500').map((c) => c.secid), ['103.ES00Y'])
  assert.deepEqual(candidatesFor('NDX100').map((c) => c.secid), ['100.NDX100'])
  assert.deepEqual(candidatesFor('NDX').map((c) => c.secid), ['100.NDX'])
  assert.deepEqual(candidatesFor('US30').map((c) => c.secid), ['103.YM00Y'])
  assert.deepEqual(candidatesFor('DXY').map((c) => c.secid), ['100.UDI'])
  assert.deepEqual(candidatesFor('XAUUSD', 'stock'), [])
  assert.deepEqual(candidatesFor(''), [])
})

test('normalizeItem drops anything that could not become a safe upstream URL', () => {
  assert.equal(normalizeItem({ kind: 'stock', secid: '../../etc/passwd' }), undefined)
  assert.equal(normalizeItem({ kind: 'crypto', pair: 'btc/usdt' }), undefined)
  assert.equal(normalizeItem({ kind: 'fx', secid: '119.EURUSD' }).id, 'fx:119.EURUSD')
  assert.equal(normalizeItem({ kind: 'stock', secid: '105.aapl' }).secid, '105.AAPL')
  assert.equal(normalizeItem({ kind: 'crypto', pair: 'BTC_USDT' }).name, 'BTC')
  assert.equal(normalizeItem({ kind: 'fx', source: 'sina', symbol: 'hf_xau' }).name, '伦敦金')
  assert.equal(normalizeItem({ kind: 'fx', source: 'sina', symbol: 'hf_XAU;drop' }), undefined)
})

test('normalizeSettings keeps a usable list, clamps the schedule, and fills defaults', () => {
  const empty = normalizeSettings({ items: [] })
  assert.ok(empty.items.length > 0)
  assert.equal(empty.schedule, 15)

  const clamped = normalizeSettings({ items: [], schedule: 1 })
  assert.equal(clamped.schedule, 15)
  const kept = normalizeSettings({ items: [], schedule: 60 })
  assert.equal(kept.schedule, 60)

  const duplicated = normalizeSettings({
    items: [
      { kind: 'stock', secid: '1.600519', name: '贵州茅台' },
      { kind: 'stock', secid: '1.600519', name: 'duplicate' },
    ],
  })
  assert.equal(duplicated.items.length, 1)
  assert.equal(duplicated.items[0].name, '贵州茅台')
})

test('the ticker route quotes every default instrument from the live upstreams', async () => {
  const routes = boot()
  const { status, body } = await call(routes, '/api/market.ticker')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.items.length, 4)
  for (const row of body.items) {
    assert.equal(typeof row.price, 'number', `${row.code} has a price`)
    assert.equal(typeof row.changePercent, 'number', `${row.code} has a change`)
    assert.equal(row.stale, false, `${row.code} is fresh`)
  }
  assert.equal(body.degraded, false)
})

test('spot metals and contract-style indices come from their own upstreams', async () => {
  const routes = boot()
  await call(routes, '/api/market.settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { kind: 'fx', source: 'sina', symbol: 'hf_XAU', code: 'XAUUSD', name: '伦敦金' },
        { kind: 'stock', secid: '103.NQ00Y', code: 'USTEC', name: '小型纳指当月连续' },
        { kind: 'crypto', pair: 'BTC_USDT' },
      ],
    }),
  })

  const { status, body } = await call(routes, '/api/market.ticker')
  assert.equal(status, 200)
  assert.deepEqual(body.items.map((row) => row.id), ['fx:sina:HF_XAU', 'stock:103.NQ00Y', 'crypto:BTC_USDT'])
  for (const row of body.items) {
    assert.equal(typeof row.price, 'number', `${row.code} has a price`)
    assert.equal(typeof row.changePercent, 'number', `${row.code} has a change`)
    assert.equal(row.stale, false, `${row.code} is fresh`)
  }
  const gold = body.items[0]
  assert.ok(gold.price > 500, 'spot gold trades in the thousands')
  assert.equal(gold.name, '伦敦金')
  assert.equal(body.items[1].code, 'USTEC', 'the alias is what the card shows')
  assert.ok(body.items[1].price > 1000, 'the Nasdaq future sits in the tens of thousands')

  const alias = await call(routes, '/api/market.resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'USTEC' }),
  })
  assert.equal(alias.status, 200)
  assert.equal(alias.body.item.secid, '103.NQ00Y')
  assert.equal(alias.body.item.code, 'USTEC')
})

test('the resolve route canonicalizes a code and backfills its name', async () => {
  const routes = boot()
  const stock = await call(routes, '/api/market.resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '600519' }),
  })
  assert.equal(stock.status, 200)
  assert.equal(stock.body.item.id, 'stock:1.600519')
  assert.equal(stock.body.item.name, '贵州茅台')

  const hk = await call(routes, '/api/market.resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '00700' }),
  })
  assert.equal(hk.body.item.kind, 'stock')
  assert.equal(hk.body.item.secid, '116.00700')

  const crypto = await call(routes, '/api/market.resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'eth', kind: 'crypto' }),
  })
  assert.equal(crypto.body.item.pair, 'ETH_USDT')
  assert.equal(crypto.body.item.name, 'Ethereum')

  const missing = await call(routes, '/api/market.resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'zzzzzz' }),
  })
  assert.equal(missing.status, 404)
})

test('settings round-trip through the host document', async () => {
  const routes = boot()
  const saved = await call(routes, '/api/market.settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { kind: 'fx', secid: '119.GBPUSD', name: '英镑兑美元' },
        { kind: 'crypto', pair: 'SOL_USDT' },
        { kind: 'bogus', secid: '1.600519' },
      ],
      schedule: 30,
      colorScheme: 'green-up',
    }),
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.items.length, 2)
  assert.equal(saved.body.settings.schedule, 30)
  assert.equal(saved.body.settings.colorScheme, 'green-up')

  const read = await call(routes, '/api/market.settings')
  assert.deepEqual(read.body.settings.items.map((item) => item.id), ['fx:119.GBPUSD', 'crypto:SOL_USDT'])
})

test('the master switch empties the payload without touching any upstream', async () => {
  const routes = boot()

  // Count what would reach an upstream: a switched-off card must cost zero requests.
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (...args) => {
    calls += 1
    return realFetch(...args)
  }
  try {
    const off = await call(routes, '/api/market.settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, items: [{ kind: 'fx', source: 'sina', symbol: 'hf_XAU' }] }),
    })
    assert.equal(off.body.settings.enabled, false)

    const idle = await call(routes, '/api/market.ticker')
    assert.equal(idle.body.enabled, false)
    assert.deepEqual(idle.body.items, [])
    assert.equal(idle.body.degraded, false)
    assert.equal(calls, 0)

    const on = await call(routes, '/api/market.settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, items: [{ kind: 'fx', source: 'sina', symbol: 'hf_XAU' }] }),
    })
    assert.equal(on.body.settings.enabled, true)

    const live = await call(routes, '/api/market.ticker')
    assert.equal(live.body.enabled, true)
    assert.equal(live.body.items.length, 1)
    assert.equal(typeof live.body.items[0].price, 'number')
  } finally {
    globalThis.fetch = realFetch
  }

  // Absent the field, the switch stays on so an older settings document keeps working.
  assert.equal(normalizeSettings({ items: [] }).enabled, true)
  assert.equal(normalizeSettings({ items: [], enabled: 'yes' }).enabled, false)
})

test('a cost basis turns the percentage column into a P&L, shorts inverted', async () => {
  assert.equal(positionPnl(undefined, 100), null)
  assert.equal(positionPnl({ side: 'long', price: 100 }, null), null)
  assert.equal(positionPnl({ side: 'long', price: 100 }, 110), 10)
  assert.equal(positionPnl({ side: 'long', price: 100 }, 90), -10)
  // A short gains when the quote falls below the selling price.
  assert.equal(positionPnl({ side: 'short', price: 100 }, 90), 10)
  assert.equal(positionPnl({ side: 'short', price: 100 }, 110), -10)

  const routes = boot()
  const saved = await call(routes, '/api/market.settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { kind: 'fx', secid: '119.EURUSD', entry: { side: 'short', price: 2 } },
        { kind: 'crypto', pair: 'BTC_USDT', entry: { side: 'long', price: 1 } },
        { kind: 'crypto', pair: 'ETH_USDT', entry: { price: -3 } },
      ],
    }),
  })
  assert.equal(saved.body.settings.items[0].entry.side, 'short')
  assert.equal(saved.body.settings.items[1].entry.side, 'long')
  assert.equal(saved.body.settings.items[2].entry, undefined, 'a negative basis is dropped')

  const { body } = await call(routes, '/api/market.ticker')
  const eur = body.items[0]
  assert.equal(typeof eur.pnlPercent, 'number')
  assert.ok(eur.pnlPercent > 0, 'a short sold above the market is in profit')

  const eth = body.items[2]
  assert.equal(eth.pnlPercent, null, 'no basis, no P&L')
  assert.equal(typeof eth.changePercent, 'number', 'the 24h move is still there')
})

test('a quantity turns the percentage into a cash amount, floored at 0.001', async () => {
  // No size, no amount: the percentage stays, the money does not appear from nowhere.
  assert.equal(positionAmount({ side: 'long', price: 100 }, undefined, 110), null)
  assert.equal(positionAmount({ side: 'long', price: 100 }, 0.0005, 110), null)
  assert.equal(positionAmount(undefined, 2, 110), null)
  // 0.5 units bought at 100 and now worth 110 is +5.
  assert.equal(positionAmount({ side: 'long', price: 100 }, 0.5, 110), 5)
  // The same move on a short is a loss of the same size.
  assert.equal(positionAmount({ side: 'short', price: 100 }, 0.5, 110), -5)
  assert.equal(positionAmount({ side: 'short', price: 100 }, 0.5, 90), 5)

  assert.equal(normalizeQty({ qty: 0.0009 }), undefined, 'below the floor is unset, not rounded')
  assert.equal(normalizeQty({ qty: 0.001 }), 0.001)
  assert.equal(normalizeQty({ qty: '3' }), 3)
  assert.equal(normalizeQty({ qty: 0 }), undefined)
  assert.equal(normalizeQty({}), undefined)

  const routes = boot()
  const saved = await call(routes, '/api/market.settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { kind: 'crypto', pair: 'BTC_USDT', entry: { side: 'long', price: 1 }, qty: 2 },
        { kind: 'crypto', pair: 'ETH_USDT', entry: { side: 'short', price: 1 }, qty: 0.0001 },
      ],
    }),
  })
  assert.equal(saved.body.settings.items[0].qty, 2)
  assert.equal(saved.body.settings.items[1].qty, undefined, 'a sub-floor size is dropped')

  const { body } = await call(routes, '/api/market.ticker')
  const btc = body.items[0]
  assert.equal(typeof btc.pnlAmount, 'number')
  assert.ok(btc.pnlAmount > 0, 'a long bought at 1 is deep in profit at the market price')
  // The percentage and the amount must agree in sign.
  assert.equal(Math.sign(btc.pnlAmount), Math.sign(btc.pnlPercent))

  const eth = body.items[1]
  assert.equal(eth.pnlAmount, null, 'no size, no amount')
  assert.equal(typeof eth.pnlPercent, 'number', 'the percentage does not need a size')
})

test('an old dsh-market-ticker.json is adopted under the new file name', async () => {
  const home = mkdtempSync(join(tmpdir(), 'market-watching-legacy-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await writeFile(
      join(home, 'dsh-market-ticker.json'),
      JSON.stringify({
        version: 1,
        items: [{ kind: 'fx', secid: '119.EURUSD', name: '欧元兑美元', entry: { side: 'short', price: 1.2 } }],
        schedule: 45,
      }),
      'utf8',
    )

    const routes = boot()
    const read = await call(routes, '/api/market.settings')
    assert.equal(read.body.settings.schedule, 45, 'legacy values survive the rename')
    assert.equal(read.body.settings.items[0].id, 'fx:119.EURUSD')
    assert.equal(read.body.settings.items[0].entry.price, 1.2)

    const adopted = JSON.parse(await readFile(join(home, 'dsh-market-watching.json'), 'utf8'))
    assert.equal(adopted.schedule, 45, 'the new document is written on adoption')
    assert.ok(await readFile(join(home, 'dsh-market-ticker.json'), 'utf8'), 'the old file is left alone')
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('the thank-you card greets each installed copy once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'market-watching-notice-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = boot()
    const first = await call(routes, '/api/market.notice')
    assert.equal(first.body.show, true)
    assert.equal(first.body.reason, 'installed')

    // A reload inside the throttle window is answered from memory: same verdict.
    const reload = await call(routes, '/api/market.notice')
    assert.equal(reload.body.show, true)

    const stored = JSON.parse(await readFile(join(home, 'dsh-market-watching.notice.json'), 'utf8'))
    assert.equal(stored.install, installStamp())
    assert.ok(stored.shownAt > 0)

    const answered = await call(routes, '/api/market.notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'thanks' }),
    })
    assert.equal(answered.status, 200)
    assert.equal(answered.body.closed, 'thanks')

    // A restart reads the file and stays quiet: this copy has been greeted.
    const restarted = await call(boot(), '/api/market.notice')
    assert.equal(restarted.body.show, false)
    assert.equal(restarted.body.reason, 'asked')
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('the notice route rejects answers it cannot understand', async () => {
  const home = mkdtempSync(join(tmpdir(), 'market-watching-notice-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const routes = boot()
    const unknown = await call(routes, '/api/market.notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'starred' }),
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.code, 'badAction')

    const broken = await call(routes, '/api/market.notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(broken.status, 400)
    assert.equal(broken.body.code, 'badJson')

    // The body is one short action; anything larger is refused before parsing.
    const huge = await call(routes, '/api/market.notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'later', pad: 'x'.repeat(4096) }),
    })
    assert.equal(huge.status, 413)
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('noticeDecision greets one installed copy', () => {
  const now = 1_700_000_000_000
  assert.deepEqual(noticeDecision({ version: 3, install: '', shownAt: 0, closed: null }, 'copy-a'), {
    show: true,
    reason: 'installed',
  })
  // A record from another copy — an older install, or a fresh directory — is due.
  assert.deepEqual(noticeDecision({ version: 3, install: 'copy-a', shownAt: now, closed: null }, 'copy-b'), {
    show: true,
    reason: 'installed',
  })
  // The copy the file already greeted stays quiet, whatever the reader answered.
  assert.equal(noticeDecision({ version: 3, install: 'copy-a', shownAt: now, closed: null }, 'copy-a').show, false)
  assert.equal(noticeDecision({ version: 3, install: 'copy-a', shownAt: now, closed: 'issue' }, 'copy-a').show, false)
  // Nothing is remembered about a copy that was never greeted.
  assert.equal(noticeDecision({ version: 3, install: 'copy-a', shownAt: 0, closed: null }, 'copy-a').show, true)
})
