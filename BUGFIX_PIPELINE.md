# BiliBot 2026-10-06 修复管线记录（F1-F5 + issue #34 实战全过程）

基线：`chenluQwQ/astrbot_plugin_bilibili_ai_bot` main @ `19e5551`（v1.5.2），基线 223 项测试全绿。
最终：6 项修复全部落地，241 项测试全绿，`git diff --check` 干净。未 commit、未提交上游。

---

## 管线总览（本次实际执行顺序）

```
审计发现 → 离线复现取证 → 问题清单(FIX_PLAN.md) → 文件级分工并行修复
→ 各自新测试 → 全量回归 → red-green 反证 → 人工逐 diff 审查 → 文档收尾
```

关键原则：**先有可复现的 bug 证据，再动代码；每个修复配回归测试；测试必须证明在旧代码上会失败。**

---

## 阶段 1：审计发现（测试没覆盖到的盲区）

现有 223 项测试全绿，但通过 AST 静态分析 + 代码链走读发现测试盲区：

- 用 AST 遍历 `BiliBiliBot` 类生成**命令权限矩阵**：哪些命令有写操作/调 API、哪些没有 `permission_type` 装饰器——一眼看出 20 个管理命令裸奔。
- 走读 `_extract_bili_share_target` 的 URL 处理链，发现域名判断是子串匹配且短链展开携带 `_headers()`（含 Cookie）。
- 通读框架源码（`astrbot/core/star/filter/permission.py`）确认 `PermissionTypeFilter` 确实拦截非管理员——排除"框架会兜底"的侥幸心理，坐实是插件没接。

## 阶段 2：离线复现取证（`audit_probes.py`）

复现脚本的三层防护：**不启动 AstrBot、不用真实凭据、网络只允许回环**。

- **网络护栏**：`sys.addaudithook` 拦截 `socket.connect`，非 127.0.0.1 直接抛异常。"离线"是强制的不是靠自觉。
- **模块隔离**：stub `astrbot.api`/`core.config` 后用 `importlib.util.spec_from_file_location` 单独加载 core 模块，配置常量全部指向临时目录。
- **main.py 方法级加载**：AST 解析出目标方法，剥掉装饰器后单独 `exec`，配假 `Event` 直接调用——不用实例化插件。
- 凭据一律 `AUDIT_FAKE_SESSION` 等假值。F1 用本机起假 HTTP 服务器，亲眼看 Cookie 头被发到非 B 站主机。

5 项全部复现成功，证据落盘 `audit_probes.stdout.json`。

## 阶段 3：问题清单与分工

写 `FIX_PLAN.md`：每项含编号/严重度/文件:行号/根因/修复方向/验收标准，然后**按文件级划分责任区**避免并行冲突：

| 编号 | 负责方 | 文件 |
|---|---|---|
| F1 / F4 / F5 | 修复子代理 | `core/share.py`、`core/llm.py` |
| F2 / F3 / #34 | 主代理 | `main.py`、`core/schedule_mixin.py`、`_conf_schema.json` |

## 阶段 4：各项修复的实际做法

### F1 短链 Cookie 外带（core/share.py）
- 新增 `_is_allowed_share_host()`：`urlparse().hostname` 小写后**精确等值**（`b23.tv`/`bili2233.cn`/`bilibili.com`）或 `.bilibili.com` 后缀比较，替换 `host in url.lower()` 子串匹配。
- `_resolve_share_url()` 改用无凭据 headers（只有 UA/Referer/Accept）——短链展开本来就是公开请求，不需要登录态。
- 重定向后的最终 URL 再过一次主机校验才提取 BV（防短链跳站外）。

### F2 管理命令权限（main.py，20 个命令）
- 统一加 `@filter.permission_type(filter.PermissionType.ADMIN)`，置于 `@filter.command(...)` 之上，与已有的 `bili兴趣`(1179 行) 写法一致。
- 用脚本批量插入 + 断言集合相等，不漏一个。
- **用户功能刻意不动**：`bili记忆/好感/状态/帮助/解析/绑定自己UID` 保持开放。

### F3 绑定冒充主人（main.py）
- 入口拦截：`cmd_bind` 中目标 UID == `OWNER_MID` 时要求 `event.is_admin()`。
- 纵深防御：`inject_bili_memory` 里注入主人活动/记忆前再查一次 `sender_is_admin`——即使存在修复前的遗留恶意绑定也读不到。

### F4 熔断探测卡死（core/llm.py）
- 根因：`CancelledError` 不走 `except Exception`，探测置位 `_llm_circuit_half_open=True` 后被取消就永久卡死。
- 修法：新增 `_release_llm_probe()`（锁内复位标志，不计成功/失败、不动冷却时间），`_llm_call` 增加 `except asyncio.CancelledError` 分支：probe 模式先释放再 re-raise。

### F5 发送副本残留（core/share.py）
- finally 中 cleanup 列表合并 `send_paths`：`list(dict.fromkeys(raw_send_paths + send_paths]))`。
- **去重是关键细节**：测试 mock 里 send 路径 == 原始路径，不去重会传重复路径打挂既有测试。

### #34 计划模型可配 + 重试增强（core/schedule_mixin.py + schema）
- 新增 `_autonomous_plan_max_attempts()`：总尝试次数 = 1 + `AUTONOMOUS_PLAN_MAX_RETRIES`（默认 2，上限 5）。
- `retry_exhausted` 判定从"重试过就 exhausted"改为"尝试次数达到上限才 exhausted"——这是和旧行为语义冲突最大的点。
- 计划生成调用 `_llm_call(..., provider_id=SCHEDULE_PLAN_PROVIDER_ID or None)`。
- `_extract_plan_json` 从 `@staticmethod` 改为实例方法，解析失败时回退 `self._repair_llm_json` 再解析一次。
- schema 两个新键插在 `AUTONOMOUS_PLAN_RETRY_MINUTES` 之后（**不能打断 `test_config_schema_order` 断言的连续段**）。

## 阶段 5：测试

- 新增 `tests/test_audit_fixes_main.py`（10 项）：AST 装饰器断言锁权限回归、绑定三种身份场景、非管理员注入隔离、max_attempts 配置边界、JSON 修复回退、provider_id 透传。
- 新增 `tests/test_audit_fixes_share_llm.py`（7 项）：主机白名单参数化、伪造短链零请求、展开头无 Cookie、重定向站外不采用、cleanup 含 send_paths、探测取消后可再探测。
- **更新旧测试**：`test_autonomous_ranges.py` 里"只重试一次"的旧语义硬编码测试改为显式配置 1 次重试，另补"默认允许两次重试"新用例。教训：**涉及次数/阈值的测试要显式设配置值，别依赖默认值。**

## 阶段 6：验证（三轮）

1. **全量回归**：`python -m unittest discover -s tests -p test_*.py` → 241 passed。
2. **Red-green 反证**：`git stash`（新测试是 untracked 会留下）→ 旧代码上 17 个新测试炸出 27 failures + 14 errors，证明测试真能抓 bug → `git stash pop` → 再跑全量 241 passed。
3. **人工审查**：6 个改动文件 + 2 个新测试文件的完整 diff 逐行过目。



## 产物索引（`bilibili_ai_bot_audit_20261006/`）

- `FIX_PLAN.md` 问题清单与分工 ｜ `FINAL_REPORT.md` 最终报告
- `audit_probes.py` / `audit_probes.stdout.json` 复现脚本与证据
- `baseline_unittest.log` 基线测试日志 ｜ `issues.json` / `pull_requests.json` 上游快照
