import { keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'
import { validateOfficialModel } from './models.mjs'
import { dynamicCapacityEnabled, summarizeCapacity } from '../pool/channel-capacity.mjs'

// Bound control-plane scan cost, independent of model RPM/concurrency permits.
const queries = new Map()
function allowCapacityQuery(id, now = Date.now()) {
  if (!id) return true // unsupported scopes are rejected below
  const bucket = queries.get(id)
  if (bucket && now - bucket.at < 1000) return ++bucket.count <= 10
  queries.delete(id)
  if (queries.size >= 1024) queries.delete(queries.keys().next().value)
  queries.set(id, { at: now, count: 1 })
  return true
}

export function capacityForRequest(req, model, { scheduler, apiKeyStore, routing }) {
  const key = req.apiKeyRecord
  const scope = keyScopeFromRequest(req)
  if (!key || key.category === 'api' || scope.group_type !== 'anthropic' || !scope.vm_pool_id) {
    throw Object.assign(new Error('Capacity requires a managed Claude OAuth pool key'), {
      status: 400,
      code: 'capacity_scope_unsupported',
    })
  }
  if (vmPoolDenial(scope))
    return summarizeCapacity({
      accounts: [],
      key,
      model,
      keyInflight: apiKeyStore.inflight.get(key.id) || 0,
      enabled: dynamicCapacityEnabled(routing, key),
    })
  return summarizeCapacity({
    accounts: scheduler.channelCapacityAccounts({
      model,
      keyScope: scope,
      ownerScope: ownerScopeFromRequest(req, apiKeyStore.users),
    }),
    key,
    model,
    keyInflight: apiKeyStore.inflight.get(key.id) || 0,
    enabled: dynamicCapacityEnabled(routing, key),
  })
}

export function capacityFailure(error) {
  return {
    status: error?.status || 503,
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: error?.code || 'channel_capacity_unavailable',
        message: error?.status === 400 ? error.message : 'Channel capacity is unavailable',
      },
    },
  }
}

export function handleChannelCapacity(req, res, { requireAuth, json, ...deps }) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAuth(req, res, { capacityQuery: true })) return
  if (!allowCapacityQuery(req.apiKeyRecord?.id)) {
    res.setHeader('Retry-After', '1')
    return json(res, 429, {
      type: 'error',
      error: { type: 'rate_limit_error', code: 'capacity_query_rate_limit', message: 'Capacity query rate exceeded' },
    })
  }
  const model = new URL(req.url, 'http://localhost').searchParams.get('model')
  const valid = validateOfficialModel(model)
  if (!valid.ok || !/^(claude-|sonnet|opus|haiku|fable)/i.test(model || '')) {
    return json(res, 400, {
      type: 'error',
      error: valid.error || { code: 'model_not_supported', message: 'Claude model required' },
    })
  }
  try {
    const snapshot = capacityForRequest(req, valid.model, deps)
    if (snapshot.state_quality === 'partial' && snapshot.pool_execution_limit === 0) {
      res.setHeader('Retry-After', '1')
      return json(res, 503, capacityFailure().body)
    }
    return json(res, 200, snapshot)
  } catch (error) {
    const failure = capacityFailure(error)
    if (failure.status === 503) res.setHeader('Retry-After', '1')
    return json(res, failure.status, failure.body)
  }
}
