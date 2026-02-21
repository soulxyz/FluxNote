import { api } from './modules/api.js';
import { state, setState } from './modules/state.js';
import { ui } from './modules/ui.js';
import { auth, initAuthEvents } from './modules/auth.js';
import { editor } from './modules/editor.js';
import { showToast, debounce, parseWikiLinks, escapeHtml, showConfirm, formatDate, formatExpiresAt } from './modules/utils.js';

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
    let allShares = []; // 存储所有分享数据

    document.getElementById('navShares')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const modal = document.getElementById('sharesModal');
        const list = document.getElementById('sharesList');

        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:40px; color:var(--slate-400);"><i class="fas fa-spinner fa-spin" style="font-size: 24px;"></i><p style="margin-top: 12px;">加载中...</p></div>';

            // Close logic
            const closeBtn = modal.querySelector('.close-shares');
            if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
            window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

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

    // 渲染分享列表
    function renderSharesList(shares) {
        const list = document.getElementById('sharesList');
        const searchInput = document.getElementById('sharesSearchInput');
        const statusFilter = document.getElementById('sharesStatusFilter');
        const sortFilter = document.getElementById('sharesSortFilter');

        // 获取筛选和排序条件
        const searchTerm = searchInput?.value.toLowerCase() || '';
        const status = statusFilter?.value || 'all';
        const sortBy = sortFilter?.value || 'newest';

        // 筛选
        let filtered = shares.filter(s => {
            const matchSearch = !searchTerm || (s.note_title || '').toLowerCase().includes(searchTerm);
            const isExpired = s.is_expired || (s.expires_at && new Date(s.expires_at) < new Date());
            const matchStatus = status === 'all' ||
                              (status === 'active' && !isExpired) ||
                              (status === 'expired' && isExpired);
            return matchSearch && matchStatus;
        });

        // 排序
        filtered.sort((a, b) => {
            switch (sortBy) {
                case 'oldest':
                    return new Date(a.created_at) - new Date(b.created_at);
                case 'views':
                    return b.view_count - a.view_count;
                case 'expiring':
                    if (!a.expires_at) return 1;
                    if (!b.expires_at) return -1;
                    return new Date(a.expires_at) - new Date(b.expires_at);
                default: // newest
                    return new Date(b.created_at) - new Date(a.created_at);
            }
        });

        // 更新统计
        updateSharesStats(shares);

        if (filtered.length === 0) {
            list.innerHTML = `
                <div class="shares-empty">
                    <i class="fas fa-share-alt"></i>
                    <p>${shares.length === 0 ? '暂无分享记录' : '没有匹配的分享'}</p>
                </div>
            `;
            return;
        }

        list.innerHTML = filtered.map(s => {
            const isExpired = s.is_expired || (s.expires_at && new Date(s.expires_at) < new Date());
            const hasPassword = s.has_password;

            return `
                <div class="share-item ${isExpired ? 'expired' : ''}" id="share-item-${s.id}">
                    <div class="share-item-header">
                        <div class="share-item-title">
                            <i class="fas fa-file-alt"></i>
                            ${escapeHtml(s.note_title || '无标题')}
                        </div>
                        <div class="share-item-status">
                            ${hasPassword ? '<span class="status-badge protected"><i class="fas fa-lock"></i> 已加密</span>' : ''}
                            ${isExpired ? '<span class="status-badge expired">已过期</span>' : '<span class="status-badge active">活跃中</span>'}
                        </div>
                    </div>
                    <div class="share-item-meta">
                        <span><i class="far fa-clock"></i> ${formatDate(s.created_at)}</span>
                        <span><i class="far fa-eye"></i> ${s.view_count} 次浏览</span>
                        <span><i class="fas fa-hourglass-half"></i> ${formatExpiresAt(s.expires_at)}</span>
                    </div>
                    <div class="share-item-url">
                        <i class="fas fa-link"></i>
                        <span>${s.url}</span>
                    </div>
                    <div class="share-item-actions">
                        <button class="btn btn-secondary btn-sm copy-share-btn" data-url="${s.url}">
                            <i class="fas fa-copy"></i> 复制
                        </button>
                        <button class="btn btn-secondary btn-sm edit-share-btn" data-id="${s.id}" data-password="${hasPassword}" data-expired="${isExpired}">
                            <i class="fas fa-edit"></i> ${isExpired ? '重新激活' : '编辑'}
                        </button>
                        ${!isExpired ? `
                        <button class="btn btn-warning btn-sm expire-share-btn" data-id="${s.id}">
                            <i class="fas fa-clock"></i> 过期
                        </button>
                        ` : ''}
                        <button class="btn btn-danger btn-sm delete-share-btn" data-id="${s.id}">
                            <i class="fas fa-trash"></i> 删除
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定事件
        bindShareItemEvents();
    }

    // 更新统计信息
    function updateSharesStats(shares) {
        const total = shares.length;
        const active = shares.filter(s => {
            const isExpired = s.is_expired || (s.expires_at && new Date(s.expires_at) < new Date());
            return !isExpired;
        }).length;
        const totalViews = shares.reduce((sum, s) => sum + (s.view_count || 0), 0);

        document.getElementById('totalSharesCount').textContent = total;
        document.getElementById('activeSharesCount').textContent = active;
        document.getElementById('totalViewsCount').textContent = totalViews;
    }

    // 绑定分享项目事件
    function bindShareItemEvents() {
        const list = document.getElementById('sharesList');

        // 复制链接
        list.querySelectorAll('.copy-share-btn').forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.dataset.url).then(() => showToast('链接已复制'));
            };
        });

        // 编辑分享
        list.querySelectorAll('.edit-share-btn').forEach(btn => {
            btn.onclick = () => showEditShareModal(btn.dataset.id, btn.dataset.password === 'true', btn.dataset.expires);
        });

        // 立即过期
        list.querySelectorAll('.expire-share-btn').forEach(btn => {
            btn.onclick = async () => {
                const confirmed = await showConfirm('确定要让此分享立即过期吗？', { title: '设为过期', type: 'danger' });
                if (!confirmed) return;
                const shareId = btn.dataset.id;
                try {
                    const res = await fetch(`/api/share/${shareId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ expire_now: true })
                    });
                    if (res.ok) {
                        const response = await fetch('/api/shares');
                        if (response.ok) {
                            allShares = await response.json();
                            renderSharesList(allShares);
                        }
                        showToast('分享已过期');
                    } else {
                        showToast('操作失败');
                    }
                } catch (err) {
                    console.error(err);
                    showToast('网络错误');
                }
            };
        });

        // 删除分享
        list.querySelectorAll('.delete-share-btn').forEach(btn => {
            btn.onclick = async () => {
                const confirmed = await showConfirm('链接将失效，确定要删除此分享吗？', { title: '删除分享', type: 'danger' });
                if (!confirmed) return;
                const shareId = btn.dataset.id.trim();
                const res = await api.share.delete(shareId);
                if (res && res.ok) {
                    // 从数据中移除并重新渲染
                    allShares = allShares.filter(s => s.id !== shareId);
                    renderSharesList(allShares);
                    showToast('分享已删除');
                } else {
                    showToast('操作失败');
                }
            };
        });
    }

    // 显示编辑分享模态框
    let currentEditShareId = null;

    function showEditShareModal(shareId, hasPassword, isExpired) {
        const modal = document.getElementById('editShareModal');
        const passwordEnabled = document.getElementById('editSharePasswordEnabled');
        const passwordInput = document.getElementById('editSharePassword');
        const expiresSelect = document.getElementById('editShareExpires');
        const warningDiv = document.getElementById('expiredWarning');
        const titleEl = document.getElementById('editShareModalTitle');
        const saveText = document.getElementById('saveEditShareText');

        currentEditShareId = shareId;

        // 根据是否过期显示不同界面
        if (isExpired) {
            titleEl.innerHTML = '<i class="fas fa-redo" style="margin-right: 8px; color: #d97706;"></i>重新激活分享';
            warningDiv.style.display = 'block';
            expiresSelect.value = '168'; // 默认7天
            saveText.textContent = '重新激活';
        } else {
            titleEl.innerHTML = '<i class="fas fa-edit" style="margin-right: 8px; color: var(--primary);"></i>编辑分享设置';
            warningDiv.style.display = 'none';
            expiresSelect.value = '';
            saveText.textContent = '保存修改';
        }

        // 设置初始值
        passwordEnabled.checked = hasPassword;
        passwordInput.disabled = !hasPassword;
        passwordInput.value = '';

        // 显示模态框
        modal.style.display = 'block';

        // 关闭按钮
        modal.querySelector('.close-edit-share').onclick = () => modal.style.display = 'none';
        document.getElementById('cancelEditShare').onclick = () => modal.style.display = 'none';

        // 点击背景关闭
        const closeHandler = (ev) => {
            if (ev.target === modal) {
                modal.style.display = 'none';
                window.removeEventListener('click', closeHandler);
            }
        };
        window.addEventListener('click', closeHandler);
    }

    // 密码启用切换
    document.getElementById('editSharePasswordEnabled')?.addEventListener('change', (e) => {
        const passwordInput = document.getElementById('editSharePassword');
        if (passwordInput) {
            passwordInput.disabled = !e.target.checked;
            if (!e.target.checked) passwordInput.value = '';
        }
    });

    // 保存编辑
    document.getElementById('saveEditShare')?.addEventListener('click', async () => {
        if (!currentEditShareId) return;

        const passwordEnabled = document.getElementById('editSharePasswordEnabled')?.checked;
        const password = document.getElementById('editSharePassword')?.value;
        const expiresIn = document.getElementById('editShareExpires')?.value;
        const warningDiv = document.getElementById('expiredWarning');

        // 过期分享必须选择有效期
        if (warningDiv.style.display !== 'none' && expiresIn === '') {
            showToast('请选择有效期');
            return;
        }

        try {
            const res = await fetch(`/api/share/${currentEditShareId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: passwordEnabled ? password : null,
                    expires_in: expiresIn !== '' ? parseInt(expiresIn) : null
                })
            });

            if (res.ok) {
                document.getElementById('editShareModal').style.display = 'none';
                // 重新加载分享列表
                const response = await fetch('/api/shares');
                if (response.ok) {
                    allShares = await response.json();
                    renderSharesList(allShares);
                }
                showToast(warningDiv.style.display !== 'none' ? '分享已重新激活' : '分享设置已更新');
            } else {
                const data = await res.json();
                showToast(data.error || '更新失败');
            }
        } catch (err) {
            console.error(err);
            showToast('网络错误');
        }
    });

    // 搜索和筛选事件
    document.getElementById('sharesSearchInput')?.addEventListener('input', () => renderSharesList(allShares));
    document.getElementById('sharesStatusFilter')?.addEventListener('change', () => renderSharesList(allShares));
    document.getElementById('sharesSortFilter')?.addEventListener('change', () => renderSharesList(allShares));

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

    // Precise Editor Auto-Resize System
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
            const viewportHeight = window.innerHeight;
            const editorHeight = memoEditor.offsetHeight;

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

    window.addEventListener('tags:refresh', () => loadTags());

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
            loadTags(); // Refresh tags after deletion
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
            loadTags(); // Refresh tags after permanent deletion
        } else {
            showToast('删除失败');
        }
    });

    window.addEventListener('note:restore', async (e) => {
        const res = await api.notes.restore(e.detail);
        if (res && res.ok) {
            showToast('已恢复');
            document.getElementById(`note-${e.detail}`)?.remove();
            loadTags(); // Refresh tags after restore
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
                                // 处理wiki链接
                                if (typeof parseWikiLinks !== 'undefined') {
                                    content = parseWikiLinks(content);
                                }
                                let html = marked.parse(content);
                                if (typeof DOMPurify !== 'undefined') {
                                    html = DOMPurify.sanitize(html);
                                }
                                // 渲染Mermaid图表
                                if (ui && ui.renderMermaid) {
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = html;
                                    ui.renderMermaid(tempDiv);
                                    html = tempDiv.innerHTML;
                                }
                                // 高亮代码
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

        // 重置表单 - 现在启用所有表单字段
        document.getElementById('sharePassword').value = '';
        document.getElementById('sharePassword').disabled = false; // 启用密码输入框
        document.getElementById('sharePasswordEnabled').checked = false;
        document.getElementById('shareExpires').value = '0'; // 默认永久有效

        // 关闭按钮
        modal.querySelector('.close-share').onclick = () => modal.style.display = 'none';
        window.onclick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };

        // 密码开关
        document.getElementById('sharePasswordEnabled').onchange = (ev) => {
            document.getElementById('sharePassword').disabled = !ev.target.checked;
            // 如果禁用密码，清空密码字段
            if (!ev.target.checked) {
                document.getElementById('sharePassword').value = '';
            }
        };

        // 创建分享按钮事件处理
        const createShareBtn = document.getElementById('createShare');
        const updateShareBtn = document.getElementById('updateShare');
        const shareUrlInput = document.getElementById('shareUrl');

        // 隐藏更新按钮，显示创建按钮
        if (updateShareBtn) updateShareBtn.style.display = 'none';
        if (createShareBtn) createShareBtn.style.display = 'inline-block';

        // 清空分享URL
        if (shareUrlInput) {
            shareUrlInput.value = '';
            shareUrlInput.dataset.shareId = '';
            shareUrlInput.dataset.noteId = noteId;
        }

        // 创建分享按钮点击事件
        if (createShareBtn) {
            createShareBtn.onclick = async () => {
                const passwordEnabled = document.getElementById('sharePasswordEnabled').checked;
                const password = passwordEnabled ? document.getElementById('sharePassword').value.trim() : '';
                const expires = document.getElementById('shareExpires').value;

                // 表单验证
                if (passwordEnabled && password.length < 4) {
                    showToast('密码至少需要4个字符');
                    return;
                }

                // 设置有效期
                let expiresIn = null;
                if (expires === '24') expiresIn = 24;
                else if (expires === '168') expiresIn = 168;
                else if (expires === '720') expiresIn = 720;
                // '0' 表示永久有效

                try {
                    createShareBtn.disabled = true;
                    createShareBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';

                    // 创建分享链接
                    const res = await api.share.create({
                        note_id: noteId,
                        password: passwordEnabled ? password : '',
                        expires_in: expiresIn
                    });

                    if (res && res.ok) {
                        const data = await res.json();
                        if (shareUrlInput) {
                            // 后端可能返回完整URL或相对路径
                            const url = data.share.url;
                            shareUrlInput.value = url.startsWith('http') ? url : window.location.origin + url;
                            shareUrlInput.dataset.shareId = data.share.id;

                            // 显示URL区域
                            const urlSection = document.getElementById('shareUrlSection');
                            if (urlSection) urlSection.style.display = 'block';

                            // 显示操作按钮
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

        // 更新分享按钮事件处理（保持原有逻辑）
        if (updateShareBtn) {
            updateShareBtn.onclick = async () => {
                const shareId = shareUrlInput?.dataset.shareId;
                if (!shareId) return;

                const passwordEnabled = document.getElementById('sharePasswordEnabled').checked;
                const password = passwordEnabled ? document.getElementById('sharePassword').value.trim() : '';
                const expires = document.getElementById('shareExpires').value;

                // 表单验证
                if (passwordEnabled && password.length < 4) {
                    showToast('密码至少需要4个字符');
                    return;
                }

                // 设置有效期
                let expiresIn = null;
                if (expires === '24') expiresIn = 24;
                else if (expires === '168') expiresIn = 168;
                else if (expires === '720') expiresIn = 720;

                try {
                    updateShareBtn.disabled = true;
                    updateShareBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 更新中...';

                    // 更新分享设置
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
            const url = data.share.url;
            shareUrl.value = url.startsWith('http') ? url : window.location.origin + url;
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
