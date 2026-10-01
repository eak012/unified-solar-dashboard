# Unified Solar Dashboard

A seamless Home Assistant custom card that merges real-time solar/grid power, a 15-day daily comparison chart, and a minimal MEA electric bill summary into one clean interface.

## Features
- **Real-time Power Bar**: Live W values for Solar, Usage, and Grid with animated flow.
- **Daily History Chart**: 15-day SVG bar chart comparing Solar vs Usage.
- **Minimal MEA Bill**: Calculates your progressive MEA bill (Type 1.2) with Solar deduction and displays it in a clean, minimal UI.

## Installation (HACS)
1. Open **HACS** -> **Frontend**.
2. Click the 3 dots in the top right -> **Custom repositories**.
3. Add the URL to your GitHub repository and select category as `Lovelace`.
4. Click **Install**.
5. Add the resource `/hacsfiles/unified-solar-dashboard/unified-solar-dashboard.js` to your Lovelace dashboard.

## Configuration
Use the Visual Editor in Home Assistant or configure manually in YAML.
