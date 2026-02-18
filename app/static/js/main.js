import { api } from './modules/api.js';
import { state, setState } from './modules/state.js';
import { ui } from './modules/ui.js';
import { auth, initAuthEvents } from './modules/auth.js';
import { editor } from './modules/editor.js';
import { showToast, debounce, parseWikiLinks, escapeHtml, showConfirm } from './modules/utils.js';

// === Scroll Loading Indicator ===
function showScrollLoading() {
    const list = document.getElementById('notesList');
    if (!list) return;

    let loader = list.querySelector('.scroll-loading');
    if (!loader) {
        loader = document.createElement('div');
        loader.className = 'scroll-loading';
        loader.innerHTML = '<i class="fas fa-spinner fa-spin"></i>加载更多...';
        list.appendChild(loader);
    }
}

function hideScrollLoading() {
    const list = document.getElementById('notesList');
    if (!list) return;

    const loader = list.querySelector('.scroll-loading');
    if (loader) loader.remove();
}

// === Main Logic ===

document.addEventListener('DOMContentLoaded', async () => {
    initGlobalEvents();
    initAuthEvents(loadData); // Pass loadData as callback after login

    // Render Skeleton and Header immediately to improve perceived performance
    ui.renderSkeleton();
    ui.updateHeaderDate();

    // Initialize image viewer
    const list = document.getElementById('notesList');
    if (list && typeof Viewer !== 'undefined') {
        state.galleryViewer = new Viewer(list, {
            button: true, navbar: false, title: false,
            toolbar: { zoomIn:1, zoomOut:1, oneToOne:1, reset:1 },
            filter(image) { return image.closest('.note-content'); }
        });
    }

    // Initialize editor
    editor.init('noteContent');

    // Initial load
    await auth.checkStatus({
        onLogin: loadData,
        onLogout: loadData
    });
});

async function loadData() {
    await loadNotes(true);
    loadTags();
    ui.renderHeatmap();
    ui.renderOverviewStats();
    ui.updateHeaderDate();
    ui.handleHashJump(); // Manually jump to anchor after notes are rendered
}

// === Note Logic ===

async function loadNotes(reset = false) {
    if (state.isLoading) return;
    if (reset) {
        setState('currentPage', 1);
        setState('notes', []);
        setState('hasNextPage', true);
    }

    setState('isLoading', true);

    // Show loading indicator for infinite scroll (not reset)
    if (!reset) {
        showScrollLoading();
    }

    const list = document.getElementById('notesList');
    if (reset && list) {
        // Show skeleton loader
        ui.renderSkeleton();
    }

    try {
        let response;
        const searchVal = document.getElementById('searchInput')?.value.trim() || '';

        if (state.isTrashMode) {
             response = await api.notes.trash(state.currentPage);
        } else if (searchVal) {
             response = await api.notes.search(searchVal, state.currentFilterTag, state.currentPage);
        } else {
             response = await api.notes.list(state.currentPage, state.currentFilterTag, state.currentDateFilter);
        }

        if (!response) return;
        const data = await response.json();

        let newNotes = [];
        if (Array.isArray(data)) {
            newNotes = data;
        } else if (data.notes) {
            newNotes = data.notes;
            if (data.has_next !== undefined) setState('hasNextPage', data.has_next);
            else if (newNotes.length < 20) setState('hasNextPage', false);
        }

        if (reset) setState('notes', newNotes);
        else setState('notes', [...state.notes, ...newNotes]);

        ui.renderNotes(newNotes, reset);
        setState('currentPage', state.currentPage + 1);

    } catch (e) {
        console.error("Load notes failed", e);
    } finally {
        setState('isLoading', false);
        hideScrollLoading();
    }
}

async function loadTags() {
    const res = await api.tags.list();
    if (res) {
        const tags = await res.json();
        ui.renderSidebarTags(tags);
    }
}

// === Event Handlers ===

function initGlobalEvents() {
    // Navigation
    document.getElementById('navAllNotes').addEventListener('click', (e) => {
        e.preventDefault();
        switchView('all');
    });
    document.getElementById('navTrash').addEventListener('click', (e) => {
        e.preventDefault();
        switchView('trash');
    });

    document.getElementById('navDailyReview')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const modal = document.getElementById('reviewModal');
        // ... (existing review logic)
        const list = document.getElementById('reviewList');
        
        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:20px;">加载中...</div>';
            
            modal.querySelector('.close-review').onclick = () => modal.style.display = 'none';
            window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

            const res = await api.notes.review();
            if (res) {
                const notes = await res.json();
                list.innerHTML = '';
                if (notes.length === 0) {
                    list.innerHTML = '<div style="text-align:center; padding:20px;">还没有足够的笔记进行回顾</div>';
                    return;
                }
                
                notes.forEach(note => {
                    const card = ui.createNoteCard(note);
                    const actions = card.querySelector('.note-actions');
                    if(actions) actions.style.display = 'none';
                    list.appendChild(card);
                });
                
                if (window.hljs) hljs.highlightAll();
            }
        }
    });

    // My Shares Modal
    document.getElementById('navShares')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const modal = document.getElementById('sharesModal');
        const list = document.getElementById('sharesList');

        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:20px;">加载中...</div>';

            // Close logic
            const closeBtn = modal.querySelector('.close-shares');
            if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
            window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

            try {
                // Fetch shares (Assume API exists, need to ensure api.js has share.list or similar if distinct)
                // Actually api.js might not have a dedicated method for user shares list yet.
                // We'll use fetch directly or add to api object if needed.
                // Let's assume we can fetch '/api/shares' directly here for simplicity or update api.js later.
                const response = await fetch('/api/shares');
                if (response.ok) {
                    const shares = await response.json();
                    if (shares.length === 0) {
                        list.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">暂无活跃分享</div>';
                        return;
                    }

                    list.innerHTML = shares.map(s => `
                        <div class="version-item" id="share-item-${s.id}">
                            <div class="version-info" style="flex:1;">
                                <div style="font-weight:600; color:var(--slate-800); margin-bottom:4px;">
                                    ${escapeHtml(s.note_title || '无标题')}
                                </div>
                                <div style="font-size:12px; color:var(--slate-500);">
                                    <span style="margin-right:10px;"><i class="far fa-clock"></i> 创建于 ${new Date(s.created_at).toLocaleDateString()}</span>
                                    <span style="margin-right:10px;"><i class="far fa-eye"></i> 浏览 ${s.view_count}</span>
                                    <span><i class="fas fa-hourglass-half"></i> ${s.expires_at ? new Date(s.expires_at).toLocaleDateString() + ' 过期' : '永久有效'}</span>
                                </div>
                                <div style="font-size:12px; color:var(--primary); margin-top:4px; word-break:break-all;">
                                    ${s.url}
                                </div>
                            </div>
                            <div class="version-actions">
                                <button class="btn btn-secondary btn-sm copy-share-btn" data-url="${s.url}">复制</button>
                                <button class="btn btn-danger btn-sm delete-share-btn" data-id="${s.id}">取消分享</button>
                            </div>
                        </div>
                    `).join('');

                    // Bind events
                    list.querySelectorAll('.copy-share-btn').forEach(btn => {
                        btn.onclick = () => {
                            navigator.clipboard.writeText(btn.dataset.url).then(() => showToast('链接已复制'));
                        };
                    });

                    list.querySelectorAll('.delete-share-btn').forEach(btn => {
                        btn.onclick = async () => {
                            const confirmed = await showConfirm('链接将失效，确定要取消此分享吗？', { title: '取消分享', type: 'danger' });
                            if (!confirmed) return;
                            const shareId = btn.dataset.id.trim();
                            const res = await api.share.delete(shareId);
                            if (res && res.ok) {
                                document.getElementById(`share-item-${shareId}`).remove();
                                showToast('分享已取消');
                            } else {
                                showToast('操作失败');
                            }
                        };
                    });
                } else {
                    list.innerHTML = '<div style="text-align:center; padding:20px; color:red;">加载失败</div>';
                }
            } catch (err) {
                console.error(err);
                list.innerHTML = '<div style="text-align:center; padding:20px; color:red;">网络错误</div>';
            }
        }
    });

    // Sidebar Toggle
    const toggleBtn = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const appContainer = document.querySelector('.app-container');

    // Float button logic
    let floatBtn = document.querySelector('.floating-menu-btn');
    if (!floatBtn) {
        floatBtn = document.createElement('button');
        floatBtn.className = 'floating-menu-btn';
        floatBtn.innerHTML = '<i class="fas fa-bars"></i>';
        floatBtn.onclick = () => {
            sidebar.classList.remove('collapsed');
            appContainer.classList.remove('sidebar-closed');
            floatBtn.style.display = 'none';
        };
        document.body.appendChild(floatBtn);
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            if (window.innerWidth <= 900) return; // Ignore on mobile/tablet
            sidebar.classList.add('collapsed');
            appContainer.classList.add('sidebar-closed');
            floatBtn.style.display = 'block';
        });
    }

    // Mobile Menu
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const brandLink = document.querySelector('.header-brand-link');

    // 点击 FluxNote 或菜单按钮打开侧边栏
    const toggleMobileSidebar = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = sidebar.classList.toggle('mobile-open');
        document.body.classList.toggle('sidebar-open', isOpen);
    };

    if (mobileBtn) {
        mobileBtn.addEventListener('click', toggleMobileSidebar);
    }
    if (brandLink) {
        brandLink.addEventListener('click', toggleMobileSidebar);
    }

    // Close sidebar with animation
    const closeMobileSidebar = () => {
        sidebar.classList.add('mobile-closing');
        sidebar.classList.remove('mobile-open');
        // Add closing class for overlay fade out
        document.body.classList.add('sidebar-closing');
        document.body.classList.remove('sidebar-open');
        // Remove closing classes after animation completes
        setTimeout(() => {
            sidebar.classList.remove('mobile-closing');
            document.body.classList.remove('sidebar-closing');
        }, 200);
    };

    document.addEventListener('click', (e) => {
        const isBrandOrBtn = (mobileBtn && mobileBtn.contains(e.target)) || (brandLink && brandLink.contains(e.target));
        if (window.innerWidth <= 900 && sidebar.classList.contains('mobile-open') && !sidebar.contains(e.target) && !isBrandOrBtn) {
            closeMobileSidebar();
        }
    });

    // Store close function for external use
    window.closeMobileSidebar = closeMobileSidebar;

    // Mobile sidebar close button
    const mobileCloseBtn = document.getElementById('sidebarMobileClose');
    if (mobileCloseBtn) {
        mobileCloseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMobileSidebar();
        });
    }

    // Search Clear Button
    const searchInput = document.getElementById('searchInput');
    const searchClearBtn = document.getElementById('searchClearBtn');
    const headerSearch = document.querySelector('.header-search');

    if (searchInput && searchClearBtn && headerSearch) {
        // Show/hide clear button based on input value
        const updateClearButton = () => {
            if (searchInput.value.trim()) {
                headerSearch.classList.add('has-value');
            } else {
                headerSearch.classList.remove('has-value');
            }
        };

        searchInput.addEventListener('input', updateClearButton);
        updateClearButton(); // Initial check

        // Clear input on button click
        searchClearBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchInput.focus();
            headerSearch.classList.remove('has-value');
            loadNotes(true);
        });
    }

    // Compact Editor on Scroll (Mobile) - 监听笔记列表区域滚动
    const memoEditor = document.querySelector('.memo-editor');
    const notesStream = document.querySelector('.notes-stream');
    let lastScrollTop = 0;

    if (notesStream && memoEditor) {
        notesStream.addEventListener('scroll', () => {
            if (window.innerWidth <= 900 && memoEditor.style.display !== 'none') {
                const currentScrollTop = notesStream.scrollTop;

                if (currentScrollTop > 50 && currentScrollTop > lastScrollTop) {
                    // 向下滚动 - 收缩编辑器
                    memoEditor.classList.add('compact');
                } else if (currentScrollTop < lastScrollTop - 10) {
                    // 向上滚动 - 展开编辑器
                    memoEditor.classList.remove('compact');
                }

                lastScrollTop = currentScrollTop;
            }
        });
    }

    // Search
    document.getElementById('searchInput')?.addEventListener('input', debounce(() => {
        loadNotes(true);
    }, 300));

    // Home Click
    document.querySelector('.header-left')?.addEventListener('click', () => {
        setState('currentFilterTag', '');
        setState('currentDateFilter', '');
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = '';
        loadNotes(true);
        ui.updateHeaderDate();
        loadTags();
    });

    // Infinite Scroll - 监听笔记列表区域
    if (notesStream) {
        notesStream.addEventListener('scroll', () => {
            const searchInput = document.getElementById('searchInput');
            if (searchInput && searchInput.value.trim() !== '') return;
            if (notesStream.scrollTop + notesStream.clientHeight >= notesStream.scrollHeight - 300) {
                if (!state.isLoading && state.hasNextPage) {
                    loadNotes(false);
                }
            }
        });
    }

    // Save Note
    document.getElementById('saveNote')?.addEventListener('click', async () => {
        const content = document.getElementById('noteContent').value.trim();
        const isPublic = document.getElementById('noteIsPublic').checked;
        const saveBtn = document.getElementById('saveNote');

        if (!content) return showToast('内容不能为空');

        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        const res = await api.notes.create({ content, tags: state.currentTags, is_public: isPublic });

        if (res && res.ok) {
            document.getElementById('noteContent').value = '';
            localStorage.removeItem('note_draft_content');
            setState('currentTags', []);
            ui.renderTags('input');
            loadData(); // Reload all
            showToast('已记录');
        } else {
            showToast('保存失败');
        }

        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    });

    // Tag Input Toggle
    const tagInput = document.getElementById('tagInput');
    const toggleTagBtn = document.getElementById('toggleTagInputBtn');
    if (toggleTagBtn && tagInput) {
        // 手机端：#按钮变成添加标签功能
        toggleTagBtn.addEventListener('click', () => {
            if (window.innerWidth <= 900) {
                // 手机端
                const val = tagInput.value.trim();
                if (val) {
                    // 有内容，添加标签
                    if (!state.currentTags.includes(val)) {
                        state.currentTags.push(val);
                        ui.renderTags('input');
                    }
                    tagInput.value = '';
                }
                // 无论有没有内容，都聚焦输入框
                tagInput.focus();
            } else {
                // 桌面端：切换输入框显示
                tagInput.style.display = tagInput.style.display === 'none' ? 'inline-block' : 'none';
                if (tagInput.style.display !== 'none') tagInput.focus();
            }
        });

        tagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = tagInput.value.trim();
                if (val && !state.currentTags.includes(val)) {
                    state.currentTags.push(val);
                    ui.renderTags('input');
                    tagInput.value = '';
                }
            }
        });
    }

    // Image Upload Button
    const imageUploadBtn = document.querySelector('.memo-editor .tool-btn[title="上传图片"]');
    if (imageUploadBtn) {
        imageUploadBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('file', file);
                showToast('正在上传图片...');

                const res = await api.upload(formData);
                if (res && res.ok) {
                    const data = await res.json();
                    const noteContent = document.getElementById('noteContent');
                    const md = `\n![image](${data.url})\n`;
                    if (noteContent.setRangeText) {
                        noteContent.setRangeText(md);
                    } else {
                        noteContent.value += md;
                    }
                    showToast('图片上传成功');
                } else {
                    showToast('上传失败');
                }
            };
            fileInput.click();
        });
    }

    // === Custom Events from UI ===

    window.addEventListener('filter:tag', (e) => {
        setState('currentFilterTag', e.detail);
        loadNotes(true);
        // Update UI active state manually or re-render sidebar tags?
        // Re-rendering sidebar tags is safer to update active class
        ui.renderSidebarTags(document.querySelectorAll('.sidebar-tag').length > 0 ? Array.from(document.querySelectorAll('.sidebar-tag')).map(b => b.dataset.tag).filter(Boolean) : []);
        // Actually we should just refetch tags or iterate DOM.
        // Let's just iterate DOM for efficiency
        document.querySelectorAll('.sidebar-tag').forEach(btn => {
            if (btn.dataset.tag === e.detail) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    });

    window.addEventListener('filter:date', (e) => {
        if (state.currentDateFilter === e.detail) {
             setState('currentDateFilter', '');
        } else {
             setState('currentDateFilter', e.detail);
        }
        loadNotes(true);
        ui.updateHeaderDate();
        ui.renderHeatmap(); // Re-render to update selection stroke
    });

    window.addEventListener('filter:date-clear', () => {
        setState('currentDateFilter', '');
        loadNotes(true);
        ui.updateHeaderDate();
        ui.renderHeatmap();
    });

    window.addEventListener('tag:remove', (e) => {
        const { tag, type } = e.detail;
        if (type === 'input') {
            setState('currentTags', state.currentTags.filter(t => t !== tag));
            ui.renderTags('input');
        }
    });

    window.addEventListener('note:refresh-list', () => loadNotes(true));

    window.addEventListener('note:delete', async (e) => {
        const confirmed = await showConfirm('确定要删除这条笔记吗？', { title: '删除笔记', type: 'danger' });
        if (!confirmed) return;
        const res = await api.notes.delete(e.detail);
        if (res && res.ok) {
            showToast('已删除');
            const card = document.getElementById(`note-${e.detail}`);
            if (card) {
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            }
            ui.renderHeatmap();
        } else {
            showToast('删除失败');
        }
    });

    window.addEventListener('note:permanent-delete', async (e) => {
        const confirmed = await showConfirm('彻底删除后无法恢复，确定吗？', { title: '彻底删除', type: 'danger' });
        if (!confirmed) return;
        const res = await api.notes.permanentDelete(e.detail);
        if (res && res.ok) {
            showToast('已彻底删除');
            document.getElementById(`note-${e.detail}`)?.remove();
        } else {
            showToast('删除失败');
        }
    });

    window.addEventListener('note:restore', async (e) => {
        const res = await api.notes.restore(e.detail);
        if (res && res.ok) {
            showToast('已恢复');
            document.getElementById(`note-${e.detail}`)?.remove();
        } else {
            showToast('恢复失败');
        }
    });

    window.addEventListener('note:edit', (e) => {
        ui.startInlineEdit(e.detail);
    });

    window.addEventListener('note:toggle-task', async (e) => {
        const { id, index, checked } = e.detail;
        const note = state.notes.find(n => n.id == id);
        if (!note) return;

        let count = 0;
        // Use a similar regex to what ui.js uses for normalization to find the n-th checkbox
        const newContent = note.content.replace(/^(\s*[-*])\s*\[([ xX]?)\]/gm, (match, p1, p2) => {
            if (count === index) {
                count++;
                return `${p1} [${checked ? 'x' : ' '}]`;
            }
            count++;
            return match;
        });

        if (newContent === note.content) return;

        const res = await api.notes.update(id, { content: newContent });
        if (res && res.ok) {
            note.content = newContent;
            // Update the card locally to reflect changes (and re-bind events)
            ui.restoreCard(note);
        } else {
            showToast('更新失败');
            ui.restoreCard(note); // Revert UI state
        }
    });

    window.addEventListener('note:history', async (e) => {
        const noteId = e.detail;
        const modal = document.getElementById('versionModal');
        const list = document.getElementById('versionList');
        const preview = document.getElementById('versionPreview');

        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '加载中...';
            preview.style.display = 'none';

            modal.querySelector('.close-version').onclick = () => modal.style.display = 'none';
            window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

            const res = await api.notes.versions(noteId);
            if (res) {
                const versions = await res.json();
                if (versions.length === 0) {
                    list.innerHTML = '暂无历史版本';
                    return;
                }
                list.innerHTML = versions.map(v => `
                    <div class="version-item">
                        <div class="version-info">
                            <span class="version-date">${v.created_at}</span>
                            <span class="version-meta">${v.title || '无标题'}</span>
                        </div>
                        <div class="version-actions">
                            <button class="btn btn-secondary btn-sm preview-v-btn" data-json='${JSON.stringify(v).replace(/'/g, "&#39;")}'>预览</button>
                            <button class="btn btn-primary btn-sm restore-v-btn" data-vid="${v.id}">恢复</button>
                        </div>
                    </div>
                `).join('');

                list.querySelectorAll('.preview-v-btn').forEach(btn => {
                    btn.onclick = () => {
                        const v = JSON.parse(btn.dataset.json);
                        let content = v.content;
                        try {
                            if (typeof marked !== 'undefined') content = DOMPurify.sanitize(marked.parse(content));
                        } catch(e) {}
                        preview.innerHTML = `<div class="version-preview-header">预览版本: ${v.created_at}</div>` + content;
                        preview.style.display = 'block';
                    };
                });

                list.querySelectorAll('.restore-v-btn').forEach(btn => {
                    btn.onclick = async () => {
                        const confirmed = await showConfirm('确定要恢复到此版本吗？', { title: '恢复版本' });
                        if (!confirmed) return;
                        const r = await api.notes.restoreVersion(noteId, btn.dataset.vid);
                        if (r && r.ok) {
                            showToast('已恢复版本');
                            modal.style.display = 'none';
                            loadNotes(true);
                        } else {
                            showToast('恢复失败');
                        }
                    };
                });
            }
        }
    });

    // 分享功能
    window.addEventListener('note:share', async (e) => {
        const noteId = e.detail;
        const note = state.notes.find(n => n.id == noteId);
        if (!note) return;

        const modal = document.getElementById('shareModal');
        if (!modal) return;

        // 填充预览卡片
        const cardTitle = document.getElementById('shareCardTitle');
        const cardContent = document.getElementById('shareCardContent');
        const cardDate = document.getElementById('shareCardDate');
        const cardTags = document.getElementById('shareCardTags');

        if (cardTitle) {
            // Optimize title display: Always try to clean the title, whether from DB or content
            let titleText = note.title;
            
            // If no title, extract from content
            if (!titleText) {
                titleText = note.content.split('\n')[0].trim();
            }
            
            // Apply cleaning to titleText (whether from DB or extracted)
            if (titleText) {
                // Strip common markdown markers (#, ##, - [ ], - [x], *, -, 1.)
                titleText = titleText.replace(/^(#+\s+|[-*]\s+(\[[ xX]?\]\s+)?|\d+\.\s+|>\s+)/, '');
                // Truncate if too long
                if (titleText.length > 50) titleText = titleText.substring(0, 50) + '...';
            }
            
            cardTitle.textContent = titleText || '无标题';
        }

        // 生成分享链接
        const res = await api.share.create({
            note_id: noteId,
            expires_in: 0  // 默认永久
        });

        if (res && res.ok) {
            const data = await res.json();
            const shareUrl = document.getElementById('shareUrl');
            shareUrl.value = window.location.origin + data.share.url;
            shareUrl.dataset.shareId = data.share.id;
            shareUrl.dataset.noteId = noteId;  // 保存 noteId
        } else {
            showToast('创建分享失败');
            return;
        }

        // 先显示模态框，确保 Mermaid 能正确计算尺寸
        modal.style.display = 'block';

        // 渲染 Markdown 内容 (Moved logic here to run after modal is visible)
        if (cardContent) {
            let content = note.content;
            
            // 解析 Markdown
            try {
                if (typeof marked !== 'undefined') {
                    // 处理 wiki 链接
                    if (typeof parseWikiLinks !== 'undefined') {
                        content = parseWikiLinks(content);
                    }
                    let html = marked.parse(content);
                    if (typeof DOMPurify !== 'undefined') {
                        html = DOMPurify.sanitize(html);
                    }
                    cardContent.innerHTML = html;
                    cardContent.classList.add('markdown-body');

                    // 渲染 Mermaid (now that container is visible)
                    if (ui && ui.renderMermaid) {
                        await ui.renderMermaid(cardContent);
                    }

                    // 高亮代码
                    if (typeof hljs !== 'undefined') {
                        cardContent.querySelectorAll('pre code').forEach(block => {
                            const isMermaid = block.classList.contains('language-mermaid') || 
                                             block.classList.contains('language-mindmap');
                            if (!isMermaid) {
                                hljs.highlightElement(block);
                            }
                        });
                    }

                } else {
                    // 降级为纯文本
                    cardContent.textContent = content.replace(/[#*`\[\]]/g, '');
                }
            } catch (err) {
                console.error(err);
                cardContent.textContent = content;
            }
        }

        if (cardDate) cardDate.textContent = new Date(note.created_at).toLocaleDateString('zh-CN');

        // 显示标签
        if (cardTags && note.tags && note.tags.length > 0) {
            cardTags.innerHTML = note.tags.map(t => `<span class="share-card-tag">#${t}</span>`).join('');
            cardTags.style.display = 'flex';
        } else if (cardTags) {
            cardTags.style.display = 'none';
        }

        // 重置表单
        document.getElementById('sharePassword').value = '';
        document.getElementById('sharePassword').disabled = true;
        document.getElementById('sharePasswordEnabled').checked = false;
        document.getElementById('shareExpires').value = '0';

        // 关闭按钮
        modal.querySelector('.close-share').onclick = () => modal.style.display = 'none';
        window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

        // 密码开关
        document.getElementById('sharePasswordEnabled').onchange = (ev) => {
            document.getElementById('sharePassword').disabled = !ev.target.checked;
        };
    });

    // 复制分享链接
    document.getElementById('copyShareUrl')?.addEventListener('click', () => {
        const input = document.getElementById('shareUrl');
        input.select();
        document.execCommand('copy');
        showToast('链接已复制');
    });

    // 下载分享卡片
    document.getElementById('downloadShareCard')?.addEventListener('click', async () => {
        const card = document.getElementById('shareCard');
        if (!card) return;

        try {
            // 动态加载 html2canvas
            if (typeof html2canvas === 'undefined') {
                const script = document.createElement('script');
                script.src = 'https://mirrors.sustech.edu.cn/cdnjs/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                document.head.appendChild(script);
                await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                });
            }

            const canvas = await html2canvas(card, {
                backgroundColor: '#ffffff',
                scale: 2
            });

            const link = document.createElement('a');
            link.download = 'share-card.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
            showToast('卡片已下载');
        } catch (err) {
            console.error('生成卡片失败', err);
            showToast('生成卡片失败');
        }
    });

    // 更新分享设置
    document.getElementById('updateShare')?.addEventListener('click', async () => {
        const shareUrl = document.getElementById('shareUrl');
        const shareId = shareUrl?.dataset.shareId;
        const noteId = shareUrl?.dataset.noteId;
        if (!shareId || !noteId) return;

        const password = document.getElementById('sharePassword').value.trim();
        const expires = document.getElementById('shareExpires').value;

        // 目前简单实现：删除旧分享，创建新分享
        await api.share.delete(shareId);

        let expiresIn = null;
        if (expires === '24') expiresIn = 24;
        else if (expires === '168') expiresIn = 168;
        else if (expires === '720') expiresIn = 720;

        // 重新创建分享
        const res = await api.share.create({
            note_id: noteId,
            password: document.getElementById('sharePasswordEnabled').checked ? password : '',
            expires_in: expiresIn
        });

        if (res && res.ok) {
            const data = await res.json();
            shareUrl.value = window.location.origin + data.share.url;
            shareUrl.dataset.shareId = data.share.id;
            showToast('设置已更新');
        } else {
            showToast('更新失败');
        }
    });
}

function switchView(view) {
    const navAll = document.getElementById('navAllNotes');
    const navTrash = document.getElementById('navTrash');

    if (view === 'trash') {
        setState('isTrashMode', true);
        navTrash?.classList.add('active');
        navAll?.classList.remove('active');
        document.getElementById('noteInputSection').style.display = 'none';
        document.querySelector('.header-left span:last-child').textContent = '回收站';
    } else {
        setState('isTrashMode', false);
        navAll?.classList.add('active');
        navTrash?.classList.remove('active');
        if (state.currentUser) {
            document.getElementById('noteInputSection').style.display = 'block';
        }
        ui.updateHeaderDate();
    }

    setState('currentFilterTag', '');
    setState('currentDateFilter', '');
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    loadNotes(true);
}
