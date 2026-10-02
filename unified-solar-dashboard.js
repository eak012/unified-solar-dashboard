/* Unified Solar Dashboard (Version 2.2 - MEA Rates Updated 2026)
 * Seamless Integration of Real-time Power, Daily History, and MEA Bill
 */

// อัปเดตเรทค่าไฟ MEA ประเภท 1.2 ล่าสุด
const DEFAULT_RATES = {
  serviceCharge: 24.62,
  tiers: [
    { upTo: 200, rate: 3.0000 },
    { upTo: 400, rate: 4.1584 },
    { upTo: Infinity, rate: 4.3583 },
  ],
};
const VAT_DEFAULT = 7;
const FT_DEFAULT = 0.1623; // อัปเดตค่า Ft เริ่มต้นเป็น 16.23 สตางค์

function tieredEnergyCharge(units, tiers) {
  let remaining = Math.max(0, units);
  let prevLimit = 0;
  let total = 0;
  for (const tier of tiers) {
    const blockSize = Math.min(remaining, tier.upTo - prevLimit);
    if (blockSize > 0) {
      total += blockSize * tier.rate;
      remaining -= blockSize;
    }
    prevLimit = tier.upTo;
    if (remaining <= 0) break;
  }
  return total;
}

function getCycleStart(cutoffDay, cutoffTime, now) {
  const [hours, minutes] = (cutoffTime || "00:00").split(":").map(Number);
  let start = new Date(now.getFullYear(), now.getMonth(), cutoffDay, hours || 0, minutes || 0, 0, 0);
  if (start > now) {
    start = new Date(now.getFullYear(), now.getMonth() - 1, cutoffDay, hours || 0, minutes || 0, 0, 0);
  }
  return start;
}

// ---------------- BILL HISTORY HELPERS ----------------
async function fetchSeries(hass, entityId, start, end) {
  if (!entityId) return [];
  const path = `history/period/${start.toISOString()}?filter_entity_id=${entityId}&end_time=${end.toISOString()}&minimal_response`;
  let series;
  try {
    series = await hass.callApi("GET", path);
  } catch (err) {
    return [];
  }
  if (!series || !series[0]) return [];
  return series[0]
    .map((p) => ({ time: new Date(p.last_changed), value: parseFloat(p.state) }))
    .filter((p) => !Number.isNaN(p.value))
    .sort((a, b) => a.time - b.time);
}

async function fetchStatPoints(hass, entityId, start, end) {
  if (!entityId) return [];
  const queryStart = new Date(start.getTime() - 60 * 60 * 1000);
  let result;
  try {
    result = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: queryStart.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [entityId],
      period: "hour",
      types: ["sum"],
    });
  } catch (err) {
    return [];
  }
  const series = (result && result[entityId]) || [];
  const points = series
    .filter((p) => p.sum != null)
    .map((p) => ({ time: new Date(p.end), value: p.sum }))
    .filter((p) => p.time.getTime() <= end.getTime())
    .sort((a, b) => a.time - b.time);
  while (points.length > 1 && points[points.length - 1].value === points[points.length - 2].value) {
    points.pop();
  }
  return points;
}

async function fetchUsageSegments(hass, entityId, start, end) {
  if (!entityId) return [];
  const STATS_SAFETY_MARGIN_MS = 3 * 60 * 60 * 1000;
  const safeStatsEnd = new Date(Math.max(start.getTime(), end.getTime() - STATS_SAFETY_MARGIN_MS));
  const statPoints = safeStatsEnd.getTime() > start.getTime() ? await fetchStatPoints(hass, entityId, start, safeStatsEnd) : [];
  const tailStart = statPoints.length ? statPoints[statPoints.length - 1].time : start;
  const tailPoints = await fetchSeries(hass, entityId, tailStart, end);
  const segments = [];
  if (statPoints.length) segments.push({ source: "stats", points: statPoints });
  if (tailPoints.length) segments.push({ source: "history", points: tailPoints });
  return segments;
}

function totalUsageMulti(segments) {
  return segments.reduce((sum, seg) => sum + totalUsage(seg.points), 0);
}

function totalUsage(points) {
  if (!points.length) return 0;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (last < first) return last;
  return last - first;
}

// ---------------- MAIN COMPONENT ----------------
class UnifiedSolarDashboard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("unified-solar-dashboard-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:unified-solar-dashboard",
      name: "Solar Dashboard",
      power_solar: "",
      power_usage: "",
      energy_solar_daily: "",
      energy_usage_daily: "",
      energy_total_monthly: "",
      energy_solar_monthly: "",
      compare_aggregation: "delta",
      cutoff_day: 24,
      cutoff_time: "09:00",
      history_months: 3,
      service_charge: 24.62,
      ft_baht: FT_DEFAULT,
      vat: 7
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data15Days = [];
    this._billData = null;
    this._billHistory = [];
    this._lastFetch = 0;
    this._loadingCompare = false;
    this._compareView = "chart";
    this._compareSelected = null;
    this._compareDays = 15;
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = {
      ...UnifiedSolarDashboard.getStubConfig(),
      ...config,
    };
    
    // Fallbacks
    this._config.compare_aggregation = this._config.compare_aggregation || "delta";
    this._config.cutoff_day = Number(this._config.cutoff_day || 24);
    this._config.history_months = Number(this._config.history_months || 0);
    this._config.service_charge = Number(this._config.service_charge ?? 24.62);
    this._config.ft_baht = Number(this._config.ft_baht ?? FT_DEFAULT);
    this._config.vat = Number(this._config.vat ?? 7);
    
    // Merge duplicated keys
    if(config.entity_power_solar && !config.power_solar) this._config.power_solar = config.entity_power_solar;
    if(config.entity_power_usage && !config.power_usage) this._config.power_usage = config.entity_power_usage;
    if(config.entity_energy_solar_daily && !config.energy_solar_daily) this._config.energy_solar_daily = config.entity_energy_solar_daily;
    if(config.entity_energy_usage_daily && !config.energy_usage_daily) this._config.energy_usage_daily = config.entity_energy_usage_daily;
    if(config.entity_energy_solar_total && !config.energy_solar_monthly) this._config.energy_solar_monthly = config.entity_energy_solar_total;
    if(config.entity_energy_total && !config.energy_total_monthly) this._config.energy_total_monthly = config.entity_energy_total;

    this._lastFetch = 0;
    this._firstRender();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateRealtime();
    
    const now = Date.now();
    if (now - this._lastFetch > 300000) {
      this._lastFetch = now;
      this._fetchHeavyData();
    }
  }

  // ---------------- REALTIME BAR LOGIC ----------------
  _getState(entityId, decimals = 0) {
    if (!this._hass || !entityId || !this._hass.states[entityId]) return null;
    const val = parseFloat(this._hass.states[entityId].state);
    if (isNaN(val)) return 0;
    return val;
  }

  _fireMoreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true, composed: true, detail: { entityId: entityId },
    }));
  }

  _updateRealtime() {
    if (!this.shadowRoot || !this.ui) return;
    const cfg = this._config;

    const solarPwr = this._getState(cfg.power_solar) || 0;
    const usagePwr = this._getState(cfg.power_usage) || 0;
    const gridPwr = usagePwr - solarPwr;

    const solarEng = cfg.energy_solar_daily ? this._getState(cfg.energy_solar_daily) : null;
    const usageEng = cfg.energy_usage_daily ? this._getState(cfg.energy_usage_daily) : null;

    const isExport = gridPwr < 0;
    const gridValAbs = Math.abs(gridPwr);
    const gridLabel = isExport ? "Export" : "Import";

    // Power W no decimals
    this.ui.valSolar.textContent = `${Math.round(solarPwr)} W`;
    this.ui.valUsage.textContent = `${Math.round(usagePwr)} W`;
    this.ui.valGrid.textContent = `${Math.round(gridValAbs)} W`;
    this.ui.lblGrid.textContent = gridLabel;
    this.ui.lblUsageBar.textContent = `${gridLabel} ${Math.round(gridValAbs)} W`;

    // Energy kWh 1 decimal
    if (solarEng !== null) {
      this.ui.engSolar.textContent = ` / ${solarEng.toFixed(1)} kWh`;
      this.ui.engSolar.style.display = 'inline';
    } else {
      this.ui.engSolar.style.display = 'none';
    }
    
    if (usageEng !== null) {
      this.ui.engUsage.textContent = ` / ${usageEng.toFixed(1)} kWh`;
      this.ui.engUsage.style.display = 'inline';
    } else {
      this.ui.engUsage.style.display = 'none';
    }

    let solarBarPct = 0;
    let gridBarPct = 0;
    if (usagePwr > 0) {
      if (gridPwr > 0) {
        let importPwr = Math.min(gridPwr, usagePwr); 
        let solarUsedByHouse = usagePwr - importPwr;
        solarBarPct = (solarUsedByHouse / usagePwr) * 100;
        gridBarPct = (importPwr / usagePwr) * 100;
      } else {
        solarBarPct = 100;
        gridBarPct = 0;
      }
    }
    this.ui.barSolar.style.width = `${solarBarPct}%`;
    this.ui.barGrid.style.width = `${gridBarPct}%`;

    if (gridValAbs === 0) {
      this.ui.flowDots.style.opacity = '0';
      this.ui.flowDots.style.animationPlayState = 'paused';
    } else {
      this.ui.flowDots.style.opacity = '0.9';
      this.ui.flowDots.style.animationPlayState = 'running';
      this.ui.flowDots.className = `flow-dots ${isExport ? 'flow-export' : 'flow-import'}`;
      this.ui.flowDots.style.setProperty('--dot-color', isExport ? '#4fc3f7' : '#ffa726');
      let ratio = isExport ? Math.min(1, Math.max(0, gridValAbs - 150) / 1850) : Math.min(1, Math.max(0, gridValAbs - 150) / 3850);
      this.ui.flowDots.style.animationDuration = `${0.7 - (ratio * 0.5)}s`;
    }
  }

  // ---------------- COMPARE DATA FETCHING ----------------
  async _fetchCompareHistoryData(entityId, start) {
    return this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: new Date().toISOString(),
      entity_ids: [entityId],
      minimal_response: false,
      no_attributes: true,
      significant_changes_only: false,
    }).then(result => {
      if (!result) return [];
      if (Array.isArray(result)) {
        const found = result.find(r => r && r.entity_id === entityId);
        return (found && (found.states || found.data)) || [];
      }
      return result[entityId] || [];
    }).catch(() => []);
  }

  async _fetchCompareDailyStats(entityId, days) {
    const end = new Date();
    const start = new Date(end.getTime() - (days + 2) * 24 * 3600 * 1000);
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const toMs = (t) => {
      if (t == null) return NaN;
      if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
      return Date.parse(t);
    };
    const callStats = (types) => this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      period: "day",
      statistic_ids: [entityId],
      ...(types ? { statistic_types: types } : {}),
    });

    let result;
    try { result = await callStats(["change", "sum", "state"]); } 
    catch (e) { result = await callStats(null); }

    const rows = (result?.[entityId] || [])
      .map(r => ({ ms: toMs(r.start), change: num(r.change), sum: num(r.sum), state: num(r.state) }))
      .filter(r => Number.isFinite(r.ms))
      .sort((a, b) => a.ms - b.ms);

    const map = new Map();
    let prevSum = null;
    let prevState = null;
    for (const r of rows) {
      const key = this._localDateKey(new Date(r.ms));
      let daily = null;
      if (r.change != null) daily = Math.max(0, r.change);
      else if (r.sum != null && prevSum != null) { daily = r.sum - prevSum; if (daily < 0) daily = Math.max(0, r.sum); }
      else if (r.state != null && prevState != null) { daily = r.state - prevState; if (daily < 0) daily = Math.max(0, r.state); }
      if (daily != null && Number.isFinite(daily)) map.set(key, Math.max(0, daily));
      if (r.sum != null) prevSum = r.sum;
      if (r.state != null) prevState = r.state;
    }
    return map;
  }

  _localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  _normaliseHistory(history) {
    return (history || [])
      .map(item => {
        const value = Number.parseFloat(item.state ?? item.s);
        let ms = Date.parse(item.last_changed || item.last_updated || "");
        if (!Number.isFinite(ms)) {
          const lc = item.lc ?? item.lu;
          const n = Number(lc);
          if (Number.isFinite(n)) ms = n < 1e12 ? n * 1000 : n;
        }
        const dt = new Date(ms);
        return { value, dt, date: Number.isFinite(ms) ? this._localDateKey(dt) : null };
      })
      .filter(x => Number.isFinite(x.value) && x.date)
      .sort((a, b) => a.dt - b.dt);
  }

  _buildDailyData(solarPts, usagePts, solarStat, usageStat) {
    if (this._config.compare_aggregation === "daily") {
      const lastByDate = (pts) => {
        const m = new Map();
        for (const p of this._normaliseHistory(pts)) m.set(p.date, p.value);
        return m;
      };
      const sM = lastByDate(solarPts);
      const uM = lastByDate(usagePts);
      const dates = new Set([...sM.keys(), ...uM.keys()]);
      return [...dates].sort().map(date => ({
        date, solar: Math.max(0, sM.get(date) ?? 0), usage: Math.max(0, uM.get(date) ?? 0),
      }));
    } else {
      const perEntity = (pts) => {
        const norm = this._normaliseHistory(pts);
        const lastByDate = new Map();
        for (const p of norm) lastByDate.set(p.date, p.value);
        const dates = [...lastByDate.keys()].sort();
        const out = new Map();
        let prev = null;
        for (const d of dates) {
          const cur = lastByDate.get(d);
          if (prev != null && cur != null) {
            let delta = cur - prev;
            if (delta < 0) {
              let gain = 0, p2 = null;
              for(const p of norm) { if(p.date === d) { if(p2!=null && p.value>p2) gain+=p.value-p2; p2=p.value; } }
              delta = gain;
              if (!(delta > 0)) delta = Math.max(0, cur);
            }
            out.set(d, Math.max(0, delta));
          }
          if (cur != null) prev = cur;
        }
        return out;
      };
      const sD = perEntity(solarPts);
      const uD = perEntity(usagePts);
      const useStatS = sD.size === 0 && solarStat && solarStat.size > 0;
      const useStatU = uD.size === 0 && usageStat && usageStat.size > 0;
      const dates = new Set([...sD.keys(), ...uD.keys(), ...(useStatS ? solarStat.keys() : []), ...(useStatU ? usageStat.keys() : [])]);
      return [...dates].sort().map(date => ({
        date,
        solar: Math.max(0, useStatS ? (solarStat.get(date) ?? 0) : (sD.get(date) ?? 0)),
        usage: Math.max(0, useStatU ? (usageStat.get(date) ?? 0) : (uD.get(date) ?? 0)),
      }));
    }
  }

  // ---------------- BILL FETCHING ----------------
  async _calculatePeriodBill(start, end) {
    const cfg = this._config;
    const totalSegs = await fetchUsageSegments(this._hass, cfg.energy_total_monthly, start, end);
    const totalUnits = totalUsageMulti(totalSegs);
    let solarUnits = 0;
    if (cfg.energy_solar_monthly) {
      const solarSegs = await fetchUsageSegments(this._hass, cfg.energy_solar_monthly, start, end);
      solarUnits = totalUsageMulti(solarSegs);
    }
    const netUnits = Math.max(0, totalUnits - solarUnits);
    
    // คำนวณด้วยเรทใหม่ (Type 1.2)
    const energyCharge = tieredEnergyCharge(netUnits, DEFAULT_RATES.tiers);
    const ftCharge = netUnits * cfg.ft_baht;
    const subtotal = energyCharge + cfg.service_charge + ftCharge;
    const totalCost = subtotal + (subtotal * (cfg.vat / 100));
    
    return { totalUnits, solarUnits, netUnits, cost: totalCost };
  }

  async _fetchHeavyData() {
    if (!this._hass || !this._config) return;
    const cfg = this._config;
    const now = new Date();

    // 1. Compare Card Data - ดึงจาก monthly เสมอตามที่คุณต้องการ (ค่าสะสม) 
    if (cfg.energy_solar_monthly && cfg.energy_total_monthly) {
      const start = new Date(now.getTime() - (this._compareDays + 3) * 24 * 3600 * 1000);
      try {
        const [solarHist, usageHist] = await Promise.all([
          this._fetchCompareHistoryData(cfg.energy_solar_monthly, start),
          this._fetchCompareHistoryData(cfg.energy_total_monthly, start),
        ]);
        let solarStat = null, usageStat = null;
        if (!solarHist.length) solarStat = await this._fetchCompareDailyStats(cfg.energy_solar_monthly, this._compareDays).catch(()=>null);
        if (!usageHist.length) usageStat = await this._fetchCompareDailyStats(cfg.energy_total_monthly, this._compareDays).catch(()=>null);
        
        const all = this._buildDailyData(solarHist, usageHist, solarStat, usageStat);
        this._data15Days = all.slice(-this._compareDays);
        if (this._data15Days.length && (!this._compareSelected || !this._data15Days.some(d => d.date === this._compareSelected))) {
          this._compareSelected = this._data15Days[this._data15Days.length - 1].date;
        }
      } catch (e) {
        console.error("Error fetching compare data", e);
      }
    }

    // 2. MEA Bill Data
    if (cfg.energy_total_monthly) {
      const start = getCycleStart(cfg.cutoff_day, cfg.cutoff_time, now);
      this._billData = await this._calculatePeriodBill(start, now);
      
      this._billHistory = [];
      if (cfg.history_months > 0) {
        let currentCycleStart = getCycleStart(cfg.cutoff_day, cfg.cutoff_time, now);
        const [hours, minutes] = (cfg.cutoff_time || "00:00").split(":").map(Number);
        for (let i = 1; i <= cfg.history_months; i++) {
          let prevCycleStart = new Date(currentCycleStart.getFullYear(), currentCycleStart.getMonth() - 1, cfg.cutoff_day, hours || 0, minutes || 0, 0, 0);
          let prevCycleEnd = new Date(currentCycleStart.getTime());
          const histUsage = await this._calculatePeriodBill(prevCycleStart, prevCycleEnd);
          if (histUsage.totalUnits > 0 || histUsage.solarUnits > 0) {
            const monthLabel = `${prevCycleEnd.getFullYear()}-${String(prevCycleEnd.getMonth() + 1).padStart(2, '0')}`;
            this._billHistory.push({ label: monthLabel, ...histUsage });
          }
          currentCycleStart = prevCycleStart;
        }
      }
    }
    this._renderHeavy();
  }

  // ---------------- RENDERING ----------------
  _firstRender() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 14px; font-family: var(--paper-font-body1_-_font-family, inherit); }
        .divider { height: 1px; background: var(--divider-color, rgba(127,127,127,0.2)); margin: 16px 0; }
        
        /* 1. Bar Styles */
        .stats-container { display: flex; justify-content: space-between; background: var(--secondary-background-color, rgba(125,125,125,0.08)); border-radius: 8px; padding: 5px 8px; margin-bottom: 12px; border: 1px solid var(--divider-color, rgba(125,125,125,0.15)); overflow: hidden; }
        .stat-box { flex: 1; text-align: center; border-right: 1px solid var(--divider-color, rgba(125,125,125,0.15)); cursor: pointer; padding: 4px 0; transition: background 0.2s ease; }
        .stat-box:last-child { border-right: none; }
        .stat-box:active, .stat-box:hover { background: var(--secondary-background-color, rgba(125,125,125,0.15)); }
        .stat-title { font-size: 0.7em; color: var(--secondary-text-color); margin-bottom: 1px; font-weight: 500; }
        .stat-value { font-size: 1.0em; font-weight: 600; color: var(--primary-text-color); }
        .sub-val { font-size: 0.75em; color: var(--secondary-text-color); font-weight: 400; }
        .visual-container { display: flex; align-items: center; gap: 10px; }
        .icon-wrap { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: var(--secondary-background-color, rgba(125,125,125,0.1)); flex-shrink: 0; }
        .icon-wrap ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
        .house-icon { border: 1px solid #b39ddb; } 
        .grid-icon { border: 1px solid #909399; } 
        .bar-wrapper { flex: 1; position: relative; display: flex; flex-direction: column; gap: 6px; }
        .progress-track { height: 20px; background: var(--secondary-background-color, rgba(125,125,125,0.1)); border-radius: 10px; position: relative; display: flex; overflow: hidden; }
        .bar-solar { height: 100%; background: #ff5c23; transition: width 0.4s ease-out; }
        .bar-grid { height: 100%; background: #7FACD6; transition: width 0.4s ease-out; }
        .usage-label-center { position: absolute; width: 100%; text-align: center; font-size: 0.72em; color: #fff; font-weight: 600; line-height: 20px; z-index: 1; text-shadow: 0px 0px 3px rgba(0,0,0,0.4); }
        .flow-container { position: relative; width: 100%; height: 12px; display: flex; align-items: center; }
        .flow-track { position: absolute; left: 0; right: 0; height: 12px; background-image: radial-gradient(circle, var(--divider-color, rgba(125,125,125,0.4)) 1px, transparent 1.5px); background-size: 8px 12px; background-repeat: repeat-x; }
        .flow-dots { position: absolute; left: 0; right: 0; height: 12px; --dot-color: #ffa726; background-image: radial-gradient(circle, var(--dot-color) 3.5px, transparent 4px); background-size: 32px 12px; background-repeat: repeat-x; opacity: 0; }
        .flow-export { animation: moveDotsRight 2s linear infinite; }
        .flow-import { animation: moveDotsLeft 2s linear infinite; }
        @keyframes moveDotsRight { 0% { background-position: 0 center; } 100% { background-position: 32px center; } }
        @keyframes moveDotsLeft { 0% { background-position: 32px center; } 100% { background-position: 0 center; } }

        /* 2. Compare Styles */
        .comp-wrap { position:relative; }
        .comp-tabs { display:inline-flex; min-width:140px; background:rgba(127,127,127,.12); border-radius:8px; padding:2px; margin-bottom:10px; gap:2px; }
        .comp-tab { flex:1; border:0; border-radius:6px; padding:4px 10px; font-size:12px; font-weight:600; background:transparent; color:var(--secondary-text-color); cursor:pointer; transition:background .15s ease, color .15s ease; }
        .comp-tab.active { background:var(--primary-color, #1f7ae0); color:#fff; box-shadow:0 2px 6px rgba(0,0,0,.20); }
        .legend { display:flex; gap:18px; align-items:center; flex-wrap:wrap; font-size:12px; margin-bottom:10px; color:var(--secondary-text-color); }
        .legend-val { color:var(--primary-text-color); font-variant-numeric:tabular-nums; }
        .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:7px; vertical-align:-1px; }
        .dot.solar { background:#ff5c23; }
        .dot.usage { background:#7FACD6; }
        .chart-body { display:flex; height:160px; }
        .y-axis { position:relative; width:36px; flex-shrink:0; }
        .y-axis span { position:absolute; right:6px; transform:translateY(50%); font-size:11px; line-height:1; color:var(--secondary-text-color); }
        .plot { flex:1; position:relative; min-width:0; }
        .chart-svg { display:block; width:100%; height:100%; }
        .grid-line { stroke:var(--divider-color, rgba(127,127,127,.35)); stroke-width:1; }
        .avg-line { stroke:#ff5c23; stroke-width:1; opacity:0.6; }
        .solar-bar { fill:#ff5c23; }
        .usage-bar { fill:#7FACD6; }
        .hit { fill:transparent; cursor:pointer; }
        .day-group.active .hit { fill:rgba(42,137,255,.10); stroke:rgba(42,137,255,.50); stroke-width:1; }
        .day-group.active .solar-bar, .day-group.active .usage-bar { filter:brightness(1.08); }
        @keyframes barGrow { from { transform: scaleY(0); opacity: 0; } to { transform: scaleY(1); opacity: 1; } }
        .bar { transform-origin: bottom; transform-box: fill-box; animation: barGrow 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) backwards; }
        .x-axis { display:flex; margin-left:36px; margin-top:5px; }
        .x-col { flex:1; min-width:0; text-align:center; }
        .x-col b { display:block; font-size:11px; font-weight:500; }
        .x-col span { display:block; font-size:10px; color:var(--secondary-text-color); }
        .tooltip { position:absolute; z-index:10; width:185px; box-sizing:border-box; padding:9px 11px; border-radius:11px; background:var(--card-background-color, #fff); border:1px solid var(--divider-color, rgba(127,127,127,.4)); box-shadow:0 8px 24px rgba(0,0,0,.25); color:var(--primary-text-color); font-size:12px; pointer-events:none; opacity:0; transform:translateY(4px); transition:opacity .2s, transform .2s; }
        .tooltip.show { opacity:1; transform:translateY(0); }
        .tip-date { font-weight:700; margin-bottom:2px; }
        .tip-diff { margin-top:4px; padding-top:4px; border-top:1px solid var(--divider-color, rgba(127,127,127,.2)); }
        
        .list-wrap { display:flex; flex-direction:column; gap:6px; max-height:300px; overflow-y:auto; padding-right:2px; }
        .list-row { display:flex; align-items:center; gap:12px; padding:8px 10px; border-radius:11px; background:rgba(127,127,127,.08); border:1px solid var(--divider-color, rgba(127,127,127,.25)); cursor:pointer; }
        .list-row.active { border-color:var(--primary-color, #1f7ae0); }
        .list-date { display:flex; flex-direction:column; align-items:center; min-width:36px; }
        .list-date b { font-size:15px; line-height:1; }
        .list-date span { font-size:11px; color:var(--secondary-text-color); }
        .list-mid { flex:1; display:flex; flex-direction:column; gap:5px; }
        .list-bar-row { display:flex; align-items:center; gap:7px; }
        .mini-track { flex:1; height:6px; border-radius:4px; background:rgba(127,127,127,.20); overflow:hidden; }
        .mini-fill { height:100%; border-radius:4px; }
        .list-val { font-size:12px; min-width:52px; text-align:right; }
        .list-right { display:flex; flex-direction:column; align-items:flex-end; min-width:54px; }
        .list-badge { font-size:10px; color:var(--secondary-text-color); margin-top:4px; background:rgba(127,127,127,.12); padding:2px 4px; border-radius:4px; }

        /* 3. Bill Styles */
        .minimal-bill-box { background: var(--secondary-background-color, rgba(125,125,125,0.08)); border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--divider-color, rgba(125,125,125,0.15)); }
        .bill-cycle { font-size: 0.8em; color: var(--secondary-text-color); margin-bottom: 4px;}
        .bill-units { font-size: 0.9em; font-weight: 500; line-height: 1.4; }
        .bill-total { font-size: 1.6em; font-weight: 700; color: var(--primary-color, #0288d1); text-align:right; }
        .history-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--divider-color, rgba(125,125,125,0.2)); }
        .history-title { font-weight: 600; font-size: 0.95em; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; color: var(--primary-text-color); }
        .history-table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
        .history-table th, .history-table td { padding: 6px 4px; border-bottom: 1px solid var(--divider-color, rgba(125,125,125,0.15)); }
        .history-table th { color: var(--secondary-text-color); font-weight: 500; text-align: left; }
        .history-table th.num, .history-table td.num { text-align: right; }
        .current-row { background-color: var(--secondary-background-color, rgba(125,125,125,0.1)); font-weight: 500; }
        .badge-live { font-size: 0.68em; background: var(--primary-color, #ff5c23); color: #fff; padding: 1px 5px; border-radius: 4px; margin-left: 4px; }
        .solar-txt { color: #67c23a; font-weight: 500; }
      </style>
      <ha-card>
        <!-- Top: Bar -->
        <div class="stats-container">
          <div id="box-solar" class="stat-box" title="Show Solar Details">
            <div class="stat-title">Solar</div>
            <div class="stat-value"><span id="val-solar">0 W</span><span id="eng-solar" class="sub-val" style="display: none;"></span></div>
          </div>
          <div id="box-usage" class="stat-box" title="Show Usage Details">
            <div class="stat-title">Usage</div>
            <div class="stat-value"><span id="val-usage">0 W</span><span id="eng-usage" class="sub-val" style="display: none;"></span></div>
          </div>
          <div id="box-grid" class="stat-box" title="Calculated Grid Power">
            <div id="lbl-grid" class="stat-title">Grid</div>
            <div class="stat-value"><span id="val-grid">0 W</span></div>
          </div>
        </div>
        <div class="visual-container">
          <div class="icon-wrap house-icon"><ha-icon icon="mdi:home"></ha-icon></div>
          <div class="bar-wrapper">
            <div class="progress-track">
               <div id="bar-solar" class="bar-solar" style="width: 0%;"></div>
               <div id="bar-grid" class="bar-grid" style="width: 0%;"></div>
               <span id="lbl-usage-bar" class="usage-label-center">0 W</span>
            </div>
            <div class="flow-container"><div class="flow-track"></div><div id="flow-dots" class="flow-dots"></div></div>
          </div>
          <div class="icon-wrap grid-icon"><ha-icon icon="mdi:transmission-tower"></ha-icon></div>
        </div>

        <div class="divider"></div>

        <!-- Middle: Compare Container -->
        <div id="compare-container"></div>

        <!-- Bottom: Bill Container -->
        <div id="bill-container"></div>
      </ha-card>
    `;

    this.ui = {
      boxSolar: this.shadowRoot.querySelector('#box-solar'),
      boxUsage: this.shadowRoot.querySelector('#box-usage'),
      valSolar: this.shadowRoot.querySelector('#val-solar'),
      engSolar: this.shadowRoot.querySelector('#eng-solar'),
      valUsage: this.shadowRoot.querySelector('#val-usage'),
      engUsage: this.shadowRoot.querySelector('#eng-usage'),
      lblGrid: this.shadowRoot.querySelector('#lbl-grid'),
      valGrid: this.shadowRoot.querySelector('#val-grid'),
      barSolar: this.shadowRoot.querySelector('#bar-solar'),
      barGrid: this.shadowRoot.querySelector('#bar-grid'),
      lblUsageBar: this.shadowRoot.querySelector('#lbl-usage-bar'),
      flowDots: this.shadowRoot.querySelector('#flow-dots'),
      compareDiv: this.shadowRoot.querySelector('#compare-container'),
      billDiv: this.shadowRoot.querySelector('#bill-container')
    };

    this.ui.boxSolar.addEventListener("click", () => this._fireMoreInfo(this._config.power_solar));
    this.ui.boxUsage.addEventListener("click", () => this._fireMoreInfo(this._config.power_usage));
  }

  _fmt(v) { return Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  
  _dayLabel(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return { day: String(d), month: dt.toLocaleDateString("th-TH", { month: "short" }).replace(".", "") };
  }
  
  _dateFull(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
  }

  _renderHeavy() {
    this._renderCompare();
    this._renderBill();
  }

  _renderCompare() {
    if (!this.ui.compareDiv) return;
    const data = this._data15Days || [];
    const isChart = this._compareView === "chart";
    const max = Math.max(1, ...data.flatMap(d => [d.solar, d.usage]));
    
    let content = `<div class="comp-wrap">`;
    content += `<div class="comp-tabs"><button class="comp-tab ${isChart?'active':''}" data-view="chart">กราฟ</button><button class="comp-tab ${!isChart?'active':''}" data-view="list">รายการ</button></div>`;
    
    const today = data.length ? data[data.length - 1] : null;
    content += `<div class="legend"><span><i class="dot solar"></i>ผลิตไฟ <b class="legend-val">${today ? this._fmt(today.solar) : "–"} kWh</b></span><span><i class="dot usage"></i>ใช้ไฟ <b class="legend-val">${today ? this._fmt(today.usage) : "–"} kWh</b></span></div>`;

    if (isChart) {
      const W = 700, H = 160;
      const groupW = data.length > 0 ? W / data.length : W;
      const gap = Math.min(5, groupW * 0.10);
      const barW = Math.max(3, (groupW - gap * 3) / 2);
      const avgSolar = data.reduce((sum, d) => sum + d.solar, 0) / (data.length||1);
      const avgY = H - H * (avgSolar / max);

      let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">`;
      for (let i = 0; i <= 4; i++) {
        const y = H - H * (i / 4);
        svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="grid-line"/>`;
      }
      if (data.length > 0) svg += `<line x1="0" y1="${avgY}" x2="${W}" y2="${avgY}" class="avg-line" stroke-dasharray="4 4"/>`;
      
      data.forEach((d, i) => {
        const center = groupW * i + groupW / 2;
        const sH = H * (d.solar / max);
        const uH = H * (d.usage / max);
        const active = d.date === this._compareSelected ? " active" : "";
        svg += `
          <g class="day-group${active}" data-date="${d.date}">
            <rect class="hit" x="${groupW*i}" y="0" width="${groupW}" height="${H}" rx="4"/>
            <rect class="bar solar-bar" x="${center - barW - gap / 2}" y="${H - sH}" width="${barW}" height="${Math.max(1.5, sH)}" rx="2" style="animation-delay:${(i * 0.02).toFixed(2)}s"/>
            <rect class="bar usage-bar" x="${center + gap / 2}" y="${H - uH}" width="${barW}" height="${Math.max(1.5, uH)}" rx="2" style="animation-delay:${(i * 0.02 + 0.1).toFixed(2)}s"/>
          </g>
        `;
      });
      svg += `</svg>`;

      let xLabels = `<div class="x-axis">`;
      data.forEach(d => {
        const l = this._dayLabel(d.date);
        xLabels += `<div class="x-col"><b>${l.day}</b><span>${l.month}</span></div>`;
      });
      xLabels += `</div>`;

      content += `
        <div class="chart-body">
          <div class="y-axis">${[0,1,2,3,4].map(i => `<span style="bottom:${i*25}%">${Math.round(max*i/4)}</span>`).join("")}</div>
          <div class="plot" id="plot">${svg}<div class="tooltip" id="tooltip"></div></div>
        </div>
        ${xLabels}
      `;
    } else {
      content += `<div class="list-wrap">`;
      [...data].reverse().forEach(d => {
        const l = this._dayLabel(d.date);
        const sPct = Math.max(2, (d.solar / max) * 100);
        const uPct = Math.max(2, (d.usage / max) * 100);
        const suff = d.usage > 0 ? Math.min(100, (d.solar / d.usage) * 100) : (d.solar > 0 ? 100 : 0);
        const active = d.date === this._compareSelected ? " active" : "";
        content += `
          <div class="list-row${active}" data-date="${d.date}">
            <div class="list-date"><b>${l.day}</b><span>${l.month}</span></div>
            <div class="list-mid">
              <div class="list-bar-row"><i class="dot solar"></i><div class="mini-track"><div class="mini-fill" style="background:#ff5c23; width:${sPct.toFixed(1)}%"></div></div><span class="list-val">${this._fmt(d.solar)}</span></div>
              <div class="list-bar-row"><i class="dot usage"></i><div class="mini-track"><div class="mini-fill" style="background:#7FACD6; width:${uPct.toFixed(1)}%"></div></div><span class="list-val">${this._fmt(d.usage)}</span></div>
            </div>
            <div class="list-right"><div style="font-size:11px; color:var(--secondary-text-color);">kWh</div><div class="list-badge">${suff.toFixed(0)}% ครอบคลุม</div></div>
          </div>
        `;
      });
      content += `</div>`;
    }
    content += `</div>`;
    this.ui.compareDiv.innerHTML = content;
    
    // Bind Compare Events
    this.shadowRoot.querySelectorAll(".comp-tab").forEach(btn => {
      btn.addEventListener("click", () => { this._compareView = btn.dataset.view; this._renderCompare(); });
    });
    
    if (isChart) {
      const tooltip = this.shadowRoot.querySelector("#tooltip");
      const plot = this.shadowRoot.querySelector("#plot");
      let hideTimeout = null;
      this.shadowRoot.querySelectorAll(".day-group").forEach(group => {
        group.addEventListener("click", e => {
          const date = group.dataset.date;
          const d = this._data15Days.find(x => x.date === date);
          if(!d) return;
          this._compareSelected = date;
          this.shadowRoot.querySelectorAll(".day-group").forEach(g => g.classList.remove("active"));
          group.classList.add("active");
          const rect = plot.getBoundingClientRect();
          const x = (e.clientX ?? rect.left + rect.width / 2) - rect.left;
          const y = (e.clientY ?? rect.top + 20) - rect.top;
          const diff = d.solar - d.usage;
          const diffColor = diff >= 0 ? "#ff5c23" : "#db4437";
          tooltip.innerHTML = `
            <div class="tip-date">${this._dateFull(d.date)}</div>
            <div><i class="dot solar"></i>ผลิตไฟ <b>${this._fmt(d.solar)} kWh</b></div>
            <div><i class="dot usage"></i>ใช้ไฟ <b>${this._fmt(d.usage)} kWh</b></div>
            <div class="tip-diff"><i class="dot" style="background:transparent; border:1px solid ${diffColor};"></i>ผลต่าง: <b style="color:${diffColor}">${diff>=0?'+':''}${this._fmt(diff)} kWh</b></div>
          `;
          tooltip.classList.add("show");
          let left = x - 92;
          left = Math.max(4, Math.min(rect.width - 185 - 4, left));
          tooltip.style.left = `${left}px`;
          tooltip.style.top = `${Math.max(4, y - 90)}px`;
          if (hideTimeout) clearTimeout(hideTimeout);
          hideTimeout = setTimeout(() => { tooltip.classList.remove("show"); group.classList.remove("active"); }, 3000);
        });
      });
    } else {
      this.shadowRoot.querySelectorAll(".list-row").forEach(row => {
        row.addEventListener("click", () => { this._compareSelected = row.dataset.date; this._renderCompare(); });
      });
    }
  }

  _renderBill() {
    if (!this.ui.billDiv) return;
    if (!this._billData) {
      this.ui.billDiv.innerHTML = "";
      return;
    }
    const b = this._billData;
    const cfg = this._config;
    let html = `<div class="divider"></div>`;
    
    html += `
      <div class="minimal-bill-box">
        <div>
          <div class="bill-cycle">รอบบิลปัจจุบัน (ตัดรอบวันที่ ${cfg.cutoff_day})</div>
          <div class="bill-units">
            ใช้ไฟ: ${b.totalUnits.toFixed(1)} <span style="color:var(--secondary-text-color); font-size:0.85em;">kWh</span> | 
            Solar: -${b.solarUnits.toFixed(1)} <span style="color:var(--secondary-text-color); font-size:0.85em;">kWh</span><br/>
            <span style="color: var(--primary-color);">สุทธิคิดเงิน: <b>${b.netUnits.toFixed(1)}</b> <span style="font-size:0.85em;">kWh</span></span>
          </div>
        </div>
        <div class="bill-total"><span style="color: #ff5c23;">${b.cost.toFixed(2)}</span> <small style="font-size:0.6em;">฿</small></div>
      </div>
    `;

    if (cfg.history_months > 0 && this._billHistory.length > 0) {
      const now = new Date();
      const currentMonthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      html += `
        <div class="history-section">
          <div class="history-title"><ha-icon icon="mdi:history" style="--mdc-icon-size:18px; color:var(--secondary-text-color);"></ha-icon><span>สถิติค่าไฟฟ้าย้อนหลังตามรอบบิล</span></div>
          <table class="history-table">
            <thead>
              <tr>
                <th>รอบบิล</th>
                <th class="num">ใช้ไฟ</th>
                <th class="num">Solar</th>
                <th class="num">ค่าไฟ</th>
              </tr>
            </thead>
            <tbody>
              <tr class="current-row">
                <td><b>${currentMonthLabel}</b><span class="badge-live">สด</span></td>
                <td class="num">${b.totalUnits.toFixed(1)}</td>
                <td class="num"><span class="solar-txt">-${b.solarUnits.toFixed(1)}</span></td>
                <td class="num" style="font-weight:600;">${b.cost.toFixed(2)} ฿</td>
              </tr>
              ${this._billHistory.map(row => `
                <tr>
                  <td><b>${row.label}</b></td>
                  <td class="num">${row.totalUnits.toFixed(1)}</td>
                  <td class="num"><span class="solar-txt">-${row.solarUnits.toFixed(1)}</span></td>
                  <td class="num" style="font-weight:600;">${row.cost.toFixed(2)} ฿</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
    this.ui.billDiv.innerHTML = html;
  }
}

// ---------------- EDITOR (100% Native HTML Inputs Fix) ----------------
class UnifiedSolarDashboardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._render(); }
  set hass(hass) { this._hass = hass; if(this.shadowRoot && this.shadowRoot.innerHTML==="") this._render(); }
  
  _valueChanged(field, value) {
    if (!this._config) return;
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    
    // Fallbacks just in case
    const c = this._config || {};
    const getVal = (key, def) => c[key] !== undefined ? c[key] : def;

    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
        .row2 { display: flex; gap: 12px; }
        .row2 .row { flex: 1; }
        label { font-size: 0.85em; color: var(--secondary-text-color); font-weight: 500; }
        
        /* ใช้งาน Standard Native Input มั่นใจว่ากดติด 100% */
        input, select { 
          padding: 8px; border-radius: 4px; 
          border: 1px solid var(--divider-color, #ccc); 
          background: var(--card-background-color, #fff); 
          color: var(--primary-text-color, #000); 
          font-size: 0.9em; width: 100%; box-sizing: border-box; 
        }
        input:focus, select:focus { border-color: var(--primary-color, #03a9f4); outline: none; }
        ha-entity-picker { width: 100%; }
        h4 { margin: 16px 0 8px 0; color: var(--primary-text-color); font-size: 1.05em; border-bottom: 1px solid var(--divider-color, rgba(127,127,127,0.2)); padding-bottom: 4px; }
      </style>
      <div>
        <h4>1. Real-time Bar (W & kWh)</h4>
        <div class="row"><ha-entity-picker id="power_solar" label="Power Solar (W)"></ha-entity-picker></div>
        <div class="row"><ha-entity-picker id="power_usage" label="Power Usage (W)"></ha-entity-picker></div>
        <div class="row"><ha-entity-picker id="energy_solar_daily" label="Daily Solar Energy (kWh)"></ha-entity-picker></div>
        <div class="row"><ha-entity-picker id="energy_usage_daily" label="Daily Usage Energy (kWh)"></ha-entity-picker></div>
        
        <h4>2. Daily Compare (15 Days)</h4>
        <div class="row">
          <label>Aggregation (รูปแบบการคำนวณกราฟ)</label>
          <select id="compare_aggregation">
            <option value="delta" ${getVal('compare_aggregation', 'delta') === 'delta' ? 'selected' : ''}>delta (สำหรับมิเตอร์สะสม)</option>
            <option value="daily" ${getVal('compare_aggregation', 'delta') === 'daily' ? 'selected' : ''}>daily (สำหรับเซ็นเซอร์รายวัน)</option>
          </select>
        </div>

        <h4>3. MEA Bill & History</h4>
        <div class="row"><ha-entity-picker id="energy_solar_monthly" label="Total Solar Energy (kWh)"></ha-entity-picker></div>
        <div class="row"><ha-entity-picker id="energy_total_monthly" label="Total Grid Energy (kWh)"></ha-entity-picker></div>
        
        <div class="row2">
          <div class="row">
            <label>Cutoff Day (1-31)</label>
            <input id="cutoff_day" type="number" min="1" max="31" value="${getVal('cutoff_day', 24)}">
          </div>
          <div class="row">
            <label>Cutoff Time (HH:MM)</label>
            <input id="cutoff_time" type="time" value="${getVal('cutoff_time', '09:00')}">
          </div>
        </div>
        
        <div class="row2">
          <div class="row">
            <label>History Months (รอบบิลย้อนหลัง)</label>
            <select id="history_months">
              <option value="0" ${getVal('history_months', 0) === 0 ? 'selected' : ''}>0 (ไม่แสดง)</option>
              <option value="3" ${getVal('history_months', 0) === 3 ? 'selected' : ''}>3 เดือน</option>
              <option value="6" ${getVal('history_months', 0) === 6 ? 'selected' : ''}>6 เดือน</option>
              <option value="12" ${getVal('history_months', 0) === 12 ? 'selected' : ''}>12 เดือน</option>
            </select>
          </div>
          <div class="row">
            <label>VAT (%)</label>
            <input id="vat" type="number" step="0.1" value="${getVal('vat', 7)}">
          </div>
        </div>
        
        <div class="row2">
          <div class="row">
            <label>Service Charge (฿/month)</label>
            <input id="service_charge" type="number" step="0.01" value="${getVal('service_charge', 24.62)}">
          </div>
          <div class="row">
            <label>Ft Rate (฿/unit)</label>
            <input id="ft_baht" type="number" step="0.0001" value="${getVal('ft_baht', FT_DEFAULT)}">
          </div>
        </div>
      </div>
    `;

    // 1. Bind HA Entity Pickers
    const bindEntity = (id) => {
      const el = this.shadowRoot.getElementById(id);
      if(el) {
        el.hass = this._hass;
        el.value = this._config[id] || "";
        el.addEventListener("value-changed", (e) => this._valueChanged(id, e.detail.value));
      }
    };
    ['power_solar', 'power_usage', 'energy_solar_daily', 'energy_usage_daily', 'energy_solar_monthly', 'energy_total_monthly'].forEach(bindEntity);

    // 2. Bind Native Inputs/Selects
    const bindInput = (id, isNum) => {
      const el = this.shadowRoot.getElementById(id);
      if(el) {
        el.addEventListener("change", (e) => {
          let v = e.target.value;
          if (isNum) v = Number(v);
          if (this._config[id] !== v) this._valueChanged(id, v);
        });
      }
    };
    
    bindInput("compare_aggregation", false);
    bindInput("cutoff_day", true);
    bindInput("cutoff_time", false);
    bindInput("history_months", true);
    bindInput("service_charge", true);
    bindInput("ft_baht", true);
    bindInput("vat", true);
  }
}

customElements.define("unified-solar-dashboard", UnifiedSolarDashboard);
customElements.define("unified-solar-dashboard-editor", UnifiedSolarDashboardEditor);
window.customCards = window.customCards || [];
window.customCards.push({ type: "unified-solar-dashboard", name: "Unified Solar Dashboard v2.2", description: "Seamless integration of Real-time, Daily, and MEA Bill (Type 1.2 updated rates)." });
