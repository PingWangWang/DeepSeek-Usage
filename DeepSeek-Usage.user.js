// ==UserScript==
// @name         DeepSeek Usage — DeepSeek用量页增强
// @namespace    https://github.com/PingWangWang
// @url          https://github.com/PingWangWang/DeepSeek-Usage.git
// @version      1.38.12
// @description  用量页增强仪表盘：订阅推送（Markdown/截图+ImgBB/PicGo图床）、费用/Token构成、缓存命中率、Key明细（ZIP导入/模型统计/筛选密钥/每日费用曲线/多选删除配置）、月份切换、自动刷新数据、手机适配。
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


  // ========== 主题模式持久化（auto / light / dark） ==========
  // auto  = 跟随站点自身主题（不干预 body.dark）
  // light / dark = 强制覆盖：翻转 body.dark 类，直接复用站点既有配色与脚本的图表重绘管线
  const THEME_MODE_KEY = "dsapi_plus_theme_mode";
  const THEME_MODES = ["auto", "light", "dark"]; // 按钮循环顺序：跟随 → 浅色 → 深色

  function loadThemeMode() {
    try {
      const v = localStorage.getItem(THEME_MODE_KEY);
      return THEME_MODES.indexOf(v) >= 0 ? v : "auto";
    } catch (e) { /* ignore */ }
    return "auto";
  }

  function saveThemeMode() {
    try { localStorage.setItem(THEME_MODE_KEY, String(state.themeMode)); }
    catch (e) { /* ignore */ }
  }

  // [需求 4] 区间起止持久化：刷新/重开页面后仍沿用上次设置，而非重置为年初至今。
  // 读取持久化区间（越界/非法时回退到默认窗口），供 state 初始化使用。
  const initialRange = loadRangeWindow();

  const state = {
    rangeStart: initialRange.start, // 面板区间聚合起始月（如 "2026-1"），持久化
    rangeEnd: initialRange.end,     // 面板区间聚合结束月（如 "2026-9"），持久化
    rangeKey: "",            // 区间去重键 `${start}~${end}`
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
    pendingPanelDataTimer: 0, // 延迟更新超时句柄
    themeMode: loadThemeMode(), // 主题模式：auto（跟随站点）/ light / dark，持久化
    // Key 明细数据（从导出接口获取）
    keyDetailData: null,       // 按 key 聚合后的数据
    keyDetailLoading: false,   // 正在加载中
    keyDetailError: "",        // 加载错误信息
    keyDetailUpdateTime: "",   // 上次成功导入的时间
    keyUnitPrices: {},         // { model: { promptMiss: 单价, promptHit: 单价, response: 单价 } }
    keyDetailAbortController: null, // 正在进行的 Key 明细导出请求（切月/连续刷新时用于取消旧请求，避免乱序覆盖）
    keyDetailReqId: 0,                 // Key 明细请求自增序号（用于丢弃已被更新的旧请求结果）

    // Key 明细表格显示状态
    keyTableVisible: loadKeyTableVisible(),    // 默认不显示表格详情（已持久化）

    // 各图表区块显示状态（持久化到 localStorage）
    sectionVisible: loadSectionVisible(),

    // 原生内容（页面原有的每月用量等）显示状态
    nativeContentVisible: loadNativeContentVisible(),

    // 按模型分组开关
    groupByModel: loadGroupByModel(),

    // 自动刷新数据
    autoRefreshInterval: loadAutoRefreshInterval(),
    autoRefreshTimer: 0,       // setInterval 句柄

    // Key 筛选密钥
    keyFilter: loadKeyFilter(),  // { mode: "all", keys: [...] } 或 null

    // 每日详情
    keyDetailDailyVisible: loadKeyDetailDailyVisible(),
    keyDetailDailyData: null,  // { dates: [], series: [{name, data}] }

    // Key 费用分布图可见性
    keyDetailChartVisible: loadKeyDetailChartVisible(),

    // 订阅功能
    subscriptions: loadSubscriptions(),           // 订阅配置数组
    subscriptionVisible: loadSubscriptionVisible(), // 订阅内嵌面板可见性
    subscriptionEditVisible: loadSubscriptionEditVisible(), // 编辑配置面板可见性
    subscriptionLastSent: loadSubscriptionLastSent(), // { subId: ISO时间戳 }
    subscriptionCheckTimer: 0,                    // 定时检查 timer 句柄
    compactViewVisible: loadCompactViewVisible(), // 精简视图，默认 false

    // Key 明细区块 / 每日明细区块 整体显示开关（默认开启，持久化）
    keyDetailVisible: loadKeyDetailVisible(),
    dailyDetailVisible: loadDailyDetailVisible(),
  };

  migrateSubscriptions();                         // 迁移旧版 contentOptions 字段

  function loadSectionVisible() {
    try {
      const saved = localStorage.getItem("dsapi_plus_section_visible");
      if (saved) {
        // 合并默认值：旧存档缺 monthTrend 键时补默认 true（月度趋势默认显示）
        return Object.assign({ models: false, monthTrend: true }, JSON.parse(saved));
      }
    } catch (e) { /* ignore */ }
    return { models: false, monthTrend: true };
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

  function loadSubscriptionEditVisible() {
    try { return localStorage.getItem("dsapi_plus_subscription_edit_visible") === "true"; }
    catch (e) { /* ignore */ }
    return false;
  }

  function saveSubscriptionEditVisible() {
    try { localStorage.setItem("dsapi_plus_subscription_edit_visible", String(state.subscriptionEditVisible)); }
    catch (e) { /* ignore */ }
  }

  function loadCompactViewVisible() {
    try { return localStorage.getItem("dsapi_plus_compact_view") === "true"; }
    catch (e) { /* ignore */ }
    return false;
  }

  function saveCompactViewVisible() {
    try { localStorage.setItem("dsapi_plus_compact_view", String(state.compactViewVisible)); }
    catch (e) { /* ignore */ }
  }

  // Key 明细区块 / 每日明细区块整体显示开关（默认开启，持久化）
  function loadKeyDetailVisible() {
    try { return localStorage.getItem("dsapi_plus_key_detail_visible") !== "false"; }
    catch (e) { /* ignore */ }
    return true;
  }

  function saveKeyDetailVisible() {
    try { localStorage.setItem("dsapi_plus_key_detail_visible", String(state.keyDetailVisible)); }
    catch (e) { /* ignore */ }
  }

  function loadDailyDetailVisible() {
    try { return localStorage.getItem("dsapi_plus_daily_detail_visible") !== "false"; }
    catch (e) { /* ignore */ }
    return true;
  }

  function saveDailyDetailVisible() {
    try { localStorage.setItem("dsapi_plus_daily_detail_visible", String(state.dailyDetailVisible)); }
    catch (e) { /* ignore */ }
  }

  function loadKeyDetailDailyVisible() {
    try {
      return localStorage.getItem("dsapi_plus_key_daily_visible") === "true";
    } catch (e) { /* ignore */ }
    return true;
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

  // ========== 面板区间起止持久化（需求 4：刷新页面后保留用户设置的区间） ==========
  // 读取上次保存的区间窗口；缺失 / 非法 / 超出可选月份范围时回退到默认窗口（当年 1 月 → 当前月）
  function loadRangeWindow() {
    const dflt = getDefaultMonthWindow();
    try {
      const s = localStorage.getItem("dsapi_plus_range_start") || "";
      const e = localStorage.getItem("dsapi_plus_range_end") || "";
      const valid = (p) => /^\d{4}-\d{1,2}$/.test(p);
      if (!valid(s) || !valid(e)) return dflt;
      const toNum = (p) => {
        const { year, month } = parsePeriod(p);
        return year * 100 + month;
      };
      let start = s;
      let end = e;
      if (toNum(start) > toNum(end)) { const t = start; start = end; end = t; }
      // 可选范围与 buildMonthSummaryOptionsList 一致：当前年往前 3 年 → 当前月
      const now = new Date();
      const nowPeriod = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
      const minPeriod = `${now.getUTCFullYear() - 3}-1`;
      const inWindow = (p) => toNum(p) >= toNum(minPeriod) && toNum(p) <= toNum(nowPeriod);
      if (!inWindow(start) || !inWindow(end)) return dflt;
      return { start, end };
    } catch (e) { /* ignore */ }
    return dflt;
  }

  function saveRangeWindow() {
    try {
      localStorage.setItem("dsapi_plus_range_start", String(state.rangeStart));
      localStorage.setItem("dsapi_plus_range_end", String(state.rangeEnd));
    } catch (e) { /* ignore */ }
  }

  // 费用摘要「当月费用」展示开关（默认关闭，遵循区间模式默认不展示单月费用的设计，持久化）
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
        range: state.rangeStart && state.rangeEnd ? `${state.rangeStart}~${state.rangeEnd}` : "",
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
    const filtered = dd.series.filter((s) => filter.keys.includes(s.name));
    // 同步过滤 requests / tokens / miss / hit 等并行数组，保持索引与 series 对齐
    return {
      dates: dd.dates,
      series: filtered,
      requests: dd.requests ? dd.requests.filter((r) => filter.keys.includes(r.name)) : undefined,
      tokens: dd.tokens ? dd.tokens.filter((t) => filter.keys.includes(t.name)) : undefined,
      miss: dd.miss ? dd.miss.filter((m) => filter.keys.includes(m.name)) : undefined,
      hit: dd.hit ? dd.hit.filter((h) => filter.keys.includes(h.name)) : undefined,
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
        // 同时刷新 Key 明细数据（如果已导入过）——[需求 1] 跟随面板完整区间
        if (state.keyDetailData && state.keyDetailData.length) {
          const rg = getSelectedRange();
          fetchKeyDetailFromExport(rg.start, rg.end);
        }
      }, state.autoRefreshInterval);
    }
  }

  function getAutoRefreshLabel(interval) {
    const found = AUTO_REFRESH_INTERVALS.find((i) => i.value === interval);
    return found ? found.label : "关";
  }

  // [新增] 自动刷新按钮文案：直接展示当前间隔，避免必须展开下拉才能看到
  function updateAutoRefreshBtnText(btn) {
    if (!btn) return;
    btn.textContent = state.autoRefreshInterval > 0
      ? `自动刷新 · ${getAutoRefreshLabel(state.autoRefreshInterval)}`
      : "自动刷新";
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

  /**
   * 迁移旧版 contentOptions 字段到新版结构
   * - keyDetail → todayDetail + monthDetail
   * - 废弃 cacheHitRate、modelDetail（不再作为独立开关）
   * [修改] 方案二重构：拆分 keyDetail 为当日/月度两个独立开关
   */
  function migrateSubscriptions() {
    var subs = state.subscriptions;
    if (!subs || !subs.length) return;
    var changed = false;
    for (var i = 0; i < subs.length; i++) {
      var opts = subs[i].contentOptions;
      if (!opts) continue;
      // 旧版 keyDetail → 拆分为 todayDetail + monthDetail
      if (opts.keyDetail !== undefined) {
        opts.todayDetail = opts.keyDetail;
        opts.monthDetail = opts.keyDetail;
        delete opts.keyDetail;
        changed = true;
      }
      // 删除配置废弃字段
      if (opts.cacheHitRate !== undefined) {
        delete opts.cacheHitRate;
        changed = true;
      }
      if (opts.modelDetail !== undefined) {
        delete opts.modelDetail;
        changed = true;
      }
    }
    if (changed) saveSubscriptions();
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
      /* [修改] 原因：平台不提供 --ds-rgb-label-* 变量（实测 0 处定义），面板文字始终走浅色 fallback；
          深色模式下必须重定义文字色，否则面板内容落在暗色背景上不可见 */
      body.dark .dsapi-plus-panel {
        --dsapi-plus-text: rgb(224 224 232);
        --dsapi-plus-muted: rgb(190 194 206); /* [修改] 提高深色下次要文字对比度 */
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
        border-radius: 6px;
        color: var(--dsapi-plus-muted);
        font-size: 12px;
        height: 28px;
        padding: 0 8px;
        cursor: pointer;
        outline: none;
        opacity: 0.7;
        transition: none;
        box-sizing: border-box;
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
      .dsapi-plus-toggle-section-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font-size: 12px;
        line-height: 18px;
        padding: 4px 2px;
        min-width: 64px;
        opacity: 0.7;
        transition: none;
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
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
      .dsapi-plus-toggle-compact-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
        white-space: nowrap;
      }
      .dsapi-plus-toggle-compact-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
        border-style: solid;
      }
      .dsapi-plus-toggle-compact-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
        border-style: solid;
      }
      /* 精简视图：隐藏订阅区和主体内容 */
      .dsapi-plus-panel.compact .dsapi-plus-subscribe-section,
      .dsapi-plus-panel.compact .dsapi-plus-body {
        display: none !important;
      }
      .dsapi-plus-group-model-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
      .dsapi-plus-auto-refresh-dropdown {
        position: absolute;
        top: 100%;
        right: 0;
        z-index: 1000;
        background: var(--dsapi-plus-bg, #fff);
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 6px;
        padding: 4px;
        min-width: 100px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        display: none;
      }
      .dsapi-plus-auto-refresh-dropdown button {
        display: block;
        width: 100%;
        border: 0;
        background: transparent;
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 4px;
        text-align: left;
        font-size: 12px;
        white-space: nowrap;
        color: var(--dsapi-plus-text);
      }
      .dsapi-plus-auto-refresh-dropdown button:hover {
        background: rgba(2, 14, 54, 0.05);
      }
      .dsapi-plus-auto-refresh-dropdown button.active {
        background: rgba(34, 197, 94, 0.1);
        color: #22c55e;
        font-weight: 600;
      }
      body.dark .dsapi-plus-auto-refresh-dropdown {
        background: #1a1a2e;
        border-color: rgba(255, 255, 255, 0.12);
      }
      body.dark .dsapi-plus-auto-refresh-dropdown button:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      /* 所有按钮控件统一样式：扁平风，统一高度 28px */
      .dsapi-plus-auto-refresh-btn,
      .dsapi-plus-toggle-section-btn,
      .dsapi-plus-toggle-key-btn,
      .dsapi-plus-toggle-native-btn,
      .dsapi-plus-toggle-compact-btn,
      .dsapi-plus-theme-btn,
      .dsapi-plus-group-model-btn,
      .dsapi-plus-key-filter-btn,
      .dsapi-plus-cost-chart-btn,
      .dsapi-plus-subscribe-btn,
      .dsapi-plus-subscribe-create-btn,
      .dsapi-plus-clear-cache-btn {
        appearance: none;
        box-sizing: border-box;
        height: 28px;
        min-width: 56px;
        padding: 0 14px;
        font-size: 12px;
        line-height: 1;
        border-radius: 6px;
        text-align: center;
      }
      .dsapi-plus-clear-cache-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.6;
        transition: none;
        white-space: nowrap;
      }
      .dsapi-plus-clear-cache-btn:hover {
        opacity: 1;
        background: rgba(214, 69, 65, 0.08);
        color: rgb(214, 69, 65);
        border-color: rgba(214, 69, 65, 0.3);
      }
      /* 主题切换按钮：跟随 / 浅色 / 深色 三态循环，强制态高亮为绿色 */
      .dsapi-plus-theme-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
        white-space: nowrap;
      }
      .dsapi-plus-theme-btn:hover {
        opacity: 1;
        background: rgba(2, 14, 54, 0.05);
        color: var(--dsapi-plus-text);
        border-style: solid;
      }
      .dsapi-plus-theme-btn.active {
        opacity: 1;
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34, 197, 94, 0.08);
        border-style: solid;
      }
      .dsapi-plus-toggle-key-btn {
        background: transparent;
        border: 1px solid var(--dsapi-plus-muted);
        color: var(--dsapi-plus-muted);
        padding: 4px 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        line-height: 18px;
        white-space: nowrap;
        opacity: 0.7;
        transition: none;
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
      .dsapi-plus-cost-chart-btn {
        appearance: none;
        border: 1px solid var(--dsapi-plus-muted);
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
        font-size: 12px;
        line-height: 1;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        opacity: 0.5;
        transition: none;
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
        align-items: stretch;
        justify-content: flex-start;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 32px;
      }
      .dsapi-plus-summary-item {
        min-width: 0;
        flex: 1 1 170px;
        max-width: 100%;
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(2, 14, 54, 0.1);
        border-radius: 10px;
        padding: 12px 14px;
        background: rgba(2, 14, 54, 0.03);
      }
      body.dark .dsapi-plus-summary-item {
        border-color: rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
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
        margin-top: auto;
        padding-top: 2px;
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
      body.dark .dsapi-plus-toggle-compact-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
        border-style: solid;
      }
      body.dark .dsapi-plus-toggle-compact-btn.active {
        color: #4ade80;
        border-color: #4ade80;
        background: rgba(74, 222, 128, 0.12);
      }
      body.dark .dsapi-plus-theme-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: var(--dsapi-plus-text);
        border-style: solid;
      }
      body.dark .dsapi-plus-theme-btn.active {
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
        background: #1a1a2e !important; /* [修改] 覆盖创建时内联的 background:var(--dsapi-plus-bg,#fff) */
        border-color: rgba(255, 255, 255, 0.15) !important;
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
        color-scheme: dark; /* [修改] 原生 select 弹出选项列表跟随深色 */
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
          flex: 1 1 140px;
          padding: 8px 12px;
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
        .dsapi-plus-key-filter-btn,
        .dsapi-plus-toggle-native-btn,
      .dsapi-plus-toggle-compact-btn,
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
        .dsapi-plus-key-filter-btn,
        .dsapi-plus-toggle-native-btn,
      .dsapi-plus-toggle-compact-btn,
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
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
        --dsapi-plus-text: rgb(var(--ds-rgb-label-1, 2 14 54));
        --dsapi-plus-muted: rgb(var(--ds-rgb-label-2, 87 97 135));
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
        font-size: 12px;
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
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        opacity: 0.7;
        transition: none;
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
      /* ===== Toggle Switch 开关样式 ===== */
      .toggle-switch {
        position: relative;
        display: inline-block;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
      }
      .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: #b0b0b0;
        transition: .25s;
        border-radius: 20px;
      }
      .toggle-slider::before {
        position: absolute;
        content: "";
        height: 16px;
        width: 16px;
        left: 2px;
        bottom: 2px;
        background-color: #fff;
        transition: .25s;
        border-radius: 50%;
      }
      .toggle-switch input:checked + .toggle-slider {
        background-color: #22c55e;
      }
      .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(16px);
      }
      /* 选择框弱化 */
      .sub-select-check {
        opacity: 0.35;
        transition: opacity 0.2s;
        cursor: pointer;
      }
      .sub-select-check:hover,
      .sub-select-check:checked {
        opacity: 1;
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
        box-sizing: border-box;
        height: 28px;
        min-width: 56px;
        padding: 0 14px;
        border: 1px solid var(--dsapi-plus-muted);
        border-radius: 6px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        text-align: center;
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
        box-sizing:border-box;
        height:28px;
        min-width:56px;
        border:1px solid var(--dsapi-plus-muted);
        border-radius:6px;
        background:transparent;
        color:var(--dsapi-plus-muted);
        cursor:pointer;
        font-size:12px;
        line-height:1;
        text-align:center;
        padding:0 14px;
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
        border-radius: 6px;
        box-sizing: border-box;
        height: 28px;
        background: transparent;
        color: var(--dsapi-plus-muted);
        cursor: pointer;
        font-size: 12px;
        padding: 0 14px;
        transition: none;
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
        --dsapi-plus-text: #e0e0e0;
        --dsapi-plus-muted: #bec2ce; /* [修改] 提高深色下次要文字对比度 */
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
      body.dark .toggle-slider {
        background-color: #555;
      }
      /* ===== [修改] 深色模式适配补充：订阅面板/报告预览/提示框/悬浮下拉 =====
         原因：深色模式下浅色主题的深蓝 hover 背景与深蓝边框几乎不可见，统一替换为白色系 */
      body.dark .dsapi-plus-subscribe-create-btn:hover,
      body.dark .dsapi-plus-subscribe-item-actions button:hover,
      body.dark .dsapi-plus-subscribe-form-actions button:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      body.dark .dsapi-plus-subscribe-item:hover {
        border-color: rgba(255, 255, 255, 0.25);
      }
      body.dark .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-send-btn:hover,
      body.dark .dsapi-plus-subscribe-form-actions .dsapi-plus-subscribe-save-btn:hover {
        background: rgba(74, 222, 128, 0.15);
      }
      body.dark .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-preview-btn:hover {
        background: rgba(96, 165, 250, 0.15);
      }
      body.dark .dsapi-plus-subscribe-item-actions .dsapi-plus-subscribe-del-btn:hover,
      body.dark .dsapi-plus-subscribe-batch-del-btn:hover,
      body.dark .dsapi-plus-subscribe-form-actions .dsapi-plus-subscribe-cancel-btn:hover {
        background: rgba(248, 113, 113, 0.15);
      }
      /* 报告预览：截图图片边框与 Markdown 预览区 */
      body.dark .dsapi-plus-subscribe-panel img {
        border-color: rgba(255, 255, 255, 0.15) !important;
      }
      /* 提示框：加载中/错误/调试信息 */
      body.dark .dsapi-plus-message {
        border-color: rgba(255, 255, 255, 0.18);
        color: #c7cbd8;
      }
      body.dark .dsapi-plus-error {
        border-color: rgba(248, 113, 113, 0.4);
        color: #f87171;
        background: rgba(248, 113, 113, 0.08);
      }
      /* 悬浮下拉补强：自动刷新下拉选中项、Key 筛选列表文字 */
      body.dark .dsapi-plus-auto-refresh-dropdown button.active {
        color: #4ade80;
        background: rgba(74, 222, 128, 0.15);
      }
      body.dark .dsapi-plus-filter-list label {
        color: #d0d3de;
      }
      /* [修改] 订阅表单/计划行原生 select：弹出选项列表深色兜底 + 覆盖内联深蓝边框 */
      body.dark .dsapi-plus-subscribe-form-control select,
      body.dark .dsapi-plus-subscribe-schedule-row select {
        color-scheme: dark;
        border-color: rgba(255, 255, 255, 0.2) !important;
      }
      /* [修改] 原生 select 弹出选项深色（Firefox/Safari 生效；Chrome Windows 由系统渲染，受 color-scheme 限制） */
      body.dark .dsapi-plus-period-select option,
      body.dark .dsapi-plus-subscribe-form-control select option,
      body.dark .dsapi-plus-subscribe-schedule-row select option {
        background: #1a1a2e;
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

  function parsePeriod(period) {
    const matched = String(period || "").match(/^(\d{4})-(\d{1,2})$/);
    if (matched) return { year: Number(matched[1]), month: Number(matched[2]) };

    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  }

  // 跨月聚合并发限流池：同时最多在飞 MAX_CONCURRENCY 条请求，其余排队。
  // 目的：月度统计一次最多 12 月 × 2 接口 = 24 条请求，直接全量并发易触发 DeepSeek 限流。
  const MONTH_RANGE_MAX_CONCURRENCY = 3;

  async function runWithConcurrency(tasks, concurrency) {
    const results = new Array(tasks.length);
    let index = 0;
    async function worker() {
      while (index < tasks.length) {
        const current = index;
        index += 1;
        // [修改] 原因：单月失败时要降级为 0 而非中断整批，故此处捕获异常继续
        results[current] = await tasks[current]().catch((error) => {
          console.warn("[DeepSeek Usage Panel Plus] 跨月单月请求失败，降级为 0", error);
          return null;
        });
      }
    }
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    return results;
  }

  // ========== 按单月分区缓存（需求 2：历史月数据不可变，缓存提速） ==========
  // 历史月永久缓存（无 TTL），当前月按短 TTL 缓存，避免频繁重复请求今日数据。
  const MONTH_CACHE_KEY = "dsapi_plus_month_cache";
  const MONTH_CACHE_TTL_CURRENT = 5 * 60 * 1000; // 当前月 5 分钟

  function loadMonthCache() {
    try {
      const saved = localStorage.getItem(MONTH_CACHE_KEY);
      if (!saved) return {};
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) { return {}; }
  }

  function saveMonthCache(cache) {
    try { localStorage.setItem(MONTH_CACHE_KEY, JSON.stringify(cache)); }
    catch (e) { /* storage quota 不足时忽略 */ }
  }

  // 当前月（含今天）周期字符串，如 "2026-9"
  function currentMonthPeriod() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  }

  // 判断某月是否为历史月（严格早于当前月），历史月数据不可变，可永久缓存
  function isPastMonth(period) {
    const toNum = (p) => { const { year, month } = parsePeriod(p); return year * 100 + month; };
    return toNum(period) < toNum(currentMonthPeriod());
  }

  // 取单月缓存：历史月命中即返回（永不过期），当前月在 TTL 内返回，否则 null
  function getCachedMonth(period) {
    const entry = loadMonthCache()[period];
    if (!entry) return null;
    if (isPastMonth(period)) return entry; // 历史月永久缓存
    if (Date.now() - (entry.fetchedAt || 0) < MONTH_CACHE_TTL_CURRENT) return entry;
    return null;
  }

  // 单月结果写入缓存（仅写入实际拉取到的数据）
  function putCachedMonth(period, amount, cost) {
    const cache = loadMonthCache();
    cache[period] = { amount, cost, fetchedAt: Date.now() };
    saveMonthCache(cache);
  }

  // 清除所有用量数据缓存（需求 3：对全部数据缓存生效），保留用户设置项
  function clearAllDataCaches() {
    try { localStorage.removeItem(MONTH_CACHE_KEY); } catch (e) { /* ignore */ }
    // [需求 1] Key 明细导出行缓存同样属于数据缓存，一并清除
    try { localStorage.removeItem(KEY_DETAIL_ROWS_CACHE_KEY); } catch (e) { /* ignore */ }
  }

  // ========== Key 明细导出行缓存（需求 1 配套：区间 = 多月度合并） ==========
  // 缓存每次 export ZIP 解析出的 CSV 行（含表头），供跨月聚合复用：
  // 历史月不可变 → 永久缓存；当前月按短 TTL，保证今日数据最新。
  const KEY_DETAIL_ROWS_CACHE_KEY = "dsapi_plus_keydetail_rows_cache";
  const KEY_DETAIL_ROWS_TTL_CURRENT = 5 * 60 * 1000; // 当前月 5 分钟

  function loadKeyDetailRowsCache() {
    try {
      const saved = localStorage.getItem(KEY_DETAIL_ROWS_CACHE_KEY);
      if (!saved) return {};
      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) { return {}; }
  }

  function saveKeyDetailRowsCache(cache) {
    try { localStorage.setItem(KEY_DETAIL_ROWS_CACHE_KEY, JSON.stringify(cache)); }
    catch (e) { /* storage quota 不足时忽略 */ }
  }

  // 取某月缓存的导出行：历史月永久有效，当前月在 TTL 内有效，否则返回 null
  function getCachedExportRows(period) {
    const entry = loadKeyDetailRowsCache()[period];
    if (!entry) return null;
    if (isPastMonth(period)) return entry;
    if (Date.now() - (entry.fetchedAt || 0) < KEY_DETAIL_ROWS_TTL_CURRENT) return entry;
    return null;
  }

  function putCachedExportRows(period, headers, rows) {
    const cache = loadKeyDetailRowsCache();
    cache[period] = { headers, rows, fetchedAt: Date.now() };
    saveKeyDetailRowsCache(cache);
  }

  // 加载单月导出行（{ headers, rows }）：优先命中缓存，未命中才下载 ZIP 并解析
  async function loadExportRowsForMonth(period, signal) {
    const cached = getCachedExportRows(period);
    if (cached) return { headers: cached.headers, rows: cached.rows, fromCache: true };
    const { year, month } = parsePeriod(period);
    const query = `year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;

    const zipBlob = await fetchExportBlob(`/api/v0/usage/export?${query}`, signal);
    const zipBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Blob 转 ArrayBuffer 失败"));
      reader.readAsArrayBuffer(zipBlob);
    });
    if (typeof JSZip === "undefined") throw new Error("JSZip 库未加载");
    const zip = await JSZip.loadAsync(zipBuffer);
    const csvFiles = Object.keys(zip.files).filter((name) => /amount.*\.csv$/i.test(name));
    if (!csvFiles.length) throw new Error(`ZIP 中未找到 amount-*.csv 文件（${period}）`);
    // JSZip 的 async 方法在 GM 沙箱中会挂起，需手动解压提取 CSV
    const csvContent = extractFileFromZip(zipBuffer, csvFiles[0]);
    if (!csvContent) throw new Error("无法从 ZIP 中提取 " + csvFiles[0]);
    const { headers, rows } = parseCSV(csvContent);
    putCachedExportRows(period, headers, rows);
    return { headers, rows, fromCache: false };
  }

  // 加载单月 amount+cost：优先命中分区缓存，未命中才发起网络请求
  // 参数:
  //   period: string，如 "2026-9"
  //   signal: AbortSignal|null
  // 返回: { period, amount, cost, fromCache }
  async function loadMonthData(period, signal) {
    const cached = getCachedMonth(period);
    if (cached) return { period, amount: cached.amount, cost: cached.cost, fromCache: true };
    const { year, month } = parsePeriod(period);
    const query = `year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;
    const [amountJson, costJson] = await Promise.all([
      fetchJson(`/api/v0/usage/amount?${query}`, signal),
      fetchJson(`/api/v0/usage/cost?${query}`, signal),
    ]);
    const amount = normalizeAmount(getBizData(amountJson));
    const cost = normalizeCost(getBizData(costJson));
    putCachedMonth(period, amount, cost);
    return { period, amount, cost, fromCache: false };
  }

  // 跨月聚合费用：按币种合并各月的 modelCosts/keyCosts/按日费用
  // 参数: collected —— loadMonthData 结果数组（含 amount/cost/period）
  // 返回: 与 normalizeCost 兼容的 cost 数组（每个币种一个块，含合并后的 modelCosts/keyCosts/days）
  function mergeCostByCurrency(collected) {
    const byCurrency = {};
    for (const item of collected) {
      if (!item || !item.cost) continue;
      for (const block of item.cost) {
        const cur = block.currency;
        if (!cur) continue;
        if (!byCurrency[cur]) byCurrency[cur] = { currency: cur, amount: 0, modelCosts: [], keyCosts: [], days: [] };
        const target = byCurrency[cur];
        target.amount += block.amount || 0;
        // 按日费用拼接：以 "YYYY-MM-DD" 为键跨月合并
        const dayByDate = {};
        for (const dc of (target.days || [])) dayByDate[dc.date] = dc;
        for (const dc of (block.days || [])) {
          const { year, month } = parsePeriod(item.period);
          const prefix = `${year}-${String(month).padStart(2, "0")}-`;
          const dayNum = String(dc.date).replace(/.*-/, "");
          const dayKey = prefix + String(dayNum).padStart(2, "0");
          let exist = dayByDate[dayKey];
          if (!exist) { exist = { date: dayKey, amount: 0 }; dayByDate[dayKey] = exist; target.days.push(exist); }
          exist.amount += dc.amount || 0;
        }
        // 模型费用合并
        for (const mc of (block.modelCosts || [])) {
          let exist = target.modelCosts.find((x) => x.model === mc.model);
          if (!exist) { exist = { model: mc.model, amount: 0, usageCostMap: {} }; target.modelCosts.push(exist); }
          exist.amount += mc.amount || 0;
          for (const [t, v] of Object.entries(mc.usageCostMap || {})) exist.usageCostMap[t] = (exist.usageCostMap[t] || 0) + v;
        }
        // Key 费用合并
        for (const kc of (block.keyCosts || [])) {
          let exist = target.keyCosts.find((x) => x.key === kc.key);
          if (!exist) { exist = { key: kc.key, amount: 0, usageCostMap: {} }; target.keyCosts.push(exist); }
          exist.amount += kc.amount || 0;
          for (const [t, v] of Object.entries(kc.usageCostMap || {})) exist.usageCostMap[t] = (exist.usageCostMap[t] || 0) + v;
        }
      }
    }
    return Object.values(byCurrency);
  }

  // 加载指定起止月份的区间聚合数据，作为主面板（整体按区间）的唯一数据源。
  // 逐月复用 loadMonthData（带历史月永久缓存 + 当前月短 TTL），再跨月聚合为单一 amount/cost/monthlySeries。
  // 参数:
  //   start/end: string，如 "2025-10" / "2026-09"
  //   signal: AbortSignal|null
  // 返回: { period, start, end, months, summary, amount, cost, monthlySeries }
  async function loadRange(start, end, signal) {
    const months = enumerateMonths(start, end);
    const tasks = months.map((period) => () => loadMonthData(period, signal).catch((error) => {
      console.warn("[DeepSeek Usage Panel Plus] 区间单月请求失败，降级为 0", error);
      return { period, amount: null, cost: null, fromCache: false };
    }));
    const collected = await runWithConcurrency(tasks, MONTH_RANGE_MAX_CONCURRENCY);

    // 账户级信息（余额等）与月份无关，仅加载一次
    let summary = { currentToken: 0, totalUsage: 0, monthlyUsage: 0, totalAvailableTokenEstimation: 0, monthlyCosts: [], normalWallets: [], bonusWallets: [] };
    try {
      const summaryJson = await fetchJson("/api/v0/users/get_user_summary", signal);
      summary = normalizeSummary(getBizData(summaryJson));
    } catch (e) { /* 摘要失败不阻断区间聚合 */ }

    // 跨月聚合 amount
    const modelMap = {}, keyMap = {}, dayByKey = {};
    let aggRequest = 0, aggResponse = 0, aggPromptMiss = 0, aggPromptHit = 0, aggTokens = 0;
    const monthlySeries = [];
    for (const item of collected) {
      if (!item || !item.amount) {
        monthlySeries.push({ period: item ? item.period : "", costCNY: 0, tokens: 0, requests: 0, cacheHitRate: 0 });
        continue;
      }
      const { amount, cost, period } = item;
      // 模型合并
      for (const m of amount.models) {
        if (!modelMap[m.model]) modelMap[m.model] = { model: m.model, request: 0, response: 0, promptMiss: 0, promptHit: 0, tokens: 0 };
        const t = modelMap[m.model];
        t.request += m.request; t.response += m.response; t.promptMiss += m.promptMiss; t.promptHit += m.promptHit; t.tokens += m.tokens;
      }
      // Key 合并
      for (const k of amount.keys) {
        if (!keyMap[k.key]) keyMap[k.key] = { key: k.key, request: 0, response: 0, promptMiss: 0, promptHit: 0, tokens: 0, cacheHitRate: 0 };
        const kt = keyMap[k.key];
        kt.request += k.request; kt.response += k.response; kt.promptMiss += k.promptMiss; kt.promptHit += k.promptHit; kt.tokens += k.tokens;
        const pt = kt.promptMiss + kt.promptHit;
        kt.cacheHitRate = pt > 0 ? kt.promptHit / pt : 0;
      }
      // 每日明细拼接（带完整日期 YYYY-MM-DD，跨月共用同一条序列）
      const { year, month } = parsePeriod(period);
      const prefix = `${year}-${String(month).padStart(2, "0")}-`;
      for (const d of (amount.days || [])) {
        const dayNum = String(d.date).replace(/.*-/, "");
        const dayKey = prefix + String(dayNum).padStart(2, "0");
        if (!dayByKey[dayKey]) {
          dayByKey[dayKey] = { date: dayKey, request: 0, response: 0, promptMiss: 0, promptHit: 0, tokens: 0, models: [] };
        }
        const td = dayByKey[dayKey];
        td.request += d.request; td.response += d.response; td.promptMiss += d.promptMiss; td.promptHit += d.promptHit; td.tokens += d.tokens;
      }
      // 汇总
      aggRequest += amount.aggregate.request; aggResponse += amount.aggregate.response;
      aggPromptMiss += amount.aggregate.promptMiss; aggPromptHit += amount.aggregate.promptHit; aggTokens += amount.aggregate.tokens;
      // 月度序列（费用按 CNY 计）
      const costCNY = sumCurrencyAmount(cost, "CNY", "amount");
      const tokens = amount.aggregate.tokens;
      const requests = amount.aggregate.request;
      const promptTotal = amount.aggregate.promptMiss + amount.aggregate.promptHit;
      const cacheHitRate = promptTotal > 0 ? amount.aggregate.promptHit / promptTotal : 0;
      monthlySeries.push({ period, costCNY, tokens, requests, cacheHitRate });
    }

    const models = Object.values(modelMap).sort((a, b) => b.tokens - a.tokens || b.request - a.request);
    const keys = Object.values(keyMap).sort((a, b) => b.tokens - a.tokens || b.request - a.request);
    const aggregate = { request: aggRequest, response: aggResponse, promptMiss: aggPromptMiss, promptHit: aggPromptHit, tokens: aggTokens };
    const costMerged = mergeCostByCurrency(collected);

    return {
      period: start === end ? start : `${start}~${end}`,
      start, end, months,
      summary,
      amount: { raw: null, models, keys, days: Object.values(dayByKey), aggregate },
      cost: costMerged,
      monthlySeries,
      debug: {
        auth: { tokenFound: state.tokenSource !== "none", tokenSource: state.tokenSource },
        range: { start, end, monthCount: months.length, seriesCount: monthlySeries.length },
      },
    };
  }

  // 生成 start~end 的月份列表（含首尾），按月升序
  // 参数:
  //   start: string，如 "2025-10"
  //   end: string，如 "2026-09"
  // 返回:
  //   string[]，形如 ["2025-10", ..., "2026-09"]
  function enumerateMonths(start, end) {
    const s = parsePeriod(start);
    const e = parsePeriod(end);
    const months = [];
    let y = s.year;
    let m = s.month;
    while (y < e.year || (y === e.year && m <= e.month)) {
      months.push(`${y}-${m}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return months;
  }

  // 读取面板当前聚合区间（起/止月份）。优先取面板内的双下拉框，否则回退到默认窗口。
  // 起 > 止时自动交换，保证区间合法。
  function getSelectedRange() {
    const startSel = document.querySelector(".dsapi-plus-range-start");
    const endSel = document.querySelector(".dsapi-plus-range-end");
    let start = (startSel && /^\d{4}-\d{1,2}$/.test(startSel.value)) ? startSel.value : "";
    let end = (endSel && /^\d{4}-\d{1,2}$/.test(endSel.value)) ? endSel.value : "";
    if (!start || !end) {
      // [需求 4] 面板尚未渲染下拉框（含 SPA 路由重进、teardown 清空 state 后）时，
      // 直接读取已持久化的区间；无记录或非法时由 loadRangeWindow 回退默认窗口。
      const win = loadRangeWindow();
      start = start || win.start;
      end = end || win.end;
    }
    const toNum = (p) => { const { year, month } = parsePeriod(p); return year * 100 + month; };
    if (toNum(start) > toNum(end)) { const t = start; start = end; end = t; }
    return { start, end };
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

  function renderSkeleton(panel, start, end) {
    // [修改] 原因：面板已渲染过时即使图表暂缺也走轻量更新，避免整面板重建销毁月份下拉
    if (state.charts.length > 0 || panel.dataset.rendered === "1") {
      const startSelect = panel.querySelector(".dsapi-plus-range-start");
      const endSelect = panel.querySelector(".dsapi-plus-range-end");
      if (startSelect) startSelect.value = start;
      if (endSelect) endSelect.value = end;
      const status = panel.querySelector(".dsapi-plus-status");
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
          ${rangeSelectsHtml(start, end)}
          <span class="dsapi-plus-status">加载中...</span>
        </div>
        <div class="dsapi-plus-actions">
          <button type="button" class="dsapi-plus-clear-cache-btn">清除缓存</button>
        </div>
      </div>
      <div class="dsapi-plus-message">正在读取 DeepSeek 用量接口。</div>
    `;
    // 重建后主动恢复鼠标交互，消除 hover 状态丢失导致的闪烁
    panel.style.pointerEvents = "none";
    requestAnimationFrame(() => { panel.style.pointerEvents = ""; });
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

  function renderError(panel, start, end, error) {
    const message = String(error?.message || error || "未知错误");
    const isAuth = /\b(401|403|40002)\b|missing token/i.test(message);
    panel.__dsapiPlusDebug = {
      auth: { tokenFound: state.tokenSource !== "none", tokenSource: state.tokenSource },
      error: message,
    };

    // [修改] 原因：面板已渲染过时走增量错误提示，避免整面板重建销毁月份下拉
    if (state.charts.length > 0 || panel.dataset.rendered === "1") {
      const startSelect = panel.querySelector(".dsapi-plus-range-start");
      const endSelect = panel.querySelector(".dsapi-plus-range-end");
      if (startSelect) startSelect.value = start;
      if (endSelect) endSelect.value = end;
      const status = panel.querySelector(".dsapi-plus-status");
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
          ${rangeSelectsHtml(start, end)}
        </div>
        <div class="dsapi-plus-actions">
          <button type="button" class="dsapi-plus-clear-cache-btn">清除缓存</button>
        </div>
      </div>
      ${errorBannerHTML(message, isAuth)}
    `;
    bindRefresh(panel);
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
      imageHosting: "imgbb",
      imgbbApiKey: "",
      picgoApiKey: "",
      contentOptions: {
        summary: true,
        todayDetail: true,
        monthDetail: true,
        topKeys: 10,
      },
      createdAt: new Date().toISOString(),
      lastSentAt: null,
      lastSentStatus: null,
    };
  }

  // ========== 订阅功能：报告生成 ==========

  function buildSubscriptionReportData(sub, overrideData) {
    const panelData = overrideData || state.lastPanelData;
    if (!panelData) return null;
    // [修复] 原因：区间重构后解构仍是旧字段 period，而下方 month 标签引用 start/end，
    // 抛 ReferenceError: start is not defined，导致预览无响应、发送卡在「发送中」
    const { summary, start, end, amount, cost } = panelData;

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
    // [修复] 原因：区间聚合后 days 日期为完整 YYYY-MM-DD，跨月区间下旧的正则（仅匹配日号）
    // 会把其他月份同日号误判为「今天」，改为精确匹配完整日期
    const now = new Date();
    const todayDate = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-" + String(now.getUTCDate()).padStart(2, "0");
    let todayTotalCost = 0;
    for (const costBlock of cost) {
      if (costBlock.currency !== "CNY") continue;
      for (const dayCost of (costBlock.days || [])) {
        if (String(dayCost.date || "") === todayDate) {
          todayTotalCost += (dayCost.amount || 0);
        }
      }
    }
    // 如果 cost API 没有今日数据，用均价估算
    if (!todayTotalCost && totalCost > 0 && totalUsage > 0) {
      const avgPerToken = totalCost / totalUsage;
      for (const day of (amount.days || [])) {
        if (String(day.date || "") === todayDate && day.tokens > 0) {
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
    var topCount = sub.contentOptions.topKeys || 10;
    // 确保 topCount 为正整数
    if (typeof topCount !== "number" || topCount < 1) topCount = 10;
    // 从 keyDetailData 中筛选密钥出已选中的 key（有数据的）
    var filteredKeyData = [];
    if (sub.keyFilterMode === "selected" && sub.selectedKeys.length) {
      filteredKeyData = keyDetailData.filter(function(item) { return sub.selectedKeys.includes(item.key); });
    } else {
      filteredKeyData = keyDetailData;
    }
    // 将已有的 key 数据映射为输出格式
    var monthKeys = filteredKeyData.map(function(k) {
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
    // 如果是指定 key 模式，为选中的但无数据的 key 补充用量为 0 的条目
    if (sub.keyFilterMode === "selected" && sub.selectedKeys.length) {
      var existingMonthKeys = {};
      for (var _mke = 0; _mke < monthKeys.length; _mke++) {
        existingMonthKeys[monthKeys[_mke].key] = true;
      }
      for (var _msk = 0; _msk < sub.selectedKeys.length; _msk++) {
        if (!existingMonthKeys[sub.selectedKeys[_msk]]) {
          monthKeys.push({
            key: sub.selectedKeys[_msk],
            requestCount: 0,
            inputMissTokens: 0,
            inputHitTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            totalCost: 0,
            cacheHitRate: 0,
          });
        }
      }
    }
    // 按总费用降序排列，再取 topCount
    monthKeys.sort(function(a, b) { return b.totalCost - a.totalCost; });
    monthKeys = monthKeys.slice(0, topCount);

    // 当日 Key 明细 — 从 keyDetailDailyData 提取今日各 Key 费用，并合并月明细字段
    var todayKeys = [];
    var dailyData = state.keyDetailDailyData;
    if (dailyData && dailyData.dates && dailyData.series) {
      var dates = dailyData.dates;
      // 复用上方已声明的 todayDate（YYYY-MM-DD，本次重构统一为完整日期匹配）
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
        // 如果是指定 key 模式，为选中的但无今日数据的 key 补充用量为 0 的条目
        if (sub.keyFilterMode === "selected" && sub.selectedKeys.length) {
          var existingTodayKeys = {};
          for (var _tek = 0; _tek < todayByKey.length; _tek++) {
            existingTodayKeys[todayByKey[_tek].key] = true;
          }
          for (var _tsk = 0; _tsk < sub.selectedKeys.length; _tsk++) {
            if (!existingTodayKeys[sub.selectedKeys[_tsk]]) {
              todayByKey.push({
                key: sub.selectedKeys[_tsk],
                todayCost: 0,
                requestCount: 0,
                totalTokens: 0,
                cacheHitRate: 0,
              });
            }
          }
        }
        todayByKey.sort(function(a, b) { return b.todayCost - a.todayCost; });
        todayKeys = todayByKey.slice(0, topCount);
      }
    }

    return {
      month: (start && end) ? (start === end ? start : `${start} ~ ${end}`) : (now.getUTCFullYear() + "-" + (now.getUTCMonth() + 1)),
      generatedAt: new Date(now.getTime() + 8 * 3600000).toISOString().replace("T", " ").substring(0, 19) + " (北京时间)",
      summary: { totalCost: totalCost, totalUsage: totalUsage, todayCost: todayTotalCost, avgCost: avgCost, balance: walletCnyBalance, cacheHitRate: overallCacheHitRate },
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
      lines.push("");
    }

    if (sub.contentOptions.todayDetail && data.todayKeys) {
      lines.push("## 🔑 当日 Key 明细 (Top " + Math.min(data.todayKeys.length, (sub.contentOptions.topKeys || 10)) + ")");
      lines.push("| Key | 总Token | 今日费用 |");
      lines.push("|-----|---------|----------|");
      if (data.todayKeys.length) {
        for (var _ki = 0; _ki < data.todayKeys.length; _ki++) {
          var tk = data.todayKeys[_ki];
          lines.push("| " + (tk.key || "未知") + " | " + formatInteger(tk.totalTokens) + " | " + formatCnyAmount(tk.todayCost) + " |");
        }
      } else {
        lines.push("| — | — | — |");
      }
      lines.push("");
    }

    if (sub.contentOptions.monthDetail && data.monthKeys && data.monthKeys.length) {
      lines.push("## 🔑 Key 月度总明细 (Top " + data.monthKeys.length + ")");
      lines.push("| Key | 总Token数 | 总费用 |");
      lines.push("|-----|-----------|--------|");
      for (var _kj = 0; _kj < data.monthKeys.length; _kj++) {
        var item = data.monthKeys[_kj];
        lines.push("| " + (item.key || "未知") + " | " + formatInteger(item.totalTokens) + " | " + formatCnyAmount(item.totalCost) + " |");
      }
      lines.push("");
    }

    lines.push("---\n");
    lines.push("📬 *由 DeepSeek Usage Plus 自动生成*");
    return lines.join("\n");
  }

  // ========== 订阅功能：发送 ==========

  async function sendSubscriptionReport(sub, showPreview, overrideData) {
    // [修复] 原因：内部任何异常（如数据构建报错）原样抛出会让「立即发送」按钮永远停在「发送中」，
    // 改为捕获后返回失败结果，由调用方展示诊断信息
    try {
      return await _sendSubscriptionReportInner(sub, showPreview, overrideData);
    } catch (err) {
      console.error("[DeepSeek Usage Panel Plus] 发送订阅报告异常:", err);
      return { success: false, error: (err && err.message) ? err.message : String(err) };
    }
  }

  async function _sendSubscriptionReportInner(sub, showPreview, overrideData) {
    const reportData = buildSubscriptionReportData(sub, overrideData);
    if (!reportData) return { success: false, error: "暂无数据，请先刷新数据" };

    let markdown;
    if (sub.contentFormat === "screenshot") {
      var apiKey = sub.imageHosting === "picgo" ? (sub.picgoApiKey || "") : (sub.imgbbApiKey || "");
      if (apiKey && apiKey.trim()) {
        // 截图 + 图床上传
        const screenshotResult = await captureReportScreenshot(sub, reportData);
        if (screenshotResult.success) {
          var uploadResult;
          if (sub.imageHosting === "picgo") {
            uploadResult = await uploadToPicgo(screenshotResult.imageBlob, apiKey);
          } else {
            uploadResult = await uploadScreenshot(screenshotResult.imageBlob, apiKey);
          }
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
        timeout: 30000,
        onload: function (resp) {
          try {
            var result = JSON.parse(resp.responseText);
            if (sub.webhookType === "dingtalk") {
              if (result.errcode === 0) { resolve({ success: true, verified: true }); return; }
              // [修改] errcode -1 (系统繁忙) 视为成功发送，钉钉会延迟推送但消息已入队
              if (result.errcode === -1) { resolve({ success: true, verified: true, note: "钉钉系统繁忙，消息已入队" }); return; }
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
        ontimeout: function () { console.error("[DeepSeek Usage Panel Plus] Webhook 请求超时"); resolve({ success: false, error: "请求超时（30秒）" }); },
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
    closeBtn.textContent = "关闭面板";
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
    // [修改] 截图配色跟随当前主题：深色模式下生成深色报告截图（背景/文字/表格/边框）
    const isDark = getBodyDark();
    const c = isDark
      ? { bg: "#1a1a2e", text: "#e0e0e0", sub: "#9ea3b2", border: "#2a2a40", head: "#23233a", foot: "#7a7f8f", canvasBg: "#1a1a2e" }
      : { bg: "#fff", text: "#1a1a2e", sub: "#888", border: "#eee", head: "#f5f5f5", foot: "#aaa", canvasBg: "#ffffff" };
    const div = document.createElement("div");
    div.style.cssText = "position: absolute; left: -9999px; top: 0; width: 420px; padding: 20px 16px; background: " + c.bg + "; color: " + c.text + "; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; line-height: 1.6;";

    // 构建报告 HTML（与 Markdown 内容对应）
    let html = `<h1 style="font-size: 20px; margin: 0 0 4px;">📊 DeepSeek 用量报告</h1>`;
    html += `<p style="color: ${c.sub}; font-size: 12px; margin: 0 0 16px;">订阅: ${escapeHtml(sub.name)} ｜ 数据月份: ${reportData.month} ｜ 生成时间: ${reportData.generatedAt}</p>`;

    if (sub.contentOptions.summary) {
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">💰 费用摘要</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px;">';
      html += '<tr>' + summaryCell("当日费用", formatCnyAmount(reportData.summary.todayCost), c) + summaryCell("当月费用", formatCnyAmount(reportData.summary.totalCost), c) + summaryCell("钱包余额", formatCnyAmount(reportData.summary.balance), c) + '</tr>';
      html += '</table>';
    }

    if (sub.contentOptions.todayDetail && reportData.todayKeys) {
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">🔑 当日 Key 明细 (Top ' + Math.min(reportData.todayKeys.length, (sub.contentOptions.topKeys || 10)) + ')</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px; border: 1px solid ' + c.border + ';">';
      html += '<tr style="background: ' + c.head + ';"><th style="padding:6px 8px; text-align:left;">Key</th><th style="padding:6px 8px; text-align:right;">总Token</th><th style="padding:6px 8px; text-align:right;">今日费用</th></tr>';
      if (reportData.todayKeys.length) {
        for (var _kt = 0; _kt < reportData.todayKeys.length; _kt++) {
          var tk = reportData.todayKeys[_kt];
          html += '<tr><td style="padding:4px 8px; border-top:1px solid ' + c.border + ';">' + escapeHtml(tk.key) + '</td><td style="padding:4px 8px; border-top:1px solid ' + c.border + '; text-align:right;">' + formatInteger(tk.totalTokens) + '</td><td style="padding:4px 8px; border-top:1px solid ' + c.border + '; text-align:right;">' + formatCnyAmount(tk.todayCost) + '</td></tr>';
        }
      } else {
        html += '<tr><td style="padding:4px 8px; border-top:1px solid ' + c.border + '; text-align:center;" colspan="3">今日暂无数据</td></tr>';
      }
      html += '</table>';
    }

    if (sub.contentOptions.monthDetail && reportData.monthKeys && reportData.monthKeys.length) {
      html += '<h2 style="font-size: 15px; margin: 16px 0 8px;">🔑 Key 月度总明细 (Top ' + reportData.monthKeys.length + ')</h2>';
      html += '<table style="width:100%; border-collapse: collapse; font-size: 12px; border: 1px solid ' + c.border + ';">';
      html += '<tr style="background: ' + c.head + ';"><th style="padding:6px 8px; text-align:left;">Key</th><th style="padding:6px 8px; text-align:right;">总Token</th><th style="padding:6px 8px; text-align:right;">总费用</th></tr>';
      for (var _km = 0; _km < reportData.monthKeys.length; _km++) {
        var mk = reportData.monthKeys[_km];
        html += '<tr><td style="padding:4px 8px; border-top:1px solid ' + c.border + ';">' + escapeHtml(mk.key) + '</td><td style="padding:4px 8px; border-top:1px solid ' + c.border + '; text-align:right;">' + formatInteger(mk.totalTokens) + '</td><td style="padding:4px 8px; border-top:1px solid ' + c.border + '; text-align:right;">' + formatCnyAmount(mk.totalCost) + '</td></tr>';
      }
      html += '</table>';
    }

    html += `<hr style="border: none; border-top: 1px solid ${c.border}; margin: 16px 0;">`;
    html += `<p style="color: ${c.foot}; font-size: 11px;">由 DeepSeek Usage Plus 自动生成</p>`;

    div.innerHTML = html;
    document.body.appendChild(div);

    try {
      if (typeof html2canvas === "undefined") {
        // html2canvas 未加载，动态加载
        await loadHtml2Canvas();
      }
      const canvas = await html2canvas(div, { scale: 2, useCORS: true, backgroundColor: c.canvasBg });
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

  /**
   * 上传截图到 PicGo（picgo.net）免费图床
   * @param {Blob} imageBlob - 截图 Blob
   * @param {string} apiKey - PicGo API Key
   * @returns {Promise<{success: boolean, url?: string, error?: string}>}
   */
  async function uploadToPicgo(imageBlob, apiKey) {
    var base64 = await new Promise(function (res) {
      var reader = new FileReader();
      reader.onload = function () { res(reader.result.split(",")[1]); };
      reader.readAsDataURL(imageBlob);
    });
    var maxRetries = 3;
    for (var retry = 0; retry < maxRetries; retry++) {
      if (retry > 0) await new Promise(function (r) { setTimeout(r, 2000); });
      var result = await new Promise(function (resolve) {
        GM.xmlHttpRequest({
          method: "POST",
          url: "https://www.picgo.net/api/1/upload",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          data: "source=" + encodeURIComponent(base64) + "&format=json&key=" + encodeURIComponent(apiKey),
          timeout: 15000,
          onload: function (resp) {
            try {
              var d = JSON.parse(resp.responseText);
              if (d.status_code === 200 && d.image && d.image.url) {
                resolve({ success: true, url: d.image.url });
              } else {
                resolve({ success: false, error: "PicGo 返回错误: " + (d.status_txt || "未知") });
              }
            } catch (e) {
              resolve({ success: false, error: "解析响应失败: " + e.message });
            }
          },
          onerror: function () { resolve({ success: false, error: "请求失败: 网络错误" }); },
          ontimeout: function () { resolve({ success: false, error: "请求超时（15秒）" }); },
        });
      });
      if (result.success && result.url) return { success: true, url: result.url };
      if (retry < maxRetries - 1) {
        console.log("[DeepSeek Usage Panel Plus] PicGo 上传失败，第 " + (retry + 1) + " 次重试...");
      }
    }
    return { success: false, error: "PicGo 上传失败（已重试 " + maxRetries + " 次）" };
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

  function summaryCell(label, value, c) {
    // [修改] 支持传入配色对象，截图随主题切换深色/浅色
    c = c || { border: "#eee", sub: "#888" };
    return '<td style="padding: 8px 12px; border: 1px solid ' + c.border + '; text-align: center; min-width: 100px;">' +
      '<div style="color: ' + c.sub + '; font-size: 11px;">' + label + '</div>' +
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
          <input type="checkbox" id="sub-select-all" onclick="var p=document.getElementById('${PANEL_ID}');if(p&&p._subSelectAll)p._subSelectAll();"> 全部选择
        </label>
        <span id="sub-select-count" style="font-size:11px;color:var(--dsapi-plus-muted);">已选 0</span>
        <button type="button" class="dsapi-plus-subscribe-batch-del-btn" onclick="var p=document.getElementById('${PANEL_ID}');if(p&&p._subBatchDelete)p._subBatchDelete();">删除已选</button>
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
              <input type="checkbox" class="sub-select-check" data-index="${i}" title="选择以批量删除" onchange="var p=document.getElementById('${PANEL_ID}');if(p&&p._subSelectUpdate)p._subSelectUpdate();">
              <label class="toggle-switch">
                <input type="checkbox" ${s.enabled ? "checked" : ""} data-action="toggle" data-index="${i}">
                <span class="toggle-slider"></span>
              </label>
              <span>${escapeHtml(s.name)}</span>
              <span class="${statusClass}" style="font-size:11px;">${statusText}</span>
            </div>
            <div class="dsapi-plus-subscribe-item-actions">
              <button data-action="edit" data-index="${i}">编辑配置</button>
              <button data-action="preview" data-index="${i}" class="dsapi-plus-subscribe-preview-btn">预览报告</button>
              <button data-action="send" data-index="${i}" class="dsapi-plus-subscribe-send-btn">立即发送</button>
              <button data-action="delete" data-index="${i}" class="dsapi-plus-subscribe-del-btn">删除配置</button>
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

  // ========== 订阅功能：编辑配置表单 ==========

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

    // 图床配置（截图模式需要）
    const hostingDisplay = s.contentFormat === "screenshot" ? "" : "display:none;";
    html += `<div id="sub-form-hosting-group" style="${hostingDisplay}">
      <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label">图床类型</div>
        <div class="dsapi-plus-subscribe-form-control">
          <select id="sub-form-hosting">
            <option value="imgbb" ${s.imageHosting === "imgbb" ? "selected" : ""}>ImgBB（国际）</option>
            <option value="picgo" ${s.imageHosting === "picgo" ? "selected" : ""}>PicGo（国内推荐）</option>
          </select>
        </div>
      </div>
        <div class="dsapi-plus-subscribe-form-row">
        <div class="dsapi-plus-subscribe-form-label" id="sub-form-hosting-key-label">API Key</div>
        <div class="dsapi-plus-subscribe-form-control">
          <div>
            <input type="text" id="sub-form-hosting-key" value="${escapeHtml(s.imageHosting === "picgo" ? (s.picgoApiKey || '') : (s.imgbbApiKey || ''))}" placeholder="${s.imageHosting === "picgo" ? "在 picgo.net 注册获取 API Key" : "在 imgbb.com 注册获取 API Key"}" style="width:100%;">
          </div>
          <div id="sub-form-hosting-status" style="font-size:11px;margin-top:4px;min-height:16px;"></div>
          <div style="font-size:10px;color:var(--dsapi-plus-muted);margin-top:2px;">截图模式需要配置图床 API Key，否则自动降级为 Markdown 文本</div>
        </div>
      </div>
    </div>`;

    // Key 筛选密钥
    const keyNames = getAvailableKeyNames();
    html += `<div class="dsapi-plus-subscribe-form-row">
      <div class="dsapi-plus-subscribe-form-label">Key 筛选密钥</div>
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
      html += `<span style="color: var(--dsapi-plus-muted);">暂无 Key 数据，请先刷新数据导入 Key 明细</span>`;
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
      ["todayDetail", "当日明细"],
      ["monthDetail", "月度明细"],
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
      <button type="button" class="dsapi-plus-subscribe-save-btn" data-action="save">保存配置</button>
      <button type="button" class="dsapi-plus-subscribe-cancel-btn" data-action="cancel">取消编辑</button>
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
    // 多选删除配置功能
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

    // 编辑配置
    panel.querySelectorAll("[data-action='edit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const sub = state.subscriptions[idx];
        if (!sub) return;
        showStaticForm(idx);
      });
    });

    // 删除配置
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
        // [修复] 原因：构建报告数据抛异常时预览按钮无任何响应，改为捕获并提示
        var reportData;
        try {
          reportData = buildSubscriptionReportData(sub);
        } catch (err) {
          console.error("[DeepSeek Usage Panel Plus] 生成预览失败:", err);
          alert("生成预览失败：" + ((err && err.message) ? err.message : String(err)));
          return;
        }
        if (!reportData) { alert("暂无数据，请先刷新数据"); return; }
        previewBtn.disabled = true;
        previewBtn.textContent = "生成中…";
        // 预览总是用截图展示
        if (sub.contentFormat === "screenshot") {
          captureReportScreenshot(sub, reportData).then(function (sr) {
            previewBtn.disabled = false;
            previewBtn.textContent = "预览报告";
            if (sr.success) {
              showReportInPanel(null, sr.imageUrl);
            } else {
              showReportInPanel(buildMarkdownReport(sub, reportData), null);
            }
          });
        } else {
          showReportInPanel(buildMarkdownReport(sub, reportData), null);
          previewBtn.disabled = false;
          previewBtn.textContent = "预览报告";
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
          let diagHtml = '<div class="dsapi-plus-subscribe-panel-header"><h2>🔴 发送失败 — 诊断信息</h2><button class="dsapi-plus-subscribe-panel-close" onclick="this.closest(\'.dsapi-plus-subscribe-overlay\').remove()">关闭面板</button></div>';
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
        state.subscriptions[eidx].lastSentStatus = null;
        // [修改] 编辑配置保存时：若当天计划时间已过，标记为已检查，避免 catch-up 补发
        var _now = new Date();
        var _subMin = formData.scheduleHour * 60 + formData.scheduleMinute;
        var _nowMin = _now.getHours() * 60 + _now.getMinutes();
        if (formData.scheduleType !== "interval" && _nowMin >= _subMin) {
          state.subscriptions[eidx].lastSentAt = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate(), 0, 0, 0).toISOString();
          state.subscriptionLastSent[state.subscriptions[eidx].id] = state.subscriptions[eidx].lastSentAt;
        } else {
          state.subscriptions[eidx].lastSentAt = null;
          delete state.subscriptionLastSent[state.subscriptions[eidx].id];
        }
      } else {
        formData.id = createSubscriptionId();
        formData.createdAt = new Date().toISOString();
        formData.lastSentAt = new Date().toISOString(); // 新订阅标记已发送，防止定时器立即触发
        state.subscriptions.push(formData);
      }
      saveSubscriptionLastSent();
      saveSubscriptions();
      updateSubscribeBtnState();
      // [修改] 编辑配置结束立即更新倒计时显示，让用户看到新的计划时间
      updateSubscriptionCountdowns();
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
      imageHosting: getName("#sub-form-hosting"),
      imgbbApiKey: getName("#sub-form-hosting") === "picgo" ? "" : getName("#sub-form-hosting-key"),
      picgoApiKey: getName("#sub-form-hosting") === "picgo" ? getName("#sub-form-hosting-key") : "",
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
        todayDetail: contentOpts.todayDetail !== false,
        monthDetail: contentOpts.monthDetail !== false,
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
    // 记录编辑配置面板状态为展开
    state.subscriptionEditVisible = true;
    saveSubscriptionEditVisible();
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
          state.subscriptions[eidx].lastSentStatus = null;
          // [修改] 编辑配置保存时：若当天计划时间已过，标记为已检查，避免 catch-up 补发
          var _now = new Date();
          var _subMin = formData.scheduleHour * 60 + formData.scheduleMinute;
          var _nowMin = _now.getHours() * 60 + _now.getMinutes();
          if (formData.scheduleType !== "interval" && _nowMin >= _subMin) {
            state.subscriptions[eidx].lastSentAt = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate(), 0, 0, 0).toISOString();
            state.subscriptionLastSent[state.subscriptions[eidx].id] = state.subscriptions[eidx].lastSentAt;
          } else {
            state.subscriptions[eidx].lastSentAt = null;
            delete state.subscriptionLastSent[state.subscriptions[eidx].id];
          }
        } else {
          formData.id = createSubscriptionId();
          formData.createdAt = new Date().toISOString();
          formData.lastSentAt = new Date().toISOString(); // 新订阅标记已发送，防止定时器立即触发
          state.subscriptions.push(formData);
        }
        saveSubscriptionLastSent();
        saveSubscriptions();
        updateSubscribeBtnState();
        // [修改] 编辑配置结束立即更新倒计时显示，让用户看到新的计划时间
        updateSubscriptionCountdowns();
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
        var hostingGroup = formEl.querySelector("#sub-form-hosting-group");
        if (hostingGroup) hostingGroup.style.display = formatSelect.value === "screenshot" ? "" : "none";
      });
    }
    // 图床类型切换
    var hostingSelect = formEl.querySelector("#sub-form-hosting");
    if (hostingSelect) {
      hostingSelect.addEventListener("change", function() {
        var keyInput = formEl.querySelector("#sub-form-hosting-key");
        var label = formEl.querySelector("#sub-form-hosting-key-label");
        var statusEl = formEl.querySelector("#sub-form-hosting-status");
        if (statusEl) statusEl.textContent = "";
        if (hostingSelect.value === "picgo") {
          if (label) label.textContent = "PicGo Key";
          if (keyInput) keyInput.placeholder = "在 picgo.net 注册获取 API Key";
        } else {
          if (label) label.textContent = "ImgBB Key";
          if (keyInput) keyInput.placeholder = "在 imgbb.com 注册获取 API Key";
        }
      });
    }
    // Key 筛选密钥模式切换
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
    // 记录编辑配置面板状态为折叠
    state.subscriptionEditVisible = false;
    saveSubscriptionEditVisible();
    // 恢复列表显示：刷新数据内联内容
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
      console.error("[DeepSeek Usage Panel Plus] 刷新数据订阅面板错误:", e);
    }
  }

  // ========== 订阅功能：定时检查 ==========

  function startSubscriptionCheckTimer() {
    stopSubscriptionCheckTimer();
    // 首次 500ms 后检查，后续每 30 秒递归（统一 tracking，防止重复）
    function scheduleNext() {
      state.subscriptionCheckTimer = setTimeout(function () {
        try { checkSubscriptionSchedule(); } catch (e) { console.error("[DeepSeek Usage Panel Plus] 订阅检查异常:", e); }
        scheduleNext();
      }, 30000);
    }
    state.subscriptionCheckTimer = setTimeout(function () {
      try { checkSubscriptionSchedule(); } catch (e) { console.error("[DeepSeek Usage Panel Plus] 订阅检查初始异常:", e); }
      scheduleNext();
    }, 500);
  }

  function stopSubscriptionCheckTimer() {
    if (state.subscriptionCheckTimer) {
      clearTimeout(state.subscriptionCheckTimer);
      state.subscriptionCheckTimer = 0;
    }
  }

  var _checkingSubscription = false;

  async function checkSubscriptionSchedule() {
    if (_checkingSubscription) return;
    _checkingSubscription = true;
    try {
      const now = new Date();
      for (const sub of state.subscriptions) {
      if (!sub.enabled) continue;
      const lastSent = state.subscriptionLastSent[sub.id] ? new Date(state.subscriptionLastSent[sub.id]) : null;
      if (shouldSendNow(sub, now, lastSent)) {
        console.log("[DeepSeek Usage Panel Plus] 订阅检查触发:", sub.name, "时间:", now.toLocaleTimeString());
        // 需求 4：面板展示区间不是当天（区间终点 != 当前月）时，发送前主动拉取今日最新数据覆盖，
        // 确保订阅报告始终基于今天实际用量；面板即当天时仅刷新 Key 明细保证最新。
        let reportOverride = null;
        const panelData = state.lastPanelData;
        const panelIsToday = !!(panelData && panelData.isCurrentPeriod);
        if (!panelIsToday) {
          try {
            const cur = currentMonthPeriod();
            reportOverride = await loadRange(cur, cur, null);
            await fetchKeyDetailFromExport(cur);
          } catch (e) {
            console.warn("[DeepSeek Usage Panel Plus] 订阅发送前拉取今日数据失败，回退到面板数据", e);
          }
        } else {
          // 面板已含当前月：按面板区间整段刷新 Key 明细（历史月走缓存，仅当前月按 TTL 可能重拉）
          try {
            const rg = getSelectedRange();
            await fetchKeyDetailFromExport(rg.start, rg.end);
          } catch (e) { /* 刷新失败不影响发送 */ }
        }
        sendSubscriptionReport(sub, undefined, reportOverride).then(result => {
          if (result.success) {
            sub.lastSentAt = new Date().toISOString();
            sub.lastSentStatus = "success";
            state.subscriptionLastSent[sub.id] = sub.lastSentAt;
          } else {
            console.error("[DeepSeek Usage Panel Plus] 订阅发送失败:", sub.name, result.error);
          }
          saveSubscriptions();
          saveSubscriptionLastSent();
          // [修改] 发送完成后刷新数据 UI，确保倒计时和状态显示同步更新
          updateSubscriptionCountdowns();
          refreshSubscribeInlineContent();
        }).catch(function (err) {
          console.error("[DeepSeek Usage Panel Plus] 订阅发送异常:", sub.name, err);
          // 发送异常时不记录 lastSent，允许下次重试
        });
      }
    }
    } finally {
      _checkingSubscription = false;
    }
  }

  function shouldSendNow(sub, now, lastSent) {
    // [修改] 防抖：同一订阅 10 秒内已发送，skip 本次（避免高频调用钉钉限流）
    if (lastSent && (now.getTime() - lastSent.getTime()) < 10000) return false;

    var subMinHour = sub.scheduleHour * 60 + sub.scheduleMinute;
    var nowMinHour = now.getHours() * 60 + now.getMinutes();

    switch (sub.scheduleType) {
      case "interval":
        if (!lastSent) return true;
        return (now.getTime() - lastSent.getTime()) >= sub.scheduleInterval;
      case "daily":
        if (lastSent && lastSent.toDateString() === now.toDateString()) return false;
        return nowMinHour >= subMinHour;
      case "weekly":
        if (lastSent && lastSent.toDateString() === now.toDateString()) return false;
        return now.getDay() === sub.scheduleDayOfWeek && nowMinHour >= subMinHour;
      case "monthly":
        if (lastSent && lastSent.toDateString() === now.toDateString()) return false;
        return now.getDate() === sub.scheduleDayOfMonth && nowMinHour >= subMinHour;
      default:
        return false;
    }
  }

  // 由 loadRange 的聚合结果构建面板渲染数据。整个面板按「起止区间」聚合：
  // 汇总卡改为区间口径（区间累计费用/月均/最高消费月/区间累计Token/钱包余额），
  // 模型分布/Key费用/每日明细均由聚合后的 amount/cost 直接消费，monthlySeries 驱动月度趋势图。
  function buildPanelData(data) {
    const { period, summary, amount, cost, monthlySeries, start, end, months } = data;

    const sortedModels = amount.models.slice().sort((a, b) => b.tokens - a.tokens || b.request - a.request);
    const sortedKeys = amount.keys.length
      ? amount.keys.slice().sort((a, b) => b.tokens - a.tokens || b.request - a.request)
      : [];
    const tokenTotal = amount.aggregate.tokens;
    const monthCnyCost = sumCurrencyAmount(cost, "CNY", "amount"); // 区间累计费用（CNY）
    const cnyCostBreakdown = getCostBreakdown(cost, "CNY");
    const walletCnyBalance =
      sumCurrencyAmount(summary.normalWallets, "CNY", "balance") +
      sumCurrencyAmount(summary.bonusWallets, "CNY", "balance");
    const averageCostPerMillion = computeAverageCostPerMillion({
      preferredCost: monthCnyCost,
      preferredTokens: tokenTotal,
      fallbackCost: 0,
      fallbackTokens: 0,
    });
    const averageInputCostPerMillion = computeAverageCostPerMillion({
      preferredCost: cnyCostBreakdown.input,
      preferredTokens: amount.aggregate.promptMiss + amount.aggregate.promptHit,
      fallbackCost: 0,
      fallbackTokens: 0,
    });
    const averageOutputCostPerMillion = computeAverageCostPerMillion({
      preferredCost: cnyCostBreakdown.output,
      preferredTokens: amount.aggregate.response,
      fallbackCost: 0,
      fallbackTokens: 0,
    });
    const averageCostDetail = `输入 ${formatCnyAmount(averageInputCostPerMillion)} /1M · 输出 ${formatCnyAmount(averageOutputCostPerMillion)} /1M`;

    // 区间汇总卡：月均按窗口内实际月份数计算
    const monthCount = (months && months.length) || (monthlySeries && monthlySeries.length) || 1;
    const rangeCostTotal = monthCnyCost;
    const rangeAvgCost = monthCount > 0 ? rangeCostTotal / monthCount : 0;
    let rangePeakCost = 0, rangePeakPeriod = "";
    for (const item of (monthlySeries || [])) {
      if ((item.costCNY || 0) > rangePeakCost) { rangePeakCost = item.costCNY || 0; rangePeakPeriod = item.period; }
    }
    const rangeTokenTotal = tokenTotal;
    const usageInput = amount.aggregate.promptMiss + amount.aggregate.promptHit;
    const usageDetail = `输入 ${formatInteger(usageInput)} tokens · 输出 ${formatInteger(amount.aggregate.response)} tokens`;

    const now = new Date();
    const nowPeriod = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
    const isCurrentPeriod = end === nowPeriod; // 区间包含当前月（订阅「补拉今日数据」判断使用）

    const updateTime = new Date().toLocaleTimeString("zh-CN");

    // 条形图高度：每横条 = 表格行高 36px + grid上下边距 40px
    const keyChartHeight = sortedKeys.length ? Math.max(100, sortedKeys.length * 36 + 40) : 160;
    const monthRangeLabel = `${start} ~ ${end}（${monthCount} 个月）`;
    const themeMeta = themeModeMeta(); // 主题切换按钮的图标/文案/提示

    const html = `
      <div class="dsapi-plus-head">
        <div class="dsapi-plus-title">
          <strong>扩展用量</strong>
          ${rangeSelectsHtml(start, end)}
          <span class="dsapi-plus-status">已更新 ${escapeHtml(updateTime)}</span>
        </div>
        <div class="dsapi-plus-actions">
          <div class="dsapi-plus-auto-refresh-wrap" style="position:relative;display:inline-block;">
            <button type="button" class="dsapi-plus-auto-refresh-btn" style="margin-left:4px;">自动刷新${state.autoRefreshInterval > 0 ? ' · ' + getAutoRefreshLabel(state.autoRefreshInterval) : ''}</button>
            <div class="dsapi-plus-auto-refresh-dropdown">
              ${AUTO_REFRESH_INTERVALS.map(i => `<button type="button" data-value="${i.value}"${state.autoRefreshInterval === i.value ? ' class="active"' : ''}>${i.label}</button>`).join('')}
            </div>
          </div>
          <button type="button" class="dsapi-plus-toggle-native-btn${state.nativeContentVisible ? ' active' : ''}" style="margin-left:4px;">原始视图</button>
          <button type="button" class="dsapi-plus-toggle-compact-btn${state.compactViewVisible ? ' active' : ''}" style="margin-left:4px;">精简视图</button>
          <button type="button" class="dsapi-plus-clear-cache-btn" style="margin-left:4px;">清除缓存</button>
          <button type="button" class="dsapi-plus-theme-btn${state.themeMode !== 'auto' ? ' active' : ''}" style="margin-left:4px;" title="${themeMeta.title}">${themeMeta.icon} ${themeMeta.text}</button>
        </div>
      </div>

      <div class="dsapi-plus-subscribe-section" style="margin-top:16px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="font-size:14px;font-weight:600;flex-shrink:0;">📬 订阅管理</div>
          <span style="font-size:11px;color:var(--dsapi-plus-muted);flex-shrink:0;">${getActiveSubscriptionCount()} 个活跃订阅</span>
          <div style="flex:1;"></div>
          <button type="button" class="dsapi-plus-subscribe-btn${state.subscriptionVisible ? ' active' : ''}">订阅面板</button>
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
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.models ? ' active' : ''}" data-section="models">模型用量</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.keyDetailVisible ? ' active' : ''}" data-section="keyDetail">Key明细</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.dailyDetailVisible ? ' active' : ''}" data-section="dailyDetail">每日明细</button>
              <button type="button" class="dsapi-plus-toggle-section-btn${state.sectionVisible.monthTrend ? ' active' : ''}" data-section="monthTrend">月度趋势</button>
            </div>
          </div>
          ${summaryItemsHtml({ rangeCostTotal, rangeAvgCost, rangeTokenTotal, monthRangeLabel, rangePeakCost, rangePeakPeriod, averageCostPerMillion, averageCostDetail, walletCnyBalance })}
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
                  : '<div class="dsapi-plus-message">当前区间暂无请求或 Token 用量。</div>'
              }
            </div>
            <div class="dsapi-plus-model-donut">
              ${chartHeading("模型分布", sortedModels.length ? `${sortedModels.length} 个活跃模型` : "暂无模型用量")}
              <div class="dsapi-plus-chart-frame">
                ${sortedModels.length ? '<div class="dsapi-plus-chart" data-dsapi-chart="models"></div>' : '<div class="dsapi-plus-message">当前区间暂无模型用量。</div>'}
              </div>
            </div>
          </div>
        </div>

        <div class="dsapi-plus-section" data-section="keyDetail" style="display:${state.keyDetailVisible ? '' : 'none'};">
          <div class="dsapi-plus-section-head">
            <div class="dsapi-plus-section-title">🔑 Key 明细</div>
            <span class="dsapi-plus-section-meta">${sortedKeys.length ? `${sortedKeys.length} 个活跃 Key` : "暂无 Key 用量"}</span>
            <div style="display:flex;gap:8px;margin-left:auto;">
              <div class="dsapi-plus-key-filter-wrap" style="position:relative;">
                <button type="button" class="dsapi-plus-key-filter-btn">筛选密钥${state.keyFilter && state.keyFilter.mode === 'selected' && state.keyFilter.keys?.length ? ` (${state.keyFilter.keys.length})` : ''}</button>
                <div class="dsapi-plus-key-filter-dropdown" style="display:none;position:absolute;top:100%;right:0;z-index:1000;background:var(--dsapi-plus-bg,#fff);border:1px solid var(--dsapi-plus-muted);border-radius:6px;padding:6px;min-width:160px;max-height:260px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.12);">
                  <div style="display:flex;gap:4px;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid var(--dsapi-plus-muted);">
                    <button type="button" class="dsapi-plus-filter-all-btn" style="flex:1;border:0;border-radius:4px;background:rgba(2,14,54,0.05);cursor:pointer;font-size:12px;padding:3px 6px;">全部选择</button>
                    <button type="button" class="dsapi-plus-filter-none-btn" style="flex:1;border:0;border-radius:4px;background:rgba(2,14,54,0.05);cursor:pointer;font-size:12px;padding:3px 6px;">取消全部</button>
                  </div>
                  <div class="dsapi-plus-filter-list"></div>
                </div>
              </div>
              <button type="button" class="dsapi-plus-group-model-btn${state.groupByModel ? ' active' : ''}">${state.groupByModel ? 'Key分组' : '模型分组'}</button>
              <button type="button" class="dsapi-plus-toggle-key-btn${state.keyTableVisible ? ' active' : ''}">明细表格</button>
              <button type="button" class="dsapi-plus-cost-chart-btn${state.keyDetailChartVisible ? ' active' : ''}">费用分布</button>
            </div>
          </div>
          ${sortedKeys.length ? renderKeyTable(sortedKeys, cost, state.keyTableVisible) : '<div class="dsapi-plus-message">当前区间暂无 Key 级别用量数据，或 API 未返回 Key 信息。</div>'}
          <div class="dsapi-plus-key-chart" style="display:${state.keyDetailChartVisible !== false ? '' : 'none'};margin-top:8px;">
            ${chartHeading("Key 费用分布", "")}
            <div class="dsapi-plus-chart-frame" style="height:${keyChartHeight}px;">
              ${sortedKeys.length ? `<div class="dsapi-plus-chart" style="height:${keyChartHeight}px;" data-dsapi-chart="keyCost"></div>` : '<div class="dsapi-plus-message">暂无 Key 费用数据。</div>'}
            </div>
          </div>
          <div class="dsapi-plus-daily-chart" style="margin-top:8px;width:100%;">
            ${chartHeading("每日费用明细", "")}
            <div class="dsapi-plus-chart-frame" style="height:200px;">
              <div class="dsapi-plus-chart" style="width:100%;height:200px;" data-dsapi-chart="keyDaily"></div>
            </div>
          </div>
        </div>

        <div class="dsapi-plus-section" data-section="dailyDetail" style="display:${state.dailyDetailVisible ? '' : 'none'};">
          <div class="dsapi-plus-section-head">
            <div class="dsapi-plus-section-title">📅 每日明细</div>
          </div>
          ${chartHeading("每日总费用与Token", "")}
          <div class="dsapi-plus-chart-frame" style="height:200px;">
            <div class="dsapi-plus-chart" style="width:100%;height:200px;" data-dsapi-chart="dailyTotal"></div>
          </div>
        </div>

        <div class="dsapi-plus-section" data-section="monthTrend" style="margin-top:8px;display:${state.sectionVisible.monthTrend ? '' : 'none'};">
          ${chartHeading("月度费用与 Token 趋势", monthRangeLabel)}
          <div class="dsapi-plus-chart-frame" style="height:260px;">
            <div class="dsapi-plus-chart" style="width:100%;height:260px;" data-dsapi-chart="monthTrend"></div>
          </div>
        </div>
      </div>
    `;

    return {
      period,
      summary,
      amount,
      cost,
      monthlySeries,
      start,
      end,
      months,
      sortedModels,
      sortedKeys,
      tokenTotal,
      isCurrentPeriod,
      averageCostPerMillion,
      averageCostDetail,
      usageDetail,
      walletCnyBalance,
      rangeCostTotal,
      rangeAvgCost,
      rangePeakCost,
      rangePeakPeriod,
      rangeTokenTotal,
      monthRangeLabel,
      keyChartHeight,
      updateTime,
      html,
    };
  }

  function renderPanel(panel, data) {
    const panelData = buildPanelData(data);
    panel.__dsapiPlusDebug = data.debug;
    state.lastPanelData = panelData;

    // [修改] 原因：图表数量不足 5 时整面板重建会销毁月份下拉，导致原生下拉弹层瞬间收回
    // 改为面板渲染过一次后一律走增量更新，缺失图表由 ensureCharts 补齐
    if (panel.dataset.rendered === "1") {
      updatePanelIncremental(panel, panelData);
      updateChartsData(panelData);
      ensureCharts(panel, panelData);
      return;
    }

    disposeCharts();
    panel.innerHTML = panelData.html;
    // 标记面板已渲染完成，后续刷新一律增量更新，避免重建销毁月份下拉
    panel.dataset.rendered = "1";
    // 重建后主动恢复鼠标交互，消除 hover 状态丢失导致的闪烁
    panel.style.pointerEvents = "none";
    requestAnimationFrame(() => { panel.style.pointerEvents = ""; });
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
    // 异步刷新 Key 明细（[需求 1] 跟随面板完整区间；历史月命中导出缓存，仅当前月按 TTL 可能重拉 ZIP）
    const rg0 = getSelectedRange();
    fetchKeyDetailFromExport(rg0.start, rg0.end).catch(function () {});
  }

  function restoreKeyDetailData(panel) {
    const saved = loadKeyDetailData();
    if (!saved || !saved.data || !saved.data.length) return;
    // [需求 1] 持久化的 Key 明细缓存带区间标识：区间不一致时丢弃，避免把旧区间的明细当成当前区间展示
    const currentRange = state.rangeStart && state.rangeEnd ? `${state.rangeStart}~${state.rangeEnd}` : "";
    if (saved.range && currentRange && saved.range !== currentRange) return;
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
    // [修改] 原因：Key 明细章节改为按 data-section 标识定位，避免新增章节后 :last-child 指向错误
    initOrUpdateKeyCostChart(panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]'));
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

  // 组装费用摘要卡片组：区间口径 4 卡 + 钱包余额（固定 5 卡）
  // 参数: d —— 含 rangeCostTotal / rangeAvgCost / rangeTokenTotal / monthRangeLabel / rangePeakCost /
  //              rangePeakPeriod / averageCostPerMillion / averageCostDetail / walletCnyBalance 的对象
  // 返回: string，summaryItem 拼接结果
  function summaryItemsHtml(d) {
    return [
      summaryItem("区间累计费用", formatCnyAmount(d.rangeCostTotal), "", `月均 ${formatCnyAmount(d.rangeAvgCost)}`),
      summaryItem("区间累计 Token", formatInteger(d.rangeTokenTotal), "Tokens", d.monthRangeLabel),
      summaryItem("最高消费月", formatCnyAmount(d.rangePeakCost), "", d.rangePeakPeriod ? `${d.rangePeakPeriod} 月` : ""),
      summaryItem("平均费用", formatCnyAmount(d.averageCostPerMillion), "/1M", d.averageCostDetail),
      summaryItem("钱包余额", formatCnyAmount(d.walletCnyBalance), "CNY", ""),
    ].join("");
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

  // [新增] 跨月日期轴标签配置：每月首个日期显示「M月D日」作为月份路标，其余显示「D日」，
  // 解决跨月区间下仅凭日号无法区分所属月份的问题（月度趋势图以月为单位，不受影响）
  // 参数: dates —— xAxis.data 的完整日期数组（YYYY-MM-DD，按时间升序）
  // 返回: { interval, formatter }，可直接 Object.assign 到 xAxis.axisLabel
  function monthAwareAxisLabel(dates) {
    const list = (dates || []).map((d) => String(d || ""));
    // 判定是否为「月路标」：系列首个日期，或与前一个日期不同月（自然月交界，含区间从月中起始的起点）
    const isMonthFirst = (idx) => {
      if (idx <= 0) return true;
      const cur = String(list[idx] || "");
      const prev = String(list[idx - 1] || "");
      return cur.slice(0, 7) !== prev.slice(0, 7);
    };
    const monthFirstSet = new Set();
    list.forEach((d, i) => {
      if (isMonthFirst(i)) monthFirstSet.add(d);
    });
    return {
      // 强制显示月交界标签（interval:"auto" 会随机抽样把月首抽掉）；
      // 其余按密度抽样，目标约 12 个标签，避免标签拥挤
      interval: (index) => {
        if (isMonthFirst(index)) return true;
        const step = Math.max(1, Math.ceil(list.length / 12));
        return index % step === 0;
      },
      formatter: (value) => {
        const m = String(value || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (!m) return String(value || "");
        if (monthFirstSet.has(String(value))) return `${Number(m[2])}月${Number(m[3])}日`;
        return `${Number(m[3])}日`;
      },
    };
  }

  function getChartTextColor() {
    // [修改] 提高深浅两套图表文字对比度：深色更亮、浅色不透明度更高
    return getBodyDark() ? "rgba(195, 195, 195, 1)" : "rgba(2, 14, 54, 0.8)";
  }

  function getChartGridColor() {
    return getBodyDark() ? "rgba(60, 60, 60, 1)" : "#D2D8E5";
  }

  function getTooltipCss() {
    // [修改] 深色模式下 tooltip 背景与文字变量同步：tooltipHtml 用 rgb(var(--ds-rgb-label-*))，
    //        平台未定义这些变量导致深色下文字仍为黑色，此处在 tooltip 根元素上定义浅色变量
    const isDark = getBodyDark();
    const base = [
      "padding: 12px",
      "border-radius: 10px",
      "box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)",
      "border: none",
    ];
    if (isDark) {
      base.unshift(
        "background-color: #1a1a2e",
        "--ds-rgb-label-1: 224 224 224",
        "--ds-rgb-label-2: 190 194 206", /* [修改] 与面板 muted 同步提高对比度 */
        "--ds-rgb-label-3: 155 160 175"
      );
    } else {
      base.unshift("background-color: rgb(var(--ds-rgb-elevated, 255 255 255))");
    }
    return base.join(";") + ";";
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
    }, 2000);
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
    const { amount, sortedModels, monthlySeries } = panelData;
    switch (key) {
      case "models": return buildModelsChartOption(sortedModels.slice(0, 8));
      case "keyCost": return buildKeyCostChartOption();
      case "keyDaily": return buildKeyDailyChartOption();
      case "dailyTotal": return buildDailyTotalChartOption(panelData);
      case "monthTrend": return (monthlySeries && monthlySeries.length) ? buildMonthTrendChartOption(monthlySeries) : null;
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
    if (state.pendingPanelDataTimer) {
      clearTimeout(state.pendingPanelDataTimer);
      state.pendingPanelDataTimer = 0;
    }
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

  // ========== 主题模式切换（auto / light / dark） ==========
  // 站点主题通常由 body.dark 或 html.dark 类驱动；脚本的 CSS 变量（--ds-rgb-label-*）、
  // body.dark 配色分支，以及图表轴色都读取该状态。
  // 强制模式只需同步 body/html 的 dark 类并触发既有 updateChartTheme 管线，无需自建配色表。
  let lastAppliedDark = null;  // 本脚本最近一次写入的 dark 期望值；null 表示尚未干预
  let sitePrefersDark = false; // 站点自身的主题偏好，切回 auto 时按此还原

  // 检测当前是否为暗色：兼容 dark 类（body/html）与站点实际使用的 body[data-ds-dark-theme] 属性
  // [修改] 原因：平台暗色由 body 的 data-ds-dark-theme 属性驱动（--dsw-alias-* 变量重定义），
  //       仅靠 dark 类判断真实主题会导致图表配色与页面脱节
  function getBodyDark() {
    const body = document.body;
    const html = document.documentElement;
    return !!(body && (body.classList.contains("dark") || body.hasAttribute("data-ds-dark-theme")))
      || !!(html && html.classList.contains("dark"));
  }

  // 当前模式对应的按钮展示信息（图标 / 文案 / 悬浮提示）
  function themeModeMeta() {
    switch (state.themeMode) {
      case "light": return { icon: "☀", text: "浅色", title: "主题：浅色（点击切换为深色）" };
      case "dark": return { icon: "🌙", text: "深色", title: "主题：深色（点击切换为跟随站点）" };
      default: return { icon: "◐", text: "跟随", title: "主题：跟随站点（点击切换为浅色）" };
    }
  }

  // 按钮循环：跟随 → 浅色 → 深色 → 跟随
  function nextThemeMode(mode) {
    const i = THEME_MODES.indexOf(mode);
    return THEME_MODES[(i < 0 ? 0 : i + 1) % THEME_MODES.length];
  }

  // 同步 body 的 dark/light 类与 data-ds-dark-theme 属性，对齐 DeepSeek 平台主题函数（main.js i()）行为；
  // 同时兼容 html dark 类 / data-theme / color-scheme 多套机制。
  // [修改] 原因：平台暗色配色由 body[data-ds-dark-theme] 属性驱动（--dsw-alias-* 变量重定义），
  //       此前仅翻转 dark 类导致页面主体配色不切换，深色模式不生效；light 类为站点浅色态约定，一并管理。
  // 返回是否确实发生了改动（只有改动时才需要重绘图表）。
  function setBodyDark(want) {
    const body = document.body;
    const html = document.documentElement;
    let changed = false;
    if (body) {
      // 类：深色加 dark、浅色加 light，与站点主题函数行为保持一致
      if (body.classList.contains("dark") !== want) {
        body.classList.toggle("dark", want);
        changed = true;
      }
      if (body.classList.contains("light") === want) {
        body.classList.toggle("light", !want);
        changed = true;
      }
      // 属性：平台暗色配色的真正开关（站点深色时必写 data-ds-dark-theme="dark"）
      if (body.hasAttribute("data-ds-dark-theme") !== want) {
        if (want) body.setAttribute("data-ds-dark-theme", "dark");
        else body.removeAttribute("data-ds-dark-theme");
        changed = true;
      }
    }
    if (html && html.classList.contains("dark") !== want) {
      html.classList.toggle("dark", want);
      changed = true;
    }
    // 兼容 data-theme 属性（shadcn/ui / Next.js 风格）：仅在站点已有此属性时才改，避免污染未使用此机制的站点
    if (html && html.hasAttribute("data-theme")) {
      const cur = html.getAttribute("data-theme");
      const next = want ? "dark" : "light";
      if (cur !== next) {
        html.setAttribute("data-theme", next);
        changed = true;
      }
    }
    // color-scheme 总是安全，影响浏览器默认 UI（滚动条、原生表单），不干扰站点自定义样式
    if (html && html.style.colorScheme !== (want ? "dark" : "light")) {
      html.style.colorScheme = want ? "dark" : "light";
    }
    if (changed) lastAppliedDark = want;
    return changed;
  }

  // 应用当前模式：auto 把 body/html 的 dark 类对齐回站点偏好（还原我们强制时加的类）；
  // light/dark 强制覆盖，并记录期望值 lastAppliedDark 供观察者判断是否被站点覆盖。
  // 返回 dark 类是否实际发生变化（未变化时不再重绘图表）。
  function applyThemeMode(reason) {
    const want = state.themeMode === "auto" ? sitePrefersDark : state.themeMode === "dark";
    const changed = setBodyDark(want);
    if (state.themeMode !== "auto") lastAppliedDark = want; // 记录期望值，供观察者判断是否被站点覆盖
    if (changed) updateChartTheme();
    return changed;
  }

  // 高频 watchdog：在点击 / 启动 / 观察者检测到被覆盖时启动一轮，50ms 一次持续 2 秒，
  // 对抗 React 高频重渲染把 dark 类冲掉。每次 tick 都重新 apply（idempotent），
  // 不依赖帧时间，节奏更密，能赢过大多数重渲染频率。
  let themeWatchdogTimer = 0;
  function startThemeWatchdog(durationMs) {
    if (state.themeMode === "auto") return;
    window.clearInterval(themeWatchdogTimer);
    const endAt = Date.now() + (durationMs || 2000);
    themeWatchdogTimer = window.setInterval(() => {
      if (Date.now() >= endAt || state.themeMode === "auto") {
        window.clearInterval(themeWatchdogTimer);
        themeWatchdogTimer = 0;
        return;
      }
      applyThemeMode("watchdog");
    }, 50);
  }

  function startThemeObserver() {
    let themeTimer = 0;
    const onClassChange = () => {
      if (state.themeMode === "auto") {
        // 跟随站点：仅记录站点偏好并刷新图表配色，不强制
        sitePrefersDark = getBodyDark();
        window.clearTimeout(themeTimer);
        themeTimer = window.setTimeout(updateChartTheme, 1000);
        return;
      }
      // 强制态：body 需同时满足 dark 类 + data-ds-dark-theme 属性（站点真实暗色状态），html 仅为兼容类
      // [修改] 原因：站点覆盖主题时可能只改属性不改类（或反之），此前只比对 dark 类会漏判
      const want = lastAppliedDark;
      const bodyEl = document.body;
      const htmlEl = document.documentElement;
      const bodyDark = !!(bodyEl && bodyEl.classList.contains("dark"));
      const bodyAttr = !!(bodyEl && bodyEl.hasAttribute("data-ds-dark-theme"));
      const htmlHas = !!(htmlEl && htmlEl.classList.contains("dark"));
      if (bodyDark === want && bodyAttr === want && htmlHas === want) {
        // 与我们的期望一致（多为本脚本自己的写入），仅刷新图表配色
        window.clearTimeout(themeTimer);
        themeTimer = window.setTimeout(updateChartTheme, 1000);
        return;
      }
      // 站点（如 React 重渲染）试图覆盖主题：记录站点自身偏好后启动 watchdog 持续重新应用
      sitePrefersDark = getBodyDark();
      applyThemeMode("observer");
      startThemeWatchdog(2000);
    };
    const obs = new MutationObserver(onClassChange);
    obs.observe(document.body, { attributes: true, attributeFilter: ["class", "data-ds-dark-theme"] });
    if (document.documentElement) {
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    }
  }

  function updatePanelIncremental(panel, panelData) {
    // [修复] 原因：解构漏掉 sortedModels/sortedKeys 导致 updatePanelIncremental 抛 ReferenceError，面板渲染中断
    const { start, end, amount, summary, cost, sortedModels, sortedKeys, walletCnyBalance, usageDetail, updateTime } = panelData;

    // 同步起/止双下拉框选中值（不再有单一 period 下拉）
    const startSelect = panel.querySelector(".dsapi-plus-range-start");
    const endSelect = panel.querySelector(".dsapi-plus-range-end");
    if (startSelect) startSelect.value = start;
    if (endSelect) endSelect.value = end;
    const status = panel.querySelector(".dsapi-plus-status");
    if (status) status.textContent = `已更新 ${escapeHtml(updateTime)}`;

    const summaryEl = panel.querySelector(".dsapi-plus-summary");
    if (summaryEl) {
      const head = summaryEl.querySelector(":scope > .dsapi-plus-section-head");
      summaryEl.querySelectorAll(":scope > .dsapi-plus-summary-item").forEach((el) => el.remove());
      if (head) {
        head.insertAdjacentHTML("afterend", summaryItemsHtml(panelData));
      } else {
        summaryEl.innerHTML =
          '<div class="dsapi-plus-section-head" style="margin-bottom:12px;width:100%;"><div class="dsapi-plus-section-title">💰 费用摘要</div></div>' +
          summaryItemsHtml(panelData);
      }
    }

    // [修改] 原因：已删除「请求统计 / Token统计 / Token构成」三个图表，头部数值只剩「模型分布」带 value
    // 故 headingTexts 只保留模型分布一项，按索引对齐
    const headingValues = panel.querySelectorAll(".dsapi-plus-chart-heading-value");
    const headingTexts = [
      sortedModels.length ? `${sortedModels.length} 个活跃模型` : "暂无模型用量",
    ];
    headingValues.forEach((el, i) => {
      if (headingTexts[i] != null) el.textContent = headingTexts[i];
    });

    const detailLayout = panel.querySelector(".dsapi-plus-detail-layout");
    if (detailLayout && detailLayout.children[0]) {
      detailLayout.children[0].innerHTML = sortedModels.length
      ? renderModelTable(sortedModels, cost)
      : '<div class="dsapi-plus-message">当前区间暂无请求或 Token 用量。</div>';
    }

    const donut = panel.querySelector(".dsapi-plus-model-donut");
    if (donut) {
      const frame = donut.querySelector(".dsapi-plus-chart-frame");
      if (frame) {
        const hasChart = !!frame.querySelector('[data-dsapi-chart="models"]');
        if (sortedModels.length && !hasChart) {
          frame.innerHTML = '<div class="dsapi-plus-chart" data-dsapi-chart="models"></div>';
        } else if (!sortedModels.length && hasChart) {
          frame.innerHTML = '<div class="dsapi-plus-message">当前区间暂无模型用量。</div>';
        }
      }
    }

    // 更新 Key 明细（仅当未通过导入按钮获取数据时）
    const keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
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
              keySection.insertAdjacentHTML("beforeend", '<div class="dsapi-plus-message">当前区间暂无 Key 级别用量数据，或 API 未返回 Key 信息。</div>');
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
      // 5 秒后强制刷新数据，避免 tooltip 长时间阻塞数据更新
      if (!state.pendingPanelDataTimer) {
        state.pendingPanelDataTimer = setTimeout(() => {
          state.pendingPanelDataTimer = 0;
          state.tooltipActive = false;
          flushPendingChartUpdates();
        }, 5000);
      }
      return;
    }
    // keyDetail 相关图表（keyCost/keyDaily）由独立数据流管理，不由 panelData 驱动，
    // 需跳过避免被无 key 的 buildChartOption 判定为无效而 dispose；monthTrend 已并入主面板由 panelData 驱动
    const independentKeys = new Set(['keyCost', 'keyDaily']);
    const remaining = [];
    for (const entry of state.charts) {
      // 跳过独立数据流图表（keyCost/keyDaily），不依赖 panelData 更新
      if (independentKeys.has(entry.key)) {
        remaining.push(entry);
        continue;
      }
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

        const keys = ["models", "keyCost", "keyDaily", "dailyTotal", "monthTrend"];
        for (const key of keys) {
          const container = panel.querySelector(`[data-dsapi-chart="${key}"]`);
          const option = buildChartOption(key, panelData);
          if (!container || !option) continue;
          // 避免与 ensureCharts 并发初始化同一容器产生双实例
          if (echarts.getInstanceByDom(container)) continue;
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

  // 增量更新路径下补齐缺失的图表实例：首载时数据为空未创建、或实例被 dispose 后数据恢复
  // 参数:
  //   panel: Element，面板根节点
  //   panelData: Object，本次渲染数据
  // 返回: 无
  // 背景：图表不足时走整面板重建会销毁月份下拉，导致原生下拉弹层瞬间收回，故改为增量补齐
  function ensureCharts(panel, panelData) {
    getEcharts()
      .then((echarts) => {
        if (!panel.isConnected) return;
        // 仅补齐由 panelData 驱动的主图表，Key 明细图表由独立数据流管理
        const keys = ["models", "dailyTotal", "monthTrend"];
        for (const key of keys) {
          const container = panel.querySelector(`[data-dsapi-chart="${key}"]`);
          const option = buildChartOption(key, panelData);
          if (!container || !option) continue;
          // 已有实例或容器被其他实例占用时跳过，避免重复初始化
          if (state.charts.some((e) => e.key === key)) continue;
          if (echarts.getInstanceByDom(container)) continue;
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
      })
      .catch((error) => {
        console.error("[DeepSeek Usage Panel Plus] ECharts init failed", error);
      });
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
    // [对齐] 三张折线图（keyDaily/dailyTotal/monthTrend）统一 left/right，
    // 使横轴绘图区宽度像素级一致（right=110 为 dailyTotal 双右轴标签的最大预留值）
    option.grid.left = 56;
    option.grid.right = 110;
    option.xAxis.data = dailyData.dates;
    // [新增] 跨月区间下轴标签带月份路标：每月首个日期显示「M月D日」，其余「D日」
    Object.assign(option.xAxis.axisLabel, monthAwareAxisLabel(dailyData.dates));
    option.tooltip.formatter = (params) => {
      // 绑定原始索引后按当日总费用降序排序，使 tooltip 优先展示当日消费最高的 Key
      const sorted = params.map((p, i) => ({ p, i })).sort((a, b) => b.p.value - a.p.value);
      const rows = sorted.map(({ p, i }) => {
        // 从同索引的 miss/hit 数组中取当日值计算缓存命中率
        var missVal = 0, hitVal = 0, cacheRate = 0;
        if (dailyData.miss && dailyData.miss[i] && dailyData.hit && dailyData.hit[i]) {
          missVal = dailyData.miss[i].data[p.dataIndex] || 0;
          hitVal = dailyData.hit[i].data[p.dataIndex] || 0;
          if (missVal + hitVal > 0) {
            cacheRate = (hitVal / (missVal + hitVal) * 100);
          }
        }
        return {
          color: p.color,
          label: p.seriesName,
          value: formatCnyAmount(p.value, 4),
          extra: cacheRate !== null ? "缓存 " + cacheRate.toFixed(1) + "%" : null,
        };
      });
      return tooltipHtml(params[0]?.axisValue || "", rows);
    };
    // tooltip 保持在图表容器内但不强制裁剪，避免多出滚动条
    option.tooltip.appendToBody = false;
    option.tooltip.confine = false;
    // [优化] 原因：base 的 splitNumber:1 会让 ECharts 把 52 的峰值取整到 100 的轴顶，曲线顶部大片空白；
    // 改为 4 刻度自适应，轴顶紧贴实际最大值（约 60），顶部空白大幅减少
    option.yAxis.splitNumber = 4;
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

  // 构建"每日明细"总览图表：每日总费用 + 每日总 Token 双轴折线图
  // 参数: panelData: Object，面板渲染数据（amount.days 提供每日 Token，cost CNY 块提供每日费用）
  // 返回: ECharts option 对象；当月无每日数据时返回 null
  function buildDailyTotalChartOption(panelData) {
    const { amount, cost } = panelData;
    // 跨月区间：每日序列取所有有数据的完整日期并集（按字典序即时间序），自然跨月连续；
    // 兜底年月取区间止月（panelData.period 跨月时为 "start~end" 复合格式，parsePeriod 解析不了）
    const { year: fallbackYear, month: fallbackMonth } = parsePeriod(panelData.end);
    const cnyBlock = (cost || []).find((b) => b.currency === "CNY");
    const cnyDays = cnyBlock ? cnyBlock.days || [] : [];
    // 将 API 返回的日期统一规范化为 YYYY-MM-DD，兼容 "YYYY-MM-DD" / "MM-DD" / 纯数字等格式
    const normalizeDayKey = (dateStr) => {
      const s = String(dateStr || "");
      let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
      m = s.match(/^(\d{1,2})-(\d{1,2})$/);
      if (m) return `${fallbackYear}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
      m = s.match(/^(\d{1,2})$/);
      if (m) return `${fallbackYear}-${String(fallbackMonth).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
      return null;
    };
    const costByDate = {};
    for (const d of cnyDays) {
      const key = normalizeDayKey(d.date);
      if (key) costByDate[key] = d.amount || 0;
    }
    const tokenByDate = {};
    for (const d of (amount.days || [])) {
      const key = normalizeDayKey(d.date);
      if (key) tokenByDate[key] = d.tokens || 0;
    }
    // 跨月：日期序列取所有有数据的完整日期的并集（自然跨月连续）；单月兜底按年月生成 1..月末
    // [修复] 原因：cost API 的 days 可能包含未来日期（当月整月网格），横坐标必须截止到今天
    const _now = new Date();
    const _todayKey = `${_now.getUTCFullYear()}-${String(_now.getUTCMonth() + 1).padStart(2, "0")}-${String(_now.getUTCDate()).padStart(2, "0")}`;
    let dates = Object.keys(Object.assign({}, costByDate, tokenByDate)).filter((d) => d <= _todayKey).sort();
    if (!dates.length) {
      const endDay = getMaxDisplayDay(fallbackYear, fallbackMonth);
      for (let d = 1; d <= endDay; d++) {
        dates.push(`${fallbackYear}-${String(fallbackMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      }
    }
    const costData = dates.map((date) => costByDate[date] || 0);
    const tokenData = dates.map((date) => tokenByDate[date] || 0);
    // 每日总单价 = 当日费用 / 当日 Token × 100万，Token 为 0 时记 0（tooltip 与曲线共用同一数据源）
    const unitPriceData = tokenData.map((t, i) => t > 0 ? (costData[i] / t * 1000000) : 0);
    if (!dates.length) return null;

    const textColor = getChartTextColor();
    const gridColor = getChartGridColor();
    const option = chartBaseOption();
    // [对齐] 与 keyDaily/monthTrend 统一 left/right，保持三图绘图区宽度一致
    option.grid.left = 56;
    option.grid.right = 110;
    option.grid.top = 32;
    option.xAxis.data = dates;
    // [新增] 跨月区间下轴标签带月份路标（同 keyDaily）：每月首个日期显示「M月D日」，其余「D日」
    Object.assign(option.xAxis.axisLabel, monthAwareAxisLabel(dates));
    // [修改] 原因：单价量级（元/1M）远小于费用与 Token，共用左轴会被压成贴底直线，改为独立第三 y 轴
    // 三个量纲各自独立缩放：左轴费用、右轴 Token、右轴外侧单价（offset 错开避免标签重叠）
    option.yAxis = [
      {
        type: "value",
        position: "left",
        // [优化] 原因：base 的 splitNumber:1 会把峰值取整到 50/100 的倍数，轴顶出现大片空白；
        // 改为 4 刻度自适应，Y 轴顶部贴近实际最大值（每日费用明细图同款优化）
        splitNumber: 4,
        splitLine: { lineStyle: { color: gridColor } },
        axisLabel: { color: textColor, align: "left", margin: 34, formatter: (v) => `¥${formatDecimal(v)}` },
      },
      {
        type: "value",
        position: "right",
        splitNumber: 4,
        splitLine: { show: false },
        axisLabel: { color: "#7BCB99", formatter: compactNumber },
      },
      {
        type: "value",
        position: "right",
        offset: 54,
        splitNumber: 4,
        splitLine: { show: false },
        axisLabel: { color: "#F59E0B", formatter: (v) => `¥${formatDecimal(v)}` },
      },
    ];
    option.tooltip.formatter = (params) => {
      const idx = params[0].dataIndex;
      const dayCost = costData[idx] || 0;
      const dayTokens = tokenData[idx] || 0;
      const unitPrice = unitPriceData[idx] || 0;
      return tooltipHtml(params[0].axisValue || "", [
        { color: "#0C70F3", label: "每日总费用", value: formatCnyAmount(dayCost) },
        { color: "#7BCB99", label: "每日总Token", value: formatInteger(dayTokens) },
        { color: "#F59E0B", label: "每日总单价", value: `¥${formatDecimal(unitPrice)}/1M` },
      ]);
    };
    // tooltip 保持在图表容器内但不强制裁剪，避免多出滚动条
    option.tooltip.appendToBody = false;
    option.tooltip.confine = false;
    option.series = [
      {
        name: "每日总费用",
        data: costData,
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        itemStyle: { color: "#0C70F3" },
        lineStyle: { color: "#0C70F3", width: 1.5 },
        emphasis: { disabled: true },
      },
      {
        name: "每日总Token",
        data: tokenData,
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        itemStyle: { color: "#7BCB99" },
        lineStyle: { color: "#7BCB99", width: 1.5 },
        emphasis: { disabled: true },
      },
      {
        name: "每日总单价",
        data: unitPriceData,
        type: "line",
        smooth: true,
        showSymbol: false,
        // 单价挂独立第三 y 轴，避免被费用量级压扁；虚线区分于费用实线
        yAxisIndex: 2,
        itemStyle: { color: "#F59E0B" },
        lineStyle: { color: "#F59E0B", width: 1.5, type: "dashed" },
        emphasis: { disabled: true },
      },
    ];
    option.legend = {
      show: true,
      top: 0,
      left: "center",
      textStyle: { color: textColor, fontSize: 11 },
      icon: "roundRect",
      itemWidth: 14,
      itemHeight: 8,
    };
    return option;
  }

  function chartPalette(index) {
    return [
      "#E74C3C", "#3498DB", "#2ECC71", "#F39C12",
      "#9B59B6", "#1ABC9C", "#E67E22", "#2980B9",
      "#27AE60", "#D35400", "#8E44AD", "#16A085",
      "#C0392B", "#3B82F6", "#10B981", "#F59E0B",
    ][index % 16];
  }

  // 计算指定月份横轴最大显示日：当前月为当天（UTC），历史月为月末
  // 参数: year: number，年份（四位）；month: number，月份（1-12，1 基）
  // 返回: number，最大显示日（1-31）
  function getMaxDisplayDay(year, month) {
    const now = new Date();
    const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
    return isCurrentMonth
      ? now.getUTCDate()
      : new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /**
   * 补全 sortedDates 数组，确保从当月1号到当天（或月末）的每一天都存在
   * @param {string[]} dates - 日期数组 "YYYY-MM-DD"，会被原地修改
   * @param {number} year - 年份（四位）
   * @param {number} month - 月份（1-12，1 基）
   */
  function fillDateRange(dates, year, month) {
    // [修改] 原因：最大显示日逻辑提取为 getMaxDisplayDay 供每日明细图表共用，保证两图横轴口径一致
    const endDay = getMaxDisplayDay(year, month);
    const existing = new Set(dates);
    var prefix = year + "-" + String(month).padStart(2, "0");
    for (var d = 1; d <= endDay; d++) {
      var dateStr = prefix + "-" + String(d).padStart(2, "0");
      if (!existing.has(dateStr)) {
        dates.push(dateStr);
      }
    }
    dates.sort();
  }

  function tooltipHtml(title, rows) {
    const body = rows.map((row) => `
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;color:rgb(var(--ds-rgb-label-2));font-size:var(--ds-font-size-sp);line-height:var(--ds-line-height-sp);">
        <span style="display:flex;align-items:center;gap:8px;">
          <span style="width:12px;height:12px;border-radius:2px;background:${row.color};display:inline-block;"></span>
          <span>${escapeHtml(row.label)}</span>
        </span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="font-variant-numeric:tabular-nums;color:rgb(var(--ds-rgb-label-2));">${escapeHtml(row.value)}</span>
          ${row.extra ? `<span style="font-variant-numeric:tabular-nums;color:rgb(var(--ds-rgb-label-3, 153 153 153));font-size:11px;">${escapeHtml(row.extra)}</span>` : ""}
        </span>
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
  // 从导出接口获取 Key 级用量数据（按主面板起止区间跨月聚合，需求 1）
  // 参数:
  //   start: string，起始月，如 "2026-1"
  //   end:   string，结束月，如 "2026-9"；省略且 start 为合法单月时按单月处理（兼容旧调用）
  // 返回: Key 级聚合数组（按费用降序）或 null
  async function fetchKeyDetailFromExport(start, end) {
    // 兼容旧调用：仅传单月 period 时视作单月区间
    if (!end && /^\d{4}-\d{1,2}$/.test(String(start))) end = start;
    const periods = enumerateMonths(start, end);
    if (!periods.length) return null;

    state.keyDetailLoading = true;
    state.keyDetailError = "";
    // 取消上一次未完成的导出请求，避免快速切月/连续刷新时乱序覆盖
    if (state.keyDetailAbortController) { try { state.keyDetailAbortController.abort(); } catch (e) { /* ignore */ } }
    const controller = new AbortController();
    state.keyDetailAbortController = controller;
    const signal = controller.signal;
    const reqId = ++state.keyDetailReqId;
    updateKeyDetailUI();

    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const todayKey = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    // 导出 CSV 的日期列统一规范为 YYYY-MM-DD（兼容完整日期 / MM-DD / 纯日号），保证跨月日期不冲突
    const normDate = (raw, year, month) => {
      const s = String(raw || "").trim();
      let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
      if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
      if (m) return `${year}-${pad(m[1])}-${pad(m[2])}`;
      m = s.match(/^(\d{1,2})$/);
      if (m) return `${year}-${pad(month)}-${pad(m[1])}`;
      return null;
    };

    try {
      // 1. 并发拉取各月导出行（历史月命中永久缓存，仅当前月按 TTL 可能真正下载 ZIP）
      const fetched = await runWithConcurrency(
        periods.map((period) => () => loadExportRowsForMonth(period, signal)),
        2
      );
      if (reqId !== state.keyDetailReqId) return null;
      if (signal && signal.aborted) return null;

      // 2. 把各月行聚合进共享映射（key|||model 与 key|||date(YYYY-MM-DD)）
      const detailMap = {};       // key|||model -> 模型级聚合条目
      const dailyDetailMap = {};  // key|||date   -> 单日聚合条目
      const dateSet = new Set();
      const addDate = (date) => { if (date && date <= todayKey) dateSet.add(date); };
      let okMonths = 0;
      for (let mi = 0; mi < periods.length; mi++) {
        const period = periods[mi];
        const res = fetched[mi];
        if (!res) continue; // 单月下载失败：跳过，由下方 okMonths 判定是否整体失败
        okMonths += 1;

        // 5. 根据该月 CSV 表头定位关键列
        const idx = (pattern) => res.headers.findIndex((h) => pattern.test(String(h).toLowerCase()));
        const colName = idx(/api_key_name|key_name|name/i);   // Key 名称列
        const colType = idx(/^type$/i);                        // 类型列
        const colPrice = idx(/^price$/i);                      // 单价列
        const colAmount = idx(/^amount$/i);                    // 用量列
        const colModel = idx(/model/i);                        // 模型列
        const colDate = idx(/utc_date|date/i);                 // 日期列
        if (colName < 0 || colType < 0 || colAmount < 0) {
          if (mi === 0) throw new Error(`CSV 缺少必要列，请检查表头：${res.headers.join(" | ")}`);
          continue;
        }
        const { year, month } = parsePeriod(period);

        for (const row of res.rows) {
          const keyName = String(row[colName] || "unknown");
          const type = colType >= 0 ? String(row[colType] || "") : "";
          const amount = colAmount >= 0 ? Number(row[colAmount]) || 0 : 0;
          const price = colPrice >= 0 ? Number(row[colPrice]) || 0 : 0;
          const modelName = colModel >= 0 ? String(row[colModel] || "") : "";

          // 6. 模型级明细（key|||model）：确保模型级数据精确
          if (modelName) {
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

          // 8. 每日明细（key|||date）：费用 / 请求数 / Token
          if (keyName !== "unknown" && colDate >= 0) {
            const date = normDate(row[colDate], year, month);
            if (!date) continue;
            addDate(date);
            const pairKey = keyName + "|||" + date;
            if (!dailyDetailMap[pairKey]) {
              dailyDetailMap[pairKey] = { requestCount: 0, missTokens: 0, hitTokens: 0, outTokens: 0, cost: 0 };
            }
            const dd = dailyDetailMap[pairKey];
            const cost = price * amount;
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
        }
      }
      if (signal && signal.aborted) return null;
      if (reqId !== state.keyDetailReqId) return null;
      if (okMonths === 0) throw new Error("全部月份导出失败，无法获取 Key 明细");

      // 7. 模型级数据汇总到 Key 级
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

      // 横轴补全：数据日 ∪ 区间内每月 1 号 → 当天/月末（历史月为月末，当前月到今日，需求 2 不外扩）
      for (const period of periods) {
        const { year, month } = parsePeriod(period);
        const endDay = getMaxDisplayDay(year, month);
        const prefix = `${year}-${pad(month)}-`;
        for (let d = 1; d <= endDay; d++) addDate(prefix + pad(d));
      }
      const sortedDates = Array.from(dateSet).sort();

      // 构建每 key 每日系列数据（零值补齐，与横轴对齐）
      var dailySerieMap = {};
      for (const [pairKey, dd] of Object.entries(dailyDetailMap)) {
        const sep = pairKey.lastIndexOf("|||");
        const k = pairKey.substring(0, sep);
        const d = pairKey.substring(sep + 3);
        if (!dailySerieMap[k]) {
          dailySerieMap[k] = { name: k, cost: {}, request: {}, tokens: {}, miss: {}, hit: {} };
          for (const dt of sortedDates) {
            dailySerieMap[k].cost[dt] = 0;
            dailySerieMap[k].request[dt] = 0;
            dailySerieMap[k].tokens[dt] = 0;
            dailySerieMap[k].miss[dt] = 0;
            dailySerieMap[k].hit[dt] = 0;
          }
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

      if (reqId !== state.keyDetailReqId) return null; // 已被更新的请求覆盖，丢弃旧结果
      state.keyDetailData = sorted;
      state.keyDetailDailyData = dailyData;
      state.keyDetailUpdateTime = new Date().toLocaleTimeString("zh-CN");
      state.keyUnitPrices = {};
      state.keyDetailLoading = false;
      saveKeyDetailData();
      // 延迟刷新数据 UI，避免和 renderPanel 的 DOM 重建竞态
      scheduleKeyDetailUIUpdate();
      return sorted;
    } catch (error) {
      console.error("[DeepSeek Usage Panel Plus] 获取 Key 明细失败", error);
      // 被更新的请求取消（切月/连续刷新）：静默忽略，由新请求负责刷新 UI
      if (error && (error.name === "AbortError" || /abort/i.test(String(error.message || "")))) {
        return null;
      }
      // 已被更新的请求覆盖，丢弃旧错误，不污染界面
      if (reqId !== state.keyDetailReqId) return null;
      state.keyDetailLoading = false;
      state.keyDetailError = error.message || String(error);
      scheduleKeyDetailUIUpdate();
      return null;
    }
  }

  // 延迟刷新数据 Key 明细 UI（避免与 renderPanel DOM 重建竞态）
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
    var keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
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

    const keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
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
      // 更新每日费用明细曲线图（数据源 state.keyDetailDailyData 在 fetchKeyDetailFromExport 中已更新）
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
      // 容器不可见时跳过初始化，避免 ECharts 在 0×0 容器上渲染异常
      if (!container.offsetParent) return;
      // 容器可能因 DOM 重建而 detached，重新查询当前 DOM 中的容器
      let currentContainer = container;
      if (!currentContainer.isConnected) {
        const refreshedFrame = keySection.querySelector(".dsapi-plus-chart-frame");
        if (refreshedFrame) currentContainer = refreshedFrame.querySelector('[data-dsapi-chart="keyCost"]');
        if (!currentContainer || !currentContainer.isConnected) return;
      }
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

  // 释放 Key 费用分布图实例（切月时清空旧月份图表，防止残留旧月份数据）
  function disposeKeyCostChart() {
    for (let ci = state.charts.length - 1; ci >= 0; ci--) {
      if (state.charts[ci].key === "keyCost") {
        try { state.charts[ci].instance.dispose(); } catch (e) { /* ignore */ }
        state.charts.splice(ci, 1);
        break;
      }
    }
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
    const keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
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

    // 切换 Key 明细表格显示
    const toggleBtn = panel.querySelector(".dsapi-plus-toggle-key-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        state.keyTableVisible = !state.keyTableVisible;
        toggleBtn.classList.toggle("active", state.keyTableVisible);
        saveKeyTableVisible();
        const keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
        if (!keySection) return;
        const tableWrap = keySection.querySelector(".dsapi-plus-table-wrap");
        if (tableWrap) {
          tableWrap.style.display = state.keyTableVisible ? "" : "none";
        }
        // 表格显示状态变化后调整图表尺寸
        requestAnimationFrame(() => {
          for (const { instance } of state.charts) instance?.resize();
        });
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
        const keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
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
        requestAnimationFrame(() => {
          for (const { instance } of state.charts) instance?.resize();
        });
      });
    }

    // Key 筛选密钥
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
        filterBtn.textContent = selectedCount < allKeys.length ? `筛选密钥 (${selectedCount})` : "筛选密钥";
      }
      populateFilterList();

      // 切换下拉菜单
      filterBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        populateFilterList();
        filterDropdown.style.display = filterDropdown.style.display === "none" ? "" : "none";
      });

      // 全部选择 / 取消全部
      filterWrap.querySelector(".dsapi-plus-filter-all-btn")?.addEventListener("click", () => {
        state.keyFilter = { mode: "all", keys: [] };
        saveKeyFilter();
        filterBtn.textContent = "筛选密钥";
        filterList.querySelectorAll("input").forEach((cb) => { cb.checked = true; });
        applyKeyFilter(panel);
        filterDropdown.style.display = "none";
      });
      filterWrap.querySelector(".dsapi-plus-filter-none-btn")?.addEventListener("click", () => {
        const data = state.keyDetailData;
        state.keyFilter = { mode: "selected", keys: data ? [] : [] };
        saveKeyFilter();
        filterBtn.textContent = "筛选密钥 (0)";
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
        filterBtn.textContent = checks.length < allKeys.length ? `筛选密钥 (${checks.length})` : "筛选密钥";
        applyKeyFilter(panel);
      });

      // 点击外部关闭
      document.addEventListener("click", (e) => {
        if (!filterWrap.contains(e.target)) filterDropdown.style.display = "none";
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
        // [修复] 显示时始终基于最新 keyDetailData 重建/重绘，避免残留旧月份数据
        if (state.keyDetailChartVisible) {
          const keySection = panel.querySelector('.dsapi-plus-section[data-section="keyDetail"]');
          if (keySection) initOrUpdateKeyCostChart(keySection);
        }
        requestAnimationFrame(() => {
          for (const { instance } of state.charts) instance?.resize();
        });
      });
    }

    // 图表区块显示切换（事件代理）
    panel.querySelectorAll(".dsapi-plus-toggle-section-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = btn.dataset.section;
        // [修改] 原因：Key 明细 / 每日明细为独立区块，state 字段不同，单独分支处理整体显示/隐藏
        if (section === "keyDetail" || section === "dailyDetail") {
          const isKey = section === "keyDetail";
          const field = isKey ? "keyDetailVisible" : "dailyDetailVisible";
          const saveFn = isKey ? saveKeyDetailVisible : saveDailyDetailVisible;
          state[field] = !state[field];
          btn.classList.toggle("active", state[field]);
          saveFn();
          const block = panel.querySelector(`.dsapi-plus-section[data-section="${section}"]`);
          if (block) {
            block.style.display = state[field] ? "" : "none";
          }
          requestAnimationFrame(() => {
            for (const { instance } of state.charts) instance?.resize();
          });
          return;
        }
        if (!section || !(section in state.sectionVisible)) return;
        state.sectionVisible[section] = !state.sectionVisible[section];
        btn.classList.toggle("active", state.sectionVisible[section]);
        saveSectionVisible();
        let block;
        if (section === "models") {
          block = panel.querySelector(".dsapi-plus-section");
        } else if (section === "monthTrend") {
          // 月度趋势是独立 .dsapi-plus-section（非 .dsapi-plus-chart-block），单独定位
          block = panel.querySelector('.dsapi-plus-section[data-section="monthTrend"]');
        } else {
          const chartEl = panel.querySelector(`[data-dsapi-chart="${section}"]`);
          if (chartEl) block = chartEl.closest(".dsapi-plus-chart-block");
        }
        if (block) {
          block.style.display = state.sectionVisible[section] ? "" : "none";
        }
        requestAnimationFrame(() => {
          for (const { instance } of state.charts) instance?.resize();
        });
      });
    });

    // 区间聚合起止下拉框：改选后更新 state 并重新加载，止早于起时自动校正
    const startSelect = panel.querySelector(".dsapi-plus-range-start");
    const endSelect = panel.querySelector(".dsapi-plus-range-end");
    const normalizeMonthRange = (start, end) => {
      // 月份比较：转成 "YYYY*100+MM" 数值便于跨年比较
      const toNum = (p) => {
        const { year, month } = parsePeriod(p);
        return year * 100 + month;
      };
      return toNum(start) <= toNum(end) ? { start, end } : { start: end, end: start };
    };
    if (startSelect) {
      startSelect.addEventListener("change", (e) => {
        e.stopPropagation(); // 避免触发 document 上的全局 change 监听造成重复刷新
        const next = startSelect.value;
        if (!/^\d{4}-\d{1,2}$/.test(next)) return;
        const range = normalizeMonthRange(next, state.rangeEnd || endSelect.value);
        state.rangeStart = range.start;
        state.rangeEnd = range.end;
        startSelect.value = state.rangeStart;
        if (endSelect) endSelect.value = state.rangeEnd;
        saveRangeWindow(state.rangeStart, state.rangeEnd); // [需求 4] 区间持久化
        refresh(true);
        fetchKeyDetailFromExport(state.rangeStart, state.rangeEnd);
      });
    }
    if (endSelect) {
      endSelect.addEventListener("change", (e) => {
        e.stopPropagation(); // 避免触发 document 上的全局 change 监听造成重复刷新
        const next = endSelect.value;
        if (!/^\d{4}-\d{1,2}$/.test(next)) return;
        const range = normalizeMonthRange(state.rangeStart || startSelect.value, next);
        state.rangeStart = range.start;
        state.rangeEnd = range.end;
        if (startSelect) startSelect.value = state.rangeStart;
        endSelect.value = state.rangeEnd;
        saveRangeWindow(state.rangeStart, state.rangeEnd); // [需求 4] 区间持久化
        refresh(true);
        fetchKeyDetailFromExport(state.rangeStart, state.rangeEnd);
      });
    }

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

    // 精简视图切换
    const compactBtn = panel.querySelector(".dsapi-plus-toggle-compact-btn");
    if (compactBtn) {
      compactBtn.addEventListener("click", () => {
        state.compactViewVisible = !state.compactViewVisible;
        saveCompactViewVisible();
        compactBtn.classList.toggle("active", state.compactViewVisible);
        panel.classList.toggle("compact", state.compactViewVisible);
      });
      // 初始化恢复状态
      if (state.compactViewVisible) {
        panel.classList.add("compact");
      }
    }

    // 主题模式切换（跟随站点 → 浅色 → 深色 循环，作用于整个用量页面）
    const themeBtn = panel.querySelector(".dsapi-plus-theme-btn");
    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        state.themeMode = nextThemeMode(state.themeMode);
        saveThemeMode();
        const meta = themeModeMeta();
        themeBtn.classList.toggle("active", state.themeMode !== "auto");
        themeBtn.textContent = `${meta.icon} ${meta.text}`;
        themeBtn.title = meta.title;
        // 强制态：翻转 body.dark 并走既有图表重绘；auto 态：还原站点偏好并刷新配色
        if (!applyThemeMode("click")) updateChartTheme();
        startThemeWatchdog(2000); // 2 秒内每 50ms 重试，对抗 React 高频重渲染把 dark 类冲掉
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
          "dsapi_plus_compact_view",
          "dsapi_plus_range_start",   // [需求 4] 区间持久化项属于用户设置，重置时一并清除
          "dsapi_plus_range_end",
          "dsapi_plus_month_cost_visible", // 旧「当月费用」开关存档（已废弃，清除残留）
          "dsapi_plus_theme_mode",         // 主题模式（跟随/浅色/深色）属于用户设置，重置时一并清除
        ];
        for (var ki = 0; ki < keys.length; ki++) {
          try { localStorage.removeItem(keys[ki]); } catch (e) { /* ignore */ }
        }
        // 需求 3：同时清除按月用量数据缓存（历史月永久缓存 + 当前月 TTL 缓存），
        // 保证「清除缓存」对全部数据缓存生效，而不仅仅是设置项。
        clearAllDataCaches();
        location.reload();
      });
    }

    // 自动刷新 — 下拉浮层选择
    const autoRefreshWrap = panel.querySelector(".dsapi-plus-auto-refresh-wrap");
    if (autoRefreshWrap) {
      const autoRefreshBtn = autoRefreshWrap.querySelector(".dsapi-plus-auto-refresh-btn");
      const dropdown = autoRefreshWrap.querySelector(".dsapi-plus-auto-refresh-dropdown");

      // 按钮点击 toggle 浮层
      autoRefreshBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpening = dropdown.style.display !== "block";
        dropdown.style.display = isOpening ? "block" : "none";
        // 每次展开时同步高亮当前选中值
        if (isOpening) {
          dropdown.querySelectorAll("button[data-value]").forEach(b => {
            b.classList.toggle("active", parseInt(b.dataset.value, 10) === state.autoRefreshInterval);
          });
        }
      });

      // 点击 wrap 内部不触发 document 关闭
      autoRefreshWrap.addEventListener("click", (e) => {
        e.stopPropagation();
      });

      // 选项点击
      dropdown.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-value]");
        if (!btn) return;
        const value = parseInt(btn.dataset.value, 10);
        state.autoRefreshInterval = value;
        saveAutoRefreshInterval();
        applyAutoRefresh();
        autoRefreshBtn.classList.toggle("active", value > 0);
        updateAutoRefreshBtnText(autoRefreshBtn); // [新增] 按钮直接显示所选间隔
        dropdown.style.display = "none";
        // 更新浮层内 active 高亮
        dropdown.querySelectorAll("button[data-value]").forEach(b => {
          b.classList.toggle("active", parseInt(b.dataset.value, 10) === value);
        });
      });

      // 初始化时恢复上次保存的状态
      const savedInterval = (() => {
        try {
          return parseInt(localStorage.getItem("dsapi_plus_auto_refresh"), 10) || 0;
        } catch (e) { return 0; }
      })();
      if (savedInterval > 0 && AUTO_REFRESH_INTERVALS.some((i) => i.value === savedInterval)) {
        state.autoRefreshInterval = savedInterval;
        autoRefreshBtn.classList.add("active");
        updateAutoRefreshBtnText(autoRefreshBtn); // [新增] 恢复持久化间隔并同步按钮文案
        applyAutoRefresh();
        // 同步下拉选项高亮
        dropdown.querySelectorAll("button[data-value]").forEach(b => {
          b.classList.toggle("active", parseInt(b.dataset.value, 10) === savedInterval);
        });
      }
    }

    // 点击页面其他位置关闭浮层（使用 capture 阶段确保捕获）
    document.addEventListener("click", function closeAutoRefreshDropdown(e) {
      document.querySelectorAll(".dsapi-plus-auto-refresh-dropdown").forEach(function(d) {
        if (d.style.display !== "none") d.style.display = "none";
      });
    });

    // 初始化时应用原生内容显示状态
    toggleNativeContent(state.nativeContentVisible);

    // 订阅按钮点击 → 打开/关闭订阅面板
    const subscribeBtn = panel.querySelector(".dsapi-plus-subscribe-btn");
    if (subscribeBtn) {
      subscribeBtn.addEventListener("click", function () {
        state.subscriptionVisible = !state.subscriptionVisible;
        saveSubscriptionVisible();
        subscribeBtn.classList.toggle("active", state.subscriptionVisible);
        var content = panel.querySelector(".dsapi-plus-subscribe-inline-content");
        var formStatic = document.getElementById("dsapi-plus-subscribe-form-static");
        if (content) {
          if (state.subscriptionVisible) {
            content.style.display = "";
            if (!content.children.length) {
              var subPanel = renderSubscriptionPanel();
              content.appendChild(subPanel);
              bindSubscriptionPanelEvents(subPanel);
            }
            // 恢复编辑配置面板状态：上次展开则同步展开，否则确保隐藏
            if (state.subscriptionEditVisible && formStatic) {
              var outerPanel = document.getElementById(PANEL_ID);
              showStaticForm(outerPanel ? outerPanel._currentFormIndex : null);
            } else if (formStatic) {
              formStatic.style.display = "none";
            }
          } else {
            content.style.display = "none";
            // 关闭时同步隐藏编辑配置面板，但保留 subscriptionEditVisible 状态以便恢复
            if (formStatic) formStatic.style.display = "none";
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

    // [修改] 原因：页面 React 重渲染会替换“每月用量”锚点节点，原 nextSibling 判断会导致面板被
    // 反复 insertBefore 移动，而移动 select 祖先会立即关闭已打开的原生下拉弹层（月份下拉收回）
    // 改为仅在面板脱离文档或父容器变化时才重新插入，保持面板 DOM 位置稳定
    if (!panel.isConnected || panel.parentNode !== reference.parentNode) {
      reference.parentNode.insertBefore(panel, reference);
    }

    // 每次确保面板时重新应用原生内容显示状态
    toggleNativeContent(state.nativeContentVisible);
    // 每次确保面板时重新应用精简视图状态
    if (state.compactViewVisible && panel) panel.classList.add("compact");

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

    const { start, end } = getSelectedRange();
    const rangeKey = `${start}~${end}`;
    if (!force && state.rangeKey === rangeKey && ["1", "error", "loading"].includes(panel.dataset.loaded)) {
      return;
    }

    state.rangeStart = start;
    state.rangeEnd = end;
    state.rangeKey = rangeKey;
    saveRangeWindow(); // [需求 4] 区间变更/首启落盘，刷新页面后保持用户区间
    panel.dataset.loaded = "loading";
    const requestId = ++state.requestId;
    renderSkeleton(panel, start, end);

    state.abortController?.abort();
    state.abortController = new AbortController();
    const { signal } = state.abortController;
    const timeoutId = setTimeout(() => state.abortController.abort(), 30000);

    try {
      const data = await loadRange(start, end, signal);
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
        renderError(panel, start, end, new Error("请求超时（30 秒）"));
        return;
      }
      panel.dataset.loaded = "error";
      renderError(panel, start, end, error);
      console.error("[DeepSeek Usage Panel Plus]", error);
    }
  }

  function scheduleRefresh(force) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refresh(force), 120);
  }

  // ========== 月份区间工具函数（供面板区间下拉框与聚合加载使用） ==========

  // 计算默认月份窗口：当年 1 月 → 当前月（YTD 年初至今语义）
  // 参数: 无（基于当前系统时间）
  // 返回: { start, end }，如当前为 2026-9 则返回 { start: "2026-1", end: "2026-9" }
  function getDefaultMonthWindow() {
    const now = new Date();
    const endYear = now.getUTCFullYear();
    const endMonth = now.getUTCMonth() + 1;
    return { start: `${endYear}-1`, end: `${endYear}-${endMonth}` };
  }

  // 构建月度统计范围下拉框可选的月份列表（跨年范围，供起止两个下拉框复用）
  // 参数: 无（基于当前系统时间）
  // 返回: string[]，从当前月向前倒序，形如 ["2026-9", ..., "2023-1"]，便于用户就近选择
  function buildMonthSummaryOptionsList() {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    // 起始年份：往前多推 3 年，便于查看更早历史（如当前 2026 年则可选到 2023 年）
    const startYear = currentYear - 3;
    const months = [];
    for (let y = currentYear; y >= startYear; y -= 1) {
      // 当前年从当月往下倒序；历史年份全选；不允许选未来月份
      for (let m = (y === currentYear ? currentMonth : 12); m >= 1; m -= 1) {
        months.push(`${y}-${m}`);
      }
    }
    return months;
  }

  // 生成月度范围下拉框的 option HTML，当前选中值标记 selected
  // 参数:
  //   selected: string，当前选中的月份，如 "2026-1"
  // 返回: string，option 拼接结果
  function buildMonthRangeOptionsHtml(selected) {
    return buildMonthSummaryOptionsList()
      .map((period) => {
        const { year, month } = parsePeriod(period);
        const label = `${year}年${month}月`;
        return `<option value="${period}"${period === selected ? " selected" : ""}>${label}</option>`;
      })
      .join("");
  }

  // 面板头部区间起止双下拉框（与 buildPanelData / renderSkeleton / renderError 共用，保证结构一致）
  function rangeSelectsHtml(start, end) {
    return `
          <label style="font-size:12px;color:var(--dsapi-plus-muted);display:inline-flex;align-items:center;gap:4px;margin-left:6px;">起
            <select class="dsapi-plus-range-start dsapi-plus-period-select" style="height:28px;min-width:88px;">${buildMonthRangeOptionsHtml(start)}</select>
          </label>
          <label style="font-size:12px;color:var(--dsapi-plus-muted);display:inline-flex;align-items:center;gap:4px;">止
            <select class="dsapi-plus-range-end dsapi-plus-period-select" style="height:28px;min-width:88px;">${buildMonthRangeOptionsHtml(end)}</select>
          </label>`;
  }


  // 生成月度趋势双轴图的 ECharts option：柱状=月费用（左轴），折线=月Token（右轴），柱顶标环比
  function buildMonthTrendChartOption(series) {
    const labels = series.map((item) => item.period);
    const costData = series.map((item) => item.costCNY || 0);
    const tokenData = series.map((item) => item.tokens || 0);
    const textColor = getChartTextColor();
    const gridColor = getChartGridColor();
    const option = chartBaseOption();
    // [对齐] 与 keyDaily/dailyTotal 统一 left/right，保持三图绘图区宽度一致
    option.grid.left = 56;
    option.grid.right = 110;
    option.grid.top = 40;
    option.xAxis.data = labels;
    const hasMultiYear =
      new Set(series.map((item) => String(item.period || "").split("-")[0])).size > 1;
    option.xAxis.axisLabel = {
      color: textColor,
      interval: "auto",
      formatter: (value) => {
        const parts = String(value || "").split("-");
        if (parts.length < 2) return value;
        const [year, month] = parts;
        return hasMultiYear ? `${year}年${Number(month)}月` : `${Number(month)}月`;
      },
    };
    option.yAxis = [
      {
        type: "value",
        position: "left",
        // [优化] 原因：base 的 splitNumber:1 会把峰值取整到 50/100 的倍数，轴顶出现大片空白；
        // 改为 4 刻度自适应，Y 轴顶部贴近实际最大值（每日费用明细图同款优化）
        splitNumber: 4,
        splitLine: { lineStyle: { color: gridColor } },
        axisLabel: { color: textColor, align: "left", margin: 34, formatter: (v) => `¥${formatDecimal(v)}` },
      },
      {
        type: "value",
        position: "right",
        splitNumber: 4,
        splitLine: { show: false },
        axisLabel: { color: "#7BCB99", formatter: compactNumber },
      },
    ];
    option.tooltip.formatter = (params) => {
      const idx = params[0].dataIndex;
      const item = series[idx] || {};
      const parts = String(item.period || "").split("-");
      let periodTitle = item.period || "";
      if (parts.length >= 2) {
        const [year, month] = parts;
        periodTitle = hasMultiYear ? `${year}年${Number(month)}月` : `${Number(month)}月`;
      }
      return tooltipHtml(periodTitle, [
        { color: "#0C70F3", label: "月费用", value: formatCnyAmount(item.costCNY || 0) },
        { color: "#7BCB99", label: "月Token", value: formatInteger(item.tokens || 0) },
        { color: "#F59E0B", label: "缓存命中率", value: formatPercent(item.cacheHitRate || 0) },
      ]);
    };
    option.tooltip.appendToBody = false;
    option.tooltip.confine = false;
    option.series = [
      {
        name: "月费用",
        data: costData,
        type: "bar",
        yAxisIndex: 0,
        barMaxWidth: 18,
        itemStyle: { color: "#0C70F3", borderRadius: [3, 3, 0, 0] },
        label: {
          show: true,
          position: "top",
          color: "#F59E0B",
          fontSize: 9,
          formatter: (p) => formatCnyAmount(series[p.dataIndex]?.costCNY || 0),
        },
      },
      {
        name: "月Token",
        data: tokenData,
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        itemStyle: { color: "#7BCB99" },
        lineStyle: { color: "#7BCB99", width: 2 },
        emphasis: { disabled: true },
      },
    ];
    return option;
  }

  function teardownUsage() {
    window.clearTimeout(state.refreshTimer);
    window.clearTimeout(state.mutationTimer);
    window.clearTimeout(state.routeTimer);
    state.abortController?.abort();
    state.abortController = null;
    state.keyDetailAbortController?.abort();
    state.keyDetailAbortController = null;
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    disposeCharts();
    closeSubscriptionPanel();
    state.lastPanelData = null;
    state.rangeStart = "";
    state.rangeEnd = "";
    state.rangeKey = "";
    state.booted = false;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  function startObservers() {
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && /^\d{4}-\d{1,2}$/.test(target.value || "")) {
        // [修改] 面板已改为「起~止区间」聚合，不再跟随原生单月下拉；
        // 区间下拉框自身会 stopPropagation，此处只可能命中原生下拉，
        // 改为非强制刷新，由 refresh 内的 rangeKey 去重避免无意义的重复请求。
        scheduleRefresh(false);
      }
    });

    state.observer = new MutationObserver((mutations) => {
      // 过滤掉仅 panel 内部或 ECharts tooltip DOM 引起的变化，避免不必要刷新数据
      const isPanelOrTooltip = mutations.some((m) => {
        const node = m.target;
        return node && (node.closest ? (node.closest('#' + PANEL_ID) != null || node.closest('.dsapi-plus-chart-tooltip,.dsapi-plus-panel') != null) : false);
      });
      if (isPanelOrTooltip) return;
      window.clearTimeout(state.mutationTimer);
      state.mutationTimer = window.setTimeout(() => {
        // [修改] 原因：原实现无条件调用 ensurePanel，页面任何 DOM 变化都会触发面板重定位，
        // 导致已打开的原生下拉弹层被移动关闭；改为仅在面板缺失或确实需要刷新时恢复面板
        const panel = document.getElementById(PANEL_ID);
        if (!panel) {
          scheduleRefresh(false);
          return;
        }
        const { start, end } = getSelectedRange();
        const rangeKey = `${start}~${end}`;
        if (rangeKey !== state.rangeKey || !panel.dataset.loaded) {
          scheduleRefresh(false);
        }
      }, 250);
    });

    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function bootUsage() {
    if (state.booted) return;
    state.booted = true;
    // 记录站点自身主题偏好，并立即应用持久化的强制模式（auto 态不干预）
    sitePrefersDark = getBodyDark();
    applyThemeMode("boot");
    startThemeWatchdog(2000); // 启动 2 秒高频 watchdog，对抗 React 重渲染
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
