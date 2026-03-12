/**
 * reader.js — 文档阅读面板
 *
 * 职责：
 *   1. 管理右侧滑出式阅读面板的开关与生命周期
 *   2. PDF 阅读（PDF.js）：渲染、翻页、缩放、文本层
 *   3. Word 阅读（mammoth 已在后端转 MD）：Markdown 渲染
 *   4. 文本选中 → 浮动工具栏 → 插入引用 / AI 解释
 *   5. 响应 `doc:navigate` 事件 → 跳页 + 高亮引用文字
 */

import { api } from './api.js';
import { showToast } from './utils.js';

// ─── 状态 ─────────────────────────────────────────────────────────────────

const state = {
    isOpen: false,
    docId: null,
    docMeta: null,          // Document 元数据
    fileType: null,         // 'pdf' | 'docx'
    pdfDoc: null,           // PDF.js PDFDocumentProxy
    currentPage: 1,
    totalPages: 0,
    scale: 1.4,
    isRendering: false,
    renderPending: false,
    pdfjsLoaded: false,
    mdContent: null,        // Word 转换的 Markdown
    activeNoteId: null,     // 当前笔记 ID，用于插入引用
};

// ─── DOM 引用（懒初始化）─────────────────────────────────────────────────

let panel, overlay, canvas, ctx, textLayerDiv, pageInput, totalPagesEl,
    scaleSelect, mdContentEl, toolbar, floatBar;

function initDom() {
    panel         = document.getElementById('readerPanel');
    overlay       = document.getElementById('readerOverlay');
    canvas        = document.getElementById('readerCanvas');
    textLayerDiv  = document.getElementById('readerTextLayer');
    pageInput     = document.getElementById('readerPageInput');
    totalPagesEl  = document.getElementById('readerTotalPages');
    scaleSelect   = document.getElementById('readerScale');
    mdContentEl   = document.getElementById('readerMdContent');
    toolbar       = document.getElementById('readerToolbar');
    floatBar      = document.getElementById('readerFloatBar');

    if (canvas) ctx = canvas.getContext('2d');
}

// ─── PDF.js 懒加载 ────────────────────────────────────────────────────────

async function loadPdfjsIfNeeded() {
    if (state.pdfjsLoaded) return window.pdfjsLib;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
        script.type = 'module';
        script.onload = () => {
            // pdfjs-dist ES module 挂载在 window.pdfjsLib 上
            state.pdfjsLoaded = true;
            resolve(window.pdfjsLib);
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// 使用 importScripts-friendly 的非模块版本
async function getPdfjsLib() {
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
        return window.pdfjsLib;
    }
    // 动态 import ES module
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
        mod.GlobalWorkerOptions.workerSrc =
            'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
        window.pdfjsLib = mod;
        state.pdfjsLoaded = true;
        return mod;
    } catch (e) {
        showToast('PDF 渲染库加载失败，请检查网络');
        throw e;
    }
}

// ─── 公开 API ─────────────────────────────────────────────────────────────

export const reader = {
    init() {
        initDom();
        if (!panel) return; // 面板不在当前页

        _bindPanelControls();
        _bindSelectionToolbar();
        _bindKeyboard();

        // 监听"点击引用回溯"事件
        window.addEventListener('doc:navigate', (e) => {
            const { docId, page, text } = e.detail || {};
            if (!docId) return;
            if (state.docId === docId && state.isOpen) {
                _gotoPageAndHighlight(page, text);
            } else {
                reader.open(docId, null, { page, text });
            }
        });

        // 监听笔记切换，更新 activeNoteId
        window.addEventListener('note:activated', (e) => {
            state.activeNoteId = e.detail?.noteId || null;
        });
    },

    /**
     * 打开文档阅读面板
     * @param {string} docId - 文档 ID
     * @param {string|null} noteId - 关联笔记 ID（用于插入引用）
     * @param {object} opts - { page, text } 可选初始跳转
     */
    async open(docId, noteId = null, opts = {}) {
        if (!panel) initDom();
        if (!panel) return;

        state.activeNoteId = noteId || state.activeNoteId;

        // 已打开同一文档，只跳转
        if (state.isOpen && state.docId === docId) {
            if (opts.page) await _gotoPageAndHighlight(opts.page, opts.text);
            return;
        }

        _showPanel();

        // 加载元数据
        state.docId = docId;
        state.pdfDoc = null;
        state.mdContent = null;
        state.currentPage = opts.page || 1;

        _setLoading(true);

        const res = await api.documents.get(docId);
        if (!res || !res.ok) { _setLoading(false); return; }
        const meta = await res.json();
        state.docMeta = meta;
        state.fileType = meta.file_type;

        // 更新面板标题
        const titleEl = document.getElementById('readerDocTitle');
        if (titleEl) titleEl.textContent = meta.original_filename;

        if (meta.file_type === 'pdf') {
            await _loadPdf(docId, opts);
        } else {
            await _loadWord(docId);
        }

        _setLoading(false);
    },

    close() {
        _hidePanel();
    },

    /** 从外部设置当前活动笔记（用于引用插入定位） */
    setActiveNote(noteId) {
        state.activeNoteId = noteId;
    }
};

// ─── 面板控制 ─────────────────────────────────────────────────────────────

function _showPanel() {
    state.isOpen = true;
    panel.classList.add('open');
    document.body.classList.add('reader-open');
    // 移动端显示 overlay
    if (overlay) overlay.style.display = 'block';
}

function _hidePanel() {
    state.isOpen = false;
    panel.classList.remove('open');
    document.body.classList.remove('reader-open');
    if (overlay) overlay.style.display = 'none';
    _hideFloatBar();
    // 释放 PDF 内存
    if (state.pdfDoc) {
        state.pdfDoc.destroy();
        state.pdfDoc = null;
    }
}

function _setLoading(loading) {
    const loadingEl = document.getElementById('readerLoading');
    if (!loadingEl) return;
    loadingEl.style.display = loading ? 'flex' : 'none';
    if (canvas) canvas.style.display = loading ? 'none' : 'block';
    if (textLayerDiv) textLayerDiv.style.display = loading ? 'none' : 'block';
    if (mdContentEl) mdContentEl.style.display = 'none';
}

function _bindPanelControls() {
    // 关闭按钮
    document.getElementById('readerCloseBtn')?.addEventListener('click', reader.close);
    // Overlay 点击关闭（移动端）
    overlay?.addEventListener('click', reader.close);

    // 翻页按钮
    document.getElementById('readerPrevBtn')?.addEventListener('click', () => _changePage(-1));
    document.getElementById('readerNextBtn')?.addEventListener('click', () => _changePage(1));

    // 页码输入
    pageInput?.addEventListener('change', () => {
        const p = parseInt(pageInput.value);
        if (p >= 1 && p <= state.totalPages) _gotoPageAndHighlight(p);
    });

    // 缩放
    scaleSelect?.addEventListener('change', () => {
        state.scale = parseFloat(scaleSelect.value);
        _renderPage(state.currentPage);
    });

    // 全屏按钮
    document.getElementById('readerFullscreenBtn')?.addEventListener('click', () => {
        panel.classList.toggle('fullscreen');
    });
}

function _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (!state.isOpen) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') _changePage(-1);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') _changePage(1);
        else if (e.key === 'Escape') reader.close();
    });
}

// ─── PDF 加载与渲染 ───────────────────────────────────────────────────────

async function _loadPdf(docId, opts = {}) {
    const pdfjsLib = await getPdfjsLib();

    const fileUrl = `/api/documents/${docId}/file`;
    try {
        const pdfDoc = await pdfjsLib.getDocument(fileUrl).promise;
        state.pdfDoc = pdfDoc;
        state.totalPages = pdfDoc.numPages;
        state.currentPage = opts.page || 1;

        // 显示 PDF 区域，隐藏 MD 区域
        if (canvas) canvas.style.display = 'block';
        if (textLayerDiv) textLayerDiv.style.display = 'block';
        if (mdContentEl) mdContentEl.style.display = 'none';
        toolbar?.classList.remove('word-mode');

        if (totalPagesEl) totalPagesEl.textContent = state.totalPages;

        await _renderPage(state.currentPage);
        if (opts.text) await _highlightText(opts.text);
    } catch (e) {
        console.error('[Reader] PDF load failed:', e);
        showToast('PDF 加载失败');
    }
}

async function _renderPage(pageNum) {
    if (!state.pdfDoc) return;
    if (state.isRendering) {
        state.renderPending = pageNum;
        return;
    }
    state.isRendering = true;
    state.currentPage = pageNum;
    if (pageInput) pageInput.value = pageNum;

    try {
        const page = await state.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });

        // Canvas 渲染
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;

        // TextLayer（文字选择 + 高亮）
        textLayerDiv.innerHTML = '';
        textLayerDiv.style.width = viewport.width + 'px';
        textLayerDiv.style.height = viewport.height + 'px';

        const textContent = await page.getTextContent();
        const pdfjsLib = window.pdfjsLib;
        if (pdfjsLib.renderTextLayer) {
            // PDF.js v4.x API
            const renderTask = pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
            });
            if (renderTask && renderTask.promise) {
                await renderTask.promise;
            } else if (renderTask && typeof renderTask.then === 'function') {
                await renderTask;
            }
        }
    } finally {
        state.isRendering = false;
        if (state.renderPending !== false) {
            const pending = state.renderPending;
            state.renderPending = false;
            await _renderPage(pending);
        }
    }
}

function _changePage(delta) {
    if (state.fileType !== 'pdf') return;
    const next = state.currentPage + delta;
    if (next >= 1 && next <= state.totalPages) _renderPage(next);
}

async function _gotoPageAndHighlight(page, text) {
    if (state.fileType !== 'pdf') return;
    if (page && page !== state.currentPage) await _renderPage(page);
    if (text) await _highlightText(text);
}

async function _highlightText(searchText) {
    if (!searchText || !state.pdfDoc) return;
    // 清除旧高亮
    textLayerDiv.querySelectorAll('.reader-highlight').forEach(el => el.classList.remove('reader-highlight'));

    // 在当前页 TextLayer 中查找匹配文字并高亮
    const spans = textLayerDiv.querySelectorAll('span');
    const needle = searchText.trim().slice(0, 60).toLowerCase(); // 取前 60 字符做匹配

    let accumulated = '';
    let matchStart = null;
    const toHighlight = [];

    for (const span of spans) {
        const spanText = (span.textContent || '').toLowerCase();
        accumulated += spanText;
        if (matchStart === null && accumulated.includes(needle.slice(0, 10))) {
            matchStart = span;
        }
        if (matchStart && accumulated.includes(needle)) {
            toHighlight.push(span);
            break;
        }
        if (matchStart) toHighlight.push(span);
    }

    // 简单方案：对包含搜索词首段的 span 添加高亮样式
    for (const span of spans) {
        if (span.textContent && needle && span.textContent.toLowerCase().includes(needle.slice(0, 20))) {
            span.classList.add('reader-highlight');
            span.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        }
    }
}

// ─── Word 文档加载 ────────────────────────────────────────────────────────

async function _loadWord(docId) {
    if (canvas) canvas.style.display = 'none';
    if (textLayerDiv) textLayerDiv.style.display = 'none';
    if (mdContentEl) mdContentEl.style.display = 'block';
    toolbar?.classList.add('word-mode');

    const res = await api.documents.getMd(docId);
    if (!res || !res.ok) {
        if (mdContentEl) mdContentEl.innerHTML = '<p class="reader-error">无法加载文档内容</p>';
        return;
    }
    const data = await res.json();
    state.mdContent = data.md || '';

    // 用全局 marked 渲染（与笔记保持一致）
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        mdContentEl.innerHTML = DOMPurify.sanitize(marked.parse(state.mdContent));
    } else {
        // 降级：纯文本
        mdContentEl.textContent = state.mdContent;
    }
}

// ─── 文字选中浮动工具栏 ───────────────────────────────────────────────────

function _bindSelectionToolbar() {
    if (!floatBar) return;

    // 监听选中事件
    const pdfWrapper = document.getElementById('readerPdfWrapper');
    const wordWrapper = document.getElementById('readerMdContent');

    [pdfWrapper, wordWrapper].forEach(wrapper => {
        if (!wrapper) return;
        wrapper.addEventListener('mouseup', _handleSelection);
        wrapper.addEventListener('touchend', _handleSelection);
    });

    // 点击空白隐藏
    document.addEventListener('mousedown', (e) => {
        if (!floatBar.contains(e.target) && e.target !== floatBar) {
            _hideFloatBar();
        }
    });

    // 引用按钮
    document.getElementById('readerBtnQuote')?.addEventListener('click', () => {
        _insertQuote();
        _hideFloatBar();
    });

    // AI 解释按钮
    document.getElementById('readerBtnAI')?.addEventListener('click', () => {
        _aiExplain();
        _hideFloatBar();
    });
}

function _handleSelection(e) {
    setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2) {
            _hideFloatBar();
            return;
        }
        _showFloatBar(e, text);
    }, 10);
}

function _showFloatBar(e, text) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    floatBar.dataset.selectedText = text;
    floatBar.style.display = 'flex';

    // 定位在选区上方
    const top = rect.top - panelRect.top - floatBar.offsetHeight - 8;
    const left = rect.left - panelRect.left + (rect.width / 2) - (floatBar.offsetWidth / 2);

    floatBar.style.top = Math.max(8, top) + 'px';
    floatBar.style.left = Math.max(8, left) + 'px';
}

function _hideFloatBar() {
    if (floatBar) floatBar.style.display = 'none';
}

// ─── 引用插入 ─────────────────────────────────────────────────────────────

function _insertQuote() {
    const text = floatBar?.dataset.selectedText || '';
    if (!text) return;

    const meta = state.docMeta;
    const docId = state.docId;
    const page = state.fileType === 'pdf' ? state.currentPage : null;
    const filename = meta?.original_filename || '文档';

    // 生成引用 Markdown
    // 格式：标准 blockquote + 可点击的来源标注
    const lines = text.split('\n').map(l => '> ' + l).join('\n');
    const pageStr = page ? `第${page}页` : '';
    const anchor = `#doc:${docId}${page ? ':' + page : ''}`;
    const citation = `>\n> *—— [《${filename}》${pageStr}](${anchor})*`;
    const markdown = `${lines}\n${citation}\n\n`;

    // 插入到活动编辑器
    _insertToEditor(markdown);
    showToast('已插入引用');
}

async function _aiExplain() {
    const text = floatBar?.dataset.selectedText || '';
    if (!text) return;

    const filename = state.docMeta?.original_filename || '文档';
    showToast('AI 解释中...', 2000);

    try {
        const response = await api.ai.stream({
            action: 'custom',
            content: text,
            prompt: `请简洁解释以下来自《${filename}》的段落，用中文回答，不超过150字：\n\n${text}`
        });

        if (!response || !response.body) {
            showToast('AI 服务暂不可用');
            return;
        }

        let explanation = '';
        const reader2 = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            explanation += decoder.decode(value, { stream: true });
        }

        // 将引用 + AI 解释一起插入编辑器
        const meta = state.docMeta;
        const page = state.fileType === 'pdf' ? state.currentPage : null;
        const lines = text.split('\n').map(l => '> ' + l).join('\n');
        const pageStr = page ? `第${page}页` : '';
        const anchor = `#doc:${state.docId}${page ? ':' + page : ''}`;
        const citation = `>\n> *—— [《${meta?.original_filename || '文档'}》${pageStr}](${anchor})*`;
        const aiBlock = `\n**AI 解读：** ${explanation.trim()}\n`;
        const markdown = `${lines}\n${citation}\n${aiBlock}\n`;

        _insertToEditor(markdown);
        showToast('已插入引用与 AI 解读');
    } catch (e) {
        console.error('[Reader] AI explain failed:', e);
        showToast('AI 解释失败');
    }
}

function _insertToEditor(text) {
    // 优先插入到当前活动的 textarea
    const textarea = document.getElementById('noteContent') ||
                     document.querySelector('.inline-editor textarea');
    if (!textarea) {
        showToast('请先打开或选择一篇笔记');
        return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);

    // 确保引用前有空行
    const prefix = before.length > 0 && !before.endsWith('\n\n') ? '\n\n' : '';
    textarea.value = before + prefix + text + after;
    textarea.selectionStart = textarea.selectionEnd = start + prefix.length + text.length;

    // 触发 input 事件，让编辑器的自动保存等功能感知到变更
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

// ─── 文档上传（供 editor 斜杠命令调用）────────────────────────────────────

export async function uploadAndOpenDocument(file, noteId) {
    showToast('正在上传文档...', 3000);
    const res = await api.documents.upload(file, noteId);
    if (!res || !res.ok) {
        showToast('上传失败');
        return null;
    }
    const doc = await res.json();
    showToast(doc.ai_summary ? `已上传：${doc.ai_summary.slice(0, 30)}…` : '文档上传成功');

    // 如果有 AI 摘要，插入笔记
    if (doc.ai_summary && noteId) {
        const textarea = document.getElementById('noteContent');
        if (textarea && !textarea.value.trim()) {
            textarea.value = `**${doc.original_filename}**\n\n${doc.ai_summary}\n\n`;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    await reader.open(doc.id, noteId);
    return doc;
}
