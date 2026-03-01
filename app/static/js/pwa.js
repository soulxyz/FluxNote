import { showToast } from './modules/utils.js';

export const pwa = {
    init() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                // 使用根路径下的 /sw.js，确保护盖全站作用域
                navigator.serviceWorker.register('/sw.js')
                    .then(registration => {
                        console.log('[PWA] Service Worker registered:', registration.scope);
                        
                        // 1. 处理初始加载时的更新检测
                        if (registration.waiting) {
                            this.updateFound(registration.waiting);
                        }

                        // 2. 监听后续发现的新版本
                        registration.onupdatefound = () => {
                            const installingWorker = registration.installing;
                            installingWorker.onstatechange = () => {
                                if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                    this.updateFound(installingWorker);
                                }
                            };
                        };
                    })
                    .catch(error => {
                        console.error('[PWA] Registration failed:', error);
                    });

                // 3. 监听控制器更替，新 SW 激活后自动刷新
                let refreshing = false;
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    if (refreshing) return;
                    refreshing = true;
                    console.log('[PWA] Controller changed, reloading...');
                    window.location.reload();
                });
            });
        }
    },

    /**
     * 当发现新版本已就绪（waiting）时调用
     */
    updateFound(worker) {
        console.log('[PWA] New version available');
        
        // 检查是否存在现有提示
        if (document.querySelector('.pwa-update-toast')) return;

        // Add animation styles if not present
        if (!document.getElementById('pwa-styles')) {
            const style = document.createElement('style');
            style.id = 'pwa-styles';
            style.textContent = `
                @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
            `;
            document.head.appendChild(style);
        }

        const updateToast = document.createElement('div');
        updateToast.className = 'pwa-update-toast';
        
        updateToast.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: white;
            color: #1e293b;
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 12px;
            border: 1px solid #e2e8f0;
            max-width: 300px;
            animation: slideIn 0.3s ease-out;
            font-family: system-ui, -apple-system, sans-serif;
        `;

        updateToast.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fas fa-sparkles" style="color:#10B981; font-size:1.2em;"></i>
                <div style="flex:1;">
                    <h4 style="margin:0; font-size:14px; font-weight:600;">发现新版本</h4>
                    <p style="margin:4px 0 0; font-size:12px; color:#64748b;">更新以获取最新功能和修复</p>
                </div>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button id="pwaLaterBtn" style="padding:6px 12px; font-size:12px; border:1px solid #e2e8f0; background:white; color:#64748b; border-radius:6px; cursor:pointer; transition: all 0.2s;">稍后</button>
                <button id="pwaRefreshBtn" style="padding:6px 12px; font-size:12px; border:none; background:#10B981; color:white; border-radius:6px; cursor:pointer; font-weight:500; transition: all 0.2s;">立即刷新</button>
            </div>
        `;

        document.body.appendChild(updateToast);

        // 绑定事件
        document.getElementById('pwaRefreshBtn').onclick = () => {
            // 发送 skipWaiting 消息触发激活，进而触发 controllerchange 刷新页面
            worker.postMessage('skipWaiting');
            updateToast.innerHTML = '<div style="text-align:center; padding:10px; color:#64748b;"><i class="fas fa-spinner fa-spin"></i> 正在更新...</div>';
        };

        document.getElementById('pwaLaterBtn').onclick = () => {
            updateToast.style.animation = 'fadeOut 0.3s ease-in forwards';
            setTimeout(() => updateToast.remove(), 300);
        };
    }
};

pwa.init();
