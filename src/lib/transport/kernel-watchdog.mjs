/**
 * Host watchdog for rust PID-1 slots (recovery level L4/L5).
 *
 * The kernel recovers its own CLI first (close slot, ping, restart CLI) and
 * reports `healthy:false` only after that budget is spent. Then this restarts
 * the container via ensureRustKernel, a bounded number of times with growing
 * waits; when that is spent too, the VM is marked faulted, the scheduler skips
 * it and the operator is notified. Never falls back to kin-worker hop.
 */
import fs from 'node:fs'
import {
  kernelFaults,
  kernelStalls,
  rustKernelHealth,
  rustKernelNeedsRestart,
  rustKernelProcessUp,
  rustKernelPaths,
} from './rust-kernel-client.mjs'
import {
  ensureRustKernel,
  restartRustKernel,
  wrapHopInflight,
  readExistingKernelConfig,
  dataplaneUsesCcNode,
  WRAP_SLOT_MAX,
  slotContainerName,
} from './rust-kernel-supervisor.mjs'
import { resolveInferenceEngine } from '../vm/slot-engine.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { dockerRequest } from '../cluster/docker-remote.mjs'
import { clusterManager, vmNodeId } from '../cluster/placement.mjs'

/** A failed observation is not evidence of a dead container. Use the slot's own host, including KVM runners. */
export async function observeWatchdogContainer(
  vm,
  { hostFor = slotHost, request = dockerRequest, timeoutMs = 1500 } = {},
) {
  let timer
  try {
    const host = hostFor(vm)
    const name = slotContainerName({ vm })
    if (!name) return { state: 'unknown' }
    const observation = Promise.resolve().then(async () => {
      if (typeof host.observe === 'function') return host.observe(vm)
      const res = await request(host.dockerApi(), {
        path: `/containers/${encodeURIComponent(name)}/json`,
        timeoutMs,
      })
      if (res.status === 404) return { state: 'missing' }
      if (res.status !== 200) return { state: 'unknown' }
      const state = JSON.parse(res.body.toString('utf8'))?.State
      if (state?.Paused === true) return { state: 'paused' }
      if (state?.Restarting === true) return { state: 'restarting' }
      if (state?.Running === true) return { state: 'running' }
      if (state?.Running === false && ['created', 'exited', 'dead'].includes(state.Status)) return { state: 'stopped' }
      return { state: 'unknown' }
    })
    // Covers connector/SSH setup too, before dockerRequest's own HTTP timeout starts.
    return await Promise.race([
      observation,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown' }), timeoutMs)
      }),
    ])
  } catch {
    return { state: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

export const DEFAULT_KERNEL_WATCHDOG = Object.freeze({
  enabled: true,
  interval_sec: 20,
  timeout_ms: 15_000,
  // Wait before each container restart, including the first one.
  restart_backoff_sec: Object.freeze([60, 300, 900]),
  restart_window_sec: 3600,
  // Longer than the standard first-byte/session-idle budgets. Not a request timeout.
  orphan_stall_sec: 900,
})

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeKernelWatchdogConfig(raw = {}) {
  const backoff = Array.isArray(raw.restart_backoff_sec)
    ? raw.restart_backoff_sec.map((sec) => clampInt(sec, 10, 86_400, 0)).filter((sec) => sec > 0)
    : []
  return {
    enabled: raw.enabled !== false,
    interval_sec: clampInt(raw.interval_sec, 5, 300, DEFAULT_KERNEL_WATCHDOG.interval_sec),
    timeout_ms: clampInt(raw.timeout_ms, 3000, 60_000, DEFAULT_KERNEL_WATCHDOG.timeout_ms),
    restart_backoff_sec: backoff.length ? backoff : [...DEFAULT_KERNEL_WATCHDOG.restart_backoff_sec],
    restart_window_sec: clampInt(raw.restart_window_sec, 60, 86_400, DEFAULT_KERNEL_WATCHDOG.restart_window_sec),
    orphan_stall_sec: clampInt(raw.orphan_stall_sec, 60, 86_400, DEFAULT_KERNEL_WATCHDOG.orphan_stall_sec),
  }
}

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

export function isKernelWatchdogTarget(vm, routing = {}) {
  if (!vm?.id) return false
  if (HARD_DOWN.has(String(vm.status || '').toLowerCase())) return false
  // Effective engine, not the slot's own fields: panel-created slots omit
  // inference_engine and inherit routing.inference.engine (usually rust).
  return resolveInferenceEngine(vm, routing) === 'rust'
}

/** A node slot answers through an SSH relay across the ocean (~110ms RTT); 800ms misfires there. */
export const NODE_SLOT_HEALTH_TIMEOUT_MS = 3000

function clusterRelayPaths(nodeId, vmId) {
  return clusterManager().slotRelayPaths(nodeId, vmId)
}

/**
 * A node slot's kernel is reached only through its local relay; the vms/<id>/run
 * path never holds a socket there. Null when the relay is not listening: that is
 * a bridge fault for healBridges, never evidence that the remote kernel is dead.
 */
export function watchdogProbeVm(vm, { relayPaths = clusterRelayPaths, exists = fs.existsSync } = {}) {
  const nodeId = vmNodeId(vm)
  if (!nodeId) return vm
  let relays
  try {
    relays = relayPaths(nodeId, vm.id)
  } catch {
    return null
  }
  if (!relays?.kernel || !exists(relays.kernel)) return null
  return {
    ...vm,
    runtime: { ...(vm.runtime || {}), kernel_socket: relays.kernel, worker_socket: relays.worker },
  }
}

function kernelSlotMismatch(exec) {
  const configPath = rustKernelPaths(exec).configPath
  if (!configPath) return false
  const n = Number(readExistingKernelConfig(configPath).slots_per_worker)
  return Number.isFinite(n) && n !== WRAP_SLOT_MAX
}

export function createKernelWatchdog({
  config: initial = {},
  listTargets,
  getRouting = null,
  homeDirFor,
  ensure = ensureRustKernel,
  restart = restartRustKernel,
  // Unknown ownership must never authorize orphan recovery. Server supplies all pool reservations.
  getInflight = () => null,
  health = rustKernelHealth,
  observeRuntime = observeWatchdogContainer,
  onFault = null,
  revive = null,
  healBridges = null,
  probeVm = watchdogProbeVm,
  now = () => Date.now(),
} = {}) {
  let config = normalizeKernelWatchdogConfig(initial)
  let timer = null
  let running = false
  let inTick = false
  // vmId -> { attempts: [ms], nextAt }
  const restarts = new Map()
  // VMs under an operator power cycle: the watchdog must not restart them mid-cycle.
  const held = new Set()
  // vmId -> this tick's pending check/restart, so hold() can wait for it to settle.
  const inflight = new Map()
  const orphanObservations = new Map()
  let healingBridges = false

  function ownedHops(vm, exec) {
    const owned = getInflight(vm)
    if (owned == null || !Number.isFinite(Number(owned)) || Number(owned) < 0) return null
    return Math.max(Number(owned), wrapHopInflight(exec))
  }

  function orphanStalled(vm, exec, health) {
    const at = now()
    const m = health?.memory
    const knownCounters =
      m &&
      ['pending', 'running', 'inflight_payload'].every(
        (key) => m[key] != null && Number.isFinite(Number(m[key])) && Number(m[key]) >= 0,
      )
    const suspect =
      rustKernelProcessUp(health) &&
      health?.healthy !== false &&
      health?.recovering !== true &&
      health?.ready_slots != null &&
      Number(health.ready_slots) === 0 &&
      Number(health.cli_pid) > 0 &&
      knownCounters &&
      Number(m.pending) + Number(m.running) > 0 &&
      ownedHops(vm, exec) === 0
    if (!suspect) {
      orphanObservations.delete(vm.id)
      // Unknown/down health does not prove that a quarantined kernel recovered.
      if (
        rustKernelProcessUp(health) &&
        health?.healthy !== false &&
        health?.recovering !== true &&
        Number(health?.ready_slots) > 0
      )
        kernelStalls.delete(vm.id)
      return false
    }
    const signature = JSON.stringify([health.cli_pid, health.cli_restarts, m.pending, m.running, m.inflight_payload])
    const prev = orphanObservations.get(vm.id)
    const consecutive =
      prev && prev.signature === signature && at >= prev.at && at - prev.at <= config.interval_sec * 2500
    const observation = consecutive
      ? { ...prev, at, samples: prev.samples + 1 }
      : { signature, since: at, at, samples: 1 }
    orphanObservations.set(vm.id, observation)
    if (observation.samples < 3 || at - observation.since < config.orphan_stall_sec * 1000) return false
    if (!kernelStalls.has(vm.id)) {
      kernelStalls.set(vm.id, 'kernel orphan stall: no owned hops or occupancy change')
      console.warn(
        `[kernel-watchdog] ${vm.id} quarantined: ready=0 pending=${m.pending} running=${m.running} owned=0 age_ms=${at - observation.since}`,
      )
    }
    return true
  }

  function healBridgesOffPath(vms) {
    if (typeof healBridges !== 'function' || healingBridges) return
    healingBridges = true
    Promise.resolve()
      .then(() => healBridges(vms))
      .catch((error) => console.warn(`[kernel-watchdog] bridge heal failed: ${error?.message || error}`))
      .finally(() => {
        healingBridges = false
      })
  }

  /** L4 gate: bounded container restarts with growing waits; spending them is L5. */
  function admitRestart(vm, reason, at) {
    if (kernelFaults.has(vm.id)) return false
    const state = restarts.get(vm.id) || { attempts: [], nextAt: at + config.restart_backoff_sec[0] * 1000 }
    state.attempts = state.attempts.filter((t) => at - t < config.restart_window_sec * 1000)
    restarts.set(vm.id, state)
    if (at < state.nextAt) return false
    const backoff = config.restart_backoff_sec
    if (state.attempts.length >= backoff.length) {
      const fault = `kernel unhealthy after ${state.attempts.length} container restarts: ${reason}`
      kernelFaults.set(vm.id, fault)
      console.error(`[kernel-watchdog] ${vm.id} faulted; scheduling skips it: ${fault}`)
      if (typeof onFault === 'function') {
        try {
          onFault(vm, fault)
        } catch (error) {
          console.warn(`[kernel-watchdog] fault notify failed: ${error?.message || error}`)
        }
      }
      return false
    }
    state.attempts.push(at)
    const nextDelay = backoff[state.attempts.length] ?? config.interval_sec
    state.nextAt = at + nextDelay * 1000
    return true
  }

  /** One VM's check. `held` is re-read after every await: an operator cycle may start mid-check. */
  async function reviveDownContainer(vm, state) {
    if (vm.status !== 'running' || typeof revive !== 'function') return
    if (!admitRestart(vm, `container ${state}`, now())) return
    const revived = await revive(vm)
    if (!revived?.ok) console.warn(`[kernel-watchdog] ${vm.id} boot failed: ${revived?.error || revived?.code}`)
  }

  async function checkVm(vm, routing) {
    const probed = probeVm(vm)
    if (!probed) {
      // The kernel cannot be probed without its relay; only a container that is really down is revived.
      const observed = await observeRuntime(vm)
      if (held.has(vm.id) || !['missing', 'stopped', 'restarting'].includes(observed?.state)) return
      return reviveDownContainer(vm, observed.state)
    }
    const exec = {
      vmId: vm.id,
      vm: probed,
      homeDir: typeof homeDirFor === 'function' ? homeDirFor(vm) : null,
    }
    const current = await health(exec, { timeoutMs: vmNodeId(vm) ? NODE_SLOT_HEALTH_TIMEOUT_MS : 800 })
    if (held.has(vm.id)) return
    // cc-node is the crag worker. Restarting a live kernel SIGKILLs it.
    if (dataplaneUsesCcNode(exec) && rustKernelProcessUp(current)) return
    const stalled = orphanStalled(vm, exec, current)
    if (!rustKernelNeedsRestart(current) && !stalled) {
      // Healthy again after a fault means someone fixed it: start a fresh budget.
      // Plain recovery keeps past attempts so a crash loop stays bounded by the window.
      if (!kernelStalls.has(vm.id) && kernelFaults.delete(vm.id)) restarts.delete(vm.id)
      // Config convergence, not a failure: outside the restart budget.
      if (kernelSlotMismatch(exec)) {
        const observed = await observeRuntime(vm)
        if (!held.has(vm.id) && observed?.state === 'running') await ensure(exec, { timeoutMs: config.timeout_ms })
      }
      return
    }
    const reason = stalled
      ? kernelStalls.get(vm.id)
      : current?.unhealthy_reason || current?.error || 'kernel process down'
    const observed = await observeRuntime(vm)
    if (held.has(vm.id)) return
    // Permission/transport failures and deliberately paused containers never authorize recovery.
    if (!['running', 'missing', 'stopped', 'restarting'].includes(observed?.state)) return
    if (observed.state !== 'running') return reviveDownContainer(vm, observed.state)
    // Re-check ownership after the asynchronous runtime observation, before any destructive action.
    if (stalled && ownedHops(vm, exec) !== 0) return
    if (!admitRestart(vm, reason, now())) return
    console.warn(`[kernel-watchdog] ${vm.id} restarting container: ${reason}`)
    // ensure() intentionally leaves a live busy kernel alone; a confirmed orphan stall needs a real restart.
    const result = await (stalled ? restart : ensure)(exec, { timeoutMs: config.timeout_ms })
    if (held.has(vm.id)) return
    // The container itself is gone or exited: a kernel restart cannot help, a full boot can.
    if (result?.reason === 'container_unavailable' && typeof revive === 'function' && vm.status === 'running') {
      // The container may disappear during ensure; do not mistake a daemon/permission error for absence.
      const latest = await observeRuntime(vm)
      if (held.has(vm.id) || !['missing', 'stopped', 'restarting'].includes(latest?.state)) return
      console.warn(`[kernel-watchdog] ${vm.id} container unavailable; booting slot`)
      const revived = await revive(vm).catch((error) => ({ ok: false, error: error?.message || String(error) }))
      if (!revived?.ok) console.warn(`[kernel-watchdog] ${vm.id} boot failed: ${revived?.error || revived?.code}`)
    }
  }

  async function tick() {
    if (inTick || !config.enabled) return
    inTick = true
    try {
      const vms = (typeof listTargets === 'function' ? listTargets() || [] : []).filter((vm) => !held.has(vm?.id))
      // Bridges (kin-egress, cluster relays) are cheap host helpers, not containers: outside the restart budget.
      healBridgesOffPath(vms)
      // Panel can change routing.inference.engine without restarting this process.
      const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
      for (const vm of vms) {
        if (held.has(vm.id)) continue
        if (!isKernelWatchdogTarget(vm, routing)) continue
        const work = checkVm(vm, routing)
        inflight.set(vm.id, work)
        try {
          await work
        } catch {
          // One failed probe/recovery must not starve later slots or reject an interval's promise.
          console.warn(`[kernel-watchdog] ${vm.id} check failed; skipping this tick`)
        } finally {
          if (inflight.get(vm.id) === work) inflight.delete(vm.id)
        }
      }
    } catch {
      console.warn('[kernel-watchdog] tick failed; retrying at the next interval')
    } finally {
      inTick = false
    }
  }

  return {
    setConfig(next) {
      config = normalizeKernelWatchdogConfig(next || {})
    },
    start({ immediate = true } = {}) {
      if (running) return
      running = true
      if (immediate) void tick()
      timer = setInterval(() => void tick(), config.interval_sec * 1000)
      timer.unref?.()
    },
    stop() {
      running = false
      clearInterval(timer)
      timer = null
    },
    tick,
    /** Keep the watchdog off a VM; resolves once any check/restart already running for it has settled. */
    hold(vmId) {
      held.add(vmId)
      const pending = inflight.get(vmId)
      if (!pending) return Promise.resolve()
      return pending.then(
        () => {},
        () => {},
      )
    },
    release(vmId) {
      held.delete(vmId)
    },
    /** Operator recovery: drop the L5 fault and spent budget so the next failure starts fresh. */
    reset(vmId) {
      const faulted = kernelFaults.delete(vmId)
      kernelStalls.delete(vmId)
      orphanObservations.delete(vmId)
      restarts.delete(vmId)
      return { faulted }
    },
    restartsInWindow(vmId) {
      const state = restarts.get(vmId)
      if (!state) return 0
      const at = now()
      return state.attempts.filter((t) => at - t < config.restart_window_sec * 1000).length
    },
  }
}
