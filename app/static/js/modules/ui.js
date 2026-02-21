import { api } from './api.js';
import { state } from './state.js';
import { formatDate, escapeHtml, parseWikiLinks, showToast } from './utils.js';
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

        notesToRender.forEach((note, index) => {
            const card = this.createNoteCard(note);
            // Stagger animation: max delay 0.5s to prevent long waits for large lists
            const delay = Math.min(index * 0.05, 0.5);
            card.style.animationDelay = `${delay}s`;
            list.appendChild(card);
        });

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
            if (typeof marked !== 'undefined') {
                const html = marked.parse(parseWikiLinks(rawContent));
                content = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
            } else {
                const html = parseWikiLinks(rawContent).replace(/\n/g, '<br>');
                content = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
            }

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

        card.innerHTML = `
            <div class="note-header">
                <span>${formatDate(note.created_at)}</span>
                ${note.is_public ? '<i class="fas fa-globe" title="公开"></i>' : '<i class="fas fa-lock" title="私密"></i>'}
            </div>
            <div class="note-content markdown-body" style="${isOwner ? 'cursor: pointer;' : ''}" ${isOwner ? `ondblclick="window.dispatchEvent(new CustomEvent('note:edit', { detail: '${note.id}' }))"` : ''}>${content}</div>

            <div class="note-tags">
                ${note.tags.map(t => `<span class="note-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}
            </div>

            ${isOwner ? (state.isTrashMode ? `
            <div class="note-actions">
                <span class="note-action restore" data-action="restore" data-id="${note.id}" title="恢复"><i class="fas fa-undo"></i></span>
                <span class="note-action delete-forever" data-action="permanent-delete" data-id="${note.id}" title="彻底删除" style="color:#ef4444;"><i class="fas fa-ban"></i></span>
            </div>
            ` : `
            <div class="note-actions">
                <span class="note-action share" data-action="share" data-id="${note.id}" title="分享"><i class="fas fa-share-alt"></i></span>
                <span class="note-action edit" data-action="edit" data-id="${note.id}" title="编辑"><i class="fas fa-edit"></i></span>
                <span class="note-action history" data-action="history" data-id="${note.id}" title="历史版本"><i class="fas fa-history"></i></span>
                <span class="note-action delete" data-action="delete" data-id="${note.id}" title="删除"><i class="fas fa-trash"></i></span>
            </div>`) : ''}

            ${backlinksHtml}
        `;

        // Event delegation for tags inside the card
        card.querySelectorAll('.note-tag').forEach(tagEl => {
            tagEl.onclick = () => window.dispatchEvent(new CustomEvent('filter:tag', { detail: tagEl.dataset.tag }));
        });

        // Action buttons delegation
        card.querySelectorAll('.note-action').forEach(actionEl => {
            actionEl.onclick = (e) => {
                const action = actionEl.dataset.action;
                const id = actionEl.dataset.id;
                window.dispatchEvent(new CustomEvent(`note:${action}`, { detail: id }));
            };
        });

        // Task list interaction
        card.querySelectorAll('.markdown-body input[type="checkbox"]').forEach((cb, idx) => {
            cb.removeAttribute('disabled');
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                // We use change event or just capture the click and prevent default to handle manually?
                // Actually, let's just use the checked status after the click.
                window.dispatchEvent(new CustomEvent('note:toggle-task', { 
                    detail: { id: note.id, index: idx, checked: cb.checked } 
                }));
            });
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

                const updateRes = await api.notes.update(id, {
                    content: textarea.value,
                    tags: state.editTags,
                    is_public: isPublic
                });

                if (updateRes && updateRes.ok) {
                    showToast('保存成功');
                    // Update local state
                    note.content = textarea.value;
                    note.tags = state.editTags;
                    note.is_public = isPublic;

                    // Local Refresh
                    this.restoreCard(note);

                    // Trigger tags refresh event
                    window.dispatchEvent(new CustomEvent('tags:refresh'));
                } else {
                    showToast('保存失败');
                    saveBtn.disabled = false;
                    saveBtn.textContent = '保存修改';
                }
            };

            btnsDiv.appendChild(cancelBtn);
            btnsDiv.appendChild(saveBtn);
            footer.appendChild(publicSwitch);
            footer.appendChild(btnsDiv);

            container.appendChild(textarea);
            container.appendChild(toolsBar);
            container.appendChild(tagsArea);
            container.appendChild(footer);

            contentDiv.innerHTML = '';
            contentDiv.appendChild(container);

            editor.setupAITools(textarea);

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

        const res = await api.stats.heatmap();
        if (!res || !res.ok) return;
        const data = await res.json();

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
        const res = await api.stats.overview();
        if (res && res.ok) {
            const data = await res.json();
            document.getElementById('statsSection').style.display = 'block';
            document.getElementById('statNoteCount').textContent = data.notes;
            document.getElementById('statTagCount').textContent = data.tags;
            document.getElementById('statDayCount').textContent = data.days;
        }
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
