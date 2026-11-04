/** Capacity is advisory, never a reservation. All counters are process-local. */
export function dynamicCapacityEnabled(routing, key) {
  const ids = routing?.channel_capacity?.key_ids
  return !!key && key.category !== 'api' && Array.isArray(ids) && ids.includes(key.id)
}

export function summarizeCapacity({ accounts, key, keyInflight = 0, model, enabled = false, now = Date.now() }) {
  const unique = new Map()
  for (const a of accounts) {
    // Duplicate credentials must not multiply capacity. Use the conservative view.
    const prev = unique.get(a.accountId)
    if (!prev) unique.set(a.accountId, a)
    else
      unique.set(a.accountId, {
        ...a,
        limit: Math.min(prev.limit, a.limit),
        executing: Math.max(prev.executing, a.executing),
        available: Math.min(prev.available, a.available),
        draining: prev.draining || a.draining,
        unknown: prev.unknown || a.unknown,
      })
  }
  const rows = [...unique.values()]
  const configured = Number(key.max_concurrency) > 0 ? Number(key.max_concurrency) : null
  const total = rows.reduce((sum, a) => sum + a.limit, 0)
  const effective = configured == null ? total : Math.min(configured, total)
  return {
    schema_version: 1,
    model,
    observed_at: new Date(now).toISOString(),
    max_age_ms: 1000,
    state_quality: rows.some((a) => a.unknown) ? 'partial' : 'known',
    dynamic_admission_enabled: enabled,
    configured_key_limit: configured,
    pool_execution_limit: total,
    effective_admission_limit: effective,
    key_inflight: keyInflight,
    pool_executing: rows.reduce((sum, a) => sum + a.executing, 0),
    available_now: Math.max(
      0,
      Math.min(
        effective - keyInflight,
        rows.reduce((sum, a) => sum + a.available, 0),
      ),
    ),
    accounts: {
      normal: rows.filter((a) => a.limit > 0 && !a.draining).length,
      draining: rows.filter((a) => a.limit > 0 && a.draining).length,
      unavailable: rows.filter((a) => a.limit <= 0).length,
    },
  }
}

export function capacityGate(snapshot, inflight) {
  if (snapshot.state_quality === 'partial' && snapshot.pool_execution_limit === 0)
    return {
      ok: false,
      status: 503,
      code: 'channel_capacity_unavailable',
      message: 'Channel capacity is unavailable',
    }
  if (snapshot.effective_admission_limit <= 0)
    return {
      ok: false,
      status: 503,
      code: 'account_pool_exhausted',
      message: 'No eligible Claude accounts remain',
    }
  if (inflight >= snapshot.effective_admission_limit || snapshot.available_now <= 0)
    return {
      ok: false,
      status: 429,
      code: 'channel_capacity_busy',
      message: 'Channel execution capacity is busy',
    }
  return { ok: true }
}
