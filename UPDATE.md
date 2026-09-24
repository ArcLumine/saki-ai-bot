# 部署与更新（给服务器 / 其他机器上的副本）

> 你在**服务器或另一台机器**上跑这个机器人，更新方式 = 从公开仓库 `git pull`。
> 仓库里只有**代码和示例**；**人设 / 知识库 / 配置 / 状态**是**你自己的私有文件**，不在 git 里 —— 更新不会动它们。

## 0. 两条原则（先读）

1. **服务器上不要改代码**。要改功能、修 bug ⇒ 提 issue / 找维护者，改动走他们的开发流程。
   （在服务器副本上改了代码，下一次更新就会冲突。）
2. **活数据不在 git 里**：`config.yml`、`knowledge/group-memory.md`、`knowledge/learned.md`、
   `knowledge/owner.md`、`knowledge/hzymtr-server.md`、`knowledge/groups/`、`state/`、`logs/`
   都被 `.gitignore` 挡住 ⇒ 更新**不会**覆盖它们，也**不会**把它们带进提交。

## 1. 首次部署

```bash
git clone https://github.com/ArcLumine/saki-ai-bot.git
cd saki-ai-bot
npm i                                    # 依赖很少（ws / js-yaml / qrcode …）
copy config.example.yml config.yml       # 然后填：llm.apiKey、onebot.accessToken、ownerQQ、botQQ、trigger.allowGroups
# 三个「活文件」用模板起头（不进仓库）：
cd knowledge
copy group-memory.example.md group-memory.md
copy hzymtr-server.example.md hzymtr-server.md
copy learned.example.md learned.md
cd ..
node test/run-all.js                     # 自检（离线、不碰真 QQ、不花钱）
node src/index.js                        # 起（管理界面 http://127.0.0.1:3099）
```

- 协议端（NapCat 等）自己装好，WS 端口 / token 与 `config.yml` 对上。
- 细节见 `README.md`「快速开始」与 `installer/README.md`。

### 首次跑测试：哪些红是**正常的**

`cs` / `teach` / `knowledge-groups` / `monthly-report` / `webui` / `sensitivity` / `holiday`
这类套件要读**你自己的** `config.yml` + 知识库内容；刚按模板起头时它们**本来就会红**。
把配置和 `knowledge/*.md` 填好后绝大多数会转绿 —— **这不是 bug，也不用报障**。

## 2. 每次更新

```bash
git status --short          # ① 必须是空的（有输出 = 你改了不该改的东西，先处理掉）
git fetch origin main       # ② 拉提交
git log --oneline HEAD..origin/main          # ③ 这版多了哪些提交
git diff --stat HEAD..origin/main            # ③ 变了哪些文件
git pull --ff-only          # ④ 更新（必须快进）
git status --short          # ⑤ 应该仍是空的；再看一眼第 3 节
```

- ③ 看不明白的改动 ⇒ **先别更新**，问维护者。
- 更新完**不一定**要重启；需要重启时看第 4 节。

## 3. 活数据核对（更新后顺手做）

```bash
git status --short                        # 应为空
dir config.yml knowledge\*.md             # 你的配置与活知识库都还在（不是 .example 的那几个）
dir state                                 # 好感度 / 故事线 / 待发箱还在
```

## 4. 重启纪律（Windows 上尤其重要）

⚠️ **一次重启 = 一次 QQ 登录**。频繁登录会被风控（踢下线，严重时要重新扫码）。

- 用 `tools/restart-bot.ps1` 重启 —— **别按名字 `taskkill` 杀 node**（会误杀别的进程）；
- **别在 1 分钟内连着重启**（建议间隔更久）；
- 看门狗在跑时：重启前先关看门狗，否则它会把旧状态写回来；
- 改 `config.yml` / `knowledge/*.md` **不用重启** —— 在管理界面点「保存」即热重载。

## 5. 回滚

```bash
git log --oneline -10             # 找上一版
git reset --hard <上一版 sha>     # 活数据不在 git 里 ⇒ hard 是安全的
# 要生效就按第 4 节重启一次
```

（只要你没有改过仓库内容，`reset --hard` 绝不会丢你的配置 / 知识库 / 状态。）

## 6. 常见问题

| 症状 | 原因 / 处理 |
| --- | --- |
| `git pull` 说 diverged | 服务器上有人改过代码 ⇒ 按第 0 节：不该改。`git stash` 后再拉；或直接 `git reset --hard origin/main` |
| PowerShell 里 git 报错 `exit 1` 但其实成功 | PowerShell 把 git 写到 stderr 的进度行当成错误。**看输出里 `main -> main` 那行**，别只看退出码 |
| 脚本里中文文件名变成 `\345\233\276` | git 默认对非 ASCII 路径做八进制转义 ⇒ 用 `git -c core.quotepath=false ls-files` |
| 改过 `.md`/`.js` 后 diff 是整个文件 | 行尾被改了（LF/CRLF 混）。用编辑器保持原行尾，别手动换行 |
| `state/`、`logs/` 会被覆盖吗 | 不会 —— 它们不在 git 里。真没了说明是人为删除，找备份 |

## 7. 别做的事

- ❌ 别把 `config.yml`、`knowledge/` 的活文件、`state/`、`logs/` 提交或推送
- ❌ 别在服务器副本上提交代码改动
- ❌ 别拿 `logs/` 当垃圾清（里面可能有你自己的聊天记录）
- ❌ 删 `napcat/`、`node/` 前想清楚：那是协议端运行时，重装很慢

---

_维护者注：本仓库是「公开脱敏快照」，由维护者的开发仓库单向同步；服务器侧的更新流程就是上面这些。_
