# 第三方组件与许可声明

本安装包/本仓库**只分发自己的代码**，以及一个 Node.js 运行时。用到的第三方组件如下。

## 1. Node.js（**内嵌**在 `node\node.exe`）

- 许可：MIT
- 版权：Copyright Node.js contributors
- 完整许可文本见 `node\LICENSE-node.txt`
- 官方：https://nodejs.org/

## 2. NapCatQQ（**没有内嵌**，需要你自己安装）

- 项目：https://github.com/NapNeko/NapCatQQ
- 许可：**Limited Redistribution License for NapCat**（Copyright © 2024 Mlikiowa）
  —— **这不是一个标准开源许可**，要点：
  1. 未经作者明确许可，禁止未授权的使用/复制/修改/分发；
  2. **允许再分发，但必须附上该许可全文、并明确标注来源与版权**；
     为再分发做的小修改可以，但**改过的代码不得公开**；
  3. **不得用于任何商业用途**；
  4. 其它权利需向作者申请。
- 本项目因此：**不打包、不再分发 NapCat**，只在安装器里给你官方下载地址，
  由你自行下载安装（**这一步是你与 NapCat 作者之间的关系**）。
- ⚠️ 因为依赖 NapCat，**本项目的整体使用也不得用于商业用途**。

## 3. 表情图片（`library\` 目录）

- 来源：网络与群聊，版权归各自原作者，仅作演示；
  介意的话把 `library\` 换成你自己的图片（或整个删掉，机器人只是没有表情包可用）。

## 4. 其它依赖

- `package.json` 里列出的 npm 包，各自的许可见 `node_modules\<包>\LICENSE`。

## ⚠️ 风险提示

本程序通过第三方协议端（NapCat）接入 QQ，**这可能违反腾讯的服务条款**，
账号存在被限制/风控的风险，请自行评估。本程序按"原样"提供，不提供任何担保。
