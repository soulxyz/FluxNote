/**
 * reader.js — 文档阅读面板
 *
 * 功能：
 *   1. 右侧滑出式阅读面板
 *   2. PDF 阅读（PDF.js）：渲染、翻页、缩放、文字层
 *   3. Word 阅读：后端转 Markdown，渲染显示
 *   4. 文字选中 → 浮动工具栏 → 颜色高亮 / 引用 / AI 解释
 *   5. 高亮批注持久化（保存到数据库，重新打开时恢复）
 *   6. 批注列表面板（查看 / 跳转 / 编辑备注 / 删除）
 *   7. doc:navigate 事件 → 跳页 + 引用回溯高亮
 */

import { api } from './api.js';
import { showToast } from './utils.js';

// ─── 状态 ─────────────────────────────────────────────────────────────────

const state = {
    isOpen: false,
    docId: null,
    docMeta: null,
    fileType: null,         // 'pdf' | 'docx'
    pdfDoc: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.4,
    isRendering: false,
    renderPending: null,
    pdfjsLoaded: false,
    mdContent: null,
    activeNoteId: null,
    annotations: [],
    annPanelOpen: false,
};

// ─── DOM 引用（懒初始化）─────────────────────────────────────────────────

let panel, overlay, canvas, ctx, textLayerDiv, pageInput, totalPagesEl,
    scaleSelect, mdContentEl, toolbar, floatBar, annPanel, annList;

function initDom() {
    panel        = document.getElementById('readerPanel');
    overlay      = document.getElementById('readerOverlay');
    canvas       = document.getElementById('readerCanvas');
    textLayerDiv = document.getElementById('readerTextLayer');
    pageInput    = document.getElementById('readerPageInput');
    totalPagesEl = document.getElementById('readerTotalPages');
    scaleSelect  = document.getElementById('readerScale');
    mdContentEl  = document.getElementById('readerMdContent');
    toolbar      = document.getElementById('readerToolbar');
    floatBar     = document.getElementById('readerFloatBar');
    annPanel     = document.getElementById('readerAnnPanel');
    annList      = document.getElementById('readerAnnList');

    if (canvas) ctx = canvas.getContext('2d');
}

// ─── PDF.js 获取 ─────────────────────────────────────────────────────────

let pdfjsLib = null;

async function getPdfjsLib() {
    if (pdfjsLib) {
        return pdfjsLib;
    }

    // 备用CDN列表
    const cdnOptions = [
        {
            module: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs',
            worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
            umd: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.js',
            umdWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.js'
        },
        {
            module: 'https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.min.mjs',
            worker: 'https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs',
            umd: 'https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.min.js',
            umdWorker: 'https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.min.js'
        }
    ];

    // 尝试ES模块导入
    for (const cdn of cdnOptions) {
        try {
            console.log('[Reader] 尝试加载PDF.js ES模块:', cdn.module);
            
            // 检查是否已经有全局变量
            if (window.pdfjsLib) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = cdn.worker;
                pdfjsLib = window.pdfjsLib;
                return pdfjsLib;
            }

            // 尝试ES模块导入
            pdfjsLib = await import(cdn.module);
            pdfjsLib.GlobalWorkerOptions.workerSrc = cdn.worker;
            
            console.log('[Reader] PDF.js ES模块加载成功');
            return pdfjsLib;
        } catch (error) {
            console.warn('[Reader] ES模块导入失败:', cdn.module, error);
            continue;
        }
    }

    // 如果ES模块都失败了，尝试UMD版本
    for (const cdn of cdnOptions) {
        try {
            console.log('[Reader] 尝试加载PDF.js UMD版本:', cdn.umd);
            
            pdfjsLib = await new Promise((resolve, reject) => {
                // 检查是否已经有全局变量
                if (window.pdfjsLib) {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = cdn.umdWorker;
                    resolve(window.pdfjsLib);
                    return;
                }

                const script = document.createElement('script');
                script.src = cdn.umd;
                script.onload = () => {
                    if (window.pdfjsLib) {
                        window.pdfjsLib.GlobalWorkerOptions.workerSrc = cdn.umdWorker;
                        resolve(window.pdfjsLib);
                    } else {
                        reject(new Error('PDF.js UMD版本加载后全局变量不存在'));
                    }
                };
                script.onerror = () => reject(new Error('PDF.js UMD脚本加载失败'));
                document.head.appendChild(script);
            });

            console.log('[Reader] PDF.js UMD版本加载成功');
            return pdfjsLib;
        } catch (error) {
            console.warn('[Reader] UMD版本加载失败:', cdn.umd, error);
            continue;
        }
    }

    throw new Error('所有PDF.js加载方案都失败了，请检查网络连接或尝试刷新页面');
}

// ─── 公开 API ─────────────────────────────────────────────────────────────

export const reader = {
    init() {
        initDom();
        if (!panel) return;

        _bindPanelControls();
        _bindSelectionToolbar();
        _bindKeyboard();
        _bindAnnotationListEvents();

        window.addEventListener('doc:navigate', (e) => {
            const { docId, page, text } = e.detail || {};
            if (!docId) return;
            if (state.docId === docId && state.isOpen) {
                _gotoPageAndHighlight(page, text);
            } else {
                reader.open(docId, null, { page, text });
            }
        });

        window.addEventListener('note:activated', (e) => {
            state.activeNoteId = e.detail?.noteId || null;
        });
    },

    async open(docId, noteId = null, opts = {}) {
        if (!panel) initDom();
        if (!panel) return;

        state.activeNoteId = noteId || state.activeNoteId;

        if (state.isOpen && state.docId === docId) {
            if (opts.page || opts.text) await _gotoPageAndHighlight(opts.page, opts.text);
            return;
        }

        _showPanel();

        state.docId      = docId;
        state.pdfDoc     = null;
        state.mdContent  = null;
        state.annotations = [];
        state.currentPage = opts.page || 1;

        _setLoading(true);

        const res = await api.documents.get(docId);
        if (!res || !res.ok) { _setLoading(false); return; }
        const meta = await res.json();
        state.docMeta  = meta;
        state.fileType = meta.file_type;

        const titleEl = document.getElementById('readerDocTitle');
        if (titleEl) titleEl.textContent = meta.original_filename;

        await _loadAllAnnotations(docId);

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

    setActiveNote(noteId) {
        state.activeNoteId = noteId;
    }
};

// ─── 批注缓存 ─────────────────────────────────────────────────────────────

async function _loadAllAnnotations(docId) {
    try {
        const res = await api.documents.getAnnotations(docId);
        if (res && res.ok) {
            state.annotations = await res.json();
        }
    } catch (e) {
        console.warn('[Reader] 批注加载失败', e);
    }
}

// ─── 面板控制 ─────────────────────────────────────────────────────────────

function _showPanel() {
    state.isOpen = true;
    panel.classList.add('open');
    document.body.classList.add('reader-open');
    if (overlay) overlay.style.display = 'block';
}

function _hidePanel() {
    state.isOpen = false;
    panel.classList.remove('open');
    document.body.classList.remove('reader-open');
    if (overlay) overlay.style.display = 'none';
    _hideFloatBar();
    if (state.pdfDoc) {
        state.pdfDoc.destroy();
        state.pdfDoc = null;
    }
    if (annPanel) annPanel.style.display = 'none';
    state.annPanelOpen = false;
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
    document.getElementById('readerCloseBtn')?.addEventListener('click', () => reader.close());
    overlay?.addEventListener('click', () => reader.close());
    document.getElementById('readerPrevBtn')?.addEventListener('click', () => _changePage(-1));
    document.getElementById('readerNextBtn')?.addEventListener('click', () => _changePage(1));

    pageInput?.addEventListener('change', () => {
        const p = parseInt(pageInput.value);
        if (p >= 1 && p <= state.totalPages) _gotoPageAndHighlight(p);
    });

    scaleSelect?.addEventListener('change', () => {
        state.scale = parseFloat(scaleSelect.value);
        _renderPage(state.currentPage);
    });

    document.getElementById('readerFullscreenBtn')?.addEventListener('click', () => {
        panel.classList.toggle('fullscreen');
    });

    document.getElementById('readerAnnToggleBtn')?.addEventListener('click', () => {
        state.annPanelOpen = !state.annPanelOpen;
        if (annPanel) {
            annPanel.style.display = state.annPanelOpen ? 'flex' : 'none';
        }
        if (state.annPanelOpen) {
            _refreshAnnotationPanel();
        }
    });

    document.getElementById('readerAnnClose')?.addEventListener('click', () => {
        state.annPanelOpen = false;
        if (annPanel) annPanel.style.display = 'none';
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
    try {
        const pdfjsLib = await getPdfjsLib();
        const fileUrl = `/api/documents/${docId}/file`;
        
        const pdfDoc = await pdfjsLib.getDocument(fileUrl).promise;
        state.pdfDoc      = pdfDoc;
        state.totalPages  = pdfDoc.numPages;
        state.currentPage = opts.page || 1;

        if (canvas) canvas.style.display = 'block';
        if (textLayerDiv) textLayerDiv.style.display = 'block';
        if (mdContentEl) mdContentEl.style.display = 'none';
        toolbar?.classList.remove('word-mode');
        if (totalPagesEl) totalPagesEl.textContent = state.totalPages;

        await _renderPage(state.currentPage);
        if (opts.text) await _highlightText(opts.text);
    } catch (e) {
        console.error('[Reader] PDF 加载失败:', e);
        
        // 显示详细的错误信息
        let errorMsg = 'PDF 加载失败';
        if (e.message.includes('PDF.js')) {
            errorMsg = 'PDF.js 库加载失败，请检查网络连接或尝试刷新页面';
        } else if (e.message.includes('网络')) {
            errorMsg = '网络连接失败，请检查网络设置';
        } else if (e.message.includes('文件')) {
            errorMsg = 'PDF 文件损坏或格式不支持';
        }
        
        showToast(errorMsg, 5000);
        
        // 在阅读器中显示错误信息
        if (mdContentEl) {
            mdContentEl.style.display = 'block';
            mdContentEl.innerHTML = `
                <div class="reader-error">
                    <i class="fas fa-exclamation-triangle"></i>
                    <h3>PDF 加载失败</h3>
                    <p>${errorMsg}</p>
                    <p>请尝试以下解决方案：</p>
                    <ul>
                        <li>刷新页面重试</li>
                        <li>检查网络连接</li>
                        <li>如果问题持续存在，请联系管理员</li>
                    </ul>
                </div>
            `;
        }
    }
}

async function _renderPage(pageNum) {
    if (!state.pdfDoc) return;
    if (state.isRendering) {
        state.renderPending = pageNum;
        return;
    }
    state.isRendering  = true;
    state.currentPage  = pageNum;
    if (pageInput) pageInput.value = pageNum;

    try {
        const page     = await state.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });

        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;

        textLayerDiv.innerHTML = '';
        textLayerDiv.style.width  = viewport.width  + 'px';
        textLayerDiv.style.height = viewport.height + 'px';

        const textContent = await page.getTextContent();
        if (pdfjsLib && pdfjsLib.renderTextLayer) {
            const task = pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
            });
            if (task && task.promise) await task.promise;
            else if (task && typeof task.then === 'function') await task;
        }

        _applyPageAnnotations(pageNum);
    } finally {
        state.isRendering = false;
        if (state.renderPending !== null) {
            const pending = state.renderPending;
            state.renderPending = null;
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
    if (state.fileType === 'pdf') {
        if (page && page !== state.currentPage) await _renderPage(page);
        if (text) await _highlightText(text);
    } else {
        if (text) _highlightWordText(text);
    }
}

// ─── 批注高亮渲染（PDF TextLayer）────────────────────────────────────────

function _applyPageAnnotations(pageNum) {
    if (!textLayerDiv) return;
    const pageAnnotations = state.annotations.filter(a => a.page === pageNum);
    if (!pageAnnotations.length) return;

    const spans = Array.from(textLayerDiv.querySelectorAll('span'));

    for (const ann of pageAnnotations) {
        const needle = (ann.selected_text || '').trim().toLowerCase();
        if (!needle) continue;

        const matchLen = Math.min(40, needle.length);
        const searchStr = needle.slice(0, matchLen);

        for (const span of spans) {
            const spanText = (span.textContent || '').toLowerCase();
            if (spanText.includes(searchStr) || searchStr.includes(spanText.trim())) {
                span.classList.add('ann-highlight', `ann-${ann.color}`);
                span.dataset.annId = ann.id;
                if (ann.ann_note) span.title = ann.ann_note;
                break;
            }
        }
    }
}

// ─── 批注高亮渲染（Word HTML）────────────────────────────────────────────

function _applyWordAnnotations() {
    if (!mdContentEl) return;
    const wordAnns = state.annotations.filter(a => !a.page);
    if (!wordAnns.length) return;

    for (const ann of wordAnns) {
        const needle = (ann.selected_text || '').trim();
        if (!needle) continue;

        const walker = document.createTreeWalker(mdContentEl, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
            const idx = node.textContent.indexOf(needle.slice(0, Math.min(50, needle.length)));
            if (idx === -1) continue;

            const mark = document.createElement('mark');
            mark.className = `ann-highlight ann-${ann.color} ann-word-mark`;
            mark.dataset.annId = ann.id;
            if (ann.ann_note) mark.title = ann.ann_note;

            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, Math.min(node.textContent.length, idx + needle.length));
            range.surroundContents(mark);
            break;
        }
    }
}

/**
 * 引用回溯高亮（临时，不持久化）
 */
async function _highlightText(searchText) {
    if (!searchText || !state.pdfDoc) return;
    textLayerDiv.querySelectorAll('.reader-nav-highlight').forEach(el => el.classList.remove('reader-nav-highlight'));

    const needle = searchText.trim().slice(0, 60).toLowerCase();
    const spans  = textLayerDiv.querySelectorAll('span');
    const matchLen = Math.min(30, needle.length);

    for (const span of spans) {
        if (span.textContent && span.textContent.toLowerCase().includes(needle.slice(0, matchLen))) {
            span.classList.add('reader-nav-highlight');
            span.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
        }
    }
}

function _highlightWordText(searchText) {
    if (!searchText || !mdContentEl) return;

    mdContentEl.querySelectorAll('.reader-nav-highlight-word').forEach(el => {
        const parent = el.parentNode;
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
    });

    const needle = searchText.trim();
    if (!needle) return;

    const walker = document.createTreeWalker(mdContentEl, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(needle.slice(0, Math.min(50, needle.length)));
        if (idx === -1) continue;

        const mark = document.createElement('mark');
        mark.className = 'reader-nav-highlight-word';
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, Math.min(node.textContent.length, idx + needle.length));
        range.surroundContents(mark);
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
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

    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        mdContentEl.innerHTML = DOMPurify.sanitize(marked.parse(state.mdContent));
    } else {
        mdContentEl.textContent = state.mdContent;
    }

    _applyWordAnnotations();
}

// ─── 文字选中浮动工具栏 ───────────────────────────────────────────────────

function _bindSelectionToolbar() {
    if (!floatBar) return;

    const pdfWrapper  = document.getElementById('readerPdfWrapper');
    const wordWrapper = document.getElementById('readerMdContent');

    [pdfWrapper, wordWrapper].forEach(wrapper => {
        if (!wrapper) return;
        wrapper.addEventListener('mouseup', _handleSelection);
        wrapper.addEventListener('touchend', _handleSelection);
    });

    document.addEventListener('mousedown', (e) => {
        if (floatBar && !floatBar.contains(e.target)) {
            _hideFloatBar();
        }
    });

    floatBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.reader-color-btn');
        if (btn) {
            const color = btn.dataset.color;
            _saveHighlight(color);
            _hideFloatBar();
        }
    });

    document.getElementById('readerBtnQuote')?.addEventListener('click', () => {
        _insertQuote();
        _hideFloatBar();
    });

    document.getElementById('readerBtnAI')?.addEventListener('click', () => {
        _aiExplain();
        _hideFloatBar();
    });

    document.getElementById('readerBtnAddNote')?.addEventListener('click', () => {
        _addAnnotationNote();
        _hideFloatBar();
    });
}

function _handleSelection(e) {
    setTimeout(() => {
        const sel  = window.getSelection();
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

    const range     = sel.getRangeAt(0);
    const rect      = range.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    floatBar.dataset.selectedText = text;
    floatBar.style.display = 'flex';

    const top  = rect.top - panelRect.top - floatBar.offsetHeight - 8;
    const left = rect.left - panelRect.left + (rect.width / 2) - (floatBar.offsetWidth / 2);

    floatBar.style.top  = Math.max(8, top)  + 'px';
    floatBar.style.left = Math.max(8, left) + 'px';
}

function _hideFloatBar() {
    if (floatBar) floatBar.style.display = 'none';
}

// ─── 高亮批注保存 ─────────────────────────────────────────────────────────

async function _saveHighlight(color) {
    const text = floatBar?.dataset.selectedText || '';
    if (!text || !state.docId) return;

    const payload = {
        selected_text: text,
        color,
        page: state.fileType === 'pdf' ? state.currentPage : null,
        note_id: state.activeNoteId || null,
    };

    try {
        const res = await api.documents.createAnnotation(state.docId, payload);
        if (!res || !res.ok) { showToast('批注保存失败'); return; }
        const ann = await res.json();
        state.annotations.push(ann);

        if (state.fileType === 'pdf' && textLayerDiv) {
            _applyPageAnnotations(state.currentPage);
        } else if (state.fileType !== 'pdf' && mdContentEl) {
            _applyWordAnnotations();
        }

        showToast('高亮已保存');

        if (state.annPanelOpen) _refreshAnnotationPanel();
    } catch (e) {
        console.error('[Reader] 保存批注失败', e);
        showToast('批注保存失败');
    }
}

async function _addAnnotationNote() {
    const text = floatBar?.dataset.selectedText || '';
    if (!text || !state.docId) return;

    const noteText = prompt('为选中内容添加批注备注：');
    if (noteText === null) return;

    const payload = {
        selected_text: text,
        color: 'yellow',
        page: state.fileType === 'pdf' ? state.currentPage : null,
        note_id: state.activeNoteId || null,
        ann_note: noteText,
    };

    try {
        const res = await api.documents.createAnnotation(state.docId, payload);
        if (!res || !res.ok) { showToast('批注保存失败'); return; }
        const ann = await res.json();
        state.annotations.push(ann);

        if (state.fileType === 'pdf' && textLayerDiv) {
            _applyPageAnnotations(state.currentPage);
        } else if (state.fileType !== 'pdf' && mdContentEl) {
            _applyWordAnnotations();
        }

        showToast('批注已保存');
        if (state.annPanelOpen) _refreshAnnotationPanel();
    } catch (e) {
        console.error('[Reader] 保存批注失败', e);
        showToast('批注保存失败');
    }
}

// ─── 批注列表面板 ─────────────────────────────────────────────────────────

function _bindAnnotationListEvents() {
    if (!annList) return;

    annList.addEventListener('click', async (e) => {
        const deleteBtn = e.target.closest('.ann-delete-btn');
        if (deleteBtn) {
            e.stopPropagation();
            const annId = deleteBtn.dataset.annId;
            if (!confirm('确定删除这条批注？')) return;
            await _deleteAnnotation(annId);
            return;
        }

        const editBtn = e.target.closest('.ann-edit-btn');
        if (editBtn) {
            e.stopPropagation();
            const annId = editBtn.dataset.annId;
            _editAnnotationNote(annId);
            return;
        }

        const item = e.target.closest('.ann-item');
        if (item) {
            const annId = item.dataset.annId;
            const ann = state.annotations.find(a => a.id === annId);
            if (ann) {
                _gotoPageAndHighlight(ann.page, (ann.selected_text || '').slice(0, 40));
            }
        }
    });
}

function _refreshAnnotationPanel() {
    if (!annList) return;
    annList.innerHTML = '';

    if (!state.annotations.length) {
        annList.innerHTML = '<p class="ann-empty">暂无批注</p>';
        return;
    }

    const sorted = [...state.annotations].sort((a, b) => (a.page || 0) - (b.page || 0));

    for (const ann of sorted) {
        const item = document.createElement('div');
        item.className = 'ann-item';
        item.dataset.annId = ann.id;

        const colorDot = `<span class="ann-dot ann-${ann.color}"></span>`;
        const pageStr  = ann.page ? `第 ${ann.page} 页` : 'Word';
        const preview  = (ann.selected_text || '').slice(0, 80);
        const noteHtml = ann.ann_note
            ? `<div class="ann-item-note"><i class="fas fa-sticky-note"></i> ${_escHtml(ann.ann_note)}</div>`
            : '';

        item.innerHTML = `
            <div class="ann-item-header">
                ${colorDot}
                <span class="ann-item-page">${pageStr}</span>
                <div class="ann-item-actions">
                    <button class="ann-edit-btn" data-ann-id="${ann.id}" title="编辑备注"><i class="fas fa-pen"></i></button>
                    <button class="ann-delete-btn" data-ann-id="${ann.id}" title="删除批注"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div>
            <div class="ann-item-text">${_escHtml(preview)}${(ann.selected_text || '').length > 80 ? '…' : ''}</div>
            ${noteHtml}
        `;

        annList.appendChild(item);
    }
}

async function _editAnnotationNote(annId) {
    const ann = state.annotations.find(a => a.id === annId);
    if (!ann) return;

    const newNote = prompt('编辑批注备注：', ann.ann_note || '');
    if (newNote === null) return;

    try {
        const res = await api.documents.updateAnnotation(annId, { ann_note: newNote });
        if (!res || !res.ok) { showToast('更新失败'); return; }
        const updated = await res.json();
        Object.assign(ann, updated);

        if (state.fileType === 'pdf' && textLayerDiv) {
            const el = textLayerDiv.querySelector(`[data-ann-id="${annId}"]`);
            if (el) el.title = newNote || '';
        }

        _refreshAnnotationPanel();
        showToast('备注已更新');
    } catch (e) {
        showToast('更新失败');
    }
}

async function _deleteAnnotation(annId) {
    try {
        const res = await api.documents.deleteAnnotation(annId);
        if (!res || !res.ok) { showToast('删除失败'); return; }
        state.annotations = state.annotations.filter(a => a.id !== annId);

        textLayerDiv?.querySelectorAll(`[data-ann-id="${annId}"]`).forEach(el => {
            el.classList.remove('ann-highlight', 'ann-yellow', 'ann-green', 'ann-pink', 'ann-blue');
            delete el.dataset.annId;
        });

        mdContentEl?.querySelectorAll(`mark[data-ann-id="${annId}"]`).forEach(el => {
            const parent = el.parentNode;
            parent.replaceChild(document.createTextNode(el.textContent), el);
            parent.normalize();
        });

        _refreshAnnotationPanel();
        showToast('批注已删除');
    } catch (e) {
        showToast('删除失败');
    }
}

function _escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── 引用插入 ─────────────────────────────────────────────────────────────

function _insertQuote() {
    const text = floatBar?.dataset.selectedText || '';
    if (!text) return;

    const meta     = state.docMeta;
    const page     = state.fileType === 'pdf' ? state.currentPage : null;
    const filename = meta?.original_filename || '文档';
    const lines    = text.split('\n').map(l => '> ' + l).join('\n');
    const pageStr  = page ? `第${page}页` : '';
    const anchor   = `#doc:${state.docId}${page ? ':' + page : ''}`;
    const citation = `>\n> *—— [《${filename}》${pageStr}](${anchor})*`;
    const markdown = `${lines}\n${citation}\n\n`;

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

        if (!response || !response.body) { showToast('AI 服务暂不可用'); return; }

        let explanation = '';
        const reader2  = response.body.getReader();
        const decoder  = new TextDecoder();
        while (true) {
            const { done, value } = await reader2.read();
            if (done) break;
            explanation += decoder.decode(value, { stream: true });
        }

        const page     = state.fileType === 'pdf' ? state.currentPage : null;
        const lines    = text.split('\n').map(l => '> ' + l).join('\n');
        const pageStr  = page ? `第${page}页` : '';
        const anchor   = `#doc:${state.docId}${page ? ':' + page : ''}`;
        const citation = `>\n> *—— [《${state.docMeta?.original_filename || '文档'}》${pageStr}](${anchor})*`;
        const aiBlock  = `\n**AI 解读：** ${explanation.trim()}\n`;
        const markdown = `${lines}\n${citation}\n${aiBlock}\n`;

        _insertToEditor(markdown);
        showToast('已插入引用与 AI 解读');
    } catch (e) {
        console.error('[Reader] AI explain 失败:', e);
        showToast('AI 解释失败');
    }
}

function _insertToEditor(text) {
    const textarea = document.getElementById('noteContent') ||
                     document.querySelector('.inline-editor textarea');
    if (!textarea) {
        showToast('请先打开或选择一篇笔记');
        return;
    }

    const start  = textarea.selectionStart;
    const end    = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after  = textarea.value.slice(end);
    const prefix = before.length > 0 && !before.endsWith('\n\n') ? '\n\n' : '';

    textarea.value = before + prefix + text + after;
    textarea.selectionStart = textarea.selectionEnd = start + prefix.length + text.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

// ─── 文档上传（供 editor.js 等模块调用）──────────────────────────────────

export async function uploadAndOpenDocument(file, noteId) {
    showToast('正在上传文档...', 3000);
    const res = await api.documents.upload(file, noteId);
    if (!res || !res.ok) {
        showToast('上传失败');
        return null;
    }
    const doc = await res.json();
    showToast(doc.ai_summary ? `已上传：${doc.ai_summary.slice(0, 30)}…` : '文档上传成功');

    if (doc.ai_summary && noteId) {
        const textarea = document.getElementById('noteContent');
        if (textarea && !textarea.value.trim()) {
            textarea.value = `**${doc.original_filename}**\n\n${doc.ai_summary}\n\n`;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // 触发自定义事件，通知编辑器更新附件列表
    window.dispatchEvent(new CustomEvent('document:uploaded', { 
        detail: { doc, noteId } 
    }));

    await reader.open(doc.id, noteId);
    return doc;
}

/**
 * 触发文件选择并上传文档（统一入口，供 editor 各处调用）
 */
export function triggerDocUpload(noteId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.doc';
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        await uploadAndOpenDocument(file, noteId || window.__currentNoteId || null);
    };
    input.click();
}
