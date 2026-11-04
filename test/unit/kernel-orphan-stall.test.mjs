import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import * as client from '../../src/lib/transport/rust-kernel-client.mjs'
import { beginWrapHop, endWrapHop } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

function fixture(t, overrides = {}) {
  let time = 0
  let owned = 0
  let status = {
    ok: true,
    healthy: true,
    ready_slots: 0,
    cli_pid: 1481,
    memory: { pending: 20, running: 1, inflight_payload: 13288961 },
  }
  const calls = []
  const vm = { id: 'orphan-test', status: 'running', inference_engine: 'rust' }
  const wd = createKernelWatchdog({
    config: { orphan_stall_sec: 60, restart_backoff_sec: [10, 20] },
    listTargets: () => [vm],
    now: () => time,
    getInflight: () => owned,
    health: async () => status,
    ensure: async () => ({ ok: true }),
    observeRuntime: async () => ({ state: 'running' }),
    restart: async () => {
      calls.push(time)
      return { ok: true }
    },
    ...overrides,
  })
  t.after(() => {
    wd.reset(vm.id)
    wd.stop()
  })
  return {
    wd,
    vm,
    calls,
    setOwned: (value) => {
      owned = value
    },
    setStatus: (value) => {
      status = value
    },
    status: () => status,
    tick: async (at) => {
      time = at
      await wd.tick()
    },
  }
}

test('orphaned full kernel is quarantined then force-recovered with bounded retries', async (t) => {
  const fx = fixture(t)
  for (const at of [0, 20000, 40000, 60000]) await fx.tick(at)
  assert.equal(client.kernelStalls?.has(fx.vm.id), true, 'stop new dispatch before restart')
  assert.deepEqual(fx.calls, [])
  await fx.tick(80000)
  assert.deepEqual(fx.calls, [80000])
  await fx.tick(100000)
  assert.deepEqual(fx.calls, [80000, 100000])
  await fx.tick(120000)
  assert.equal(client.kernelFaults.has(fx.vm.id), true)
  await fx.tick(200000)
  assert.equal(fx.calls.length, 2)
  fx.setStatus({
    ok: true,
    healthy: true,
    ready_slots: 20,
    cli_pid: 1500,
    memory: { pending: 0, running: 0, inflight_payload: 0 },
  })
  await fx.tick(220000)
  assert.equal(client.kernelStalls.has(fx.vm.id), false)
  assert.equal(client.kernelFaults.has(fx.vm.id), false)
})

test('owned long jobs and changing native occupancy reset orphan observations', async (t) => {
  const fx = fixture(t)
  fx.setOwned(1)
  for (const at of [0, 20000, 40000, 60000, 80000]) await fx.tick(at)
  assert.equal(client.kernelStalls?.has(fx.vm.id) || false, false)
  fx.setOwned(0)
  await fx.tick(100000)
  await fx.tick(120000)
  fx.setStatus({ ...fx.status(), memory: { ...fx.status().memory, pending: 19 } })
  await fx.tick(140000)
  await fx.tick(160000)
  await fx.tick(180000)
  assert.equal(client.kernelStalls?.has(fx.vm.id) || false, false)
  assert.deepEqual(fx.calls, [])
})

test('missing ownership/health, recovering CLI and observation gaps never authorize orphan restart', async (t) => {
  for (const override of [
    { getInflight: () => null },
    { health: async () => ({ ok: true, healthy: true, ready_slots: 0, recovering: true, cli_pid: 1 }) },
    { health: async () => null },
  ]) {
    const fx = fixture(t, override)
    for (const at of [0, 20000, 40000, 60000, 80000]) await fx.tick(at)
    assert.deepEqual(fx.calls, [])
  }
  const fx = fixture(t)
  await fx.tick(0)
  await fx.tick(900000)
  await fx.tick(920000)
  assert.equal(client.kernelStalls?.has(fx.vm.id) || false, false)
})

test('a reservation arriving during runtime observation prevents destructive recovery', async (t) => {
  let fx
  let race = false
  fx = fixture(t, {
    observeRuntime: async () => {
      if (race) fx.setOwned(1)
      return { state: 'running' }
    },
  })
  for (const at of [0, 20000, 40000, 60000]) await fx.tick(at)
  race = true
  await fx.tick(80000)
  assert.deepEqual(fx.calls, [])
})

test('tracked diagnostic hops protect long native work even without a pool reservation', async (t) => {
  const fx = fixture(t)
  const exec = { vmId: fx.vm.id }
  beginWrapHop(exec)
  try {
    for (const at of [0, 20000, 40000, 60000, 80000]) await fx.tick(at)
    assert.equal(client.kernelStalls.has(fx.vm.id), false)
    assert.deepEqual(fx.calls, [])
  } finally {
    endWrapHop(exec)
  }
})

test('unused ready slots do not hide orphaned work that blocks the CLI', async (t) => {
  const fx = fixture(t)
  fx.setStatus({ ...fx.status(), ready_slots: 10, memory: { pending: 10, running: 1, inflight_payload: 1000 } })
  for (const at of [0, 20000, 40000, 60000, 80000]) await fx.tick(at)
  assert.deepEqual(fx.calls, [80000])
  assert.equal(client.kernelStalls.has(fx.vm.id), true)
  // Free slots alone are not proof of cleanup; the lingering running job remains quarantined.
  await fx.tick(100000)
  assert.equal(client.kernelStalls.has(fx.vm.id), true)
  fx.setStatus({ ...fx.status(), ready_slots: 20, memory: { pending: 0, running: 0, inflight_payload: 0 } })
  await fx.tick(120000)
  assert.equal(client.kernelStalls.has(fx.vm.id), false)
})
