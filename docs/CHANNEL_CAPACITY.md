# Claude 渠道实时容量

`GET /v1/channel/capacity?model=<Claude模型>` 使用渠道现有调用 Key 鉴权，返回该 Key 可访问的 Claude OAuth 池容量。仅支持绑定命名池的 managed Claude Key；Master、Codex 与直连 API Key 不支持。模型使用与推理接口相同的官方模型名或别名。

查询不占用推理并发，不探测上游、不刷新凭据、不预留位置，不返回账号 ID 或秘密。响应带 `Cache-Control: no-store`。每把 Key 每秒最多查询 10 次，超限返回 `429 capacity_query_rate_limit` 和 `Retry-After: 1`。禁用、过期、额度耗尽的 Key 仍受原鉴权规则限制。

## 响应字段

| 字段 | 含义 |
|---|---|
| `schema_version` | 当前为 1 |
| `model` | 规范化后的模型名 |
| `observed_at` / `max_age_ms` | 快照时间 / 建议有效期（1000ms） |
| `state_quality` | `known` 或 `partial`；未知账号按零容量保守处理 |
| `dynamic_admission_enabled` | 当前 Key 是否开启动态准入 |
| `configured_key_limit` | 原静态 Key 上限；`null` 表示静态无限制 |
| `pool_execution_limit` | 去重账号的有效并发贡献之和，不因正在执行而下降 |
| `effective_admission_limit` | 池容量与静态 Key 上限的较小值 |
| `key_inflight` | 此 Key 已准入且未释放的请求，包含内部等待 |
| `pool_executing` | 池内执行占用，包含其他 Key/模型对共享账号的占用 |
| `available_now` | 同时扣除 Key 与账号占用后的保守可用数 |
| `accounts` | `normal`、`draining`、`unavailable` 的账号数量 |

正常账号贡献现有调度器的有效并发数，drain 账号最多贡献 1，不可用账号贡献 0。沿用现有额度、健康缓存、模型资格、冷却、RPM、熔断及执行资源限制，不另设额度阈值。重复账号保守去重。两个基础并发为 2 的账号正常时容量为 4；一正常一 drain 为 3；两个 drain 为 2；全部不可用为 0。状态不可确定且没有已知可用容量时返回 `503 channel_capacity_unavailable`，而非报告确定的零容量。

这是进程本地即时快照，不是容量租约，也不承诺任意会话零等待。亲和目标、其他 Key、模型共享账号和查询后的状态变化都可能带来等待或竞争拒绝。单进程计数不能用于宣称多 VM2API 副本的全局一致准入。

## 显式启用动态准入

默认关闭，查询接口仍可使用。管理员通过现有私有面板接口 `PUT /api/panel/routing` 配置完整启用名单（填写 Key ID，不是调用密钥）：

```json
{"channel_capacity":{"key_ids":["key_0123456789ab"]}}
```

空名单关闭动态准入。该配置不改账号并发，也不替代原静态上限；例如静态上限为 4 时，池扩大至 6 后仍最多准入 4，需另行调整静态上限。静态值 0 仍表示无限制，但动态池容量为 0 时不会因此无限放行。

开启后，在 Claude 推理的 Key 准入处同步重算容量，无异步检查与占用之间的竞争窗口。容量下降不终止已有流，只限制新请求；原有清理路径释放计数。

新错误包括 `429 channel_capacity_busy`、`503 account_pool_exhausted`、`503 channel_capacity_unavailable`，均带 `Retry-After: 1`。原静态 Key 门禁和鉴权错误仍可能先返回，保持既有协议。调用方不应对请求体不变的瞬时错误无界立即重试。

## 中转接入顺序

1. 先以现有调用 Key 按实际请求模型查询容量，建议每秒一次，记录快照时间。
2. 速度优先时分流；可等待时在中转排队，并在已有请求结束或容量恢复后补发。`available_now` 已扣占用，不要重复扣减同一快照占用。
3. 快照失效或查询失败时，不把历史值继续当作实时保证；有限等待、重新查询或转其他渠道。
4. 能处理竞争拒绝与零容量恢复后，再由管理员开启该 Key 的动态准入。

多个中转副本仍需协调派发，不能各自把同一个可用数重复消费。VM2API 保留最终门禁；本功能不增加服务端队列、分布式存储或会话迁移策略。

回退时移除启用名单中的 Key，保留原静态上限和原调度，无数据库迁移。
