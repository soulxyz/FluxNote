/**
 * 流光笔记 Service Worker
 * 仅在登录后启用，提供离线访问能力
 */

// This will be replaced by server: const CACHE_VERSION = '1.0.8';
const CACHE_VERSION = 'DEV'; 
// This will be replaced by server: const IS_DEBUG = true/false;
const IS_DEBUG = false;

const STATIC_CACHE = `fluxnote-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `fluxnote-dynamic-${CACHE_VERSION}`;

// 需要预缓存的静态资源（关键资源）
const PRECACHE_ASSETS = [
    '/',
    '/static/css/style.css',
    '/static/js/main.js',
    '/static/js/markdown-renderer.js',
    '/static/manifest.json',
    '/static/img/icons/icon.svg',
    '/static/offline.html'
];

// JS 模块（需要缓存）
const JS_MODULES = [
    '/static/js/modules/api.js',
    '/static/js/modules/state.js',
    '/static/js/modules/ui.js',
    '/static/js/modules/auth.js',
    '/static/js/modules/editor.js',
    '/static/js/modules/utils.js',
    '/static/js/modules/events.js',
    '/static/js/modules/comment-widget.js', // Ensure all modules are listed
    '/static/js/theme-sdk.js',
    '/static/js/pwa.js',
    '/static/js/heatmap.js'
];

// 第三方库（可选）
const LIBS = [
    '/static/lib/fontawesome/css/all.min.css',
    '/static/lib/marked/marked.min.js',
    '/static/lib/dompurify/purify.min.js',
    '/static/lib/highlightjs/highlight.min.js',
    '/static/lib/highlightjs/github.min.css',
    '/static/lib/viewerjs/viewer.min.js',
    '/static/lib/viewerjs/viewer.min.css'
];

// 字体文件（可选）
const FONTS = [
    '/static/lib/fontawesome/webfonts/fa-solid-900.woff2',
    '/static/lib/fontawesome/webfonts/fa-regular-400.woff2'
];

// 所有需要预缓存的资源集合
const ALL_ASSETS = [...PRECACHE_ASSETS, ...JS_MODULES, ...LIBS, ...FONTS];

// 不缓存的路径
const EXCLUDED_PATHS = [
    '/api/auth/',
    '/api/ai/',
    '/api/upload/',
    '/api/settings/',
    '/login',
    '/register',
    '/logout',
    '/settings'
];

// 检查是否为排除路径
function isExcludedPath(url) {
    const pathname = new URL(url, self.location.origin).pathname;
    return EXCLUDED_PATHS.some(path => pathname.startsWith(path));
}

// 检查是否为 API 请求
function isApiRequest(url) {
    const pathname = new URL(url, self.location.origin).pathname;
    return pathname.startsWith('/api/');
}

// 检查是否为导航请求
function isNavigationRequest(request) {
    return request.mode === 'navigate' ||
           request.headers.get('accept')?.includes('text/html');
}

/**
 * Helper: Fetch asset with version param to bypass HTTP cache,
 * but store in Cache Storage with clean URL key.
 * 这样 ES Modules 的 import '/static/foo.js' (无版本号) 才能命中缓存
 */
async function cacheAssetWithVersion(cache, url) {
    try {
        // 添加版本号参数以绕过浏览器 HTTP 缓存
        const versionedUrl = url.includes('?') 
            ? `${url}&v=${CACHE_VERSION}` 
            : `${url}?v=${CACHE_VERSION}`;
            
        const response = await fetch(versionedUrl);
        
        if (response.ok) {
            // 使用原始 URL (不带版本号) 作为 Key 存入缓存
            await cache.put(url, response);
            return true;
        }
    } catch (e) {
        console.warn(`[SW] Failed to cache: ${url}`, e);
    }
    return false;
}

// 安装事件 - 预缓存
self.addEventListener('install', (event) => {
    console.log('[SW] Installing Service Worker v' + CACHE_VERSION);

    event.waitUntil(
        (async () => {
            const cache = await caches.open(STATIC_CACHE);

            // 并行缓存所有资源
            // 使用 cacheAssetWithVersion 确保获取最新内容并以 clean URL 存储
            await Promise.all(ALL_ASSETS.map(url => cacheAssetWithVersion(cache, url)));

            console.log('[SW] Installation complete');
            // 强制跳过等待，让新 SW 尽快接管 (配合客户端 reload 逻辑)
            // self.skipWaiting(); 
            // 注意：如果自动 skipWaiting，可能会导致正在使用的旧页面资源加载错误。
            // 最好还是由用户点击“刷新”按钮触发 postMessage('skipWaiting')。
        })()
    );
});

// 激活事件
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating Service Worker');

    event.waitUntil(
        (async () => {
            // 清理旧缓存
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter(name => !name.includes(CACHE_VERSION))
                    .map(name => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );

            // 接管所有客户端
            await self.clients.claim();
            console.log('[SW] Activation complete');
        })()
    );
});

// 请求拦截
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = request.url;

    // 只处理 GET 请求
    if (request.method !== 'GET') return;

    // 只处理 http/https 请求
    if (!url.startsWith('http')) return;

    // 跳过排除路径
    if (isExcludedPath(url)) return;

    // 1. 导航请求：网络优先 -> 缓存 -> 离线页
    if (isNavigationRequest(request)) {
        event.respondWith(
            (async () => {
                try {
                    const response = await fetch(request);
                    if (response.ok) {
                        const cache = await caches.open(DYNAMIC_CACHE);
                        cache.put(request, response.clone());
                        return response;
                    }
                } catch (error) {
                    console.log('[SW] Navigation offline, checking cache');
                }

                // 尝试获取缓存的页面
                const cached = await caches.match(request);
                if (cached) return cached;

                // 尝试 App Shell 回退 (针对 SPA 路由)
                const appShell = await caches.match('/');
                if (appShell) return appShell;

                // 最后回退到离线提示页
                const offlinePage = await caches.match('/static/offline.html');
                if (offlinePage) return offlinePage;

                return new Response(
                    '<html><body><h1>离线模式</h1><p>请连接网络后重试</p></body></html>',
                    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                );
            })()
        );
        return;
    }

    // 2. API 请求：网络优先 -> 缓存(标记过期) -> 失败JSON
    if (isApiRequest(url)) {
        event.respondWith(
            (async () => {
                try {
                    const response = await fetch(request);
                    if (response.ok) {
                        const cache = await caches.open(DYNAMIC_CACHE);
                        cache.put(request, response.clone());
                        return response;
                    }
                } catch (error) {
                    // 网络失败
                }

                const cached = await caches.match(request);
                if (cached) {
                    const newHeaders = new Headers(cached.headers);
                    newHeaders.set('X-Cache-Status', 'stale');
                    return new Response(cached.body, {
                        status: cached.status,
                        statusText: cached.statusText,
                        headers: newHeaders
                    });
                }

                return new Response(
                    JSON.stringify({ error: '离线模式', offline: true }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } }
                );
            })()
        );
        return;
    }

    // 3. 静态资源：stale-while-revalidate 策略
    // 先返回缓存（快速），同时在后台更新缓存（确保下次访问是最新版本）
    event.respondWith(
        (async () => {
            // Debug 模式下强制网络优先，不走缓存
            if (IS_DEBUG) {
                 return fetch(request).catch(() => {
                     return new Response('Offline (Debug Mode)', { status: 503, statusText: 'Offline' });
                 });
            }

            // 查找缓存时忽略查询参数 (ignoreSearch: true)
            // 这样 /style.css?v=1.0.9 也能命中 /style.css 的缓存
            const cached = await caches.match(request, { ignoreSearch: true });

            // 启动后台更新 (仅当不是 debug 模式时)
            const fetchPromise = fetch(request).then(response => {
                if (response.ok) {
                    const cache = caches.open(STATIC_CACHE);
                    // 存储时使用 clean URL (去除查询参数)
                    // 确保 cache key 始终为 /static/js/main.js 而不是 /static/js/main.js?v=1.0.9
                    const cleanUrl = new URL(request.url);
                    cleanUrl.search = '';
                    
                    cache.then(c => c.put(cleanUrl.toString(), response.clone()));
                }
                return response;
            }).catch(() => null);

            // 有缓存就立即返回，否则等待网络
            if (cached) {
                return cached;
            }

            const networkResponse = await fetchPromise;
            if (networkResponse) {
                return networkResponse;
            }

            return new Response('', { status: 404, statusText: 'Not Found' });
        })()
    );
});

// 消息处理
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    if (event.data === 'clearCache') {
        caches.keys().then(names => {
            Promise.all(names.map(name => caches.delete(name)))
                .then(() => {
                    // 通知客户端清理完成 (如果有通信端口)
                    if (event.ports && event.ports[0]) {
                        event.ports[0].postMessage('cleared');
                    }
                });
        });
    }
});
