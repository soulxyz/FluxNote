/**
 * 热力图渲染模块
 * 用于在侧边栏显示活动热力图
 */

/**
 * 生成热力图
 * @param {Object} heatmapData - 热力图数据 {date: count}
 * @param {string} navigateUrl - 点击跳转的基础URL
 */
export function generateHeatmap(heatmapData, navigateUrl = '/blog') {
    const grid = document.getElementById('heatmapGrid');
    const tooltip = document.getElementById('customTooltip');

    if (!grid || !heatmapData) return;

    grid.innerHTML = '';
    const today = new Date();
    const weeks = 12;

    for (let w = weeks - 1; w >= 0; w--) {
        for (let d = 0; d < 7; d++) {
            const date = new Date(today);
            date.setDate(date.getDate() - (w * 7 + (6 - d)));
            const dateStr = date.toISOString().split('T')[0];
            const count = heatmapData[dateStr] || 0;

            const cell = document.createElement('div');
            cell.className = 'heatmap-cell';
            cell.dataset.date = dateStr;

            let level = 0;
            if (count > 0) level = 1;
            if (count >= 2) level = 2;
            if (count >= 4) level = 3;
            if (count >= 6) level = 4;

            cell.setAttribute('data-level', level);

            cell.addEventListener('click', () => {
                if (window.themeSDK) {
                    window.themeSDK.navigate(`${navigateUrl}?date=${dateStr}`);
                } else {
                    window.location.href = `${navigateUrl}?date=${dateStr}`;
                }
            });

            cell.addEventListener('mouseenter', () => {
                if (tooltip) {
                    tooltip.innerHTML = `<b>${dateStr}</b><br>${count} 篇笔记`;
                    tooltip.style.opacity = '1';

                    const rect = cell.getBoundingClientRect();
                    tooltip.style.left = `${rect.left + (rect.width / 2)}px`;
                    tooltip.style.top = `${rect.top}px`;
                }
            });

            cell.addEventListener('mouseleave', () => {
                if (tooltip) tooltip.style.opacity = '0';
            });

            grid.appendChild(cell);
        }
    }
}

/**
 * 初始化热力图（自动从全局变量读取数据）
 */
export function initHeatmap() {
    if (window.heatmapData) {
        generateHeatmap(window.heatmapData, '/blog');
    }
}

// 自动绑定事件
window.addEventListener('page-ready', initHeatmap);
window.addEventListener('DOMContentLoaded', initHeatmap);
