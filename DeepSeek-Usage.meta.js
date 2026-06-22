// ==UserScript==
// @name         DeepSeek Usage — DeepSeek用量页增强
// @namespace    https://github.com/PingWangWang
// @url          https://github.com/PingWangWang/DeepSeek-Usage.git
// @version      1.9.53
// @description  DeepSeek 用量页只展示了基础数字和简表。本项目基于 DeepSeek Usage+ 修改，在其基础上扩展为完整的数据分析仪表盘，包含费用细分、Token 构成、交互图表、缓存命中率、Key 明细（支持从导出ZIP导入、按模型统计、Key筛选、每日费用曲线）、月份选择、自动刷新、手机端适配等功能。
// @author       PingWangWang
// @icon         https://www.deepseek.com/favicon.ico
// @match        https://platform.deepseek.com/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @downloadURL  https://raw.githubusercontent.com/PingWangWang/DeepSeek-Usage/main/DeepSeek-Usage.user.js
// @updateURL    https://raw.githubusercontent.com/PingWangWang/DeepSeek-Usage/main/DeepSeek-Usage.meta.js
// @supportURL   https://github.com/PingWangWang/DeepSeek-Usage/issues
// @license      MIT
// ==/UserScript==