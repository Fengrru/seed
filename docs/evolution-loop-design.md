# Seed 进化闭环设计（Evolution Loop Design）

> 目标：让 seed 成为「下一个范式」的 agent —— 极简、优雅、动态，能处理复杂任务，且**越用越聪明**。
> 核心命题：**智能在基座里，不在循环里**。循环保持笨和薄；知识（版本化、带证据、可验证）是程序，模型是解释器。
> 本文档是设计稿，供评审；批准后按第七节分阶段实施。

---

## 1. 设计原则（不可谈判）

1. **一切机制都是数据，不是代码。** 任务、证据、派生关系、巩固结果，全部表达为事件（event log）或知识对象（knowledge store）。新机制 = 新事件类型 + 新知识字段，而不是新子系统。
2. **循环保持薄。** `kernel/loop.ts` 目标 < 800 行（当前约 260 行）。任何让循环变厚的功能都要先问「这能不能是数据」。
3. **所有自我写入走同一道门。** 模型产出的知识一律 draft → verify → active；使用反馈和证据只能**修改排序、标 stale、产生新版本**，永远不原地删除（append-only）。
4. **证据先于信任。** 一条知识被注入上下文时，其证据必须可追溯；证据失效时，依赖它的知识必须级联失效。
5. **收敛性优先于聪明。** 自进化的最大风险是发散（垃圾进 → 垃圾记忆 → 更垃圾的决策）。每一环都要有把「低质量自我写入」过滤掉或淘汰掉的机制。

## 2. 现状差距清单

| 愿景要求 | 现状 | 差距 |
|---|---|---|
| 极简 | ✅ 2400 行内核，分层干净 | 保持即可，新增机制需有行数预算 |
| 优雅 | ✅ 事件溯源 + I6 + draft→verified | evidence 是空心指针（stepId 字符串） |
| 动态 | ❌ 连接表固定、工作集快照式、知识只增不减 | 缺使用反馈、级联失效、巩固/遗忘 |
| 复杂任务 | ⚠️ 有 delegate，无任务树、无并行工具 | 缺两个复杂度原语（见 §5.5、§5.6） |
| 自进化 | ⚠️ harvest/meta/verify 存在但默认全关，`recordOutcome` 是死代码 | 闭环断在三处（见 §3） |
| 越用越聪明 | ❌ 检索排序不用使用指标，无巩固 | 缺 §5.1 与 §5.4 |

## 3. 总览：四个闭环 + 两个复杂度原语 + 两个防退化件

```
                     ┌────────────────────────────────────────────┐
                     │              知识基座 (knowledge)            │
                     │  draft ──verify──▶ active ──usage──▶ 晋升   │
                     │    │                  │               │     │
                     │    │              证据失效         久未用    │
                     │    ▼                  ▼               ▼     │
                     │  (保持 draft)       stale ◀─────────────┘   │
                     │    ▲                  │                      │
                     │    └── re-verify ─────┘                      │
                     └───────────────┬──────────────────────────────┘
                                     │ 注入 (retriever + metrics 排序)
        ┌────────────────────────────▼────────────────────────────┐
        │                      内核循环 (thin)                      │
        │  decide → [steps] → 顺序执行 → verdict → feedback        │
        │  任务树(数据)  doom-loop  length-stop                    │
        └────────────────────────────┬────────────────────────────┘
                                     │ 事件流 (event log, 内容寻址)
        ┌────────────────────────────▼────────────────────────────┐
        │   harvest(学习) → consolidate(巩固) → meta(反思)          │
        │   证据 = 事件哈希链        合并/晋升/标stale               │
        └──────────────────────────────────────────────────────────┘
```

**四个闭环：**
- **A 使用反馈环**：注入的知识 → 记录使用 → run 成败回写 metrics → 检索排序利用 metrics。
- **B 证据环**：知识 ← 事件（内容寻址哈希）；事件被推翻/来源失败 → 级联标 stale → 重新验证才复活。
- **C 验证环**：现有 draft→verified→active，扩展为「依赖的知识变化 → 已验证技能降级重验」。
- **D 巩固/遗忘环**：定期轻量 consolidate（合并相似、晋升高频、淘汰僵尸），保持基座小而高信号。

**两个复杂度原语：** 任务树（§5.5）、单轮多工具调用（§5.6）。
**两个防退化件：** length-stop 截断保护（§5.7）、doom-loop 检测（§5.8）。

## 4. 数据模型变更

### 4.1 事件内容寻址（`events.content_hash`）

证据要「内容寻址」才能被追溯和防篡改：事件落库时计算其 JSON 的哈希，证据引用事件 id，校验时重算哈希比对。

```sql
ALTER TABLE events ADD COLUMN content_hash TEXT;  -- sha256(canonical_json(event)) 前 40 字符
CREATE INDEX IF NOT EXISTS events_hash ON events(content_hash);
```

`SqliteLog.append()` 内计算 `contentHash(event)`（复用 `knowledge.ts` 的 `stableStringify` + sha256）。旧库行 `content_hash` 为 NULL，视为「不可校验的遗留证据」。

**evidence 语义规范**（不破坏现有 `string[]` 结构）：
- 每个条目是事件 id（如 `stepId`），通过 `content_hash` 列内容寻址。
- 新增 API：`Log.verifyEvidence(ids: string[]): { ok: true } | { ok: false; tampered: string[] }` —— 重读事件、重算哈希，不匹配或缺失的 id 列入 `tampered`。
- 知识对象写入时，evidence 必须引用**已存在**的事件（写入路径校验，见 §5.2）。

### 4.2 派生链（`RefSchema.knowledgeId`）

级联失效需要「谁派生了谁」的边。`schema/knowledge.ts` 的 `RefSchema` 增加一个可选字段：

```ts
export const RefSchema = z.object({
  url: z.string().optional(),
  sessionId: z.string().optional(),
  connection: z.string().optional(),
  knowledgeId: z.string().optional(),   // 新增：派生自哪条知识（内容哈希 id）
})
```

边的方向：`refs` 指向**上游**（这条知识依赖什么）。级联失效从失效源头沿 refs 反向 BFS。

### 4.3 任务树（新事件类型 `task`）

任务是会话期数据，属于事件流而非知识库（不跨会话持久化，但转录进 harvest 的原料）：

```ts
// EventSchema 新增变体
z.object({
  type: z.literal("task"),
  id: z.string(),           // 任务自身 id
  ts: z.number(),
  sessionId: z.string(),
  taskId: z.string(),       // 语义 id，如 "T1.1"，模型可引用
  parentId: z.string().nullable(),  // 树形结构；null = 根任务
  status: z.enum(["open", "done", "failed", "abandoned"]),
  title: z.string(),
})
```

- 任务树只影响转录（`renderTranscript` 输出树形结构）和 `meta` 统计（失败任务数），**不改变循环执行语义**。
- 任务的执行体是 delegate（`op=one`），模型先声明任务再委托——树是「计划」，委托是「执行」，两者解耦。
- 提供 `task` connection：`create/complete/fail/abandon` 四个 op，写任务事件。约 60 行。

### 4.4 知识指标用于检索

`AssembledContext.included` 从 `string[]`（仅 name）改为 `Array<{ kind: KnowledgeKind; name: string }>`，供反馈环回写 metrics。检索排序公式调整（§5.1）。

## 5. 机制详细设计

### 5.1 使用反馈环（A）

**现状**：`SelfStore.recordOutcome` 已实现但 src 内零调用；检索排序为 `cosine*3 + 名称命中 +5 + memory +0.5`，完全不看使用指标。

**变更：**
1. `assembleContext` 返回 `included: Array<{ kind; name }>`。
2. `session.run` 末尾（无论成功失败）：对每个 injected 条目 `self.recordOutcome(kind, name, ok)`，`ok = result.stopped === "done"`（后续接入 goal verifier 时改为裁判结果）。
3. 检索排序引入指标信号：

```ts
// retriever.ts —— 在现有分数上乘一个「健康度」因子
const health = 1 + 0.3 * Math.tanh((m.successes - m.uses / 2) / 10)   // 成功率偏离 50% 的信号
score = (sim * 3 + nameHit + kindBias) * (1 + Math.log10(m.uses + 2) * 0.2) * health
```

   用过且成功率高的记忆排序上升；用得多但老失败的被压低。**约 10 行改动，不改存储结构。**

4. `meta` 的失败工具统计从「当前会话」扩展到「跨会话」（读 log 全量，`replaySince`），让 guidance 真正「越用越准」。

### 5.2 证据环（B）

**写入时**（`harvest.ts` / `meta.ts` / `memory.ts` / `search.ts` 的写入路径）：
- evidence 只接受事件 id；写入前 `log.verifyEvidence` 校验存在性与完整性，校验失败的引用丢弃（宁可证据少，不可证据假）。
- memory/skill 经 `Connection.call(ctx)` 已有 `stepId`，其 evidence = 该 step 的事件链（step + result + verdict 三个 id）。

**失效时**（新 kernel 模块 `invalidate.ts`，约 80 行）：
- 触发器：① 某记忆的来源事件被标记为失败轨迹（verdict ok=false 的 step 链）；② 用户/工具显式推翻（新增 `memory op=revoke`，写一条 revoke 事件）；③ TTL 到期（已有 `isExpired`）。
- 算法：从失效知识出发，沿 `refs` 反向 BFS（`SelfStore.dependentsOf(knowledgeId)`，一条 SQL 按 refs LIKE 匹配或建边表），对沿途每个 active 条目 `setState(kind, name, "stale")`，并在 verification 上标 `"stale"`。
- 后续：stale 的 skill 不再 injectable（`injectable()` 已排除 stale）；stale 条目可通过 re-verify 复活为 active（§5.3），或经 consolidate 归档。

**存储**：为派生边建轻量表（避免 refs LIKE 扫描）：

```sql
CREATE TABLE IF NOT EXISTS knowledge_deps (
  dependent_id TEXT NOT NULL,   -- 下游知识 id
  upstream_id   TEXT NOT NULL,  -- 上游知识 id（refs.knowledgeId）
  PRIMARY KEY (dependent_id, upstream_id)
);
```

`SelfStore.add` 时同步 upsert。约 20 行 SQL + 30 行 TS。

### 5.3 验证环升级（C）

- 保持 `autoVerifySkills` **默认关闭**（验证命令是任意 shell，安全性不可默认放开），但新增更安全的默认路径：
  - **轻验证（默认开）**：技能验证命令若匹配安全前缀白名单（默认仅 `test -f` / `grep -q` / `ls` / 文件存在性检查类，可配置），harvest 后自动执行；其余命令仍需显式 `SEED_AUTO_VERIFY_SKILLS=1` 或 `skill op=verify`。
  - **级联重验**：当技能 refs 的某条上游知识变 stale，技能自动降级 `verified → stale`（§5.2），stale 技能在下次被检索到且候选数不足时提示模型调用 `skill op=verify` 重验。
- `verify` 结果现在写进 verification 的同时写一条 `verdict` 事件，使验证动作本身可审计、可作证据。

### 5.4 巩固/遗忘环（D）

新 kernel 模块 `consolidate.ts`（目标 < 150 行，纯同步，无模型调用）：

**触发**：每次 `session.run` 结束后以 1/8 概率执行（摊销成本，无需计时器/后台线程）。

**算法（按序执行，每个动作都产生新版本而非删除）：**
1. **合并**：同名同 kind 的最新条目两两比较 `stableStringify(content)` 的 token 重叠率 > 0.9 → 合并为一个新版本（content 取较短者，`refs` 合并两条的 id，`evidence` 取并集，`state` 取 max(两者)）。父链照常接在新版本上。
2. **晋升**：skill 满足 `verification.status === "verified" && metrics.uses >= 3 && successes/uses >= 0.8` → 新版本 state=active（原本就是 active 则跳过）；memory 满足 `uses >= 5` 且成功率 >= 0.8 → 在 content 不变的前提下产生新版本并把 `verification.status` 置 `"verified"`（**使用本身就是一种弱验证**）。
3. **僵尸标 stale**：`lastUsedAt` 超过 30 天且 `uses < 3` 的条目 → `setState(..., "stale")`。TTL 到期条目同样处理（现有 `isExpired` 逻辑统一入口）。
4. **归档留档**：不做物理删除。`stale` 超过 90 天的条目在 `latest()` 中不再出现（`all()` 仍可见），保持 append-only。

**防发散设计**：合并只看同名同 kind；晋升只看指标门槛；标 stale 不删除——每一步都是可回放的（事件流里有每次 state 变更的来源：consolidate 产生的事件记为 `type:"harvest"` 的新用途或专用 `consolidate` 事件，记录合并映射）。

### 5.5 复杂度原语一：任务树

- 模型通过 `task` 工具声明/更新任务树（数据）。
- 树的执行靠现有 `delegate`（one 执行单个子任务，many 并行执行兄弟任务）——**循环不新增任何调度逻辑**。
- `renderTranscript` 按树形输出任务层级，使 harvest 能蒸馏「如何拆解这类任务」为技能（任务的拆解模式是最高价值的可复用知识）。
- `meta.analyzeEvents` 统计失败任务与未完成任务，写入 guidance（“T3 失败、T3.1 未完成——考虑更细的拆解”）。

### 5.6 复杂度原语二：单轮多工具调用

**变更**：`Model.decide` 返回 `Step[]`（openai 适配器已能拿到全部 `tool_calls`，此前静默丢弃其余——顺手修复这个已知问题）。

**循环语义（保守设计）**：
- 一次 decide 返回多个 tool 时，**顺序执行**（不 Promise.all）：每个 tool 完整走 step → result → verdict → harvest 事件链，I6 不变式逐条保持，日志顺序天然确定。
- 若中途某 tool 结果包含 done（finish 混在批量里），停止执行剩余并返回答案。
- 并行留作后续：当连接声明 `{ concurrent: true }` 时用 FiberSet 式并行——**本设计不实现**，只预留接口字段。
- `fake.ts` 同步支持 `Step[][]` 脚本。

**收益**：消除「多工具调用被静默丢弃」的正确性 bug；减少模型往返次数（复杂任务的主要 token 消耗）；不增加循环复杂度。

### 5.7 防退化一：length-stop 截断保护（pi 的设计）

`finishReason === "length"` 时，模型输出被硬截断，工具参数可能不完整。**绝不补救解析后执行**：

- openai 适配器返回 `{ type: "error", code: "output_truncated" }` 或直接抛 `ModelCallError("output_truncated")`。
- loop 捕获后走现有 decide 重试路径（重试一次），失败则 stopped:"error"。
- 对比 MiMo 的补全续写方案，seed 选择 pi 的保守方案：**截断就重来，不猜**。理由：seed 的 bash 工具无沙箱，猜错参数的代价大于重试的 token 成本。

### 5.8 防退化二：doom-loop 检测（opencode/MiMo 的设计）

- loop 维护最近 8 个 `(tool, contentHash(args))` 的环形缓冲。
- 连续 3 次相同 → 该次调用不执行，直接产生 `{ok:false, error:{code:"doom_loop"}}` 的失败结果注入历史，并让模型看到「重复调用已拦截」的提示。
- 极小成本（约 15 行），对「卡死循环烧 token」的防御价值极高（hermes 的迭代预算 + grace call 本质是同一种防御，seed 用更简单的形式）。

## 6. 默认值变更

| 配置 | 现状 | 建议 | 理由 |
|---|---|---|---|
| `autoHarvest` | false | **true** | 学习环是核心卖点，harvest 失败已隔离（P0 修复后不丢答案） |
| `autoMeta` | false | **true** | 反思只写记忆不执行命令，无安全成本 |
| `autoVerifySkills` | false | **false（保持）** | 验证命令是任意 shell；改由 §5.3 的轻验证白名单覆盖安全子集 |
| `maxSteps` | 100 | 100（保持） | 有 doom-loop 检测后不再需要更激进的上限 |

## 7. 分阶段实施计划

每阶段独立可交付、可测试、行数受控。验收 = `bun run check` 全绿 + 新增测试覆盖该阶段机制 + 阶段行数预算不超。

### Phase A：使用反馈环（约 120 行 + 200 行测试）
- `assembleContext.included` 类型升级；`session.run` 回写 `recordOutcome`；检索排序加指标因子；`autoHarvest/autoMeta` 默认开。
- meta 跨会话统计。
- 测试：注入条目在成功/失败 run 后 metrics 变化；检索排序随使用提升；默认开关生效。

### Phase B：多工具 + 防退化（约 150 行 + 250 行测试）
- `Model.decide → Step[]`；loop 队列顺序执行；fake/openai 适配器同步更新。
- length-stop 保护；doom-loop 检测。
- 测试：批量工具顺序执行与中途 done 短路；openai 多 tool_calls 全量映射；截断重试；连续重复拦截。

### Phase C：证据内容寻址 + 级联失效（约 250 行 + 300 行测试）
- `events.content_hash` + `Log.verifyEvidence`；写入路径证据校验；`knowledge_deps` 边表 + `dependentsOf`；`invalidate.ts` 级联标 stale；stale 不注入（已有）+ re-verify 复活路径；verify 写 verdict 事件。
- 测试：哈希校验（含篡改检测）；依赖链级联（A→B→C 三层）；重验复活；旧库 NULL hash 兼容。

### Phase D：任务树 + 巩固/遗忘（约 250 行 + 300 行测试）
- `task` 事件 + task connection + 树形转录；`consolidate.ts`（合并/晋升/僵尸标 stale）；1/8 触发；consolidate 事件留痕。
- 测试：任务树转录；合并去重与证据并集；晋升门槛边界（恰好 3 次、成功率 0.79 vs 0.8）；僵尸 stale；append-only 不变量（合并后旧版本仍在 history 中）。

## 8. 风险与不变量

- **收敛性**：所有自我写入继续走 draft→verify→active；consolidate 只产生新版本不删除；stale 可复活。若某环导致基座膨胀，1/8 概率触发可调至 1/16，机制不变。
- **证据可信度上限**：evidence 校验的是「事件存在且未被篡改」，不是「结论正确」。结论正确性由验证环（命令）与使用反馈环（成功率）共同逼近——这是设计选择：**过程可信，而非事实可信**。
- **不变量**（新增）：`I7 所有知识写入必须带可校验证据或明确声明人类来源`；`I8 任何自动状态变更（stale/active/verified）必须产生事件或新版本`。
- **明确不做**：向量库（TF-IDF/BM25 足够，hermes 已验证）；多平台网关；第二套引擎（opencode 双引擎教训）；后台线程/定时器（用概率触发摊销）；UI。

---

## Implementation status (all four phases shipped)

| Phase | Scope | Status |
|---|---|---|
| A | Usage feedback loop: `AssembledContext.included` carries `(kind, name)`; `session.run` records outcomes for injected entries; retrieval ranking multiplies by `usageFactor` (use-frequency boost + failure penalty); `autoHarvest`/`autoMeta` default ON; guidance/meta aggregate cross-session | ✅ shipped |
| B | Multi-tool turns (`Model.decide → Step[]`, every tool call executed in order, done short-circuits); length-stop protection (`finish_reason: length` never salvaged, one retry then `stopped: error`); doom-loop guard (3 identical calls intercepted) | ✅ shipped |
| C | Content-addressed evidence (`events.content_hash`, `Log.verifyEvidence`, legacy-DB migration); write-path citation validation; `RefSchema.knowledgeId` + `knowledge_deps` + `invalidateKnowledge` cascade; `memory revoke` op; harvest source-quality gate (failed sessions → draft memories); verification verdicts are auditable events | ✅ shipped |
| D | Task tree (`task` event + `task` connection + indented tree in `renderTranscript`); consolidation (`consolidate.ts`: merge/archive with mapping, usage-based promotion, zombie + TTL staling) triggered every N sessions via `consolidateEvery` (default 8, 0 disables) | ✅ shipped |

Verification: `bun run check` green — typecheck + biome + **232 tests** (was 82 before the
four phases). Coverage: ~98% lines.

Deviations from the design doc, with reasons:

1. **Merge does not create a new knowledge version.** Content-hash idempotency makes a
   "merged version with union evidence" unreachable (same content ⇒ same id ⇒ no version
   bump). The shipped behavior archives the loser and records the mapping in the
   `consolidate` event — append-only and reversible, which satisfies I8.
2. **No failed-trajectory auto-invalidation** beyond the harvest quality gate. An automatic
   event→knowledge index would stale well-sourced memories because of one bad run; explicit
   `memory revoke` covers the deliberate case.
3. **Doom-loop / multi-tool thresholds** use the design's constants (window 8, repeat 3).
