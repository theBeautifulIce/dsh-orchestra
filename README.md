# DSH Orchestra

**从 Agent 的会话管理迈向任务流程管理**

用三个 Agent 合写一份发布说明，最费神的往往是交接工作。一个会话整理了新功能，另一个找出了已知限制，你得把两份结果交给写稿的 Agent。隔天回来，还要翻聊天记录，确认手上的稿子有没有补上昨天提的那条修改。

DSH Orchestra 是 DeepSeek Harness（DSH）的工作流编排插件。你在原会话说清要交付什么，Orchestra 把工作拆成步骤，放在同一项任务里。可以分头做的步骤按可用名额开工，负责汇总的步骤等所需材料到齐再开始。离开一会儿再回来，打开同一张任务卡，就知道**做到哪一步、什么事在等你、这次交付了哪些文件**。

[下载 Beta 插件包][download] · [先看一份实际交付的报告][net] · [安装与试用](#安装与试用) · [English][english]

## 一句话交办，四份报告

在一次真实的 DSH Desktop 试用中，用户在普通会话里请 Orchestra 核对一份办公流水，分别报出收入、退款和行数，最后用收入和退款算出净额。

| 任务里的步骤 | 怎样配合 | 这次交付 |
| --- | --- | --- |
| 核对收入 | 独立读取流水 | [收入报告][income]，两笔合计 **200.00** |
| 核对退款 | 可与收入核对同时进行 | [退款报告][refund]，一笔退款 **20.00** |
| 清点行数 | 独立清点数据行 | [行数报告][rows]，共 **3 行** |
| 计算净额 | 收入和退款两份报告到齐就能开始 | [净额报告][net]，**200.00 − 20.00 = 180.00** |

这四份报告随同一次任务交付。用户回到原会话就能看到完成通知。要复核 **180.00**，打开净额报告，可以顺着文件名找到两份原始核对结果。[查看这次任务的运行记录][case]

## 安装与试用

1. 下载 [`dsh-orchestra-0.1.0-beta.1.tgz`][download]。本版面向 DSH `0.2.2` 系列，原生会话派单与审批已在 **DSH Desktop `0.2.2-rc.5`** 验证。
2. 在 DSH Desktop 的**插件管理**中安装这个包，按提示重新加载。侧栏出现 **Orchestra** 后，打开一个工作区及其中的普通会话，选用已配置的模型。
3. 把下面整段发到会话里。`/orchestra` 会把这条消息明确交给插件。第一次用也可以直接描述目标，Orchestra 能为这次任务生成专属流程，以后遇到同类工作时也能复用合适的已发布流程。

```text
/orchestra 帮我给试用者写一份发布说明草稿。材料都在这条消息里。

开发记录里有两项已交付的改动，分别是新增报告导出和修复列表排序。批量导出还在开发中。
试用者想知道从哪导出，以及能不能一次导出多份。单份报告的导出入口在结果页。

请分头整理「已经交付的改动」和「用户最关心的问题」，再用这两份结果写成 release-note.md。
读者看完要知道去哪里导出一份报告，也要知道批量导出仍在开发中。
```

看到 **Orchestra 已接单** 后，可以留在原会话等结果，也可以打开 **Orchestra → 任务** 查看分工。完成后，在这次运行的 **结果** 里打开 `release-note.md`。用试用者的问题验一下稿子——现在可以一次导出几份？

## 任务进行时，你可以在哪里看

| 你想知道什么 | 去哪里看 |
| --- | --- |
| 做到哪了，哪几步在一起跑？ | 在 **任务 → 看板** 展开任务卡。切到 **流程** 可以看到每一步依赖谁。 |
| 某一步怎么一直没动？ | 打开 **队列**，查看它在等上游结果、可用执行名额，还是等人处理。 |
| 这一步需要我同意什么？ | 在原会话的审批卡或 **审批中心** 查看申请原因和确认后会执行的动作，再决定是否授权。 |
| 成品里有一处需要改，怎么指出来？ | 对需要人工审核的交付，在 **结果 → 成果审核与返工** 打开当前版本并填写具体意见。符合返工条件时，意见会交回负责这份成果的步骤，修订后可以再验。支持会话内审核的宿主也可直接在原会话处理。 |

![DSH Desktop 结果页，可以预览已交付的文件并查看审核入口][result-image]

*结果页示意，使用隔离桌面环境中的示例任务。*

## 使用提示

- **习惯直接说任务？** 个人 Desktop 默认开启「聊天任务自动接管」。在 **Orchestra → 设置** 可以关闭，之后用 `/orchestra` 挑选要交给插件的任务。
- **想看看计划再开始？** 打开 **任务 → 用自然语言规划任务**，输入目标，核对分工和交付物后确认启动。
- **退出过 DSH？** 本机任务依赖桌面宿主运行。重新打开后，从原任务查看最后进度和待处理事项。

[Beta 发布说明][release] · [配置、自管宿主与源码构建][guide] · [设计说明][design] · [桌面验收记录][desktop]

本项目采用 [PolyForm Noncommercial License 1.0.0][license]，可按许可条款用于非商业用途。商业使用需另行授权。

[download]: https://github.com/theBeautifulIce/dsh-orchestra/releases/download/v0.1.0-beta.1/dsh-orchestra-0.1.0-beta.1.tgz
[english]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/README.en.md
[income]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/reviews/acceptance/evidence/desktop-1120-b/qa-b-income.md
[refund]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/reviews/acceptance/evidence/desktop-1120-b/qa-b-refund.md
[rows]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/reviews/acceptance/evidence/desktop-1120-b/qa-b-rows.md
[net]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/reviews/acceptance/evidence/desktop-1120-b/qa-b-net.md
[case]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/reviews/acceptance/dispatch-views.md#L3-L8
[result-image]: https://raw.githubusercontent.com/theBeautifulIce/dsh-orchestra/v0.1.0-beta.1/docs/assets/readme/results.png
[release]: https://github.com/theBeautifulIce/dsh-orchestra/releases/tag/v0.1.0-beta.1
[guide]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/README.md#共享资料和设置
[design]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/design-notes.md
[desktop]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/docs/reviews/acceptance/desktop.md
[license]: https://github.com/theBeautifulIce/dsh-orchestra/blob/v0.1.0-beta.1/LICENSE
