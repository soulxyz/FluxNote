/**
 * 流光笔记 Service Worker
 * 为流光笔记提供离线支持、加载加速和稳定的更新机制
 */

// 这些变量将被 Flask 路由动态替换
const CACHE_VERSION = 'DEV'; 
const ASSET_MANIFEST = {}; 
const IS_DEBUG = false;

// 静态资源使用固定缓存名，通过资源哈希实现真正的增量更新
const STATIC_CACHE = 'fluxnote-static-v1';
const LIBS_CACHE = 'fluxnote-libs-v1';
const IMAGE_CACHE = 'fluxnote-images-v1';
const DYNAMIC_CACHE = `fluxnote-dynamic-${CACHE_VERSION}`;

const OFFLINE_FALLBACK = '/static/offline.html';

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
const EXCLUDED_PATHS = ['/api/auth/', '/api/ai/', '/api/upload/', '/api/update/', '/login', '/register', '/logout'];

/**
 * 是否是排除路径
 */
function isExcluded(url) {
    const pathname = new URL(url, self.location.origin).pathname;
    return EXCLUDED_PATHS.some(path => pathname.startsWith(path));
}

function shouldCacheResponse(response) {
    if (!response || !response.ok) return false;

    const cacheControl = response.headers.get('Cache-Control') || '';
    return !/no-store/i.test(cacheControl);
}

function getStaticAssetCache(url) {
    return url.startsWith('/static/lib/') ? LIBS_CACHE : STATIC_CACHE;
}

function createInstallError(stage, asset, error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stage, asset, message };
}

async function broadcastUpdateStatus(payload) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
        client.postMessage({
            type: 'sw-update-status',
            version: CACHE_VERSION,
            ...payload
        });
    }
}

/**
 * 安装事件：根据 Manifest 执行增量预缓存
 */
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        try {
            const staticCache = await caches.open(STATIC_CACHE);
            const libsCache = await caches.open(LIBS_CACHE);
            const manifestEntries = Object.entries(ASSET_MANIFEST);
            const libEntries = EXTERNAL_LIBS.filter((url) => !ASSET_MANIFEST[url]);
            const totalItems = manifestEntries.length + libEntries.length;
            let completedItems = 0;

            await broadcastUpdateStatus({ status: 'start', total: totalItems });

            // 0. 预缓存离线回退页面（确保离线时一定可用）
            try {
                const offlineResponse = await fetch(OFFLINE_FALLBACK, { cache: 'no-store' });
                if (offlineResponse.ok) {
                    await staticCache.put(OFFLINE_FALLBACK, offlineResponse);
                }
            } catch (e) {
                console.warn('[SW] Failed to precache offline fallback:', e);
            }

            // 1. 处理带哈希的业务代码 (增量检查并更新到 STATIC_CACHE)
            const manifestPromises = manifestEntries.map(async ([url, hash]) => {
                try {
                    await broadcastUpdateStatus({
                        status: 'progress',
                        stage: 'fetching',
                        asset: url,
                        completed: completedItems,
                        total: totalItems
                    });

                    const targetCache = await caches.open(getStaticAssetCache(url));
                    const cachedResponse = await targetCache.match(url);
                    if (cachedResponse) {
                        const cachedHash = cachedResponse.headers.get('X-Asset-Hash');
                        if (cachedHash === hash) {
                            completedItems += 1;
                            await broadcastUpdateStatus({
                                status: 'progress',
                                stage: 'cached',
                                asset: url,
                                completed: completedItems,
                                total: totalItems
                            });
                            return;
                        }
                    }

                    const versionedUrl = `${url}?v=${hash}`;
                    const response = await fetch(versionedUrl, { cache: 'no-store' });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const headers = new Headers(response.headers);
                    headers.set('X-Asset-Hash', hash);
                    const newResponse = new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: headers
                    });
                    await targetCache.put(url, newResponse);
                    completedItems += 1;
                    await broadcastUpdateStatus({
                        status: 'progress',
                        stage: 'cached',
                        asset: url,
                        completed: completedItems,
                        total: totalItems
                    });
                } catch (error) {
                    throw createInstallError('static', url, error);
                }
            });

            // 2. 处理第三方库 (进入 LIBS_CACHE)
            const libPromises = libEntries.map(async (url) => {
                try {
                    await broadcastUpdateStatus({
                        status: 'progress',
                        stage: 'fetching',
                        asset: url,
                        completed: completedItems,
                        total: totalItems
                    });

                    const cachedResponse = await libsCache.match(url);
                    if (cachedResponse) {
                        completedItems += 1;
                        await broadcastUpdateStatus({
                            status: 'progress',
                            stage: 'cached',
                            asset: url,
                            completed: completedItems,
                            total: totalItems
                        });
                        return;
                    }

                    const response = await fetch(url, { cache: 'no-store' });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    await libsCache.put(url, response);
                    completedItems += 1;
                    await broadcastUpdateStatus({
                        status: 'progress',
                        stage: 'cached',
                        asset: url,
                        completed: completedItems,
                        total: totalItems
                    });
                } catch (error) {
                    throw createInstallError('lib', url, error);
                }
            });

            const results = await Promise.allSettled([...manifestPromises, ...libPromises]);
            const failed = results.find((result) => result.status === 'rejected');
            if (failed) {
                throw failed.reason;
            }

            await broadcastUpdateStatus({
                status: 'ready',
                completed: completedItems,
                total: totalItems
            });
            console.log(`[SW] ${CACHE_VERSION} Incremental Precache Complete`);
        } catch (error) {
            const installError = error?.message ? error : createInstallError('install', null, error);
            await broadcastUpdateStatus({
                status: 'error',
                stage: installError.stage || 'install',
                asset: installError.asset || null,
                error: installError.message || 'Unknown install error'
            });
            throw new Error(installError.message || 'Service Worker install failed');
        }
    })());
});

/**
 * 策略：简单缓存优先
 * 优化：增加 ignoreSearch: true，确保模板中带 ?v=hash 的请求能命中缓存中的原始路径
 */
async function cacheFirst(request, cacheName, options = {}) {
    const { ignoreSearch = false } = options;
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreSearch });
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (shouldCacheResponse(response)) {
            const cloned = response.clone();
            cache.put(request, cloned).then(() => {
                if (cacheName === IMAGE_CACHE) {
                    limitCacheSize(cacheName, 100);
                }
            });
        }
        return response;
    } catch (e) {
        return new Response('', { status: 404 });
    }
}

/**
 * 缓存条数限制：先写入再清理，确保不超限
 */
async function limitCacheSize(cacheName, maxItems) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
        const overflow = keys.length - maxItems;
        await Promise.all(keys.slice(0, overflow).map(key => cache.delete(key)));
    }
}

/**
 * 策略：Network First (网络优先)
 */
async function networkFirst(request, cacheName) {
    try {
        const response = await fetch(request);
        if (shouldCacheResponse(response)) {
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
 * 支持 Navigation Preload 以减少 SW 启动延迟
 */
async function networkFirstWithTimeout(request, timeoutMs, fallbackUrl, preloadResponse) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = (await preloadResponse) || await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (shouldCacheResponse(response)) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
    }

    const cached = await caches.match(request);
    if (cached) {
        if (request.mode === 'navigate' && cached.redirected) {
            console.warn('[SW] Cannot return redirected cache');
        } else {
            return cached;
        }
    }

    const offlinePage = await caches.match(fallbackUrl);
    return offlinePage || new Response(
        '<html><body><div style="padding: 20px; font-family: sans-serif;"><h1>离线模式</h1><p>网络连接已断开。</p></div></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

/**
 * 激活事件：清理旧缓存、启用 Navigation Preload 并接管页面
 */
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // 先接管页面，让 controllerchange 尽快触发页面刷新
        await self.clients.claim();

        // 再做后续清理，不阻塞页面接管
        if (self.registration.navigationPreload) {
            await self.registration.navigationPreload.enable();
        }

        const cacheNames = await caches.keys();
        const VALID_CACHES = [STATIC_CACHE, LIBS_CACHE, IMAGE_CACHE, DYNAMIC_CACHE];
        await Promise.all(
            cacheNames
                .filter(name => name.startsWith('fluxnote-') && !VALID_CACHES.includes(name))
                .map(name => caches.delete(name))
        );
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

    // 1. 导航请求 (HTML) — 利用 Navigation Preload
    if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
        const preloadResponse = event.preloadResponse;
        event.respondWith(networkFirstWithTimeout(request, 3000, OFFLINE_FALLBACK, preloadResponse));
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
        event.respondWith(cacheFirst(request, LIBS_CACHE, { ignoreSearch: true }));
        return;
    }

    // 5. 业务静态资源 (JS/CSS) - 使用 STATIC_CACHE
    // 移除 ignoreSearch: true，确保带有 ?v=hash 的新请求能触发网络请求，而不是命中旧版本的缓存
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
