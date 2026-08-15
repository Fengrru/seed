# 历史压缩设计稿(History Compaction Design)

> 目标:让长会话的 decide 成本从 O(n²) 降到有界,同时不破坏事件日志的 append-only 审计性和 harvest/judge 的输入质量。
> 核心命题:**压缩是会话层的数据策略,不是内核机制**。日志永远是完整的事实源;压缩只改变"喂给模型的视图"。
> 本文档是设计稿,供评审;批准后按第五节分阶段实施。

---

## 1. 现状与问题

`src/model/openai.ts` 的 `historyToMessages` 每次 decide 都重发**整个会话历史**,并以 60k 字符预算从尾部截断(P0 修复后截断已不会产生孤立 tool 消息)。三个问题随会话长度放大:

1. **token 成本 O(n²)**。一个 100 步的会话,第 100 次 decide 要重发前 99 步的全部内容。
2. **截断静默丢上下文**。预算耗尽时最早的消息被整体丢弃,模型对"任务为什么开始"失去记忆;被丢掉的恰好是最早的目标陈述。
3. **恢复会话的复利**。`reconstructHistory` 把历史全部展开,跨多次 run 的持久会话(turn → … → done 反复追加)会让问题 1 每轮翻倍。

## 2. 设计原则

1. **日志不动**。事件日志保持 append-only、完整、可重放。压缩只产生新事件,不修改、不删除已有事件。
2. **机制是数据**。压缩产物写成新事件类型 `compact`,摘要本身是可审计、可引用的数据。
3. **循环保持薄**。压缩发生在会话层(`agent.runSession` 组装历史之后、`run()` 之前),`kernel/loop.ts` 不感知压缩的存在。
4. **边界安全**。压缩单元是"完整轮次",绝不切断 `assistant-tool`/`tool` 消息对——这是 60k 截断修复(P0)买来的教训,压缩设计上直接绕开它。
5. **收敛性优先**。摘要失真会让模型基于错误上下文决策,其危害由使用反馈环兜底:错误决策 → 失败 verdict → 相关记忆降权。

## 3. 机制设计

### 3.1 压缩单元:轮

一轮 = 一个 `turn` 事件到其对应 `done` 事件之间的完整区间(含全部 step/result/verdict 事件)。只压缩**完整**的轮;当前进行中的轮(最近一次 turn 之后)永不压缩。

工作历史(喂给 decide 的 history)由两部分组成:

```
[轮 1 摘要] [轮 2 摘要] … [轮 k 摘要] [最近未压缩轮次的完整事件]
```

### 3.2 触发条件

`agent.runSession` 在 `reconstructHistory` 之后检查:若序列化后的工作历史超过 `COMPACT_THRESHOLD`(默认 30k 字符,可配置,`0` 禁用),从最早的完整轮开始折叠,直到低于阈值或仅剩最近一轮。

确定性、同步、无模型调用——与 consolidate 的"摊销、无定时器"风格一致。

### 3.3 数据模型:新事件类型 `compact`

```ts
// EventSchema 新增变体
z.object({
  type: z.literal("compact"),
  id: z.string(),
  ts: z.number(),
  sessionId: z.string(),
  covers: z.array(z.string()),   // 被折叠的事件 id(内容寻址,可校验)
  summary: z.string(),           // 折叠后的视图
})
```

- **I7 模式**:`covers` 里的 id 写入前必须通过 `validEvidenceIds` 校验(与 harvest/memory 写入同一道门)。
- **I8 满足**:压缩动作本身留痕,可审计、可回放。
- 不引入新知识对象:摘要属于会话期数据,与 `task` 事件同理,只进事件流。

### 3.4 摘要生成:两阶段

**Phase 1(确定性摘要,默认)**。无模型调用,格式固定:

```
[compacted turn] goal: <goal>
  steps: <tool1>(<参数截断 80 字符>), <tool2>(…), …  (共 N 步,失败 M 次)
  outcome: <done 的 answer 截断 500 字符> / max_steps / error
```

信息密度高、零成本、可回归测试(输出是纯函数)。

**Phase 2(模型摘要,可选开关 `compactModel: true`)**。把被折叠的轮次渲染成 transcript(复用 `renderTranscript`),调用一次模型(复用 harvest 的调用形态,带超时与失败回退)压缩成一段 ≤ 800 字符的文字。失败时**回退到 Phase 1 的确定性摘要**,压缩永不阻塞运行。默认关闭:每一轮压缩都花钱,且引入失真风险,先用确定性版本验证机制。

### 3.5 重放语义(`reconstructHistory`)

重放一个会话时遇到 `compact` 事件:其 `covers` 覆盖的事件**不展开**为历史项(它们仍在日志里,供 harvest/judge/审计),折叠为一条 `assistant-text` 摘要消息:

```
[earlier turns summarized] <summary>
```

实现上:重放前先把 `compact` 事件的 covers 集合求并集,重放时跳过其中的事件;covers 校验失败的 compact 事件(引用丢失/被篡改)按"不可信"处理,**忽略折叠、照常展开被覆盖事件**——退化到今天的全量历史行为,只损失压缩收益,不损失正确性。

### 3.6 与 harvest / judge / meta 的交互

- **harvest**:继续吃完整事件流的 `renderTranscript` 输出,压缩不影响蒸馏质量——学习环看事实,不看视图。
- **judge**:已自带 8000 字符窗口,不受影响。
- **meta / guidance**:读事件流统计,不受影响。
- **反馈环**:`recordOutcome` 的注入条目与被压缩的历史无关,不受影响。

## 4. 失败模式与兜底

| 失败 | 兜底 |
|---|---|
| 摘要失真(Phase 2 模型摘要胡说) | 使用反馈环:错误上下文 → 失败 verdict → 相关记忆降权/标 stale;且 Phase 2 默认关 |
| 模型摘要调用失败/超时 | 回退 Phase 1 确定性摘要;压缩过程从不抛错 |
| compact 事件的 covers 校验失败 | 忽略该压缩,展开原始事件(全量历史,仅损失压缩收益) |
| 压缩后历史仍超预算(极端:单条消息巨大) | 60k 截断仍作为最后防线(已修复孤立消息问题) |
| 跨 run 的持久会话 | 每轮 run 开头重放时折叠旧轮;新轮在下次 run 才被折叠——语义一致 |

## 5. 分阶段实施计划

### Phase 1:确定性压缩(约 200 行 + 250 行测试)

- `EventSchema` 增加 `compact` 变体。
- 新模块 `src/session/compact.ts`:纯函数 `buildCompact(summary)`、`foldRounds(events, threshold)`(返回折叠后的历史项 + 新 compact 事件列表)、`summarizeRound(turn 区间事件)`(确定性摘要)。
- `agent.runSession`:组装历史后调用 `foldRounds`;产生的 compact 事件经 `validEvidenceIds` 校验 covers 后 append 到日志。
- `reconstructHistory`:支持 covers 折叠与损坏回退。
- 测试:折叠阈值边界(恰好低于/高于阈值);只折叠完整轮;covers 全部可校验;损坏 compact 事件回退全量展开;harvest transcript 仍含完整事件流;持久会话跨 run 折叠。

### Phase 2:模型摘要(可选,约 100 行 + 120 行测试)

- `AgentOptions.compactModel?: boolean`(默认 false)+ `compactTimeoutMs`。
- 摘要调用复用 OpenAI 适配器形态;失败回退确定性摘要。
- 测试:摘要成功替换、失败回退、超时不阻塞运行。

## 6. 明确不做

- **不做事件日志的物理压缩/删除/归档**。日志是审计源,append-only 不可谈判;压缩只影响视图。
- **不把摘要写入知识库**。摘要是会话期数据;跨会话的持久知识走 harvest,两者职责不混。
- **不引入摘要检索/向量**。摘要只在会话重放时按时间顺序注入,不参与知识检索排序。
- **不压缩当前轮**。进行中的 tool 调用对必须保持完整,否则重蹈孤立消息覆辙。
- **不改 `kernel/loop.ts`**。压缩是会话层策略,内核保持对"history 已就绪"的假设。

## 7. 验收标准

- `bun run check` 全绿;新增测试覆盖 §5 所列场景。
- 一个 100 步会话的 decide 请求体大小有界(阈值 + 最近轮),不再随会话长度线性增长。
- 事件日志不变量保持:append-only、I6/I7/I8 全部成立;harvest 输入与压缩前一致。

---

## Implementation status (both phases shipped)

| Phase | Scope | Status |
|---|---|---|
| 1 | Deterministic compaction: `compact` event (verified `covers` + deterministic summary), `src/session/compact.ts` (`summarizeRound`, `planCompaction`), `reconstructHistory` fold + corrupt-compact fallback, `AgentOptions.compactThreshold` (default 30 000, `0` disables), `SEED_COMPACT_THRESHOLD` | ✅ shipped |
| 2 | Model-based summarization: `Model.summarizeRounds` (OpenAI adapter, 60s timeout, 30k transcript cap, 800-char summary cap), `AgentOptions.compactModel` (default off) + `SEED_COMPACT_MODEL=1`, deterministic fallback on any failure | ✅ shipped |

Verification: `bun run check` green — typecheck + biome + 232 tests.

Implementation notes:

1. **Compacts are appended after the round they fold**, so on the next replay the
   summary appears in the prefix block before the live rounds — chronological order is
   preserved even though the log order is append-order.
2. **The most recent round is never foldable** (`segments.slice(0, -1)`), so a round folds
   with one run of lag: it becomes a candidate as soon as a newer round exists.
3. **Reconstruction measures exactly**: `planCompaction` re-reconstructs the history per
   candidate with `skipIds`, an O(rounds × events) pass that runs once per session run.
4. **Phase 2 fails closed**: a missing, throwing, or empty model summary always falls back
   to the deterministic format, and the phase stays opt-in (`compactModel`/`SEED_COMPACT_MODEL`).
