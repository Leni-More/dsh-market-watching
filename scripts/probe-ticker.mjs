// Ad-hoc probe: hit the ticker route once and print what came back.
import * as mod from '../index.js'

const routes = []
mod.apply(
  { connection: { fetch: { register: (spec) => routes.push(spec) } }, logger: console },
  {},
)

const spec = routes.find((entry) => entry.path === mod.TICKER_PATH)
const started = Date.now()
const response = await spec.fetch({ method: 'GET', url: `http://127.0.0.1${mod.TICKER_PATH}`, signal: undefined })
const body = await response.json()
console.log('status', response.status, 'ms', Date.now() - started)
console.log('ok', body.ok, 'degraded', body.degraded, 'answered', body.answered, '/', body.total)
for (const row of body.items ?? []) {
  console.log(row.code, row.name, 'price', row.price, 'chg%', row.changePercent, 'stale', row.stale, 'note', row.note)
}
console.log('errors', JSON.stringify(body.errors ?? null))
