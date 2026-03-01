/**
 * 流光笔记 Service Worker
 * 为流光笔记提供离线支持、加载加速和稳定的更新机制
 */

// 这些变量将被 Flask 路由动态替换
const CACHE_VERSION = 'DEV'; 
const ASSET_MANIFEST = {}; 
const IS_DEBUG = false;

// 静态资源使用固定缓存名，通过 manifest 实现增量更新
const STATIC_CACHE = 'fluxnote-static-v1';
const LIBS_CACHE = 'fluxnote-libs-v1';
const IMAGE_CACHE = 'fluxnote-images-v1';
const DYNAMIC_CACHE = `fluxnote-dynamic-${CACHE_VERSION}`;

// 第三方库和字体 (由于忽略了哈希计算，采用固定版本或原始路径)
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
 * 安装事件：根据 Manifest 执行增量预缓存
 */
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const staticCache = await caches.open(STATIC_CACHE);
        const libsCache = await caches.open(LIBS_CACHE);
        
        // 1. 处理带哈希的业务代码 (增量检查并更新到 STATIC_CACHE)
        const manifestEntries = Object.entries(ASSET_MANIFEST);
        const manifestPromises = manifestEntries.map(async ([url, hash]) => {
            try {
                // 检查现有缓存
                const cachedResponse = await staticCache.match(url);
                if (cachedResponse) {
                    // 如果缓存中已存在且哈希一致，跳过下载
                    const cachedHash = cachedResponse.headers.get('X-Asset-Hash');
                    if (cachedHash === hash) {
                        return;
                    }
                }

                // 技巧：我们通过在请求 URL 上附加版本号来利用浏览器 HTTP 缓存
                const versionedUrl = `${url}?v=${hash}`;
                const response = await fetch(versionedUrl);
                if (response.ok) {
                    // 创建新响应头，存入该文件的独立哈希以便下次对比
                    const headers = new Headers(response.headers);
                    headers.set('X-Asset-Hash', hash);
                    const newResponse = new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: headers
                    });
                    return staticCache.put(url, newResponse);
                }
            } catch (e) {
                console.warn(`[SW] Failed to cache static ${url}:`, e);
            }
        });

        // 2. 处理第三方库 (进入 LIBS_CACHE)
        const libPromises = EXTERNAL_LIBS.map(async (url) => {
            const cachedResponse = await libsCache.match(url);
            if (!cachedResponse) {
                return libsCache.add(url);
            }
        });

        await Promise.all([...manifestPromises, ...libPromises]);
        console.log(`[SW] ${CACHE_VERSION} Incremental Precache Complete`);
    })());
});

/**
 * 策略：简单缓存优先
 * 优化：增加 ignoreSearch: true，确保模板中带 ?v=hash 的请求能命中缓存中的原始路径
 */
async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    // 关键修复：忽略搜索参数匹配
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            // 如果是图片，限制该桶的存储条数，防止无限膨胀
            if (cacheName === IMAGE_CACHE) {
                limitCacheSize(cacheName, 100);
            }
            cache.put(request, response.clone());
        }
        return response;
    } catch (e) {
        return new Response('', { status: 404 });
    }
}

/**
 * 简单的缓存条数限制逻辑
 */
async function limitCacheSize(cacheName, maxItems) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
        // 删除最旧的一条
        await cache.delete(keys[0]);
    }
}

/**
 * 策略：Network First (网络优先)
 */
async function networkFirst(request, cacheName) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            const headers = new Headers(cachedResponse.headers);
            headers.set('X-Cache-Status', 'stale');
            return new Response(cachedResponse.body, { status: cachedResponse.status, statusText: cachedResponse.statusText, headers });
        }
    }
    return new Response(JSON.stringify({ error: '离线模式' }), { 
        status: 503, 
        headers: { 'Content-Type': 'application/json' } 
    });
}

/**
 * 策略：Network First with Timeout (HTML 导航专用)
 */
async function networkFirstWithTimeout(request, timeoutMs, fallbackUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        console.log('[SW] Navigation fetch failed, falling back to cache');
    }

    const cached = await caches.match(request);
    if (cached) {
        if (request.mode === 'navigate' && cached.redirected) {
            console.warn('[SW] Cannot return redirected cache');
        } else {
            return cached;
        }
    }

    return caches.match(fallbackUrl) || new Response(
        '<html><body><div style="padding: 20px; font-family: sans-serif;"><h1>离线模式</h1><p>网络连接已断开。</p></div></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

/**
 * 激活事件：清理旧缓存并接管页面
 */
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        const VALID_CACHES = [STATIC_CACHE, LIBS_CACHE, IMAGE_CACHE, DYNAMIC_CACHE];
        
        await Promise.all(
            cacheNames
                .filter(name => {
                    // 仅清理 fluxnote 相关但不在当前白名单内的缓存
                    return name.startsWith('fluxnote-') && !VALID_CACHES.includes(name);
                })
                .map(name => caches.delete(name))
        );
        // 立即接管所有客户端
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

    // 1. 导航请求 (HTML)
    if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
        event.respondWith(networkFirstWithTimeout(request, 3000, '/static/offline.html'));
        return;
    }

    // 2. API 请求
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request, DYNAMIC_CACHE));
        return;
    }

    // 3. 图片请求 (笔记图片、Icons) - 使用 IMAGE_CACHE
    if (url.pathname.startsWith('/uploads/') || /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(url.pathname)) {
        event.respondWith(cacheFirst(request, IMAGE_CACHE));
        return;
    }

    // 4. 第三方库 - 使用 LIBS_CACHE
    if (EXTERNAL_LIBS.includes(url.pathname) || url.pathname.includes('/static/lib/')) {
        event.respondWith(cacheFirst(request, LIBS_CACHE));
        return;
    }

    // 5. 业务静态资源 (JS/CSS) - 使用 STATIC_CACHE
    event.respondWith(cacheFirst(request, STATIC_CACHE));
});

/**
 * 消息处理
 */
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
