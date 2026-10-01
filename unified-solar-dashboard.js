/* Unified Solar Dashboard 
 * Seamless Integration of Real-time Power, Daily History, and MEA Bill
 */

const DEFAULT_RATES = {
  serviceCharge: 24.62,
  tiers: [
    { upTo: 150, rate: 3.2484 },
    { upTo: 400, rate: 4.2218 },
    { upTo: Infinity, rate: 4.4217 },
  ],
};
const VAT_DEFAULT = 7;
const FT_DEFAULT = 0.3972;

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

// Minimal History Fetcher
async function fetchStatPoints(hass, entityId, start, end, period="hour") {
  if (!entityId) return [];
  const queryStart = new Date(start.getTime() - 60 * 60 * 1000);
  let result;
  try {
    result = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: queryStart.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [entityId],
      period: period,
      types: ["sum", "state", "change"],
    });
  } catch (err) {
    return [];
  }
  return result[entityId] || [];
}

class UnifiedSolarDashboard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("unified-solar-dashboard-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:unified-solar-dashboard",
      name: "Solar Dashboard",
      entity_power_solar: "",
      entity_power_usage: "",
      entity_energy_solar_daily: "",
      entity_energy_usage_daily: "",
      entity_energy_total: "",
      entity_energy_solar_total: "",
      cutoff_day: 24,
      ft_baht: FT_DEFAULT,
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = {
      name: config.name || "Solar Dashboard",
      entity_power_solar: config.entity_power_solar,
      entity_power_usage: config.entity_power_usage,
      entity_energy_solar_daily: config.entity_energy_solar_daily,
      entity_energy_usage_daily: config.entity_energy_usage_daily,
      entity_energy_total: config.entity_energy_total,
      entity_energy_solar_total: config.entity_energy_solar_total,
      cutoff_day: Number(config.cutoff_day || 24),
      cutoff_time: config.cutoff_time || "09:00",
      ft_baht: config.ft_baht != null ? Number(config.ft_baht) : FT_DEFAULT,
      service_charge: config.service_charge != null ? Number(config.service_charge) : DEFAULT_RATES.serviceCharge,
      vat: Number(config.vat ?? VAT_DEFAULT),
      days: 15
    };
    
    this._data15Days = [];
    this._billData = null;
    this._lastFetch = 0;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    
    // Update real-time immediately
    this._updateRealtime();

    // Throttle heavy fetching (every 5 mins)
    const now = Date.now();
    if (now - this._lastFetch > 300000) {
      this._lastFetch = now;
      this._fetchHeavyData();
    }
  }
  
  _getState(entityId) {
    if (!this._hass || !entityId) return 0;
    const state = this._hass.states[entityId];
    return state ? parseFloat(state.state) || 0 : 0;
  }

  _updateRealtime() {
    if (!this.shadowRoot) return;
    const solarPwr = this._getState(this._config.entity_power_solar);
    const usagePwr = this._getState(this._config.entity_power_usage);
    const gridPwr = usagePwr - solarPwr;
    const gridValAbs = Math.abs(gridPwr);
    const isExport = gridPwr < 0;

    const elSolar = this.shadowRoot.getElementById('val-solar');
    const elUsage = this.shadowRoot.getElementById('val-usage');
    const elGrid = this.shadowRoot.getElementById('val-grid');
    const elLblGrid = this.shadowRoot.getElementById('lbl-grid');
    const elBarSolar = this.shadowRoot.getElementById('bar-solar');
    const elBarGrid = this.shadowRoot.getElementById('bar-grid');
    const elFlowDots = this.shadowRoot.getElementById('flow-dots');
    const elLblUsageBar = this.shadowRoot.getElementById('lbl-usage-bar');

    if(elSolar) elSolar.textContent = `${solarPwr} W`;
    if(elUsage) elUsage.textContent = `${usagePwr} W`;
    if(elGrid) elGrid.textContent = `${gridValAbs} W`;
    if(elLblGrid) elLblGrid.textContent = isExport ? "Export" : "Import";
    if(elLblUsageBar) elLblUsageBar.textContent = `${isExport ? "Export" : "Import"} ${gridValAbs} W`;

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
    if(elBarSolar) elBarSolar.style.width = `${solarBarPct}%`;
    if(elBarGrid) elBarGrid.style.width = `${gridBarPct}%`;

    if(elFlowDots) {
      if (gridValAbs === 0) {
        elFlowDots.style.opacity = '0';
        elFlowDots.style.animationPlayState = 'paused';
      } else {
        elFlowDots.style.opacity = '0.9';
        elFlowDots.style.animationPlayState = 'running';
        elFlowDots.className = `flow-dots ${isExport ? 'flow-export' : 'flow-import'}`;
        elFlowDots.style.setProperty('--dot-color', isExport ? '#4fc3f7' : '#ffa726');
        let ratio = isExport ? Math.min(1, Math.max(0, gridValAbs - 150) / 1850) : Math.min(1, Math.max(0, gridValAbs - 150) / 3850);
        elFlowDots.style.animationDuration = `${0.7 - (ratio * 0.5)}s`;
      }
    }
  }

  async _fetchHeavyData() {
    if (!this._hass || !this._config) return;
    const now = new Date();
    
    // 1. Fetch MEA Bill Data
    const cycleStart = getCycleStart(this._config.cutoff_day, this._config.cutoff_time, now);
    const totalStats = await fetchStatPoints(this._hass, this._config.entity_energy_total, cycleStart, now);
    const solarStats = await fetchStatPoints(this._hass, this._config.entity_energy_solar_total, cycleStart, now);
    
    const getUsage = (pts) => {
        if(!pts || pts.length === 0) return 0;
        const validPts = pts.filter(p => p.sum != null);
        if(validPts.length < 2) return 0;
        return validPts[validPts.length-1].sum - validPts[0].sum;
    };
    
    const totalU = getUsage(totalStats);
    const solarU = getUsage(solarStats);
    const netU = Math.max(0, totalU - solarU);
    
    // Calc Bill
    const energyCharge = tieredEnergyCharge(netU, DEFAULT_RATES.tiers);
    const ftCharge = netU * this._config.ft_baht;
    const subtotal = energyCharge + this._config.service_charge + ftCharge;
    const totalCost = subtotal + (subtotal * (this._config.vat / 100));
    
    this._billData = { totalU, solarU, netU, totalCost };

    // 2. Fetch 15-Day Chart Data (Using daily entities for simplicity if provided, or fallback to zero)
    const days = 15;
    const chartStart = new Date(now.getTime() - (days + 2) * 24 * 3600 * 1000);
    const dailySolar = await fetchStatPoints(this._hass, this._config.entity_energy_solar_daily, chartStart, now, "day");
    const dailyUsage = await fetchStatPoints(this._hass, this._config.entity_energy_usage_daily, chartStart, now, "day");
    
    // Parse Daily Stats
    const mapDaily = (pts) => {
        const map = new Map();
        pts.forEach(p => {
           if(p.state != null) {
               const dt = new Date(p.start);
               const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
               map.set(key, Math.max(0, p.state));
           } 
        });
        return map;
    };
    const sMap = mapDaily(dailySolar);
    const uMap = mapDaily(dailyUsage);
    
    const dates = [...new Set([...sMap.keys(), ...uMap.keys()])].sort();
    this._data15Days = dates.slice(-days).map(d => ({
        date: d,
        solar: sMap.get(d) || 0,
        usage: uMap.get(d) || 0
    }));

    this._render();
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    
    // Build Chart SVG
    const data = this._data15Days || [];
    const max = Math.max(1, ...data.flatMap(d => [d.solar, d.usage]));
    const W = 700, H = 160;
    const groupW = data.length > 0 ? W / data.length : W;
    const gap = Math.min(5, groupW * 0.10);
    const barW = Math.max(3, (groupW - gap * 3) / 2);
    
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:100%;">`;
    for (let i = 0; i <= 4; i++) {
      const y = H - H * (i / 4);
      svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="var(--divider-color, rgba(127,127,127,.35))"/>`;
    }
    data.forEach((d, i) => {
      const center = groupW * i + groupW / 2;
      const sH = H * (d.solar / max);
      const uH = H * (d.usage / max);
      svg += `
        <rect x="${center - barW - gap / 2}" y="${H - sH}" width="${barW}" height="${Math.max(1, sH)}" fill="#ffbd32" rx="2"/>
        <rect x="${center + gap / 2}" y="${H - uH}" width="${barW}" height="${Math.max(1, uH)}" fill="#2389ff" rx="2"/>
      `;
    });
    svg += `</svg>`;
    
    const xLabels = data.map(d => {
        const [y, m, day] = d.date.split('-');
        return `<div style="flex:1; text-align:center; font-size:10px; color:var(--secondary-text-color);">${Number(day)}</div>`;
    }).join("");

    // Bill Info
    const b = this._billData || { totalU:0, solarU:0, netU:0, totalCost:0 };

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; font-family: var(--paper-font-body1_-_font-family, inherit); }
        .section { margin-bottom: 20px; }
        
        /* Real-time styles */
        .stats-container { display: flex; justify-content: space-between; background: rgba(125, 125, 125, 0.08); border-radius: 8px; padding: 8px; margin-bottom: 12px; border: 1px solid rgba(125, 125, 125, 0.15); }
        .stat-box { flex: 1; text-align: center; border-right: 1px solid rgba(125, 125, 125, 0.15); }
        .stat-box:last-child { border-right: none; }
        .stat-title { font-size: 0.7em; color: var(--secondary-text-color); margin-bottom: 2px; }
        .stat-value { font-size: 1.1em; font-weight: 600; color: var(--primary-text-color); }
        
        .progress-track { height: 20px; background: rgba(125, 125, 125, 0.1); border-radius: 10px; position: relative; display: flex; overflow: hidden; flex:1; margin: 0 10px; }
        .bar-solar { height: 100%; background: #4fc3f7; transition: width 0.4s; }
        .bar-grid { height: 100%; background: #b39ddb; transition: width 0.4s; }
        .usage-label-center { position: absolute; width: 100%; text-align: center; font-size: 0.75em; color: #fff; font-weight: 600; line-height: 20px; text-shadow: 0px 0px 3px rgba(0,0,0,0.5); }
        .flow-container { height: 12px; position: relative; margin: 4px 10px 0; }
        .flow-track { position: absolute; left: 0; right: 0; height: 12px; background-image: radial-gradient(circle, rgba(125, 125, 125, 0.4) 1px, transparent 1.5px); background-size: 8px 12px; }
        .flow-dots { position: absolute; left: 0; right: 0; height: 12px; background-image: radial-gradient(circle, var(--dot-color, #ffa726) 3.5px, transparent 4px); background-size: 32px 12px; opacity: 0; }
        .flow-export { animation: moveRight 2s linear infinite; }
        .flow-import { animation: moveLeft 2s linear infinite; }
        @keyframes moveRight { to { background-position: 32px center; } }
        @keyframes moveLeft { to { background-position: -32px center; } }

        /* Chart styles */
        .chart-box { background: rgba(125, 125, 125, 0.05); border-radius: 8px; padding: 12px; }
        .chart-title { font-size: 0.85em; font-weight: 600; margin-bottom: 8px; display:flex; justify-content: space-between; }
        
        /* Minimal Bill styles */
        .minimal-bill-box { background: rgba(125, 125, 125, 0.08); border-radius: 8px; padding: 14px 16px; margin-top: 16px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(125, 125, 125, 0.2); }
        .bill-cycle { font-size: 0.8em; color: var(--secondary-text-color); margin-bottom:4px; }
        .bill-units { font-size: 0.9em; font-weight: 500; line-height: 1.4;}
        .bill-total { font-size: 1.6em; font-weight: 700; color: var(--primary-color, #0288d1); text-align:right;}
      </style>

      <ha-card>
        <!-- Top: Realtime -->
        <div class="section">
          <div class="stats-container">
            <div class="stat-box"><div class="stat-title">Solar</div><div class="stat-value" id="val-solar">0 W</div></div>
            <div class="stat-box"><div class="stat-title">Usage</div><div class="stat-value" id="val-usage">0 W</div></div>
            <div class="stat-box"><div class="stat-title" id="lbl-grid">Grid</div><div class="stat-value" id="val-grid">0 W</div></div>
          </div>
          <div style="display:flex; align-items:center;">
            <ha-icon icon="mdi:home" style="color:var(--secondary-text-color);"></ha-icon>
            <div style="flex:1;">
               <div class="progress-track">
                 <div id="bar-solar" class="bar-solar"></div>
                 <div id="bar-grid" class="bar-grid"></div>
                 <span id="lbl-usage-bar" class="usage-label-center">0 W</span>
               </div>
               <div class="flow-container"><div class="flow-track"></div><div id="flow-dots" class="flow-dots"></div></div>
            </div>
            <ha-icon icon="mdi:transmission-tower" style="color:var(--secondary-text-color);"></ha-icon>
          </div>
        </div>

        <!-- Middle: SVG Chart -->
        <div class="section chart-box">
          <div class="chart-title">
            <span>เปรียบเทียบย้อนหลัง 15 วัน</span>
            <span style="font-size:0.9em; font-weight:normal;"><span style="color:#ffbd32;">■</span> Solar &nbsp; <span style="color:#2389ff;">■</span> Usage</span>
          </div>
          <div style="height:120px; width:100%; position:relative;">
            ${svg}
          </div>
          <div style="display:flex; margin-top:4px;">${xLabels}</div>
        </div>

        <!-- Bottom: Minimal MEA Bill -->
        <div class="minimal-bill-box">
          <div>
            <div class="bill-cycle">รอบบิลปัจจุบัน (ตัดรอบวันที่ ${this._config.cutoff_day})</div>
            <div class="bill-units">
              ใช้ไฟ: ${b.totalU.toFixed(1)} <span style="color:var(--secondary-text-color); font-size:0.85em;">kWh</span> | 
              Solar: -${b.solarU.toFixed(1)} <span style="color:var(--secondary-text-color); font-size:0.85em;">kWh</span><br/>
              <span style="color: var(--primary-color);">สุทธิคิดเงิน: <b>${b.netU.toFixed(1)}</b> <span style="font-size:0.85em;">kWh</span></span>
            </div>
          </div>
          <div class="bill-total">
            ${b.totalCost.toFixed(2)} <small style="font-size:0.6em;">฿</small>
          </div>
        </div>
      </ha-card>
    `;
    
    // Repopulate real-time
    this._updateRealtime();
  }
}

// Minimal Editor
class UnifiedSolarDashboardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._render(); }
  set hass(hass) { this._hass = hass; if(this.shadowRoot && this.shadowRoot.innerHTML==="") this._render(); }
  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px;">
        <h3>Unified Config</h3>
        <ha-entity-picker id="entity_power_solar" label="Power Solar (W)"></ha-entity-picker>
        <ha-entity-picker id="entity_power_usage" label="Power Usage (W)"></ha-entity-picker>
        <ha-entity-picker id="entity_energy_solar_daily" label="Daily Solar Energy (kWh)"></ha-entity-picker>
        <ha-entity-picker id="entity_energy_usage_daily" label="Daily Usage Energy (kWh)"></ha-entity-picker>
        <ha-entity-picker id="entity_energy_solar_total" label="Total Solar Energy (kWh)"></ha-entity-picker>
        <ha-entity-picker id="entity_energy_total" label="Total Grid Energy (kWh)"></ha-entity-picker>
        <ha-textfield id="cutoff_day" label="MEA Cutoff Day (1-31)" type="number"></ha-textfield>
      </div>
    `;
    // Attach event listeners... (simplified for brevity)
    const attach = (id) => {
       const el = this.shadowRoot.getElementById(id);
       if(el) {
           el.hass = this._hass;
           el.value = this._config[id] || "";
           el.addEventListener("value-changed", (e) => {
               this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: { ...this._config, [id]: e.detail.value } }, bubbles: true, composed: true }));
           });
       }
    };
    ['entity_power_solar', 'entity_power_usage', 'entity_energy_solar_daily', 'entity_energy_usage_daily', 'entity_energy_solar_total', 'entity_energy_total'].forEach(attach);
    
    const cutoff = this.shadowRoot.getElementById("cutoff_day");
    if(cutoff) {
       cutoff.value = this._config.cutoff_day;
       cutoff.addEventListener("change", (e) => {
           this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: { ...this._config, cutoff_day: Number(e.target.value) } }, bubbles: true, composed: true }));
       });
    }
  }
}

customElements.define("unified-solar-dashboard", UnifiedSolarDashboard);
customElements.define("unified-solar-dashboard-editor", UnifiedSolarDashboardEditor);
window.customCards = window.customCards || [];
window.customCards.push({ type: "unified-solar-dashboard", name: "Unified Solar Dashboard", description: "Seamless integration of Real-time, Daily, and MEA Bill." });
