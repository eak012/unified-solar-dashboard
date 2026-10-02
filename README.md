# Unified Solar Dashboard for Home Assistant

A seamless, all-in-one Home Assistant custom card that merges real-time solar/grid power, a 15-day daily comparison chart, and a minimal MEA (Thailand) electric bill summary into one clean interface.

<img width="423" height="714" alt="Screenshot 2569-10-02 at 11 28 44" src="https://github.com/user-attachments/assets/d9a667b1-f47e-4642-ba70-a77302d8e346" />


## Features
- ⚡ **Real-time Power Bar**: Live power (W) values for Solar, Usage, and calculated Grid (Import/Export) with animated flow dots.
- 📊 **15-Day History Chart**: SVG-based bar chart comparing daily Solar vs Usage. Includes a clickable tooltip that auto-hides and a list view.
- 💰 **Minimal MEA Bill (Type 1.2)**: Auto-calculates your progressive MEA bill (Thailand) using the latest rates (> 150 units = 3.00 THB), including Solar deduction, VAT, Service Charge, and Ft rate.
- 🕒 **Bill History**: Shows a history table of your previous billing cycles.
- ⚙️ **Fully Functional Visual Editor**: 100% native HTML input editor, ensuring compatibility and easy setup without writing YAML.

## Installation via HACS

1. Open **HACS** in your Home Assistant.
2. Go to **Frontend**.
3. Click the 3 dots in the top right corner and select **Custom repositories**.
4. Add the URL of this GitHub repository and select the category as `Dashboard`.
5. Click **Install**.
6. When adding a card to your dashboard, search for **Unified Solar Dashboard**.

## Configuration

You can configure the card entirely via the **Visual Editor** in Home Assistant. Alternatively, you can use the YAML configuration below:

```yaml
type: custom:unified-solar-dashboard
name: Solar Dashboard

# 1. Real-time Entities (W)
power_solar: sensor.solar_meter_energy_power
power_usage: sensor.main_power

# 2. Daily Energy Entities (kWh) - For top stats
energy_solar_daily: sensor.daily_pv
energy_usage_daily: sensor.daily_energy

# 3. Monthly/Total Energy Entities (kWh) - For Chart & MEA Bill
energy_solar_monthly: sensor.solar_meter_energy_total
energy_total_monthly: sensor.main_energy

# 4. Chart Settings
compare_aggregation: delta # Use "delta" for total accumulated meters, or "daily" for sensors that reset at midnight.

# 5. MEA Bill Settings
cutoff_day: 24
cutoff_time: '09:00'
history_months: 3
vat: 7
service_charge: 24.62
ft_baht: 0.1623 # Example: 16.23 Satang
