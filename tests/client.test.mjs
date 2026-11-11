/**
 * Browser-half smoke tests. The real UI needs the DSH shell, so this loads the module
 * the way `__ModuleLoader__` does and checks the registrations it makes: a wrong slot
 * id or a missing export would leave the card invisible with no error on screen.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Stand-in for the React surface `client.js` touches at module scope. */
const ReactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

/**
 * Stand-in for the locale service. It resolves through the real dictionaries the
 * module registers, so label assertions test the shipping copy.
 * @param active - language the fake shell reports as current.
 * @returns the service plus the dictionary store it fills.
 */
function localeStub(active = 'zh') {
  const dictionaries = new Map()
  let revision = 0
  const service = {
    register: (namespace, messages) => { dictionaries.set(namespace, messages) },
    bind: (namespace) => function bound(key, params) {
      const table = dictionaries.get(namespace) ?? {}
      const text = table[active]?.[key] ?? table.en?.[key] ?? key
      if (params === undefined || params === null) return text
      return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    },
    getLocale: () => ({ active, locales: ['zh', 'en'], revision }),
    subscribe: () => () => {},
  }
  return service
}

/**
 * Evaluate `client.js` in a sandbox that mimics the loader handoff.
 * @param options - `folded` seeds the stored fold preference, `locale` picks the language.
 * @returns the module definition handed to `__ModuleLoader__.load`.
 */
function loadDefinition(options = {}) {
  let definition
  const injected = []
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      localStorage: {
        getItem: (key) => (options.folded === true && key === 'dsh-market-watching.collapsed' ? '1' : null),
        setItem: () => {},
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      getComputedStyle: () => ({ display: 'block' }),
    },
    document: {
      baseURI: 'http://127.0.0.1:65505/',
      head: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
    },
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    navigator: { language: options.locale === 'en' ? 'en-US' : 'zh-CN' },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(definition, 'module called __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-market-watching')
  assert.deepEqual(injected, [])
  return definition
}

/** Build the plugin context the shell hands to `apply`. */
function shellContext(options = {}) {
  const locale = localeStub(options.locale === 'en' ? 'en' : 'zh')
  const ctx = {
    effect: (callback) => { callback() },
    locale,
    slots: {
      inject: (name, callback) => callback(),
      register: (spec, component) => { (options.registered ?? []).push({ spec, component }) },
    },
  }
  return ctx
}


/** Flatten a stub element tree into a node list. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) {
    if (Array.isArray(child)) child.forEach((entry) => walk(entry, out))
    else walk(child, out)
  }
  return out
}

/**
 * Build the exports the loader would return.
 * @param definition - value captured from `__ModuleLoader__.load`.
 * @returns the module exports.
 */
function loadExports(definition) {
  return definition.factory((id) => {
    if (id === 'react') return ReactStub
    throw new Error(`unexpected require: ${id}`)
  })
}

test('client module registers both surfaces under the expected slot ids', () => {
  const exports = loadExports(loadDefinition())
  // The sandbox creates its own Array prototype, so compare element-wise.
  assert.equal(exports.inject.length, 2)
  assert.equal(exports.inject[0], 'slots')
  assert.equal(exports.inject[1], 'locale', 'the copy follows the shell language')
  assert.equal(typeof exports.apply, 'function')

  const registered = []
  exports.apply(shellContext({ registered }))

  const byName = new Map(registered.map((entry) => [entry.spec.name, entry]))
  assert.deepEqual([...byName.keys()], ['sidebar.footer.action', 'settings.section', 'settings.section.icon'])

  const card = byName.get('sidebar.footer.action')
  assert.equal(card.spec.id, 'market-watching')
  assert.equal(typeof card.spec.order, 'number')
  assert.equal(typeof card.component, 'function')

  const page = byName.get('settings.section')
  assert.equal(page.spec.id, 'market-watching-settings')
  assert.equal(page.spec.label(), '行情卡片')
  assert.equal(typeof page.component, 'function')

  // The icon has to share the section id, or the navigation row stays icon-less.
  assert.equal(byName.get('settings.section.icon').spec.id, page.spec.id)
})

test('an English shell gets English copy everywhere', () => {
  const registered = []
  loadExports(loadDefinition({ locale: 'en' })).apply(shellContext({ locale: 'en', registered }))
  const page = registered.find((entry) => entry.spec.name === 'settings.section')
  assert.equal(page.spec.label(), 'Market card')

  const card = renderCard({ locale: 'en' }).find((node) => node.props?.className === 'dmt-card')
  assert.ok(card, 'the card still renders')
  const text = walk(card).map((node) => node.children?.join('')).join(' ')
  assert.ok(!/[\u3400-\u9fff]/.test(text), `english shell leaked Chinese: ${text}`)
})

test('the dictionary covers every key in both languages', () => {
  const exports = loadExports(loadDefinition())
  const registered = []
  exports.apply(shellContext({ registered }))
  assert.ok(registered.length > 0)

  const zhKeys = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.ok(zhKeys.length > 50, 'the component tree is translated key by key')
  // Every literal key has to exist in the table, otherwise the UI shows raw keys.
  const miss = zhKeys.filter((key) => !source.includes(`'${key}':`))
  assert.deepEqual(miss, [])
})

test('client module survives a second apply without throwing', () => {
  const exports = loadExports(loadDefinition())
  const ctx = shellContext()
  exports.apply(ctx)
  exports.apply(ctx)
})

/** Render the card through the stub and hand back its element tree. */
function renderCard(options) {
  const exports = loadExports(loadDefinition(options))
  let card
  const registered = []
  exports.apply(shellContext({ ...options, registered }))
  card = registered.find((entry) => entry.spec.name === 'sidebar.footer.action').component
  return walk(card({ wide: true }))
}

test('the card folds down to a single summary line and remembers the choice', () => {
  const open = renderCard({})
  const openCard = open.find((node) => node.props?.className === 'dmt-card')
  assert.equal(openCard.props['data-collapsed'], '0')

  const foldOpen = open.find((node) => node.props?.className === 'dmt-fold')
  assert.ok(foldOpen, 'the header carries a fold button')
  assert.equal(foldOpen.type, 'button')
  assert.equal(foldOpen.props['aria-expanded'], 'true')
  assert.equal(foldOpen.children[0], '▾')

  const folded = renderCard({ folded: true })
  const foldedCard = folded.find((node) => node.props?.className === 'dmt-card')
  assert.equal(foldedCard.props['data-collapsed'], '1')

  const foldClosed = folded.find((node) => node.props?.className === 'dmt-fold')
  assert.equal(foldClosed.props['aria-expanded'], 'false')
  assert.equal(foldClosed.children[0], '▸')

  // Folded, the quote rows stay in the tree but the stylesheet hides them, so the
  // card shows nothing but its title and the expand button.
  const rows = folded.find((node) => node.props?.className === 'dmt-rows')
  assert.ok(rows, 'the rows survive the fold')
  assert.equal(rows.props.onClick, undefined, 'no stray click target outside the header')
})

test('a stored cost basis replaces the 24h move with the P&L percentage', () => {
  const exports = loadExports(loadDefinition())

  const withBasis = exports.percentCell({ changePercent: -0.35, pnlPercent: 12.5 })
  assert.equal(withBasis.value, 12.5)
  assert.equal(withBasis.pnl, 12.5)

  const withoutBasis = exports.percentCell({ changePercent: -0.35, pnlPercent: null })
  assert.equal(withoutBasis.value, -0.35, 'no basis keeps the 24h move')
  assert.equal(withoutBasis.pnl, null)

  // A quote that arrived without a price leaves the P&L null, not zero.
  const missing = exports.percentCell({ changePercent: 1.5, pnlPercent: null })
  assert.equal(missing.value, 1.5)

  assert.equal(exports.formatPrice(4126.52, 'fx'), '4,126.52')
  assert.equal(exports.formatPrice(1.1225, 'fx'), '1.12250')
})

test('a cash amount keeps its sign and the market 0 decimals', () => {
  const exports = loadExports(loadDefinition())
  assert.equal(exports.formatAmount(5, 'fx'), '+5.00000')
  assert.equal(exports.formatAmount(-5, 'fx'), '-5.00000')
  assert.equal(exports.formatAmount(1234.5, 'stock'), '+1,234.50')
  assert.equal(exports.formatAmount(0, 'stock'), '0.00')
  assert.equal(exports.formatAmount(null, 'stock'), '--')
})

test('cost and size are committed by the row button, not by leaving the box', () => {
  assert.ok(source.includes("className: 'dmt-ok-btn'"), 'each row carries a confirm button')
  assert.ok(source.includes("'data-field': 'price'"), 'the cost box is addressable')
  assert.ok(source.includes("'data-field': 'qty'"), 'the size box is addressable')
  // Blur used to write straight through, which turned an abandoned edit into a stored
  // position. Only the row button and the Enter key may persist now.
  assert.ok(!/onBlur: \(event\) => \{ commit/.test(source), 'leaving a box must not save')
})

test('the thank-you card talks to the host route and the issue tracker', () => {
  assert.ok(source.includes("const NOTICE_ENDPOINT = '/api/market.notice'"), 'the card asks the host, not a browser flag')
  assert.ok(source.includes("const REPO_URL = 'https://github.com/Leni-More/dsh-market-watching'"))
  assert.ok(source.includes('const ISSUES_URL = `${REPO_URL}/issues`'))
  assert.ok(source.includes("answerThanks('later')") || source.includes("onClose('later')"), 'dismissal is reported back')
  // Both dictionaries carry the card, or one shell renders raw keys.
  for (const key of ['thanks.title', 'thanks.body', 'thanks.wish', 'thanks.star', 'thanks.ack', 'thanks.close', 'thanks.note', 'thanks.repo']) {
    assert.equal(source.split(`'${key}':`).length - 1, 2, `${key} is translated twice`)
  }
  // The primary ask is a star, so it has to land on the repo rather than the issue list.
  assert.ok(/cta\.href = REPO_URL/.test(source), 'the amber button opens the repo')
  assert.ok(source.includes("onClose('thanks')"), 'clicking the star retires the card')
})

test('the settings page ends with the star line and the repo address', () => {
  assert.ok(source.includes("className: 'dmt-page-credit'"), 'the settings page carries a credit line')
  assert.ok(source.includes("t('credit.ask')"), 'the ask goes through the dictionary')
  assert.equal(source.split("'credit.ask':").length - 1, 2, 'credit.ask is translated twice')
  // The address is printed, not only linked: a link whose text says "here" gives the
  // reader nothing to copy when the shell refuses to open a tab.
  assert.ok(/href: REPO_URL/.test(source), 'the line links to the repository')
  assert.ok(source.includes('REPO_URL.replace(/^https?:\\/\\//, \'\')'), 'the bare address is what the reader sees')
})

test('the plugin ships a brand mark, and the sidebar card wears it', () => {
  const icon = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')
  assert.ok(icon.trimStart().startsWith('<svg'), 'icon.svg is an SVG document')
  assert.ok(icon.includes('viewBox="0 0 24 24"'), 'the mark is drawn on one 24px grid')

  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.icon, './icon.svg')
  // npm publishes only what `files` lists, so an icon declared but not listed would
  // work in the repo and 404 on the registry.
  assert.ok(manifest.files.includes('icon.svg'), 'the icon is published, not just declared')

  assert.ok(source.includes("className: 'dmt-brand'"), 'the card header renders the mark')
  assert.ok(source.includes('function BrandMark'), 'the mark is drawn in the module, not fetched')
})
