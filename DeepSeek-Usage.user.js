// ==UserScript==
// @name         DeepSeek Usage — DeepSeek用量页增强
// @namespace    https://github.com/PingWangWang
// @url          https://github.com/PingWangWang/DeepSeek-Usage.git
// @version      1.11.95
// @description  用量页增强仪表盘：订阅推送（Markdown/截图+ImgBB）、费用/Token构成、缓存命中率、Key明细（ZIP导入/模型统计/筛选/每日费用曲线/多选删除）、月份切换、自动刷新、手机适配。
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

    // Key 费用分布图可见性
    keyDetailChartVisible: loadKeyDetailChartVisible(),

    // 订阅功能
    subscriptions: loadSubscriptions(),           // 订阅配置数组
    subscriptionVisible: loadSubscriptionVisible(), // 订阅内嵌面板可见性
    subscriptionLastSent: loadSubscriptionLastSent(), // { subId: ISO时间戳 }
    subscriptionCheckTimer: 0,                    // 定时检查 timer 句柄
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

  function loadSubscriptionVisible() {
    try { return localStorage.getItem("dsapi_plus_subscription_visible") === "true"; }
    catch (e) { /* ignore */ }
    return false;
  }

  function saveSubscriptionVisible() {
    try { localStorage.setItem("dsapi_plus_subscription_visible", String(state.subscriptionVisible)); }
    catch (e) { /* ignore */ }
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

  function loadKeyDetailChartVisible() {
    try { return localStorage.getItem("dsapi_plus_key_chart_visible") !== "false"; }
    catch (e) { /* ignore */ }
    return true;
  }

  function saveKeyDetailChartVisible() {
    try { localStorage.setItem("dsapi_plus_key_chart_visible", String(state.keyDetailChartVisible)); }
    catch (e) { /* ignore */ }
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

  function loadSubscriptions() {
    try {
      const saved = localStorage.getItem("dsapi_plus_subscriptions");
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveSubscriptions() {
    try {
      localStorage.setItem("dsapi_plus_subscriptions", JSON.stringify(state.subscriptions));
    } catch (e) { /* ignore */ }
  }

  function loadSubscriptionLastSent() {
    try {
      const saved = localStorage.getItem("dsapi_plus_subscription_last_sent");
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return {};
  }

  function saveSubscriptionLastSent() {
    try {
      localStorage.setItem("dsapi_plus_subscription_last_sent", JSON.stringify(state.subscriptionLastSent));
    } catch (e) { /* ignore */ }
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
      /* 所有按钮控件统一样式 */
      .dsapi-plus-auto-refresh-btn,
      .dsapi-plus-toggle-section-btn,
      .dsapi-plus-toggle-key-btn,
      .dsapi-plus-toggle-native-btn,
      .dsapi-plus-group-model-btn,
      .dsapi-plus-daily-btn,
      .dsapi-plus-key-filter-btn,
      .dsapi-plus-cost-chart-btn,
      .dsapi-plus-subscribe-btn,
      .dsapi-plus-subscribe-create-btn,
      .dsapi-plus-refresh,
      .dsapi-plus-clear-cache-btn {
        min-width: 48px;
        text-align: center;
      }
      .dsapi-plus-clear-cache-btn {
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
        opacity: 0.6;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        white-space: nowrap;
      }
      .dsapi-plus-clear-cache-btn:hover {
        opacity: 1;
        background: rgba(214, 69, 65, 0.08);
        color: rgb(214, 69, 65);
        border-color: rgba(214, 69, 65, 0.3);
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
      .dsapi-plus-cost-chart-btn {
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
      .dsapi-plus-cost-chart-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-cost-chart-btn.active {
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
      body.dark .dsapi-plus-cost-chart-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-cost-chart-btn.active {
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
      body.dark .dsapi-plus-clear-cache-btn:hover {
        background: rgba(214, 69, 65, 0.15);
        color: #f87171;
        border-color: rgba(214, 69, 65, 0.4);
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
        .dsapi-plus-section-head > div:not(.dsapi-plus-section-title) {
          margin-left: 0 !important;
          width: 100%;
          justify-content: flex-start;
        }
        .dsapi-plus-head .dsapi-plus-actions {
          margin-left: 0;
          width: 100%;
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
        .dsapi-plus-subscribe-item-meta {
          gap: 6px;
        }
        .dsapi-plus-subscribe-item {
          padding: 10px 12px;
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
        .dsapi-plus-subscribe-section input,
        .dsapi-plus-subscribe-section select {
          font-size: 12px !important;
          min-height: 28px;
        }
        .dsapi-plus-subscribe-form-row {
          flex-direction: column;
          gap: 4px;
        }
        .dsapi-plus-subscribe-form-label {
          width: 100% !important;
        }
        .dsapi-plus-subscribe-form-control {
          width: 100% !important;
        }
        .dsapi-plus-subscribe-form-control input,
        .dsapi-plus-subscribe-form-control select {
          max-width: 100% !important;
          width: 100% !important;
          box-sizing: border-box;
        }
        .dsapi-plus-subscribe-item-meta {
          flex-direction: column;
          gap: 4px;
        }
        .dsapi-plus-subscribe-item-actions {
          flex-wrap: wrap;
        }
        .dsapi-plus-subscribe-item {
          padding: 10px;
        }
        .dsapi-plus-subscribe-checkbox-group {
          max-height: 120px;
          overflow-y: auto;
        }
      }

      /* ===== 订阅功能样式 ===== */
      .dsapi-plus-subscribe-btn {
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
      .dsapi-plus-subscribe-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-subscribe-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-subscribe-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.3);
        z-index: 99999;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 60px;
        overflow-y: auto;
      }
      .dsapi-plus-subscribe-panel {
        background: #fff;
        border-radius: 12px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.15);
        width: 640px;
        max-width: calc(100vw - 32px);
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        padding: 24px;
        position: relative;
        font-size: 13px;
        line-height: 1.5;
        color: #1a1a2e;
      }
      .dsapi-plus-subscribe-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 20px;
      }
      .dsapi-plus-subscribe-panel-header h2 {
        font-size: 18px;
        font-weight: 650;
        margin: 0;
      }
      .dsapi-plus-subscribe-panel-close {
        appearance: none;
        border: none;
        background: transparent;
        cursor: pointer;
        font-size: 22px;
        line-height: 1;
        color: var(--dsapi-plus-muted);
        padding: 4px 8px;
      }
      .dsapi-plus-subscribe-panel-close:hover {
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-subscribe-create-btn {
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
      .dsapi-plus-subscribe-create-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-subscribe-item {
        border: 1px solid rgba(2, 14, 54, 0.1);
        border-radius: 8px;
        padding: 14px 16px;
        margin-bottom: 10px;
        transition: border-color 0.15s;
      }
      .dsapi-plus-subscribe-item:hover {
        border-color: rgba(2, 14, 54, 0.25);
      }
      .dsapi-plus-subscribe-item-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .dsapi-plus-subscribe-item-name {
        font-weight: 600;
        font-size: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dsapi-plus-subscribe-item-name input[type="checkbox"] {
        margin: 0;
        accent-color: #22c55e;
      }
      .dsapi-plus-subscribe-item-meta {
        color: var(--dsapi-plus-muted);
        font-size: 11px;
        margin-top: 6px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .dsapi-plus-subscribe-item-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
      .dsapi-plus-subscribe-item-actions button {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        padding: 3px 8px;
        opacity: 0.7;
        transition: opacity 0.15s;
      }
      .dsapi-plus-subscribe-item-actions button:hover {
        opacity: 1;
        color: var(--dsapi-plus-text);
        border-color: var(--dsapi-plus-text);
      }
      .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-del-btn:hover {
        color: #e74c3c;
        border-color: #e74c3c;
      }
      .dsapi-plus-subscribe-batch-del-btn {
        margin-left:auto;
        border:1px solid var(--dsapi-plus-muted);
        border-radius:4px;
        background:transparent;
        color:var(--dsapi-plus-muted);
        cursor:pointer;
        font:inherit;
        font-size:11px;
        line-height:18px;
        padding:4px 6px;
        opacity:0.7;
        transition:opacity 0.15s;
        white-space:nowrap;
      }
      .dsapi-plus-subscribe-batch-del-btn:hover {
        opacity:1;
        background:rgba(231,76,60,0.08);
        color:#e74c3c;
        border-color:rgba(231,76,60,0.3);
      }
      .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-send-btn {
        color: #22c55e;
        border-color: #22c55e;
        opacity: 0.8;
      }
      .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-send-btn:hover {
        opacity: 1;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-preview-btn {
        color: #3b82f6;
        border-color: #3b82f6;
        opacity: 0.8;
      }
      .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-preview-btn:hover {
        opacity: 1;
        background: rgba(59, 130, 246, 0.08);
      }
      .dsapi-plus-subscribe-inline-content .dsapi-plus-subscribe-panel {
        width: 100%;
        max-width: none;
        box-shadow: none;
        padding: 0;
        border: none;
      }
      .dsapi-plus-subscribe-status-success {
        color: #22c55e;
      }
      .dsapi-plus-subscribe-status-error {
        color: #e74c3c;
      }
      .dsapi-plus-subscribe-form {
        border: 1px solid rgba(2, 14, 54, 0.1);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 12px;
      }
      .dsapi-plus-subscribe-form-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 12px;
      }
      .dsapi-plus-subscribe-form-row:last-child {
        margin-bottom: 0;
      }
      .dsapi-plus-subscribe-form-label {
        min-width: 80px;
        font-size: 12px;
        font-weight: 600;
        color: var(--dsapi-plus-text);
        padding-top: 6px;
        flex-shrink: 0;
      }
      .dsapi-plus-subscribe-form-control {
        flex: 1;
        min-width: 0;
      }
      .dsapi-plus-subscribe-form-control input[type="text"],
      .dsapi-plus-subscribe-form-control input[type="url"],
      .dsapi-plus-subscribe-form-control select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(2, 14, 54, 0.15);
        border-radius: 4px;
        padding: 6px 8px;
        font: inherit;
        font-size: 12px;
        color: var(--dsapi-plus-text);
        background: transparent;
        outline: none;
        transition: border-color 0.15s;
      }
      .dsapi-plus-subscribe-form-control input:focus,
      .dsapi-plus-subscribe-form-control select:focus {
        border-color: #22c55e;
      }
      .dsapi-plus-subscribe-form-control .dsapi-plus-subscribe-checkbox-group {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 12px;
        padding-top: 4px;
      }
      .dsapi-plus-subscribe-form-control .dsapi-plus-subscribe-checkbox-group label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      .dsapi-plus-subscribe-form-control .dsapi-plus-subscribe-checkbox-group input {
        margin: 0;
        accent-color: #22c55e;
      }
      .dsapi-plus-subscribe-form-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 12px;
      }
      .dsapi-plus-subscribe-form-actions button {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 4px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        padding: 5px 14px;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
      }
      .dsapi-plus-subscribe-form-actions button:hover {
        opacity: 1;
        color: var(--dsapi-plus-text);
        border-color: var(--dsapi-plus-text);
      }
      .dsapi-plus-subscribe-form-actions .dsapi-plus-subscribe-save-btn {
        color: #22c55e;
        border-color: #22c55e;
        opacity: 0.8;
      }
      .dsapi-plus-subscribe-form-actions .dsapi-plus-subscribe-save-btn:hover {
        opacity: 1;
        background: rgba(34, 197, 94, 0.08);
      }
      .dsapi-plus-subscribe-form-actions .dsapi-plus-subscribe-cancel-btn:hover {
        color: #e74c3c;
        border-color: #e74c3c;
      }
      .dsapi-plus-subscribe-schedule-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .dsapi-plus-subscribe-schedule-row select,
      .dsapi-plus-subscribe-schedule-row input[type="number"] {
        border: 1px solid rgba(2, 14, 54, 0.15);
        border-radius: 4px;
        padding: 4px 6px;
        font: inherit;
        font-size: 12px;
        color: var(--dsapi-plus-text);
        background: transparent;
        outline: none;
      }
      .dsapi-plus-subscribe-schedule-row select:focus,
      .dsapi-plus-subscribe-schedule-row input[type="number"]:focus {
        border-color: #22c55e;
      }
      body.dark .dsapi-plus-subscribe-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
      }
      body.dark .dsapi-plus-subscribe-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-subscribe-overlay {
        background: rgba(0,0,0,0.5);
      }
      body.dark .dsapi-plus-subscribe-panel {
        background: #1a1a2e;
        color: #e0e0e0;
      }
      body.dark .dsapi-plus-subscribe-item {
        border-color: rgba(255,255,255,0.12);
      }
      body.dark .dsapi-plus-subscribe-form {
        border-color: rgba(255,255,255,0.12);
      }
      body.dark .dsapi-plus-subscribe-form-control input,
      body.dark .dsapi-plus-subscribe-form-control select,
      body.dark .dsapi-plus-subscribe-schedule-row select,
      body.dark .dsapi-plus-subscribe-schedule-row input[type="number"] {
        border-color: rgba(255,255,255,0.2);
        color: #e0e0e0;
      }
      body.dark .dsapi-plus-subscribe-panel-close:hover {
        color: #e0e0e0;
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

  // ========== 订阅功能：数据管理 ==========

  function getActiveSubscriptionCount() {
    return state.subscriptions.filter(s => s.enabled).length;
  }

  function createSubscriptionId() {
    return "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  }

  function getDefaultSubscription() {
    return {
      id: createSubscriptionId(),
      name: "新订阅",
      enabled: true,
      receiveMethod: "webhook",
      webhookType: "dingtalk",
      webhookUrl: "",
      webhookSecret: "",
      keyFilterMode: "all",
      selectedKeys: [],
      scheduleType: "daily",
      scheduleInterval: 3600000,
      scheduleHour: 9,
      scheduleMinute: 0,
      scheduleDayOfWeek: 1,
      scheduleDayOfMonth: 1,
      contentFormat: "markdown",
    imgbbApiKey: "",
      contentOptions: {
        summary: true,
        tokenComposition: true,
        cacheHitRate: true,
        modelDetail: false,
        keyDetail: true,
        topKeys: 10,
      },
      createdAt: new Date().toISOString(),
      lastSentAt: null,
      lastSentStatus: null,
    };
  }

  // ========== 订阅功能：报告生成 ==========

  function buildSubscriptionReportData(sub) {
    const panelData = state.lastPanelData;
    if (!panelData) return null;
    const { summary, period, amount, cost } = panelData;

    // CNY 月度总费用
    const monthCnyCost = sumCurrencyAmount(cost, "CNY", "amount");
    const monthlyCnyCost = sumCurrencyAmount(summary.monthlyCosts, "CNY", "amount");
    const totalCost = monthCnyCost || monthlyCnyCost || 0;
    const totalUsage = summary.monthlyUsage || amount.aggregate.tokens || 0;

    // Token 构成 — 从 amount.aggregate
    const inputMiss = amount.aggregate.promptMiss || 0;
    const inputHit = amount.aggregate.promptHit || 0;
    const output = amount.aggregate.response || 0;

    // 费用构成 — 从 cost[CNY] modelCosts.usageCostMap
    const cnyBreakdown = getCostBreakdown(cost, "CNY");
    // getCostBreakdown 只返回 input/output 合并值，需要分拆 miss/hit
    let costMiss = 0, costHit = 0, costOut = 0;
    for (const block of cost) {
      if (!block || block.currency !== "CNY") continue;
      for (const mc of (block.modelCosts || [])) {
        costMiss += Number((mc.usageCostMap || {})[TOKEN_TYPES.promptMiss] || 0);
        costHit += Number((mc.usageCostMap || {})[TOKEN_TYPES.promptHit] || 0);
        costOut += Number((mc.usageCostMap || {})[TOKEN_TYPES.response] || 0);
      }
    }

    // 今日费用 — 复用 buildPanelData 逻辑
    const now = new Date();
    const todayDay = now.getUTCDate();
    let todayTotalCost = 0;
    for (const costBlock of cost) {
      if (costBlock.currency !== "CNY") continue;
      for (const dayCost of (costBlock.days || [])) {
        const match = String(dayCost.date || "").match(/(\d{1,2})$/);
        if (match && Number(match[1]) === todayDay) {
          todayTotalCost += (dayCost.amount || 0);
        }
      }
    }
    // 如果 cost API 没有今日数据，用均价估算
    if (!todayTotalCost && totalCost > 0 && totalUsage > 0) {
      const avgPerToken = totalCost / totalUsage;
      for (const day of (amount.days || [])) {
        const match = String(day.date || "").match(/(\d{1,2})$/);
        if (match && Number(match[1]) === todayDay && day.tokens > 0) {
          todayTotalCost = avgPerToken * day.tokens;
          break;
        }
      }
    }

    const avgCost = totalUsage > 0 ? (totalCost / totalUsage * 1000000) : 0;

    // 钱包余额
    var walletCnyBalance = sumCurrencyAmount(summary.normalWallets, "CNY", "balance") +
                           sumCurrencyAmount(summary.bonusWallets, "CNY", "balance");

    // 缓存命中率
    var promptTotal = inputMiss + inputHit;
    var overallCacheHitRate = promptTotal > 0 ? (inputHit / promptTotal * 100) : 0;

    // 过滤 Key 明细（月总数据）
    var keyDetailData = state.keyDetailData || [];
    if (sub.keyFilterMode === "selected" && sub.selectedKeys.length) {
      keyDetailData = keyDetailData.filter(function(item) { return sub.selectedKeys.includes(item.key); });
    }
    var topCount = sub.contentOptions.topKeys || 10;
    // 确保 topCount 为正整数
    if (typeof topCount !== "number" || topCount < 1) topCount = 10;
    var monthKeys = keyDetailData.slice(0, topCount).map(function(k) {
      var pt = (k.inputMissTokens || 0) + (k.inputHitTokens || 0);
      return {
        key: k.key,
        requestCount: k.requestCount,
        inputMissTokens: k.inputMissTokens,
        inputHitTokens: k.inputHitTokens,
        outputTokens: k.outputTokens,
        totalTokens: (k.inputMissTokens || 0) + (k.inputHitTokens || 0) + (k.outputTokens || 0),
        totalCost: k.totalCost,
        cacheHitRate: pt > 0 ? ((k.inputHitTokens || 0) / pt * 100) : 0,
      };
    });

    // 当日 Key 明细 — 从 keyDetailDailyData 提取今日各 Key 费用，并合并月明细字段
    var todayKeys = [];
    var dailyData = state.keyDetailDailyData;
    if (dailyData && dailyData.dates && dailyData.series) {
      var dates = dailyData.dates;
      var todayDate = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
      var todayIdx = -1;
      for (var di = 0; di < dates.length; di++) {
        if (String(dates[di]).indexOf(todayDate) === 0) { todayIdx = di; break; }
      }
      if (todayIdx >= 0) {
        // 从每日数据中获取今日请求数和 Tokens
        var todayByKey = [];
        // 兼容旧数据：若 dailyData 无 requests/tokens，用月数据填充
        var hasDailyDetail = dailyData.requests && dailyData.tokens;
        if (!hasDailyDetail) {
          // 构建 key → 月数据 映射（降级）
          var monthMap = {};
          for (var mi = 0; mi < keyDetailData.length; mi++) {
            monthMap[keyDetailData[mi].key] = keyDetailData[mi];
          }
        }
        for (var si = 0; si < dailyData.series.length; si++) {
          var s = dailyData.series[si];
          if (sub.keyFilterMode === "selected" && sub.selectedKeys.length && sub.selectedKeys.indexOf(s.name) < 0) continue;
          var todayReq = 0, todayTokens = 0, todayHitRate = 0;
          if (hasDailyDetail) {
            var reqSeries = dailyData.requests[si] ? dailyData.requests[si].data : null;
            var tokSeries = dailyData.tokens[si] ? dailyData.tokens[si].data : null;
            var missSeries = dailyData.miss && dailyData.miss[si] ? dailyData.miss[si].data : null;
            var hitSeries = dailyData.hit && dailyData.hit[si] ? dailyData.hit[si].data : null;
            todayReq = reqSeries ? (reqSeries[todayIdx] || 0) : 0;
            todayTokens = tokSeries ? (tokSeries[todayIdx] || 0) : 0;
            var todayMiss = missSeries ? (missSeries[todayIdx] || 0) : 0;
            var todayHit = hitSeries ? (hitSeries[todayIdx] || 0) : 0;
            todayHitRate = (todayMiss + todayHit) > 0 ? (todayHit / (todayMiss + todayHit) * 100) : 0;
          } else if (monthMap[s.name]) {
            // 降级：用月数据中的日均值
            var mk = monthMap[s.name];
            var daysInMonth = dailyData.dates.length || 1;
            todayReq = Math.round((mk.requestCount || 0) / daysInMonth);
            todayTokens = Math.round(((mk.inputMissTokens || 0) + (mk.inputHitTokens || 0) + (mk.outputTokens || 0)) / daysInMonth);
          }
          var entry = {
            key: s.name,
            todayCost: s.data[todayIdx] || 0,
            requestCount: todayReq,
            totalTokens: todayTokens,
            cacheHitRate: todayHitRate,
          };
          todayByKey.push(entry);
        }
        todayByKey.sort(function(a, b) { return b.todayCost - a.todayCost; });
        todayKeys = todayByKey.slice(0, topCount);
      }
    }

    return {
      month: period || (now.getUTCFullYear() + "-" + (now.getUTCMonth() + 1)),
      generatedAt: new Date(now.getTime() + 8 * 3600000).toISOString().replace("T", " ").substring(0, 19) + " (北京时间)",
      summary: { totalCost: totalCost, totalUsage: totalUsage, todayCost: todayTotalCost, avgCost: avgCost, balance: walletCnyBalance, cacheHitRate: overallCacheHitRate },
      tokenComposition: { inputMiss: inputMiss, inputHit: inputHit, output: output },
      costComposition: { costMiss: costMiss, costHit: costHit, costOut: costOut },
      todayKeys: todayKeys,
      monthKeys: monthKeys,
    };
  }

  function buildMarkdownReport(sub, data) {
    if (!data) return "暂无数据";
    const lines = [];
    lines.push("# 📊 DeepSeek 用量报告");
    lines.push(`> 订阅: ${sub.name} ｜ 数据月份: ${data.month} ｜ 生成时间: ${data.generatedAt}\n`);

    if (sub.contentOptions.summary) {
      lines.push("## 💰 费用摘要");
      var sumData = data.summary;
      lines.push("| 当日费用 | 当月费用 | 钱包余额 |");
      lines.push("|---------|---------|---------|");
      lines.push("| " + formatCnyAmount(sumData.todayCost) + " | " + formatCnyAmount(sumData.totalCost) + " | " + formatCnyAmount(sumData.balance) + " |");
      if (sub.contentOptions.modelDetail && data.costComposition) {
        var cc = data.costComposition;
        lines.push("| 未缓存费用 | 缓存命中费用 | 输出费用 |");
        lines.push("|-----------|-------------|---------|");
        lines.push("| " + formatCnyAmount(cc.costMiss) + " | " + formatCnyAmount(cc.costHit) + " | " + formatCnyAmount(cc.costOut) + " |");
      }
      lines.push("");
    }

    if (sub.contentOptions.tokenComposition || sub.contentOptions.cacheHitRate) {
      var tc = data.tokenComposition;
      var totalTokens = tc.inputMiss + tc.inputHit + tc.output;
      lines.push("## 📈 Token 构成");
      if (totalTokens > 0) {
        var missPct = (tc.inputMiss / totalTokens * 100).toFixed(1);
        var hitPct = (tc.inputHit / totalTokens * 100).toFixed(1);
        var outPct = (tc.output / totalTokens * 100).toFixed(1);
        var cr = data.summary.cacheHitRate.toFixed(1);
        lines.push("| 类型 | 数量 | 命中率 |");
        lines.push("|------|------|--------|");
        lines.push("| 输入未缓存 | " + formatInteger(tc.inputMiss) + " | — |");
        lines.push("| 缓存命中 | " + formatInteger(tc.inputHit) + " | " + hitPct + "% |");
        lines.push("| 输出 | " + formatInteger(tc.output) + " | — |");
        lines.push("| 总计 | " + formatInteger(totalTokens) + " | " + cr + "% |");
        lines.push("");
      } else {
        lines.push("- 暂无 Token 数据\n");
      }
    }

    if (sub.contentOptions.keyDetail && data.todayKeys) {
      lines.push("## 🔑 当日 Key 明细 (Top " + Math.min(data.todayKeys.length, (sub.contentOptions.topKeys || 10)) + ")");
      lines.push("| Key | 总Token | 缓存命中率 | 今日费用 |");
      lines.push("|-----|---------|------------|----------|");
      if (data.todayKeys.length) {
        for (var _ki = 0; _ki < data.todayKeys.length; _ki++) {
          var tk = data.todayKeys[_ki];
          var crStr = tk.cacheHitRate && tk.cacheHitRate > 0 ? tk.cacheHitRate.toFixed(1) + "%" : "-";
          lines.push("| " + (tk.key || "未知") + " | " + formatInteger(tk.totalTokens) + " | " + crStr + " | " + formatCnyAmount(tk.todayCost) + " |");
        }
      } else {
        lines.push("| — | — | — | — |");
      }
      lines.push("");
    }

    if (sub.contentOptions.keyDetail && data.monthKeys && data.monthKeys.length) {
      lines.push("## 🔑 Key 月度总明细 (Top " + data.monthKeys.length + ")");
      lines.push("| Key | 总Token数 | 缓存命中率 | 总费用 |");
      lines.push("|-----|-----------|------------|--------|");
      for (var _kj = 0; _kj < data.monthKeys.length; _kj++) {
        var item = data.monthKeys[_kj];
        lines.push("| " + (item.key || "未知") + " | " + formatInteger(item.totalTokens) + " | " + (item.cacheHitRate ? item.cacheHitRate.toFixed(1) + "%" : "-") + " | " + formatCnyAmount(item.totalCost) + " |");
      }
      lines.push("");
    }

    lines.push("---\n");
    lines.push("📬 *由 DeepSeek Usage Plus 自动生成*");
    return lines.join("\n");
  }

  // ========== 订阅功能：发送 ==========

  async function sendSubscriptionReport(sub, showPreview) {
    const reportData = buildSubscriptionReportData(sub);
    if (!reportData) return { success: false, error: "暂无数据，请先刷新" };

    let markdown;
    if (sub.contentFormat === "screenshot") {
      if (sub.imgbbApiKey && sub.imgbbApiKey.trim()) {
        // 截图 + ImgBB 上传
        const screenshotResult = await captureReportScreenshot(sub, reportData);
        if (screenshotResult.success) {
          const uploadResult = await uploadScreenshot(screenshotResult.imageBlob, sub.imgbbApiKey);
          if (uploadResult.success) {
            // 截图模式：只发送截图，不附带 Markdown 文本
            return sendReportText(sub, "![](" + uploadResult.url + ")");
          }
          console.error("[DeepSeek Usage Panel Plus] 截图上传失败:", uploadResult.error);
        } else {
          console.error("[DeepSeek Usage Panel Plus] 截图失败:", screenshotResult.error);
        }
      }
      // 截图失败或无 API Key → 降级到 Markdown
      markdown = buildMarkdownReport(sub, reportData);
      return sendReportText(sub, markdown);
    }

    markdown = buildMarkdownReport(sub, reportData);
    return sendReportText(sub, markdown);
  }

  function sendReportText(sub, text) {
    switch (sub.receiveMethod) {
      case "webhook":
        return sendToWebhook(sub, text);
      case "clipboard":
        return copyReportToClipboard(text);
      case "panel":
        showReportInPanel(text, null);
        return { success: true };
      default:
        return { success: false, error: "未知的接收方式" };
    }
  }

  function sendReportImage(sub, imageBlob, imageUrl) {
    switch (sub.receiveMethod) {
      case "webhook":
        return sendImageToWebhook(sub, imageBlob, imageUrl);
      case "clipboard":
        return copyImageToClipboard(imageBlob);
      case "panel":
        showReportInPanel(null, imageUrl);
        return { success: true };
      default:
        return { success: false, error: "未知的接收方式" };
    }
  }

  function sendToWebhook(sub, text) {
    return new Promise(function (resolve) {
      var url = sub.webhookUrl && sub.webhookUrl.trim();
      if (!url) { resolve({ success: false, error: "Webhook URL 未配置" }); return; }

      var payload;
      switch (sub.webhookType) {
        case "dingtalk":
          payload = { msgtype: "markdown", markdown: { title: "DeepSeek用量报告", text } };
          break;
        case "feishu":
          payload = {
            msg_type: "interactive",
            card: {
              header: { title: { tag: "plain_text", content: "DeepSeek 用量报告 - " + sub.name }, template: "blue" },
              elements: [
                { tag: "markdown", content: text },
                { tag: "hr" },
                { tag: "note", elements: [{ tag: "plain_text", content: "由 DeepSeek Usage Plus 自动生成" }] },
              ],
            },
          };
          break;
        case "wecom":
          payload = { msgtype: "markdown", markdown: { content: text } };
          break;
        default:
          payload = { msgtype: "markdown", markdown: { title: "DeepSeek 用量报告 - " + sub.name, text } };
      }

      GM.xmlHttpRequest({
        method: "POST",
        url: url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(payload),
        timeout: 15000,
        onload: function (resp) {
          try {
            var result = JSON.parse(resp.responseText);
            if (sub.webhookType === "dingtalk") {
              if (result.errcode === 0) { resolve({ success: true, verified: true }); return; }
              resolve({ success: false, error: decodeDingtalkError(result.errcode, result.errmsg), httpStatus: resp.status });
              return;
            }
            if (sub.webhookType === "feishu") {
              if (result.code === 0) { resolve({ success: true, verified: true }); return; }
              resolve({ success: false, error: "飞书错误 (code=" + result.code + "): " + (result.msg || "未知错误"), httpStatus: resp.status });
              return;
            }
            if (sub.webhookType === "wecom") {
              if (result.errcode === 0) { resolve({ success: true, verified: true }); return; }
              resolve({ success: false, error: "企业微信错误 (errcode=" + result.errcode + "): " + (result.errmsg || "未知错误"), httpStatus: resp.status });
              return;
            }
            resolve({ success: true, verified: true });
          } catch (e) {
            resolve({ success: true, verified: false, note: "已发送" });
          }
        },
        onerror: function () { console.error("[DeepSeek Usage Panel Plus] Webhook 请求失败: 网络错误"); resolve({ success: false, error: "请求失败: 网络错误" }); },
        ontimeout: function () { console.error("[DeepSeek Usage Panel Plus] Webhook 请求超时"); resolve({ success: false, error: "请求超时（15秒）" }); },
      });
    });
  }

  function decodeDingtalkError(errcode, errmsg) {
    const map = {
      "300001": "token 不存在或已过期 — 请检查 Webhook URL 中的 access_token 是否正确",
      "310000": "安全设置校验失败 — 请在钉钉机器人安全设置中添加关键词 DeepSeek",
      "50002": "发送频率超出限制 — 每分钟最多 20 条，请稍后再试",
      "45009": "API 调用次数超限 — 今日调用量已达上限",
    };
    const detail = map[String(errcode)] || ("错误码 " + errcode + ": " + (errmsg || "未知错误"));
    return "钉钉 " + detail;
  }

  async function sendImageToWebhook(sub, imageBlob, imageUrl) {
    // Webhook 不支持直接传图片，自动发送文本报告 + 本地显示截图预览
    if (sub.receiveMethod === "webhook") {
      const reportData = buildSubscriptionReportData(sub);
      const text = buildMarkdownReport(sub, reportData);
      return sendToWebhook(sub, text);
    }
    return { success: false, error: "截图模式仅支持 Webhook / 剪贴板 / 面板内预览" };
  }

  async function copyReportToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function copyImageToClipboard(blob) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function copyDataUrlToClipboard(dataUrl) {
    try {
      var resp = await fetch(dataUrl);
      var blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      return true;
    } catch (err) {
      return false;
    }
  }

  function showReportInPanel(markdown, imageUrl) {
    const existing = document.getElementById("dsapi-plus-report-preview");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "dsapi-plus-report-preview";
    overlay.className = "dsapi-plus-subscribe-overlay";
    overlay.style.cssText = "z-index: 100000; align-items: center; padding-top: 0;";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    const content = document.createElement("div");
    content.className = "dsapi-plus-subscribe-panel";
    content.style.cssText = "width: 700px; max-height: 80vh; overflow-y: auto;";

    var header = document.createElement("div");
    header.className = "dsapi-plus-subscribe-panel-header";
    header.innerHTML = '<h2>📋 报告预览</h2>';
    var headerRight = document.createElement("div");
    headerRight.style.cssText = "display:flex;align-items:center;gap:8px;";

    if (imageUrl) {
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "📋 复制图片";
      copyBtn.style.cssText = "appearance:none;border:1px solid #3b82f6;border-radius:4px;background:transparent;color:#3b82f6;cursor:pointer;font-size:12px;padding:4px 10px;";
      copyBtn.onclick = function () {
        copyDataUrlToClipboard(imageUrl).then(function (ok) {
          copyBtn.textContent = ok ? "✓ 已复制" : "✗ 失败";
          if (ok) { copyBtn.style.color = "#22c55e"; copyBtn.style.borderColor = "#22c55e"; }
          setTimeout(function () { copyBtn.textContent = "📋 复制图片"; copyBtn.style.color = "#3b82f6"; copyBtn.style.borderColor = "#3b82f6"; }, 2000);
        });
      };
      headerRight.appendChild(copyBtn);
    }
    var closeBtn = document.createElement("button");
    closeBtn.className = "dsapi-plus-subscribe-panel-close";
    closeBtn.textContent = "✕";
    closeBtn.onclick = function () { overlay.remove(); };
    headerRight.appendChild(closeBtn);
    header.appendChild(headerRight);
    content.appendChild(header);

    if (imageUrl) {
      var img = document.createElement("img");
      img.src = imageUrl;
      img.style.cssText = "width: 100%; border-radius: 8px; border: 1px solid rgba(2,14,54,0.1);";
      content.appendChild(img);
    } else if (markdown) {
      const pre = document.createElement("pre");
      pre.style.cssText = "font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--dsapi-plus-text); margin: 0;";
      pre.textContent = markdown;
      content.appendChild(pre);
    }

    overlay.appendChild(content);
    document.body.appendChild(overlay);
  }

  // ========== 订阅功能：截图 ==========

  async function captureReportScreenshot(sub, reportData) {
    const div = document.createElement("div");
    div.style.cssText = "position: absolute; left: -9999px; top: 0; width: 680px; padding: 24px; background: #fff; color: #1a1a2e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.6;";

    // 构建报告 HTML（与 Markdown 内容对应）
    let html = `<h1 style="font-size: 20px; margin: 0 0 4px;">📊 DeepSeek 用量报告</h1>`;
    html += `<p style="color: #888; font-size: 12px; margin: 0 0 16px;">订阅: ${escapeHtml(sub.name)} ｜ 数据月份: ${reportData.month} ｜ 生成时间: ${reportData.generatedAt}</p>`;

    if (sub.contentOptions.summary) {
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">💰 费用摘要</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px;">';
      html += '<tr>' + summaryCell("当日费用", formatCnyAmount(reportData.summary.todayCost)) + summaryCell("当月费用", formatCnyAmount(reportData.summary.totalCost)) + summaryCell("钱包余额", formatCnyAmount(reportData.summary.balance)) + '</tr>';
      if (sub.contentOptions.modelDetail && reportData.costComposition) {
        html += '<tr>' + summaryCell("未缓存费用", formatCnyAmount(reportData.costComposition.costMiss)) + summaryCell("缓存命中费用", formatCnyAmount(reportData.costComposition.costHit)) + summaryCell("输出费用", formatCnyAmount(reportData.costComposition.costOut)) + '</tr>';
      }
      html += '</table>';
    }

    if (sub.contentOptions.tokenComposition || sub.contentOptions.cacheHitRate) {
      var scr_total = reportData.tokenComposition.inputMiss + reportData.tokenComposition.inputHit + reportData.tokenComposition.output;
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">📈 Token 构成</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px; border: 1px solid #eee;">';
      html += '<tr style="background: #f5f5f5;"><th style="padding:6px 8px; text-align:left;">类型</th><th style="padding:6px 8px; text-align:right;">数量</th><th style="padding:6px 8px; text-align:right;">命中率</th></tr>';
      if (scr_total > 0) {
        var missPct2 = (reportData.tokenComposition.inputMiss / scr_total * 100).toFixed(1);
        var hitPct2 = (reportData.tokenComposition.inputHit / scr_total * 100).toFixed(1);
        var outPct2 = (reportData.tokenComposition.output / scr_total * 100).toFixed(1);
        html += '<tr><td style="padding:4px 8px; border-top:1px solid #eee;">输入未缓存</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(reportData.tokenComposition.inputMiss) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">—</td></tr>';
        html += '<tr><td style="padding:4px 8px; border-top:1px solid #eee;">缓存命中</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(reportData.tokenComposition.inputHit) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + hitPct2 + '%</td></tr>';
        html += '<tr><td style="padding:4px 8px; border-top:1px solid #eee;">输出</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(reportData.tokenComposition.output) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">—</td></tr>';
        html += '<tr style="font-weight:600;"><td style="padding:4px 8px; border-top:1px solid #eee;">总计</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(scr_total) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + reportData.summary.cacheHitRate.toFixed(1) + '%</td></tr>';
      }
      html += '</table>';
    }

    if (sub.contentOptions.keyDetail && reportData.todayKeys) {
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">🔑 当日 Key 明细 (Top ' + Math.min(reportData.todayKeys.length, (sub.contentOptions.topKeys || 10)) + ')</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px; border: 1px solid #eee;">';
      html += '<tr style="background: #f5f5f5;"><th style="padding:6px 8px; text-align:left;">Key</th><th style="padding:6px 8px; text-align:right;">总Token</th><th style="padding:6px 8px; text-align:right;">缓存命中率</th><th style="padding:6px 8px; text-align:right;">今日费用</th></tr>';
      if (reportData.todayKeys.length) {
        for (var _kt = 0; _kt < reportData.todayKeys.length; _kt++) {
          var tk = reportData.todayKeys[_kt];
          var crStr = tk.cacheHitRate && tk.cacheHitRate > 0 ? tk.cacheHitRate.toFixed(1) + "%" : "-";
          html += '<tr><td style="padding:4px 8px; border-top:1px solid #eee;">' + escapeHtml(tk.key) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(tk.totalTokens) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + crStr + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatCnyAmount(tk.todayCost) + '</td></tr>';
        }
      } else {
        html += '<tr><td style="padding:4px 8px; border-top:1px solid #eee; text-align:center;" colspan="4">今日暂无数据</td></tr>';
      }
      html += '</table>';
    }

    if (sub.contentOptions.keyDetail && reportData.monthKeys && reportData.monthKeys.length) {
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">🔑 Key 月度总明细 (Top ' + reportData.monthKeys.length + ')</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px; border: 1px solid #eee;">';
      html += '<tr style="background: #f5f5f5;"><th style="padding:6px 8px; text-align:left;">Key</th><th style="padding:6px 8px; text-align:right;">总Token</th><th style="padding:6px 8px; text-align:right;">缓存命中率</th><th style="padding:6px 8px; text-align:right;">总费用</th></tr>';
      for (var _km = 0; _km < reportData.monthKeys.length; _km++) {
        var mk = reportData.monthKeys[_km];
        var crStr = mk.cacheHitRate ? mk.cacheHitRate.toFixed(1) + "%" : "-";
        html += '<tr><td style="padding:4px 8px; border-top:1px solid #eee;">' + escapeHtml(mk.key) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(mk.totalTokens) + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + crStr + '</td><td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatCnyAmount(mk.totalCost) + '</td></tr>';
      }
      html += '</table>';
    }

    html += `<hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;">`;
    html += `<p style="color: #aaa; font-size: 11px;">由 DeepSeek Usage Plus 自动生成</p>`;

    div.innerHTML = html;
    document.body.appendChild(div);

    try {
      if (typeof html2canvas === "undefined") {
        // html2canvas 未加载，动态加载
        await loadHtml2Canvas();
      }
      const canvas = await html2canvas(div, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const dataUrl = canvas.toDataURL("image/png");
      return { success: true, imageBlob: blob, imageUrl: dataUrl };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      div.remove();
    }
  }

  // 上传截图到 ImgBB（在页面上下文中执行 fetch，绕过 GM 沙箱代理限制），支持自动重试 3 次
  async function uploadScreenshot(imageBlob, apiKey) {
    // Blob → base64
    var base64 = await new Promise(function (res) {
      var reader = new FileReader();
      reader.onload = function () { res(reader.result.split(",")[1]); };
      reader.readAsDataURL(imageBlob);
    });
    var maxRetries = 3;
    for (var retry = 0; retry < maxRetries; retry++) {
      if (retry > 0) await new Promise(function (r) { setTimeout(r, 2000); }); // 重试前等待 2 秒
      var callbackId = "imgbb_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
      var result = await new Promise(function (resolve) {
        window.addEventListener(callbackId, function (e) { resolve(e.detail); }, { once: true });
        var script = document.createElement("script");
        script.textContent = "(async function(){try{var r=await fetch('https://api.imgbb.com/1/upload?key=" +
          encodeURIComponent(apiKey) +
          "',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'}," +
          "body:'image=" + encodeURIComponent(base64) + "'});" +
          "var d=await r.json();" +
          "window.dispatchEvent(new CustomEvent('" + callbackId + "',{detail:{success:d.success,url:d.data?d.data.url:''}}));" +
          "}catch(e){window.dispatchEvent(new CustomEvent('" + callbackId + "',{detail:{success:false,error:e.message}}));}" +
          "})()";
        document.body.appendChild(script);
        script.remove();
      });
      if (result.success && result.url) return { success: true, url: result.url };
      if (retry < maxRetries - 1) {
        console.log("[DeepSeek Usage Panel Plus] ImgBB 上传失败，第 " + (retry + 1) + " 次重试...");
      }
    }
    return { success: false, error: "ImgBB 上传失败（已重试 " + maxRetries + " 次）" };
  }

  function loadHtml2Canvas() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("html2canvas 加载失败"));
      document.head.appendChild(script);
    });
  }

  function summaryCell(label, value) {
    return '<td style="padding: 8px 12px; border: 1px solid #eee; text-align: center; min-width: 100px;">' +
      '<div style="color: #888; font-size: 11px;">' + label + '</div>' +
      '<div style="font-size: 15px; font-weight: 600; margin-top: 4px;">' + value + '</div></td>';
  }

  function scrRow(label, val, total) {
    var pct = total > 0 ? (val / total * 100).toFixed(1) + "%" : "-";
    return '<tr><td style="padding:4px 8px; border-top:1px solid #eee;">' + label + '</td>' +
      '<td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + formatInteger(val) + '</td>' +
      '<td style="padding:4px 8px; border-top:1px solid #eee; text-align:right;">' + pct + '</td></tr>';
  }

  // ========== 订阅功能：面板 UI ==========

  function openSubscriptionPanel() {
    state.subscriptionPanelVisible = true;
    const overlay = document.createElement("div");
    overlay.className = "dsapi-plus-subscribe-overlay";
    overlay.id = "dsapi-plus-subscribe-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSubscriptionPanel();
    });

    const panel = renderSubscriptionPanel();
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    bindSubscriptionPanelEvents(panel);
  }

  function closeSubscriptionPanel() {
    if (state._countdownTimer) { clearInterval(state._countdownTimer); state._countdownTimer = 0; }
    state.subscriptionVisible = false;
    saveSubscriptionVisible();
    var panel = document.getElementById(PANEL_ID);
    if (panel) {
      var section = panel.querySelector(".dsapi-plus-subscribe-section");
      if (section) section.style.display = "none";
    }
  }

  function renderSubscriptionPanel() {
    const panel = document.createElement("div");
    panel.className = "dsapi-plus-subscribe-panel";
    panel.id = "dsapi-plus-subscribe-panel-inner";

    let html = "";

    // 订阅列表
    const subs = state.subscriptions;
    if (!subs || !subs.length) {
      html += `<div style="text-align: center; padding: 32px 16px; color: var(--dsapi-plus-muted); font-size: 13px;">暂无订阅配置，点击上方按钮创建</div>`;
    } else {
      html += `<div class="dsapi-plus-subscribe-list-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:4px 0;">
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="sub-select-all" onclick="var p=document.getElementById('${PANEL_ID}');if(p&&p._subSelectAll)p._subSelectAll();"> 全选
        </label>
        <span id="sub-select-count" style="font-size:11px;color:var(--dsapi-plus-muted);">已选 0</span>
        <button type="button" class="dsapi-plus-subscribe-batch-del-btn" onclick="var p=document.getElementById('${PANEL_ID}');if(p&&p._subBatchDelete)p._subBatchDelete();">删除选中</button>
      </div>`;
      html += `<div class="dsapi-plus-subscribe-list">`;
      for (let i = 0; i < subs.length; i++) {
        const s = subs[i];
        const statusClass = s.lastSentStatus === "success" ? "dsapi-plus-subscribe-status-success"
          : s.lastSentStatus === "error" ? "dsapi-plus-subscribe-status-error" : "";
        const statusText = s.lastSentStatus === "success" ? "✓ 发送成功"
          : s.lastSentStatus === "error" ? "✗ 发送失败"
          : s.lastSentAt ? "已配置" : "未发送";
        const lastSentText = s.lastSentAt ? new Date(s.lastSentAt).toLocaleString() : "从未";
        const scheduleText = getScheduleLabel(s);
        const methodText = getMethodLabel(s);
        const formatText = s.contentFormat === "screenshot" ? "截图" : "Markdown";

        html += `<div class="dsapi-plus-subscribe-item" data-index="${i}">
          <div class="dsapi-plus-subscribe-item-head">
            <div class="dsapi-plus-subscribe-item-name">
              <input type="checkbox" class="sub-select-check" data-index="${i}" onchange="var p=document.getElementById('${PANEL_ID}');if(p&&p._subSelectUpdate)p._subSelectUpdate();">
              <input type="checkbox" ${s.enabled ? "checked" : ""} data-action="toggle" data-index="${i}">
              <span>${escapeHtml(s.name)}</span>
              <span class="${statusClass}" style="font-size:11px;">${statusText}</span>
            </div>
            <div class="dsapi-plus-subscribe-item-actions">
              <button data-action="edit" data-index="${i}">编辑</button>
              <button data-action="preview" data-index="${i}" class="dsapi-plus-subscribe-preview-btn">预览</button>
              <button data-action="send" data-index="${i}" class="dsapi-plus-subscribe-send-btn">立即发送</button>
              <button data-action="delete" data-index="${i}" class="dsapi-plus-subscribe-del-btn">删除</button>
            </div>
          </div>
          <div class="dsapi-plus-subscribe-item-meta">
            <span>${methodText}</span>
            <span>${formatText}</span>
            <span>${scheduleText}</span>
            <span>上次发送: ${lastSentText}</span>
            <span class="sub-countdown" data-index="${i}" style="margin-left:auto;">倒计时: --</span>
          </div>
        </div>`;
      }
      html += `</div>`;
    }

    panel.innerHTML = html;
    return panel;
  }

  function getNextSendTime(sub) {
    var now = new Date();
    switch (sub.scheduleType) {
      case "interval":
        if (sub.scheduleInterval <= 0) return null;
        var last = state.subscriptionLastSent[sub.id] ? new Date(state.subscriptionLastSent[sub.id]) : null;
        if (!last) return null;
        return new Date(last.getTime() + sub.scheduleInterval);
      case "daily":
        var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sub.scheduleHour || 0, sub.scheduleMinute || 0, 0);
        // 如果今天已过去发送时间且尚未成功发送，返回 now（显示待发送）
        if (next <= now) {
          var last = state.subscriptionLastSent[sub.id] ? new Date(state.subscriptionLastSent[sub.id]) : null;
          if (!last || last.toDateString() !== now.toDateString()) return now;
          next.setDate(next.getDate() + 1);
        }
        return next;
      case "weekly": {
        var day = sub.scheduleDayOfWeek || 0;
        var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sub.scheduleHour || 0, sub.scheduleMinute || 0, 0);
        // 如果本周已过去发送时间且尚未成功发送，返回 now
        while (next.getDay() !== day || next <= now) {
          if (next <= now) {
            var last = state.subscriptionLastSent[sub.id] ? new Date(state.subscriptionLastSent[sub.id]) : null;
            if (!last || last.toDateString() !== now.toDateString()) return now;
          }
          next.setDate(next.getDate() + 1);
        }
        return next;
      }
      case "monthly": {
        var dom = sub.scheduleDayOfMonth || 1;
        var next = new Date(now.getFullYear(), now.getMonth(), dom, sub.scheduleHour || 0, sub.scheduleMinute || 0, 0);
        if (next <= now) next.setMonth(next.getMonth() + 1);
        return next;
      }
      default: return null;
    }
  }

  function updateSubscriptionCountdowns() {
    var els = document.querySelectorAll(".sub-countdown");
    if (!els.length) return;
    var now = new Date();
    for (var ci = 0; ci < els.length; ci++) {
      var el = els[ci];
      var idx = parseInt(el.dataset.index, 10);
      var sub = state.subscriptions[idx];
      if (!sub || !sub.enabled) { el.textContent = "未启用"; continue; }
      var next = getNextSendTime(sub);
      if (!next) { el.textContent = "倒计时: --"; continue; }
      var diff = next.getTime() - now.getTime();
      var diff = next.getTime() - now.getTime();
      var diff = next.getTime() - now.getTime();
      // 待发送（计划时间已过或即将到来且尚未成功发送）
      if (diff < 3000) { el.textContent = "待发送"; continue; }
      var sec = Math.floor(diff / 1000);
      var min = Math.floor(sec / 60);
      var hr = Math.floor(min / 60);
      sec = sec % 60;
      min = min % 60;
      if (hr > 0) { el.textContent = "倒计时: " + hr + "时" + min + "分" + sec + "秒"; }
      else if (min > 0) { el.textContent = "倒计时: " + min + "分" + sec + "秒"; }
      else { el.textContent = "倒计时: " + sec + "秒"; }
    }
  }

  function getScheduleLabel(sub) {
    switch (sub.scheduleType) {
      case "interval":
        const min = Math.round(sub.scheduleInterval / 60000);
        return `每 ${min} 分钟`;
      case "daily":
        return `每天 ${String(sub.scheduleHour).padStart(2,"0")}:${String(sub.scheduleMinute).padStart(2,"0")}`;
      case "weekly":
        const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        return `每周${days[sub.scheduleDayOfWeek]} ${String(sub.scheduleHour).padStart(2,"0")}:${String(sub.scheduleMinute).padStart(2,"0")}`;
      case "monthly":
        return `每月${sub.scheduleDayOfMonth}日 ${String(sub.scheduleHour).padStart(2,"0")}:${String(sub.scheduleMinute).padStart(2,"0")}`;
      default:
        return "未配置";
    }
  }

  function getMethodLabel(sub) {
    const methodMap = { webhook: "Webhook", clipboard: "剪贴板", panel: "面板预览" };
    const typeMap = { dingtalk: "钉钉", feishu: "飞书", wecom: "企业微信" };
    const method = methodMap[sub.receiveMethod] || sub.receiveMethod;
    const type = sub.receiveMethod === "webhook" ? (typeMap[sub.webhookType] || sub.webhookType) : "";
    return type ? `${method} (${type})` : method;
  }

  // ========== 订阅功能：编辑表单 ==========

  function renderSubscriptionForm(sub, index) {
    const isNew = index === undefined || index === null;
    const s = sub || getDefaultSubscription();

    let html = `<div class="dsapi-plus-subscribe-form" data-form-index="${index !== undefined ? index : ""}">`;

    // 名称
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">名称</div>
      <div class="dsapi-plus-subscribe-form-control">
        <input type="text" id="sub-form-name" value="${escapeHtml(s.name)}" placeholder="订阅名称">
      </div>
    </div>`;

    // 接收方式
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">接收方式</div>
      <div class="dsapi-plus-subscribe-form-control">
        <select id="sub-form-method">
          <option value="webhook" ${s.receiveMethod === "webhook" ? "selected" : ""}>Webhook 推送</option>
          <option value="clipboard" ${s.receiveMethod === "clipboard" ? "selected" : ""}>复制到剪贴板</option>
          <option value="panel" ${s.receiveMethod === "panel" ? "selected" : ""}>面板内预览</option>
        </select>
      </div>
    </div>`;

    // Webhook 配置（仅在 webhook 模式下显示）
    const webhookDisplay = s.receiveMethod === "webhook" ? "" : "display:none;";
    html += `<div id="sub-form-webhook-group" style="${webhookDisplay}">
      <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label">平台</div>
        <div class="dsapi-plus-subscribe-form-control">
          <select id="sub-form-webhook-type">
            <option value="dingtalk" ${s.webhookType === "dingtalk" ? "selected" : ""}>钉钉</option>
            <option value="feishu" ${s.webhookType === "feishu" ? "selected" : ""}>飞书</option>
            <option value="wecom" ${s.webhookType === "wecom" ? "selected" : ""}>企业微信</option>
          </select>
        </div>
      </div>
      <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label">Webhook URL</div>
        <div class="dsapi-plus-subscribe-form-control">
          <input type="url" id="sub-form-webhook-url" value="${escapeHtml(s.webhookUrl || "")}" placeholder="https://oapi.dingtalk.com/robot/send?access_token=...">
        </div>
      </div>
      <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label">签名密钥</div>
        <div class="dsapi-plus-subscribe-form-control">
          <input type="text" id="sub-form-webhook-secret" value="${escapeHtml(s.webhookSecret || "")}" placeholder="可选，飞书安全设置需要">
        </div>
      </div>
    </div>`;

    // 内容格式
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">内容格式</div>
      <div class="dsapi-plus-subscribe-form-control">
        <select id="sub-form-format">
          <option value="markdown" ${s.contentFormat === "markdown" ? "selected" : ""}>Markdown 文本</option>
          <option value="screenshot" ${s.contentFormat === "screenshot" ? "selected" : ""}>截图</option>
        </select>
      </div>
    </div>`;

    // ImgBB API Key（截图模式需要）
    const imgbbDisplay = s.contentFormat === "screenshot" ? "" : "display:none;";
    html += `<div id="sub-form-imgbb-group" style="${imgbbDisplay}">
      <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label">ImgBB Key</div>
        <div class="dsapi-plus-subscribe-form-control">
          <input type="text" id="sub-form-imgbb-key" value="${escapeHtml(s.imgbbApiKey || '')}" placeholder="在 imgbb.com 注册获取 API Key" style="width:100%;">
          <div style="font-size:10px;color:var(--dsapi-plus-muted);margin-top:2px;">截图模式需要配置 ImgBB API Key，否则自动降级为 Markdown 文本</div>
        </div>
      </div>
    </div>`;

    // Key 筛选
    const keyNames = getAvailableKeyNames();
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">Key 筛选</div>
      <div class="dsapi-plus-subscribe-form-control">
        <select id="sub-form-key-mode">
          <option value="all" ${s.keyFilterMode === "all" ? "selected" : ""}>全部 Key</option>
          <option value="selected" ${s.keyFilterMode === "selected" ? "selected" : ""}>选择特定 Key</option>
        </select>
      </div>
    </div>`;

    const keyDisplay = s.keyFilterMode === "selected" ? "" : "display:none;";
    html += `<div id="sub-form-key-select-group" style="${keyDisplay}">
      <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label">选择 Key</div>
        <div class="dsapi-plus-subscribe-form-control">
          <div class="dsapi-plus-subscribe-checkbox-group" id="sub-form-keys">`;
    if (keyNames.length) {
      for (const kn of keyNames) {
        const checked = s.selectedKeys && s.selectedKeys.includes(kn) ? "checked" : "";
        html += `<label><input type="checkbox" value="${escapeHtml(kn)}" ${checked}> ${escapeHtml(kn)}</label>`;
      }
    } else {
      html += `<span style="color: var(--dsapi-plus-muted);">暂无 Key 数据，请先刷新导入 Key 明细</span>`;
    }
    html += `</div></div></div></div>`;

    // 发送频率
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">发送频率</div>
      <div class="dsapi-plus-subscribe-form-control">
        <div class="dsapi-plus-subscribe-schedule-row" id="sub-form-schedule">`;

    if (s.scheduleType === "interval") {
      html += `<select id="sub-form-stype">
        <option value="interval" selected>间隔</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option>
      </select>
      <input type="number" id="sub-form-interval-val" value="${Math.round(s.scheduleInterval / 60000)}" min="1" style="width:60px;"> 分钟`;
    } else {
      const st = s.scheduleType;
      html += `<select id="sub-form-stype">
        <option value="interval">间隔</option>
        <option value="daily" ${st === "daily" ? "selected" : ""}>每天</option>
        <option value="weekly" ${st === "weekly" ? "selected" : ""}>每周</option>
        <option value="monthly" ${st === "monthly" ? "selected" : ""}>每月</option>
      </select>`;
      if (st === "weekly") {
        html += `<select id="sub-form-weekday">
          ${["周日","周一","周二","周三","周四","周五","周六"].map((d,i) => `<option value="${i}" ${s.scheduleDayOfWeek === i ? "selected" : ""}>${d}</option>`).join("")}
        </select>`;
      }
      if (st === "monthly") {
        html += `<input type="number" id="sub-form-monthday" value="${s.scheduleDayOfMonth}" min="1" max="31" style="width:50px;"> 日`;
      }
      html += ` <input type="number" id="sub-form-hour" value="${s.scheduleHour}" min="0" max="23" style="width:50px;"> 时
        <input type="number" id="sub-form-minute" value="${s.scheduleMinute}" min="0" max="59" style="width:50px;"> 分`;
    }
    html += `</div></div></div>`;

    // 内容定制
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">内容定制</div>
      <div class="dsapi-plus-subscribe-form-control">
        <div class="dsapi-plus-subscribe-checkbox-group">`;
    const contentChecks = [
      ["summary", "费用摘要"],
      ["tokenComposition", "Token 构成"],
      ["cacheHitRate", "缓存命中率"],
      ["modelDetail", "费用明细"],
      ["keyDetail", "Key 明细"],
    ];
    for (const [k, label] of contentChecks) {
      const checked = s.contentOptions[k] ? "checked" : "";
      html += `<label><input type="checkbox" data-content-opt="${k}" ${checked}> ${label}</label>`;
    }
    html += `</div>
        <div style="margin-top: 6px; display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 11px; color: var(--dsapi-plus-muted);">Top Key 数量:</span>
          <select id="sub-form-top-keys" style="border:1px solid rgba(2,14,54,0.15);border-radius:4px;padding:2px 4px;font-size:12px;">
            ${[5, 10, 20, 50].map(n => `<option value="${n}" ${(s.contentOptions.topKeys || 10) === n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>`;

    // 按钮区
    html += `<div class="dsapi-plus-subscribe-form-actions">
      <button type="button" class="dsapi-plus-subscribe-save-btn" data-action="save">💾 保存</button>
      <button type="button" class="dsapi-plus-subscribe-cancel-btn" data-action="cancel">取消</button>
    </div>`;

    html += `</div>`;
    return html;
  }

  function getAvailableKeyNames() {
    const data = state.keyDetailData;
    if (!data || !data.length) return [];
    return data.map(item => item.key || item.api_key || item.apiKey).filter(Boolean);
  }

  // ========== 订阅功能：面板事件绑定 ==========

  function bindSubscriptionPanelEvents(panel) {
    // 多选删除功能
    var mainP = document.getElementById(PANEL_ID);
    if (mainP) {
      mainP._subSelectAll = function() {
        var checked = document.getElementById("sub-select-all")?.checked;
        document.querySelectorAll(".sub-select-check").forEach(function(cb) { cb.checked = !!checked; });
        var cnt = document.querySelectorAll(".sub-select-check:checked").length;
        var countEl = document.getElementById("sub-select-count");
        if (countEl) countEl.textContent = "已选 " + cnt;
      };
      mainP._subSelectUpdate = function() {
        var cnt = document.querySelectorAll(".sub-select-check:checked").length;
        var countEl = document.getElementById("sub-select-count");
        if (countEl) countEl.textContent = "已选 " + cnt;
      };
      mainP._subBatchDelete = function() {
        var checked = document.querySelectorAll(".sub-select-check:checked");
        if (!checked.length) { alert("请先选择要删除的订阅"); return; }
        var names = [];
        var indices = [];
        checked.forEach(function(cb) {
          var idx = parseInt(cb.dataset.index, 10);
          if (!isNaN(idx) && state.subscriptions[idx]) {
            names.push(state.subscriptions[idx].name);
            indices.push(idx);
          }
        });
        if (!indices.length) return;
        if (!confirm("确定删除选中的 " + indices.length + " 个订阅？\n" + names.join(", "))) return;
        indices.sort(function(a, b) { return b - a; }).forEach(function(idx) {
          state.subscriptions.splice(idx, 1);
        });
        saveSubscriptions();
        updateSubscribeBtnState();
        refreshSubscribeInlineContent();
      };
    }

    // 关闭
    panel.querySelector("[data-action='close']")?.addEventListener("click", closeSubscriptionPanel);

    // 新建
    panel.querySelector("[data-action='create']")?.addEventListener("click", () => {
      // 隐藏列表，显示表单
      const list = panel.querySelector(".dsapi-plus-subscribe-list");
      const createBtn = panel.querySelector("[data-action='create']");
      const existingForm = panel.querySelector(".dsapi-plus-subscribe-form");
      if (existingForm) { existingForm.remove(); return; }
      if (list) list.style.display = "none";
      if (createBtn) createBtn.style.display = "none";
      const noData = panel.querySelector("div[style*='text-align: center']");
      if (noData) noData.style.display = "none";

      showStaticForm(null);
    });

    // 编辑
    panel.querySelectorAll("[data-action='edit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const sub = state.subscriptions[idx];
        if (!sub) return;
        showStaticForm(idx);
      });
    });

    // 删除
    panel.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const sub = state.subscriptions[idx];
        if (!sub) return;
        if (!confirm(`确定删除订阅「${sub.name}」？`)) return;
        state.subscriptions.splice(idx, 1);
        saveSubscriptions();
        updateSubscribeBtnState();
        refreshSubscribeInlineContent();
        updateSubscribeBtnState();
      });
    });

    // 预览
    panel.querySelectorAll("[data-action='preview']").forEach(function (previewBtn) {
      previewBtn.addEventListener("click", function () {
        var idx = parseInt(previewBtn.dataset.index, 10);
        var sub = state.subscriptions[idx];
        if (!sub) return;
        var reportData = buildSubscriptionReportData(sub);
        if (!reportData) { alert("暂无数据，请先刷新"); return; }
        previewBtn.disabled = true;
        previewBtn.textContent = "生成中…";
        // 预览总是用截图展示
        if (sub.contentFormat === "screenshot") {
          captureReportScreenshot(sub, reportData).then(function (sr) {
            previewBtn.disabled = false;
            previewBtn.textContent = "预览";
            if (sr.success) {
              showReportInPanel(null, sr.imageUrl);
            } else {
              showReportInPanel(buildMarkdownReport(sub, reportData), null);
            }
          });
        } else {
          showReportInPanel(buildMarkdownReport(sub, reportData), null);
          previewBtn.disabled = false;
          previewBtn.textContent = "预览";
        }
      });
    });

    // 立即发送
    panel.querySelectorAll("[data-action='send']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.index, 10);
        const sub = state.subscriptions[idx];
        if (!sub) return;
        btn.disabled = true;
        btn.textContent = "发送中…";
        const result = await sendSubscriptionReport(sub);
        // 更新状态
        sub.lastSentAt = new Date().toISOString();
        sub.lastSentStatus = result.success ? "success" : "error";
        state.subscriptionLastSent[sub.id] = sub.lastSentAt;
        saveSubscriptions();
        saveSubscriptionLastSent();
        // 更新按钮状态
        btn.textContent = result.success ? (result.note ? "已发送" : "✓ 已送达") : "✗ 发送失败";
        if (!result.success) {
          const errOverlay = document.createElement("div");
          errOverlay.className = "dsapi-plus-subscribe-overlay";
          errOverlay.style.cssText = "z-index: 100001; align-items: center; padding-top: 0;";
          const errPanel = document.createElement("div");
          errPanel.className = "dsapi-plus-subscribe-panel";
          errPanel.style.cssText = "width: 520px; max-height: 85vh; overflow-y: auto;";
          let diagHtml = '<div class="dsapi-plus-subscribe-panel-header"><h2>🔴 发送失败 — 诊断信息</h2><button class="dsapi-plus-subscribe-panel-close" onclick="this.closest(\'.dsapi-plus-subscribe-overlay\').remove()">✕</button></div>';
          diagHtml += '<div style="margin-bottom:16px; padding:12px; background:rgba(231,76,60,0.06); border-radius:8px; border-left:3px solid #e74c3c;">';
          diagHtml += '<div style="font-size:13px; line-height:1.7; word-break:break-all;">';
          diagHtml += '<p style="margin:0 0 6px;"><strong>错误信息：</strong>' + escapeHtml(result.error || "未知错误") + '</p>';
          if (result.httpStatus) {
            diagHtml += '<p style="margin:0 0 6px;"><strong>HTTP 状态码：</strong>' + result.httpStatus + '</p>';
          }
          diagHtml += '</div></div>';
          diagHtml += '<div style="font-size:12px; color:var(--dsapi-plus-muted); line-height:1.8; margin-bottom:8px;">';
          diagHtml += '<p style="margin:0 0 6px;"><strong>📋 自助排查：</strong></p>';
          diagHtml += '<ol style="margin:0; padding-left:18px;">';
          diagHtml += '<li>检查 Webhook URL 是否正确（完整的 https://oapi.dingtalk.com/robot/send?access_token=...）</li>';
          diagHtml += '<li>钉钉机器人安全设置：需选择<strong>自定义关键词</strong>，填入 <code>DeepSeek</code></li>';
          diagHtml += '<li>如果选择<strong>加签</strong>方式，需在订阅配置中填写密钥（当前暂未实现签名）</li>';
          diagHtml += '<li>确认钉钉群未解散、机器人未被移除</li>';
          diagHtml += '<li>如果不是 HTTPS 链接，浏览器可能拦截请求</li>';
          diagHtml += '</ol></div>';
          diagHtml += '<div style="font-size:12px;"><strong>配置的 Webhook：</strong><br><code style="word-break:break-all; background:rgba(2,14,54,0.04); padding:4px 8px; border-radius:4px; display:block; margin-top:4px;">';
          diagHtml += escapeHtml((sub.webhookUrl || "").replace(/access_token=[^&]+/, "access_token=***")) + '</code></div>';
          errPanel.innerHTML = diagHtml;
          errOverlay.appendChild(errPanel);
          document.body.appendChild(errOverlay);
          errOverlay.addEventListener("click", (e) => { if (e.target === errOverlay) errOverlay.remove(); });
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = "立即发送"; }, 2000);
      });
    });

    // 启用/禁用复选框
    panel.querySelectorAll("[data-action='toggle']").forEach(cb => {
      cb.addEventListener("change", () => {
        const idx = parseInt(cb.dataset.index, 10);
        if (state.subscriptions[idx]) {
          state.subscriptions[idx].enabled = cb.checked;
          saveSubscriptions();
          updateSubscribeBtnState();
        }
      });
    });
    // 倒计时更新
    if (state._countdownTimer) clearInterval(state._countdownTimer);
    state._countdownTimer = setInterval(updateSubscriptionCountdowns, 1000);
    updateSubscriptionCountdowns();
  }

  function bindFormEvents(formEl, editIndex) {
    if (editIndex !== undefined && editIndex !== null) formEl._editIndex = editIndex;
    var mainP = document.getElementById(PANEL_ID);
    if (!mainP) return;
    // 将保存/取消函数挂到主面板上，供 inline onclick 直接调用（绕过 addEventListener 隔离问题）
    mainP._subSave = function(btn) {
      var formEl = btn.closest('.dsapi-plus-subscribe-form');
      if (!formEl) return;
      const formData = collectFormData(formEl);
      if (!formData.name.trim()) { alert("请输入订阅名称"); return; }
      if (formData.receiveMethod === "webhook" && !formData.webhookUrl.trim()) { alert("请输入 Webhook URL"); return; }
      const eidx = formEl._editIndex;
      if (eidx !== null && eidx !== undefined && state.subscriptions[eidx]) {
        Object.assign(state.subscriptions[eidx], formData);
        state.subscriptions[eidx].lastSentAt = null;
        state.subscriptions[eidx].lastSentStatus = null;
        delete state.subscriptionLastSent[state.subscriptions[eidx].id];
        saveSubscriptionLastSent();
      } else {
        formData.id = createSubscriptionId();
        formData.createdAt = new Date().toISOString();
        state.subscriptions.push(formData);
      }
      saveSubscriptions();
      updateSubscribeBtnState();
      checkSubscriptionSchedule();
      refreshSubscribeInlineContent();
    };
    mainP._subCancel = function() {
      refreshSubscribeInlineContent();
    };
    // 频率类型切换处理
    mainP._subStypeChange = function(sel) {
      var formEl = sel.closest('.dsapi-plus-subscribe-form');
      if (!formEl) return;
      var scheduleRow = formEl.querySelector("#sub-form-schedule");
      if (!scheduleRow) return;
      var st = sel.value;
      // 保留当前值
      var currentHour = parseInt(formEl.querySelector("#sub-form-hour")?.value ?? formEl.dataset.savedHour ?? 9, 10);
      var currentMinute = parseInt(formEl.querySelector("#sub-form-minute")?.value ?? formEl.dataset.savedMinute ?? 0, 10);
      var currentInterval = parseInt(formEl.querySelector("#sub-form-interval-val")?.value ?? formEl.dataset.savedInterval ?? 60, 10);
      var currentWeekday = parseInt(formEl.querySelector("#sub-form-weekday")?.value ?? formEl.dataset.savedWeekday ?? 1, 10);
      var currentMonthday = parseInt(formEl.querySelector("#sub-form-monthday")?.value ?? formEl.dataset.savedMonthday ?? 1, 10);
      Object.assign(formEl.dataset, { savedHour: currentHour, savedMinute: currentMinute, savedInterval: currentInterval, savedWeekday: currentWeekday, savedMonthday: currentMonthday });
      var panelId = '${PANEL_ID}';
      var schedHtml = "";
      if (st === "interval") {
        schedHtml = `<select id="sub-form-stype" onchange="var p=document.getElementById('${PANEL_ID}');if(p&&p._subStypeChange)p._subStypeChange(this);"><option value="interval" selected>间隔</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select>
          <input type="number" id="sub-form-interval-val" value="${currentInterval}" min="1" style="width:60px;"> 分钟`;
      } else {
        schedHtml = `<select id="sub-form-stype" onchange="var p=document.getElementById('${PANEL_ID}');if(p&&p._subStypeChange)p._subStypeChange(this);"><option value="interval">间隔</option><option value="daily" ${st==="daily"?"selected":""}>每天</option><option value="weekly" ${st==="weekly"?"selected":""}>每周</option><option value="monthly" ${st==="monthly"?"selected":""}>每月</option></select>`;
        if (st === "weekly") {
          schedHtml += `<select id="sub-form-weekday">${["周日","周一","周二","周三","周四","周五","周六"].map((d,i)=>"<option value=\""+i+"\""+(currentWeekday===i?" selected":"")+">"+d+"</option>").join("")}</select>`;
        }
        if (st === "monthly") {
          schedHtml += `<input type="number" id="sub-form-monthday" value="${currentMonthday}" min="1" max="31" style="width:50px;"> 日`;
        }
        schedHtml += ` <input type="number" id="sub-form-hour" value="${currentHour}" min="0" max="23" style="width:50px;"> 时
          <input type="number" id="sub-form-minute" value="${currentMinute}" min="0" max="59" style="width:50px;"> 分`;
      }
      scheduleRow.innerHTML = schedHtml;
    };
  }

  function collectFormData(formEl) {
    const getName = (id) => formEl.querySelector(id)?.value || "";
    const getChecked = (id) => Array.from(formEl.querySelectorAll(id + ":checked")).map(el => el.value);
    const getBool = (id) => formEl.querySelector(id)?.checked || false;

    const stype = getName("#sub-form-stype");
    const contentOpts = {};
    formEl.querySelectorAll("[data-content-opt]").forEach(cb => {
      contentOpts[cb.dataset.contentOpt] = cb.checked;
    });

    const data = {
      name: getName("#sub-form-name"),
      receiveMethod: getName("#sub-form-method"),
      webhookType: getName("#sub-form-webhook-type"),
      webhookUrl: getName("#sub-form-webhook-url"),
      webhookSecret: getName("#sub-form-webhook-secret"),
      contentFormat: getName("#sub-form-format"),
      imgbbApiKey: getName("#sub-form-imgbb-key"),
      keyFilterMode: getName("#sub-form-key-mode"),
      selectedKeys: getChecked("#sub-form-keys input[type='checkbox']"),
      scheduleType: stype,
      scheduleInterval: stype === "interval" ? (parseInt(getName("#sub-form-interval-val"), 10) || 60) * 60000 : 3600000,
      scheduleHour: stype !== "interval" ? (parseInt(getName("#sub-form-hour"), 10) || 9) : 9,
      scheduleMinute: stype !== "interval" ? (parseInt(getName("#sub-form-minute"), 10) || 0) : 0,
      scheduleDayOfWeek: stype === "weekly" ? (parseInt(getName("#sub-form-weekday"), 10) || 1) : 1,
      scheduleDayOfMonth: stype === "monthly" ? (parseInt(getName("#sub-form-monthday"), 10) || 1) : 1,
      contentOptions: {
        summary: contentOpts.summary !== false,
        tokenComposition: contentOpts.tokenComposition !== false,
        cacheHitRate: contentOpts.cacheHitRate !== false,
        modelDetail: !!contentOpts.modelDetail,
        keyDetail: contentOpts.keyDetail !== false,
        topKeys: Math.max(1, parseInt(getName("#sub-form-top-keys"), 10) || 10),
      },
      lastSentAt: null,
      lastSentStatus: null,
    };
    return data;
  }

  /** 在主面板上注册事件代理，处理此表单的所有交互（解决移动端动态元素事件不触发） */
  function showStaticForm(editIndex) {
    var formContainer = document.getElementById("dsapi-plus-subscribe-form-static");
    if (!formContainer) return;
    var sub = (editIndex !== null && editIndex !== undefined) ? state.subscriptions[editIndex] : null;
    formContainer.innerHTML = renderSubscriptionForm(sub, editIndex);
    formContainer.style.display = "block";
    // 隐藏订阅列表
    var list = document.querySelector(".dsapi-plus-subscribe-list");
    if (list) list.style.display = "none";
    var noData = document.querySelector(".dsapi-plus-subscribe-inline-content div[style*='text-align: center']");
    if (noData) noData.style.display = "none";
    // 隐藏订阅列表
    var panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel._currentFormIndex = editIndex !== undefined ? editIndex : null;
    }
    // 绑定表单内交互事件（保存/取消/下拉切换等）
    bindStaticFormEvents(formContainer);
  }

  function bindStaticFormEvents(formEl) {
    // 保存
    var saveBtn = formEl.querySelector("[data-action='save']");
    if (saveBtn) {
      saveBtn.addEventListener("click", function() {
        var formData = collectFormData(formEl);
        if (!formData.name.trim()) { alert("请输入订阅名称"); return; }
        if (formData.receiveMethod === "webhook" && !formData.webhookUrl.trim()) { alert("请输入 Webhook URL"); return; }
        var panel = document.getElementById(PANEL_ID);
        var eidx = panel ? panel._currentFormIndex : null;
        if (eidx !== null && eidx !== undefined && state.subscriptions[eidx]) {
          Object.assign(state.subscriptions[eidx], formData);
          state.subscriptions[eidx].lastSentAt = null;
          state.subscriptions[eidx].lastSentStatus = null;
          delete state.subscriptionLastSent[state.subscriptions[eidx].id];
          saveSubscriptionLastSent();
        } else {
          formData.id = createSubscriptionId();
          formData.createdAt = new Date().toISOString();
          state.subscriptions.push(formData);
        }
        saveSubscriptions();
        updateSubscribeBtnState();
        checkSubscriptionSchedule();
        hideStaticForm();
      });
    }
    // 取消
    var cancelBtn = formEl.querySelector("[data-action='cancel']");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function() {
        hideStaticForm();
      });
    }
    // 格式切换
    var formatSelect = formEl.querySelector("#sub-form-format");
    if (formatSelect) {
      formatSelect.addEventListener("change", function() {
        var imgbbGroup = formEl.querySelector("#sub-form-imgbb-group");
        if (imgbbGroup) imgbbGroup.style.display = formatSelect.value === "screenshot" ? "" : "none";
      });
    }
    // Key 筛选模式切换
    var keyModeSelect = formEl.querySelector("#sub-form-key-mode");
    if (keyModeSelect) {
      keyModeSelect.addEventListener("change", function() {
        var keySelectGroup = formEl.querySelector("#sub-form-key-select-group");
        if (keySelectGroup) keySelectGroup.style.display = keyModeSelect.value === "selected" ? "" : "none";
      });
    }
    // 接收方式切换
    var methodSelect = formEl.querySelector("#sub-form-method");
    if (methodSelect) {
      methodSelect.addEventListener("change", function() {
        var webhookGroup = formEl.querySelector("#sub-form-webhook-group");
        if (webhookGroup) webhookGroup.style.display = methodSelect.value === "webhook" ? "" : "none";
      });
    }
    // 频率类型切换
    var stypeSelect = formEl.querySelector("#sub-form-stype");
    if (stypeSelect) {
      stypeSelect.addEventListener("change", function handleStypeChange() {
        var scheduleRow = formEl.querySelector("#sub-form-schedule");
        if (!scheduleRow) return;
        var st = stypeSelect.value;
        var currentHour = parseInt(formEl.querySelector("#sub-form-hour")?.value ?? formEl.dataset.savedHour ?? 9, 10);
        var currentMinute = parseInt(formEl.querySelector("#sub-form-minute")?.value ?? formEl.dataset.savedMinute ?? 0, 10);
        var currentInterval = parseInt(formEl.querySelector("#sub-form-interval-val")?.value ?? formEl.dataset.savedInterval ?? 60, 10);
        var currentWeekday = parseInt(formEl.querySelector("#sub-form-weekday")?.value ?? formEl.dataset.savedWeekday ?? 1, 10);
        var currentMonthday = parseInt(formEl.querySelector("#sub-form-monthday")?.value ?? formEl.dataset.savedMonthday ?? 1, 10);
        Object.assign(formEl.dataset, { savedHour: currentHour, savedMinute: currentMinute, savedInterval: currentInterval, savedWeekday: currentWeekday, savedMonthday: currentMonthday });
        var schedHtml = "";
        if (st === "interval") {
          schedHtml = `<select id="sub-form-stype"><option value="interval" selected>间隔</option><option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option></select>
            <input type="number" id="sub-form-interval-val" value="${currentInterval}" min="1" style="width:60px;"> 分钟`;
        } else {
          schedHtml = `<select id="sub-form-stype"><option value="interval">间隔</option><option value="daily" ${st==="daily"?"selected":""}>每天</option><option value="weekly" ${st==="weekly"?"selected":""}>每周</option><option value="monthly" ${st==="monthly"?"selected":""}>每月</option></select>`;
          if (st === "weekly") {
            schedHtml += `<select id="sub-form-weekday">${["周日","周一","周二","周三","周四","周五","周六"].map((d,i)=>`<option value="${i}" ${currentWeekday===i?"selected":""}>${d}</option>`).join("")}</select>`;
          }
          if (st === "monthly") {
            schedHtml += `<input type="number" id="sub-form-monthday" value="${currentMonthday}" min="1" max="31" style="width:50px;"> 日`;
          }
          schedHtml += ` <input type="number" id="sub-form-hour" value="${currentHour}" min="0" max="23" style="width:50px;"> 时
            <input type="number" id="sub-form-minute" value="${currentMinute}" min="0" max="59" style="width:50px;"> 分`;
        }
        scheduleRow.innerHTML = schedHtml;
        // 重新绑定切换事件
        var newStype = scheduleRow.querySelector("#sub-form-stype");
        if (newStype) newStype.addEventListener("change", handleStypeChange);
      });
    }
  }

  function hideStaticForm() {
    var formContainer = document.getElementById("dsapi-plus-subscribe-form-static");
    if (formContainer) formContainer.style.display = "none";
    // 恢复列表显示：刷新内联内容
    refreshSubscribeInlineContent();
  }

  function updateSubscribeBtnState() {
    var btn = document.querySelector(".dsapi-plus-subscribe-btn");
    if (btn) {
      var active = state.subscriptions && state.subscriptions.some(function(s) { return s.enabled !== false; });
      btn.classList.toggle("active", !!active);
    }
  }

  function refreshSubscribeInlineContent() {
    try {
      var content = document.querySelector(".dsapi-plus-subscribe-inline-content");
      if (!content) return;
      var newPanel = renderSubscriptionPanel();
      content.innerHTML = "";
      content.appendChild(newPanel);
      bindSubscriptionPanelEvents(newPanel);
    } catch (e) {
      console.error("[DeepSeek Usage Panel Plus] 刷新订阅面板错误:", e);
    }
  }

  // ========== 订阅功能：定时检查 ==========

  function startSubscriptionCheckTimer() {
    stopSubscriptionCheckTimer();
    // 延迟 500ms 后首次检查，确保页面已就绪
    setTimeout(function () { checkSubscriptionSchedule(); }, 500);
    // 使用递归 setTimeout 替代 setInterval，避免某次执行异常导致后续检查停止
    function scheduleNext() {
      state.subscriptionCheckTimer = setTimeout(function () {
        try { checkSubscriptionSchedule(); } catch (e) { console.error("[DeepSeek Usage Panel Plus] 订阅检查异常:", e); }
        scheduleNext();
      }, 30000);
    }
    scheduleNext();
  }

  function stopSubscriptionCheckTimer() {
    if (state.subscriptionCheckTimer) {
      clearTimeout(state.subscriptionCheckTimer);
      state.subscriptionCheckTimer = 0;
    }
  }

  async function checkSubscriptionSchedule() {
    const now = new Date();
    for (const sub of state.subscriptions) {
      if (!sub.enabled) continue;
      const lastSent = state.subscriptionLastSent[sub.id] ? new Date(state.subscriptionLastSent[sub.id]) : null;
      if (shouldSendNow(sub, now, lastSent)) {
        console.log("[DeepSeek Usage Panel Plus] 订阅检查触发:", sub.name, "时间:", now.toLocaleTimeString());
        // 发送前先刷新 Key 明细数据
        try {
          await fetchKeyDetailFromExport(getSelectedPeriod(), new AbortController().signal);
        } catch (e) { /* 刷新失败不影响发送，使用已有数据 */ }
        sendSubscriptionReport(sub).then(result => {
          if (result.success) {
            sub.lastSentAt = new Date().toISOString();
            sub.lastSentStatus = "success";
            state.subscriptionLastSent[sub.id] = sub.lastSentAt;
          } else {
            console.error("[DeepSeek Usage Panel Plus] 订阅发送失败:", sub.name, result.error);
          }
          saveSubscriptions();
          saveSubscriptionLastSent();
        }).catch(function (err) {
          console.error("[DeepSeek Usage Panel Plus] 订阅发送异常:", sub.name, err);
          // 发送异常时不记录 lastSent，允许下次重试
        });
      }
    }
  }

  function shouldSendNow(sub, now, lastSent) {
    var subMinHour = sub.scheduleHour * 60 + sub.scheduleMinute;
    var nowMinHour = now.getHours() * 60 + now.getMinutes();

    switch (sub.scheduleType) {
      case "interval":
        if (!lastSent) return true;
        return (now.getTime() - lastSent.getTime()) >= sub.scheduleInterval;
      case "daily":
        if (lastSent && lastSent.toDateString() === now.toDateString()) return false;
        // 新订阅或从未发送时，仅在今天计划时间已到且还未发过的情况下发送
        if (!lastSent) {
          // 距离计划时间不足 60 秒（刚设置）时，说明是新建后首次检查，不应立即发送
          var diff = now.getTime() - new Date(sub.createdAt || now).getTime();
          if (diff < 120000) return false; // 2 分钟内不发送
        }
        return nowMinHour >= subMinHour;
      case "weekly":
        if (lastSent && lastSent.toDateString() === now.toDateString()) return false;
        if (!lastSent) {
          var diff = now.getTime() - new Date(sub.createdAt || now).getTime();
          if (diff < 120000) return false;
        }
        return now.getDay() === sub.scheduleDayOfWeek && nowMinHour >= subMinHour;
      case "monthly":
        if (lastSent && lastSent.toDateString() === now.toDateString()) return false;
        if (!lastSent) {
          var diff = now.getTime() - new Date(sub.createdAt || now).getTime();
          if (diff < 120000) return false;
        }
        return now.getDate() === sub.scheduleDayOfMonth && nowMinHour >= subMinHour;
      default:
        return false;
    }
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
          <button type="button" class="dsapi-plus-auto-refresh-btn" style="margin-left:4px;">自动刷新 ${getAutoRefreshLabel(state.autoRefreshInterval)}</button>
          <button type="button" class="dsapi-plus-toggle-native-btn${state.nativeContentVisible ? ' active' : ''}" style="margin-left:4px;">原生内容</button>
          <button type="button" class="dsapi-plus-clear-cache-btn" style="margin-left:4px;">清除缓存</button>
          <button type="button" class="dsapi-plus-refresh">刷新</button>
        </div>
      </div>

      <div class="dsapi-plus-subscribe-section" style="margin-top:16px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="font-size:14px;font-weight:600;flex-shrink:0;">📬 订阅管理</div>
          <span style="font-size:11px;color:var(--dsapi-plus-muted);flex-shrink:0;">${getActiveSubscriptionCount()} 个活跃订阅</span>
          <div style="flex:1;"></div>
          <button type="button" class="dsapi-plus-subscribe-btn${state.subscriptionVisible ? ' active' : ''}">订阅</button>
          <button type="button" class="dsapi-plus-subscribe-create-btn" data-action="create">新建订阅</button>
        </div>
        <div class="dsapi-plus-subscribe-inline-content"></div>
        <div id="dsapi-plus-subscribe-form-static" class="dsapi-plus-subscribe-form" style="display:none;"></div>
      </div>

      <div class="dsapi-plus-body">
        <div class="dsapi-plus-summary">
          <div class="dsapi-plus-section-head" style="margin-bottom:12px;width:100%;">
            <div class="dsapi-plus-section-title">💰 费用摘要</div>
            <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.requests ? ' active' : ''}" data-section="requests">请求</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.tokens ? ' active' : ''}" data-section="tokens">Tokens</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.cacheRate ? ' active' : ''}" data-section="cacheRate">缓存</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.composition ? ' active' : ''}" data-section="composition">Token构成</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.models ? ' active' : ''}" data-section="models">模型</button>
            </div>
          </div>
          ${summaryItem("当日费用", isCurrentPeriod ? todayCostText : "--", "", isCurrentPeriod ? todayCostDetail : "")}
          ${summaryItem("当月费用", monthCostText, "", costDetail)}
          ${summaryItem("当月平均费用", formatCnyAmount(averageCostPerMillion), "/1M", averageCostDetail)}
          ${summaryItem("当月用量", formatInteger(summary.monthlyUsage), "Tokens", usageDetail)}
          ${isCurrentPeriod ? summaryItem("预估可用", estimatedAvailableTokens ? formatInteger(estimatedAvailableTokens) : "无法估算", estimatedAvailableTokens ? "Tokens" : "") : ""}
          ${summaryItem("钱包余额", formatCnyAmount(walletCnyBalance), "CNY", "")}
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
            <div class="dsapi-plus-section-title">🔑 Key 明细</div>
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
              <button type="button" class="dsapi-plus-toggle-key-btn${state.keyTableVisible ? ' active' : ''}">表格详情</button>
              <button type="button" class="dsapi-plus-cost-chart-btn${state.keyDetailChartVisible ? ' active' : ''}">费用分布</button>
              <button type="button" class="dsapi-plus-daily-btn${state.keyDetailDailyVisible ? ' active' : ''}">每日详情</button>
            </div>
          </div>
          ${sortedKeys.length ? renderKeyTable(sortedKeys, cost, state.keyTableVisible) : '<div class="dsapi-plus-message">当前月份暂无 Key 级别用量数据，或 API 未返回 Key 信息。</div>'}
          <div class="dsapi-plus-key-chart" style="display:${state.keyDetailChartVisible !== false ? '' : 'none'};margin-top:8px;">
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
      walletCnyBalance,
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
    // 初始化订阅管理内嵌面板
    var subContent = panel.querySelector(".dsapi-plus-subscribe-inline-content");
    if (subContent) {
      if (state.subscriptionVisible) {
        subContent.style.display = "";
        if (!subContent.children.length) {
          var subPanel = renderSubscriptionPanel();
          subContent.appendChild(subPanel);
          bindSubscriptionPanelEvents(subPanel);
        }
      } else {
        subContent.style.display = "none";
      }
    }
    // 全量重渲染后恢复原生内容显示状态
    toggleNativeContent(state.nativeContentVisible);
    // 异步刷新 Key 明细（使用当前选中月份）
    var period = getSelectedPeriod();
    var controller = new AbortController();
    fetchKeyDetailFromExport(period, controller.signal).catch(function () {});
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
    return Promise.resolve(typeof echarts !== "undefined" ? echarts : window.echarts);
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
    const { period, amount, summary, cost, monthlyCostText, monthCostText, todayCostText, todayCostDetail, costDetail, usageDetail, sortedModels, sortedKeys, tokenTotal, isCurrentPeriod, averageCostLabel, averageCostPerMillion, averageCostDetail, estimatedAvailableTokens, walletCnyBalance, updateTime } = panelData;

    const periodSelect = panel.querySelector(".dsapi-plus-period-select");
    const status = panel.querySelector(".dsapi-plus-status");
    if (periodSelect) periodSelect.value = period;
    if (status) status.textContent = `已更新 ${escapeHtml(updateTime)}`;

    const summaryEl = panel.querySelector(".dsapi-plus-summary");
    if (summaryEl) {
      summaryEl.innerHTML =
        '<div class="dsapi-plus-section-head" style="margin-bottom:12px;width:100%;"><div class="dsapi-plus-section-title">💰 费用摘要</div></div>' +
        summaryItem("当日费用", isCurrentPeriod ? todayCostText : "--", "", isCurrentPeriod ? todayCostDetail : "") +
        summaryItem("当月费用", monthCostText, "", costDetail) +
        summaryItem("当月平均费用", formatCnyAmount(averageCostPerMillion), "/1M", averageCostDetail) +
        summaryItem("当月用量", formatInteger(summary.monthlyUsage), "Tokens", usageDetail) +
        (isCurrentPeriod ? summaryItem("预估可用", estimatedAvailableTokens ? formatInteger(estimatedAvailableTokens) : "无法估算", estimatedAvailableTokens ? "Tokens" : "") : "") +
        summaryItem("钱包余额", formatCnyAmount(walletCnyBalance), "CNY", "");
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

  // 获取导出 ZIP 文件（返回 Blob）
  function fetchExportBlob(path, signal) {
    var auth = getStoredAuthToken();
    var headers = { accept: "application/octet-stream, application/zip, */*" };
    var appVersion = document.querySelector('meta[name="commit-id"]');
    if (appVersion && appVersion.content) headers["X-App-Version"] = appVersion.content;
    if (auth.token) headers.Authorization = "Bearer " + auth.token;

    var absUrl = path;
    if (absUrl.indexOf("http") !== 0) absUrl = location.origin + "/" + absUrl.replace(/^\//, "");

    return new Promise(function (resolve, reject) {
      var gmReq = GM.xmlHttpRequest({
        method: "GET",
        url: absUrl,
        headers: headers,
        responseType: "blob",
        timeout: 30000,
        onload: function (resp) {
          if (resp.status >= 200 && resp.status < 300 && resp.response) {
            resolve(resp.response);
          } else {
            reject(new Error("下载失败：" + resp.status + " " + (resp.statusText || "")));
          }
        },
        onerror: function () { reject(new Error("GM_xmlhttpRequest 网络错误")); },
        ontimeout: function () { reject(new Error("下载超时（30秒）")); },
      });
      if (signal) {
        if (signal.aborted) { reject(new Error("请求已取消")); return; }
        signal.addEventListener("abort", function () { if (gmReq && gmReq.abort) gmReq.abort(); reject(new Error("请求已取消")); }, { once: true });
      }
    });
  }

  // 从 ZIP ArrayBuffer 中提取指定文件的内容（手动解析 ZIP 结构，避免 GM 沙箱中 JSZip async 挂起）
  function extractFileFromZip(zipBuf, targetName) {
    var zipName = targetName.toLowerCase();
    var bytes = new Uint8Array(zipBuf);
    var i = 0;
    // 查找中央目录结束标记 (EOCD) 0x06054b50
    for (i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) break;
    }
    if (i < 0) return null;
    // 中央目录偏移量（EOCD 偏移 16 字节处，4 字节）
    var cdOffset = (bytes[i + 16]) | (bytes[i + 17] << 8) | (bytes[i + 18] << 16) | (bytes[i + 19] << 24);
    // 遍历中央目录条目，查找目标文件
    var pos = cdOffset;
    while (pos < bytes.length - 46) {
      if (bytes[pos] !== 0x50 || bytes[pos + 1] !== 0x4b || bytes[pos + 2] !== 0x01 || bytes[pos + 3] !== 0x02) break;
      var fileNameLen = (bytes[pos + 28]) | (bytes[pos + 29] << 8);
      var extraLen = (bytes[pos + 30]) | (bytes[pos + 31] << 8);
      var commentLen = (bytes[pos + 32]) | (bytes[pos + 33] << 8);
      var compressedSize = (bytes[pos + 20]) | (bytes[pos + 21] << 8) | (bytes[pos + 22] << 16) | (bytes[pos + 23] << 24);
      var compressionMethod = (bytes[pos + 10]) | (bytes[pos + 11] << 8);
      var localOffset = (bytes[pos + 42]) | (bytes[pos + 43] << 8) | (bytes[pos + 44] << 16) | (bytes[pos + 45] << 24);
      var nameBuf = bytes.subarray(pos + 46, pos + 46 + fileNameLen);
      var name = new TextDecoder("utf-8").decode(nameBuf).toLowerCase();
      if (name === zipName || name.replace(/^.*\//, "") === zipName.replace(/^.*\//, "")) {
        // 找到文件 → 从 local file header 读取文件数据
        var localPos = localOffset;
        if (localPos + 30 > bytes.length) return null;
        var localFNLen = (bytes[localPos + 26]) | (bytes[localPos + 27] << 8);
        var localExtraLen = (bytes[localPos + 28]) | (bytes[localPos + 29] << 8);
        var dataStart = localPos + 30 + localFNLen + localExtraLen;
        var fileData = bytes.subarray(dataStart, dataStart + compressedSize);
        if (compressionMethod === 0) {
          // 未压缩（stored）
          return new TextDecoder("utf-8").decode(fileData);
        }
        if (compressionMethod === 8) {
          // Deflate 压缩 — 使用 pako（JSZip 内包含）同步解压
          try {
            var deflate = JSZip.compressions.DEFLATE;
            var csvBytes = deflate.uncompress(fileData);
            return new TextDecoder("utf-8").decode(csvBytes);
          } catch (e) { return null; }
        }
        return null;
      }
      pos += 46 + fileNameLen + extraLen + commentLen;
    }
    return null;
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
      var zipBlob = await fetchExportBlob(`/api/v0/usage/export?${query}`, signal);
      console.log("[DeepSeek Usage Panel Plus] 下载 ZIP 大小", (zipBlob.size || 0), "bytes");

      // Blob → ArrayBuffer（JSZip 需要 ArrayBuffer）
      var zipBuffer = await new Promise(function (res, rej) {
        var reader = new FileReader();
        reader.onload = function () { res(reader.result); };
        reader.onerror = function () { rej(new Error("Blob 转 ArrayBuffer 失败")); };
        reader.readAsArrayBuffer(zipBlob);
      });

      // 2. 用 JSZip 解压
      if (typeof JSZip === "undefined") throw new Error("JSZip 库未加载");
      var zip = await JSZip.loadAsync(zipBuffer);
      console.log("[DeepSeek Usage Panel Plus] JSZip 解压成功, 文件列表:", Object.keys(zip.files));

      // 3. 找到 amount-*.csv 文件
      var csvFiles = Object.keys(zip.files).filter(function (name) { return /amount.*\.csv$/i.test(name); });
      console.log("[DeepSeek Usage Panel Plus] ZIP 中的 CSV 文件", csvFiles);
      if (!csvFiles.length) throw new Error("ZIP 中未找到 amount-*.csv 文件");

      // 手动解析 ZIP 提取 CSV（JSZip 的 async 方法在 GM 沙箱中会挂起）
      var csvContent = extractFileFromZip(zipBuffer, csvFiles[0]);
      if (!csvContent) throw new Error("无法从 ZIP 中提取 " + csvFiles[0]);

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

      // 8. 按 (key, date) 聚合每日详情（费用、请求数、Token，用于每日详情折线图和订阅报告日明细）
      const dailyDetailMap = {};
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
        const pairKey = keyName + "|||" + date;
        if (!dailyDetailMap[pairKey]) {
          dailyDetailMap[pairKey] = { requestCount: 0, missTokens: 0, hitTokens: 0, outTokens: 0, cost: 0 };
        }
        var dd = dailyDetailMap[pairKey];
        var cost = price * amount;
        if (type === "request_count" || type === "calls" || type === "requests") {
          dd.requestCount += amount;
        } else if (type === "input_cache_hit_tokens" || type === "prompt_cache_hit_token" || type === "inputCacheHit") {
          dd.hitTokens += amount; dd.cost += cost;
        } else if (type === "input_cache_miss_tokens" || type === "prompt_cache_miss_token" || type === "inputCacheMiss") {
          dd.missTokens += amount; dd.cost += cost;
        } else if (type === "output_tokens" || type === "completion_token" || type === "output") {
          dd.outTokens += amount; dd.cost += cost;
        }
      }
      const sortedDates = Array.from(allDates).sort();
      // 构建每 key 每日系列数据
      var dailySerieMap = {};
      for (const [pairKey, dd] of Object.entries(dailyDetailMap)) {
        const sep = pairKey.lastIndexOf("|||");
        const k = pairKey.substring(0, sep);
        const d = pairKey.substring(sep + 3);
        if (!dailySerieMap[k]) {
          dailySerieMap[k] = { name: k, cost: {}, request: {}, tokens: {}, miss: {}, hit: {} };
          for (const dt of sortedDates) { dailySerieMap[k].cost[dt] = 0; dailySerieMap[k].request[dt] = 0; dailySerieMap[k].tokens[dt] = 0; dailySerieMap[k].miss[dt] = 0; dailySerieMap[k].hit[dt] = 0; }
        }
        dailySerieMap[k].cost[d] = dd.cost;
        dailySerieMap[k].request[d] = dd.requestCount;
        dailySerieMap[k].tokens[d] = dd.missTokens + dd.hitTokens + dd.outTokens;
        dailySerieMap[k].miss[d] = dd.missTokens;
        dailySerieMap[k].hit[d] = dd.hitTokens;
      }
      const sortedKeys2 = Object.values(keyMap).sort((a, b) => b.totalCost - a.totalCost || b.requestCount - a.requestCount);
      const keyOrder = sortedKeys2.map((k) => k.key);
      const dailyData = {
        dates: sortedDates,
        series: keyOrder.filter((k) => dailySerieMap[k]).map((k) => ({
          name: k,
          data: sortedDates.map((d) => dailySerieMap[k].cost[d] || 0),
        })),
        requests: keyOrder.filter((k) => dailySerieMap[k]).map((k) => ({
          name: k,
          data: sortedDates.map((d) => dailySerieMap[k].request[d] || 0),
        })),
        tokens: keyOrder.filter((k) => dailySerieMap[k]).map((k) => ({
          name: k,
          data: sortedDates.map((d) => dailySerieMap[k].tokens[d] || 0),
        })),
        miss: keyOrder.filter((k) => dailySerieMap[k]).map((k) => ({
          name: k,
          data: sortedDates.map((d) => dailySerieMap[k].miss[d] || 0),
        })),
        hit: keyOrder.filter((k) => dailySerieMap[k]).map((k) => ({
          name: k,
          data: sortedDates.map((d) => dailySerieMap[k].hit[d] || 0),
        })),
      };

      console.log("[DeepSeek Usage Panel Plus] Key 明细聚合结果", {
        keysCount: sorted.length,
        sample: sorted.slice(0, 3),
      });

      state.keyDetailData = sorted;
      state.keyDetailDailyData = dailyData;
      state.keyDetailUpdateTime = new Date().toLocaleTimeString("zh-CN");
      state.keyUnitPrices = {};
      state.keyDetailLoading = false;
      saveKeyDetailData();
      // 延迟刷新 UI，避免和 renderPanel 的 DOM 重建竞态
      scheduleKeyDetailUIUpdate();
      return sorted;
    } catch (error) {
      console.error("[DeepSeek Usage Panel Plus] 获取 Key 明细失败", error);
      state.keyDetailLoading = false;
      state.keyDetailError = error.message || String(error);
      scheduleKeyDetailUIUpdate();
      return null;
    }
  }

  // 延迟刷新 Key 明细 UI（避免与 renderPanel DOM 重建竞态）
  var _keyDetailUIRetryTimer = 0;
  function scheduleKeyDetailUIUpdate() {
    if (_keyDetailUIRetryTimer) clearTimeout(_keyDetailUIRetryTimer);
    _keyDetailUIRetryTimer = setTimeout(function () { tryUpdateKeyDetailUI(0); }, 80);
  }
  function tryUpdateKeyDetailUI(retries) {
    var panel = document.getElementById(PANEL_ID);
    if (!panel) {
      if (retries < 5) { _keyDetailUIRetryTimer = setTimeout(function () { tryUpdateKeyDetailUI(retries + 1); }, 200); }
      return;
    }
    var keySection = panel.querySelector(".dsapi-plus-section:last-child");
    if (!keySection) {
      if (retries < 5) { _keyDetailUIRetryTimer = setTimeout(function () { tryUpdateKeyDetailUI(retries + 1); }, 200); }
      return;
    }
    updateKeyDetailUI();
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
    // 隐藏面板之后的所有原生内容
    for (let i = idx + 1; i < siblings.length; i++) {
      siblings[i].style.display = show ? "" : "none";
    }
    // 隐藏面板之前的内容（页面顶部：用量信息、充值余额等）
    for (let i = 0; i < idx; i++) {
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

    // Key 费用分布图可见性
    const costChartBtn = panel.querySelector(".dsapi-plus-cost-chart-btn");
    if (costChartBtn) {
      costChartBtn.addEventListener("click", () => {
        state.keyDetailChartVisible = !state.keyDetailChartVisible;
        costChartBtn.classList.toggle("active", state.keyDetailChartVisible);
        saveKeyDetailChartVisible();
        const chartWrap = panel.querySelector(".dsapi-plus-key-chart");
        if (chartWrap) {
          chartWrap.style.display = state.keyDetailChartVisible ? "" : "none";
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
        nativeBtn.classList.toggle("active", state.nativeContentVisible);
        saveNativeContentVisible();
        toggleNativeContent(state.nativeContentVisible);
      });
    }

    // 清除缓存
    var clearBtn = panel.querySelector(".dsapi-plus-clear-cache-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        if (!confirm("确定清除所有缓存数据？这将重置所有设置并重新加载页面。")) return;
        var keys = [
          "dsapi_plus_section_visible",
          "dsapi_plus_key_table_visible",
          "dsapi_plus_native_content_visible",
          "dsapi_plus_group_by_model",
          "dsapi_plus_auto_refresh",
          "dsapi_plus_key_detail",
          "dsapi_plus_key_filter",
          "dsapi_plus_key_daily_visible",
          "dsapi_plus_subscriptions",
          "dsapi_plus_subscription_last_sent",
        ];
        for (var ki = 0; ki < keys.length; ki++) {
          try { localStorage.removeItem(keys[ki]); } catch (e) { /* ignore */ }
        }
        location.reload();
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

    // 订阅按钮点击 → 打开订阅面板
    const subscribeBtn = panel.querySelector(".dsapi-plus-subscribe-btn");
    if (subscribeBtn) {
      subscribeBtn.addEventListener("click", function () {
        state.subscriptionVisible = !state.subscriptionVisible;
        saveSubscriptionVisible();
        subscribeBtn.classList.toggle("active", state.subscriptionVisible);
        var content = panel.querySelector(".dsapi-plus-subscribe-inline-content");
        if (content) {
          if (state.subscriptionVisible) {
            content.style.display = "";
            if (!content.children.length) {
              var subPanel = renderSubscriptionPanel();
              content.appendChild(subPanel);
              bindSubscriptionPanelEvents(subPanel);
            }
          } else {
            content.style.display = "none";
          }
        }
      });
    }

    // 订阅管理：新建订阅按钮（在标题行，不在内嵌面板内）
    var outerCreateBtn = panel.querySelector(".dsapi-plus-subscribe-section [data-action='create']");
    if (outerCreateBtn) {
      outerCreateBtn.addEventListener("click", function () {
        var inlineContent = panel.querySelector(".dsapi-plus-subscribe-inline-content");
        if (!inlineContent) return;
        // 确保订阅项可见
        if (!state.subscriptionVisible) {
          state.subscriptionVisible = true;
          saveSubscriptionVisible();
          var sb = panel.querySelector(".dsapi-plus-subscribe-btn");
          if (sb) sb.classList.add("active");
          inlineContent.style.display = "";
        }
        if (!inlineContent.children.length) {
          var subPanel = renderSubscriptionPanel();
          inlineContent.appendChild(subPanel);
          bindSubscriptionPanelEvents(subPanel);
        }
        // 使用静态表单
        showStaticForm(null);
      });
    }

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
    state.abortController?.abort();
    state.abortController = null;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    disposeCharts();
    closeSubscriptionPanel();
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
    startSubscriptionCheckTimer();
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
