import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api, readTrace } from '../harness.mjs'

test('real server: managed capacity auth, opt-in, zero capacity and disabled-gate fallback', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'pong' })
  try {
    const pool = await api(gw, 'POST', '/api/panel/vm-pools', {
      body: { name: 'capacity-test', vm_ids: ['vm-sim-01'] },
    })
    assert.equal(pool.status, 201, pool.text)
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: {
        name: 'capacity-test',
        category: 'oauth',
        group_type: 'anthropic',
        vm_pool_id: pool.json.data.pool.id,
        max_concurrency: 4,
      },
    })
    assert.equal(created.status, 201, created.text)
    const id = created.json.item.id
    const revealed = await api(gw, 'POST', `/api/panel/api-keys/${id}/reveal`)
    const auth = { authorization: `Bearer ${revealed.json.key}` }
    const query = '/v1/channel/capacity?model=claude-haiku-4-5'
    const invalid = await fetch(gw.baseUrl + query, { headers: { authorization: 'Bearer invalid-test-key' } })
    assert.equal(invalid.status, 401)
    const missing = await api(gw, 'GET', '/v1/channel/capacity', { headers: auth })
    assert.equal(missing.status, 400)
    const first = await api(gw, 'GET', query, { headers: auth })
    assert.ok([200, 503].includes(first.status), first.text)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(readTrace(gw), null, 'capacity query must not call model')
    const patched = await api(gw, 'PUT', '/api/panel/routing', { body: { channel_capacity: { key_ids: [id] } } })
    assert.equal(patched.status, 200, patched.text)
    const hold = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/schedulable', { body: { schedulable: false } })
    assert.equal(hold.status, 200, hold.text)
    const zero = await api(gw, 'GET', query, { headers: auth })
    assert.equal(zero.status, 200, zero.text)
    assert.equal(zero.json.pool_execution_limit, 0)
    assert.equal(zero.json.effective_admission_limit, 0)
    assert.equal(zero.json.dynamic_admission_enabled, true)
    const inferred = await api(gw, 'POST', '/v1/messages', {
      headers: auth,
      body: {
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
    })
    assert.equal(inferred.status, 503, inferred.text)
    assert.equal(inferred.json.error.code, 'account_pool_exhausted')
    assert.equal(inferred.headers.get('retry-after'), '1')
    assert.equal(readTrace(gw), null)
    const restored = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/schedulable', { body: { schedulable: true } })
    assert.equal(restored.status, 200, restored.text)
    await api(gw, 'PUT', '/api/panel/routing', { body: { channel_capacity: { key_ids: [] } } })
    const legacy = await api(gw, 'POST', '/v1/messages', {
      headers: auth,
      body: {
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      },
    })
    // The old harness seeds a Go mock, while this release requires Rust.
    // Verify fallback reaches the legacy kernel path, not a synthetic success.
    assert.equal(legacy.status, 503, legacy.text)
    assert.equal(legacy.json.error.code, 'upstream_error')
    assert.match(legacy.json.error.message, /rust kernel is not available/)
  } finally {
    await gw.stop()
  }
})
