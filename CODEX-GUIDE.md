# Codex 桌宠适配版

保留 PC2005-cloud/dsh-pet 当前版本的蓝发女仆角色、106 段透明动画、漫游、点击、拖拽甩抛、多开和动作菜单，增加 Codex 会话联动、账号额度查询、宠物聊天与设置页。

## 使用

- `Start-Pet.cmd`：启动桌宠。重复运行会复用已运行实例。
- `Open-Settings.cmd`：打开本机设置，可修改名字、大小、显示、原地陪伴、多开、碎碎念和通知；也能聊天、查额度、点播动作。
- `Stop-Pet.cmd`：停止宿主及全部桌宠窗口。也可从托盘菜单关闭。
- `Install-Hooks.cmd`：合并安装 Codex 事件连接；自动备份原 hooks.json，不修改 config.toml、notify 或登录。
- `Uninstall-Hooks.cmd`：只移除本包安装的 Hooks，保留其他 Hooks。

**事件连接需要 Codex 的信任审核。** 在新会话中检查新增 Hooks，并在 Codex 提供的 Hooks 审核入口信任本包的定义。CLI 可输入 `/hooks`。未信任时 Codex 会跳过这些 Hooks，桌宠仍能独立运行。不要使用绕过信任的参数。此文件夹移动后，先在旧位置卸载 Hooks，再在新位置安装并重新审核。

这是原版完整交互的独立桌面伴侣，**不是 Codex 内置宠物选择器的精灵图包**。不需要 DSH，不需要更换现有 Codex 宠物；两者可同时使用。没有添加 Windows 开机启动。

## 功能与边界

| 功能 | 行为 |
|---|---|
| 工作状态 | 思考、执行、整理、等待确认、完成；中断返回空闲，工具明确报告失败时显示出错 |
| 多会话 | 等待确认优先，仍在运行的任务优先于其他会话的完成状态；子任务未结束时暂不庆祝 |
| 自动清理 | 完成/失败状态 10 秒后回到空闲；无事件的活动会话 30 分钟后移除，避免崩溃会话永久挂住 |
| 聊天 | 使用当前桌面版附带的 Codex CLI 和已有登录；优先匹配用户模型，匹配不到时使用接口列出的默认模型；不读取或复制登录凭据 |
| 聊天隔离 | 独立临时会话、只读沙箱、禁用 Shell、插件、Apps、浏览器、Computer Use 和子代理；不改变项目会话 |
| 额度 | 通过 Codex 官方 app-server 读取真实窗口；保留窗口名称与重置时间；没有读数时明确显示不可用，不伪造余额 |
| 碎碎念 | 默认关闭，手动触发可用；开启后消耗当前账号模型额度，最短间隔 5 分钟 |
| 系统通知 | 默认关闭，在设置里开启；完成、等待确认或失败时发本机通知，不读取 Codex 窗口焦点 |
| 自定义素材 | 保留原版 pet pack 和用户素材目录；设置页编辑主宠物，不覆盖额外种类文件 |

Codex 的 Hooks 并不提供所有底层运行失败的统一事件。`PostToolUse` 明确携带 `isError`/`is_error` 时能显示错误；没有对应 Hook 的崩溃不会被假装识别，靠活动超时清理恢复空闲。完整系统错误联动仍受 Codex 事件接口边界限制。异步提问在下一条用户消息前保持等待；不会把工具返回当成用户已经回答。

## 本机数据

数据在本文件夹的 `data/`：配置、宠物聊天记忆、Chromium 缓存、运行标识和 Hooks 备份。事件连接只传会话/回合标识、事件名、工具名、子代理标识及失败布尔值；不传工作提示词、项目路径、命令参数或工具输出。宠物聊天内容会发送给 Codex 模型，并按原版机制在本机记忆文件保存。

服务默认只监听 `127.0.0.1:31380`，管理操作要求随机凭据并校验 Origin/Host。`data/runtime.json` 含本机访问凭据，**不要分享 data 文件夹**。设置页入口通过启动器或桌宠右键打开。

原始 DSH 专用余额、凭据及聊天后端已由 Codex 通道替代；没有额外配置 API Key。此包带有项目独立的 Node 与 Electron，不全局安装。

## 开发与验证

```powershell
npm install --include=dev --legacy-peer-deps --ignore-scripts
npm run codex:build
npm run codex:typecheck
npm run codex:test
$env:CODEX_PET_TEST_SHIMS = '1'
node --experimental-strip-types --import ./scripts/test-register.mjs --test src/shared/balance.test.ts src/host/work-status.test.ts src/host/work-status-lifecycle.test.ts
```

Windows 64 位已验证。跨平台源码沿用上游，但本便携目录附带的是 Windows 运行时。配置环境变量 `CODEX_PET_PORT`、`CODEX_PET_DATA`、`CODEX_PET_CODEX` 可分别指定端口、数据目录和 Codex 可执行文件；设置后要在同一环境使用控制脚本。

## 来源

- 上游：https://github.com/PC2005-cloud/dsh-pet
- 固定源码：`c6f96350d9307bd6c23bc6ea31974e76a719a8b6`，dsh-pet 0.3.7。
- 发布包 dsh-pet@0.3.7 的 106 段动画与本仓库逐一 SHA-256 比对完全一致。人物是蓝发女仆，包描述里的蓝鲸文字没有对应另一套人物素材。
- 原版 MIT 许可见 `LICENSE`；上游说明保留在 `UPSTREAM-README.md`。Node 和 Electron 及其依赖的许可随运行时保留。
- 官方 Hooks：https://learn.chatgpt.com/docs/hooks
- 官方宠物说明：https://learn.chatgpt.com/docs/pets

停止并卸载 Hooks 后即可移除此文件夹；如果需要聊天记忆或配置，请先保留 data。不自动删除数据，也不更改 Windows 注册表。
