# DeepSeek Usage+ — 用量页增强仪表盘

> 本项目基于 [DeepSeek Usage+](https://greasyfork.org/zh-CN/scripts/578066-deepseek-usage-%E5%AE%98%E6%96%B9api%E7%94%A8%E9%87%8F%E9%A1%B5%E5%A2%9E%E5%BC%BA%E4%BB%AA%E8%A1%A8%E7%9B%98) 修改扩展，为 DeepSeek API 用量页（platform.deepseek.com/usage）注入完整的数据分析仪表盘，并可在对话页快速跳转。

[![Version](https://img.shields.io/badge/version-1.11.76-blue)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-supported-orange)]()

## ✨ 项目亮点

- **一键安装，开箱即用**：Tampermonkey 用户脚本，安装即可在用量页看到扩展面板，无需任何配置
- **订阅推送**：支持定时向钉钉/飞书/企业微信 Webhook 推送用量报告（Markdown 或截图+ImgBB 图床），无需后端服务
- **费用、Token、缓存全掌握**：当日费用、月度费用、均价、当月可用 Tokens，一目了然
- **交互图表驱动分析**：基于 ECharts 实现请求趋势、Token 构成、缓存命中率、模型分布等 7 张交互图表
- **Key 级明细账单**：支持从 DeepSeek 导出 ZIP 导入 Key 级别的用量和费用数据，含堆叠条形图和模型细分
- **月份选择与自动刷新**：顶部月份下拉框切换统计周期，支持 30s~1h 的可选自动刷新
- **灵活的图表开关**：各图表区块可独立显示/隐藏，支持记忆
- **原生内容开关**：可隐藏页面原有内容，仅显示扩展面板
- **中文开发者优化**：万位分割（中文数字习惯）、CNY 金额格式化、全中文标签
- **自动主题适配**：跟随 DeepSeek 页面明/暗模式自动切换图表配色

## 📦 安装

### 前提条件
浏览器需安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（Chrome / Edge / Firefox 均支持）。

### 安装方式

**方式一 — 直接使用（推荐）**

1. 在 Tampermonkey 中创建新脚本
2. 将 [`DeepSeek Usage.txt`](./DeepSeek%20Usage.txt) 的全部内容粘贴进去
3. 保存（`Ctrl+S`）并启用

**方式二 — 从 GitHub 原始链接安装**

```bash
# 将以下地址粘贴到浏览器中，Tampermonkey 会自动弹出安装页面：
# https://raw.githubusercontent.com/你的仓库/main/DeepSeek%20Usage.txt
```

## 🚀 快速开始

1. 安装脚本后，打开 [platform.deepseek.com/usage](https://platform.deepseek.com/usage) 并登录
2. 在"每月用量"表格下方会自动出现 **扩展用量** 面板
3. 面板包含：
   - **汇总卡片**：当日费用、当月费用、均价、当月用量、预估可用 Tokens
   - **趋势图表**：API 请求数、Tokens、缓存命中率、Token 构成（支持显示/隐藏）
   - **模型明细表与分布图**：每个模型的请求数、Tokens、缓存命中、费用
   - **Key 明细**：从 DeepSeek 导出 ZIP 导入，支持按 Key/按模型统计，可折叠表格
4. 使用顶部月份下拉框切换统计月份，点击 **自动刷新** 可设置定时刷新

## 🧭 功能详解

### 汇总指标
| 指标 | 说明 |
|------|------|
| 当日费用 | 当日实际费用（优先从 cost API 获取，fallback 按均价估算），仅当前月显示 |
| 当月费用 | 选中月份总费用 |
| 当月平均费用 | 每百万 Tokens 的均价，细分输入/输出 |
| 当月用量 | 选中月份的总 Token 用量 |
| 预估可用 | 根据钱包余额和均价估算的可用 Tokens，仅当前月显示 |

### 交互图表
| 图表 | 类型 | 作用 |
|------|------|------|
| API 请求次数汇总 | 折线图 | 每日请求量趋势 |
| Tokens 汇总 | 堆叠柱状图 | 每日输出 / 输入未缓存 / 缓存命中的 Token 分布 |
| 缓存命中率 | 折线图 | 每日 Prompt 缓存命中率变化 |
| Token 构成 | 水平条形图 | 本月累计 Token 组成（输出 / 未缓存 / 缓存命中） |
| 模型分布 | 环形图 | 各模型 Token 占比（Top 8） |
| Key 费用分布 | 堆叠水平条形图 | 各 API Key 或各模型的未缓存 / 缓存 / 输出费用 |

### 顶部工具栏
| 功能 | 说明 |
|------|------|
| 月份选择 | 下拉框切换统计月份，数据实时刷新 |
| 订阅 | 点击弹出订阅管理面板，可创建定时推送配置（Webhook / 剪贴板 / 面板预览） |
| 请求 / Tokens / 缓存 / Token构成 / 模型 | 开关按钮，独立控制各图表区块显示/隐藏，状态持久化 |
| 显示原生内容 | 切换 DeepSeek 页面原有内容的显示/隐藏 |
| 自动刷新 | 点击循环切换：关→30秒→5分钟→10分钟→30分钟→1小时，启用时绿色高亮 |
| 刷新 | 手动刷新全部数据（用量 + Key 明细） |
| Key 筛选 | 在 Key 明细区域，支持多选筛选 Key，支持全选/全取消，状态持久化 |

### Key 明细（高级功能）
- 点击 **刷新** 按钮自动调用 DeepSeek 导出接口下载月度 ZIP
- 解压并解析其中的 `amount-*.csv` 文件，先按 (Key, 模型) 二元组精确聚合，再汇总到 Key 级别
- 支持缓存命中/未命中的费用拆分
- 表格可折叠，图表高度自动适配
- **按模型统计**：开启后表格展示各 Key 下按模型细分的子行，图表切换为模型级堆叠条形图
- **Key 筛选**：支持多选/全选/全取消筛选 Key，展示数据、费用分布图和每日曲线图同步过滤
- 数据自动记忆（localStorage），切换页面后自动恢复

### 对话页快捷入口
在 [chat.deepseek.com](https://chat.deepseek.com) 页面左上角，工具栏中会出现一个柱状图图标按钮，点击即可在新窗口打开 API 用量页。

### 订阅推送（新功能）
在扩展用量面板顶部工具栏新增 **订阅** 按钮，支持定时推送用量报告：

- **接收方式**：钉钉 / 飞书 / 企业微信 Webhook、复制到剪贴板、面板内预览
- **内容格式**：Markdown 文本或截图（自动上传 ImgBB 图床，在消息中嵌入图片链接）
- **ImgBB 集成**：截图模式下需在订阅配置中填写 ImgBB API Key（免费注册 api.imgbb.com），上传失败自动降级为 Markdown
- **发送频率**：间隔（自定义分钟数）、每天、每周、每月
- **内容定制**：可选择包含费用摘要、Token 构成、缓存命中率、Key 明细、Top N Key 等
- **Key 筛选**：可针对特定 API Key 生成报告
- **定时触发**：页面打开期间按设定频率自动检查并推送
- **无需后端**：直接使用浏览器 fetch 调用 Webhook URL，飞书/钉钉/企微均支持 CORS

## 📁 项目结构

- `DeepSeek-Usage.user.js` — 用户脚本主文件（~5200 行），包含全部逻辑、样式、模板和图表配置
- `DeepSeek-Usage.meta.js` — Tampermonkey 元数据头文件

## 🛠️ 技术架构

| 依赖 | 用途 |
|------|------|
| [ECharts 5.6](https://echarts.apache.org/) | 交互图表渲染（SVG 模式） |
| [JSZip 3.10](https://stuk.github.io/jszip/) | 解压 DeepSeek 导出的 ZIP 文件 |
| [html2canvas 1.4](https://html2canvas.hertzen.com/) | 报告截图生成（按需动态加载） |
| Tampermonkey `@require` | CDN 加载上述库 |
| MutationObserver | 监听页面变化自动刷新 |
| History API 拦截 | 感知 SPA 路由变化 |

### 脚本运行机制
1. 通过 `@match` 匹配 `platform.deepseek.com/*`
2. 自动从 `localStorage` / `sessionStorage` 中提取登录 Token
3. 调用 `usage/amount`、`usage/cost`、`users/get_user_summary` 三个 API 获取数据
4. 智能适配 API 响应格式（`biz_data` 解包、字段名自动匹配）
5. 将数据渲染为 HTML 仪表盘 + ECharts 图表

## ❓ 适用场景

- **API 重度用户**：需要实时追踪 DeepSeek API 调用量和费用
- **多 Key 管理**：通过导入 Key 明细，分析各 API Key 的使用和费用分布
- **缓存策略优化**：观察缓存命中率趋势，调整 Prompt 设计以降低成本
- **预算控制**：通过均价和余额估算，预判可用调用量

## 🧪 开发

该脚本是纯前端用户脚本，无需构建工具。修改后直接保存并刷新页面即可生效。

```bash
# 本地开发时，在 Tampermonkey 中指向本地文件
# 或通过 @require file:// 引入（需在 Tampermonkey 设置中开启文件 URL 访问）
```

## 🤝 贡献

欢迎提交 Issue 和 PR。

### 开发指引
- 核心逻辑入口：`boot()` → `installRouteObserver()` → `bootUsage()` / `bootChatButton()`
- 数据获取：`loadData()` → `fetchJson()` 调用三个 API 端点
- 数据归一化：`normalizeSummary()` / `normalizeAmount()` / `normalizeCost()`
- 面板渲染：`buildPanelData()` → `renderPanel()` → `initCharts()`
- Key 明细导入：`fetchKeyDetailFromExport()` → 下载 ZIP → JSZip 解压 → `parseCSV()` 解析 → 聚合展示
- 订阅推送：`sendSubscriptionReport()` → `buildMarkdownReport()` / `captureReportScreenshot()` → `sendToWebhook()` / `copyReportToClipboard()`

### 待改进
- Key 明细导入目前依赖页面上的导出 ZIP 接口，速度较慢
- 缺少单元测试

## 📝 License

MIT

---

*为 DeepSeek API 用户打造的开源用量分析工具。*
