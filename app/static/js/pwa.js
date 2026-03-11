import { showToast } from './modules/utils.js';

export const pwa = {
    _deferredPrompt: null,
    _installDismissed: false,
    _installPromptEnabled: true,  // 缓存设置，避免重复请求

    // 隐私模式或存储被禁用时的安全存储访问辅助
    _safeStorage: {
        get(storage, key, fallback = null) {
            try { return storage.getItem(key); } catch { return fallback; }
        },
        set(storage, key, value) {
            try { storage.setItem(key, value); } catch { /* ignore */ }
        },
        remove(storage, key) {
            try { storage.removeItem(key); } catch { /* ignore */ }
        },
    },
    _swInstallStatus: {
        active: false,
        lastAsset: '',
        completed: 0,
        total: 0,
        watchdogId: null
    },
    _activationWatchdogId: null,

    async init() {
        this._registerServiceWorker();
        this._listenServiceWorkerMessages();
        // 立即注册监听，确保不错过 beforeinstallprompt 事件
        this._listenInstallPrompt();
        this._listenNetworkStatus();
        // 异步读取设置，完成后再决定是否显示弹窗
        this._installPromptEnabled = await this._fetchInstallPromptSetting();
    },

    // ── Service Worker 注册与更新 ──

    _registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;

        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            this._clearInstallWatchdog();
            this._clearActivationWatchdog();
            sessionStorage.removeItem('pwa-updating');
            window.location.reload();
        });

        const onInstalledWorkerFound = (worker) => {
            if (!navigator.serviceWorker.controller) return;

            const updatingTs = parseInt(sessionStorage.getItem('pwa-updating') || '0');
            if (Date.now() - updatingTs < 10000) {
                sessionStorage.removeItem('pwa-updating');
                worker.postMessage('skipWaiting');
                return;
            }

            this._showUpdateToast(worker);
        };

        const bindUpdateWatcher = (registration) => {
            if (registration._watched) return;
            registration._watched = true;
            registration.addEventListener('updatefound', () => {
                const worker = registration.installing;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed') onInstalledWorkerFound(worker);
                });
            });
        };

        if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.getRegistration().then(reg => {
                if (!reg) return;
                if (reg.waiting) onInstalledWorkerFound(reg.waiting);
                bindUpdateWatcher(reg);
            });
        }

        const registerSW = () => {
            navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
                .then(registration => {
                    console.log('[PWA] Service Worker registered:', registration.scope);
                    if (registration.waiting) onInstalledWorkerFound(registration.waiting);
                    bindUpdateWatcher(registration);
                })
                .catch(error => {
                    console.error('[PWA] Registration failed:', error);
                });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', registerSW);
        } else {
            registerSW();
        }
    },

    _listenServiceWorkerMessages() {
        if (!('serviceWorker' in navigator)) return;

        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data.type !== 'sw-update-status') return;
            this._handleServiceWorkerStatus(data);
        });
    },

    _handleServiceWorkerStatus(data) {
        if (data.asset) {
            this._swInstallStatus.lastAsset = data.asset;
        }

        if (data.status === 'start') {
            this._swInstallStatus.active = true;
            this._swInstallStatus.completed = 0;
            this._swInstallStatus.total = data.total || 0;
            this._scheduleInstallWatchdog();
            return;
        }

        if (data.status === 'progress') {
            this._swInstallStatus.active = true;
            this._swInstallStatus.completed = data.completed || 0;
            this._swInstallStatus.total = data.total || 0;
            this._scheduleInstallWatchdog();

            const hasUpdateToast = document.querySelector('.pwa-update-toast');
            if (hasUpdateToast) {
                const progressText = this._swInstallStatus.total
                    ? `正在下载更新资源 (${this._swInstallStatus.completed}/${this._swInstallStatus.total})`
                    : '正在准备更新资源...';
                this._updateUpdateToastText({
                    title: '正在后台更新',
                    message: progressText,
                    detail: `当前处理：${this._swInstallStatus.lastAsset || '未知文件'}`
                });
            }
            return;
        }

        if (data.status === 'ready') {
            this._swInstallStatus.active = false;
            this._swInstallStatus.completed = data.completed || this._swInstallStatus.completed;
            this._swInstallStatus.total = data.total || this._swInstallStatus.total;
            this._clearInstallWatchdog();
            return;
        }

        if (data.status === 'error') {
            this._swInstallStatus.active = false;
            this._clearInstallWatchdog();
            sessionStorage.removeItem('pwa-updating');
            this._showUpdateIssueToast({
                title: '更新下载失败',
                message: '由于网络原因，新版本未能完全下载。当前页面仍可正常使用。',
                detail: `失败文件：${data.asset || '未知文件'}\n错误信息：${data.error || '未知错误'}`,
                primaryLabel: '刷新重试',
                secondaryLabel: '关闭',
                primaryHandler: () => window.location.reload(),
                secondaryHandler: () => this._removeUpdateToast(),
                tone: 'error'
            });
        }
    },

    _scheduleInstallWatchdog() {
        this._clearInstallWatchdog();
        this._swInstallStatus.watchdogId = setTimeout(() => {
            if (!this._swInstallStatus.active) return;

            this._showUpdateIssueToast({
                title: '更新下载缓慢',
                message: '网络似乎有些拥堵，您可以继续正常使用，或尝试刷新页面。',
                detail: this._swInstallStatus.lastAsset
                    ? `当前卡在：${this._swInstallStatus.lastAsset}`
                    : '当前未定位到具体文件',
                primaryLabel: '刷新页面',
                secondaryLabel: '继续等待',
                primaryHandler: () => window.location.reload(),
                secondaryHandler: () => this._removeUpdateToast(),
                tone: 'warning'
            });
        }, 8000);
    },

    _clearInstallWatchdog() {
        if (this._swInstallStatus.watchdogId) {
            clearTimeout(this._swInstallStatus.watchdogId);
            this._swInstallStatus.watchdogId = null;
        }
    },

    _startActivationWatchdog() {
        this._clearActivationWatchdog();
        this._activationWatchdogId = setTimeout(() => {
            this._showUpdateIssueToast({
                title: '更新即将完成',
                message: '新版本已就绪，但页面切换似乎遇到了阻碍。建议您手动刷新页面。',
                detail: this._swInstallStatus.lastAsset
                    ? `最后处理：${this._swInstallStatus.lastAsset}`
                    : '无具体文件记录，可能卡在激活阶段。',
                primaryLabel: '手动刷新',
                secondaryLabel: '关闭',
                primaryHandler: () => window.location.reload(),
                secondaryHandler: () => this._removeUpdateToast(),
                tone: 'warning'
            });
        }, 8000);
    },

    _clearActivationWatchdog() {
        if (this._activationWatchdogId) {
            clearTimeout(this._activationWatchdogId);
            this._activationWatchdogId = null;
        }
    },

    _ensureUpdateToast() {
        let toast = document.querySelector('.pwa-update-toast');
        if (toast) return toast;

        if (!document.getElementById('pwa-anim-styles')) {
            const style = document.createElement('style');
            style.id = 'pwa-anim-styles';
            style.textContent = `
                @keyframes pwaSlideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes pwaFadeOut { from { opacity: 1; } to { opacity: 0; } }
            `;
            document.head.appendChild(style);
        }

        toast = document.createElement('div');
        toast.className = 'pwa-update-toast';
        toast.style.cssText = `
            position: fixed; bottom: 24px; right: 24px;
            background: white; color: #1e293b; padding: 16px;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1);
            z-index: 9999; display: flex; flex-direction: column; gap: 12px;
            border: 1px solid #e2e8f0; max-width: 360px;
            animation: pwaSlideIn .3s ease-out;
            font-family: system-ui, -apple-system, sans-serif;
        `;
        toast.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:12px;">
                <i id="pwaUpdateIcon" class="fas fa-sparkles" style="color:#10B981;font-size:1.2em;margin-top:2px;"></i>
                <div style="flex:1;">
                    <h4 id="pwaUpdateTitle" style="margin:0;font-size:14px;font-weight:600;">发现新版本</h4>
                    <p id="pwaUpdateMessage" style="margin:4px 0 0;font-size:12px;color:#64748b;line-height:1.5;">已在后台准备好更新，刷新页面即可体验新功能。</p>
                    <details id="pwaUpdateDevBox" style="margin-top:8px;font-size:11px;color:#94a3b8;cursor:pointer;display:none;">
                        <summary style="outline:none;user-select:none;">开发信息</summary>
                        <div id="pwaUpdateDetail" style="margin-top:4px;white-space:pre-wrap;word-break:break-all;background:#f8fafc;padding:6px;border-radius:4px;border:1px solid #e2e8f0;"></div>
                    </details>
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="pwaLaterBtn" style="padding:6px 12px;font-size:12px;border:1px solid #e2e8f0;background:white;color:#64748b;border-radius:6px;cursor:pointer;transition:all .2s;">稍后</button>
                <button id="pwaRefreshBtn" style="padding:6px 12px;font-size:12px;border:none;background:#10B981;color:white;border-radius:6px;cursor:pointer;font-weight:500;transition:all .2s;">立即刷新</button>
            </div>
        `;
        document.body.appendChild(toast);
        return toast;
    },

    _updateUpdateToastText({ title, message, detail, tone = 'default' } = {}) {
        const toast = this._ensureUpdateToast();
        const icon = document.getElementById('pwaUpdateIcon');
        const titleEl = document.getElementById('pwaUpdateTitle');
        const messageEl = document.getElementById('pwaUpdateMessage');
        const detailEl = document.getElementById('pwaUpdateDetail');

        if (title !== undefined && titleEl) titleEl.textContent = title;
        if (message !== undefined && messageEl) messageEl.textContent = message;
        if (detail !== undefined && detailEl) {
            detailEl.textContent = detail;
            const devBox = document.getElementById('pwaUpdateDevBox');
            if (devBox) devBox.style.display = detail ? 'block' : 'none';
        }

        if (toast) {
            if (tone === 'error') {
                toast.style.borderColor = '#fecaca';
                toast.style.background = '#fff7f7';
                if (icon) {
                    icon.className = 'fas fa-triangle-exclamation';
                    icon.style.color = '#dc2626';
                }
            } else if (tone === 'warning') {
                toast.style.borderColor = '#fde68a';
                toast.style.background = '#fffbeb';
                if (icon) {
                    icon.className = 'fas fa-clock';
                    icon.style.color = '#d97706';
                }
            } else {
                toast.style.borderColor = '#e2e8f0';
                toast.style.background = 'white';
                if (icon) {
                    icon.className = 'fas fa-sparkles';
                    icon.style.color = '#10B981';
                }
            }
        }
    },

    _showUpdateIssueToast({ title, message, detail, primaryLabel, secondaryLabel, primaryHandler, secondaryHandler, tone }) {
        this._updateUpdateToastText({ title, message, detail, tone });

        const primaryBtn = document.getElementById('pwaRefreshBtn');
        const secondaryBtn = document.getElementById('pwaLaterBtn');

        if (primaryBtn) {
            primaryBtn.disabled = false;
            primaryBtn.textContent = primaryLabel || '确定';
            primaryBtn.onclick = primaryHandler || null;
            primaryBtn.style.background = tone === 'error' ? '#DC2626' : '#10B981';
        }

        if (secondaryBtn) {
            secondaryBtn.textContent = secondaryLabel || '关闭';
            secondaryBtn.onclick = secondaryHandler || (() => this._removeUpdateToast());
            secondaryBtn.style.display = 'inline-block';
        }
    },

    _removeUpdateToast() {
        const toast = document.querySelector('.pwa-update-toast');
        if (!toast) return;

        this._clearActivationWatchdog();
        toast.style.animation = 'pwaFadeOut .3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    },

    _showUpdateToast(worker) {
        this._updateUpdateToastText({
            title: '发现新版本',
            message: '已在后台准备好更新，刷新页面即可体验新功能。',
            detail: this._swInstallStatus.lastAsset
                ? `版本就绪，最后处理：${this._swInstallStatus.lastAsset}`
                : ''
        });

        document.getElementById('pwaRefreshBtn').onclick = () => {
            sessionStorage.setItem('pwa-updating', Date.now().toString());
            worker.postMessage('skipWaiting');
            this._updateUpdateToastText({
                title: '正在加载新版本',
                message: '正在切换到最新版本，请稍候...',
                detail: this._swInstallStatus.lastAsset
                    ? `触发跳过等待，最后处理：${this._swInstallStatus.lastAsset}`
                    : ''
            });
            document.getElementById('pwaRefreshBtn').disabled = true;
            document.getElementById('pwaRefreshBtn').textContent = '加载中...';
            this._startActivationWatchdog();
        };
        document.getElementById('pwaLaterBtn').onclick = () => {
            this._removeUpdateToast();
        };
    },

    // ── PWA 安装提示 ──

    _listenInstallPrompt() {
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this._deferredPrompt = e;

            if (this._installDismissed) return;
            if (!this._shouldShowInstallPrompt()) return;

            setTimeout(() => this._showInstallPrompt(), 5000);
        });

        window.addEventListener('appinstalled', () => {
            this._deferredPrompt = null;
            this._installPromptEnabled = false;
            this._removeInstallPrompt();
            localStorage.setItem('pwa-app-installed', 'true');
            // 清除不再需要的提示状态
            localStorage.removeItem('pwa-install-dismiss-time');
            localStorage.removeItem('pwa-visit-count');
            sessionStorage.removeItem('pwa-install-session-dismissed');
            showToast('应用安装成功！现在可以从桌面快速访问了');
        });
    },

    _shouldShowInstallPrompt() {
        try {
            // 已安装（standalone模式）— beforeinstallprompt本身不会触发，双重保险
            if (localStorage.getItem('pwa-app-installed') === 'true') return false;

            // 设置开关已关闭
            if (!this._installPromptEnabled) {
                console.log('[PWA] Install prompt disabled in settings');
                return false;
            }

            // 7天冷却期
            const dismissTime = parseInt(localStorage.getItem('pwa-install-dismiss-time') || '0');
            if (dismissTime && (Date.now() - dismissTime < 7 * 24 * 60 * 60 * 1000)) return false;

            // 会话内已拒绝
            if (sessionStorage.getItem('pwa-install-session-dismissed')) return false;

            // 至少访问3次才显示
            let visitCount = parseInt(localStorage.getItem('pwa-visit-count') || '0');
            visitCount++;
            localStorage.setItem('pwa-visit-count', visitCount.toString());
            if (visitCount < 3) return false;

            return true;
        } catch (e) {
            console.warn('[PWA] localStorage unavailable, skipping install prompt');
            return false;
        }
    },

    async _fetchInstallPromptSetting() {
        try {
            const response = await fetch('/api/settings/get-by-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys: ['pwa_install_prompt'] })
            });
            if (response.ok) {
                const data = await response.json();
                return data.data?.pwa_install_prompt?.toLowerCase() !== 'false';
            }
        } catch (e) {
            console.warn('[PWA] Error fetching install prompt setting:', e);
        }
        return true;
    },

    _showInstallPrompt() {
        // 二次检查：_installPromptEnabled 可能在 setTimeout 期间被设置更新
        if (!this._installPromptEnabled) return;
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
                <button class="btn pwa-never-btn" title="不再提醒">×</button>
                <button class="btn pwa-dismiss-btn">稍后</button>
                <button class="btn pwa-accept-btn">安装</button>
            </div>
        `;
        document.body.appendChild(prompt);

        // 安装按钮
        prompt.querySelector('.pwa-accept-btn').onclick = async () => {
            if (!this._deferredPrompt) return;
            try {
                this._deferredPrompt.prompt();
                const { outcome } = await this._deferredPrompt.userChoice;
                console.log('[PWA] Install prompt result:', outcome);
            } catch (e) {
                console.warn('[PWA] Install prompt failed:', e);
            }
            this._deferredPrompt = null;
            this._removeInstallPrompt();
        };

        // 稍后按钮（本次会话内不再显示）
        prompt.querySelector('.pwa-dismiss-btn').onclick = () => {
            this._installDismissed = true;
            this._safeStorage.set(sessionStorage, 'pwa-install-session-dismissed', '1');
            this._removeInstallPrompt();
        };

        // 不再提醒按钮（设置7天冷却期）
        prompt.querySelector('.pwa-never-btn').onclick = () => {
            this._installDismissed = true;
            this._safeStorage.set(localStorage, 'pwa-install-dismiss-time', Date.now().toString());
            this._safeStorage.set(sessionStorage, 'pwa-install-session-dismissed', '1');
            this._removeInstallPrompt();
            showToast('7天内不再提醒');
        };
    },

    _removeInstallPrompt() {
        const el = document.querySelector('.pwa-install-prompt');
        if (el) {
            el.style.animation = 'slideUp .3s ease-in reverse forwards';
            setTimeout(() => el.remove(), 300);
        }
    },

    // 公开方法：手动触发安装提示
    showInstallDialog() {
        if (!this._deferredPrompt) {
            showToast('当前浏览器不支持应用安装，或应用已经安装');
            return false;
        }
        
        // 清除会话拒绝标记，允许手动显示
        this._safeStorage.remove(sessionStorage, 'pwa-install-session-dismissed');
        this._installDismissed = false;
        this._showInstallPrompt();
        return true;
    },

    // 公开方法：重置安装提示设置
    resetInstallPromptSettings() {
        this._safeStorage.remove(localStorage, 'pwa-install-dismiss-time');
        this._safeStorage.remove(localStorage, 'pwa-visit-count');
        this._safeStorage.remove(sessionStorage, 'pwa-install-session-dismissed');
        this._installDismissed = false;
        showToast('安装提示设置已重置');
    },

    // 当设置页切换开关时同步内存状态
    onSettingChanged(settingKey, value) {
        if (settingKey === 'pwa_install_prompt') {
            this._installPromptEnabled = value;
            if (!value) this._removeInstallPrompt();
        }
    },

    getInstallStatus() {
        return {
            isInstalled: this._safeStorage.get(localStorage, 'pwa-app-installed') === 'true',
            promptEnabled: this._installPromptEnabled,
            hasDeferred: !!this._deferredPrompt,
            dismissed: this._installDismissed
        };
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

window.PWA = {
    showInstallDialog:  () => pwa.showInstallDialog(),
    resetSettings:      () => pwa.resetInstallPromptSettings(),
    onSettingChanged:   (key, value) => pwa.onSettingChanged(key, value),
    getInstallStatus:   () => pwa.getInstallStatus(),
};
