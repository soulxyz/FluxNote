/**
 * SPA 页面加载器 - 实现真实进度追踪的无刷新页面切换
 */

class SPALoader {
    constructor() {
        this.progressBar = null;
        this.isLoading = false;
        this.cache = new Map();
        this.cacheEnabled = true;
        this.cacheTTL = 30000; // 缓存30秒
        this.trickleInterval = null;
        this.currentProgress = 0;

        // Default selectors (Fallback for legacy themes)
        this.selectors = {
            content: ['.main-stream', '.blog-main', '.next-main'],
            nav: ['.sidebar-nav .nav-item', '.blog-nav .blog-nav-item', '.next-nav .next-nav-item'],
            activeClass: 'active'
        };

        this.init();
    }

    /**
     * Configure selectors for the current theme
     * @param {Object} options
     * @param {string} options.contentSelector - Selector for the main content container
     * @param {string} options.navSelector - Selector for navigation items
     * @param {string} options.activeClass - CSS class for active nav items
     */
    setConfig(options = {}) {
        if (options.contentSelector) {
            this.selectors.content = [options.contentSelector];
        }
        if (options.navSelector) {
            this.selectors.nav = [options.navSelector];
        }
        if (options.activeClass) {
            this.selectors.activeClass = options.activeClass;
        }
    }

    init() {
        this.progressBar = document.querySelector('.nprogress-bar');
        this.bindEvents();
        this.initProgressBar();
    }

    initProgressBar() {
        if (!this.progressBar) return;
        this.progressBar.style.transition = 'none';
        this.progressBar.style.width = '0%';
        this.progressBar.style.opacity = '0';
        this.currentProgress = 0;
    }

    showProgress() {
        if (!this.progressBar) return;
        this.currentProgress = 0;
        this.progressBar.style.transition = 'none';
        this.progressBar.style.width = '0%';
        this.progressBar.style.opacity = '1';
        
        // Force reflow
        this.progressBar.offsetHeight;
        
        this.startTrickle();
    }

    startTrickle() {
        if (this.trickleInterval) clearInterval(this.trickleInterval);
        this.progressBar.style.transition = 'width 0.3s ease-out';
        
        // Initial jump
        this.updateProgress(10);

        this.trickleInterval = setInterval(() => {
            if (this.currentProgress >= 90) {
                // Slow down significantly near the end
                return;
            }
            
            // Add random increment, decaying as it gets higher
            const remaining = 100 - this.currentProgress;
            const inc = remaining * (Math.random() * 0.05 + 0.02); // 2-7% of remaining
            this.updateProgress(this.currentProgress + inc);
        }, 200);
    }

    stopTrickle() {
        if (this.trickleInterval) {
            clearInterval(this.trickleInterval);
            this.trickleInterval = null;
        }
    }

    updateProgress(percent) {
        if (!this.progressBar) return;
        percent = Math.min(percent, 100);
        this.currentProgress = percent;
        this.progressBar.style.width = `${percent}%`;
    }

    hideProgress() {
        this.stopTrickle();
        if (!this.progressBar) return;

        this.updateProgress(100);

        setTimeout(() => {
            this.progressBar.style.transition = 'opacity 0.3s ease-out';
            this.progressBar.style.opacity = '0';
            setTimeout(() => {
                this.initProgressBar();
            }, 300);
        }, 200);
    }

    bindEvents() {
        // 拦截所有内部链接点击
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');

            if (!link) return;

            const href = link.getAttribute('href');
            const target = link.getAttribute('target');

            // 跳过外部链接、锚点、新窗口、特殊协议、带有 data-spa-ignore 的链接
            if (!href ||
                href.startsWith('#') ||
                href.startsWith('javascript:') ||
                href.startsWith('mailto:') ||
                href.startsWith('tel:') ||
                target === '_blank' ||
                link.hasAttribute('data-spa-ignore') ||
                e.ctrlKey ||
                e.metaKey ||
                e.shiftKey) {
                return;
            }

            // 检查是否为内部链接
            if (this.isInternalLink(href)) {
                e.preventDefault();
                this.navigate(href);
            }
        });

        // 处理浏览器前进/后退
        window.addEventListener('popstate', (e) => {
            if (e.state && e.state.url) {
                this.loadPage(e.state.url, false);
            }
        });

        // 初始状态
        history.replaceState({ url: window.location.href }, '', window.location.href);
    }

    isInternalLink(href) {
        // 相对路径或同域名链接
        if (href.startsWith('/')) return true;
        if (href.startsWith(window.location.origin)) return true;
        return false;
    }

    navigate(url) {
        if (this.isLoading) return;

        // 检查缓存
        const cached = this.getFromCache(url);
        if (cached) {
            this.applyContent(cached, url, true);
            return;
        }

        this.loadPage(url, true);
    }

    async loadPage(url, pushState = true) {
        if (this.isLoading) return;
        this.isLoading = true;

        this.showProgress();

        try {
            const response = await fetch(url, {
                headers: {
                    'X-Requested-With': 'SPA-Loader',
                    'Accept': 'text/html'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            // 读取响应体并追踪进度
            const reader = response.body.getReader();
            const contentLength = +response.headers.get('Content-Length');
            let receivedLength = 0;
            let chunks = [];

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                chunks.push(value);
                receivedLength += value.length;

                // 仅当有 Content-Length 时使用精确进度，否则依赖 trickle
                if (contentLength > 0) {
                    const progress = (receivedLength / contentLength) * 90;
                    this.updateProgress(progress);
                }
            }

            this.updateProgress(95);

            // 合并数据
            const bytes = new Uint8Array(receivedLength);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }

            const html = new TextDecoder('utf-8').decode(bytes);

            // 缓存结果
            this.setCache(url, html);

            // 应用内容
            this.applyContent(html, url, pushState);

        } catch (error) {
            console.error('SPA Loader error:', error);
            // 出错时降级为普通跳转
            window.location.href = url;
        } finally {
            this.isLoading = false;
            this.hideProgress();
        }
    }

    applyContent(html, url, pushState) {
        this.updateProgress(98);

        // 解析新页面
        const parser = new DOMParser();
        const newDoc = parser.parseFromString(html, 'text/html');

        // 提取主要内容区域 (Support dynamic theme containers)
        let selector = null;
        let newMain = null;

        for (const s of this.selectors.content) {
            newMain = newDoc.querySelector(s);
            if (newMain) {
                selector = s;
                break;
            }
        }

        const newTitle = newDoc.querySelector('title')?.textContent || '';

        if (!newMain || !selector) {
            // 如果找不到主内容区，降级为普通跳转
            window.location.href = url;
            return;
        }

        // 更新页面标题
        document.title = newTitle;

        // 替换主内容
        const currentMain = document.querySelector(selector);
        if (currentMain) {
            currentMain.innerHTML = newMain.innerHTML;
        }

        // 更新侧边栏激活状态
        this.updateSidebarActive(url, newDoc);

        // 更新 URL
        if (pushState) {
            history.pushState({ url }, '', url);
        }

        // 滚动到顶部
        window.scrollTo(0, 0);
        if (currentMain) currentMain.scrollTo(0, 0);

        // 执行页面内联脚本
        this.executeScripts(newMain);

        // 触发自定义事件 (Delay slightly to allow module scripts to init)
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('spa-loaded', {
                detail: { url, title: newTitle }
            }));
        }, 10);

        this.updateProgress(100);
    }

    updateSidebarActive(url, newDoc) {
        const activeClass = this.selectors.activeClass;
        // Support dynamic navigation structures
        for (const selector of this.selectors.nav) {
            const currentNav = document.querySelectorAll(selector);
            if (currentNav.length > 0) {
                currentNav.forEach(item => item.classList.remove(activeClass));
                
                // Find active in new doc
                const newActive = newDoc.querySelector(`${selector}.${activeClass}`);
                if (newActive) {
                    const href = newActive.getAttribute('href');
                    const match = document.querySelector(`${selector}[href="${href}"]`);
                    if (match) match.classList.add(activeClass);
                }
                return; // Found the matching nav structure
            }
        }
    }

    executeScripts(container) {
        // 执行内联脚本
        const scripts = container.querySelectorAll('script:not([src])');
        scripts.forEach(script => {
            try {
                const newScript = document.createElement('script');
                newScript.textContent = script.textContent;
                if (script.type) newScript.type = script.type;
                document.body.appendChild(newScript);
                document.body.removeChild(newScript);
            } catch (e) {
                console.error('Script execution error:', e);
            }
        });
    }

    // 缓存管理
    getFromCache(url) {
        if (!this.cacheEnabled) return null;

        const cached = this.cache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.html;
        }

        this.cache.delete(url);
        return null;
    }

    setCache(url, html) {
        if (!this.cacheEnabled) return;

        this.cache.set(url, {
            html,
            timestamp: Date.now()
        });

        // 清理过期缓存
        if (this.cache.size > 20) {
            const now = Date.now();
            for (const [key, value] of this.cache) {
                if (now - value.timestamp > this.cacheTTL) {
                    this.cache.delete(key);
                }
            }
        }
    }

    clearCache() {
        this.cache.clear();
    }
}

// 导出单例
export const spaLoader = new SPALoader();
export default spaLoader;
