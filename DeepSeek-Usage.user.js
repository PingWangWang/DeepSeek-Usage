// ==UserScript==
// @name         DeepSeek Usage — DeepSeek用量页增强
// @namespace    https://github.com/PingWangWang
// @url          https://github.com/PingWangWang/DeepSeek-Usage.git
// @version      1.9.54
// @description  用量页增强仪表盘：费用/Token构成、缓存命中率、Key明细（ZIP导入/模型统计/筛选/每日费用曲线）、月份切换、自动刷新、手机适配。
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

(function () {
  "use strict";

  const PANEL_ID = "dsapi-plus-panel";
  const STYLE_ID = "dsapi-plus-style";
  const USAGE_PAGE_URL = "https://platform.deepseek.com/usage";
  const TOKEN_TYPES = {
    request: "REQUEST",
    response: "RESPONSE_TOKEN",
    promptMiss: "PROMPT_CACHE_MISS_TOKEN",
    promptHit: "PROMPT_CACHE_HIT_TOKEN",
  };

  const state = {
    selectedPeriod: "",
    observer: null,
    refreshTimer: 0,
    mutationTimer: 0,
    routeTimer: 0,
    requestId: 0,
    tokenSource: "none",
    abortController: null,
    charts: [],
    chartResizeObserver: null,
    lastPanelData: null,
    booted: false,
    historyHooked: false,
    tooltipActive: false,
    tooltipKeeperTimer: 0,
    tooltipKeeperChart: null,
    tooltipKeeperPoint: null,
    pendingThemeUpdate: false,
    pendingPanelData: null,
    // Key 明细数据（从导出接口获取）
    keyDetailData: null,       // 按 key 聚合后的数据
    keyDetailLoading: false,   // 正在加载中
    keyDetailError: "",        // 加载错误信息
    keyDetailUpdateTime: "",   // 上次成功导入的时间
    keyUnitPrices: {},         // { model: { promptMiss: 单价, promptHit: 单价, response: 单价 } }

    // Key 明细表格显示状态
    keyTableVisible: loadKeyTableVisible(),    // 默认不显示表格详情（已持久化）

    // 各图表区块显示状态（持久化到 localStorage）
    sectionVisible: loadSectionVisible(),

    // 原生内容（页面原有的每月用量等）显示状态
    nativeContentVisible: loadNativeContentVisible(),

    // 按模型分组开关
    groupByModel: loadGroupByModel(),

    // 自动刷新
    autoRefreshInterval: loadAutoRefreshInterval(),
    autoRefreshTimer: 0,       // setInterval 句柄

    // Key 筛选
    keyFilter: loadKeyFilter(),  // { mode: "all", keys: [...] } 或 null

    // 每日详情
    keyDetailDailyVisible: loadKeyDetailDailyVisible(),
    keyDetailDailyData: null,  // { dates: [], series: [{name, data}] }
  };

  function loadSectionVisible() {
    try {
      const saved = localStorage.getItem("dsapi_plus_section_visible");
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return { requests: false, tokens: false, cacheRate: false, composition: false, models: false };
  }

  function saveSectionVisible() {
    try {
      localStorage.setItem("dsapi_plus_section_visible", JSON.stringify(state.sectionVisible));
    } catch (e) { /* ignore */ }
  }

  function loadKeyTableVisible() {
    try {
      const saved = localStorage.getItem("dsapi_plus_key_table_visible");
      return saved === "true";
    } catch (e) { /* ignore */ }
    return false;
  }

  function saveKeyTableVisible() {
    try {
      localStorage.setItem("dsapi_plus_key_table_visible", String(state.keyTableVisible));
    } catch (e) { /* ignore */ }
  }

  function loadKeyDetailDailyVisible() {
    try {
      return localStorage.getItem("dsapi_plus_key_daily_visible") === "true";
    } catch (e) { /* ignore */ }
    return false;
  }

  function saveKeyDetailDailyVisible() {
    try {
      localStorage.setItem("dsapi_plus_key_daily_visible", String(state.keyDetailDailyVisible));
    } catch (e) { /* ignore */ }
  }

  function loadNativeContentVisible() {
    try {
      const saved = localStorage.getItem("dsapi_plus_native_content_visible");
      return saved !== "false"; // 默认显示
    } catch (e) { /* ignore */ }
    return true;
  }

  function saveNativeContentVisible() {
    try {
      localStorage.setItem("dsapi_plus_native_content_visible", String(state.nativeContentVisible));
    } catch (e) { /* ignore */ }
  }

  function saveKeyDetailData() {
    if (!state.keyDetailData || !state.keyDetailData.length) return;
    try {
      const payload = {
        data: state.keyDetailData,
        unitPrices: state.keyUnitPrices,
        updateTime: state.keyDetailUpdateTime,
        dailyData: state.keyDetailDailyData,
      };
      localStorage.setItem("dsapi_plus_key_detail", JSON.stringify(payload));
    } catch (e) { /* storage quota 不足时静默忽略 */ }
  }

  function loadKeyDetailData() {
    try {
      const saved = localStorage.getItem("dsapi_plus_key_detail");
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return null;
  }

  function loadGroupByModel() {
    try {
      return localStorage.getItem("dsapi_plus_group_by_model") === "true";
    } catch (e) { /* ignore */ }
    return false;
  }

  function saveGroupByModel() {
    try {
      localStorage.setItem("dsapi_plus_group_by_model", String(state.groupByModel));
    } catch (e) { /* ignore */ }
  }

  const AUTO_REFRESH_INTERVALS = [
    { label: "关", value: 0 },
    { label: "1分钟", value: 60000 },
    { label: "5分钟", value: 300000 },
    { label: "10分钟", value: 600000 },
    { label: "30分钟", value: 1800000 },
  ];

  function loadAutoRefreshInterval() {
    try {
      const v = parseInt(localStorage.getItem("dsapi_plus_auto_refresh"), 10);
      if (v > 0) {
        // 兼容旧数据：匹配最近的可用间隔（如旧版 30秒 → 1分钟）
        const match = AUTO_REFRESH_INTERVALS.find((i) => i.value === v);
        if (match) return match.value;
        // 没有精确匹配时取最接近的（向最近的有效值靠拢）
        const sorted = AUTO_REFRESH_INTERVALS.filter((i) => i.value > 0).sort((a, b) => a.value - b.value);
        const nearest = sorted.reduce((a, b) => Math.abs(b.value - v) < Math.abs(a.value - v) ? b : a);
        return nearest.value;
      }
      return 0;
    } catch (e) { /* ignore */ }
    return 0; // 默认关闭
  }

  function saveAutoRefreshInterval() {
    try {
      localStorage.setItem("dsapi_plus_auto_refresh", String(state.autoRefreshInterval));
    } catch (e) { /* ignore */ }
  }

  function loadKeyFilter() {
    try {
      const saved = localStorage.getItem("dsapi_plus_key_filter");
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return { mode: "all", keys: [] };
  }

  function saveKeyFilter() {
    try {
      localStorage.setItem("dsapi_plus_key_filter", JSON.stringify(state.keyFilter));
    } catch (e) { /* ignore */ }
  }

  function getFilteredKeyData() {
    const data = state.keyDetailData;
    if (!data || !data.length) return data;
    const filter = state.keyFilter;
    if (!filter || filter.mode === "all" || !filter.keys || !filter.keys.length) return data;
    return data.filter((item) => filter.keys.includes(item.key));
  }

  function getFilteredDailyData() {
    const dd = state.keyDetailDailyData;
    if (!dd || !dd.series) return dd;
    const filter = state.keyFilter;
    if (!filter || filter.mode === "all" || !filter.keys || !filter.keys.length) return dd;
    return {
      dates: dd.dates,
      series: dd.series.filter((s) => filter.keys.includes(s.name)),
    };
  }

  function applyAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = 0;
    }
    if (state.autoRefreshInterval > 0) {
      state.autoRefreshTimer = setInterval(() => {
        refresh(true);
        // 同时刷新 Key 明细数据（如果已导入过）
        if (state.keyDetailData && state.keyDetailData.length) {
          const period = getSelectedPeriod();
          const controller = new AbortController();
          fetchKeyDetailFromExport(period, controller.signal);
        }
      }, state.autoRefreshInterval);
    }
  }

  function getAutoRefreshLabel(interval) {
    const found = AUTO_REFRESH_INTERVALS.find((i) => i.value === interval);
    return found ? found.label : "关";
  }

  function nextAutoRefreshInterval(current) {
    const idx = AUTO_REFRESH_INTERVALS.findIndex((i) => i.value === current);
    return AUTO_REFRESH_INTERVALS[(idx + 1) % AUTO_REFRESH_INTERVALS.length].value;
  }

  function isUsagePage() {
    return location.pathname === "/usage" || location.pathname.startsWith("/usage/");
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .dsapi-plus-panel {
        --dsapi-plus-text: rgb(var(--ds-rgb-label-1, 2 14 54));
        --dsapi-plus-muted: rgb(var(--ds-rgb-label-2, 87 97 135));
        box-sizing: border-box;
        width: 100%;
        margin: 0 0 42px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--dsapi-plus-text);
        font-family: inherit;
      }
      .dsapi-plus-page-wide .b7e4e307,
      .dsapi-plus-page-wide main > div {
        max-width: none !important;
      }
      .dsapi-plus-page-wide ._6660b4d {
        padding-left: clamp(20px, 3vw, 44px) !important;
        padding-right: clamp(20px, 3vw, 44px) !important;
      }
      .dsapi-plus-head,
      .dsapi-plus-summary,
      .dsapi-plus-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .dsapi-plus-title {
        display: flex;
        align-items: baseline;
        gap: 10px;
        min-width: 0;
      }
      .dsapi-plus-title strong {
        font-size: 16px;
        line-height: 16px;
        font-weight: var(--ds-font-weight-strong, 600);
      }
      .dsapi-plus-subtitle {
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        line-height: 18px;
      }
      .dsapi-plus-period-select {
        background: transparent;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        color: var(--dsapi-plus-muted);
        font: inherit;
        font-size: 12px;
        line-height: 18px;
        padding: 2px 4px;
        cursor: pointer;
        outline: none;
        opacity: 0.7;
        transition: opacity 0.15s;
      }
      .dsapi-plus-period-select:hover,
      .dsapi-plus-period-select:focus {
        opacity: 1;
      }
      .dsapi-plus-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      .dsapi-plus-head {
        margin-bottom: 0;
      }
      .dsapi-plus-status {
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
      }
      .dsapi-plus-refresh {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 6px;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-refresh:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-toggle-section-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 2px;
        min-width: 64px;
        text-align: center;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-toggle-section-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-toggle-section-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-toggle-native-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 6px;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
        white-space: nowrap;
      }
      .dsapi-plus-toggle-native-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
        border-style: solid;
      }
      .dsapi-plus-toggle-native-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
        border-style: solid;
      }
      .dsapi-plus-group-model-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 6px;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-group-model-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-group-model-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-auto-refresh-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 6px;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-auto-refresh-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-auto-refresh-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-toggle-key-btn {
        background: transparent;
        border: 1px solid var(--dsapi-plus-muted);
        color: var(--dsapi-plus-muted);
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        white-space: nowrap;
        opacity: 0.7;
        transition: opacity 0.15s;
      }
      .dsapi-plus-toggle-key-btn:hover {
        opacity: 1;
      }
      .dsapi-plus-toggle-key-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-daily-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 6px;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-daily-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-daily-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-key-filter-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        padding: 4px 6px;
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-key-filter-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-filter-list label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        line-height: 22px;
        padding: 1px 4px;
        cursor: pointer;
        border-radius: 3px;
        white-space: nowrap;
      }
      .dsapi-plus-filter-list label:hover {
        background: rgba(2, 14, 54, 0.04);
      }
      .dsapi-plus-filter-list input {
        margin: 0;
        accent-color: #22c55e;
      }
      .dsapi-plus-toggle-chart-btn {
        background: none;
        border: 1px solid var(--dsapi-plus-muted);
        color: var(--dsapi-plus-muted);
        width: 20px;
        height: 20px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        opacity: 0.5;
        transition: opacity 0.15s;
      }
      .dsapi-plus-toggle-chart-btn:hover {
        opacity: 1;
      }
      .dsapi-plus-debug {
        appearance: none;
        border: 0;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        line-height: 18px;
        padding: 5px 0;
      }
      .dsapi-plus-debug:hover {
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-body {
        margin-top: 21px;
      }
      .dsapi-plus-summary {
        align-items: flex-start;
        justify-content: flex-start;
        flex-wrap: wrap;
        margin-bottom: 32px;
      }
      .dsapi-plus-summary-item {
        min-width: 0;
        margin-right: 28px;
      }
      .dsapi-plus-summary-label {
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        line-height: 18px;
      }
      .dsapi-plus-summary-value {
        margin-top: 5px;
        font-size: 16px;
        font-weight: var(--ds-font-weight-strong, 600);
        line-height: 22px;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
      .dsapi-plus-summary-unit {
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        font-weight: 400;
        line-height: 18px;
        margin-left: 4px;
      }
      .dsapi-plus-summary-detail {
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        font-weight: 400;
        line-height: 18px;
        margin-top: 2px;
      }
      .dsapi-plus-section {
        margin-top: 18px;
      }
      .dsapi-plus-section-head {
        display: flex;
        align-items: baseline;
        justify-content: flex-start;
        gap: 12px;
        margin-bottom: 10px;
      }
      .dsapi-plus-section-title {
        font-size: 14px;
        font-weight: 650;
        line-height: 20px;
      }
      .dsapi-plus-section-meta {
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        line-height: 18px;
      }
      .dsapi-plus-chart-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 42px 64px;
      }
      .dsapi-plus-chart-block {
        min-width: 0;
      }
      .dsapi-plus-chart-heading {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 18px;
      }
      .dsapi-plus-chart-heading-title {
        font-size: var(--ds-font-size-sp, 14px);
        line-height: var(--ds-line-height-sp, 18px);
        font-weight: 400;
      }
      .dsapi-plus-chart-heading-value {
        color: var(--dsapi-plus-muted);
        font-size: var(--ds-font-size-sp, 14px);
        line-height: var(--ds-line-height-sp, 18px);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .dsapi-plus-chart-frame {
        height: 160px;
        position: relative;
      }
      .dsapi-plus-chart {
        width: 100%;
        height: 160px;
      }
      .dsapi-plus-table-wrap {
        overflow-x: auto;
        border: 0;
        border-radius: 0;
      }
      .dsapi-plus-table {
        width: 100%;
        min-width: 620px;
        border-collapse: collapse;
        font-size: 12px;
        line-height: 18px;
      }
      .dsapi-plus-table th,
      .dsapi-plus-table td {
        padding: 9px 10px;
        border-bottom: 1px solid rgba(2, 14, 54, 0.07);
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .dsapi-plus-table th:first-child,
      .dsapi-plus-table td:first-child {
        max-width: 230px;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dsapi-plus-table th {
        color: var(--dsapi-plus-muted);
        background: rgba(2, 14, 54, 0.035);
        font-weight: 600;
      }
      .dsapi-plus-table tr:last-child td {
        border-bottom: 0;
      }
      .dsapi-plus-message {
        border: 1px dashed rgba(2, 14, 54, 0.14);
        border-radius: 8px;
        color: var(--dsapi-plus-muted);
        font-size: 13px;
        line-height: 20px;
        padding: 16px;
      }
      .dsapi-plus-detail-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(300px, 28%);
        gap: 20px;
        align-items: start;
      }
      .dsapi-plus-model-donut {
        min-width: 0;
      }
      .dsapi-plus-model-donut .dsapi-plus-chart-heading {
        margin-bottom: 6px;
      }
      .dsapi-plus-model-donut .dsapi-plus-chart-frame {
        height: 136px;
      }
      .dsapi-plus-model-donut .dsapi-plus-chart {
        height: 136px;
      }
      .dsapi-plus-error {
        border-color: rgba(214, 69, 65, 0.28);
        color: rgb(170, 49, 45);
        background: rgba(214, 69, 65, 0.04);
      }
      body.dark .dsapi-plus-table th,
      body.dark .dsapi-plus-table td {
        border-bottom-color: rgba(255, 255, 255, 0.08);
      }
      body.dark .dsapi-plus-table th {
        background: rgba(255, 255, 255, 0.06);
      }
      body.dark .dsapi-plus-toggle-section-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-toggle-section-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-toggle-native-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
        border-style: solid;
      }
      body.dark .dsapi-plus-toggle-native-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-toggle-key-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-group-model-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-group-model-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-daily-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-daily-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-key-filter-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-key-filter-dropdown {
        background: #1a1a2e;
        border-color: rgba(255, 255, 255, 0.15);
      }
      body.dark .dsapi-plus-filter-list label:hover {
        background: rgba(255, 255, 255, 0.06);
      }
      body.dark .dsapi-plus-filter-all-btn,
      body.dark .dsapi-plus-filter-none-btn {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-auto-refresh-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-auto-refresh-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-period-select {
        border-color: rgba(255, 255, 255, 0.3);
        color: var(--dsapi-plus-muted);
      }
      body.dark .dsapi-plus-period-select:hover,
      body.dark .dsapi-plus-period-select:focus {
        border-color: rgba(255, 255, 255, 0.6);
        color: var(--dsapi-plus-text);
      }
      @media (max-width: 920px) {
        .dsapi-plus-chart-grid {
          grid-template-columns: 1fr;
          gap: 32px;
        }
        .dsapi-plus-detail-layout {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 560px) {
        .dsapi-plus-head,
        .dsapi-plus-section-head {
          align-items: flex-start;
          flex-direction: column;
        }
      }
      @media (max-width: 768px) {
        .dsapi-plus-actions {
          flex-wrap: wrap;
          gap: 6px;
          max-width: 100%;
        }
        .dsapi-plus-title {
          flex-wrap: wrap;
          gap: 6px;
          min-width: 0;
        }
        .dsapi-plus-period-select {
          max-width: 140px;
          font-size: 11px;
        }
        .dsapi-plus-summary {
          gap: 8px;
        }
        .dsapi-plus-summary-item {
          font-size: 12px;
          padding: 6px 10px;
        }
        .dsapi-plus-section-head {
          flex-wrap: wrap;
          gap: 6px;
        }
        .dsapi-plus-section-head .dsapi-plus-section-title {
          width: 100%;
          flex-shrink: 0;
        }
        .dsapi-plus-key-filter-dropdown {
          right: auto;
          left: 0;
          min-width: 140px;
          max-height: 200px;
        }
        .dsapi-plus-table {
          font-size: 10px;
        }
        .dsapi-plus-table th,
        .dsapi-plus-table td {
          padding: 4px 4px;
        }
        .dsapi-plus-chart-frame {
          min-height: 100px;
        }
        .dsapi-plus-chart-heading {
          flex-wrap: wrap;
          gap: 4px;
        }
        .dsapi-plus-toggle-section-btn,
        .dsapi-plus-toggle-key-btn,
        .dsapi-plus-group-model-btn,
        .dsapi-plus-daily-btn,
        .dsapi-plus-key-filter-btn,
        .dsapi-plus-toggle-native-btn,
        .dsapi-plus-refresh,
        .dsapi-plus-auto-refresh-btn {
          font-size: 10px;
          padding: 3px 4px;
        }
      }
      @media (max-width: 480px) {
        .dsapi-plus-head {
          gap: 8px;
        }
        .dsapi-plus-actions {
          gap: 4px;
        }
        .dsapi-plus-title strong {
          font-size: 14px;
        }
        .dsapi-plus-period-select {
          max-width: 100px;
          font-size: 10px;
          padding: 1px 2px;
        }
        .dsapi-plus-chart-frame {
          min-height: 80px;
        }
        .dsapi-plus-table {
          font-size: 9px;
        }
        .dsapi-plus-table th,
        .dsapi-plus-table td {
          padding: 2px 3px;
        }
        .dsapi-plus-toggle-section-btn,
        .dsapi-plus-toggle-key-btn,
        .dsapi-plus-group-model-btn,
        .dsapi-plus-daily-btn,
        .dsapi-plus-key-filter-btn,
        .dsapi-plus-toggle-native-btn,
        .dsapi-plus-refresh,
        .dsapi-plus-auto-refresh-btn {
          font-size: 9px;
          padding: 2px 3px;
        }
        .dsapi-plus-key-filter-dropdown {
          min-width: 120px;
          max-height: 160px;
          font-size: 10px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function formatFourGroup(numStr) {
    // 从右向左每4位插入逗号，符合中文数字习惯（万位分割）
    const parts = String(numStr).split(".");
    const grouped = parts[0].replace(/\B(?=(\d{4})+(?!\d))/g, ",");
    return parts.length > 1 ? grouped + "." + parts[1] : grouped;
  }

  function formatInteger(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return "0";
    return formatFourGroup(String(Math.round(number)));
  }

  function formatDecimal(value, digits = 4) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return "0";
    const numStr = number.toFixed(digits);
    return formatFourGroup(numStr);
  }

  function formatPercent(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return "0%";
    return `${formatDecimal(number * 100, 2)}%`;
  }

  function formatMoney(item) {
    if (!item) return "0";
    const currency = item.currency || "";
    const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
    return `${symbol}${formatDecimal(item.amount ?? item.balance ?? 0, 6)}${currency ? ` ${currency}` : ""}`;
  }

  function formatCnyAmount(value, digits = 4) {
    return `¥${formatDecimal(value, digits)} CNY`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getBizData(json) {
    const unwrapped = unwrapApiPayload(json);
    return parseMaybeJson(unwrapped);
  }

  function unwrapApiPayload(value) {
    let current = parseMaybeJson(value);
    const seen = new Set();

    for (let i = 0; i < 8; i += 1) {
      current = parseMaybeJson(current);
      if (!current || typeof current !== "object" || seen.has(current)) return current;
      seen.add(current);

      if (Object.prototype.hasOwnProperty.call(current, "biz_data")) {
        current = current.biz_data;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(current, "bizData")) {
        current = current.bizData;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(current, "data")) {
        const data = parseMaybeJson(current.data);
        if (data && typeof data === "object") {
          current = data;
          continue;
        }
      }
      if (Object.prototype.hasOwnProperty.call(current, "result")) {
        current = current.result;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(current, "payload")) {
        current = current.payload;
        continue;
      }

      return current;
    }

    return current;
  }

  function parseMaybeJson(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) return value;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return value;
    }
  }

  async function fetchJson(path, signal) {
    const { token, source } = getStoredAuthToken();
    state.tokenSource = source;
    const headers = { accept: "application/json, text/plain, */*" };
    const appVersion = document.querySelector('meta[name="commit-id"]')?.content;

    if (appVersion) headers["X-App-Version"] = appVersion;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(path, {
      credentials: "include",
      headers,
      signal,
    });

    let json = null;
    try {
      json = await response.json();
    } catch (error) {
      throw new Error(`接口返回不是 JSON：${path}`);
    }

    if (!response.ok) {
      const message = json?.message || json?.msg || response.statusText || "请求失败";
      throw new Error(`${response.status} ${message}`);
    }

    const businessCode = json?.code ?? json?.status_code ?? json?.status;
    if (
      businessCode != null &&
      ![0, 200, "0", "200", "success", "SUCCESS", true].includes(businessCode)
    ) {
      const message = json?.message || json?.msg || json?.error_msg || "业务接口返回失败";
      throw new Error(`${businessCode} ${message}`);
    }

    return json;
  }

  function getStoredAuthToken() {
    const candidates = [];

    collectTokenCandidates(candidates, "localStorage", window.localStorage);
    collectTokenCandidates(candidates, "sessionStorage", window.sessionStorage);

    candidates.sort((a, b) => b.score - a.score || b.token.length - a.token.length);
    const best = candidates[0];
    return best ? { token: best.token, source: best.source } : { token: "", source: "none" };
  }

  function collectTokenCandidates(candidates, storageName, storage) {
    if (!storage) return;

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;

      let raw = "";
      try {
        raw = storage.getItem(key) || "";
      } catch (error) {
        continue;
      }

      const loweredKey = key.toLowerCase();
      if (!loweredKey.includes("token") && loweredKey !== "usertoken") continue;
      if (/(hcaptcha|captcha|turnstile|apdid|csrf|xsrf|apple|google)/i.test(key)) continue;

      const parsed = parseMaybeJson(raw);
      const exactKeyScore = loweredKey === "usertoken" ? 100 : 0;
      findTokenStrings(parsed, `${storageName}.${key}`, exactKeyScore, candidates);
    }
  }

  function findTokenStrings(value, source, baseScore, candidates, depth = 0) {
    if (depth > 6 || value == null) return;

    if (typeof value === "string") {
      const token = normalizeTokenString(value);
      if (looksLikeAuthToken(token)) {
        candidates.push({ token, source, score: baseScore + scoreTokenSource(source, token) });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => findTokenStrings(item, `${source}[${index}]`, baseScore, candidates, depth + 1));
      return;
    }

    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const keyScore = /^(token|userToken|access_token|accessToken)$/i.test(key) ? 80 : 0;
        findTokenStrings(child, `${source}.${key}`, baseScore + keyScore, candidates, depth + 1);
      }
    }
  }

  function normalizeTokenString(value) {
    return String(value || "")
      .trim()
      .replace(/^Bearer\s+/i, "")
      .replace(/^"|"$/g, "");
  }

  function looksLikeAuthToken(value) {
    if (!value || value === "null" || value === "undefined") return false;
    if (value.length < 16 || value.length > 4096) return false;
    if (/\s/.test(value)) return false;
    return /^[A-Za-z0-9._~+/=-]+$/.test(value);
  }

  function scoreTokenSource(source, token) {
    let score = 0;
    if (/userToken/i.test(source)) score += 80;
    if (/access[_-]?token|token$/i.test(source)) score += 40;
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) score += 20;
    return score;
  }

  async function loadData(period, signal) {
    const { year, month } = parsePeriod(period);
    const query = `year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;
    const [summaryJson, amountJson, costJson] = await Promise.all([
      fetchJson("/api/v0/users/get_user_summary", signal),
      fetchJson(`/api/v0/usage/amount?${query}`, signal),
      fetchJson(`/api/v0/usage/cost?${query}`, signal),
    ]);

    return {
      period: `${year}-${month}`,
      summary: normalizeSummary(getBizData(summaryJson)),
      amount: normalizeAmount(getBizData(amountJson)),
      cost: normalizeCost(getBizData(costJson)),
      debug: {
        auth: { tokenFound: state.tokenSource !== "none", tokenSource: state.tokenSource },
        summary: summarizeShape(summaryJson),
        amount: summarizeShape(amountJson),
        cost: summarizeShape(costJson),
        amountRawFields: inspectAmountFields(getBizData(amountJson)),
      },
    };
  }

  function parsePeriod(period) {
    const matched = String(period || "").match(/^(\d{4})-(\d{1,2})$/);
    if (matched) return { year: Number(matched[1]), month: Number(matched[2]) };

    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }

  function getSelectedPeriod() {
    // 优先使用自定义月份下拉框
    const customSelect = document.querySelector(".dsapi-plus-period-select");
    if (customSelect && /^\d{4}-\d{1,2}$/.test(customSelect.value)) return customSelect.value;

    const selects = Array.from(document.querySelectorAll("select"));
    for (const select of selects) {
      const value = select.value || select.selectedOptions?.[0]?.value || "";
      if (/^\d{4}-\d{1,2}$/.test(value)) return value;
    }

    const now = new Date();
    return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  }

  function normalizeSummary(raw) {
    const data = findObjectWithKeys(raw, [
      "current_token",
      "currentToken",
      "total_usage",
      "totalUsage",
      "monthly_usage",
      "monthlyUsage",
      "normal_wallets",
      "normalWallets",
    ]) || {};
    return {
      currentToken: firstValue(data, ["current_token", "currentToken"]) ?? 0,
      totalUsage: firstValue(data, ["total_usage", "totalUsage"]) ?? 0,
      monthlyUsage: firstValue(data, ["monthly_usage", "monthlyUsage"]) ?? 0,
      totalAvailableTokenEstimation:
        firstValue(data, ["total_available_token_estimation", "totalAvailableTokenEstimation"]) ?? 0,
      monthlyCosts: asArray(firstValue(data, ["monthly_costs", "monthlyCosts"])),
      normalWallets: asArray(firstValue(data, ["normal_wallets", "normalWallets"])),
      bonusWallets: asArray(firstValue(data, ["bonus_wallets", "bonusWallets"])),
    };
  }

  function normalizeAmount(raw) {
    const data = findUsageDataObject(raw) || {};
    const totals = asArray(firstValue(data, ["total", "totals", "models", "model_usage", "modelUsage"]));
    const days = asArray(firstValue(data, ["days", "daily", "daily_usage", "dailyUsage"]));
    const models = totals.map((item) => normalizeModelUsage(getModelName(item), getUsageList(item)));
    const aggregate = models.reduce(
      (sum, model) => ({
        request: sum.request + model.request,
        response: sum.response + model.response,
        promptMiss: sum.promptMiss + model.promptMiss,
        promptHit: sum.promptHit + model.promptHit,
        tokens: sum.tokens + model.tokens,
      }),
      { request: 0, response: 0, promptMiss: 0, promptHit: 0, tokens: 0 }
    );

    // 按 Key 聚合（如果 API 返回了 Key 信息）
    const keyMap = {};
    for (const item of totals) {
      const keyName = getKeyName(item);
      if (!keyName) continue;
      const usage = normalizeModelUsage(keyName, getUsageList(item));
      if (!keyMap[keyName]) {
        keyMap[keyName] = { key: keyName, request: 0, response: 0, promptMiss: 0, promptHit: 0, tokens: 0, cacheHitRate: 0 };
      }
      keyMap[keyName].request += usage.request;
      keyMap[keyName].response += usage.response;
      keyMap[keyName].promptMiss += usage.promptMiss;
      keyMap[keyName].promptHit += usage.promptHit;
      keyMap[keyName].tokens += usage.tokens;
      const promptTotal = keyMap[keyName].promptMiss + keyMap[keyName].promptHit;
      keyMap[keyName].cacheHitRate = promptTotal > 0 ? keyMap[keyName].promptHit / promptTotal : 0;
    }
    const keys = Object.values(keyMap);

    return {
      raw: data,
      models,
      keys,
      days: normalizeDailyUsage(days),
      aggregate,
    };
  }

  function normalizeDailyUsage(days) {
    return days.map((day, index) => {
      const data = asArray(firstValue(day, ["data", "models", "usage", "usages"]));
      const aggregate = data.reduce(
        (sum, item) => {
          const model = normalizeModelUsage(getModelName(item), getUsageList(item));
          return {
            request: sum.request + model.request,
            response: sum.response + model.response,
            promptMiss: sum.promptMiss + model.promptMiss,
            promptHit: sum.promptHit + model.promptHit,
            tokens: sum.tokens + model.tokens,
          };
        },
        { request: 0, response: 0, promptMiss: 0, promptHit: 0, tokens: 0 }
      );

      return {
        date: firstValue(day, ["date", "day"]) || String(index + 1),
        models: data.map((item) => normalizeModelUsage(getModelName(item), getUsageList(item))),
        ...aggregate,
      };
    });
  }

  function normalizeModelUsage(model, usage) {
    const usageMap = usageToMap(usage);
    const request = usageMap[TOKEN_TYPES.request] || 0;
    const response = usageMap[TOKEN_TYPES.response] || 0;
    const promptMiss = usageMap[TOKEN_TYPES.promptMiss] || 0;
    const promptHit = usageMap[TOKEN_TYPES.promptHit] || 0;
    const promptTotal = promptMiss + promptHit;
    const tokens = response + promptMiss + promptHit;

    return {
      model: model || "unknown",
      request,
      response,
      promptMiss,
      promptHit,
      promptTotal,
      tokens,
      cacheHitRate: promptTotal > 0 ? promptHit / promptTotal : 0,
    };
  }

  function usageToMap(usage) {
    const map = {};
    if (!Array.isArray(usage)) return map;
    for (const item of usage) {
      const type = firstValue(item, ["type", "usage_type", "usageType", "name", "key"]);
      if (!type) continue;
      map[type] = Number(firstValue(item, ["amount", "value", "count", "total"]) || 0);
    }
    return map;
  }

  function normalizeCost(raw) {
    const list = Array.isArray(raw)
      ? raw
      : asArray(firstValue(findUsageDataObject(raw) || raw || {}, ["cost", "costs", "currencies", "data"]));
    return list.map((currencyBlock) => {
      const total = asArray(firstValue(currencyBlock, ["total", "totals", "models", "model_cost", "modelCost"]));
      const days = normalizeDailyCostData(
        asArray(firstValue(currencyBlock, ["days", "daily", "daily_cost", "dailyCost"]))
      );
      const modelCosts = total.map((item) => {
        const usage = getUsageList(item);
        const usageCostMap = usageToMap(usage);
        const amount = usage.length
          ? usage.reduce((sum, usageItem) => sum + Number(firstValue(usageItem, ["amount", "value", "cost"]) || 0), 0)
          : Number(firstValue(item, ["amount", "value", "cost"]) || 0);
        return { model: getModelName(item), amount, usageCostMap };
      });
      // 按 Key 聚合费用（如果 API 返回了 Key 信息）
      const keyCostsMap = {};
      for (const item of total) {
        const keyName = getKeyName(item);
        if (!keyName) continue;
        const usage = getUsageList(item);
        const usageCostMap = usageToMap(usage);
        const itemAmount = usage.length
          ? usage.reduce((sum, usageItem) => sum + Number(firstValue(usageItem, ["amount", "value", "cost"]) || 0), 0)
          : Number(firstValue(item, ["amount", "value", "cost"]) || 0);
        if (!keyCostsMap[keyName]) {
          keyCostsMap[keyName] = { key: keyName, amount: 0, usageCostMap: {} };
        }
        keyCostsMap[keyName].amount += itemAmount;
        for (const [type, val] of Object.entries(usageCostMap)) {
          keyCostsMap[keyName].usageCostMap[type] = (keyCostsMap[keyName].usageCostMap[type] || 0) + val;
        }
      }
      const keyCosts = Object.values(keyCostsMap);
      const amount = modelCosts.reduce((sum, item) => sum + item.amount, 0);

      return {
        currency: firstValue(currencyBlock, ["currency", "currency_code", "currencyCode"]) || "",
        amount,
        modelCosts,
        keyCosts,
        days,
      };
    });
  }

  function normalizeDailyCostData(days) {
    return days.map((day) => {
      const date = firstValue(day, ["date", "day"]) || "";
      let amount = Number(firstValue(day, ["amount", "value", "cost", "total"]) || 0);

      if (!amount) {
        const models = asArray(firstValue(day, ["models", "data", "costs", "model_cost", "modelCost"]));
        amount = models.reduce((sum, model) => {
          const usage = getUsageList(model);
          if (usage.length) {
            return sum + usage.reduce((s, u) => s + Number(firstValue(u, ["amount", "value", "cost"]) || 0), 0);
          }
          return sum + Number(firstValue(model, ["amount", "value", "cost"]) || 0);
        }, 0);
      }

      return { date, amount };
    });
  }

  function findUsageDataObject(raw) {
    return findObjectWithKeys(raw, ["total", "totals", "days", "daily", "models", "model_usage", "modelUsage"]);
  }

  function findObjectWithKeys(value, keys) {
    const root = parseMaybeJson(value);
    const queue = [root];
    const seen = new Set();

    while (queue.length) {
      const current = parseMaybeJson(queue.shift());
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);

      if (!Array.isArray(current) && keys.some((key) => Object.prototype.hasOwnProperty.call(current, key))) {
        return current;
      }

      const children = Array.isArray(current) ? current : Object.values(current);
      for (const child of children) {
        if (child && (typeof child === "object" || typeof child === "string")) queue.push(child);
      }
    }

    return null;
  }

  function firstValue(object, keys) {
    if (!object || typeof object !== "object") return undefined;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(object, key)) return object[key];
    }
    return undefined;
  }

  function asArray(value) {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return Object.values(parsed);
    return [];
  }

  function getModelName(item) {
    return firstValue(item, ["model", "model_name", "modelName", "name", "id"]) || "unknown";
  }

  function getKeyName(item) {
    return firstValue(item, ["api_key", "apiKey", "key", "api_key_id", "apiKeyId"]) || null;
  }

  function getUsageList(item) {
    return asArray(firstValue(item, ["usage", "usages", "amounts", "values", "data"]));
  }

  function summarizeShape(value, depth = 0) {
    const parsed = parseMaybeJson(value);
    if (depth > 2) return "...";
    if (Array.isArray(parsed)) {
      return {
        type: "array",
        length: parsed.length,
        first: parsed.length ? summarizeShape(parsed[0], depth + 1) : null,
      };
    }
    if (!parsed || typeof parsed !== "object") return { type: typeof parsed };
    const keys = Object.keys(parsed);
    const result = { type: "object", keys: keys.slice(0, 20) };
    for (const key of keys.slice(0, 6)) result[key] = summarizeShape(parsed[key], depth + 1);
    return result;
  }

  function inspectAmountFields(raw) {
    try {
      const data = findUsageDataObject(raw) || {};
      const totals = asArray(firstValue(data, ["total", "totals", "models", "model_usage", "modelUsage"]));
      if (!totals.length) return { message: "totals 数组为空", totalItems: 0 };
      const sampleItems = totals.slice(0, 3).map((item, idx) => ({
        index: idx,
        keys: Object.keys(item),
        model: getModelName(item),
        keyField: getKeyName(item),
        hasUsage: !!getUsageList(item).length,
        usageTypes: getUsageList(item).map((u) => firstValue(u, ["type", "usage_type", "usageType", "name", "key"])),
      }));
      return {
        totalItems: totals.length,
        sampleItems,
        allKeysInFirst: Object.keys(totals[0]),
        hasKeyField: totals.some((item) => !!getKeyName(item)),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  function renderSkeleton(panel, period) {
    if (state.charts.length > 0) {
      const periodSelect = panel.querySelector(".dsapi-plus-period-select");
      const status = panel.querySelector(".dsapi-plus-status");
      if (periodSelect) periodSelect.value = period;
      if (status) status.textContent = "加载中...";
      const banner = panel.querySelector(".dsapi-plus-error-banner");
      if (banner) banner.remove();
      return;
    }

    disposeCharts();
    panel.innerHTML = `
      <div class="dsapi-plus-head">
        <div class="dsapi-plus-title">
          <strong>扩展用量</strong>
          <select class="dsapi-plus-period-select">${buildPeriodOptions(period)}</select>
        </div>
        <div class="dsapi-plus-actions">
          <span class="dsapi-plus-status">加载中...</span>
          <button type="button" class="dsapi-plus-refresh">刷新</button>
        </div>
      </div>
      <div class="dsapi-plus-message">正在读取 DeepSeek 用量接口。</div>
    `;
    bindRefresh(panel);
  }

  function errorBannerHTML(message, isAuth) {
    return `
      <div class="dsapi-plus-message dsapi-plus-error dsapi-plus-error-banner">
        ${
          isAuth
            ? "当前脚本没有读到 DeepSeek 登录 token，或 token 已失效。请确认脚本运行在 https://platform.deepseek.com/usage 页面并已登录。"
            : "接口读取失败。"
        }
        <br>${escapeHtml(message)}
      </div>
    `;
  }

  function renderError(panel, period, error) {
    const message = String(error?.message || error || "未知错误");
    const isAuth = /\b(401|403|40002)\b|missing token/i.test(message);
    panel.__dsapiPlusDebug = {
      auth: { tokenFound: state.tokenSource !== "none", tokenSource: state.tokenSource },
      error: message,
    };

    if (state.charts.length > 0) {
      const periodSelect = panel.querySelector(".dsapi-plus-period-select");
      const status = panel.querySelector(".dsapi-plus-status");
      if (periodSelect) periodSelect.value = period;
      if (status) status.textContent = "加载失败";
      const existing = panel.querySelector(".dsapi-plus-error-banner");
      if (existing) existing.remove();
      const body = panel.querySelector(".dsapi-plus-body");
      if (body) {
        body.insertAdjacentHTML("afterbegin", errorBannerHTML(message, isAuth));
      }
      return;
    }

    disposeCharts();
    panel.innerHTML = `
      <div class="dsapi-plus-head">
        <div class="dsapi-plus-title">
          <strong>扩展用量</strong>
          <select class="dsapi-plus-period-select">${buildPeriodOptions(period)}</select>
        </div>
        <div class="dsapi-plus-actions">
          <span class="dsapi-plus-status">加载失败</span>
          <button type="button" class="dsapi-plus-refresh">重试</button>
        </div>
      </div>
      ${errorBannerHTML(message, isAuth)}
    `;
    bindRefresh(panel);
  }

  function buildPeriodOptions(selectedPeriod) {
    const now = new Date();
    const currentMonth = now.getUTCMonth() + 1;
    const currentYear = now.getUTCFullYear();
    let html = "";
    for (let i = 0; i < 12; i++) {
      let m = currentMonth - i;
      let y = currentYear;
      if (m <= 0) { m += 12; y -= 1; }
      const val = `${y}-${m}`;
      const label = `${y}年${m}月${i === 0 ? " (当前)" : ""}`;
      html += `<option value="${val}"${val === selectedPeriod ? " selected" : ""}>${label}</option>`;
    }
    return html;
  }

  function buildPanelData(data) {
    const { period, summary, amount, cost } = data;

    const monthlyCostText = summary.monthlyCosts.length
      ? summary.monthlyCosts.map(formatMoney).join(" + ")
      : "0";
    const monthCostText = cost.length ? cost.map(formatMoney).join(" + ") : "0";
    const sortedModels = amount.models.slice().sort((a, b) => b.tokens - a.tokens || b.request - a.request);
    const sortedKeys = amount.keys.length
      ? amount.keys.slice().sort((a, b) => b.tokens - a.tokens || b.request - a.request)
      : [];
    const tokenTotal = amount.aggregate.tokens;
    const monthCnyCost = sumCurrencyAmount(cost, "CNY", "amount");
    const monthlyCnyCost = sumCurrencyAmount(summary.monthlyCosts, "CNY", "amount");
    const cnyCostBreakdown = getCostBreakdown(cost, "CNY");
    const walletCnyBalance =
      sumCurrencyAmount(summary.normalWallets, "CNY", "balance") +
      sumCurrencyAmount(summary.bonusWallets, "CNY", "balance");
    const averageCostPerMillion = computeAverageCostPerMillion({
      preferredCost: monthCnyCost,
      preferredTokens: tokenTotal,
      fallbackCost: monthlyCnyCost,
      fallbackTokens: Number(summary.monthlyUsage || 0),
    });
    // 区分数据来源：选中月 vs 本月（备选）
    const isUsingPreferred = monthCnyCost > 0 && tokenTotal > 0;
    const _now = new Date();
    const nowPeriod = `${_now.getUTCFullYear()}-${_now.getUTCMonth() + 1}`;
    const averageCostLabel = isUsingPreferred
      ? (period === nowPeriod ? "本月平均消费" : "选中月平均消费")
      : "本月平均消费（备选）";
    const isCurrentPeriod = period === nowPeriod;
    const averageInputCostPerMillion = computeAverageCostPerMillion({
      preferredCost: cnyCostBreakdown.input,
      preferredTokens: amount.aggregate.promptMiss + amount.aggregate.promptHit,
      fallbackCost: monthCnyCost || monthlyCnyCost,
      fallbackTokens: tokenTotal || Number(summary.monthlyUsage || 0),
    });
    const averageOutputCostPerMillion = computeAverageCostPerMillion({
      preferredCost: cnyCostBreakdown.output,
      preferredTokens: amount.aggregate.response,
      fallbackCost: monthCnyCost || monthlyCnyCost,
      fallbackTokens: tokenTotal || Number(summary.monthlyUsage || 0),
    });
    const estimatedAvailableTokens = averageCostPerMillion > 0
      ? Math.floor(walletCnyBalance / averageCostPerMillion * 1000000)
      : 0;
    const averageCostDetail = `输入 ${formatCnyAmount(averageInputCostPerMillion)} /1M · 输出 ${formatCnyAmount(averageOutputCostPerMillion)} /1M`;

    const daysArr = amount.days;
    const now = new Date();
    const todayDay = now.getUTCDate();
    let today = null;
    for (const day of daysArr) {
      const match = String(day.date || "").match(/(\d{1,2})$/);
      if (match && Number(match[1]) === todayDay) {
        today = day;
        break;
      }
    }
    if (!today) {
      for (let i = daysArr.length - 1; i >= 0; i--) {
        if (daysArr[i].tokens > 0 || daysArr[i].request > 0) {
          today = daysArr[i];
          break;
        }
      }
      if (!today) today = daysArr.length ? daysArr[daysArr.length - 1] : null;
    }
    // 从 cost API 每日数据中获取今天的实际消费金额
    let todayActualCost = 0;
    for (const costBlock of cost) {
      if (costBlock.currency !== "CNY") continue;
      for (const dayCost of (costBlock.days || [])) {
        const match = String(dayCost.date || "").match(/(\d{1,2})$/);
        if (match && Number(match[1]) === todayDay) {
          todayActualCost += (dayCost.amount || 0);
        }
      }
    }

    const todayInputTokens = today ? (today.promptMiss || 0) + (today.promptHit || 0) : 0;
    const todayOutputTokens = today ? (today.response || 0) : 0;
    // 先用均价估算作为基准
    const todayInputCostEstimated = averageInputCostPerMillion > 0 ? averageInputCostPerMillion * todayInputTokens / 1000000 : 0;
    const todayOutputCostEstimated = averageOutputCostPerMillion > 0 ? averageOutputCostPerMillion * todayOutputTokens / 1000000 : 0;
    const todayTotalCostEstimated = todayInputCostEstimated + todayOutputCostEstimated;

    // 优先使用 cost API 的实际每日数据，估算值作为 fallback
    let todayTotalCost, todayInputCost, todayOutputCost;
    if (todayActualCost > 0) {
      todayTotalCost = todayActualCost;
      // 按实际总额等比缩放输入/输出估算值以保持细分一致
      if (todayTotalCostEstimated > 0) {
        const scale = todayActualCost / todayTotalCostEstimated;
        todayInputCost = todayInputCostEstimated * scale;
        todayOutputCost = todayOutputCostEstimated * scale;
      } else {
        todayInputCost = 0;
        todayOutputCost = 0;
      }
    } else {
      todayTotalCost = todayTotalCostEstimated;
      todayInputCost = todayInputCostEstimated;
      todayOutputCost = todayOutputCostEstimated;
    }

    const todayCostText = formatCnyAmount(todayTotalCost);
    const todayCostDetail = `输入 ${formatCnyAmount(todayInputCost)} · 输出 ${formatCnyAmount(todayOutputCost)}`;
    const costDetail = `输入 ${formatCnyAmount(cnyCostBreakdown.input)} · 输出 ${formatCnyAmount(cnyCostBreakdown.output)}`;
    const usageInput = amount.aggregate.promptMiss + amount.aggregate.promptHit;
    const usageDetail = `输入 ${formatInteger(usageInput)} tokens · 输出 ${formatInteger(amount.aggregate.response)} tokens`;

    const updateTime = new Date().toLocaleTimeString("zh-CN");

    // 条形图高度：每横条 = 表格行高 36px + grid上下边距 40px
    const keyChartHeight = sortedKeys.length ? Math.max(100, sortedKeys.length * 36 + 40) : 160;

    const html = `
      <div class="dsapi-plus-head">
        <div class="dsapi-plus-title">
          <strong>扩展用量</strong>
          <select class="dsapi-plus-period-select">${buildPeriodOptions(period)}</select>
          <span class="dsapi-plus-status">已更新 ${escapeHtml(updateTime)}</span>
        </div>
        <div class="dsapi-plus-actions">
          <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.requests ? ' active' : ''}" data-section="requests">请求</button>
          <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.tokens ? ' active' : ''}" data-section="tokens">Tokens</button>
          <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.cacheRate ? ' active' : ''}" data-section="cacheRate">缓存</button>
          <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.composition ? ' active' : ''}" data-section="composition">Token构成</button>
          <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.models ? ' active' : ''}" data-section="models">模型</button>
          <button type="button" class="dsapi-plus-auto-refresh-btn" style="margin-left:4px;">自动刷新 ${getAutoRefreshLabel(state.autoRefreshInterval)}</button>
          <button type="button" class="dsapi-plus-toggle-native-btn${state.nativeContentVisible ? ' active' : ''}" style="margin-left:4px;">${state.nativeContentVisible ? '隐藏原生内容' : '显示原生内容'}</button>
          <button type="button" class="dsapi-plus-refresh">刷新</button>
        </div>
      </div>

      <div class="dsapi-plus-body">
        <div class="dsapi-plus-summary">
          ${summaryItem("当日费用", isCurrentPeriod ? todayCostText : "--", "", isCurrentPeriod ? todayCostDetail : "")}
          ${summaryItem("当月费用", monthCostText, "", costDetail)}
          ${summaryItem("当月平均费用", formatCnyAmount(averageCostPerMillion), "/1M", averageCostDetail)}
          ${summaryItem("当月用量", formatInteger(summary.monthlyUsage), "Tokens", usageDetail)}
          ${isCurrentPeriod ? summaryItem("预估可用", estimatedAvailableTokens ? formatInteger(estimatedAvailableTokens) : "无法估算", estimatedAvailableTokens ? "Tokens" : "") : ""}
        </div>

        <div class="dsapi-plus-chart-grid">
          <div class="dsapi-plus-chart-block" style="display:${state.sectionVisible.requests ? '' : 'none'};">
            ${chartHeading("API 请求次数汇总", formatInteger(amount.aggregate.request))}
            <div class="dsapi-plus-chart-frame">
              <div class="dsapi-plus-chart" data-dsapi-chart="requests"></div>
            </div>
          </div>

          <div class="dsapi-plus-chart-block" style="display:${state.sectionVisible.tokens ? '' : 'none'};">
            ${chartHeading("Tokens 汇总", formatInteger(tokenTotal))}
            <div class="dsapi-plus-chart-frame">
              <div class="dsapi-plus-chart" data-dsapi-chart="tokens"></div>
            </div>
          </div>

          <div class="dsapi-plus-chart-block" style="display:${state.sectionVisible.cacheRate ? '' : 'none'};">
            ${chartHeading("缓存命中率", formatPercent(cacheHitRate(amount.aggregate)))}
            <div class="dsapi-plus-chart-frame">
              <div class="dsapi-plus-chart" data-dsapi-chart="cacheRate"></div>
            </div>
          </div>

          <div class="dsapi-plus-chart-block" style="display:${state.sectionVisible.composition ? '' : 'none'};">
            ${chartHeading("Token 构成", `缓存命中 ${formatPercent(cacheHitRate(amount.aggregate))}`)}
            <div class="dsapi-plus-chart-frame">
              <div class="dsapi-plus-chart" data-dsapi-chart="composition"></div>
            </div>
          </div>
        </div>

        <div class="dsapi-plus-section" style="display:${state.sectionVisible.models ? '' : 'none'};">
          <div class="dsapi-plus-section-head">
            <div class="dsapi-plus-section-title">模型明细</div>
          </div>
          <div class="dsapi-plus-detail-layout">
            <div>
              ${
                sortedModels.length
                  ? renderModelTable(sortedModels, cost)
                  : '<div class="dsapi-plus-message">当前月份暂无请求或 Token 用量。</div>'
              }
            </div>
            <div class="dsapi-plus-model-donut">
              ${chartHeading("模型分布", sortedModels.length ? `${sortedModels.length} 个活跃模型` : "暂无模型用量")}
              <div class="dsapi-plus-chart-frame">
                ${sortedModels.length ? '<div class="dsapi-plus-chart" data-dsapi-chart="models"></div>' : '<div class="dsapi-plus-message">当前月份暂无模型用量。</div>'}
              </div>
            </div>
          </div>
        </div>

        <div class="dsapi-plus-section">
          <div class="dsapi-plus-section-head">
            <div class="dsapi-plus-section-title">Key 明细</div>
            <span class="dsapi-plus-section-meta">${sortedKeys.length ? `${sortedKeys.length} 个活跃 Key` : "暂无 Key 用量"}</span>
            <span class="dsapi-plus-status" style="font-size:11px;">已更新 ${state.keyDetailUpdateTime || "--"}</span>
            <div style="display:flex;gap:8px;margin-left:auto;">
              <button type="button" class="dsapi-plus-group-model-btn${state.groupByModel ? ' active' : ''}">${state.groupByModel ? '按Key统计' : '按模型统计'}</button>
              <div class="dsapi-plus-key-filter-wrap" style="position:relative;">
                <button type="button" class="dsapi-plus-key-filter-btn">筛选${state.keyFilter && state.keyFilter.mode === 'selected' && state.keyFilter.keys?.length ? ` (${state.keyFilter.keys.length})` : ''}</button>
                <div class="dsapi-plus-key-filter-dropdown" style="display:none;position:absolute;top:100%;right:0;z-index:1000;background:var(--dsapi-plus-bg,#fff);border:1px solid var(--dsapi-plus-muted);border-radius:6px;padding:6px;min-width:160px;max-height:260px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.12);">
                  <div style="display:flex;gap:4px;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid var(--dsapi-plus-muted);">
                    <button type="button" class="dsapi-plus-filter-all-btn" style="flex:1;border:0;border-radius:4px;background:rgba(2,14,54,0.05);cursor:pointer;font:inherit;font-size:11px;padding:3px 6px;">全选</button>
                    <button type="button" class="dsapi-plus-filter-none-btn" style="flex:1;border:0;border-radius:4px;background:rgba(2,14,54,0.05);cursor:pointer;font:inherit;font-size:11px;padding:3px 6px;">全取消</button>
                  </div>
                  <div class="dsapi-plus-filter-list"></div>
                </div>
              </div>
              <button type="button" class="dsapi-plus-toggle-key-btn${state.keyTableVisible ? ' active' : ''}">${state.keyTableVisible ? '隐藏表格详情' : '显示表格详情'}</button>
              <button type="button" class="dsapi-plus-daily-btn${state.keyDetailDailyVisible ? ' active' : ''}">${state.keyDetailDailyVisible ? '隐藏每日详情' : '显示每日详情'}</button>
            </div>
          </div>
          ${sortedKeys.length ? renderKeyTable(sortedKeys, cost, state.keyTableVisible) : '<div class="dsapi-plus-message">当前月份暂无 Key 级别用量数据，或 API 未返回 Key 信息。</div>'}
          <div class="dsapi-plus-key-chart" style="margin-top:8px;">
            ${chartHeading("Key 费用分布", "")}
            <div class="dsapi-plus-chart-frame" style="height:${keyChartHeight}px;">
              ${sortedKeys.length ? `<div class="dsapi-plus-chart" style="height:${keyChartHeight}px;" data-dsapi-chart="keyCost"></div>` : '<div class="dsapi-plus-message">暂无 Key 费用数据。</div>'}
            </div>
          </div>
          <div class="dsapi-plus-daily-chart" style="display:${state.keyDetailDailyVisible ? '' : 'none'};margin-top:8px;width:100%;">
            ${chartHeading("每日费用明细", "")}
            <div class="dsapi-plus-chart-frame" style="height:200px;">
              <div class="dsapi-plus-chart" style="width:100%;height:200px;" data-dsapi-chart="keyDaily"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    return {
      period,
      summary,
      amount,
      cost,
      monthlyCostText,
      monthCostText,
      todayCostText,
      todayCostDetail,
      costDetail,
      usageDetail,
      sortedModels,
      sortedKeys,
      tokenTotal,
      isCurrentPeriod,
      averageCostLabel,
      averageCostPerMillion,
      averageCostDetail,
      estimatedAvailableTokens,
      updateTime,
      html,
    };
  }

  function renderPanel(panel, data) {
    const panelData = buildPanelData(data);
    panel.__dsapiPlusDebug = data.debug;
    state.lastPanelData = panelData;
    const expectedChartCount = panelData.sortedModels.length ? 6 : 5;

    if (state.charts.length > 0 && state.charts.length === expectedChartCount) {
      updatePanelIncremental(panel, panelData);
      updateChartsData(panelData);
      return;
    }

    disposeCharts();
    panel.innerHTML = panelData.html;
    bindRefresh(panel);
    initCharts(panel, panelData);
    // 恢复记忆的 Key 明细数据
    restoreKeyDetailData(panel);
    // 全量重渲染后恢复原生内容显示状态
    toggleNativeContent(state.nativeContentVisible);
  }

  function restoreKeyDetailData(panel) {
    const saved = loadKeyDetailData();
    if (!saved || !saved.data || !saved.data.length) return;
    // 兼容旧数据：补充 byModel 中缺失的费用、model 名称等
    for (const item of saved.data) {
      if (item.byModel) {
        for (const [name, m] of Object.entries(item.byModel)) {
          if (m.model === undefined) m.model = name;
          if (m.requestCount === undefined) m.requestCount = 0;
          if (m.missCost === undefined || m.hitCost === undefined || m.outCost === undefined) {
            // 按 token 比例分摊总费用到各模型（旧数据无明细费用时使用）
            const totalMiss = item.inputMissTokens || 1;
            const totalHit = item.inputHitTokens || 1;
            const totalOut = item.outputTokens || 1;
            m.missCost = (item.inputMissCost || 0) * (m.missTokens || 0) / totalMiss;
            m.hitCost = (item.inputHitCost || 0) * (m.hitTokens || 0) / totalHit;
            m.outCost = (item.outputCost || 0) * (m.outTokens || 0) / totalOut;
          }
        }
      }
    }
    // 全量重渲染后，用记忆数据覆盖面板中的 Key 明细内容
    state.keyDetailData = saved.data;
    state.keyDetailDailyData = saved.dailyData || null;
    state.keyUnitPrices = saved.unitPrices || {};
    state.keyDetailUpdateTime = saved.updateTime || "";
    updateKeyDetailUI();
    initOrUpdateKeyCostChart(panel.querySelector(".dsapi-plus-section:last-child"));
  }

  function formatWallet(item) {
    const tokenEstimation = item && item.token_estimation != null
      ? `，约 ${formatInteger(item.token_estimation)} Tokens`
      : "";
    return `${formatMoney(item)}${tokenEstimation}`;
  }

  function summaryItem(label, value, unit = "", detail = "") {
    return `
      <div class="dsapi-plus-summary-item">
        <div class="dsapi-plus-summary-label">${escapeHtml(label)}</div>
        <div class="dsapi-plus-summary-value">${escapeHtml(value)}${unit ? `<span class="dsapi-plus-summary-unit">${escapeHtml(unit)}</span>` : ""}</div>
        ${detail ? `<div class="dsapi-plus-summary-detail">${escapeHtml(detail)}</div>` : ""}
      </div>
    `;
  }

  function sumCurrencyAmount(items, currency, amountKey) {
    return asArray(items)
      .filter((item) => item && item.currency === currency)
      .reduce((sum, item) => sum + Number(item[amountKey] || 0), 0);
  }

  function computeAverageCostPerMillion(input) {
    const preferredCost = Number(input.preferredCost || 0);
    const preferredTokens = Number(input.preferredTokens || 0);
    if (preferredCost > 0 && preferredTokens > 0) return preferredCost / preferredTokens * 1000000;

    const fallbackCost = Number(input.fallbackCost || 0);
    const fallbackTokens = Number(input.fallbackTokens || 0);
    if (fallbackCost > 0 && fallbackTokens > 0) return fallbackCost / fallbackTokens * 1000000;

    return 0;
  }

  function getCostBreakdown(costBlocks, currency) {
    const outputTypes = new Set([TOKEN_TYPES.response]);
    const inputTypes = new Set([TOKEN_TYPES.promptMiss, TOKEN_TYPES.promptHit]);
    const result = { input: 0, output: 0 };

    for (const block of costBlocks) {
      if (!block || block.currency !== currency) continue;
      for (const modelCost of block.modelCosts || []) {
        for (const [type, amount] of Object.entries(modelCost.usageCostMap || {})) {
          if (outputTypes.has(type)) result.output += Number(amount || 0);
          if (inputTypes.has(type)) result.input += Number(amount || 0);
        }
      }
    }

    return result;
  }

  function chartHeading(title, value) {
    return `
      <div class="dsapi-plus-chart-heading">
        <span class="dsapi-plus-chart-heading-title">${escapeHtml(title)}</span>
        ${value ? `<span class="dsapi-plus-chart-heading-value">${escapeHtml(value)}</span>` : ""}
      </div>
    `;
  }

  function cacheHitRate(aggregate) {
    const promptTotal = aggregate.promptMiss + aggregate.promptHit;
    return promptTotal > 0 ? aggregate.promptHit / promptTotal : 0;
  }

  function renderModelTable(models, costBlocks) {
    const rows = models
      .map((model) => {
        const costText = costForModel(costBlocks, model.model);
        return `
          <tr>
            <td title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</td>
            <td>${formatInteger(model.request)}</td>
            <td>${formatInteger(model.tokens)}</td>
            <td>${formatInteger(model.response)}</td>
            <td>${formatInteger(model.promptMiss)}</td>
            <td>${formatInteger(model.promptHit)}</td>
            <td>${formatPercent(model.cacheHitRate)}</td>
            <td>${escapeHtml(costText)}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="dsapi-plus-table-wrap">
        <table class="dsapi-plus-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求数</th>
              <th>Tokens</th>
              <th>输出</th>
              <th>输入未缓存</th>
              <th>输入缓存命中</th>
              <th>缓存命中占比</th>
              <th>费用</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function compactNumber(value) {
    const number = Number(value || 0);
    if (number >= 100000000) return `${formatDecimal(number / 100000000, 1)}亿`;
    if (number >= 10000) return `${formatDecimal(number / 10000, 1)}万`;
    return formatInteger(number);
  }

  function shortDateLabel(value) {
    const matched = String(value || "").match(/(\d{1,2})$/);
    return matched ? `${matched[1]}日` : String(value || "");
  }

  function getChartTextColor() {
    return document.body.classList.contains("dark") ? "rgba(150, 150, 150, 1)" : "rgba(2, 14, 54, 0.6)";
  }

  function getChartGridColor() {
    return document.body.classList.contains("dark") ? "rgba(60, 60, 60, 1)" : "#D2D8E5";
  }

  function getTooltipCss() {
    return [
      "padding: 12px",
      "background-color: rgb(var(--ds-rgb-elevated, 255 255 255))",
      "border-radius: 10px",
      "box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)",
      "border: none",
    ].join(";") + ";";
  }

  function getTooltipPosition(point, params, dom, rect, size) {
    const gap = 12;
    const width = dom?.offsetWidth || 180;
    const height = dom?.offsetHeight || 90;
    const viewWidth = size?.viewSize?.[0] || window.innerWidth;
    const viewHeight = size?.viewSize?.[1] || window.innerHeight;
    let x = point[0] + gap;
    let y = point[1] + gap;
    if (x + width > viewWidth) x = point[0] - width - gap;
    if (y + height > viewHeight) y = point[1] - height - gap;
    return [Math.max(0, x), Math.max(0, y)];
  }

  function tooltipInteractionOption() {
    return {
      triggerOn: "mousemove|click",
      showDelay: 0,
      enterable: false,
      hideDelay: 0,
      renderMode: "html",
      appendToBody: true,
      position: getTooltipPosition,
    };
  }

  function chartBaseOption() {
    const textColor = getChartTextColor();
    const gridColor = getChartGridColor();
    return {
      animation: false,
      grid: { left: 44, right: 12, top: 8, bottom: 24 },
      tooltip: {
        confine: true,
        trigger: "axis",
        ...tooltipInteractionOption(),
        extraCssText: getTooltipCss(),
        axisPointer: { lineStyle: { color: gridColor } },
      },
      xAxis: {
        type: "category",
        axisTick: { show: false },
        axisLabel: { color: textColor, interval: "auto", formatter: shortDateLabel },
        axisLine: { lineStyle: { color: gridColor } },
      },
      yAxis: {
        type: "value",
        splitNumber: 1,
        splitLine: { lineStyle: { color: gridColor } },
        axisLabel: { color: textColor, align: "left", margin: 34, formatter: compactNumber },
      },
    };
  }

  function getEcharts() {
    return Promise.resolve(window.echarts);
  }

  function disposeCharts() {
    stopTooltipKeeper();
    if (state.chartResizeObserver) {
      state.chartResizeObserver.disconnect();
      state.chartResizeObserver = null;
    }
    for (const { instance } of state.charts) instance.dispose();
    state.charts = [];
  }

  function startTooltipKeeper(instance, event) {
    if (!instance || instance.isDisposed()) return;
    if (state.tooltipKeeperChart !== instance && state.tooltipKeeperTimer) {
      window.clearInterval(state.tooltipKeeperTimer);
      state.tooltipKeeperTimer = 0;
    }
    for (const entry of state.charts) {
      const chart = entry.instance;
      if (chart !== instance && !chart.isDisposed()) {
        chart.dispatchAction({ type: "hideTip" });
      }
    }

    state.tooltipActive = true;
    state.tooltipKeeperChart = instance;
    state.tooltipKeeperPoint = [event.offsetX, event.offsetY];

    instance.dispatchAction({
      type: "showTip",
      x: state.tooltipKeeperPoint[0],
      y: state.tooltipKeeperPoint[1],
    });

    if (state.tooltipKeeperTimer) return;
    state.tooltipKeeperTimer = window.setInterval(() => {
      const chart = state.tooltipKeeperChart;
      const point = state.tooltipKeeperPoint;
      if (!state.tooltipActive || !chart || chart.isDisposed() || !point) {
        stopTooltipKeeper();
        return;
      }
      chart.dispatchAction({ type: "showTip", x: point[0], y: point[1] });
    }, 250);
  }

  function stopTooltipKeeper(instance) {
    if (instance && state.tooltipKeeperChart !== instance) {
      if (!instance.isDisposed()) instance.dispatchAction({ type: "hideTip" });
      return false;
    }

    if (state.tooltipKeeperTimer) {
      window.clearInterval(state.tooltipKeeperTimer);
      state.tooltipKeeperTimer = 0;
    }
    const chart = state.tooltipKeeperChart;
    if (chart && !chart.isDisposed()) {
      chart.dispatchAction({ type: "hideTip" });
    }
    state.tooltipKeeperChart = null;
    state.tooltipKeeperPoint = null;
    state.tooltipActive = false;
    return true;
  }

  function buildChartOption(key, panelData) {
    const { amount, sortedModels } = panelData;
    switch (key) {
      case "requests": return buildRequestChartOption(amount.days);
      case "tokens": return buildTokensChartOption(amount.days);
      case "cacheRate": return buildCacheRateChartOption(amount.days);
      case "composition": return buildCompositionChartOption(amount.aggregate);
      case "models": return buildModelsChartOption(sortedModels.slice(0, 8));
      case "keyCost": return buildKeyCostChartOption();
      case "keyDaily": return buildKeyDailyChartOption();
      default: return null;
    }
  }

  function updateChartTheme() {
    if (!state.lastPanelData) return;
    if (state.tooltipActive) {
      state.pendingThemeUpdate = true;
      return;
    }
    for (const entry of state.charts) {
      if (entry.instance.isDisposed()) continue;
      const option = buildChartOption(entry.key, state.lastPanelData);
      if (option) entry.instance.setOption(option, { notMerge: true });
    }
  }

  function flushPendingChartUpdates() {
    if (state.tooltipActive) return;

    if (state.pendingThemeUpdate && state.lastPanelData) {
      state.pendingThemeUpdate = false;
      updateChartTheme();
    }

    if (state.pendingPanelData) {
      const pending = state.pendingPanelData;
      state.pendingPanelData = null;
      updateChartsData(pending);
    }
  }

  function startThemeObserver() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          updateChartTheme();
          break;
        }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  function updatePanelIncremental(panel, panelData) {
    const { period, amount, summary, cost, monthlyCostText, monthCostText, todayCostText, todayCostDetail, costDetail, usageDetail, sortedModels, sortedKeys, tokenTotal, isCurrentPeriod, averageCostLabel, averageCostPerMillion, averageCostDetail, estimatedAvailableTokens, updateTime } = panelData;

    const periodSelect = panel.querySelector(".dsapi-plus-period-select");
    const status = panel.querySelector(".dsapi-plus-status");
    if (periodSelect) periodSelect.value = period;
    if (status) status.textContent = `已更新 ${escapeHtml(updateTime)}`;

    const summaryEl = panel.querySelector(".dsapi-plus-summary");
    if (summaryEl) {
      summaryEl.innerHTML =
        summaryItem("当日费用", isCurrentPeriod ? todayCostText : "--", "", isCurrentPeriod ? todayCostDetail : "") +
        summaryItem("当月费用", monthCostText, "", costDetail) +
        summaryItem("当月平均费用", formatCnyAmount(averageCostPerMillion), "/1M", averageCostDetail) +
        summaryItem("当月用量", formatInteger(summary.monthlyUsage), "Tokens", usageDetail) +
        (isCurrentPeriod ? summaryItem("预估可用", estimatedAvailableTokens ? formatInteger(estimatedAvailableTokens) : "无法估算", estimatedAvailableTokens ? "Tokens" : "") : "");
    }

    const headingValues = panel.querySelectorAll(".dsapi-plus-chart-heading-value");
    const headingTexts = [
      formatInteger(amount.aggregate.request),
      formatInteger(tokenTotal),
      formatPercent(cacheHitRate(amount.aggregate)),
      `缓存命中 ${formatPercent(cacheHitRate(amount.aggregate))}`,
      sortedModels.length ? `${sortedModels.length} 个活跃模型` : "暂无模型用量",
      state.keyDetailData?.length ? `${state.keyDetailData.length} 个活跃 Key` : (sortedKeys.length ? `${sortedKeys.length} 个活跃 Key` : "暂无 Key 用量"),
    ];
    headingValues.forEach((el, i) => {
      if (headingTexts[i] != null) el.textContent = headingTexts[i];
    });

    const detailLayout = panel.querySelector(".dsapi-plus-detail-layout");
    if (detailLayout && detailLayout.children[0]) {
      detailLayout.children[0].innerHTML = sortedModels.length
        ? renderModelTable(sortedModels, cost)
        : '<div class="dsapi-plus-message">当前月份暂无请求或 Token 用量。</div>';
    }

    const donut = panel.querySelector(".dsapi-plus-model-donut");
    if (donut) {
      const frame = donut.querySelector(".dsapi-plus-chart-frame");
      if (frame) {
        const hasChart = !!frame.querySelector('[data-dsapi-chart="models"]');
        if (sortedModels.length && !hasChart) {
          frame.innerHTML = '<div class="dsapi-plus-chart" data-dsapi-chart="models"></div>';
        } else if (!sortedModels.length && hasChart) {
          frame.innerHTML = '<div class="dsapi-plus-message">当前月份暂无模型用量。</div>';
        }
      }
    }

    // 更新 Key 明细（仅当未通过导入按钮获取数据时）
    const keySection = panel.querySelector(".dsapi-plus-section:last-child");
    if (keySection) {
      const meta = keySection.querySelector(".dsapi-plus-section-meta");
      // 如果已有导入的 Key 数据，不覆盖内容，只更新 meta
      if (state.keyDetailData && state.keyDetailData.length) {
        if (meta) meta.textContent = `${state.keyDetailData.length} 个活跃 Key`;
      } else if (state.keyDetailLoading) {
        if (meta) meta.textContent = "正在获取 Key 明细…";
      } else if (state.keyDetailError) {
        if (meta) meta.textContent = "导入失败";
      } else {
        if (meta) meta.textContent = sortedKeys.length ? `${sortedKeys.length} 个活跃 Key` : "暂无 Key 用量";
        const tableWrap = keySection.querySelector(".dsapi-plus-table-wrap");
        if (tableWrap) {
          if (sortedKeys.length) {
            tableWrap.outerHTML = renderKeyTable(sortedKeys, cost, state.keyTableVisible);
          } else {
            const msg = keySection.querySelector(".dsapi-plus-message");
            if (!msg) {
              if (tableWrap) tableWrap.remove();
              keySection.insertAdjacentHTML("beforeend", '<div class="dsapi-plus-message">当前月份暂无 Key 级别用量数据，或 API 未返回 Key 信息。</div>');
            }
          }
        } else {
          const msg = keySection.querySelector(".dsapi-plus-message");
          if (sortedKeys.length) {
            if (msg) msg.remove();
            keySection.insertAdjacentHTML("beforeend", renderKeyTable(sortedKeys, cost, state.keyTableVisible));
          }
        }
      }
    }
  }

  function updateChartsData(panelData) {
    if (state.tooltipActive) {
      state.pendingPanelData = panelData;
      return;
    }
    const remaining = [];
    for (const entry of state.charts) {
      const option = buildChartOption(entry.key, panelData);
      if (!option || entry.instance.isDisposed()) {
        entry.instance.dispose();
        continue;
      }
      entry.instance.setOption(option, { notMerge: true });
      remaining.push(entry);
    }
    state.charts = remaining;
  }

  function initCharts(panel, panelData) {
    getEcharts()
      .then((echarts) => {
        if (!panel.isConnected) return;

        const keys = ["requests", "tokens", "cacheRate", "composition", "models", "keyCost", "keyDaily"];
        for (const key of keys) {
          const container = panel.querySelector(`[data-dsapi-chart="${key}"]`);
          const option = buildChartOption(key, panelData);
          if (!container || !option) continue;
          const instance = echarts.init(container, null, { renderer: "svg" });
          const zr = instance.getZr();
          zr.on("mousemove", (event) => {
            startTooltipKeeper(instance, event);
          });
          zr.on("globalout", () => {
            if (stopTooltipKeeper(instance)) {
              flushPendingChartUpdates();
            }
          });
          instance.setOption(option);
          state.charts.push({ key, instance });
        }

        state.chartResizeObserver = new ResizeObserver(() => {
          for (const { instance } of state.charts) instance.resize();
        });
        state.chartResizeObserver.observe(panel);
      })
      .catch((error) => {
        console.error("[DeepSeek Usage Panel Plus] ECharts init failed", error);
      });
  }

  function buildRequestChartOption(days) {
    const option = chartBaseOption();
    const x = days.map((day) => day.date);
    option.xAxis.data = x;
    option.tooltip.formatter = (params) => {
      const item = params[0];
      const day = days[item.dataIndex] || {};
      const modelRows = (day.models || [])
        .filter((model) => model.request > 0)
        .sort((a, b) => b.request - a.request)
        .map((model, index) => ({
          color: chartPalette(index),
          label: model.model,
          value: formatInteger(model.request),
        }));
      return tooltipHtml(item.axisValue, modelRows.length ? modelRows : [
        { color: "#0C70F3", label: "API 请求次数汇总", value: formatInteger(item.value) },
      ]);
    };
    option.series = [
      {
        data: days.map((day) => day.request),
        type: "line",
        smooth: true,
        showSymbol: false,
        itemStyle: { color: "#0C70F3" },
        lineStyle: { color: "#0C70F3", width: 1.5 },
        areaStyle: { color: "rgba(112, 178, 254, 0.7)" },
        emphasis: { disabled: true },
      },
    ];
    return option;
  }

  function buildCacheRateChartOption(days) {
    const option = chartBaseOption();
    option.xAxis.data = days.map((day) => day.date);
    option.yAxis.axisLabel.formatter = (value) => `${formatDecimal(value * 100, 0)}%`;
    option.yAxis.max = 1;
    option.tooltip.formatter = (params) => {
      const item = params[0];
      const day = days[item.dataIndex] || {};
      return tooltipHtml(item.axisValue, [
        { color: "#0C70F3", label: "缓存命中率", value: formatPercent(item.value) },
        { color: "#60B3FE", label: "缓存命中 Tokens", value: formatInteger(day.promptHit || 0) },
        { color: "#A0DCFD", label: "输入 Tokens", value: formatInteger((day.promptHit || 0) + (day.promptMiss || 0)) },
      ]);
    };
    option.series = [
      {
        data: days.map((day) => {
          const total = day.promptHit + day.promptMiss;
          return total > 0 ? day.promptHit / total : 0;
        }),
        type: "line",
        smooth: true,
        showSymbol: false,
        itemStyle: { color: "#0C70F3" },
        lineStyle: { color: "#0C70F3", width: 1.5 },
        areaStyle: { color: "rgba(112, 178, 254, 0.7)" },
        emphasis: { disabled: true },
      },
    ];
    return option;
  }

  function buildTokensChartOption(days) {
    const option = chartBaseOption();
    option.xAxis.data = days.map((day) => day.date);
    option.tooltip.formatter = (params) => {
      const rows = params
        .slice()
        .reverse()
        .map((item) => ({ color: item.color, label: item.seriesName, value: `${formatInteger(item.value)} tokens` }));
      return tooltipHtml(params[0]?.axisValue || "", rows);
    };
    option.series = [
      tokenBarSeries("输出 Tokens", days.map((day) => day.response), "#0C70F3"),
      tokenBarSeries("输入未缓存", days.map((day) => day.promptMiss), "#60B3FE"),
      tokenBarSeries("输入缓存命中", days.map((day) => day.promptHit), "#A0DCFD"),
    ];
    return option;
  }

  function tokenBarSeries(name, data, color) {
    return {
      name,
      data,
      type: "bar",
      stack: "tokens",
      barMaxWidth: 12,
      itemStyle: { color },
      emphasis: { disabled: true },
    };
  }

  function buildCompositionChartOption(aggregate) {
    return buildHorizontalBarOption([
      { name: "输出 Tokens", value: aggregate.response, color: "#0C70F3" },
      { name: "输入未缓存", value: aggregate.promptMiss, color: "#60B3FE" },
      { name: "输入缓存命中", value: aggregate.promptHit, color: "#A0DCFD" },
    ]);
  }

  function buildModelsChartOption(models) {
    if (!models.length) return null;
    const textColor = getChartTextColor();
    return {
      animation: false,
      tooltip: {
        confine: true,
        trigger: "item",
        ...tooltipInteractionOption(),
        extraCssText: getTooltipCss(),
        formatter: (params) => tooltipHtml(params.name, [
          { color: params.color, label: "Tokens", value: formatInteger(params.value) },
          { color: params.color, label: "占比", value: `${formatDecimal(params.percent, 2)}%` },
        ]),
      },
      legend: {
        type: "scroll",
        orient: "vertical",
        right: 8,
        top: "middle",
        width: 118,
        height: 118,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: textColor, fontSize: 11 },
      },
      series: [{
        type: "pie",
        radius: ["36%", "52%"],
        center: ["38%", "44%"],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderWidth: 2, borderColor: "rgb(var(--ds-rgb-elevated, 255 255 255))" },
        data: models.map((model, index) => ({
          name: model.model,
          value: model.tokens,
          itemStyle: { color: chartPalette(index) },
        })),
        emphasis: { scale: true, scaleSize: 4 },
      }],
    };
  }

  function getKeyDetailData() {
    // 始终返回按 Key 聚合的数据（含 byModel 子数据用于模型明细）
    return state.keyDetailData;
  }

  function countModels() {
    if (!state.keyDetailData) return 0;
    const models = new Set();
    for (const item of state.keyDetailData) {
      if (item.byModel) {
        for (const name of Object.keys(item.byModel)) {
          if (name && name !== "unknown") models.add(name);
        }
      }
    }
    return models.size;
  }

  function countModelItems() {
    if (!state.keyDetailData) return 0;
    let count = 0;
    for (const item of state.keyDetailData) {
      if (item.byModel) {
        for (const name of Object.keys(item.byModel)) {
          if (name && name !== "unknown") count++;
        }
      }
    }
    return count;
  }

  function buildKeyCostChartOption() {
    // 根据 groupByModel 决定使用 Key 级还是模型级数据
    let data = getFilteredKeyData();
    if (!data || !data.length) return null;
    if (state.groupByModel) {
      // 展平为 (key, model) 二元组，每个条目显示为 "key - model"
      const flat = [];
      for (const item of data) {
        if (!item.byModel) continue;
        const models = Object.entries(item.byModel)
          .filter(([name]) => name && name !== "unknown")
          .sort((a, b) => (b[1].totalCost || 0) - (a[1].totalCost || 0));
        for (const [name, m] of models) {
          flat.push({
            key: `${item.key} - ${name}`,
            requestCount: m.requestCount || 0,
            inputMissTokens: m.missTokens || 0,
            inputHitTokens: m.hitTokens || 0,
            outputTokens: m.outTokens || 0,
            inputMissCost: m.missCost || 0,
            inputHitCost: m.hitCost || 0,
            outputCost: m.outCost || 0,
            totalCost: m.totalCost || 0,
          });
        }
      }
      data = flat;
    }
    const textColor = getChartTextColor();
    const gridColor = getChartGridColor();
    const names = data.map((k) => k.key);
    return {
      animation: false,
      grid: { left: state.groupByModel ? 130 : 72, right: 90, top: 12, bottom: 28 },
      tooltip: {
        confine: true,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        extraCssText: getTooltipCss(),
        formatter: (params) => {
          const item = data[params[0]?.dataIndex];
          if (!item) return "";
          const hitRate = item.inputHitTokens + item.inputMissTokens > 0
            ? item.inputHitTokens / (item.inputHitTokens + item.inputMissTokens)
            : 0;
          return tooltipHtml(item.key, [
            { color: "#E87461", label: "未缓存费用", value: formatCnyAmount(item.inputMissCost, 6) },
            { color: "#60B3FE", label: "缓存费用", value: formatCnyAmount(item.inputHitCost, 6) },
            { color: "#7BCB99", label: "输出费用", value: formatCnyAmount(item.outputCost, 6) },
            { color: "#A78BFA", label: "缓存命中率", value: formatPercent(hitRate) },
          ]);
        },
      },
      xAxis: {
        type: "value",
        splitLine: { lineStyle: { color: gridColor } },
        axisLabel: { color: textColor, formatter: (v) => `¥${formatDecimal(v, 2)}` },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: names,
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: textColor, width: state.groupByModel ? 120 : 72, overflow: "truncate" },
      },
      series: [
        {
          name: "未缓存费用",
          type: "bar",
          stack: "cost",
          barMaxWidth: 200,
          barCategoryGap: "20%",
          data: data.map((k) => k.inputMissCost),
          itemStyle: { color: "#E87461" },
          emphasis: { disabled: true },
        },
        {
          name: "缓存费用",
          type: "bar",
          stack: "cost",
          barMaxWidth: 200,
          barCategoryGap: "20%",
          data: data.map((k) => k.inputHitCost),
          itemStyle: { color: "#60B3FE" },
          emphasis: { disabled: true },
        },
        {
          name: "输出费用",
          type: "bar",
          stack: "cost",
          barMaxWidth: 200,
          barCategoryGap: "20%",
          data: data.map((k) => k.outputCost),
          label: {
            show: true,
            position: "right",
            color: textColor,
            fontWeight: 600,
            formatter: (p) => formatCnyAmount(data[p.dataIndex]?.totalCost || 0, 4),
          },
          itemStyle: { color: "#7BCB99" },
          emphasis: { disabled: true },
        },
      ],
    };
  }

  function buildKeyDailyChartOption() {
    const dailyData = getFilteredDailyData();
    if (!dailyData || !dailyData.dates || !dailyData.dates.length || !dailyData.series || !dailyData.series.length) return null;
    const textColor = getChartTextColor();
    const gridColor = getChartGridColor();
    const option = chartBaseOption();
    option.grid.left = 56;
    option.grid.right = 16;
    option.xAxis.data = dailyData.dates;
    option.tooltip.formatter = (params) => {
      const rows = params.map((p, i) => ({
        color: p.color,
        label: p.seriesName,
        value: formatCnyAmount(p.value, 4),
      }));
      return tooltipHtml(params[0]?.axisValue || "", rows);
    };
    // tooltip 保持在图表容器内但不强制裁剪，避免多出滚动条
    option.tooltip.appendToBody = false;
    option.tooltip.confine = false;
    option.yAxis.axisLabel.formatter = (v) => `¥${formatDecimal(v, 2)}`;
    option.series = dailyData.series.map((s, i) => ({
      name: s.name,
      data: s.data,
      type: "line",
      smooth: true,
      showSymbol: false,
      itemStyle: { color: chartPalette(i) },
      lineStyle: { color: chartPalette(i), width: 1.5 },
      emphasis: { disabled: true },
    }));
    option.legend = {
      show: true,
      top: 0,
      left: "center",
      textStyle: { color: textColor, fontSize: 11 },
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 8,
    };
    option.grid.top = 32;
    return option;
  }

  function buildHorizontalBarOption(items) {
    const textColor = getChartTextColor();
    const gridColor = getChartGridColor();
    return {
      animation: false,
      grid: { left: 94, right: 56, top: 8, bottom: 8 },
      tooltip: {
        confine: true,
        trigger: "axis",
        ...tooltipInteractionOption(),
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(2,14,54,0.04)" } },
        extraCssText: getTooltipCss(),
        formatter: (params) => tooltipHtml(params[0]?.name || "", [
          { color: params[0]?.color || "#0C70F3", label: "Tokens", value: formatInteger(params[0]?.value || 0) },
        ]),
      },
      xAxis: {
        type: "value",
        splitNumber: 1,
        splitLine: { lineStyle: { color: gridColor } },
        axisLabel: { color: textColor, formatter: compactNumber },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: items.map((item) => item.name),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: {
          color: textColor,
          width: 86,
          overflow: "truncate",
        },
      },
      series: [{
        type: "bar",
        barMaxWidth: 48,
        data: items.map((item) => ({ value: item.value, itemStyle: { color: item.color } })),
        label: {
          show: true,
          position: "right",
          color: textColor,
          formatter: (params) => compactNumber(params.value),
        },
        emphasis: { disabled: true },
      }],
    };
  }

  function chartPalette(index) {
    return [
      "#E74C3C", "#3498DB", "#2ECC71", "#F39C12",
      "#9B59B6", "#1ABC9C", "#E67E22", "#2980B9",
      "#27AE60", "#D35400", "#8E44AD", "#16A085",
      "#C0392B", "#3B82F6", "#10B981", "#F59E0B",
    ][index % 16];
  }

  function tooltipHtml(title, rows) {
    const body = rows.map((row) => `
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;color:rgb(var(--ds-rgb-label-2));font-size:var(--ds-font-size-sp);line-height:var(--ds-line-height-sp);">
        <span style="display:flex;align-items:center;gap:8px;">
          <span style="width:12px;height:12px;border-radius:2px;background:${row.color};display:inline-block;"></span>
          <span>${escapeHtml(row.label)}</span>
        </span>
        <span style="font-variant-numeric:tabular-nums;color:rgb(var(--ds-rgb-label-2));">${escapeHtml(row.value)}</span>
      </div>
    `).join("");
    return `
      <div style="display:flex;flex-direction:column;gap:8px;min-width:150px;">
        <div style="color:rgb(var(--ds-rgb-label-1));font-weight:var(--ds-font-weight-strong);font-size:var(--ds-font-size-sp);line-height:var(--ds-line-height-sp);">${escapeHtml(title)}</div>
        ${body}
      </div>
    `;
  }

  function costForModel(costBlocks, modelName) {
    const parts = [];
    for (const block of costBlocks) {
      const hit = block.modelCosts.find((item) => item.model === modelName);
      if (!hit || !hit.amount) continue;
      parts.push(formatMoney({ currency: block.currency, amount: hit.amount }));
    }
    return parts.length ? parts.join(" + ") : "0";
  }

  function costForKey(costBlocks, keyName) {
    const parts = [];
    for (const block of costBlocks) {
      const hit = (block.keyCosts || []).find((item) => item.key === keyName);
      if (!hit || !hit.amount) continue;
      parts.push(formatMoney({ currency: block.currency, amount: hit.amount }));
    }
    return parts.length ? parts.join(" + ") : "0";
  }

  function renderKeyTable(keys, costBlocks, visible = true) {
    const rows = keys
      .map((key) => {
        const costText = costForKey(costBlocks, key.key);
        return `
          <tr>
            <td title="${escapeHtml(key.key)}">${escapeHtml(key.key)}</td>
            <td>${formatInteger(key.request)}</td>
            <td>${formatInteger(key.tokens)}</td>
            <td>${formatInteger(key.response)}</td>
            <td>${formatInteger(key.promptMiss)}</td>
            <td>${formatInteger(key.promptHit)}</td>
            <td>${formatPercent(key.cacheHitRate)}</td>
            <td>${escapeHtml(costText)}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="dsapi-plus-table-wrap"${visible ? '' : ' style="display:none;"'}>
        <table class="dsapi-plus-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>请求数</th>
              <th>Tokens</th>
              <th>输出</th>
              <th>输入未缓存</th>
              <th>输入缓存命中</th>
              <th>缓存命中占比</th>
              <th>费用</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderKeyTableForExport(keys, unitPrices, visible = true, byModel = false) {
    const makeRow = (item, label, isSub = false) => {
      const totalCost = isSub ? (item.missCost || 0) + (item.hitCost || 0) + (item.outCost || 0) : (item.inputMissCost || 0) + (item.inputHitCost || 0) + (item.outputCost || 0);
      const missT = isSub ? (item.missTokens || 0) : (item.inputMissTokens || 0);
      const hitT = isSub ? (item.hitTokens || 0) : (item.inputHitTokens || 0);
      const outT = isSub ? (item.outTokens || 0) : (item.outputTokens || 0);
      const missC = isSub ? (item.missCost || 0) : (item.inputMissCost || 0);
      const hitC = isSub ? (item.hitCost || 0) : (item.inputHitCost || 0);
      const outC = isSub ? (item.outCost || 0) : (item.outputCost || 0);
      const totalTokens = missT + hitT + outT;
      const hitRate = missT + hitT > 0 ? hitT / (missT + hitT) : 0;
      const req = isSub ? (item.requestCount || 0) : (item.requestCount || 0);
      return `
          <tr${isSub ? ' style="color:var(--dsapi-plus-muted);font-size:11px;"' : ''}>
            <td${isSub ? ' style="padding-left:24px;"' : ''} title="${escapeHtml(label)}">${escapeHtml(label)}</td>
            <td>${formatInteger(req)}</td>
            <td>${formatInteger(missT)}</td>
            <td>${formatInteger(hitT)}</td>
            <td>${formatInteger(outT)}</td>
            <td>${formatInteger(totalTokens)}</td>
            <td>${formatPercent(hitRate)}</td>
            <td>${formatCnyAmount(missC, 6)}</td>
            <td>${formatCnyAmount(hitC, 6)}</td>
            <td>${formatCnyAmount(outC, 6)}</td>
            <td>${formatCnyAmount(totalCost, 6)}</td>
          </tr>`;
    };
    const rows = keys
      .map((key) => {
        let html = makeRow(key, key.key);
        if (byModel && key.byModel) {
          const models = Object.entries(key.byModel)
            .filter(([name]) => name && name !== "unknown")
            .sort((a, b) => b[1].totalCost - a[1].totalCost);
          for (const [modelName, modelData] of models) {
            html += makeRow(modelData, modelData.model || modelName, true);
          }
        }
        return html;
      })
      .join("");

    return `
      <div class="dsapi-plus-table-wrap"${visible ? '' : ' style="display:none;"'}>
        <table class="dsapi-plus-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>请求数</th>
              <th>输入未缓存</th>
              <th>输入缓存命中</th>
              <th>输出</th>
              <th>总Token</th>
              <th>缓存命中率</th>
              <th>未缓存费用</th>
              <th>缓存费用</th>
              <th>输出费用</th>
              <th>总费用</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // 获取导出 ZIP 文件（返回 ArrayBuffer）
  async function fetchExportBlob(path, signal) {
    const { token, source } = getStoredAuthToken();
    const headers = { accept: "application/octet-stream, application/zip, */*" };
    const appVersion = document.querySelector('meta[name="commit-id"]')?.content;
    if (appVersion) headers["X-App-Version"] = appVersion;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(path, {
      credentials: "include",
      headers,
      signal,
    });
    if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  }

  // 解析 CSV/TSV 文本为二维数组
  function parseCSV(text) {
    // 自动检测分隔符（制表符或逗号）
    const firstLine = text.split("\n").find((l) => l.trim());
    const delimiter = firstLine && firstLine.includes("\t") ? "\t" : ",";
    console.log("[DeepSeek Usage Panel Plus] 检测到分隔符", delimiter === "\t" ? "TAB" : "逗号");

    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) return { headers: [], rows: [] };
    const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
    const rows = lines.slice(1).map((line) => {
      if (delimiter === "\t") return line.split("\t").map((v) => v.trim().replace(/^"|"$/g, ""));
      // 逗号分隔时处理引号
      const vals = [];
      let current = "";
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === "," && !inQuote) { vals.push(current.trim()); current = ""; continue; }
        current += ch;
      }
      vals.push(current.trim());
      return vals;
    });
    return { headers, rows };
  }

  // 从导出接口获取 Key 级用量数据
  async function fetchKeyDetailFromExport(period, signal) {
    state.keyDetailLoading = true;
    state.keyDetailError = "";
    updateKeyDetailUI();

    try {
      const { year, month } = parsePeriod(period);
      const query = `year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;

      // 1. 下载 ZIP 文件
      const zipBuffer = await fetchExportBlob(`/api/v0/usage/export?${query}`, signal);
      console.log("[DeepSeek Usage Panel Plus] 下载 ZIP 大小", zipBuffer.byteLength, "bytes");

      // 2. 用 JSZip 解压
      const JSZip = window.JSZip;
      if (!JSZip) throw new Error("JSZip 库未加载");
      const zip = await JSZip.loadAsync(zipBuffer);

      // 3. 找到 amount-*.csv 文件
      const csvFiles = Object.keys(zip.files).filter((name) => /amount.*\.csv$/i.test(name));
      console.log("[DeepSeek Usage Panel Plus] ZIP 中的 CSV 文件", csvFiles);
      if (!csvFiles.length) throw new Error(`ZIP 中未找到 amount-*.csv 文件，可用文件：${Object.keys(zip.files).join(", ")}`);

      const csvContent = await zip.files[csvFiles[0]].async("string");
      console.log("[DeepSeek Usage Panel Plus] CSV 内容前 500 字符", csvContent.slice(0, 500));

      // 4. 解析 CSV
      const { headers, rows } = parseCSV(csvContent);
      console.log("[DeepSeek Usage Panel Plus] CSV 表头", headers);
      console.log("[DeepSeek Usage Panel Plus] CSV 行数", rows.length);
      if (rows.length > 0) console.log("[DeepSeek Usage Panel Plus] CSV 第1行", rows[0]);

      // 5. 根据 CSV 表头定位关键列
      const idx = (pattern) => headers.findIndex((h) => pattern.test(h.toLowerCase()));
      const colName = idx(/api_key_name|key_name|name/i);         // Key 名称列
      const colType = idx(/^type$/i);                              // 类型列
      const colPrice = idx(/^price$/i);                            // 单价列
      const colAmount = idx(/^amount$/i);                          // 用量列
      const colModel = idx(/model/i);                              // 模型列
      const colDate = idx(/utc_date|date/i);                        // 日期列

      console.log("[DeepSeek Usage Panel Plus] CSV 字段映射", {
        api_key_name: colName >= 0 ? headers[colName] : "未找到",
        type: colType >= 0 ? headers[colType] : "未找到",
        price: colPrice >= 0 ? headers[colPrice] : "未找到",
        amount: colAmount >= 0 ? headers[colAmount] : "未找到",
        model: colModel >= 0 ? headers[colModel] : "未找到",
        allHeaders: headers,
      });
      if (colName < 0 || colType < 0 || colAmount < 0) {
        throw new Error(`CSV 缺少必要列，请检查表头：${headers.join(" | ")}`);
      }

      // 6. 先按 (api_key_name, model) 二元组聚合，确保模型级数据精确
      const detailMap = {};
      for (const row of rows) {
        const keyName = String(row[colName] || "unknown");
        const type = colType >= 0 ? String(row[colType] || "") : "";
        const amount = colAmount >= 0 ? Number(row[colAmount]) || 0 : 0;
        const price = colPrice >= 0 ? Number(row[colPrice]) || 0 : 0;
        const modelName = colModel >= 0 ? String(row[colModel] || "") : "";
        if (!modelName) continue;
        const pairKey = keyName + "|||" + modelName;

        if (!detailMap[pairKey]) {
          detailMap[pairKey] = {
            key: keyName, model: modelName,
            requestCount: 0,
            inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0,
            inputMissCost: 0, inputHitCost: 0, outputCost: 0,
            totalCost: 0,
          };
        }
        const entry = detailMap[pairKey];
        const cost = price * amount;
        if (type === "input_cache_hit_tokens" || type === "prompt_cache_hit_token" || type === "inputCacheHit") {
          entry.inputHitTokens += amount; entry.inputHitCost += cost;
        } else if (type === "input_cache_miss_tokens" || type === "prompt_cache_miss_token" || type === "inputCacheMiss") {
          entry.inputMissTokens += amount; entry.inputMissCost += cost;
        } else if (type === "output_tokens" || type === "completion_token" || type === "output") {
          entry.outputTokens += amount; entry.outputCost += cost;
        } else if (type === "request_count" || type === "calls" || type === "requests") {
          entry.requestCount += amount;
        }
        entry.totalCost += cost;
      }

      // 7. 从模型级数据汇总到 Key 级
      const keyMap = {};
      for (const item of Object.values(detailMap)) {
        if (!keyMap[item.key]) {
          keyMap[item.key] = {
            key: item.key,
            requestCount: 0,
            inputMissTokens: 0, inputHitTokens: 0, outputTokens: 0,
            inputMissCost: 0, inputHitCost: 0, outputCost: 0,
            totalCost: 0,
            byModel: {},
          };
        }
        const k = keyMap[item.key];
        k.requestCount += item.requestCount;
        k.inputMissTokens += item.inputMissTokens;
        k.inputHitTokens += item.inputHitTokens;
        k.outputTokens += item.outputTokens;
        k.inputMissCost += item.inputMissCost;
        k.inputHitCost += item.inputHitCost;
        k.outputCost += item.outputCost;
        k.totalCost += item.totalCost;
        k.byModel[item.model] = {
          model: item.model,
          requestCount: item.requestCount,
          missTokens: item.inputMissTokens,
          hitTokens: item.inputHitTokens,
          outTokens: item.outputTokens,
          missCost: item.inputMissCost,
          hitCost: item.inputHitCost,
          outCost: item.outputCost,
          totalCost: item.totalCost,
        };
      }

      const sorted = Object.values(keyMap).sort((a, b) => b.totalCost - a.totalCost || b.requestCount - a.requestCount);

      // 8. 按 (key, date) 聚合每日费用（用于每日详情折线图）
      const dailyMap = {};
      const allDates = new Set();
      for (const row of rows) {
        const keyName = String(row[colName] || "unknown");
        if (keyName === "unknown") continue;
        const date = colDate >= 0 ? String(row[colDate] || "") : "";
        if (!date) continue;
        allDates.add(date);
        const type = colType >= 0 ? String(row[colType] || "") : "";
        const amount = colAmount >= 0 ? Number(row[colAmount]) || 0 : 0;
        const price = colPrice >= 0 ? Number(row[colPrice]) || 0 : 0;
        if (type === "request_count" || type === "calls" || type === "requests") continue;
        const pairKey = keyName + "|||" + date;
        if (!dailyMap[pairKey]) dailyMap[pairKey] = 0;
        dailyMap[pairKey] += price * amount;
      }
      const sortedDates = Array.from(allDates).sort();
      // 构建每 key 每日费用数组
      const dailyCostByKey = {};
      for (const row of rows) {
        const keyName = String(row[colName] || "unknown");
        if (keyName === "unknown") continue;
        if (!dailyCostByKey[keyName]) {
          dailyCostByKey[keyName] = { name: keyName, data: {} };
          for (const d of sortedDates) dailyCostByKey[keyName].data[d] = 0;
        }
      }
      for (const [pairKey, cost] of Object.entries(dailyMap)) {
        const sep = pairKey.lastIndexOf("|||");
        const k = pairKey.substring(0, sep);
        const d = pairKey.substring(sep + 3);
        if (dailyCostByKey[k]) dailyCostByKey[k].data[d] = cost;
      }
      const sortedKeys2 = Object.values(keyMap).sort((a, b) => b.totalCost - a.totalCost || b.requestCount - a.requestCount);
      const keyOrder = sortedKeys2.map((k) => k.key);
      const dailyData = {
        dates: sortedDates,
        series: keyOrder.filter((k) => dailyCostByKey[k]).map((k) => ({
          name: k,
          data: sortedDates.map((d) => dailyCostByKey[k].data[d] || 0),
        })),
      };

      console.log("[DeepSeek Usage Panel Plus] Key 明细聚合结果", {
        keysCount: sorted.length,
        sample: sorted.slice(0, 3),
      });

      state.keyDetailData = sorted;
      state.keyDetailDailyData = dailyData;
      state.keyDetailUpdateTime = new Date().toLocaleTimeString("zh-CN");
      state.keyUnitPrices = {}; // 不再需要，已从 CSV 获取实际价格
      state.keyDetailLoading = false;
      saveKeyDetailData(); // 持久化到本地
      updateKeyDetailUI();
      return sorted;
    } catch (error) {
      console.error("[DeepSeek Usage Panel Plus] 获取 Key 明细失败", error);
      state.keyDetailLoading = false;
      state.keyDetailError = error.message || String(error);
      updateKeyDetailUI();
      return null;
    }
  }

  // 更新 UI 中的 Key 明细区域
  function updateKeyDetailUI() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const keySection = panel.querySelector(".dsapi-plus-section:last-child");
    if (!keySection) return;

    // 更新 meta 文字
    const meta = keySection.querySelector(".dsapi-plus-section-meta");
    if (meta) {
      if (state.keyDetailLoading) {
        meta.textContent = "正在获取 Key 明细…";
      } else if (state.keyDetailError) {
        meta.textContent = "导入失败";
      } else if (state.keyDetailData && state.keyDetailData.length) {
        const activeData = getKeyDetailData();
        const itemCount = state.groupByModel ? countModels() : activeData.length;
        meta.textContent = state.groupByModel ? `${itemCount} 个活跃模型` : `${itemCount} 个活跃 Key`;
      } else {
        meta.textContent = "暂无 Key 用量";
      }
    }
    // 更新时间戳
    const statusEl = keySection.querySelector(".dsapi-plus-status");
    if (statusEl) {
      statusEl.textContent = `已更新 ${state.keyDetailUpdateTime || "--"}`;
    }

    // 更新内容
    const contentArea = keySection.querySelector(".dsapi-plus-table-wrap, .dsapi-plus-message");
    if (state.keyDetailLoading) {
      if (contentArea) contentArea.remove();
      const existingMsg = keySection.querySelector(".dsapi-plus-key-loading");
      if (!existingMsg) {
        keySection.insertAdjacentHTML("beforeend",
          '<div class="dsapi-plus-message dsapi-plus-key-loading">正在获取 Key 级别用量数据…</div>');
      }
    } else if (state.keyDetailError) {
      if (contentArea) contentArea.remove();
      const existingMsg = keySection.querySelector(".dsapi-plus-key-loading");
      if (existingMsg) existingMsg.remove();
      keySection.insertAdjacentHTML("beforeend",
        `<div class="dsapi-plus-message dsapi-plus-error dsapi-plus-key-loading">Key 明细导入失败：${escapeHtml(state.keyDetailError)}</div>`);
    } else if (state.keyDetailData && state.keyDetailData.length) {
      const existingMsg = keySection.querySelector(".dsapi-plus-key-loading");
      if (existingMsg) existingMsg.remove();
      const tableWrap = keySection.querySelector(".dsapi-plus-table-wrap");
      const newHTML = renderKeyTableForExport(getFilteredKeyData(), state.keyUnitPrices, state.keyTableVisible, state.groupByModel);
      if (tableWrap) {
        tableWrap.outerHTML = newHTML;
      } else {
        // 插入到图表容器之前
        const chartDiv = keySection.querySelector(".dsapi-plus-key-chart");
        if (chartDiv) {
          chartDiv.insertAdjacentHTML("beforebegin", newHTML);
        } else {
          keySection.insertAdjacentHTML("beforeend", newHTML);
        }
        // 移除之前的提示消息
        const oldMsg = keySection.querySelector(".dsapi-plus-message");
        if (oldMsg) oldMsg.remove();
      }
      // 初始化或更新 Key 费用图表
      initOrUpdateKeyCostChart(keySection);
    }
  }

  function initOrUpdateKeyCostChart(keySection) {
    const frame = keySection.querySelector(".dsapi-plus-chart-frame");
    if (!frame) return;
    // 确保图表容器存在
    let container = frame.querySelector('[data-dsapi-chart="keyCost"]');
    if (!container) {
      frame.innerHTML = '<div class="dsapi-plus-chart" data-dsapi-chart="keyCost"></div>';
      container = frame.querySelector('[data-dsapi-chart="keyCost"]');
    }
    // 更新 heading 值
    const heading = keySection.querySelector(".dsapi-plus-chart-heading-value");
    if (heading) {
      const itemCount = state.groupByModel ? countModelItems() : (state.keyDetailData ? state.keyDetailData.length : 0);
      heading.textContent = itemCount > 0
        ? `${itemCount} ${state.groupByModel ? '个明细' : '个活跃 Key'}`
        : "暂无数据";
    }
    // 同步图表容器高度：每横条 = 表格行高 36px + grid上下边距 40px
    const itemCount = state.groupByModel ? countModelItems() : (state.keyDetailData ? state.keyDetailData.length : 0);
    const chartHeight = itemCount > 0
      ? Math.max(100, itemCount * 36 + 40)
      : 160;
    frame.style.height = chartHeight + "px";
    container.style.height = chartHeight + "px";
    // 创建或更新图表
    const option = buildKeyCostChartOption();
    if (!option || !container) return;
    getEcharts().then((echarts) => {
      // 检查是否已有实例
      let instance = null;
      for (const entry of state.charts) {
        if (entry.key === "keyCost") {
          instance = entry.instance;
          break;
        }
      }
      if (instance && !instance.isDisposed()) {
        instance.setOption(option, { notMerge: true });
      } else {
        instance = echarts.init(container, null, { renderer: "svg" });
        const zr = instance.getZr();
        zr.on("mousemove", (event) => startTooltipKeeper(instance, event));
        zr.on("globalout", () => { if (stopTooltipKeeper(instance)) flushPendingChartUpdates(); });
        instance.setOption(option);
        state.charts.push({ key: "keyCost", instance });
      }
      instance.resize();
    });
  }

  function renderKeyTable(keys, costBlocks, visible = true) {
    const rows = keys
      .map((key) => {
        const costText = costForKey(costBlocks, key.key);
        return `
          <tr>
            <td title="${escapeHtml(key.key)}">${escapeHtml(key.key)}</td>
            <td>${formatInteger(key.request)}</td>
            <td>${formatInteger(key.tokens)}</td>
            <td>${formatInteger(key.response)}</td>
            <td>${formatInteger(key.promptMiss)}</td>
            <td>${formatInteger(key.promptHit)}</td>
            <td>${formatPercent(key.cacheHitRate)}</td>
            <td>${escapeHtml(costText)}</td>
          </tr>
        `;
      })
      .join("");

    return `
      <div class="dsapi-plus-table-wrap"${visible ? '' : ' style="display:none;"'}>
        <table class="dsapi-plus-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>请求数</th>
              <th>Tokens</th>
              <th>输出</th>
              <th>输入未缓存</th>
              <th>输入缓存命中</th>
              <th>缓存命中占比</th>
              <th>费用</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function toggleNativeContent(show) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panel.parentNode) return;
    const siblings = Array.from(panel.parentNode.children);
    const idx = siblings.indexOf(panel);
    for (let i = idx + 1; i < siblings.length; i++) {
      siblings[i].style.display = show ? "" : "none";
    }
  }

  function applyKeyFilter(panel) {
    const keySection = panel.querySelector(".dsapi-plus-section:last-child");
    if (!keySection) return;
    // 更新表格
    const filtered = getFilteredKeyData();
    const meta = keySection.querySelector(".dsapi-plus-section-meta");
    if (meta && filtered) meta.textContent = `${filtered.length} 个活跃 Key`;
    const tableWrap = keySection.querySelector(".dsapi-plus-table-wrap");
    if (tableWrap && filtered && filtered.length) {
      tableWrap.outerHTML = renderKeyTableForExport(filtered, state.keyUnitPrices, state.keyTableVisible, state.groupByModel);
    }
    // 更新费用分布图
    initOrUpdateKeyCostChart(keySection);
    // 更新每日曲线图
    const dailyChart = panel.querySelector(".dsapi-plus-daily-chart");
    if (dailyChart && dailyChart.style.display !== "none") {
      const container = dailyChart.querySelector('[data-dsapi-chart="keyDaily"]');
      if (container) {
        const option = buildKeyDailyChartOption();
        if (option) {
          getEcharts().then((echarts) => {
            let instance = echarts.getInstanceByDom(container);
            if (instance) { instance.setOption(option, { notMerge: true }); instance.resize(); }
          });
        }
      }
    }
    for (const { instance } of state.charts) instance?.resize();
  }

  function bindRefresh(panel) {
    const button = panel.querySelector(".dsapi-plus-refresh");
    if (button) {
      button.addEventListener("click", () => {
        refresh(true);
        // 同时刷新 Key 明细
        const period = getSelectedPeriod();
        const controller = new AbortController();
        fetchKeyDetailFromExport(period, controller.signal);
      });
    }

    // 切换 Key 明细表格显示
    const toggleBtn = panel.querySelector(".dsapi-plus-toggle-key-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        state.keyTableVisible = !state.keyTableVisible;
        toggleBtn.textContent = state.keyTableVisible ? "隐藏表格详情" : "显示表格详情";
        toggleBtn.classList.toggle("active", state.keyTableVisible);
        saveKeyTableVisible();
        const keySection = panel.querySelector(".dsapi-plus-section:last-child");
        if (!keySection) return;
        const tableWrap = keySection.querySelector(".dsapi-plus-table-wrap");
        if (tableWrap) {
          tableWrap.style.display = state.keyTableVisible ? "" : "none";
        }
        // 表格显示状态变化后调整图表尺寸
        for (const { instance } of state.charts) instance?.resize();
      });
    }

    // 按模型/Key 统计切换
    const groupModelBtn = panel.querySelector(".dsapi-plus-group-model-btn");
    if (groupModelBtn) {
      groupModelBtn.addEventListener("click", () => {
        state.groupByModel = !state.groupByModel;
        groupModelBtn.textContent = state.groupByModel ? "按Key统计" : "按模型统计";
        groupModelBtn.classList.toggle("active", state.groupByModel);
        saveGroupByModel();
        // 重新渲染表格和图表
        const keySection = panel.querySelector(".dsapi-plus-section:last-child");
        if (keySection) {
          const activeData = getFilteredKeyData();
          const tableWrap = keySection.querySelector(".dsapi-plus-table-wrap");
          if (tableWrap && activeData && activeData.length) {
            tableWrap.outerHTML = renderKeyTableForExport(activeData, state.keyUnitPrices, state.keyTableVisible, state.groupByModel);
          }
          // 更新 meta
          const meta = keySection.querySelector(".dsapi-plus-section-meta");
          if (meta && activeData) {
            const itemCount = state.groupByModel ? countModels() : activeData.length;
            meta.textContent = state.groupByModel ? `${itemCount} 个活跃模型` : `${itemCount} 个活跃 Key`;
          }
          initOrUpdateKeyCostChart(keySection);
        }
        for (const { instance } of state.charts) instance?.resize();
      });
    }

    // Key 筛选
    const filterWrap = panel.querySelector(".dsapi-plus-key-filter-wrap");
    const filterBtn = panel.querySelector(".dsapi-plus-key-filter-btn");
    const filterDropdown = panel.querySelector(".dsapi-plus-key-filter-dropdown");
    const filterList = panel.querySelector(".dsapi-plus-filter-list");
    if (filterWrap && filterBtn && filterDropdown && filterList) {
      // 填充下拉列表
      function populateFilterList() {
        const data = state.keyDetailData;
        if (!data || !data.length) { filterList.innerHTML = ""; return; }
        const filter = state.keyFilter || { mode: "all", keys: [] };
        const allKeys = data.map((k) => k.key);
        filterList.innerHTML = allKeys
          .map((k) => {
            const checked = filter.mode === "all" || filter.keys.includes(k);
            return `<label><input type="checkbox" value="${escapeHtml(k)}"${checked ? " checked" : ""}><span>${escapeHtml(k)}</span></label>`;
          })
          .join("");
        // 更新按钮文字
        const selectedCount = filter.mode === "all" ? allKeys.length : filter.keys.length;
        filterBtn.textContent = selectedCount < allKeys.length ? `筛选 (${selectedCount})` : "筛选";
      }
      populateFilterList();

      // 切换下拉菜单
      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        populateFilterList();
        filterDropdown.style.display = filterDropdown.style.display === "none" ? "" : "none";
      });

      // 全选 / 全取消
      filterWrap.querySelector(".dsapi-plus-filter-all-btn")?.addEventListener("click", () => {
        state.keyFilter = { mode: "all", keys: [] };
        saveKeyFilter();
        filterBtn.textContent = "筛选";
        filterList.querySelectorAll("input").forEach((cb) => { cb.checked = true; });
        applyKeyFilter(panel);
        filterDropdown.style.display = "none";
      });
      filterWrap.querySelector(".dsapi-plus-filter-none-btn")?.addEventListener("click", () => {
        const data = state.keyDetailData;
        state.keyFilter = { mode: "selected", keys: data ? [] : [] };
        saveKeyFilter();
        filterBtn.textContent = "筛选 (0)";
        filterList.querySelectorAll("input").forEach((cb) => { cb.checked = false; });
        applyKeyFilter(panel);
        filterDropdown.style.display = "none";
      });

      // 单个 checkbox
      filterList.addEventListener("change", () => {
        const checks = filterList.querySelectorAll("input:checked");
        const allKeys = (state.keyDetailData || []).map((k) => k.key);
        if (checks.length === allKeys.length) {
          state.keyFilter = { mode: "all", keys: [] };
        } else {
          state.keyFilter = { mode: "selected", keys: Array.from(checks).map((cb) => cb.value) };
        }
        saveKeyFilter();
        filterBtn.textContent = checks.length < allKeys.length ? `筛选 (${checks.length})` : "筛选";
        applyKeyFilter(panel);
      });

      // 点击外部关闭
      document.addEventListener("click", (e) => {
        if (!filterWrap.contains(e.target)) filterDropdown.style.display = "none";
      });
    }

    // 每日详情切换
    const dailyBtn = panel.querySelector(".dsapi-plus-daily-btn");
    if (dailyBtn) {
      dailyBtn.addEventListener("click", () => {
        state.keyDetailDailyVisible = !state.keyDetailDailyVisible;
        dailyBtn.textContent = state.keyDetailDailyVisible ? "隐藏每日详情" : "显示每日详情";
        dailyBtn.classList.toggle("active", state.keyDetailDailyVisible);
        saveKeyDetailDailyVisible();
        const dailyChart = panel.querySelector(".dsapi-plus-daily-chart");
        if (dailyChart) {
          dailyChart.style.display = state.keyDetailDailyVisible ? "" : "none";
        }
        if (state.keyDetailDailyVisible) {
          // 初始化或更新每日图表
          const container = dailyChart?.querySelector('[data-dsapi-chart="keyDaily"]');
          if (container) {
            const option = buildKeyDailyChartOption();
            if (option) {
              getEcharts().then((echarts) => {
                let instance = echarts.getInstanceByDom(container);
                if (!instance) {
                  instance = echarts.init(container, null, { renderer: "svg" });
                  const zr = instance.getZr();
                  zr.on("mousemove", (event) => startTooltipKeeper(instance, event));
                  zr.on("globalout", () => { if (stopTooltipKeeper(instance)) flushPendingChartUpdates(); });
                  state.charts.push({ key: "keyDaily", instance });
                }
                instance.setOption(option, { notMerge: true });
                instance.resize();
              });
            }
          }
        }
        for (const { instance } of state.charts) instance?.resize();
      });
    }

    // 图表区块显示切换（事件代理）
    // 图表区块显示切换
    panel.querySelectorAll(".dsapi-plus-toggle-section-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = btn.dataset.section;
        if (!section || !(section in state.sectionVisible)) return;
        state.sectionVisible[section] = !state.sectionVisible[section];
        btn.classList.toggle("active", state.sectionVisible[section]);
        saveSectionVisible();
        let block;
        if (section === "models") {
          block = panel.querySelector(".dsapi-plus-section");
        } else {
          const chartEl = panel.querySelector(`[data-dsapi-chart="${section}"]`);
          if (chartEl) block = chartEl.closest(".dsapi-plus-chart-block");
        }
        if (block) {
          block.style.display = state.sectionVisible[section] ? "" : "none";
        }
        for (const { instance } of state.charts) instance?.resize();
      });
    });

    // 原生内容显示切换
    const nativeBtn = panel.querySelector(".dsapi-plus-toggle-native-btn");
    if (nativeBtn) {
      nativeBtn.addEventListener("click", () => {
        state.nativeContentVisible = !state.nativeContentVisible;
        nativeBtn.textContent = state.nativeContentVisible ? "隐藏原生内容" : "显示原生内容";
        nativeBtn.classList.toggle("active", state.nativeContentVisible);
        saveNativeContentVisible();
        toggleNativeContent(state.nativeContentVisible);
      });
    }

    // 自动刷新切换
    const autoRefreshBtn = panel.querySelector(".dsapi-plus-auto-refresh-btn");
    if (autoRefreshBtn) {
      autoRefreshBtn.addEventListener("click", () => {
        state.autoRefreshInterval = nextAutoRefreshInterval(state.autoRefreshInterval);
        saveAutoRefreshInterval();
        applyAutoRefresh();
        autoRefreshBtn.textContent = `自动刷新 ${getAutoRefreshLabel(state.autoRefreshInterval)}`;
        autoRefreshBtn.classList.toggle("active", state.autoRefreshInterval > 0);
      });
      // 初始化时应用保存的自动刷新状态（直接读取 localStorage 确保一致性）
      const savedInterval = (() => {
        try {
          return parseInt(localStorage.getItem("dsapi_plus_auto_refresh"), 10) || 0;
        } catch (e) { return 0; }
      })();
      if (savedInterval > 0 && AUTO_REFRESH_INTERVALS.some((i) => i.value === savedInterval)) {
        state.autoRefreshInterval = savedInterval;
        autoRefreshBtn.textContent = `自动刷新 ${getAutoRefreshLabel(savedInterval)}`;
        autoRefreshBtn.classList.add("active");
        applyAutoRefresh();
      }
    }

    // 月份下拉选择
    const periodSelect = panel.querySelector(".dsapi-plus-period-select");
    if (periodSelect) {
      periodSelect.addEventListener("change", () => {
        state.selectedPeriod = periodSelect.value;
        // 清除旧的 Key 明细数据
        state.keyDetailData = null;
        state.keyDetailError = "";
        state.keyDetailUpdateTime = "";
        localStorage.removeItem("dsapi_plus_key_detail");
        refresh(true);
        // 自动刷新 Key 明细
        const controller = new AbortController();
        fetchKeyDetailFromExport(periodSelect.value, controller.signal);
      });
    }
    // 初始化时应用原生内容显示状态
    toggleNativeContent(state.nativeContentVisible);
  }

  function ensurePanel() {
    if (!isUsagePage()) return null;
    injectStyles();
    document.body.classList.add("dsapi-plus-page-wide");

    let panel = document.getElementById(PANEL_ID);
    const reference = findInsertionReference();
    if (!reference) return null;

    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      panel.className = "dsapi-plus-panel";
    }

    if (!panel.isConnected || panel.parentNode !== reference.parentNode || panel.nextSibling !== reference) {
      reference.parentNode.insertBefore(panel, reference);
    }

    // 每次确保面板时重新应用原生内容显示状态
    toggleNativeContent(state.nativeContentVisible);

    return panel;
  }

  function findInsertionReference() {
    const monthlyTitle = findExactTextElement("每月用量");
    if (monthlyTitle) return climbToSectionRow(monthlyTitle);

    const usageTitle = findExactTextElement("用量信息");
    if (usageTitle && usageTitle.parentElement) {
      return usageTitle.nextElementSibling || usageTitle.parentElement.firstElementChild;
    }

    const main = document.querySelector("main");
    return main && main.firstElementChild ? main.firstElementChild : null;
  }

  function findExactTextElement(text) {
    const root = document.querySelector("main") || document.body;
    const elements = Array.from(root.querySelectorAll("div, span, h1, h2, h3, [role='heading']"));
    return elements.find((element) => {
      if (element.id === PANEL_ID || element.closest(`#${PANEL_ID}`)) return false;
      const value = (element.textContent || "").trim();
      return value === text;
    });
  }

  function climbToSectionRow(element) {
    let node = element;
    for (let i = 0; i < 4 && node.parentElement; i += 1) {
      const parent = node.parentElement;
      const text = (parent.textContent || "").trim();
      if (text.includes("每月用量") && parent.children.length > 1) return parent;
      node = parent;
    }
    return element;
  }

  async function refresh(force) {
    if (!isUsagePage()) return;
    const panel = ensurePanel();
    if (!panel) return;

    const period = getSelectedPeriod();
    if (!force && state.selectedPeriod === period && ["1", "error", "loading"].includes(panel.dataset.loaded)) {
      return;
    }

    state.selectedPeriod = period;
    panel.dataset.loaded = "loading";
    const requestId = ++state.requestId;
    renderSkeleton(panel, period);

    state.abortController?.abort();
    state.abortController = new AbortController();
    const { signal } = state.abortController;
    const timeoutId = setTimeout(() => state.abortController.abort(), 30000);

    try {
      const data = await loadData(period, signal);
      clearTimeout(timeoutId);
      if (requestId !== state.requestId) return;
      panel.dataset.loaded = "1";
      renderPanel(panel, data);
    } catch (error) {
      clearTimeout(timeoutId);
      if (requestId !== state.requestId) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        if (state.abortController && state.abortController.signal !== signal) return;
        panel.dataset.loaded = "error";
        renderError(panel, period, new Error("请求超时（30 秒）"));
        return;
      }
      panel.dataset.loaded = "error";
      renderError(panel, period, error);
      console.error("[DeepSeek Usage Panel Plus]", error);
    }
  }

  function scheduleRefresh(force) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refresh(force), 120);
  }

  function teardownUsage() {
    window.clearTimeout(state.refreshTimer);
    window.clearTimeout(state.mutationTimer);
    window.clearTimeout(state.routeTimer);
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = 0;
    }
    state.abortController?.abort();
    state.abortController = null;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    disposeCharts();
    state.lastPanelData = null;
    state.selectedPeriod = "";
    state.booted = false;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  function startObservers() {
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && /^\d{4}-\d{1,2}$/.test(target.value || "")) {
        scheduleRefresh(true);
      }
    });

    state.observer = new MutationObserver(() => {
      window.clearTimeout(state.mutationTimer);
      state.mutationTimer = window.setTimeout(() => {
        const panel = ensurePanel();
        if (!panel) return;
        const period = getSelectedPeriod();
        if (period !== state.selectedPeriod || !panel.dataset.loaded) {
          scheduleRefresh(false);
        }
      }, 250);
    });

    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function bootUsage() {
    if (state.booted) return;
    state.booted = true;
    ensurePanel();
    startObservers();
    startThemeObserver();
    scheduleRefresh(true);
  }

  function handleRouteChange() {
    if (isUsagePage()) {
      bootUsage();
    } else if (state.booted) {
      teardownUsage();
    }
  }

  function installRouteObserver() {
    if (!state.historyHooked) {
      state.historyHooked = true;
      const notifyRouteChange = () => {
        window.clearTimeout(state.routeTimer);
        state.routeTimer = window.setTimeout(handleRouteChange, 50);
      };

      const wrapHistoryMethod = (name) => {
        const original = history[name];
        history[name] = function (...args) {
          const result = original.apply(this, args);
          notifyRouteChange();
          return result;
        };
      };

      wrapHistoryMethod("pushState");
      wrapHistoryMethod("replaceState");
      window.addEventListener("popstate", notifyRouteChange);
      window.addEventListener("hashchange", notifyRouteChange);
      new MutationObserver(notifyRouteChange).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    handleRouteChange();
  }

  function boot() {
    installRouteObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
