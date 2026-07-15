// ==UserScript==
// @name         DeepSeek Usage — DeepSeek用量页增强
// @namespace    https://github.com/PingWangWang
// @url          https://github.com/PingWangWang/DeepSeek-Usage.git
// @version      1.26.0
// @description  用量页增强仪表盘：订阅推送、费用/Token构成、缓存命中率、Key明细（ZIP导入/模型统计/筛选/每日费用曲线/多选删除）、月份切换、自动刷新、手机适配。
// @author       PingWangWang
// @icon         https://www.deepseek.com/favicon.ico
// @match        https://platform.deepseek.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @downloadURL  https://raw.githubusercontent.com/PingWangWang/DeepSeek-Usage/main/DeepSeek-Usage.user.js
// @updateURL    https://raw.githubusercontent.com/PingWangWang/DeepSeek-Usage/main/DeepSeek-Usage.meta.js
// @supportURL   https://github.com/PingWangWang/DeepSeek-Usage/issues
// @connect      oapi.dingtalk.com
// @connect      www.picgo.net
// @license      MIT
// ==/UserScript==