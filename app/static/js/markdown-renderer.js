/**
 * 公共 Markdown 渲染模块
 * 统一处理 Markdown 渲染、Mermaid 图表、代码高亮、图片查看等
 *
 * 用法：
 *   import { renderContent, decodeHtmlEntities, parseWikiLinks } from '/static/js/markdown-renderer.js';
 *   await renderContent(container, content, options);
 */

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

        // 5. 安全清理
        if (typeof DOMPurify !== 'undefined') {
            html = DOMPurify.sanitize(html);
        }

        container.innerHTML = html;

        // 6. 渲染 Mermaid 图表
        if (enableMermaid && typeof mermaid !== 'undefined') {
            await renderMermaidBlocks(container);
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
        const isMindmap = block.classList.contains('language-mindmap');

        // 关键：解码 HTML 实体（修复 DOMPurify 转义问题）
        let rawCode = decodeHtmlEntities(block.textContent);

        // Mindmap 自动添加关键字
        if (isMindmap && !rawCode.trim().startsWith('mindmap')) {
            rawCode = 'mindmap\n' + rawCode;
        }

        const pre = block.parentElement;
        const div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = rawCode;
        div.style.textAlign = 'center';

        if (pre && pre.parentNode) {
            pre.parentNode.replaceChild(div, pre);
            nodesToRender.push(div);
        }
    });

    if (nodesToRender.length > 0) {
        try {
            await mermaid.run({ nodes: nodesToRender });
        } catch (e) {
            console.error('Mermaid rendering failed:', e);
        }
    }
}

/**
 * 初始化 Markdown 渲染器配置
 * @param {Object} config - 插件配置项
 */
export function initMarkdownRenderer(config = {}) {
    // 配置 marked
    if (typeof marked !== 'undefined') {
        marked.use({ gfm: true, breaks: true });
    }

    // 配置 highlight.js
    if (typeof hljs !== 'undefined') {
        const hljsConfig = config.highlight || {};
        hljs.configure({ ignoreUnescapedHTML: true, ...hljsConfig });
    }

    // 配置 Mermaid
    if (typeof mermaid !== 'undefined') {
        const mermaidConfig = config.mermaid || { theme: 'default' };
        mermaid.initialize({ startOnLoad: false, ...mermaidConfig });
    }
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

    // 2. Mermaid 图表
    if (window.mermaid) {
        await renderMermaidBlocks(container);
    }

    // 3. 图片查看器
    if (window.Viewer) {
        // 销毁旧实例（如果存在）- 这里简化处理，直接绑定新实例
        // Viewer.js 会自动处理重复绑定吗？通常最好是 new Viewer(element)
        // 我们的 container 通常是 .blog-main，如果是 SPA 切换，container 内容是新的，所以是安全的。
        new window.Viewer(container, {
            button: true, navbar: false, title: false,
            toolbar: { zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1 }
        });
    }
}

// 默认导出
export default {
    renderContent,
    decodeHtmlEntities,
    parseWikiLinks,
    fixChinesePunctuationForMarkdown,
    initMarkdownRenderer,
    renderMermaidBlocks,
    initThemePlugins
};
