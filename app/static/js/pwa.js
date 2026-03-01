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
        
        // 创建一个无侵入式的更新提示 Toast
        const updateToast = document.createElement('div');
        updateToast.className = 'pwa-update-toast';
        updateToast.innerHTML = `
            <div class="pwa-update-content">
                <i class="fas fa-magic" style="color: #f59e0b; margin-right: 8px;"></i>
                <span>发现新版本系统，点击立即体验</span>
            </div>
            <button class="pwa-update-close">&times;</button>
        `;
        
        // 基本样式内联，确保不依赖外部 CSS 的更新
        Object.assign(updateToast.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            backgroundColor: '#1e293b',
            color: 'white',
            padding: '12px 16px',
            borderRadius: '8px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            zIndex: '9999',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            transform: 'translateY(100px)',
            opacity: '0',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: '14px'
        });

        document.body.appendChild(updateToast);
        
        // 动画显示
        requestAnimationFrame(() => {
            updateToast.style.transform = 'translateY(0)';
            updateToast.style.opacity = '1';
        });

        // 点击更新内容区域
        updateToast.querySelector('.pwa-update-content').addEventListener('click', () => {
            updateToast.style.opacity = '0.5';
            worker.postMessage('skipWaiting'); // 触发 SW 激活并刷新页面
        });

        // 点击关闭按钮
        updateToast.querySelector('.pwa-update-close').addEventListener('click', (e) => {
            e.stopPropagation();
            updateToast.style.transform = 'translateY(100px)';
            updateToast.style.opacity = '0';
            setTimeout(() => updateToast.remove(), 300);
        });
    }
};

pwa.init();
