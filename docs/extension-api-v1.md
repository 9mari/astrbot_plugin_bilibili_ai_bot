# BiliBot Extension API v1

Extension API v1 让独立 AstrBot 插件以**受限扩展**形式接入 BiliBot WebUI，而不复制、覆盖或导入主插件私有实现。Creator 扩展是首个适配者。

## 设计目标

- 扩展存在时：WebUI 显示模式入口，并由主插件渲染扩展返回的安全 Page Schema。
- 扩展不存在、关闭或异常时：入口自动消失，BiliBot 原有页面、配置和运行逻辑不受影响。
- 扩展只能获得 Host 明确授权的能力；声明权限不等于获得权限。
- Host 的公开方法不返回 Cookie、数据库连接、插件实例或其他内部对象。
- Extension API v1 默认拒绝视频上传与正式发布。

这是一套同进程插件接口，不是用于运行不可信 Python 代码的沙箱。只应安装可信扩展；Python 私有属性约定不构成操作系统级隔离。

## 扩展发现

Host 在访问扩展接口时，通过 `context.get_all_stars()` 懒发现同时启用的插件。兼容插件使用 duck typing 暴露：

```python
def get_bilibot_extension_manifest() -> dict: ...
def bind_bilibot_host(host_api) -> None: ...
def unbind_bilibot_host() -> None: ...
async def handle_bilibot_extension_request(request: dict) -> dict: ...
```

发现过程会隔离单个扩展异常，并跳过禁用扩展、无效 manifest、未知 API 版本和重复扩展 ID。
Host 会校验 `host_requires` 版本范围，以及页面与动作的声明。异步发现/绑定/解绑最多等待 5 秒，页面与动作最多等待 30 秒；同步钩子必须快速返回，不能阻塞事件循环。主控制页面不会等待扩展发现完成才显示。

停用、移除、关闭 Host 或变更权限时，原有 Host API 引用会被撤销。并发发现只会绑定一次。

## Manifest 与协议

双端协议文件为 `core/extensions/extension_api_v1.json`。扩展 manifest 至少声明：

- `type`、`id`、`name`、`version`；
- `extension_api` 与 `host_requires`；
- `navigation`、`pages`、`actions`；
- 请求权限 `permissions`。

Host 到扩展的操作名：

```text
page:{page_id}
action:{action_id}
health
```

请求和响应均使用带 `request_id` 的数据字典信封。扩展不直接注册主插件 HTTP 路由。

### 呈现方式 `presentation`

可选，控制扩展在主界面里怎么露出：

- `entry`：`brand` 在品牌区显示入口，`hidden` 不显示；
- `entry_priority`：多个扩展时的排序；
- `switch_label`、`return_label`：入口和返回按钮的文案；
- `accent`、`surface`：沉浸模式配色；
- `standalone`：默认允许。品牌区会多一个按钮，用 `?ext={extension_id}` 在新标签页
  只加载这个扩展的工作区，便于和主界面并排对照检查。置 `false` 可关掉。

单独模式下不渲染返回按钮：那个标签页没有加载过主插件页面，返回会落在空壳上。

## WebUI Bridge 路由

以下 endpoint 挂载在 BiliBot WebUI Bridge 的插件前缀下：

```text
GET  extensions
GET  extensions/page?extension_id={extension_id}&page_id={page_id}
POST extensions/action
POST extensions/refresh
```

浏览器提交的扩展 ID、页面 ID、动作 ID和 payload 会先经过 Host。`actor` 与 `request_id` 由 Host 生成，不能由页面伪造。

## Page Schema 安全边界

扩展页面必须使用 `bilibot-schema-v1`。Host 后端先验证组件白名单，前端再按内置 renderer 渲染并转义文本。

Extension API v1 不允许扩展提供：

- 任意 HTML、JavaScript 或 CSS；
- 任意文件系统路径；
- 主插件 Cookie、配置对象、数据库连接或运行时实例；
- 绕过 Host 的 Bilibili 写操作。

Creator 视觉样式由主仓库内置的 `pages/bilibot/creator.css` 提供，并限定在 `.creator-mode` 作用域；离开 Creator 模式后恢复原 WebUI。

## 权限

安全默认授权：

```text
account.identity.read
memory.creator.read
memory.creator.write
activity.write
analytics.video.read
opportunities.read
storage.extension.read
storage.extension.write
```

默认拒绝：

```text
actions.video.upload
actions.video.publish
```

后续接入真实上传/发布时，应增加管理员显式授权、投稿预览、人工确认、速率限制和审计记录，而不是直接扩大默认权限。

创作记忆读取只包含公开媒体记忆和当前扩展自己写入的 `creator` 记忆。私密媒体记录与其他扩展的草稿不进入此接口；写入的创作草稿保存在 `self` 域，不参与公开评论召回。`storage.extension.*` 是协议中的能力名称，当前 Host 不提供通用文件系统读写方法，扩展仍自行管理其私有存储。

## `list_creator_signals` 返回什么

一次浏览已经下载、分析、打分并写下观后感，这些判断随信号一起交给扩展，
避免扩展为了拿到同样的结论再看一遍：

```text
title  summary  source  source_ref  tags  captured_at  heat_score
score  mood  review  up_name  up_mid  tname  pic  actions
```

`actions` 是评分驱动的真实互动记录（`["👍点赞", "🪙投币", ...]`）。
阈值在 `core/proactive.py`：6 分点赞、7 分评论、8 分投币和收藏、9 分关注。
硬币每天有限、收藏是明确的“值得留下”，所以这个字段比 `score` 更能说明兴趣。

`watch_log.json` 有评分和互动，`video_memory.json` 有最长的 `analysis`，
两者描述同一个 bvid，因此按 `source_ref` 合并成一条：空值不覆盖有值，
`summary` 取更长的那个。

## 兼容与维护

Creator 仓库维护同名 `contracts/extension_api_v1.json`。修改协议时必须：

1. 同步更新两端文件；
2. 保持协议文件使用 LF 换行时的相同 SHA-256；
3. 更新两端测试和文档；
4. 对破坏性变更升级 `extension_api` 主版本。
