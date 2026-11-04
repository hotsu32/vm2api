import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { summarizeCapacity, capacityGate, dynamicCapacityEnabled } from '../../src/lib/pool/channel-capacity.mjs'
import { handleChannelCapacity } from '../../src/lib/protocol/channel-capacity.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

const key = { id: 'key_abc', max_concurrency: 4 }
const account = (id, limit, executing = 0) => ({
  accountId: id,
  limit,
  executing,
  available: Math.max(0, limit - executing),
  draining: limit === 1,
})
for (const [limits, expected] of [
  [[2, 2], 4],
  [[2, 1], 3],
  [[1, 1], 2],
  [[2, 0], 2],
  [[1, 0], 1],
  [[0, 0], 0],
]) {
  test(`capacity ${limits.join('+')} = ${expected}`, () => {
    const s = summarizeCapacity({
      accounts: limits.map((l, i) => account(String(i), l)),
      key,
      model: 'claude-opus-5-5',
    })
    assert.equal(s.pool_execution_limit, expected)
    assert.equal(s.available_now, expected)
  })
}
test('occupied accounts keep total capacity; cross-key occupancy and static cap reduce availability', () => {
  const s = summarizeCapacity({
    accounts: [account('a', 2, 2), account('b', 2, 1)],
    key: { ...key, max_concurrency: 3 },
    keyInflight: 2,
  })
  assert.equal(s.pool_execution_limit, 4)
  assert.equal(s.effective_admission_limit, 3)
  assert.equal(s.available_now, 1)
  assert.equal(s.pool_executing, 3)
})
test('duplicates do not multiply capacity; old static zero means uncapped but empty pool is rejected', () => {
  const s = summarizeCapacity({ accounts: [account('a', 3), account('a', 3)], key: { ...key, max_concurrency: 0 } })
  assert.equal(s.pool_execution_limit, 3)
  assert.equal(s.configured_key_limit, null)
  assert.equal(capacityGate(s, 3).code, 'channel_capacity_busy')
  const empty = summarizeCapacity({ accounts: [], key: { ...key, max_concurrency: 0 } })
  assert.equal(capacityGate(empty, 0).code, 'account_pool_exhausted')
  assert.equal(capacityGate({ ...empty, state_quality: 'partial' }, 0).code, 'channel_capacity_unavailable')
})
test('opt-in is scoped to explicit managed OAuth key IDs', () => {
  assert.equal(dynamicCapacityEnabled({}, key), false)
  assert.equal(dynamicCapacityEnabled({ channel_capacity: { key_ids: [key.id] } }, key), true)
  assert.equal(dynamicCapacityEnabled({ channel_capacity: { key_ids: [key.id] } }, { ...key, category: 'api' }), false)
})
test('real Key store: atomic competition, capacity shrink/recover and idempotent lifecycle cleanup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-keys-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = store.create({ max_concurrency: 10 })
  let limit = 1
  const snapshot = () =>
    summarizeCapacity({ accounts: [account('a', limit)], key: rec, keyInflight: store.inflight.get(rec.id) || 0 })
  const results = Array.from({ length: 20 }, () => store.acquire(rec, Date.now(), snapshot))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(store.inflight.get(rec.id), 1)
  limit = 0
  assert.equal(store.acquire(rec, Date.now(), snapshot).status, 503)
  assert.equal(store.inflight.get(rec.id), 1, 'do not kill existing request')
  store.release(rec)
  limit = 2
  assert.equal(store.acquire(rec, Date.now(), snapshot).ok, true)
  assert.equal(store.acquire(rec, Date.now(), snapshot).ok, true)
  assert.equal(store.acquire(rec, Date.now(), snapshot).status, 429)
  store.release(rec)
  store.release(rec)
  assert.equal(store.inflight.get(rec.id), undefined)
})
test('capacity authentication bypasses only transient Key gates, never disabled/quota checks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = store.create({ max_concurrency: 1, rpm: 1 })
  store.acquire(rec)
  assert.equal(store.canAccept(rec).ok, false)
  assert.equal(store.canAccept(rec, Date.now(), { capacityQuery: true }).ok, true)
  assert.equal(store.canAccept({ ...rec, status: 'disabled' }, Date.now(), { capacityQuery: true }).status, 403)
  assert.equal(
    store.canAccept({ ...rec, quota_requests: 1, quota_requests_used: 1 }, Date.now(), { capacityQuery: true }).ok,
    false,
  )
})
test('capacity endpoint rejects unsupported scopes/models without calling scheduler or acquiring slots', () => {
  const headers = {}
  const res = {
    setHeader: (k, v) => {
      headers[k] = v
    },
  }
  let response
  const deps = {
    requireAuth: (req, res, opts) => {
      assert.equal(opts.capacityQuery, true)
      return true
    },
    json: (res, status, body) => {
      response = { status, body }
    },
    apiKeyStore: { inflight: new Map() },
    scheduler: {
      channelCapacityAccounts: () => {
        throw new Error('should not run')
      },
    },
  }
  handleChannelCapacity({ url: '/v1/channel/capacity' }, res, deps)
  assert.equal(response.status, 400)
  handleChannelCapacity({ url: '/v1/channel/capacity?model=claude-haiku-4-5' }, res, deps)
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'capacity_scope_unsupported')
  assert.equal(headers['Cache-Control'], 'no-store')
})
