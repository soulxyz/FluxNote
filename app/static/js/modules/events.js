import { api } from './api.js';
import { state, setState } from './state.js';
import { ui } from './ui.js';
import { showToast, debounce, parseWikiLinks, escapeHtml, showConfirm, formatDate, formatExpiresAt } from './utils.js';

// 防止重复绑定的标志
let eventsInitialized = false;

export function initGlobalEvents(context) {
    if (eventsInitialized) {
        console.warn('Global events already initialized, skipping...');
        return;
    }

    const { loadNotes, loadTags, switchView } = context;

    // Navigation
    document.getElementById('navAllNotes')?.addEventListener('click', (e) => {
        e.preventDefault();
        switchView('all');
    });
    document.getElementById('navTrash')?.addEventListener('click', (e) => {
        e.preventDefault();
        switchView('trash');
    });

    // Daily Review
    document.getElementById('navDailyReview')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const modal = document.getElementById('reviewModal');
        const list = document.getElementById('reviewList');
        
        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:20px;">加载中...</div>';
            
            const closeBtn = modal.querySelector('.close-review');
            if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
            
            const outsideClick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };
            window.addEventListener('click', outsideClick);
            // Cleanup on close to avoid leaking listeners if needed, but for modal simple toggle is fine.

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

    // My Shares Modal logic
    initSharesModal();

    // Sidebar Toggle
    initSidebarLogic();

    // Search Logic
    initSearchLogic(loadNotes);

    // Editor Auto-Resize & Logic
    initEditorLogic(loadNotes);

    // Custom Events (Event Bus)
    initCustomEvents(loadNotes, loadTags);

    eventsInitialized = true;
    console.log('Global events initialized');
}

function initSharesModal() {
    let allShares = []; 

    document.getElementById('navShares')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const modal = document.getElementById('sharesModal');
        const list = document.getElementById('sharesList');

        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:40px; color:var(--slate-400);"><i class="fas fa-spinner fa-spin" style="font-size: 24px;"></i><p style="margin-top: 12px;">加载中...</p></div>';

            const closeBtn = modal.querySelector('.close-shares');
            if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
            
            const outsideClick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };
            window.addEventListener('click', outsideClick);

            try {
                const response = await fetch('/api/shares');
                if (response.ok) {
                    allShares = await response.json();
                    renderSharesList(allShares);
                } else {
                    list.innerHTML = '<div class="shares-empty"><i class="fas fa-exclamation-circle"></i><p>加载失败，请重试</p></div>';
                }
            } catch (err) {
                console.error(err);
                list.innerHTML = '<div class="shares-empty"><i class="fas fa-wifi"></i><p>网络错误</p></div>';
            }
        }
    });

    function renderSharesList(shares) {
        const list = document.getElementById('sharesList');
        const searchInput = document.getElementById('sharesSearchInput');
        const statusFilter = document.getElementById('sharesStatusFilter');
        const sortFilter = document.getElementById('sharesSortFilter');
        
        if (!list) return;

        const searchTerm = searchInput?.value.toLowerCase() || '';
        const status = statusFilter?.value || 'all';
        const sortBy = sortFilter?.value || 'newest';

        let filtered = shares.filter(s => {
            const matchSearch = !searchTerm || (s.note_title || '').toLowerCase().includes(searchTerm);
            const isExpired = s.is_expired || (s.expires_at && new Date(s.expires_at) < new Date());
            const matchStatus = status === 'all' ||
                              (status === 'active' && !isExpired) ||
                              (status === 'expired' && isExpired);
            return matchSearch && matchStatus;
        });

        filtered.sort((a, b) => {
            switch (sortBy) {
                case 'oldest': return new Date(a.created_at) - new Date(b.created_at);
                case 'views': return b.view_count - a.view_count;
                case 'expiring':
                    if (!a.expires_at) return 1;
                    if (!b.expires_at) return -1;
                    return new Date(a.expires_at) - new Date(b.expires_at);
                default: return new Date(b.created_at) - new Date(a.created_at);
            }
        });

        updateSharesStats(shares);

        if (filtered.length === 0) {
            list.innerHTML = `<div class="shares-empty"><i class="fas fa-share-alt"></i><p>${shares.length === 0 ? '暂无分享记录' : '没有匹配的分享'}</p></div>`;
            return;
        }

        list.innerHTML = filtered.map(s => {
            const isExpired = s.is_expired || (s.expires_at && new Date(s.expires_at) < new Date());
            return `
                <div class="share-item ${isExpired ? 'expired' : ''}" id="share-item-${s.id}">
                    <div class="share-item-header">
                        <div class="share-item-title"><i class="fas fa-file-alt"></i> ${escapeHtml(s.note_title || '无标题')}</div>
                        <div class="share-item-status">
                            ${s.has_password ? '<span class="status-badge protected"><i class="fas fa-lock"></i> 已加密</span>' : ''}
                            ${isExpired ? '<span class="status-badge expired">已过期</span>' : '<span class="status-badge active">活跃中</span>'}
                        </div>
                    </div>
                    <div class="share-item-meta">
                        <span><i class="far fa-clock"></i> ${formatDate(s.created_at)}</span>
                        <span><i class="far fa-eye"></i> ${s.view_count} 次浏览</span>
                        <span><i class="fas fa-hourglass-half"></i> ${formatExpiresAt(s.expires_at)}</span>
                    </div>
                    <div class="share-item-url"><i class="fas fa-link"></i> <span>${s.url}</span></div>
                    <div class="share-item-actions">
                        <button class="btn btn-secondary btn-sm copy-share-btn" data-url="${s.url}"><i class="fas fa-copy"></i> 复制</button>
                        <button class="btn btn-secondary btn-sm edit-share-btn" data-id="${s.id}" data-password="${s.has_password}" data-expired="${isExpired}"><i class="fas fa-edit"></i> ${isExpired ? '重新激活' : '编辑'}</button>
                        ${!isExpired ? `<button class="btn btn-warning btn-sm expire-share-btn" data-id="${s.id}"><i class="fas fa-clock"></i> 过期</button>` : ''}
                        <button class="btn btn-danger btn-sm delete-share-btn" data-id="${s.id}"><i class="fas fa-trash"></i> 删除</button>
                    </div>
                </div>
            `;
        }).join('');

        // Bind events
        list.querySelectorAll('.copy-share-btn').forEach(btn => {
            btn.onclick = () => navigator.clipboard.writeText(btn.dataset.url).then(() => showToast('链接已复制'));
        });

        list.querySelectorAll('.edit-share-btn').forEach(btn => {
            btn.onclick = () => showEditShareModal(btn.dataset.id, btn.dataset.password === 'true', btn.dataset.expired === 'true', () => {
                 // Refresh list callback
                 fetch('/api/shares').then(r => r.json()).then(data => {
                     allShares = data;
                     renderSharesList(allShares);
                 });
            });
        });
        
        list.querySelectorAll('.expire-share-btn').forEach(btn => {
            btn.onclick = async () => {
                if(await showConfirm('确定要让此分享立即过期吗？', { title: '设为过期', type: 'danger' })) {
                    const res = await fetch(`/api/share/${btn.dataset.id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({expire_now: true})});
                    if(res.ok) {
                        const data = await (await fetch('/api/shares')).json();
                        allShares = data;
                        renderSharesList(allShares);
                        showToast('分享已过期');
                    }
                }
            };
        });

        list.querySelectorAll('.delete-share-btn').forEach(btn => {
            btn.onclick = async () => {
                if(await showConfirm('链接将失效，确定要删除此分享吗？', { title: '删除分享', type: 'danger' })) {
                    const res = await api.share.delete(btn.dataset.id);
                    if(res && res.ok) {
                        allShares = allShares.filter(s => s.id !== btn.dataset.id);
                        renderSharesList(allShares);
                        showToast('分享已删除');
                    }
                }
            };
        });
    }

    function updateSharesStats(shares) {
        const total = shares.length;
        const active = shares.filter(s => !(s.is_expired || (s.expires_at && new Date(s.expires_at) < new Date()))).length;
        const totalViews = shares.reduce((sum, s) => sum + (s.view_count || 0), 0);
        
        const elTotal = document.getElementById('totalSharesCount');
        if(elTotal) elTotal.textContent = total;
        const elActive = document.getElementById('activeSharesCount');
        if(elActive) elActive.textContent = active;
        const elViews = document.getElementById('totalViewsCount');
        if(elViews) elViews.textContent = totalViews;
    }

    // Bind Search/Filter Inputs
    document.getElementById('sharesSearchInput')?.addEventListener('input', () => renderSharesList(allShares));
    document.getElementById('sharesStatusFilter')?.addEventListener('change', () => renderSharesList(allShares));
    document.getElementById('sharesSortFilter')?.addEventListener('change', () => renderSharesList(allShares));
}

let currentEditShareId = null;
function showEditShareModal(shareId, hasPassword, isExpired, onSuccess) {
    const modal = document.getElementById('editShareModal');
    const passwordEnabled = document.getElementById('editSharePasswordEnabled');
    const passwordInput = document.getElementById('editSharePassword');
    const expiresSelect = document.getElementById('editShareExpires');
    const warningDiv = document.getElementById('expiredWarning');
    const titleEl = document.getElementById('editShareModalTitle');
    const saveText = document.getElementById('saveEditShareText');
    const saveBtn = document.getElementById('saveEditShare');

    currentEditShareId = shareId;

    if (isExpired) {
        titleEl.innerHTML = '<i class="fas fa-redo" style="margin-right: 8px; color: #d97706;"></i>重新激活分享';
        warningDiv.style.display = 'block';
        expiresSelect.value = '168';
        saveText.textContent = '重新激活';
    } else {
        titleEl.innerHTML = '<i class="fas fa-edit" style="margin-right: 8px; color: var(--primary);"></i>编辑分享设置';
        warningDiv.style.display = 'none';
        expiresSelect.value = '';
        saveText.textContent = '保存修改';
    }

    passwordEnabled.checked = hasPassword;
    passwordInput.disabled = !hasPassword;
    passwordInput.value = '';
    
    passwordEnabled.onchange = (e) => {
        passwordInput.disabled = !e.target.checked;
        if (!e.target.checked) passwordInput.value = '';
    };

    modal.style.display = 'block';
    
    // Unbind old click to prevent multiple submits
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    newSaveBtn.onclick = async () => {
        const pwd = passwordInput.value;
        const exp = expiresSelect.value;
        
        if (warningDiv.style.display !== 'none' && exp === '') {
            showToast('请选择有效期');
            return;
        }

        try {
            const res = await fetch(`/api/share/${currentEditShareId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: passwordEnabled.checked ? pwd : null,
                    expires_in: exp !== '' ? parseInt(exp) : null
                })
            });

            if (res.ok) {
                modal.style.display = 'none';
                showToast(warningDiv.style.display !== 'none' ? '分享已重新激活' : '分享设置已更新');
                if (onSuccess) onSuccess();
            } else {
                const data = await res.json();
                showToast(data.error || '更新失败');
            }
        } catch (err) {
            console.error(err);
            showToast('网络错误');
        }
    };

    modal.querySelector('.close-edit-share').onclick = () => modal.style.display = 'none';
    document.getElementById('cancelEditShare').onclick = () => modal.style.display = 'none';
}

function initSidebarLogic() {
    const toggleBtn = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const appContainer = document.querySelector('.app-container');
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const brandLink = document.querySelector('.header-brand-link');

    // Float button logic
    let floatBtn = document.querySelector('.floating-menu-btn');
    if (!floatBtn) {
        floatBtn = document.createElement('button');
        floatBtn.className = 'floating-menu-btn';
        floatBtn.innerHTML = '<i class="fas fa-bars"></i>';
        floatBtn.onclick = () => {
            sidebar.classList.remove('collapsed');
            appContainer?.classList.remove('sidebar-closed');
            floatBtn.style.display = 'none';
        };
        document.body.appendChild(floatBtn);
    }

    toggleBtn?.addEventListener('click', () => {
        if (window.innerWidth <= 900) return;
        sidebar.classList.add('collapsed');
        appContainer?.classList.add('sidebar-closed');
        floatBtn.style.display = 'block';
    });

    const toggleMobileSidebar = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = sidebar.classList.toggle('mobile-open');
        document.body.classList.toggle('sidebar-open', isOpen);
    };

    mobileBtn?.addEventListener('click', toggleMobileSidebar);
    brandLink?.addEventListener('click', toggleMobileSidebar);
    
    // Mobile Close Logic
    window.closeMobileSidebar = () => {
        sidebar.classList.add('mobile-closing');
        sidebar.classList.remove('mobile-open');
        document.body.classList.add('sidebar-closing');
        document.body.classList.remove('sidebar-open');
        setTimeout(() => {
            sidebar.classList.remove('mobile-closing');
            document.body.classList.remove('sidebar-closing');
        }, 200);
    };

    document.getElementById('sidebarMobileClose')?.addEventListener('click', (e) => {
        e.stopPropagation();
        window.closeMobileSidebar();
    });

    document.addEventListener('click', (e) => {
        const isBrandOrBtn = (mobileBtn && mobileBtn.contains(e.target)) || (brandLink && brandLink.contains(e.target));
        if (window.innerWidth <= 900 && sidebar.classList.contains('mobile-open') && !sidebar.contains(e.target) && !isBrandOrBtn) {
            window.closeMobileSidebar();
        }
    });
}

function initSearchLogic(loadNotes) {
    const searchInput = document.getElementById('searchInput');
    const searchClearBtn = document.getElementById('searchClearBtn');
    const headerSearch = document.querySelector('.header-search');

    if (searchInput && searchClearBtn && headerSearch) {
        const updateClearButton = () => {
            if (searchInput.value.trim()) headerSearch.classList.add('has-value');
            else headerSearch.classList.remove('has-value');
        };

        searchInput.addEventListener('input', () => {
            updateClearButton();
            // Debounce handled by events bus logic calling loadNotes
        });
        
        // Debounce search input triggering loadNotes
        searchInput.addEventListener('input', debounce(() => {
            loadNotes(true);
        }, 300));

        updateClearButton();

        searchClearBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchInput.focus();
            headerSearch.classList.remove('has-value');
            loadNotes(true);
        });
    }

    document.querySelector('.header-left')?.addEventListener('click', () => {
        setState('currentFilterTag', '');
        setState('currentDateFilter', '');
        if (searchInput) searchInput.value = '';
        loadNotes(true);
        ui.updateHeaderDate();
        window.dispatchEvent(new CustomEvent('tags:refresh'));
    });
}

function initEditorLogic(loadNotes) {
    const memoEditor = document.querySelector('.memo-editor');
    const notesStream = document.querySelector('.notes-stream');
    const textarea = document.getElementById('noteContent');
    
    let lastScrollTop = 0;
    let lastUserAction = 'none'; // 'scroll_top', 'click_notes', 'manual_expand'
    let isManuallyExpanded = false;
    let scrollLock = false;
    let actionCooldown = 0;
    let lastClickTime = 0;

    // Track user typing activity
    if (textarea) {
        textarea.addEventListener('input', () => {
            isManuallyExpanded = true;
            if (memoEditor && memoEditor.classList.contains('compact')) {
                memoEditor.classList.remove('compact');
            }
            lastUserAction = 'manual_expand';
        });

        textarea.addEventListener('focus', () => {
            isManuallyExpanded = true;
            if (memoEditor) memoEditor.classList.remove('compact');
            lastUserAction = 'manual_expand';
        });
    }

    if (notesStream && memoEditor) {
        // Precise state logic
        const updateEditorState = () => {
            if (window.innerWidth > 900) {
                memoEditor.classList.remove('compact');
                return;
            }

            const now = Date.now();
            if (now < actionCooldown) return;

            const currentScrollTop = notesStream.scrollTop;
            const scrollDirection = currentScrollTop > lastScrollTop ? 'down' : 'up';
            const noteCount = document.querySelectorAll('.note-card').length;
            
            memoEditor.style.transition = 'height 0.3s ease, transform 0.3s ease';

            // Rule 1: Only expand when scrolled to very top (within 30px of top)
            if (currentScrollTop <= 30 && scrollDirection === 'up') {
                if (memoEditor.classList.contains('compact')) {
                    memoEditor.classList.remove('compact');
                    isManuallyExpanded = false; // Reset manual state when auto-expanded at top
                    actionCooldown = now + 800;
                }
                lastUserAction = 'scroll_top';
            }
            // Rule 2: Compact when scrolled down significantly OR when clicking note stream
            else if ((currentScrollTop > 80 && noteCount > 1) || lastUserAction === 'click_notes') {
                if (!memoEditor.classList.contains('compact')) {
                    memoEditor.classList.add('compact');
                    actionCooldown = now + 1000;
                    scrollLock = true;
                    setTimeout(() => { scrollLock = false; }, 1200);
                }
                if (lastUserAction === 'click_notes') {
                    lastUserAction = 'none';
                }
            }
            // Rule 3: If manually expanded, stay expanded unless scrolled far down
            else if (isManuallyExpanded) {
                if (currentScrollTop > 200) {
                    memoEditor.classList.add('compact');
                    isManuallyExpanded = false;
                    actionCooldown = now + 800;
                } else {
                    memoEditor.classList.remove('compact');
                }
            }

            lastScrollTop = currentScrollTop;
        };

        // Optimized scroll handler
        let isScrolling = false;
        const handleScroll = () => {
            if (scrollLock || window.innerWidth > 900) return;

            if (!isScrolling) {
                isScrolling = true;
                requestAnimationFrame(() => {
                    updateEditorState();
                    isScrolling = false;
                });
            }
        };

        // Handle clicks on note stream to compact editor
        document.addEventListener('click', (e) => {
            const now = Date.now();
            // Prevent rapid clicks
            if (now - lastClickTime < 300) return;

            lastClickTime = now;

            // Check if click is on note stream but not on editor or its children
            if (notesStream.contains(e.target) &&
                !memoEditor.contains(e.target) &&
                e.target !== textarea) {

                // Only compact if editor is visible and expanded
                if (memoEditor && !memoEditor.classList.contains('compact')) {
                    lastUserAction = 'click_notes';
                    actionCooldown = now + 500;
                    // Force immediate update
                    memoEditor.style.transition = 'height 0.3s ease, transform 0.3s ease';
                    memoEditor.classList.add('compact');
                }
            }
        });

        // Touch handling for mobile
        document.addEventListener('touchstart', (e) => {
            if (memoEditor.contains(e.target) && memoEditor.classList.contains('compact')) {
                isManuallyExpanded = true;
                lastUserAction = 'manual_expand';
            }
        });

        // Window resize handling
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (window.innerWidth > 900) {
                    memoEditor.classList.remove('compact');
                    isManuallyExpanded = false;
                } else {
                    updateEditorState();
                }
            }, 200);
        });

        // Initial setup
        notesStream.addEventListener('scroll', handleScroll);

        // Initial evaluation
        setTimeout(() => {
            if (window.innerWidth <= 900) {
                memoEditor.style.transition = 'height 0.4s ease, transform 0.4s ease';
                if (document.querySelectorAll('.note-card').length > 2) {
                    memoEditor.classList.add('compact');
                }
            }
        }, 500);
    }
    
    document.getElementById('saveNote')?.addEventListener('click', async () => {
        const content = document.getElementById('noteContent').value.trim();
        const isPublic = document.getElementById('noteIsPublic').checked;
        const saveBtn = document.getElementById('saveNote');

        if (!content) return showToast('内容不能为空');

        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        // Offline logic included in main.js, here we simplify or replicate?
        // Ideally we should use api.js which might handle offline logic, or keep the offline check here.
        
        if (!navigator.onLine) {
            const draftId = Date.now();
            const draft = {
                _id: draftId,
                content,
                tags: [...state.currentTags],
                is_public: isPublic,
                created_at: new Date().toISOString()
            };
            const drafts = JSON.parse(localStorage.getItem('offline_drafts') || '[]');
            drafts.push(draft);
            localStorage.setItem('offline_drafts', JSON.stringify(drafts));

            // UI Optimistic Update
            const tempNote = {
                id: `offline-${draftId}`,
                content: draft.content,
                tags: draft.tags,
                is_public: draft.is_public,
                created_at: draft.created_at,
                user_id: state.currentUser ? state.currentUser.id : -1,
                backlinks: [],
                is_offline_draft: true
            };
            const list = document.getElementById('notesList');
            if (list) {
                list.querySelector('.empty-state')?.remove();
                const card = ui.createNoteCard(tempNote);
                card.style.opacity = '0.85';
                list.insertBefore(card, list.firstChild);
            }

            document.getElementById('noteContent').value = '';
            localStorage.removeItem('note_draft_content');
            setState('currentTags', []);
            ui.renderTags('input');
            showToast('已保存到离线草稿，联网后自动同步');
            
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
            return;
        }

        try {
            const res = await api.notes.create({ content, tags: state.currentTags, is_public: isPublic });
            if (res && res.ok) {
                document.getElementById('noteContent').value = '';
                localStorage.removeItem('note_draft_content');
                setState('currentTags', []);
                ui.renderTags('input');
                loadNotes(true);
                showToast('已记录');
            } else {
                showToast('保存失败');
            }
        } catch (e) {
            console.error(e);
            showToast('保存失败');
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
        }
    });

    // Tag Input
    const tagInput = document.getElementById('tagInput');
    const toggleTagBtn = document.getElementById('toggleTagInputBtn');
    if (toggleTagBtn && tagInput) {
        toggleTagBtn.addEventListener('click', () => {
            if (window.innerWidth <= 900) {
                const val = tagInput.value.trim();
                if (val && !state.currentTags.includes(val)) {
                    state.currentTags.push(val);
                    ui.renderTags('input');
                    tagInput.value = '';
                }
                tagInput.focus();
            } else {
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

    // Image Upload
    const imageUploadBtn = document.querySelector('.memo-editor .tool-btn[title="上传图片"]');
    imageUploadBtn?.addEventListener('click', () => {
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
                const md = `
![image](${data.url})
`;
                if (noteContent.setRangeText) noteContent.setRangeText(md);
                else noteContent.value += md;
                showToast('图片上传成功');
            } else {
                showToast('上传失败');
            }
        };
        fileInput.click();
    });

    // Infinite Scroll
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
}

function initCustomEvents(loadNotes, loadTags) {
    window.addEventListener('filter:tag', (e) => {
        setState('currentFilterTag', e.detail);
        loadNotes(true);
        document.querySelectorAll('.sidebar-tag').forEach(btn => {
            if (btn.dataset.tag === e.detail) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    });

    window.addEventListener('filter:date', (e) => {
        setState('currentDateFilter', state.currentDateFilter === e.detail ? '' : e.detail);
        loadNotes(true);
        ui.updateHeaderDate();
        ui.renderHeatmap();
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
    window.addEventListener('tags:refresh', () => loadTags());

    // Note Action Events
    window.addEventListener('note:delete', async (e) => {
        if(!await showConfirm('确定要删除这条笔记吗？', { title: '删除笔记', type: 'danger' })) return;
        
        const id = e.detail;
        if (!navigator.onLine) {
            handleOfflineDelete(id);
            return;
        }

        const res = await api.notes.delete(id);
        if (res && res.ok) {
            showToast('已删除');
            removeCardFromUI(id);
            ui.renderHeatmap();
            loadTags();
        } else {
            showToast('删除失败');
        }
    });

    window.addEventListener('note:permanent-delete', async (e) => {
        if (!navigator.onLine) return showToast('离线模式暂不支持彻底删除');
        if(!await showConfirm('彻底删除后无法恢复，确定吗？', { title: '彻底删除', type: 'danger' })) return;

        const res = await api.notes.permanentDelete(e.detail);
        if (res && res.ok) {
            showToast('已彻底删除');
            removeCardFromUI(e.detail);
            loadTags();
        } else {
            showToast('删除失败');
        }
    });

    window.addEventListener('note:restore', async (e) => {
        if (!navigator.onLine) return showToast('离线模式暂不支持恢复笔记');
        const res = await api.notes.restore(e.detail);
        if (res && res.ok) {
            showToast('已恢复');
            removeCardFromUI(e.detail);
            loadTags();
        } else {
            showToast('恢复失败');
        }
    });

    window.addEventListener('note:edit', (e) => ui.startInlineEdit(e.detail));

    window.addEventListener('note:toggle-task', async (e) => {
        const { id, index, checked } = e.detail;
        const note = state.notes.find(n => n.id == id);
        if (!note) return;

        let count = 0;
        const newContent = note.content.replace(/^(\s*[-*])\s*\[([ xX]?)\]/gm, (match, p1, p2) => {
            if (count === index) { count++; return `${p1} [${checked ? 'x' : ' '}]`; }
            count++; return match;
        });

        if (newContent === note.content) return;

        if (!navigator.onLine) {
            handleOfflineUpdate(id, { content: newContent });
            note.content = newContent;
            ui.restoreCard(note);
            return;
        }

        const res = await api.notes.update(id, { content: newContent });
        if (res && res.ok) {
            note.content = newContent;
            ui.restoreCard(note);
        } else {
            showToast('更新失败');
            ui.restoreCard(note);
        }
    });

    window.addEventListener('note:request-update', async (e) => {
        const { id, content, tags, is_public } = e.detail;
        const note = state.notes.find(n => n.id == id);
        
        if (!navigator.onLine) {
            handleOfflineUpdate(id, { content, tags, is_public });
            if (note) {
                note.content = content;
                note.tags = tags;
                note.is_public = is_public;
                ui.restoreCard(note);
            }
            showToast('已保存 (离线)');
            loadTags();
            return;
        }

        const res = await api.notes.update(id, { content, tags, is_public });
        if (res && res.ok) {
            if (note) {
                note.content = content;
                note.tags = tags;
                note.is_public = is_public;
                ui.restoreCard(note);
            }
            showToast('保存成功');
            loadTags();
        } else {
            showToast('保存失败');
            if (note) ui.restoreCard(note);
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
            if (preview) preview.style.display = 'none';

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
                            if (typeof marked !== 'undefined') {
                                if (typeof parseWikiLinks !== 'undefined') {
                                    content = parseWikiLinks(content);
                                }
                                let html = marked.parse(content);
                                if (typeof DOMPurify !== 'undefined') {
                                    html = DOMPurify.sanitize(html);
                                }
                                if (ui && ui.renderMermaid) {
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = html;
                                    ui.renderMermaid(tempDiv);
                                    html = tempDiv.innerHTML;
                                }
                                if (typeof hljs !== 'undefined') {
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = html;
                                    tempDiv.querySelectorAll('pre code').forEach(block => {
                                        const isMermaid = block.classList.contains('language-mermaid') ||
                                                         block.classList.contains('language-mindmap');
                                        if (!isMermaid) {
                                            hljs.highlightElement(block);
                                        }
                                    });
                                    html = tempDiv.innerHTML;
                                }
                                preview.innerHTML = `<div class="version-preview-header">预览版本: ${v.created_at}</div>` + html;
                            } else {
                                preview.innerHTML = `<div class="version-preview-header">预览版本: ${v.created_at}</div>` + content.replace(/[#*`[\]]/g, '');
                            }
                            preview.style.display = 'block';
                        } catch(e) {
                            console.error('预览渲染失败:', e);
                            preview.innerHTML = `<div class="version-preview-header">预览版本: ${v.created_at}</div>` + content;
                            preview.style.display = 'block';
                        }
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
            let titleText = note.title;
            if (!titleText) {
                titleText = note.content.split('\n')[0].trim();
            }
            if (titleText) {
                titleText = titleText.replace(/^(#+\s+|[-*]\s+(\[[ xX]?\]\s+)?|\d+\.\s+|>\s+)/, '');
                if (titleText.length > 50) titleText = titleText.substring(0, 50) + '...';
            }
            cardTitle.textContent = titleText || '无标题';
        }

        modal.style.display = 'block';

        if (cardContent) {
            let content = note.content;
            try {
                if (typeof marked !== 'undefined') {
                    if (typeof parseWikiLinks !== 'undefined') {
                        content = parseWikiLinks(content);
                    }
                    let html = marked.parse(content);
                    if (typeof DOMPurify !== 'undefined') {
                        html = DOMPurify.sanitize(html);
                    }
                    cardContent.innerHTML = html;
                    cardContent.classList.add('markdown-body');

                    if (ui && ui.renderMermaid) {
                        await ui.renderMermaid(cardContent);
                    }

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
                    cardContent.textContent = content.replace(/[#*`\[\]]/g, '');
                }
            } catch (err) {
                console.error(err);
                cardContent.textContent = content;
            }
        }

        if (cardDate) cardDate.textContent = new Date(note.created_at).toLocaleDateString('zh-CN');

        if (cardTags && note.tags && note.tags.length > 0) {
            cardTags.innerHTML = note.tags.map(t => `<span class="share-card-tag">#${t}</span>`).join('');
            cardTags.style.display = 'flex';
        } else if (cardTags) {
            cardTags.style.display = 'none';
        }

        document.getElementById('sharePassword').value = '';
        document.getElementById('sharePassword').disabled = false;
        document.getElementById('sharePasswordEnabled').checked = false;
        document.getElementById('shareExpires').value = '0';

        modal.querySelector('.close-share').onclick = () => modal.style.display = 'none';
        window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

        document.getElementById('sharePasswordEnabled').onchange = (ev) => {
            document.getElementById('sharePassword').disabled = !ev.target.checked;
            if (!ev.target.checked) {
                document.getElementById('sharePassword').value = '';
            }
        };

        const createShareBtn = document.getElementById('createShare');
        const updateShareBtn = document.getElementById('updateShare');
        const shareUrlInput = document.getElementById('shareUrl');

        if (updateShareBtn) updateShareBtn.style.display = 'none';
        if (createShareBtn) createShareBtn.style.display = 'inline-block';

        if (shareUrlInput) {
            shareUrlInput.value = '';
            shareUrlInput.dataset.shareId = '';
            shareUrlInput.dataset.noteId = noteId;
        }

        if (createShareBtn) {
            createShareBtn.onclick = async () => {
                const passwordEnabled = document.getElementById('sharePasswordEnabled').checked;
                const password = passwordEnabled ? document.getElementById('sharePassword').value.trim() : '';
                const expires = document.getElementById('shareExpires').value;

                if (passwordEnabled && password.length < 4) {
                    showToast('密码至少需要4个字符');
                    return;
                }

                let expiresIn = null;
                if (expires === '24') expiresIn = 24;
                else if (expires === '168') expiresIn = 168;
                else if (expires === '720') expiresIn = 720;

                try {
                    createShareBtn.disabled = true;
                    createShareBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';

                    const res = await api.share.create({
                        note_id: noteId,
                        password: passwordEnabled ? password : '',
                        expires_in: expiresIn
                    });

                    if (res && res.ok) {
                        const data = await res.json();
                        if (shareUrlInput) {
                            const url = data.share.url;
                            shareUrlInput.value = url.startsWith('http') ? url : window.location.origin + url;
                            shareUrlInput.dataset.shareId = data.share.id;

                            const urlSection = document.getElementById('shareUrlSection');
                            if (urlSection) urlSection.style.display = 'block';

                            if (updateShareBtn) {
                                updateShareBtn.style.display = 'inline-block';
                                createShareBtn.style.display = 'none';
                            }

                            showToast('分享链接创建成功');
                        }
                    } else {
                        const errorData = await res.json();
                        showToast(errorData.message || '创建分享失败');
                    }
                } catch (err) {
                    console.error('创建分享失败:', err);
                    showToast('网络错误，请重试');
                } finally {
                    createShareBtn.disabled = false;
                    createShareBtn.innerHTML = '<i class="fas fa-link"></i> 创建分享链接';
                }
            };
        }

        if (updateShareBtn) {
            updateShareBtn.onclick = async () => {
                const shareId = shareUrlInput?.dataset.shareId;
                if (!shareId) return;

                const passwordEnabled = document.getElementById('sharePasswordEnabled').checked;
                const password = passwordEnabled ? document.getElementById('sharePassword').value.trim() : '';
                const expires = document.getElementById('shareExpires').value;

                if (passwordEnabled && password.length < 4) {
                    showToast('密码至少需要4个字符');
                    return;
                }

                let expiresIn = null;
                if (expires === '24') expiresIn = 24;
                else if (expires === '168') expiresIn = 168;
                else if (expires === '720') expiresIn = 720;

                try {
                    updateShareBtn.disabled = true;
                    updateShareBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 更新中...';

                    const res = await api.share.update(shareId, {
                        password: passwordEnabled ? password : null,
                        expires_in: expiresIn
                    });

                    if (res && res.ok) {
                        showToast('分享设置已更新');
                    } else {
                        const errorData = await res.json();
                        showToast(errorData.message || '更新失败');
                    }
                } catch (err) {
                    console.error('更新分享失败:', err);
                    showToast('网络错误，请重试');
                } finally {
                    updateShareBtn.disabled = false;
                    updateShareBtn.innerHTML = '<i class="fas fa-sync-alt"></i> 更新设置';
                }
            };
        }
    });

    document.getElementById('copyShareUrl')?.addEventListener('click', () => {
        const input = document.getElementById('shareUrl');
        input.select();
        document.execCommand('copy');
        showToast('链接已复制');
    });

    document.getElementById('downloadShareCard')?.addEventListener('click', async () => {
        const card = document.getElementById('shareCard');
        if (!card) return;

        try {
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

    document.getElementById('updateShare')?.addEventListener('click', async () => {
        const shareUrl = document.getElementById('shareUrl');
        const shareId = shareUrl?.dataset.shareId;
        const noteId = shareUrl?.dataset.noteId;
        if (!shareId || !noteId) return;

        const password = document.getElementById('sharePassword').value.trim();
        const expires = document.getElementById('shareExpires').value;

        await api.share.delete(shareId);

        let expiresIn = null;
        if (expires === '24') expiresIn = 24;
        else if (expires === '168') expiresIn = 168;
        else if (expires === '720') expiresIn = 720;

        const res = await api.share.create({
            note_id: noteId,
            password: document.getElementById('sharePasswordEnabled').checked ? password : '',
            expires_in: expiresIn
        });

        if (res && res.ok) {
            const data = await res.json();
            const url = data.share.url;
            shareUrl.value = url.startsWith('http') ? url : window.location.origin + url;
            shareUrl.dataset.shareId = data.share.id;
            showToast('设置已更新');
        } else {
            showToast('更新失败');
        }
    });
}

function handleOfflineDelete(id) {
    if (id.startsWith('draft-') || id.startsWith('offline-')) {
        let drafts = JSON.parse(localStorage.getItem('offline_drafts') || '[]');
        const draftId = parseInt(id.split('-').pop());
        drafts = drafts.filter(d => d._id !== draftId);
        localStorage.setItem('offline_drafts', JSON.stringify(drafts));
    } else {
        const deletes = JSON.parse(localStorage.getItem('offline_deletes') || '[]');
        if (!deletes.some(d => (typeof d === 'string' ? d === id : d.id === id))) {
            deletes.push({ id, timestamp: Date.now() });
            localStorage.setItem('offline_deletes', JSON.stringify(deletes));
        }
    }
    removeCardFromUI(id);
    showToast('已删除 (离线)');
}

function handleOfflineUpdate(id, updates) {
    if (id.toString().startsWith('draft-') || id.toString().startsWith('offline-')) {
        let drafts = JSON.parse(localStorage.getItem('offline_drafts') || '[]');
        const draftId = parseInt(id.toString().split('-').pop());
        const targetDraft = drafts.find(d => d._id === draftId);
        if (targetDraft) {
            Object.assign(targetDraft, updates);
            localStorage.setItem('offline_drafts', JSON.stringify(drafts));
        }
    } else {
        const offlineUpdates = JSON.parse(localStorage.getItem('offline_updates') || '{}');
        const existing = offlineUpdates[id] || {};
        offlineUpdates[id] = { ...existing, ...updates };
        localStorage.setItem('offline_updates', JSON.stringify(offlineUpdates));
    }
}

function removeCardFromUI(id) {
    const card = document.getElementById(`note-${id}`);
    if (card) {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 300);
    }
}
