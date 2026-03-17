/**
 * reader.js — 文档阅读面板
 *
 * 功能：
 *   1. 右侧滑出式阅读面板（宽度 localStorage 持久化）
 *   2. PDF 阅读（PDF.js）：渲染、翻页、缩放、文字层（已配置 cMapUrl）
 *   3. Word 阅读：后端转 Markdown，渲染显示
 *   4. 文字选中 → 浮动工具栏 → 颜色高亮 / 引用 / AI 解释
 *   5. 高亮批注持久化（保存到数据库，重新打开时恢复）
 *   6. 批注列表面板（按颜色/页码筛选、查看 / 跳转 / 编辑备注 / 删除）
 *   7. doc:navigate 事件 → 跳页 + 引用回溯高亮
 *   8. 移动端自动全屏 + 左滑手势关闭
 *   9. 上传进度条指示
 */

import { api } from './api.js';
import { showToast } from './utils.js';

// ─── 自定义对话框（替代原生 prompt / confirm）──────────────────────────────

function _showDialog({ title, message, placeholder = '', defaultValue = '', type = 'confirm' }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'reader-dialog-overlay';

        const isPrompt = type === 'prompt';
        overlay.innerHTML = `
            <div class="reader-dialog-box">
                <div class="reader-dialog-title">${_escHtml(title)}</div>
                ${message ? `<div class="reader-dialog-message">${_escHtml(message)}</div>` : ''}
                ${isPrompt ? `<textarea class="reader-dialog-input" placeholder="${_escHtml(placeholder)}" rows="3">${_escHtml(defaultValue)}</textarea>` : ''}
                <div class="reader-dialog-actions">
                    <button class="reader-dialog-cancel">取消</button>
                    <button class="reader-dialog-confirm ${type === 'danger' ? 'danger' : ''}">${isPrompt ? '确定' : '确定'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const inputEl = overlay.querySelector('.reader-dialog-input');
        if (inputEl) {
            inputEl.focus();
            inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }

        const close = (value) => {
            overlay.classList.add('reader-dialog-closing');
            setTimeout(() => overlay.remove(), 200);
            resolve(value);
        };

        overlay.querySelector('.reader-dialog-cancel').onclick = () => close(null);
        overlay.querySelector('.reader-dialog-confirm').onclick = () => {
            close(isPrompt ? (inputEl?.value ?? '') : true);
        };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close(null);
            if (e.key === 'Enter' && !isPrompt) close(true);
        });
    });
}

function _readerConfirm(message, title = '确认') {
    return _showDialog({ title, message, type: 'danger' });
}

function _readerPrompt(title, defaultValue = '', placeholder = '') {
    return _showDialog({ title, placeholder, defaultValue, type: 'prompt' });
}

function _escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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
    scaleSelect, mdContentEl, toolbar, floatBar, annPanel, annList, resizer;

function initDom() {
    panel        = document.getElementById('readerPanel');
    overlay      = document.getElementById('readerOverlay');
    resizer      = document.getElementById('readerResizer');
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

    // 从 localStorage 恢复上次拖拽的宽度
    const savedWidth = localStorage.getItem('reader_panel_width');
    if (savedWidth) {
        document.documentElement.style.setProperty('--reader-width', savedWidth + 'px');
    }

    // 移动端：隐藏 resizer，使用全屏模式
    if (window.innerWidth <= 768) {
        if (resizer) resizer.style.display = 'none';
    }

    // 桌面端无级拖拽逻辑
    if (resizer && panel) {
        let isResizing = false;
        resizer.addEventListener('mousedown', () => {
            isResizing = true;
            document.body.classList.add('reader-dragging');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            let newWidth = window.innerWidth - e.clientX;
            const minWidth = 360;
            const maxWidth = Math.min(900, window.innerWidth * 0.7);
            newWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);
            document.documentElement.style.setProperty('--reader-width', newWidth + 'px');
        });

        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            document.body.classList.remove('reader-dragging');
            // 持久化宽度
            const currentWidth = getComputedStyle(document.documentElement)
                .getPropertyValue('--reader-width').trim().replace('px', '');
            if (currentWidth) localStorage.setItem('reader_panel_width', currentWidth);
        });
    }

    // 移动端左滑手势关闭
    _initTouchClose();
}

function _initTouchClose() {
    if (!panel) return;
    let touchStartX = 0;
    let touchStartY = 0;

    panel.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    panel.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
        // 水平向右滑动超过 80px 且竖向偏移 < 40px 则关闭
        if (dx > 80 && dy < 40) {
            reader.close();
        }
    }, { passive: true });
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
    },

    clearActiveNote() {
        state.activeNoteId = null;
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
    // 移动端自动全屏
    if (window.innerWidth <= 768) {
        panel.classList.add('fullscreen');
    }
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

    if (loading) {
        // 加载中：隐藏所有内容区域
        if (canvas) canvas.style.display = 'none';
        if (textLayerDiv) textLayerDiv.style.display = 'none';
        if (mdContentEl) mdContentEl.style.display = 'none';
    } else {
        // 加载完成：根据文件类型决定显示哪个区域
        const isPdf = state.fileType === 'pdf';
        if (canvas) canvas.style.display = isPdf ? 'block' : 'none';
        if (textLayerDiv) textLayerDiv.style.display = isPdf ? 'block' : 'none';
        if (mdContentEl) mdContentEl.style.display = isPdf ? 'none' : 'block';
    }
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

    // 鼠标滚轮翻页（仅 PDF 模式）
    let _wheelTimer = null;
    panel?.addEventListener('wheel', (e) => {
        if (!state.isOpen || state.fileType !== 'pdf') return;
        e.preventDefault();
        if (_wheelTimer) return;
        _wheelTimer = setTimeout(() => { _wheelTimer = null; }, 300);
        if (e.deltaY > 0) _changePage(1);
        else if (e.deltaY < 0) _changePage(-1);
    }, { passive: false });
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
        
        // 配置 PDF.js 加载参数
        const loadingTask = pdfjsLib.getDocument({
            url: fileUrl,
            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
            cMapPacked: true,
        });
        
        const pdfDoc = await loadingTask.promise;
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

        let errorMsg = '文档加载失败，请稍后重试或刷新页面';
        let errorTip = '如持续失败，可尝试下载后在本地打开。';

        if (e.message && e.message.includes('所有PDF.js加载方案')) {
            errorMsg = '渲染组件加载失败，可能是网络不稳定';
            errorTip = '请检查网络连接后刷新页面重试。';
        } else if (e.message && (e.message.includes('InvalidPDFException') || e.message.includes('MissingPDFException'))) {
            errorMsg = '文件格式有误或文件已损坏';
            errorTip = '请确认上传的是有效的 PDF 文件。';
        }

        showToast(errorMsg, 5000);

        if (mdContentEl) {
            mdContentEl.style.display = 'block';
            mdContentEl.innerHTML = `
                <div class="reader-error">
                    <i class="fas fa-file-exclamation"></i>
                    <h3>${_escHtml(errorMsg)}</h3>
                    <p>${_escHtml(errorTip)}</p>
                    <div style="margin-top:16px;">
                        <button class="reader-btn" onclick="location.reload()" style="padding:8px 16px;border-radius:8px;background:var(--primary);color:#fff;border:none;cursor:pointer;">
                            <i class="fas fa-redo"></i> 刷新重试
                        </button>
                    </div>
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

        // 清空文字层，设置原始尺寸
        textLayerDiv.innerHTML = '';
        textLayerDiv.style.width  = viewport.width  + 'px';
        textLayerDiv.style.height = viewport.height + 'px';
        // 重置文字层缩放（稍后重新计算）
        textLayerDiv.style.transform = '';

        const textContent = await page.getTextContent();
        console.log('[Reader] 文字层渲染 — renderTextLayer:', !!pdfjsLib?.renderTextLayer,
                    'TextLayer:', !!pdfjsLib?.TextLayer,
                    '文本项数:', textContent?.items?.length);

        // 兼容 PDF.js v4.x: 优先使用 renderTextLayer，回退到 TextLayer 类
        if (pdfjsLib && pdfjsLib.renderTextLayer) {
            const task = pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
            });
            if (task && task.promise) await task.promise;
            else if (task && typeof task.then === 'function') await task;
        } else if (pdfjsLib && pdfjsLib.TextLayer) {
            const textLayer = new pdfjsLib.TextLayer({
                textContentSource: textContent,
                container: textLayerDiv,
                viewport,
            });
            await textLayer.render();
        } else {
            console.warn('[Reader] PDF.js 无可用的文字层渲染接口（renderTextLayer / TextLayer），文字选择不可用');
        }

        console.log('[Reader] 文字层 span 数量:', textLayerDiv.querySelectorAll('span').length);

        // canvas 被 CSS max-width:100% 缩放后，文字层也需同步缩放
        // 使用 rAF 确保浏览器完成布局后再读取 clientWidth
        requestAnimationFrame(() => {
            _syncTextLayerScale(viewport);
        });

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

/**
 * 同步文字层缩放：当 canvas 被 CSS max-width 缩放时，
 * 文字层保持原始像素尺寸会导致文字定位偏移。
 * 通过 CSS transform 让文字层与 canvas 视觉尺寸一致。
 */
function _syncTextLayerScale(viewport) {
    if (!canvas || !textLayerDiv) return;
    const renderedWidth = canvas.clientWidth;
    if (renderedWidth <= 0 || viewport.width <= 0) return;

    const scaleFactor = renderedWidth / viewport.width;
    if (Math.abs(scaleFactor - 1) > 0.01) {
        // canvas 被缩放了，文字层也需要同步缩放
        textLayerDiv.style.transform = `scale(${scaleFactor})`;
        textLayerDiv.style.transformOrigin = '0 0';
        textLayerDiv.style.width  = viewport.width  + 'px';
        textLayerDiv.style.height = viewport.height + 'px';
    } else {
        textLayerDiv.style.transform = '';
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
    
    // 构建忽略空白字符的纯文本，以及字符到span的映射表
    let cleanText = '';
    const cleanToSpan = [];
    
    for (const span of spans) {
        const text = span.textContent || '';
        for (let i = 0; i < text.length; i++) {
            if (!/\s/.test(text[i])) {
                cleanText += text[i].toLowerCase();
                cleanToSpan.push(span);
            }
        }
    }

    for (const ann of pageAnnotations) {
        // 去除用户选中文本的所有空白符进行匹配
        const needle = (ann.selected_text || '').replace(/\s+/g, '').toLowerCase();
        if (!needle) continue;

        let matchIdx = cleanText.indexOf(needle);
        let matchLen = needle.length;

        // 如果长段落未能完全匹配，退而求其次取前20个字符匹配起止位置
        if (matchIdx === -1 && needle.length > 20) {
            const shortNeedle = needle.slice(0, 20);
            matchIdx = cleanText.indexOf(shortNeedle);
            matchLen = shortNeedle.length;
        }

        if (matchIdx !== -1) {
            const matchedSpans = new Set();
            for (let i = matchIdx; i < matchIdx + matchLen; i++) {
                if (cleanToSpan[i]) {
                    matchedSpans.add(cleanToSpan[i]);
                }
            }
            
            for (const span of matchedSpans) {
                span.classList.add('ann-highlight', `ann-${ann.color}`);
                span.dataset.annId = ann.id;
                if (ann.ann_note) span.title = ann.ann_note;
            }
        } else {
            console.warn('[Reader] PDF批注无法匹配块:', ann.selected_text);
        }
    }
}

// ─── 批注高亮渲染（Word HTML）────────────────────────────────────────────

function _applyWordAnnotations() {
    if (!mdContentEl) return;

    // 移除已有的批注标记，避免嵌套 mark
    mdContentEl.querySelectorAll('mark[data-ann-id], mark.ann-word-mark').forEach(el => {
        const parent = el.parentNode;
        if (parent) {
            while (el.firstChild) {
                parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            parent.normalize();
        }
    });

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
            
            try {
                range.surroundContents(mark);
            } catch (e) {
                console.warn('[Reader] surroundContents failed for annotation:', ann.id, e);
            }
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

    const spans = Array.from(textLayerDiv.querySelectorAll('span'));
    let cleanText = '';
    const cleanToSpan = [];
    
    for (const span of spans) {
        const text = span.textContent || '';
        for (let i = 0; i < text.length; i++) {
            if (!/\s/.test(text[i])) {
                cleanText += text[i].toLowerCase();
                cleanToSpan.push(span);
            }
        }
    }

    const needle = searchText.replace(/\s+/g, '').slice(0, 60).toLowerCase();
    const matchIdx = cleanText.indexOf(needle);

    if (matchIdx !== -1) {
        let targetSpan = null;
        for (let i = matchIdx; i < matchIdx + needle.length; i++) {
            if (cleanToSpan[i]) {
                cleanToSpan[i].classList.add('reader-nav-highlight');
                if (!targetSpan) targetSpan = cleanToSpan[i];
            }
        }
        if (targetSpan) {
            targetSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    document.getElementById('readerBtnCopy')?.addEventListener('click', async () => {
        const text = floatBar?.dataset.selectedText || '';
        if (text) {
            try {
                await navigator.clipboard.writeText(text);
                showToast('已复制到剪贴板');
            } catch (err) {
                console.error('[Reader] 复制失败:', err);
                showToast('复制失败，请手动复制');
            }
        }
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

    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
    const noteText = await _readerPrompt(`为"${preview}"添加批注备注`, '', '输入批注内容…');
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
            const ok = await _readerConfirm('确定删除这条批注？', '删除批注');
            if (!ok) return;
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
            const ann = state.annotations.find(a => String(a.id) === String(annId));
            if (ann) {
                _gotoPageAndHighlight(ann.page, (ann.selected_text || '').slice(0, 40));
            }
        }
    });
}

// 批注面板筛选状态
const _annFilter = { color: 'all', pageRange: 'all' };

function _renderAnnPanelFilter(container) {
    const colors = ['all', 'yellow', 'green', 'pink', 'blue'];
    const colorLabels = { all: '全部', yellow: '黄', green: '绿', pink: '粉', blue: '蓝' };

    let filterEl = container.querySelector('.ann-filter-bar');
    if (!filterEl) {
        filterEl = document.createElement('div');
        filterEl.className = 'ann-filter-bar';
        container.insertBefore(filterEl, container.querySelector('#readerAnnList') || container.firstChild);
    }

    filterEl.innerHTML = `
        <div class="ann-filter-colors">
            ${colors.map(c => `
                <button class="ann-filter-color-btn ${_annFilter.color === c ? 'active' : ''}" data-color="${c}" title="${colorLabels[c]}">
                    ${c === 'all' ? '全部' : `<span class="ann-dot ann-${c}"></span>`}
                </button>
            `).join('')}
        </div>
        <select class="ann-filter-page-select" title="按页码范围筛选">
            <option value="all" ${_annFilter.pageRange === 'all' ? 'selected' : ''}>全部页</option>
            <option value="current" ${_annFilter.pageRange === 'current' ? 'selected' : ''}>当前页</option>
            <option value="word" ${_annFilter.pageRange === 'word' ? 'selected' : ''}>Word 批注</option>
        </select>
    `;

    filterEl.querySelectorAll('.ann-filter-color-btn').forEach(btn => {
        btn.onclick = () => {
            _annFilter.color = btn.dataset.color;
            _refreshAnnotationPanel();
        };
    });
    filterEl.querySelector('.ann-filter-page-select').onchange = (e) => {
        _annFilter.pageRange = e.target.value;
        _refreshAnnotationPanel();
    };
}

function _refreshAnnotationPanel() {
    if (!annPanel || !annList) return;

    _renderAnnPanelFilter(annPanel);

    if (!state.annotations.length) {
        annList.innerHTML = '<p class="ann-empty">暂无批注</p>';
        return;
    }

    // 应用筛选
    let filtered = [...state.annotations];

    if (_annFilter.color !== 'all') {
        filtered = filtered.filter(a => a.color === _annFilter.color);
    }
    if (_annFilter.pageRange === 'current' && state.fileType === 'pdf') {
        filtered = filtered.filter(a => a.page === state.currentPage);
    } else if (_annFilter.pageRange === 'word') {
        filtered = filtered.filter(a => !a.page);
    }

    filtered.sort((a, b) => (a.page || 0) - (b.page || 0));

    if (!filtered.length) {
        annList.innerHTML = '<p class="ann-empty">没有符合筛选条件的批注</p>';
        return;
    }

    annList.innerHTML = '';
    for (const ann of filtered) {
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
    const ann = state.annotations.find(a => String(a.id) === String(annId));
    if (!ann) return;

    const newNote = await _readerPrompt('编辑批注备注', ann.ann_note || '', '输入批注内容…');
    if (newNote === null) return;

    try {
        const res = await api.documents.updateAnnotation(annId, { ann_note: newNote });
        if (!res || !res.ok) { showToast('更新失败'); return; }
        const updated = await res.json();
        Object.assign(ann, updated);

        if (state.fileType === 'pdf' && textLayerDiv) {
            textLayerDiv.querySelectorAll(`[data-ann-id="${annId}"]`).forEach(el => {
                el.title = newNote || '';
            });
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
        state.annotations = state.annotations.filter(a => String(a.id) !== String(annId));

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

// ─── 引用生成（公共工具）─────────────────────────────────────────────────

function _buildCitation(text, page) {
    const filename = state.docMeta?.original_filename || '文档';
    const lines    = text.split('\n').map(l => '> ' + l).join('\n');
    const pageStr  = page ? `第${page}页` : '';
    const anchor   = `#doc:${state.docId}${page ? ':' + page : ''}`;
    const citation = `>\n> *—— [《${filename}》${pageStr}](${anchor})*`;
    return { lines, citation };
}

// ─── 引用插入 ─────────────────────────────────────────────────────────────

function _insertQuote() {
    const text = floatBar?.dataset.selectedText || '';
    if (!text) return;

    const page = state.fileType === 'pdf' ? state.currentPage : null;
    const { lines, citation } = _buildCitation(text, page);
    _insertToEditor(`${lines}\n${citation}\n\n`);
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
        const streamReader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            explanation += decoder.decode(value, { stream: true });
        }

        const page = state.fileType === 'pdf' ? state.currentPage : null;
        const { lines, citation } = _buildCitation(text, page);
        const aiBlock = `\n**AI 解读：** ${explanation.trim()}\n`;
        _insertToEditor(`${lines}\n${citation}\n${aiBlock}\n`);
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

// ─── 上传进度条 UI ────────────────────────────────────────────────────────

function _showUploadProgress() {
    let bar = document.getElementById('readerUploadProgress');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'readerUploadProgress';
        bar.className = 'reader-upload-progress';
        bar.innerHTML = `
            <div class="reader-upload-inner">
                <i class="fas fa-file-upload"></i>
                <span class="reader-upload-label">正在上传文档…</span>
                <div class="reader-upload-bar-track"><div class="reader-upload-bar-fill" id="readerUploadFill"></div></div>
                <span class="reader-upload-pct" id="readerUploadPct">0%</span>
            </div>
        `;
        document.body.appendChild(bar);
    }
    bar.style.display = 'flex';
    _updateUploadProgress(0);
    return bar;
}

function _updateUploadProgress(pct) {
    const fill = document.getElementById('readerUploadFill');
    const pctEl = document.getElementById('readerUploadPct');
    if (fill) fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
}

function _hideUploadProgress() {
    const bar = document.getElementById('readerUploadProgress');
    if (bar) {
        _updateUploadProgress(100);
        setTimeout(() => { bar.style.display = 'none'; }, 600);
    }
}

function _uploadWithProgress(file, noteId) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('file', file);
        if (noteId) formData.append('note_id', noteId);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/documents/upload');

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                _updateUploadProgress(Math.round((e.loaded / e.total) * 90));
            }
        };

        xhr.onload = () => {
            _updateUploadProgress(100);
            if (xhr.status >= 200 && xhr.status < 300) {
                try { resolve(JSON.parse(xhr.responseText)); }
                catch { reject(new Error('响应解析失败')); }
            } else {
                let msg = '上传失败';
                try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
                reject(new Error(msg));
            }
        };

        xhr.onerror = () => reject(new Error('网络错误，上传失败'));
        xhr.send(formData);
    });
}

// ─── 文档上传（供 editor.js 等模块调用）──────────────────────────────────

export async function uploadAndOpenDocument(file, noteId) {
    _showUploadProgress();
    let doc;
    try {
        doc = await _uploadWithProgress(file, noteId);
    } catch (e) {
        _hideUploadProgress();
        showToast(e.message || '上传失败');
        return null;
    }
    _hideUploadProgress();
    showToast('文档上传成功，正在生成摘要...');

    // 触发自定义事件，通知编辑器更新附件列表
    window.dispatchEvent(new CustomEvent('document:uploaded', { 
        detail: { doc, noteId } 
    }));

    await reader.open(doc.id, noteId);

    // 获取对应的 textarea
    let textarea = null;
    if (!noteId) {
        // 新建笔记（主编辑器）
        textarea = document.getElementById('noteContent');
    } else {
        // 已有笔记，可能是主编辑器，也可能是行内编辑器
        textarea = document.getElementById('noteContent');
        if (window.__currentNoteId !== String(noteId)) {
            // 如果主编辑器当前编辑的不是这个 noteId，则尝试找行内编辑器
            const inlineContainer = document.querySelector(`.inline-editor-container[data-id="${noteId}"]`);
            if (inlineContainer) {
                textarea = inlineContainer.querySelector('textarea');
            } else {
                textarea = null;
            }
        }
    }

    if (textarea && !textarea.value.trim()) {
        textarea.value = `**${doc.original_filename}**\n\n`;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        
        try {
            const streamRes = await api.ai.stream({
                action: 'document_summary',
                doc_id: doc.id
            });
            
            if (!streamRes.ok) {
                console.error('[Reader] AI summary stream failed:', streamRes.status);
                showToast('无法生成AI摘要：' + (await streamRes.json().catch(() => {}))?.error || '请求错误');
                return doc;
            }
            
            if (streamRes.body) {
                const rdr = streamRes.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await rdr.read();
                    if (done) break;
                    let chunk = decoder.decode(value, { stream: true });
                    // 去掉可能包含在开头的 Error: 信息
                    if (chunk.startsWith('Error:')) {
                        console.error('AI Summary stream error:', chunk);
                        break;
                    }
                    if (chunk) {
                        textarea.value += chunk;
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
                textarea.value += '\n\n';
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (e) {
            console.error('[Reader] Failed to stream AI summary:', e);
            showToast('AI摘要生成失败');
        }
    }

    return doc;
}

/**
 * 触发文件选择并上传文档（统一入口，供 editor 各处调用）
 */
export function triggerDocUpload(noteId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx';
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        await uploadAndOpenDocument(file, noteId || null);
    };
    input.click();
}
