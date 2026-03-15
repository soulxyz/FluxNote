import { api } from './api.js';
import { state } from './state.js';
import { offlineStore } from './offline.js';
import { formatDate, escapeHtml, parseWikiLinks, showToast, sanitizeHtml } from './utils.js';
import { editor } from './editor.js';
import { loadMermaidIfNeeded } from '/static/js/markdown-renderer.js';

// Re-export needed functions if necessary or keep internal
// We will export functions to be called by main.js

export const ui = {
    renderSkeleton() {
        const list = document.getElementById('notesList');
        if (!list) return;
        // Avoid re-rendering if already showing skeleton to prevent flicker
        if (list.querySelector('.skeleton-card')) return;

        const skeletonItem = `
            <div class="note-card skeleton-card">
                <div class="skeleton-header" style="width: 30%;"></div>
                <div class="skeleton-content"></div>
                <div class="skeleton-content" style="width: 80%;"></div>
                <div class="skeleton-content" style="width: 60%;"></div>
            </div>
        `;
        list.innerHTML = skeletonItem.repeat(3);
    },

    renderNotes(notesToRender, reset = false) {
        const list = document.getElementById('notesList');
        if (!list) return;

        if (reset) list.innerHTML = '';

        if (notesToRender.length === 0 && state.notes.length === 0) {
            list.innerHTML = '<div class="empty-state" style="text-align:center; padding:40px; color:#999;">还没有笔记，记录下第一条吧</div>';
            return;
        }

        const fragment = document.createDocumentFragment();
        notesToRender.forEach((note, index) => {
            const card = this.createNoteCard(note);
            // Stagger animation: max delay 0.5s to prevent long waits for large lists
            const delay = Math.min(index * 0.05, 0.5);
            card.style.animationDelay = `${delay}s`;
            fragment.appendChild(card);
        });
        list.appendChild(fragment);

        // Load bilibili card metadata (title, cover)
        this._loadBilibiliCards(list);

        // Render Mermaid/Mindmap first to replace code blocks with divs
        this.renderMermaid(list);

        // Highlight only the code blocks that aren't diagrams
        if (window.hljs) {
            list.querySelectorAll('pre code').forEach(block => {
                const isMermaid = block.classList.contains('language-mermaid') ||
                    block.classList.contains('language-mindmap');
                if (!isMermaid) {
                    hljs.highlightElement(block);
                }
            });
        }

        this.addCopyButtons();
        if (state.galleryViewer) state.galleryViewer.update();
    },

    async renderMermaid(container = document) {
        // Find all mermaid and mindmap code blocks first
        const blocks = container.querySelectorAll('pre code.language-mermaid, pre code.language-mindmap');
        if (blocks.length === 0) return;

        // 懒加载 Mermaid（只在有图表时才加载 3.3MB）
        const loaded = await loadMermaidIfNeeded();
        if (!loaded || typeof mermaid === 'undefined') {
            console.warn('Mermaid not loaded, diagrams will show as code');
            return;
        }

        const nodesToRender = [];

        blocks.forEach(block => {
            const isMindmap = block.classList.contains('language-mindmap');
            let rawCode = block.textContent;

            // Decode HTML entities (e.g., &gt; -> >) to prevent Mermaid syntax errors
            const txt = document.createElement("textarea");
            txt.innerHTML = rawCode;
            rawCode = txt.value;

            // If it's a mindmap block and doesn't start with the keyword, prepend it
            if (isMindmap && !rawCode.trim().startsWith('mindmap')) {
                rawCode = 'mindmap\n' + rawCode;
            }

            const pre = block.parentElement;

            // Create a div for mermaid
            const div = document.createElement('div');
            div.className = 'mermaid';
            div.textContent = rawCode;
            div.style.textAlign = 'center'; // Center the diagram
            div.style.background = 'transparent'; // Ensure transparent bg

            // Replace the <pre> block with the new <div>
            if (pre && pre.parentNode) {
                pre.parentNode.replaceChild(div, pre);
                nodesToRender.push(div);
            }
        });

        if (nodesToRender.length > 0) {
            try {
                // Ensure container is visible before rendering
                const containerRect = container.getBoundingClientRect ? container.getBoundingClientRect() : { width: 1, height: 1 };
                if (containerRect.width === 0 || containerRect.height === 0) {
                    console.warn('Container not visible, delaying Mermaid render');
                    setTimeout(() => this.renderMermaid(container), 100);
                    return;
                }

                await mermaid.run({ nodes: nodesToRender });
            } catch (e) {
                console.error('Mermaid rendering failed', e);
                // Fallback: show original code blocks with error comment
                nodesToRender.forEach(div => {
                    const pre = document.createElement('pre');
                    const code = document.createElement('code');
                    code.className = div.className.includes('mindmap') ? 'language-mindmap' : 'language-mermaid';
                    code.textContent = div.textContent + '\n\n/* Mermaid rendering failed - showing raw code */';
                    pre.appendChild(code);
                    div.replaceWith(pre);
                });
            }
        }
    },

    createNoteCard(note) {
        const isOwner = state.currentUser && note.user_id === state.currentUser.id;
        const isLockedCapsule = note.is_capsule && note.capsule_status !== 'opened' && note.capsule_status !== 'none';
        const isOpenedCapsule = note.is_capsule && note.capsule_status === 'opened';
        const card = document.createElement('div');
        card.className = 'note-card';
        card.id = `note-${note.id}`;

        let rawContent = note.content || '';
        // Normalize task list syntax: convert - [] or -[ ] to - [ ] (supports indented lists)
        rawContent = rawContent.replace(/^(\s*[-*])\s*\[([ xX]?)\]/gm, '$1 [$2]');

        // Pre-process: Fix bold syntax with quotes (marked.js doesn't handle **"quote"** well)
        // Handle English quotes: **"content"**
        rawContent = rawContent.replace(/\*\*"([^"]+)"([^\*]*?)\*\*/g, '<strong>"$1"$2</strong>');
        // Handle Chinese quotes: **"content"** (U+201C left, U+201D right)
        rawContent = rawContent.replace(/\*\*\u201C([^\u201D]+)\u201D([^\*]*?)\*\*/g, '<strong>\u201C$1\u201D$2</strong>');
        // Handle 「」
        rawContent = rawContent.replace(/\*\*「([^」]+)」([^\*]*?)\*\*/g, '<strong>「$1」$2</strong>');
        // Handle 『』
        rawContent = rawContent.replace(/\*\*『([^』]+)』([^\*]*?)\*\*/g, '<strong>『$1』$2</strong>');

        let content = rawContent;
        const searchVal = document.getElementById('searchInput')?.value.trim() || '';

        try {
            // Pre-process: convert bilibili markdown links to card HTML blocks
            const preprocessed = this._preprocessBilibiliLinks(parseWikiLinks(rawContent));

            let html;
            if (typeof marked !== 'undefined') {
                html = marked.parse(preprocessed);
            } else {
                html = preprocessed.replace(/\n/g, '<br>');
            }

            // Post-process: also catch any bilibili <a> tags that slipped through the renderer
            html = this._postprocessBilibiliLinks(html);
            content = sanitizeHtml(html);

            // Highlight Search Keywords (Safer implementation)
            if (searchVal && !state.isTrashMode) {
                // Use a temporary container to DOM-parse the HTML and only highlight text nodes
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = content;

                const highlightTextNodes = (node) => {
                    if (node.nodeType === 3) { // Text node
                        const text = node.nodeValue;
                        if (text.toLowerCase().includes(searchVal.toLowerCase())) {
                            const regex = new RegExp(`(${escapeHtml(searchVal)})`, 'gi');
                            const highlighted = text.replace(regex, '<mark class="search-highlight">$1</mark>');
                            const span = document.createElement('span');
                            span.innerHTML = highlighted;
                            node.replaceWith(...span.childNodes);
                        }
                    } else if (node.nodeType === 1 && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE' && node.tagName !== 'MARK') {
                        Array.from(node.childNodes).forEach(highlightTextNodes);
                    }
                };

                Array.from(tempDiv.childNodes).forEach(highlightTextNodes);
                content = tempDiv.innerHTML;
            }
        } catch (e) {
            console.error('Markdown rendering failed', e);
            content = note.content;
        }

        // Render Backlinks
        let backlinksHtml = '';
        if (note.backlinks && note.backlinks.length > 0 && !state.isTrashMode) {
            const links = note.backlinks.map(l =>
                `<a href="#note-${l.id}" class="backlink-item" style="margin-right:10px; color:var(--primary-color); text-decoration:none;">${escapeHtml(l.title)}</a>`
            ).join('');
            backlinksHtml = `
                <div class="backlinks-section" style="margin-top:10px; padding-top:10px; border-top:1px dashed #eee; font-size:0.8rem; color:#888;">
                    引用: ${links}
                </div>
            `;
        }

        // Render Documents List
        let docsHtml = '';
        if (note.documents && note.documents.length > 0) {
            const docs = note.documents.map(doc => {
                const icon = doc.file_type === 'pdf'
                    ? '<i class="fas fa-file-pdf" style="color:#e74c3c"></i>'
                    : '<i class="fas fa-file-word" style="color:#2980b9"></i>';
                const escapedFilename = escapeHtml(doc.original_filename);
                const escapedDocId = escapeHtml(String(doc.id));
                const escapedNoteId = escapeHtml(String(note.id));
                return `
                    <div class="editor-doc-card" style="cursor:pointer;" onclick="if(window.readerModule?.reader) window.readerModule.reader.open('${escapedDocId}', '${escapedNoteId}')">
                        ${icon}
                        <span class="doc-name" title="${escapedFilename}">${escapedFilename}</span>
                    </div>
                `;
            }).join('');

            docsHtml = `
                <div class="note-documents-list" style="display:flex; flex-wrap:wrap; gap:0px; margin-top:2px; margin-bottom: 4px;">
                    ${docs}
                </div>
            `;
        }

        card.innerHTML = `
            <div class="note-header">
                <span>${formatDate(note.created_at)}</span>
                <span class="note-header-right">
                    ${note.is_public ? '<i class="fas fa-globe" title="公开"></i>' : '<i class="fas fa-lock" title="私密"></i>'}
                    ${isOpenedCapsule ? '<span title="已拆开的时光胶囊" style="color:#f39c12; font-size:12px; display:inline-flex; align-items:center; gap:3px;"><i class="fas fa-hourglass-end"></i> 胶囊</span>' : ''}
                    ${note.is_offline_draft ? '<span class="offline-badge" title="待同步"><i class="fas fa-cloud-upload-alt"></i></span>' : ''}
                </span>
            </div>
            <div class="note-content markdown-body" style="${isOwner ? 'cursor: pointer;' : ''}" ${isOwner && !note.is_offline_draft ? `ondblclick="window.dispatchEvent(new CustomEvent('note:edit', { detail: '${note.id}' }))"` : ''}>${content}</div>
            
            ${docsHtml}

            ${note.tags.length > 0 ? `
            <div class="note-footer">
                <div class="note-tags">
                    ${note.tags.map(t => `<span class="note-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>` : ''}

            ${isOwner ? (state.isTrashMode ? `
            <div class="note-actions">
                <span class="note-action restore" data-action="restore" data-id="${note.id}" title="恢复"><i class="fas fa-undo"></i></span>
                <span class="note-action delete-forever" data-action="permanent-delete" data-id="${note.id}" title="彻底删除"><i class="fas fa-trash-alt"></i></span>
            </div>
            ` : `
            <div class="note-actions">
                <span class="note-action share" data-action="share" data-id="${note.id}" title="分享"><i class="fas fa-share-alt"></i></span>
                <span class="note-action edit" data-action="edit" data-id="${note.id}" title="编辑"><i class="fas fa-edit"></i></span>
                <span class="note-action history" data-action="history" data-id="${note.id}" title="历史版本"><i class="fas fa-history"></i></span>
                ${!isLockedCapsule ? `<span class="note-action delete" data-action="delete" data-id="${note.id}" title="删除"><i class="fas fa-trash"></i></span>` : ''}
            </div>`) : ''}

            ${backlinksHtml}
        `;

        if (note.is_offline_draft) {
            card.classList.add('offline-card');
            card.style.border = '2px dashed #f59e0b';
            card.style.background = '#fffbeb';
        }

        // Checkboxes in markdown must be clickable for event delegation
        card.querySelectorAll('.markdown-body input[type="checkbox"]').forEach(cb => {
            cb.removeAttribute('disabled');
        });

        return card;
    },

    restoreCard(note) {
        const oldCard = document.getElementById(`note-${note.id}`);
        if (!oldCard) return;
        const newCard = this.createNoteCard(note);

        // Disable animation for in-place updates to prevent flashing
        newCard.style.animation = 'none';

        oldCard.replaceWith(newCard);

        if (window.hljs) {
            newCard.querySelectorAll('pre code').forEach(block => {
                const isMermaid = block.classList.contains('language-mermaid') ||
                    block.classList.contains('language-mindmap');
                if (!isMermaid) {
                    hljs.highlightElement(block);
                }
            });
        }

        this.renderMermaid(newCard);
        this.addCopyButtons();
        this._loadBilibiliCards(newCard);
    },

    // bilibili 官方 TV 脸 SVG logo（来自 simple-icons）
    _BILI_LOGO_SVG: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>`,

    _createBilibiliCardHtml(bvid) {
        const logoSm = `<svg viewBox="0 0 24 24" width="14" height="14" fill="#fb7299" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>`;
        const logoLg = `<svg viewBox="0 0 24 24" width="36" height="36" fill="rgba(255,255,255,0.85)" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>`;

        return `<div class="bilibili-card" data-bvid="${bvid}" role="button" tabindex="0">` +
            `<div class="bili-card-thumb">` +
            `<div class="bili-thumb-placeholder">${logoLg}</div>` +
            `<div class="bili-play-btn"><i class="fas fa-play"></i></div>` +
            `</div>` +
            `<div class="bili-card-content">` +
            `<div class="bili-card-brand-row">${logoSm}<span class="bili-brand-name">bilibili</span></div>` +
            `<div class="bili-card-title" data-loading="true">加载中…</div>` +
            `<div class="bili-card-meta">` +
            `<span class="bili-card-bvid">${bvid}</span>` +
            `</div>` +
            `</div>` +
            `<div class="bili-card-arrow"><i class="fas fa-chevron-right"></i></div>` +
            `</div>`;
    },

    _loadBilibiliCards(container) {
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
                    if (metaEl) {
                        const bvidSpan = metaEl.querySelector('.bili-card-bvid');
                        if (bvidSpan) bvidSpan.textContent = bvid;
                        if (data.owner && !metaEl.querySelector('.bili-card-owner')) {
                            const ownerSpan = document.createElement('span');
                            ownerSpan.className = 'bili-card-owner';
                            ownerSpan.textContent = data.owner;
                            metaEl.appendChild(ownerSpan);
                        }
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
    },

    _preprocessBilibiliLinks(content) {
        // Match [any-text](bilibili-url) markdown link patterns
        // Bilibili BV IDs use base58 encoding (excludes 0, O, I, l to avoid confusion)
        let result = content.replace(
            /\[([^\]]*)\]\((https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+)[^)]*)\)/gi,
            (match, text, url, bvid) => `\n${this._createBilibiliCardHtml(bvid)}\n`
        );
        // Also match bare bilibili URLs on their own line (no markdown link wrapping)
        result = result.replace(
            /(?<!\()(https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+)[^\s)]*)/gi,
            (match, url, bvid) => this._createBilibiliCardHtml(bvid)
        );
        return result;
    },

    _postprocessBilibiliLinks(html) {
        // Catch any bilibili <a href> tags rendered by marked (fallback)
        return html.replace(
            /<a\s+href="https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+)[^"]*"[^>]*>(?:[^<]|<(?!\/a>))*<\/a>/gi,
            (match, bvid) => this._createBilibiliCardHtml(bvid)
        );
    },

    addCopyButtons() {
        document.querySelectorAll('pre code').forEach((block) => {
            if (block.parentNode.querySelector('.copy-code-btn')) return;

            const button = document.createElement('button');
            button.className = 'copy-code-btn';
            button.innerHTML = '<i class="far fa-copy"></i>';
            button.title = '复制/Copy';
            // Styling kept inline or move to CSS. Sticking to inline for parity with original
            Object.assign(button.style, {
                position: 'absolute', right: '10px', top: '10px',
                background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff',
                padding: '4px 8px', borderRadius: '4px', cursor: 'pointer',
                fontSize: '12px', opacity: '0.6', transition: 'opacity 0.2s'
            });

            block.parentNode.style.position = 'relative';

            button.onmouseover = () => button.style.opacity = '1';
            button.onmouseout = () => button.style.opacity = '0.6';

            button.onclick = () => {
                navigator.clipboard.writeText(block.innerText).then(() => {
                    button.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(() => button.innerHTML = '<i class="far fa-copy"></i>', 2000);
                });
            };

            block.parentNode.appendChild(button);
        });
    },

    // Inline Edit Logic
    async startInlineEdit(id) {
        const card = document.getElementById(`note-${id}`);
        if (!card) return;
        // 记录当前编辑的笔记 ID，供文档上传等功能使用
        window.__currentNoteId = id;
        if (window.readerModule?.reader) window.readerModule.reader.setActiveNote(id);

        const contentDiv = card.querySelector('.note-content');
        const tagsDiv = card.querySelector('.note-tags');
        const actionsDiv = card.querySelector('.note-actions');

        if (tagsDiv) tagsDiv.style.display = 'none';
        if (actionsDiv) actionsDiv.style.display = 'none';
        contentDiv.classList.add('editing'); // Add editing class

        try {
            // Use local state if available to avoid delay
            let note = state.notes.find(n => n.id == id);

            // Fallback to API if not found (e.g., direct link or partial load)
            if (!note) {
                const res = await api.notes.get(id);
                if (!res) throw new Error("Failed to load note");
                note = await res.json();
            }

            state.editTags = [...note.tags];

            const container = document.createElement('div');
            container.className = 'inline-editor-container';

            const textarea = document.createElement('textarea');
            textarea.value = note.content;
            textarea.id = `edit-textarea-${id}`;
            textarea.className = 'inline-editor-textarea';

            // 文档附件列表
            const docsList = document.createElement('div');
            docsList.className = 'editor-documents-list inline-editor-documents';
            docsList.id = `edit-docs-list-${id}`;
            docsList.style.display = 'none';

            // Auto-resize
            const autoResize = () => {
                textarea.style.height = 'auto';
                textarea.style.height = (textarea.scrollHeight + 10) + 'px';
            };
            setTimeout(autoResize, 0);
            textarea.addEventListener('input', autoResize);

            // Tools Bar
            const toolsBar = document.createElement('div');
            toolsBar.className = 'inline-tools-bar';
            const toolsLeft = document.createElement('div');
            toolsLeft.className = 'inline-tools-left input-controls';

            const imgBtn = document.createElement('button');
            imgBtn.className = 'tool-btn';
            imgBtn.innerHTML = '<i class="far fa-image"></i>';
            imgBtn.title = '上传图片';
            imgBtn.onclick = () => {
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = 'image/*';
                fileInput.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const formData = new FormData();
                    formData.append('file', file);
                    showToast('正在上传图片...');
                    const upRes = await api.upload(formData);
                    if (upRes && upRes.ok) {
                        const data = await upRes.json();
                        const md = `\n![image](${data.url})\n`;
                        if (textarea.setRangeText) textarea.setRangeText(md);
                        else textarea.value += md;
                        showToast('图片上传成功');
                    } else {
                        showToast('上传失败');
                    }
                };
                fileInput.click();
            };
            toolsLeft.appendChild(imgBtn);

            const docBtn = document.createElement('button');
            docBtn.className = 'tool-btn tool-btn-doc';
            docBtn.innerHTML = '<i class="fas fa-file-import"></i>';
            docBtn.title = '上传文档';
            docBtn.onclick = () => {
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = '.pdf,.docx,.doc';
                fileInput.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    showToast('正在上传文档...');
                    const upRes = await api.documents?.upload(file, id);
                    if (upRes && upRes.ok) {
                        const doc = await upRes.json();
                        window.__editPendingDocs = window.__editPendingDocs || {};
                        window.__editPendingDocs[id] = window.__editPendingDocs[id] || [];
                        window.__editPendingDocs[id].push(doc);
                        window.dispatchEvent(new CustomEvent('document:edit-uploaded', { detail: { doc, noteId: id } }));
                        showToast('文档上传成功');
                    } else {
                        showToast('上传失败');
                    }
                };
                fileInput.click();
            };
            toolsLeft.appendChild(docBtn);
            toolsBar.appendChild(toolsLeft);

            // Tags Area
            const tagsArea = document.createElement('div');
            tagsArea.className = 'inline-tags-area';

            const tagInput = document.createElement('input');
            tagInput.className = 'inline-tag-input';
            tagInput.placeholder = '+ 标签 (回车)';
            tagInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = tagInput.value.trim();
                    if (val && !state.editTags.includes(val)) {
                        state.editTags.push(val);
                        this.renderInlineTags(tagsArea, tagInput);
                        tagInput.value = '';
                    }
                }
            });

            this.renderInlineTags(tagsArea, tagInput);

            // Footer
            const footer = document.createElement('div');
            footer.className = 'inline-footer';

            const publicSwitch = document.createElement('div');
            publicSwitch.className = 'public-switch';
            publicSwitch.innerHTML = `
                <input type="checkbox" id="edit-public-${id}" ${note.is_public ? 'checked' : ''}>
                <label for="edit-public-${id}" title="设为公开"><i class="fas fa-globe-americas"></i> <span style="font-size:12px">公开</span></label>
            `;

            const btnsDiv = document.createElement('div');
            btnsDiv.className = 'inline-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.className = 'btn btn-secondary btn-sm';
            cancelBtn.onclick = () => {
                // Restore original card locally without refreshing list
                this.restoreCard(note);
            };

            const saveBtn = document.createElement('button');
            saveBtn.textContent = '保存修改';
            saveBtn.className = 'btn btn-primary btn-sm';
            saveBtn.onclick = async () => {
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中';
                const isPublic = document.getElementById(`edit-public-${id}`).checked;

                // 时光胶囊数据
                const isCapsule = textarea.dataset.isCapsule === 'true';
                const capsuleDate = textarea.dataset.capsuleDate || null;
                const capsuleHint = textarea.dataset.capsuleHint || '';

                // Dispatch event to main.js for handling (offline support)
                const updateDetail = {
                    id: id,
                    content: textarea.value,
                    tags: state.editTags,
                    is_public: isPublic,
                    is_capsule: isCapsule,
                    capsule_date: capsuleDate,
                    capsule_hint: capsuleHint
                };

                // 获取当前编辑的文档附件 ID 列表
                if (window.__editPendingDocs && window.__editPendingDocs[id]) {
                    updateDetail.doc_ids = window.__editPendingDocs[id].map(d => d.id);
                }

                window.dispatchEvent(new CustomEvent('note:request-update', {
                    detail: updateDetail
                }));
            };

            btnsDiv.appendChild(cancelBtn);
            btnsDiv.appendChild(saveBtn);
            footer.appendChild(publicSwitch);
            footer.appendChild(btnsDiv);

            container.appendChild(textarea);
            container.appendChild(docsList);
            container.appendChild(toolsBar);
            container.appendChild(tagsArea);
            container.appendChild(footer);

            // 渲染已有的文档附件
            if (note.documents && note.documents.length > 0) {
                // 暂时将文档存入全局状态，以便编辑时可以删除或增加
                window.__editPendingDocs = window.__editPendingDocs || {};
                window.__editPendingDocs[id] = [...note.documents];

                // 渲染附件列表
                const renderEditDocs = () => {
                    const docs = window.__editPendingDocs[id] || [];
                    if (docs.length > 0) {
                        docsList.style.display = 'flex';
                        docsList.innerHTML = docs.map(doc => {
                            const icon = doc.file_type === 'pdf'
                                ? '<i class="fas fa-file-pdf" style="color:#e74c3c"></i>'
                                : '<i class="fas fa-file-word" style="color:#2980b9"></i>';
                            const escapedFilename = escapeHtml(doc.original_filename);
                            const escapedDocId = escapeHtml(String(doc.id));
                            return `
                                <div class="editor-doc-card" data-doc-id="${escapedDocId}">
                                    ${icon}
                                    <span class="doc-name" title="${escapedFilename}">${escapedFilename}</span>
                                    <button type="button" class="doc-remove-btn" title="移除附件"><i class="fas fa-times"></i></button>
                                </div>
                            `;
                        }).join('');

                        // 绑定事件
                        docsList.querySelectorAll('.editor-doc-card').forEach(card => {
                            // 点击卡片打开阅读器
                            card.addEventListener('click', (e) => {
                                if (e.target.closest('.doc-remove-btn')) return;
                                const docId = card.dataset.docId;
                                if (window.readerModule?.reader) {
                                    window.readerModule.reader.open(docId, id);
                                }
                            });

                            // 点击删除按钮
                            const removeBtn = card.querySelector('.doc-remove-btn');
                            removeBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                const docId = card.dataset.docId;
                                window.__editPendingDocs[id] = window.__editPendingDocs[id].filter(d => d.id !== docId);
                                renderEditDocs();
                            });
                        });
                    } else {
                        docsList.style.display = 'none';
                        docsList.innerHTML = '';
                    }
                };

                // 绑定到 DOM 元素上以便其他模块调用
                docsList.__renderFunc = renderEditDocs;

                renderEditDocs();
            }

            // 监听新上传的文档
            const uploadListener = (e) => {
                if (e.detail.noteId == id) {
                    if (docsList.__renderFunc) {
                        docsList.__renderFunc();
                    } else {
                        // 如果之前没有附件，初始化渲染函数并调用
                        docsList.__renderFunc = () => {
                            const docs = window.__editPendingDocs[id] || [];
                            if (docs.length > 0) {
                                docsList.style.display = 'flex';
                                docsList.innerHTML = docs.map(doc => {
                                    const icon = doc.file_type === 'pdf'
                                        ? '<i class="fas fa-file-pdf" style="color:#e74c3c"></i>'
                                        : '<i class="fas fa-file-word" style="color:#2980b9"></i>';
                                    const escapedFilename = escapeHtml(doc.original_filename);
                                    const escapedDocId = escapeHtml(String(doc.id));
                                    return `
                                        <div class="editor-doc-card" data-doc-id="${escapedDocId}">
                                            ${icon}
                                            <span class="doc-name" title="${escapedFilename}">${escapedFilename}</span>
                                            <button type="button" class="doc-remove-btn" title="移除附件"><i class="fas fa-times"></i></button>
                                        </div>
                                    `;
                                }).join('');

                                docsList.querySelectorAll('.editor-doc-card').forEach(card => {
                                    card.addEventListener('click', (e) => {
                                        if (e.target.closest('.doc-remove-btn')) return;
                                        const docId = card.dataset.docId;
                                        if (window.readerModule?.reader) {
                                            window.readerModule.reader.open(docId, id);
                                        }
                                    });

                                    const removeBtn = card.querySelector('.doc-remove-btn');
                                    removeBtn.addEventListener('click', (e) => {
                                        e.stopPropagation();
                                        const docId = card.dataset.docId;
                                        window.__editPendingDocs[id] = window.__editPendingDocs[id].filter(d => d.id !== docId);
                                        docsList.__renderFunc();
                                    });
                                });
                            } else {
                                docsList.style.display = 'none';
                                docsList.innerHTML = '';
                            }
                        };
                        docsList.__renderFunc();
                    }
                }
            };
            window.addEventListener('document:edit-uploaded', uploadListener);

            // 保存清理监听器的引用
            container.__uploadListener = uploadListener;

            contentDiv.innerHTML = '';
            contentDiv.appendChild(container);

            // 初始化编辑器功能
            editor.setupAutocomplete(textarea);
            editor.setupSlashCommands(textarea);
            editor.setupMarkdownShortcuts(textarea);
            editor.setupAutoHeight(textarea);
            editor.setupAITools(textarea);
            editor.setupCapsuleTool(textarea);
            editor.setupVoiceInput(textarea);

            // 如果原本就是时光胶囊，初始化状态
            if (note.is_capsule) {
                textarea.dataset.isCapsule = 'true';
                textarea.dataset.capsuleDate = note.capsule_date;
                textarea.dataset.capsuleHint = note.capsule_hint || '';

                const capsuleBtn = toolsLeft.querySelector('.capsule-trigger');
                if (capsuleBtn) {
                    capsuleBtn.innerHTML = '<i class="fas fa-hourglass-half"></i>';
                    capsuleBtn.style.color = '#f39c12';
                }
            }

            textarea.focus();
        } catch (e) {
            console.error(e);
            showToast('加载失败');
            if (tagsDiv) tagsDiv.style.display = 'flex';
            if (actionsDiv) actionsDiv.style.display = 'flex';
        }
    },

    renderInlineTags(container, inputElement) {
        // Clear all except inputElement (which we append back)
        // But inputElement is passed in, so we can just clear innerHTML and rebuild
        container.innerHTML = '';

        state.editTags.forEach((t, index) => {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'note-tag'; // Use note-tag style
            // Inline styles are now handled by CSS class .note-tag, removing inline styles
            // But keep specific layout if needed. .note-tag has display:inline-flex.

            tagSpan.innerHTML = `#${escapeHtml(t)} <span class="remove-btn" style="cursor:pointer; font-weight:bold; margin-left:4px;">&times;</span>`;

            // Delete
            tagSpan.querySelector('.remove-btn').onclick = (e) => {
                e.stopPropagation();
                state.editTags = state.editTags.filter((_, i) => i !== index);
                this.renderInlineTags(container, inputElement);
            };

            // Edit
            tagSpan.ondblclick = (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.value = t;
                input.className = 'tag-edit-input';

                const save = () => {
                    const val = input.value.trim();
                    if (val && val !== t) {
                        state.editTags[index] = val;
                        // Unique
                        state.editTags = [...new Set(state.editTags)];
                    }
                    this.renderInlineTags(container, inputElement);
                };

                input.onblur = save;
                input.onkeydown = (ev) => {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        input.blur();
                    }
                };

                tagSpan.replaceWith(input);
                input.focus();
            };

            container.appendChild(tagSpan);
        });
        container.appendChild(inputElement);
        // inputElement.focus(); // Avoid stealing focus on every render if not intended
    },

    renderTags(type) {
        const container = document.getElementById(type === 'input' ? 'tagsList' : 'editTagsList');
        if (!container) return;
        const tags = type === 'input' ? state.currentTags : state.editTags;

        container.innerHTML = '';
        tags.forEach((t, index) => {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'filter-tag active';
            tagSpan.style.marginRight = '5px';
            tagSpan.innerHTML = `
                ${escapeHtml(t)} <span class="remove-tag-btn" data-tag="${escapeHtml(t)}" data-type="${type}">&times;</span>
            `;

            // Double click to edit
            tagSpan.ondblclick = (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'text';
                input.value = t;
                input.className = 'tag-edit-input';

                const saveEdit = () => {
                    const newVal = input.value.trim();
                    if (newVal && newVal !== t) {
                        if (type === 'input') {
                            state.currentTags[index] = newVal;
                            // Ensure uniqueness if needed, or allow duplicates? Better unique.
                            state.currentTags = [...new Set(state.currentTags)];
                        } else {
                            state.editTags[index] = newVal;
                            state.editTags = [...new Set(state.editTags)];
                        }
                    }
                    this.renderTags(type);
                };

                input.onblur = saveEdit;
                input.onkeydown = (ev) => {
                    if (ev.key === 'Enter') {
                        ev.preventDefault(); // Prevent form submit or newline
                        input.blur();
                    }
                };

                tagSpan.replaceWith(input);
                input.focus();
            };

            container.appendChild(tagSpan);
        });

        // Re-bind remove buttons (using delegation or direct binding in loop)
        container.querySelectorAll('.remove-tag-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation(); // Prevent dblclick trigger
                window.dispatchEvent(new CustomEvent('tag:remove', { detail: { tag: btn.dataset.tag, type: btn.dataset.type } }));
            };
        });
    },

    renderSidebarTags(tags) {
        const container = document.querySelector('.filter-tags-list');
        if (container) {
            container.innerHTML = `<button class="sidebar-tag ${state.currentFilterTag === '' ? 'active' : ''}" data-tag="" style="width:100%; border:none; background:transparent;">
                <span style="font-weight:600;">全部</span>
            </button>`;

            tags.forEach((t, index) => {
                const btn = document.createElement('button');
                btn.className = `sidebar-tag ${state.currentFilterTag === t ? 'active' : ''}`;
                Object.assign(btn.style, { width: '100%', border: 'none', background: 'transparent' });
                btn.innerHTML = `<span># ${escapeHtml(t)}</span>`;
                btn.dataset.tag = t;
                btn.onclick = () => window.dispatchEvent(new CustomEvent('filter:tag', { detail: t }));

                // Stagger animation
                const delay = Math.min(index * 0.03, 0.5); // Faster stagger for tags
                btn.style.animationDelay = `${delay}s`;

                container.appendChild(btn);
            });
        }
    },

    // Header & Stats
    updateHeaderDate() {
        const el = document.getElementById('currentDateDisplay');
        const icon = document.querySelector('.header-left i');

        if (state.currentDateFilter) {
            el.innerHTML = `<span class="clickable-crumb" id="resetDateFilter">首页</span> <span class="divider">/</span> <span style="color:var(--slate-800); font-weight:600;">${state.currentDateFilter}</span>`;
            if (icon) icon.className = "fas fa-filter";
            document.getElementById('resetDateFilter').onclick = () => window.dispatchEvent(new CustomEvent('filter:date-clear'));
        } else {
            const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
            const todayStr = new Date().toLocaleDateString('zh-CN', options);
            el.innerHTML = todayStr;
            if (icon) icon.className = "fas fa-home";
        }
    },

    async renderHeatmap() {
        const container = document.getElementById('heatmapGrid');
        if (!container) return;

        let tooltip = document.getElementById('heatmapTooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'heatmapTooltip';
            tooltip.className = 'custom-tooltip';
            document.body.appendChild(tooltip);
        }

        let data;
        const res = await api.stats.heatmap();
        if (res && res.ok) {
            data = await res.json();
            offlineStore.setHeatmap(data);
        } else {
            data = offlineStore.getHeatmap();
            if (!data || Object.keys(data).length === 0) return;
        }

        container.innerHTML = '';

        // SVG Config
        const boxSize = 12;
        const gap = 3;
        const weeks = 12;
        const days = 7;
        const width = weeks * (boxSize + gap);
        const height = days * (boxSize + gap);

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        Object.assign(svg.style, { height: "auto", display: "block", margin: "0 auto" });

        const today = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - startDate.getDay() - ((weeks - 1) * 7));

        const formatDateStr = d => d.toISOString().split('T')[0];

        for (let w = 0; w < weeks; w++) {
            for (let d = 0; d < days; d++) {
                const currentDate = new Date(startDate);
                currentDate.setDate(startDate.getDate() + (w * 7) + d);

                if (currentDate > today) continue;

                const dateStr = formatDateStr(currentDate);
                const count = data[dateStr] || 0;

                let color = '#F1F5F9';
                if (count > 0) color = '#6EE7B7';
                if (count > 2) color = '#34D399';
                if (count > 4) color = '#10B981';
                if (count > 6) color = '#059669';

                const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                rect.setAttribute("x", w * (boxSize + gap));
                rect.setAttribute("y", d * (boxSize + gap));
                rect.setAttribute("width", boxSize);
                rect.setAttribute("height", boxSize);
                rect.setAttribute("rx", 2);
                rect.setAttribute("fill", color);
                rect.setAttribute("data-date", dateStr);
                rect.setAttribute("class", "heatmap-cell day-cell");
                rect.style.cursor = 'pointer';

                if (state.currentDateFilter === dateStr) {
                    rect.style.border = '2px solid var(--slate-800)'; // SVG rect doesn't support border style like this, need stroke
                    rect.setAttribute("stroke", "#1E293B");
                    rect.setAttribute("stroke-width", "2");
                }

                rect.addEventListener('mouseenter', () => {
                    const dateText = new Date(dateStr).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
                    tooltip.innerHTML = `<strong>${dateText}</strong> · ${count} 条笔记`;
                    tooltip.style.opacity = '1';
                    const rectBox = rect.getBoundingClientRect();
                    tooltip.style.left = `${rectBox.left + rectBox.width / 2}px`;
                    tooltip.style.top = `${rectBox.top}px`;
                });

                rect.addEventListener('mouseleave', () => tooltip.style.opacity = '0');

                rect.addEventListener('click', () => {
                    window.dispatchEvent(new CustomEvent('filter:date', { detail: dateStr }));
                });

                svg.appendChild(rect);
            }
        }
        container.appendChild(svg);
        container.style.display = 'block';
        container.style.borderTop = 'none';
    },

    async renderOverviewStats() {
        if (!state.currentUser) return;

        let data;
        const res = await api.stats.overview();
        if (res && res.ok) {
            data = await res.json();
            offlineStore.setStats(data);
        } else {
            data = offlineStore.getStats();
            if (!data) return;
        }

        document.getElementById('statsSection').style.display = 'block';
        document.getElementById('statNoteCount').textContent = data.notes;
        document.getElementById('statTagCount').textContent = data.tags;
        document.getElementById('statDayCount').textContent = data.days;
    },

    handleHashJump() {
        const hash = window.location.hash;
        if (!hash || !hash.startsWith('#note-')) return;

        const targetId = hash.substring(1);
        const element = document.getElementById(targetId);

        if (element) {
            // Scroll to element
            setTimeout(() => {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // Add highlight effect
                element.classList.add('jump-highlight');
                setTimeout(() => {
                    element.classList.remove('jump-highlight');
                }, 2000);
            }, 100);
        }
    }
};
