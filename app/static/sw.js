/**
 * 流光笔记 Service Worker
 * 为流光笔记提供离线支持、加载加速和稳定的更新机制
 */

// 这些变量将被 Flask 路由动态替换
const CACHE_VERSION = 'DEV'; 
const IS_DEBUG = false;

const STATIC_CACHE = `fluxnote-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `fluxnote-dynamic-${CACHE_VERSION}`;

// 1. 需要预缓存的静态资源 (核心 UI 框架)
const PRECACHE_ASSETS = [
    '/static/css/style.css',
    '/static/js/main.js',
    '/static/js/markdown-renderer.js',
    '/manifest.json',
    '/static/img/icons/icon.svg',
    '/static/offline.html'
];

// 2. JS 模块 (核心业务逻辑)
const JS_MODULES = [
    '/static/js/modules/api.js',
    '/static/js/modules/state.js',
    '/static/js/modules/ui.js',
    '/static/js/modules/auth.js',
    '/static/js/modules/editor.js',
    '/static/js/modules/utils.js',
    '/static/js/modules/events.js',
    '/static/js/modules/comment-widget.js',
    '/static/js/theme-sdk.js',
    '/static/js/pwa.js',
    '/static/js/heatmap.js'
];

// 3. 第三方库和字体 (极少变动)
const EXTERNAL_LIBS = [
    '/static/lib/fontawesome/css/all.min.css',
    '/static/lib/marked/marked.min.js',
    '/static/lib/dompurify/purify.min.js',
    '/static/lib/highlightjs/highlight.min.js',
    '/static/lib/highlightjs/github.min.css',
    '/static/lib/viewerjs/viewer.min.js',
    '/static/lib/viewerjs/viewer.min.css',
    '/static/lib/fontawesome/webfonts/fa-solid-900.woff2',
    '/static/lib/fontawesome/webfonts/fa-regular-400.woff2'
];

const ALL_PRECACHE = [...PRECACHE_ASSETS, ...JS_MODULES, ...EXTERNAL_LIBS];

// 不应被缓存的路径
const EXCLUDED_PATHS = ['/api/auth/', '/api/ai/', '/api/upload/', '/login', '/register', '/logout'];

/**
 * 是否是排除路径
 */
function isExcluded(url) {
    const pathname = new URL(url, self.location.origin).pathname;
    return EXCLUDED_PATHS.some(path => pathname.startsWith(path));
}

/**
 * 安装事件：预缓存关键资源
 */
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(STATIC_CACHE);
        // 使用 cache.addAll，如果有一个失败则全部失败，确保原子性
        await cache.addAll(ALL_PRECACHE);
        console.log(`[SW] ${CACHE_VERSION} Precache Complete`);
    })());
});

/**
 * 激活事件：清理旧缓存并接管页面
 */
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter(name => name.startsWith('fluxnote-') && !name.includes(CACHE_VERSION))
                .map(name => caches.delete(name))
        );
        // 立即接管所有客户端，触发 pwa.js 的 controllerchange
        await self.clients.claim();
        console.log(`[SW] ${CACHE_VERSION} Activated & Claimed`);
    })());
});

/**
 * 拦截请求
 */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // 仅处理 GET 请求，且非排除路径，且同域
    if (request.method !== 'GET' || !url.protocol.startsWith('http') || isExcluded(request.url)) return;

    // 1. 导航请求 (HTML) - Network-First with 3s Timeout
    if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(networkFirstWithTimeout(request, 3000, '/static/offline.html'));
        return;
    }

    // 2. API 请求 - Network-First (缓存作为回退)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request, DYNAMIC_CACHE));
        return;
    }

    // 3. 静态资源 (JS/CSS/Fonts/Images) - Cache-First or SWR
    event.respondWith(cacheFirstWithRefresh(request));
});

/**
 * 策略：Network First (网络优先)
 * 成功后存入缓存，失败回退到缓存
 */
async function networkFirst(request, cacheName) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        // 只要网络有响应，直接返回（即使是 4xx 或 5xx 或 opaqueredirect）
        return response;
    } catch (error) {
        // 只有网络断开时才回退到缓存
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            // 在 Header 中标记这是过期的缓存数据
            const headers = new Headers(cachedResponse.headers);
            headers.set('X-Cache-Status', 'stale');
            return new Response(cachedResponse.body, { status: cachedResponse.status, statusText: cachedResponse.statusText, headers });
        }
    }
    // API 最终失败响应
    return new Response(JSON.stringify({ error: '离线模式' }), { 
        status: 503, 
        headers: { 'Content-Type': 'application/json' } 
    });
}

/**
 * 策略：Network First with Timeout (带超时的网络优先)
 * 用于 HTML 导航，防止在极慢网络下转圈
 */
async function networkFirstWithTimeout(request, timeoutMs, fallbackUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        // 缓存成功的响应 (200)
        if (response.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(request, response.clone());
        }
        
        // 返回网络响应（非常重要：包含 301/302 的 opaqueredirect）
        // 否则浏览器无法正常执行重定向
        return response;
    } catch (error) {
        // 超时或断网，进入下方回退逻辑
        console.log('[SW] Navigation fetch failed, falling back to cache', error);
    }

    const cached = await caches.match(request);
    if (cached) {
        // 安全检查：如果这是一个导航请求，且缓存的响应是重定向产生的 (redirected: true)，
        // 则不能返回给浏览器，否则会报 "a redirected response was used for a request whose redirect mode is not 'follow'" 错误。
        if (request.mode === 'navigate' && cached.redirected) {
            console.warn('[SW] Cannot return redirected cache for navigate request. Falling back to offline page.');
        } else {
            return cached;
        }
    }

    // 如果没有缓存，返回离线占位页
    return caches.match(fallbackUrl) || new Response(
        '<html><body><div style="padding: 20px; font-family: sans-serif;"><h1>离线模式</h1><p>网络连接已断开，请检查网络后重试。</p></div></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

/**
 * 策略：Cache First with Versioning (带版本的缓存优先)
 */
async function cacheFirstWithRefresh(request) {
    const cached = await caches.match(request, { ignoreSearch: true });
    
    // 如果已经缓存，直接返回
    if (cached) return cached;

    // 否则网络请求并缓存
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (e) {
        return new Response('', { status: 404 });
    }
}

/**
 * 消息处理
 */
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
