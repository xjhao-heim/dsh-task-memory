# dsh-task-memory

DeepSeek Harness 插件：**工作区级任务记忆**。

解决的问题：相似的活会反复出现，而每次会话都从零重新分析一遍。这个插件把"做过的任务"存成**一人一张**的记忆卡，并且让卡片以**两段式**被检索——先看索引，命中后才读那一张的正文，所以记忆再长也不需要每次全读。

## 两段式检索

| 阶段 | 机制 | 成本 |
| --- | --- | --- |
| **索引** | 每张卡注册成一个技能，出现在会话的技能目录里（一行一卡：名字 + 描述 + 触发词） | 常驻，但宿主只在目录真正变化时重新发布 |
| **正文** | 内置 `skill` 工具按名字加载命中的那一张卡 | 一次调用，只读一张 |

这正是设计的关键：**不需要为本插件写任何注入逻辑**。技能目录本来就会被注入会话，而且宿主已对快照做了去重（内容不变不重发），所以索引是"免费"的，也不会每轮刷屏。

## 数据布局

```
<会话 cwd>\.dsh\task-memory\
  notes\<卡名>\SKILL.md      ← 卡片本体；既是持久记忆，也是技能正文
  notes\<卡名>\assets\       ← 可选：代码片段、补丁、命令
  stats.json                 ← 加载次数（与卡片分离，读卡不会重写正文）
```

只有一份真相：**索引永远从卡片 frontmatter 现算**，不存索引文件，因此不可能漂移；`## 变更记录` 段落承担版本历史，所以也不需要 journal。

## 工具

| 工具 | 作用 |
| --- | --- |
| `task_memory_index` | 完整索引，可按 `query` / `status` / `tag` 过滤。目录被上限截断时兜底 |
| `task_memory_load` | 按名字取一张卡的正文、元数据与附件清单（`skill` 工具取正文同样可用） |
| `task_memory_save` | 落卡。默认 `auto` 模式会**拒绝为已记录的任务再建一张卡**，并返回候选卡 |
| `task_memory_search` | 跨卡片正文全文检索（带片段），触发词都没命中时兜底 |

## 只记一份

`task_memory_save` 的三种模式：

- `auto`（默认）：先用本地相似度（字符 trigram + 触发词重合 + 标签重合）比对已有卡片。判定为同一件事时**不创建**，直接返回那张卡的 `name` 与匹配理由，让模型改用 `update`。
- `update`：合并进指定卡。合并按 `##` 段落进行——模型这次写到的段落被替换，**没提到的段落原样保留**，因此后一次保存不会悄悄抹掉先前的结论。`revision` 递增，`triggers` / `tags` 取并集。
- `force-create`：确实是一个不同任务时才用。

索引有硬上限（默认 50 张，按加载次数→更新时间排序）。被截断的卡仍然可以通过 `task_memory_index` / `task_memory_search` 找到——这是"记忆可以很长，但每次不必全读"的落地方式。

## 记忆面板（P3）

Harness 侧边栏里的「任务记忆」入口，中间列打开面板，用来管理当前工作区的卡片：

| 操作 | 说明 |
| --- | --- |
| 浏览 | 顶部选工作区（带卡片数），下面是卡片列表：名字、状态、描述、更新时间、revision、加载次数、触发词 |
| 查看 | 点卡片展开正文与元数据 |
| 新建 | 填名字/描述/触发词/标签/正文，名字必须是 kebab-case |
| 编辑 | 直接改字段与正文后保存 |
| 删除 | 二次确认，删掉整个卡片目录（含 assets） |
| 检索 | 按正文全文过滤列表 |

**人工编辑与模型写入的语义不同**：模型 `update` 是按 `##` 段落合并，而面板保存是**逐字替换**——你在编辑器里写的就是最终内容，删掉的段落和触发词不会自己回来。

实现要点：Host 侧用 `ctx.webServer.register` 挂 `/api/task-memory/*` 六条路由，客户端用 `fetch` 调用，两个 slot（`sidebar.panellist` + `main`）提供入口和页面。样式只用主题 token，明暗主题都跟随宿主。

界面里的下拉框是**自绘**的，不是原生 `<select>`：后者的展开弹层由 Chromium/OS 绘制、CSS 碰不到，在暗色主题下会是白底黑字，与其余控件格格不入。自绘版直接采用宿主菜单的配方（`--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter` + `--dsw-elevation-prominent`），并保留原生控件的全部键盘与无障碍行为（方向键、Home/End、Enter/Space、Escape、点外部关闭、焦点回到触发器）。

## 安装

本插件不使用 npm 安装、没有 `node_modules`、不依赖任何 `@deepseek-ai/*` 包——`link:` 安装的插件是从真实路径加载的，Node 的解析走不到 profile 的 `node_modules`，所以裸包名会失败。`lib/schema.js` 因此自己实现了注册契约。

1. 加依赖（`link:` 指向本目录）：
   ```json
   "dependencies": { "dsh-task-memory": "link:D:/AI/dsh-task-memory" }
   ```
2. 加进 bundles：
   ```json
   "bundles": [ ..., "dsh-task-memory" ]
   ```
3. 建 junction，让 Node 能解析到它：
   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-task-memory" `
     -Target "D:\AI\dsh-task-memory"
   ```

## 配置

```yaml
- id: dsh-task-memory
  name: dsh-task-memory
  config:
    maxCatalogCards: 50     # 注入到技能目录的卡片上限
    maxBodyChars: 24000     # 单张卡正文的读取上限，超出截断并给出文件路径
    includeSystemPrompt: true
```

## 测试

```powershell
node test/all.test.js
```

`node --test` 会为每个文件 spawn 子进程（在受限沙箱下会被拒），`test/all.test.js` 把六组用例导入同一进程执行，断言完全相同。

另有一个真实 Cordis 运行时的集成测试（`test/integration.cordis.mjs`，14 项：装配、通过真实注册表读写、面板路由、卸载清理）。它必须在 profile 目录下运行——插件是 junction 安装的，从 `D:\AI\dsh-task-memory` 里跑会解析不到 `@deepseek-ai/*`。运行方式见该文件头部注释。

## 限制

- 卡片按**会话工作目录**隔离，不跨工作区共享。面板顶部的选择器可以在工作区间切换查看。
- 去重是启发式：它宁可拒绝新建也不轻易产生第二张卡，但最终判断在模型；工具会给出匹配理由，模型可以据此改用 `force-create`。
- 删除卡片不提供**模型**工具——模型能自行删除的记忆就是会消失的记忆。删除只在面板里由人操作。
- 改动插件的 JS 代码后需要**重启 Harness** 才会加载（`patchReload: live` 只覆盖新增插件与配置改动）。
