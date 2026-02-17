/**
 * ============================================================================
 * FLUXNOTE - THEME SDK (核心理念)
 * ============================================================================
 * 
 * 设计哲学：配置优于实现，能力重于长相
 * 
 * 1. 行为与展现分离：
 *    - SDK 负责“行为逻辑”（如：路由拦截、认证调用、Markdown 增强、事件监听）。
 *    - 主题负责“展现结构”（如：HTML 布局、CSS 样式、交互组件的外观）。
 * 
 * 2. 严禁侵入 UI 渲染：
 *    - SDK 不应包含任何具体的 HTML 字符串拼装（如 renderNotes）。
 *    - 笔记列表、卡片样式、空状态等 HTML 必须由主题模板完全控制。
 *    - 这样确保了以后添加结构完全不同的主题时，不需要修改 SDK 源码。
 * 
 * 3. 声明式交互：
 *    - 优先通过 data-* 属性实现功能，减少主题中重复的 JS 绑定代码。
 * 
 * ============================================================================
 */

import spaLoader from '/static/js/spa-loader.js';
import auth from '/static/js/auth-module.js';
import { initMarkdownRenderer, initThemePlugins } from '/static/js/markdown-renderer.js';

class ThemeSDK {
    constructor() {
        this.options = {
            contentSelector: '.blog-main', // 默认容器选择器
            navSelector: null,             // 默认导航选择器
            activeClass: 'active',         // 导航激活类名
            autoResetSelectors: [],        // 页面切换时需要重置状态的选择器 (如移动端菜单)
            resetClasses: ['open', 'active', 'sidebar-open', 'mobile-open', 'next-sidebar-open'], // 默认重置的类名
            auth: true,                    // 是否启用认证
            spa: true,                     // 是否启用 SPA
            plugins: {                     // 插件配置
                mermaid: { theme: 'default' },
                highlight: {}
            }
        };
    }

    /**
     * 初始化主题核心能力
     */
    init(options = {}) {
        this.options = { ...this.options, ...options };

        // 1. 初始化渲染配置
        initMarkdownRenderer(this.options.plugins);

        // 2. 配置 SPA 加载器 (仅传递有效配置)
        if (this.options.spa) {
            const spaConfig = { activeClass: this.options.activeClass };
            
            // 健壮性检查：过滤来自模板的空字符串或 'null' 占位符
            if (this.options.contentSelector && this.options.contentSelector !== 'null' && this.options.contentSelector !== '') {
                spaConfig.contentSelector = this.options.contentSelector;
            }
            if (this.options.navSelector && this.options.navSelector !== 'null' && this.options.navSelector !== '') {
                spaConfig.navSelector = this.options.navSelector;
            }

            spaLoader.setConfig(spaConfig);
            window.addEventListener('spa-loaded', this.handlePageLoad.bind(this));
        }

        // 3. 初始化认证
        if (this.options.auth) {
            auth.init({ onSuccess: () => window.location.reload() });
        }

        // 4. 处理首屏加载
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.handlePageLoad());
        } else {
            this.handlePageLoad();
        }
        
        // 5. 绑定声明式事件
        this.bindDeclarativeEvents();

        // 6. 自动检测 URL 参数触发登录 (如: ?show_login=1)
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('show_login')) {
            // 延迟一小会儿确保 DOM 稳定
            setTimeout(() => this.smartLogin(), 100);
        }
    }

    /**
     * 处理页面加载/切换 (SPA 或首屏)
     */
    async handlePageLoad() {
        const container = document.querySelector(this.options.contentSelector);
        if (container) {
            // 确保第三方库加载后再执行插件初始化
            // 某些情况下 Mermaid 加载稍慢，这里做一个极简的等待
            if (typeof mermaid === 'undefined' || typeof hljs === 'undefined') {
                setTimeout(() => this.handlePageLoad(), 100);
                return;
            }
            await initThemePlugins(container);
        }

        // 自动重置指定选择器的状态
        if (this.options.autoResetSelectors && this.options.autoResetSelectors.length > 0) {
            this.options.autoResetSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    this.options.resetClasses.forEach(cls => el.classList.remove(cls));
                });
            });
        }

        // 初始化/更新浮动展开按钮
        this.initFloatingMenuBtn();

        // 通知外部页面已准备就绪
        window.dispatchEvent(new CustomEvent('page-ready'));
        window.dispatchEvent(new CustomEvent('theme-ready'));
    }

    /**
     * 【公共能力】绑定搜索框逻辑
     * @param {string} selector 搜索框的选择器
     * @param {string} baseUrl 跳转的基础路径
     */
    bindSearch(selector = '#searchInput', baseUrl = '/') {
        // 健壮性检查：如果页面上没有搜索框，不执行绑定
        if (!document.querySelector(selector)) return;

        document.addEventListener('keypress', (e) => {
            const input = e.target.closest(selector);
            if (input && e.key === 'Enter') {
                const query = input.value.trim();
                const url = baseUrl + (query ? `?search=${encodeURIComponent(query)}` : '');
                this.navigate(url);
            }
        });
    }

    /**
     * 【公共能力】绑定标签点击逻辑
     * @param {string} selector 标签的选择器 (需带 data-tag 属性)
     * @param {string} baseUrl 跳转的基础路径 (默认 /tags/)
     */
    bindTagClicks(selector = '.note-tag[data-tag]', baseUrl = '/tags/') {
        // 健壮性检查
        if (!document.querySelector(selector)) return;

        document.addEventListener('click', (e) => {
            const tagEl = e.target.closest(selector);
            if (tagEl) {
                e.preventDefault();
                e.stopPropagation();
                const tagName = tagEl.dataset.tag;
                this.navigate(baseUrl + encodeURIComponent(tagName));
            }
        });
    }

    /**
     * 【公共能力】跳转页面 (优先使用 SPA)
     */
    navigate(url) {
        if (this.options.spa && spaLoader) {
            spaLoader.navigate(url);
        } else {
            window.location.href = url;
        }
    }

    /**
     * 【公共能力】智能登录 (代理至 auth 模块)
     */
    smartLogin() {
        auth.smartLogin();
    }

    /**
     * 【公共能力】注销登录 (代理至 auth 模块)
     */
    logout() {
        auth.logout();
    }

    /**
     * 绑定声明式事件
     */
    bindDeclarativeEvents() {
        document.addEventListener('click', (e) => {
            // 认证行为: data-auth-action="login|logout"
            const authBtn = e.target.closest('[data-auth-action]');
            if (authBtn) {
                e.preventDefault();
                const action = authBtn.dataset.authAction;
                if (action === 'login') auth.smartLogin();
                if (action === 'logout') auth.logout();
            }

            // 类切换行为: data-toggle-class="open" data-target="#menu"
            const toggleBtn = e.target.closest('[data-toggle-menu]');
            if (toggleBtn) {
                e.preventDefault();
                const targetSelector = toggleBtn.dataset.target;
                const toggleClass = toggleBtn.dataset.class || 'open';
                const target = targetSelector === 'body' ? document.body : document.querySelector(targetSelector);
                target?.classList.toggle(toggleClass);

                // 侧边栏收起/展开时，更新浮动按钮状态
                this.updateFloatingMenuBtn();
            }
        });

        // 监听 SPA 页面切换，重置浮动按钮状态
        window.addEventListener('spa-loaded', () => this.updateFloatingMenuBtn());
    }

    /**
     * 初始化浮动展开按钮（在 DOM 准备好后调用）
     */
    initFloatingMenuBtn() {
        // 创建浮动展开按钮（用于侧边栏收起后展开）
        this.createFloatingMenuBtn();
    }

    /**
     * 创建浮动展开按钮（侧边栏收起后显示）
     */
    createFloatingMenuBtn() {
        // 只有存在侧边栏的页面才创建
        const sidebar = document.querySelector('#sidebar');
        if (!sidebar) return;

        // 检查是否已存在
        if (document.querySelector('.floating-menu-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'floating-menu-btn';
        btn.innerHTML = '<i class="fas fa-bars"></i>';
        btn.style.display = 'none';

        btn.addEventListener('click', () => {
            if (sidebar) {
                sidebar.classList.remove('collapsed');
                this.updateFloatingMenuBtn();
            }
        });

        document.body.appendChild(btn);

        // 初始化状态
        this.updateFloatingMenuBtn();
    }

    /**
     * 更新浮动展开按钮的显示状态
     */
    updateFloatingMenuBtn() {
        const floatBtn = document.querySelector('.floating-menu-btn');
        const sidebar = document.querySelector('#sidebar');

        if (floatBtn && sidebar) {
            floatBtn.style.display = sidebar.classList.contains('collapsed') ? 'flex' : 'none';
        }
    }
}

export const themeSDK = new ThemeSDK();
export default themeSDK;
