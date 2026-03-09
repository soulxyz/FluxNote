/**
 * 公共 Markdown 渲染模块
 * 统一处理 Markdown 渲染、Mermaid 图表、代码高亮、图片查看等
 *
 * 用法：
 *   import { renderContent, decodeHtmlEntities, parseWikiLinks } from '/static/js/markdown-renderer.js';
 *   await renderContent(container, content, options);
 */

// Mermaid 懒加载状态
let mermaidLoading = false;
let mermaidLoaded = false;
let mermaidCallbacks = [];

/**
 * 动态加载 Mermaid 库（按需加载 3.3MB）
 * 只在页面包含 mermaid/mindmap 代码块时才加载
 */
export async function loadMermaidIfNeeded() {
    // 已加载或正在加载，直接返回
    if (mermaidLoaded && typeof mermaid !== 'undefined') {
        return true;
    }

    if (mermaidLoading) {
        // 等待加载完成
        return new Promise(resolve => {
            mermaidCallbacks.push(resolve);
        });
    }

    mermaidLoading = true;

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://mirrors.sustech.edu.cn/cdnjs/ajax/libs/mermaid/10.9.0/mermaid.min.js';
        script.async = true;

        script.onload = () => {
            mermaidLoaded = true;
            mermaidLoading = false;

            // 初始化 Mermaid
            if (typeof mermaid !== 'undefined') {
                mermaid.initialize({ startOnLoad: false, theme: 'default' });
            }

            // 通知所有等待的回调
            mermaidCallbacks.forEach(cb => cb(true));
            mermaidCallbacks = [];
            resolve(true);
        };

        script.onerror = () => {
            mermaidLoading = false;
            console.error('Failed to load Mermaid');
            mermaidCallbacks.forEach(cb => cb(false));
            mermaidCallbacks = [];
            resolve(false);
        };

        document.head.appendChild(script);
    });
}

/**
 * 检查内容是否包含 Mermaid 图表
 */
export function hasMermaidContent(content) {
    if (!content) return false;
    return /```(?:mermaid|mindmap)\s*\n/i.test(content) ||
           /class="(?:language-)?(?:mermaid|mindmap)"/i.test(content);
}

// 解码 HTML 实体（修复 DOMPurify 导致的 Mermaid 语法问题）
export function decodeHtmlEntities(text) {
    if (!text) return '';
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

// 解析 WikiLinks 语法 [[title]] 或 [[title|display]]
export function parseWikiLinks(content) {
    if (!content) return '';
    return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, title, display) => {
        return `<span class="wiki-link" title="${title.trim()}">${(display || title).trim()}</span>`;
    });
}

/**
 * 修复中文标点导致的 Markdown 粗体/斜体解析问题
 * 问题：marked.js 不认为中文标点是单词边界，导致 **"文字"** 无法正确解析
 * 方案：在 ** 或 * 与中文标点之间插入零宽空格（U+200B），让解析器正确识别边界
 */
export function fixChinesePunctuationForMarkdown(content) {
    if (!content) return '';

    // 中文标点：引号、书名号、括号、顿号、逗号、句号、问号、感叹号等
    // 使用 Unicode 转义避免编码问题
    const chinesePunctuation = '["\u201C\u201D\u2018\u2019\u300C\u300D\u300E\u300F\u3010\u3011\u300A\u300B\uFF08\uFF09\u3001\uFF0C\u3002\uFF1F\uFF01\uFF1B\uFF1A]';

    // 在 ** 前后添加零宽空格（如果相邻的是中文标点）
    // 例如：**"文字"** -> **​"文字"​**
    content = content.replace(new RegExp(`(\\*\\*)(${chinesePunctuation})`, 'g'), '$1\u200B$2');
    content = content.replace(new RegExp(`(${chinesePunctuation})(\\*\\*)`, 'g'), '$1\u200B$2');

    // 同样处理单个 * (斜体)
    content = content.replace(new RegExp(`(\\*)(${chinesePunctuation})`, 'g'), '$1\u200B$2');
    content = content.replace(new RegExp(`(${chinesePunctuation})(\\*)`, 'g'), '$1\u200B$2');

    return content;
}

/**
 * 渲染 Markdown 内容（核心函数）
 * @param {HTMLElement} container - 目标容器
 * @param {string} content - Markdown 原始内容
 * @param {Object} options - 配置选项
 * @param {boolean} options.skipFirstH1 - 是否跳过第一个 h1 标题
 * @param {boolean} options.enableViewer - 是否启用图片查看器（默认 true）
 * @param {boolean} options.enableMermaid - 是否启用 Mermaid 渲染（默认 true）
 * @param {boolean} options.enableHighlight - 是否启用代码高亮（默认 true）
 */
export async function renderContent(container, content, options = {}) {
    if (!container || !content) return;

    const {
        skipFirstH1 = false,
        enableViewer = true,
        enableMermaid = true,
        enableHighlight = true
    } = options;

    try {
        // 1. 处理 WikiLinks
        let processed = parseWikiLinks(content);

        // 2. 修复中文标点导致的粗体/斜体解析问题
        processed = fixChinesePunctuationForMarkdown(processed);

        // 3. 移除第一个 h1 标题（避免重复）
        if (skipFirstH1) {
            processed = processed.replace(/^#\s+.+\n?/, '');
        }

        // 4. Markdown 解析
        let html = processed;
        if (typeof marked !== 'undefined') {
            html = marked.parse(processed);
        }

        if (typeof DOMPurify !== 'undefined') {
            html = DOMPurify.sanitize(html, {
                ADD_TAGS: ['audio', 'source', 'video', 'iframe'],
                ADD_ATTR: ['controls', 'src', 'type', 'preload', 'autoplay', 'muted', 'loop', 'poster',
                           'width', 'height', 'frameborder', 'allowfullscreen', 'allow',
                           'referrerpolicy', 'loading', 'srcdoc', 'scrolling'],
            });
        }

        container.innerHTML = html;

        // 5.5 B站链接 → 卡片（在 DOMPurify 之后操作 DOM，卡片 HTML 可信）
        convertBilibiliLinksToCards(container);
        loadBilibiliCards(container);
        

        // 6. 渲染 Mermaid 图表（按需懒加载）
        if (enableMermaid) {
            // 检查是否包含 mermaid/mindmap 代码块
            const mermaidBlocks = container.querySelectorAll([
                'pre code.language-mermaid',
                'pre code.mermaid',
                'pre code.language-mindmap',
                'pre code.mindmap'
            ].join(','));

            if (mermaidBlocks.length > 0) {
                // 懒加载 Mermaid
                const loaded = await loadMermaidIfNeeded();
                if (loaded && typeof mermaid !== 'undefined') {
                    await renderMermaidBlocks(container);
                }
            }
        }

        // 7. 代码高亮
        if (enableHighlight && typeof hljs !== 'undefined') {
            container.querySelectorAll('pre code').forEach(block => {
                const isDiagram = block.classList.contains('language-mermaid') ||
                                  block.classList.contains('language-mindmap');
                if (!isDiagram) {
                    hljs.highlightElement(block);
                }
            });
        }

        // 8. 图片查看器
        if (enableViewer && typeof Viewer !== 'undefined') {
            new Viewer(container, {
                button: true,
                navbar: false,
                title: false,
                toolbar: { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1 }
            });
        }

    } catch (e) {
        console.error('Markdown rendering failed:', e);
        container.textContent = content;
    }
}

/**
 * 渲染 Mermaid 图表块
 */
export async function renderMermaidBlocks(container) {
    // 增强选择器：支持 language-mermaid, language-mindmap 以及直接的 mermaid, mindmap 类名
    const blocks = container.querySelectorAll([
        'pre code.language-mermaid',
        'pre code.mermaid',
        'pre code.language-mindmap',
        'pre code.mindmap'
    ].join(','));

    if (blocks.length === 0) return;

    const nodesToRender = [];

    blocks.forEach(block => {
        // 检查元素是否仍在文档中
        if (!document.body.contains(block)) return;

        const isMindmap = block.classList.contains('language-mindmap');

        // 关键：解码 HTML 实体（修复 DOMPurify 转义问题）
        let rawCode = decodeHtmlEntities(block.textContent);

        // Mindmap 自动添加关键字
        if (isMindmap && !rawCode.trim().startsWith('mindmap')) {
            rawCode = 'mindmap\n' + rawCode;
        }

        const pre = block.parentElement;
        if (!pre || !pre.parentNode || !document.body.contains(pre)) return;

        const div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = rawCode;
        div.style.textAlign = 'center';

        pre.parentNode.replaceChild(div, pre);
        nodesToRender.push(div);
    });

    if (nodesToRender.length > 0) {
        try {
            // 过滤掉已不在文档中的节点
            const validNodes = nodesToRender.filter(node => document.body.contains(node));
            if (validNodes.length > 0) {
                await mermaid.run({ nodes: validNodes });
            }
        } catch (e) {
            // 忽略因 DOM 元素被移除导致的错误
            if (e.message && e.message.includes('getBoundingClientRect')) {
                console.warn('[Mermaid] Element removed during rendering, skipping');
            } else {
                console.error('Mermaid rendering failed:', e);
            }
        }
    }
}

// ==================== B站视频卡片 ====================

const BILI_SVG_SM = `<svg viewBox="0 0 24 24" width="14" height="14" fill="#fb7299" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>`;
const BILI_SVG_LG = `<svg viewBox="0 0 24 24" width="36" height="36" fill="rgba(255,255,255,0.85)" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>`;

export function extractBilibiliId(url) {
    if (!url) return null;
    // Bilibili BV IDs use base58 encoding (excludes 0, O, I, l to avoid confusion)
    let m = url.match(/bilibili\.com\/video\/(BV[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+)/i);
    if (m) return m[1];
    m = url.match(/b23\.tv\/(BV[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+)/i);
    if (m) return m[1];
    m = url.match(/bilibili\.com\/video\/av(\d+)/i);
    if (m) return `av${m[1]}`;
    return null;
}

export function createBilibiliCardHtml(bvid) {
    return `<div class="bilibili-card" data-bvid="${bvid}" role="button" tabindex="0">` +
        `<div class="bili-card-thumb">` +
            `<div class="bili-thumb-placeholder">${BILI_SVG_LG}</div>` +
            `<div class="bili-play-btn"><i class="fas fa-play"></i></div>` +
        `</div>` +
        `<div class="bili-card-content">` +
            `<div class="bili-card-brand-row">${BILI_SVG_SM}<span class="bili-brand-name">bilibili</span></div>` +
            `<div class="bili-card-title" data-loading="true">加载中…</div>` +
            `<div class="bili-card-meta"><span class="bili-card-bvid">${bvid}</span></div>` +
        `</div>` +
        `<div class="bili-card-arrow"><i class="fas fa-chevron-right"></i></div>` +
    `</div>`;
}

export function loadBilibiliCards(container) {
    if (!container) return;
    container.querySelectorAll('.bilibili-card[data-bvid]:not([data-loaded])').forEach(card => {
        const bvid = card.dataset.bvid;
        if (!bvid) return;
        card.dataset.loaded = 'loading';

        fetch(`/api/bilibili/info?bvid=${encodeURIComponent(bvid)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data || data.error) { card.dataset.loaded = 'error'; return; }

                const titleEl = card.querySelector('.bili-card-title');
                if (titleEl && data.title) {
                    titleEl.textContent = data.title;
                    titleEl.removeAttribute('data-loading');
                    card.title = data.title;
                }

                const metaEl = card.querySelector('.bili-card-meta');
                if (metaEl && data.owner && !metaEl.querySelector('.bili-card-owner')) {
                    const ownerSpan = document.createElement('span');
                    ownerSpan.className = 'bili-card-owner';
                    ownerSpan.textContent = data.owner;
                    metaEl.appendChild(ownerSpan);
                }

                if (data.cover) {
                    const thumbEl = card.querySelector('.bili-card-thumb');
                    if (thumbEl) {
                        const img = new Image();
                        img.loading = 'lazy';
                        img.referrerPolicy = 'no-referrer';
                        img.alt = data.title || bvid;
                        img.onerror = () => img.remove();
                        img.src = data.cover;
                        thumbEl.insertBefore(img, thumbEl.firstChild);
                    }
                }

                card.dataset.loaded = 'true';
            })
            .catch(() => {
                const titleEl = card.querySelector('.bili-card-title');
                if (titleEl) { titleEl.textContent = bvid; titleEl.removeAttribute('data-loading'); }
                card.dataset.loaded = 'error';
            });
    });
}

function convertBilibiliLinksToCards(container) {
    container.querySelectorAll('a').forEach(link => {
        const bvid = extractBilibiliId(link.href);
        if (!bvid) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = createBilibiliCardHtml(bvid);
        const card = wrapper.firstChild;
        const parent = link.parentElement;
        if (parent && parent.tagName === 'P' && parent.childNodes.length === 1) {
            parent.replaceWith(card);
        } else {
            link.replaceWith(card);
        }
    });
}


// ==================== Marked 渲染器 ====================

function mediaRenderer() {
    const audioExts = /\.(mp3|wav|ogg|m4a|flac|aac|webm)$/i;
    const videoExts = /\.(mp4|webm|ogg|mov)$/i;

    return {
        // marked v12 调用方式: link(href, title, text)
        // 兼容新版对象参数: link({ href, title, tokens })
        link(href, title, text) {
            if (href && typeof href === 'object') {
                const token = href;
                try {
                    text = (this.parser && token.tokens) ? this.parser.parseInline(token.tokens) : '';
                } catch (_) { text = ''; }
                if (!text && token.tokens) {
                    text = token.tokens.map(t => t.raw || t.text || '').join('');
                }
                title = token.title;
                href = token.href;
            }
            if (!text) text = href;

            if (audioExts.test(href)) {
                return `<audio controls preload="metadata" src="${href}"></audio>`;
            }
            if (videoExts.test(href)) {
                return `<div class="video-wrapper"><video controls preload="metadata" src="${href}"></video></div>`;
            }
            const titleAttr = title ? ` title="${title}"` : '';
            return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
        }
    };
}

export function initMarkdownRenderer(config = {}) {
    if (typeof marked !== 'undefined') {
        marked.use({ gfm: true, breaks: true, renderer: mediaRenderer() });
    }

    // 配置 highlight.js
    if (typeof hljs !== 'undefined') {
        const hljsConfig = config.highlight || {};
        hljs.configure({ ignoreUnescapedHTML: true, ...hljsConfig });
    }

    // Mermaid 不再在此初始化，改为懒加载
    // 如果需要预加载，可以调用 loadMermaidIfNeeded()
}

/**
 * 统一初始化主题所需的插件 (Highlight.js, Mermaid, Viewer.js)
 * @param {HTMLElement} container - 需要初始化的容器
 */
export async function initThemePlugins(container) {
    if (!container) return;

    // 1. 代码高亮
    if (window.hljs) {
        container.querySelectorAll('pre code').forEach(block => {
            const isDiagram = block.classList.contains('language-mermaid') ||
                              block.classList.contains('language-mindmap');
            if (!isDiagram) {
                window.hljs.highlightElement(block);
            }
        });
    }

    // 2. Mermaid 图表（懒加载）
    const mermaidBlocks = container.querySelectorAll([
        'pre code.language-mermaid',
        'pre code.mermaid',
        'pre code.language-mindmap',
        'pre code.mindmap'
    ].join(','));

    if (mermaidBlocks.length > 0) {
        const loaded = await loadMermaidIfNeeded();
        if (loaded && window.mermaid) {
            await renderMermaidBlocks(container);
        }
    }

    // 3. 图片查看器
    if (window.Viewer) {
        new window.Viewer(container, {
            button: true, navbar: false, title: false,
            toolbar: { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1 }
        });
    }

    // 4. B站视频卡片元数据加载（服务端渲染的页面已输出卡片 HTML）
    loadBilibiliCards(container);
}

// 默认导出
export default {
    renderContent,
    decodeHtmlEntities,
    parseWikiLinks,
    fixChinesePunctuationForMarkdown,
    initMarkdownRenderer,
    renderMermaidBlocks,
    initThemePlugins,
    loadMermaidIfNeeded,
    hasMermaidContent,
    extractBilibiliId,
    createBilibiliCardHtml,
    loadBilibiliCards
};
