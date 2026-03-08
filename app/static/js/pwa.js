import { showToast } from './modules/utils.js';

export const pwa = {
    _deferredPrompt: null,
    _installDismissed: false,

    init() {
        this._registerServiceWorker();
        this._listenInstallPrompt();
        this._listenNetworkStatus();
    },

    // ── Service Worker 注册与更新 ──

    _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;

        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js')
                .then(registration => {
                    console.log('[PWA] Service Worker registered:', registration.scope);

                    if (registration.waiting) {
                        this._showUpdateToast(registration.waiting);
                    }

                    registration.onupdatefound = () => {
                        const installingWorker = registration.installing;
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                this._showUpdateToast(installingWorker);
                            }
                        };
                    };
                })
                .catch(error => {
                    console.error('[PWA] Registration failed:', error);
                });

            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (refreshing) return;
                refreshing = true;
                window.location.reload();
            });
        });
    },

    _showUpdateToast(worker) {
        if (document.querySelector('.pwa-update-toast')) return;

        if (!document.getElementById('pwa-anim-styles')) {
            const style = document.createElement('style');
            style.id = 'pwa-anim-styles';
            style.textContent = `
                @keyframes pwaSlideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes pwaFadeOut { from { opacity: 1; } to { opacity: 0; } }
            `;
            document.head.appendChild(style);
        }

        const toast = document.createElement('div');
        toast.className = 'pwa-update-toast';
        toast.style.cssText = `
            position: fixed; bottom: 24px; right: 24px;
            background: white; color: #1e293b; padding: 16px;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1);
            z-index: 9999; display: flex; flex-direction: column; gap: 12px;
            border: 1px solid #e2e8f0; max-width: 300px;
            animation: pwaSlideIn .3s ease-out;
            font-family: system-ui, -apple-system, sans-serif;
        `;
        toast.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <i class="fas fa-sparkles" style="color:#10B981;font-size:1.2em;"></i>
                <div style="flex:1;">
                    <h4 style="margin:0;font-size:14px;font-weight:600;">发现前端新版本</h4>
                    <p style="margin:4px 0 0;font-size:12px;color:#64748b;">更新到浏览器缓存以快速使用最新特性</p>
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="pwaLaterBtn" style="padding:6px 12px;font-size:12px;border:1px solid #e2e8f0;background:white;color:#64748b;border-radius:6px;cursor:pointer;">稍后</button>
                <button id="pwaRefreshBtn" style="padding:6px 12px;font-size:12px;border:none;background:#10B981;color:white;border-radius:6px;cursor:pointer;font-weight:500;">立即刷新</button>
            </div>
        `;
        document.body.appendChild(toast);

        document.getElementById('pwaRefreshBtn').onclick = () => {
            worker.postMessage('skipWaiting');
            toast.innerHTML = '<div style="text-align:center;padding:10px;color:#64748b;"><i class="fas fa-spinner fa-spin"></i> 正在更新...</div>';
        };
        document.getElementById('pwaLaterBtn').onclick = () => {
            toast.style.animation = 'pwaFadeOut .3s ease-in forwards';
            setTimeout(() => toast.remove(), 300);
        };
    },

    // ── PWA 安装提示 ──

    _listenInstallPrompt() {
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this._deferredPrompt = e;

            if (this._installDismissed) return;

            const dismissed = sessionStorage.getItem('pwa-install-dismissed');
            if (dismissed) return;

            setTimeout(() => this._showInstallPrompt(), 3000);
        });

        window.addEventListener('appinstalled', () => {
            this._deferredPrompt = null;
            this._removeInstallPrompt();
            showToast('应用安装成功');
        });
    },

    _showInstallPrompt() {
        if (!this._deferredPrompt || document.querySelector('.pwa-install-prompt')) return;

        const prompt = document.createElement('div');
        prompt.className = 'pwa-install-prompt';
        prompt.innerHTML = `
            <div class="pwa-install-icon"><i class="fas fa-download"></i></div>
            <div class="pwa-install-content">
                <div class="pwa-install-title">安装流光笔记</div>
                <div class="pwa-install-desc">添加到桌面，获得原生应用体验</div>
            </div>
            <div class="pwa-install-actions">
                <button class="btn pwa-dismiss-btn" style="background:transparent;color:var(--slate-500);border:1px solid var(--slate-200);">忽略</button>
                <button class="btn pwa-accept-btn" style="background:var(--primary);color:white;">安装</button>
            </div>
        `;
        document.body.appendChild(prompt);

        prompt.querySelector('.pwa-accept-btn').onclick = async () => {
            if (!this._deferredPrompt) return;
            this._deferredPrompt.prompt();
            const { outcome } = await this._deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                console.log('[PWA] User accepted install');
            }
            this._deferredPrompt = null;
            this._removeInstallPrompt();
        };

        prompt.querySelector('.pwa-dismiss-btn').onclick = () => {
            this._installDismissed = true;
            sessionStorage.setItem('pwa-install-dismissed', '1');
            this._removeInstallPrompt();
        };
    },

    _removeInstallPrompt() {
        const el = document.querySelector('.pwa-install-prompt');
        if (el) {
            el.style.animation = 'slideUp .3s ease-in reverse forwards';
            setTimeout(() => el.remove(), 300);
        }
    },

    // ── 网络状态指示器 ──

    _listenNetworkStatus() {
        const update = () => this._updateNetworkIndicator(!navigator.onLine);
        window.addEventListener('online', () => update());
        window.addEventListener('offline', () => update());
    },

    _updateNetworkIndicator(isOffline) {
        let indicator = document.querySelector('.pwa-network-indicator');

        if (!isOffline) {
            if (indicator) {
                indicator.style.animation = 'pwaFadeOut .3s ease-in forwards';
                setTimeout(() => indicator.remove(), 300);
            }
            return;
        }

        if (indicator) return;

        if (!document.getElementById('pwa-anim-styles')) {
            const style = document.createElement('style');
            style.id = 'pwa-anim-styles';
            style.textContent = `
                @keyframes pwaSlideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes pwaFadeOut { from { opacity: 1; } to { opacity: 0; } }
            `;
            document.head.appendChild(style);
        }

        indicator = document.createElement('div');
        indicator.className = 'pwa-network-indicator';
        indicator.style.cssText = `
            position: fixed; bottom: 24px; left: 24px;
            background: #FEF2F2; color: #DC2626;
            padding: 8px 16px; border-radius: 8px;
            font-size: 13px; font-weight: 500;
            display: flex; align-items: center; gap: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,.1);
            border: 1px solid #FECACA;
            z-index: 9998;
            animation: pwaSlideIn .3s ease-out;
            font-family: system-ui, -apple-system, sans-serif;
        `;
        indicator.innerHTML = '<i class="fas fa-wifi-slash" style="font-size:14px;"></i> 离线模式';
        document.body.appendChild(indicator);
    }
};

pwa.init();
