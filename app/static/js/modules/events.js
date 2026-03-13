import { api, fetchJson } from './api.js';
import { state, setState } from './state.js';
import { ui } from './ui.js';
import { offlineStore } from './offline.js';
import { showToast, debounce, throttle, parseWikiLinks, escapeHtml, showConfirm, formatDate, formatExpiresAt, renderMarkdownToContainer } from './utils.js';

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
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持每日回顾');
        const modal = document.getElementById('reviewModal');
        const list = document.getElementById('reviewList');
        
        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:20px;">加载中...</div>';
            
            const closeBtn = modal.querySelector('.close-review');
            if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
            
            const outsideClick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };
            window.addEventListener('click', outsideClick);

            const res = await api.notes.review();
            if (res) {
                const notes = await res.json();
                list.innerHTML = '';
                if (notes.length === 0) {
                    list.innerHTML = '<div style="text-align:center; padding:20px;">还没有足够的笔记进行回顾</div>';
                    return;
                }
                
                const fragment = document.createDocumentFragment();
                notes.forEach(note => {
                    const card = ui.createNoteCard(note);
                    const actions = card.querySelector('.note-actions');
                    if(actions) actions.style.display = 'none';
                    fragment.appendChild(card);
                });
                list.appendChild(fragment);
                
                if (window.hljs) hljs.highlightAll();
            } else {
                list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--slate-400);"><i class="fas fa-wifi-slash"></i><p>网络不可用</p></div>';
            }
        }
    });

    // Knowledge Graph
    document.getElementById('navGraph')?.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持知识图谱');
        const modal = document.getElementById('graphModal');
        if (modal) {
            modal.style.display = 'block';
            
            const closeBtn = modal.querySelector('.close-graph');
            if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
            
            const outsideClick = (ev) => { if(ev.target === modal) modal.style.display = 'none'; };
            window.addEventListener('click', outsideClick);

            if (typeof echarts === 'undefined') {
                showToast('正在加载图谱引擎，请稍候...');
                return;
            }

            try {
                const res = await fetchJson('/api/notes/graph');
                if (!res) throw new Error('获取数据失败');
                const data = await res.json();
                
                const container = document.getElementById('graphContainer');
                if (!container) return;
                
                // Initialize ECharts if not already
                let chart = echarts.getInstanceByDom(container);
                if (!chart) {
                    chart = echarts.init(container);
                }

                const option = {
                    tooltip: {
                        formatter: '{b}'
                    },
                    series: [{
                        type: 'graph',
                        layout: 'force',
                        data: data.nodes.map(n => ({
                            id: n.id,
                            name: n.name,
                            symbolSize: Math.max(10, Math.min(50, n.value * 5)), // Limit size
                            itemStyle: {
                                color: '#10B981' // var(--primary)
                            }
                        })),
                        edges: data.edges,
                        roam: true,
                        label: {
                            show: true,
                            position: 'right',
                            formatter: '{b}',
                            color: '#475569'
                        },
                        force: {
                            repulsion: 200,
                            edgeLength: 100
                        },
                        lineStyle: {
                            color: '#cbd5e1',
                            width: 2,
                            curveness: 0.1
                        },
                        emphasis: {
                            focus: 'adjacency',
                            lineStyle: {
                                width: 4
                            }
                        }
                    }]
                };

                chart.setOption(option);
                
                // Handle window resize for the chart
                window.addEventListener('resize', () => {
                    chart.resize();
                });
                
                // Clicking a node jumps to the note (if we implement a viewer, for now just log or jump)
                chart.on('click', (params) => {
                    if (params.dataType === 'node') {
                        modal.style.display = 'none';
                        showToast(`跳转到笔记: ${params.data.name}`);
                        
                        const searchInput = document.getElementById('searchInput');
                        if (searchInput) {
                            searchInput.value = params.data.name;
                            // Trigger search
                            searchInput.dispatchEvent(new Event('input'));
                            // Ensure we are in the 'all' view
                            if (state.isTrashMode) {
                                switchView('all');
                            }
                        }
                    }
                });
                
            } catch (err) {
                console.error(err);
                showToast('加载图谱失败');
            }
        }
    });

    // My Shares Modal logic
    initSharesModal();

    // Time Capsule Modal logic
    initCapsuleModal(loadNotes);

    // Sidebar Toggle
    initSidebarLogic();

    // Search Logic
    initSearchLogic(loadNotes);

    // Editor Auto-Resize & Logic
    initEditorLogic(loadNotes);

    // Custom Events (Event Bus)
    initCustomEvents(loadNotes, loadTags);

    // Global Event Delegation for Note Cards
    document.body.addEventListener('click', (e) => {
        // Handle Note Actions
        const actionEl = e.target.closest('.note-action');
        if (actionEl) {
            const action = actionEl.dataset.action;
            const id = actionEl.dataset.id;
            if (action && id) {
                window.dispatchEvent(new CustomEvent(`note:${action}`, { detail: id }));
            }
            return;
        }

        // Handle Tag Clicks within cards
        const tagEl = e.target.closest('.note-tag');
        if (tagEl && tagEl.closest('.note-card') && tagEl.dataset.tag) {
            window.dispatchEvent(new CustomEvent('filter:tag', { detail: tagEl.dataset.tag }));
            return;
        }

        // Handle Task Checkbox Clicks
        const taskCheckbox = e.target.closest('.markdown-body input[type="checkbox"]');
        if (taskCheckbox && taskCheckbox.closest('.note-card')) {
            const card = taskCheckbox.closest('.note-card');
            const id = card.id.replace('note-', '');
            // Find index of this checkbox among all checkboxes in this card
            const checkboxes = Array.from(card.querySelectorAll('.markdown-body input[type="checkbox"]'));
            const index = checkboxes.indexOf(taskCheckbox);
            if (index > -1) {
                window.dispatchEvent(new CustomEvent('note:toggle-task', { 
                    detail: { id, index, checked: taskCheckbox.checked } 
                }));
            }
        }

        // Handle Bilibili Card Clicks — expand to iframe player
        const biliCard = e.target.closest('.bilibili-card');
        if (biliCard) {
            const bvid = biliCard.dataset.bvid;
            if (!bvid) return;
            const src = `https://player.bilibili.com/player.html?bvid=${bvid}&high_quality=1&as_wide=1&autoplay=0`;
            const wrapper = document.createElement('div');
            wrapper.className = 'video-wrapper bilibili-wrapper';
            wrapper.innerHTML = `<iframe src="${src}" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" allow="autoplay; fullscreen; encrypted-media" referrerpolicy="no-referrer"></iframe>`;
            biliCard.replaceWith(wrapper);
            return;
        }

        // Handle Wiki Link Clicks
        const wikiLink = e.target.closest('.wiki-link');
        if (wikiLink) {
            e.preventDefault();
            const title = wikiLink.dataset.wikiTitle;
            if (title) {
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.value = title;
                    // Trigger input event manually so that the debounce listener fires
                    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    // Ensure we are in the 'all' view
                    if (state.isTrashMode) {
                        switchView('all');
                    }
                }
            }
        }
    });

    // 文档引用链接点击 → 触发阅读面板跳转（事件委托）
    document.addEventListener('click', (e) => {
        const link = e.target.closest('.doc-citation-link');
        if (!link) return;
        e.preventDefault();
        const docId = link.dataset.docId;
        const page = link.dataset.page ? parseInt(link.dataset.page) : null;
        // 从父级 blockquote 中提取引用文字（用于高亮定位）
        const blockquote = link.closest('blockquote');
        let text = '';
        if (blockquote) {
            const clone = blockquote.cloneNode(true);
            // 移除来源行
            clone.querySelectorAll('em').forEach(el => el.remove());
            text = clone.textContent.trim().slice(0, 80);
        }
        if (docId) {
            window.dispatchEvent(new CustomEvent('doc:navigate', {
                detail: { docId, page, text }
            }));
        }
    });

    eventsInitialized = true;
    console.log('Global events initialized');
}

function initSharesModal() {
    let allShares = []; 

    document.getElementById('navShares')?.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持管理分享');
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
                const response = await api.share.list();
                if (response && response.ok) {
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
                 api.share.list().then(r => r.json()).then(data => {
                     allShares = data;
                     renderSharesList(allShares);
                 });
            });
        });
        
        list.querySelectorAll('.expire-share-btn').forEach(btn => {
            btn.onclick = async () => {
                if(await showConfirm('确定要让此分享立即过期吗？', { title: '设为过期', type: 'danger' })) {
                    const res = await fetchJson(`/api/share/${btn.dataset.id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({expire_now: true})});
                    if(res && res.ok) {
                        const data = await (await api.share.list()).json();
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
            const res = await fetchJson(`/api/share/${currentEditShareId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: passwordEnabled.checked ? pwd : null,
                    expires_in: exp !== '' ? parseInt(exp) : null
                })
            });

            if (res && res.ok) {
                modal.style.display = 'none';
                showToast(warningDiv.style.display !== 'none' ? '分享已重新激活' : '分享设置已更新');
                if (onSuccess) onSuccess();
            } else if (res) {
                const data = await res.json();
                showToast(data.error || '更新失败');
            } else {
                showToast('网络连接失败');
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

    // 保存滚动位置
    let scrollPosition = 0;
    
    const toggleMobileSidebar = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = sidebar.classList.toggle('mobile-open');
        document.body.classList.toggle('sidebar-open', isOpen);
        
        if (isOpen) {
            // 打开时保存当前滚动位置
            scrollPosition = window.pageYOffset;
            document.body.style.top = `-${scrollPosition}px`;
        } else {
            // 关闭时恢复滚动位置
            document.body.style.top = '';
            window.scrollTo(0, scrollPosition);
        }
    };

    mobileBtn?.addEventListener('click', toggleMobileSidebar);
    brandLink?.addEventListener('click', toggleMobileSidebar);
    
    // Mobile Close Logic
    window.closeMobileSidebar = () => {
        sidebar.classList.add('mobile-closing');
        sidebar.classList.remove('mobile-open');
        document.body.classList.add('sidebar-closing');
        document.body.classList.remove('sidebar-open');
        
        // 恢复滚动位置
        document.body.style.top = '';
        window.scrollTo(0, scrollPosition);
        
        setTimeout(() => {
            sidebar.classList.remove('mobile-closing');
            document.body.classList.remove('sidebar-closing');
        }, 200);
    };

    document.getElementById('sidebarMobileClose')?.addEventListener('click', (e) => {
        e.stopPropagation();
        window.closeMobileSidebar();
    });

    // 蒙版点击关闭侧边栏
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    sidebarOverlay?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (sidebar.classList.contains('mobile-open')) {
            window.closeMobileSidebar();
        }
    });

    document.addEventListener('click', (e) => {
        const isBrandOrBtn = (mobileBtn && mobileBtn.contains(e.target)) || (brandLink && brandLink.contains(e.target));
        const isOverlay = e.target.id === 'sidebarOverlay';
        if (window.innerWidth <= 900 && sidebar.classList.contains('mobile-open') && !sidebar.contains(e.target) && !isBrandOrBtn && !isOverlay) {
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
        const textarea = document.getElementById('noteContent');
        const content = textarea.value.trim();
        const isPublic = document.getElementById('noteIsPublic').checked;
        const saveBtn = document.getElementById('saveNote');

        // 时光胶囊数据
        const isCapsule = textarea.dataset.isCapsule === 'true';
        const capsuleDate = textarea.dataset.capsuleDate || null;
        const capsuleHint = textarea.dataset.capsuleHint || '';

        if (!content) return showToast('内容不能为空');

        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        const payload = { 
            content, 
            tags: state.currentTags, 
            is_public: isPublic,
            is_capsule: isCapsule,
            capsule_date: capsuleDate,
            capsule_hint: capsuleHint
        };
        
        // 获取当前主编辑器待关联的文档 ID 列表
        if (window.__mainPendingDocs && window.__mainPendingDocs.length > 0) {
            payload.doc_ids = window.__mainPendingDocs.map(d => d.id);
        }

        if (!navigator.onLine || state.sessionRevoked) {
            const draftId = Date.now();
            const draft = {
                _id: draftId,
                ...payload,
                created_at: new Date().toISOString()
            };
            offlineStore.addDraft(draft);

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
            const res = await api.notes.create(payload);
            if (res && res.ok) {
                textarea.value = '';
                delete textarea.dataset.isCapsule;
                delete textarea.dataset.capsuleDate;
                delete textarea.dataset.capsuleHint;
                
                // 重置按钮样式
                const capsuleBtn = textarea.closest('.memo-editor')?.querySelector('.capsule-trigger');
                if (capsuleBtn) {
                    capsuleBtn.innerHTML = '<i class="far fa-hourglass"></i>';
                    capsuleBtn.classList.remove('active');
                    capsuleBtn.style.color = '';
                }

                localStorage.removeItem('note_draft_content');
                setState('currentTags', []);
                ui.renderTags('input');
                
                // 清空主编辑器待关联文档列表
                window.__mainPendingDocs = [];
                if (typeof renderMainDocsList === 'function') renderMainDocsList();
                else {
                    const list = document.getElementById('editorDocumentsList');
                    if (list) {
                        list.style.display = 'none';
                        list.innerHTML = '';
                    }
                }
                
                loadNotes(true);
                showToast(isCapsule ? '已封存' : '已记录');
            } else if (res === null) {
                const draftId = Date.now();
                const draft = {
                    _id: draftId,
                    ...payload,
                    created_at: new Date().toISOString()
                };
                offlineStore.addDraft(draft);

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
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持上传图片');
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
        notesStream.addEventListener('scroll', throttle(() => {
            const searchInput = document.getElementById('searchInput');
            if (searchInput && searchInput.value.trim() !== '') return;
            if (notesStream.scrollTop + notesStream.clientHeight >= notesStream.scrollHeight - 300) {
                if (!state.isLoading && state.hasNextPage) {
                    loadNotes(false);
                }
            }
        }, 200));
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
        if (!navigator.onLine || state.sessionRevoked) {
            handleOfflineDelete(id);
            return;
        }

        const res = await api.notes.delete(id);
        if (res && res.ok) {
            showToast('已删除');
            removeCardFromUI(id);
            ui.renderHeatmap();
            loadTags();
        } else if (res === null) {
            handleOfflineDelete(id);
        } else {
            showToast('删除失败');
        }
    });

    window.addEventListener('note:permanent-delete', async (e) => {
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持彻底删除');
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
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持恢复笔记');
        const res = await api.notes.restore(e.detail);
        if (res && res.ok) {
            showToast('已恢复');
            removeCardFromUI(e.detail);
            loadTags();
        } else {
            showToast('恢复失败');
        }
    });

    document.getElementById('emptyTrashBtn')?.addEventListener('click', async () => {
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持此操作');
        const confirmed = await showConfirm('将永久删除回收站中的所有笔记，无法恢复，确定吗？', { title: '清空回收站', type: 'danger' });
        if (!confirmed) return;
        const res = await api.notes.emptyTrash();
        if (res && res.ok) {
            const data = await res.json();
            showToast(`已清空，共删除 ${data.deleted ?? 0} 条笔记`);
            loadNotes(true);
            loadTags();
        } else {
            showToast('清空失败，请重试');
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

        // 必须携带所有原有字段，否则后端会将 tags/is_public/is_capsule 重置为默认值
        const updatePayload = {
            content: newContent,
            tags: note.tags,
            is_public: note.is_public,
            is_capsule: note.is_capsule,
            capsule_date: note.capsule_date,
            capsule_hint: note.capsule_hint
        };

        if (!navigator.onLine || state.sessionRevoked) {
            handleOfflineUpdate(id, { content: newContent });
            note.content = newContent;
            ui.restoreCard(note);
            return;
        }

        const res = await api.notes.update(id, updatePayload);
        if (res && res.ok) {
            note.content = newContent;
            ui.restoreCard(note);
        } else if (res === null) {
            handleOfflineUpdate(id, { content: newContent });
            note.content = newContent;
            ui.restoreCard(note);
            showToast('已保存 (离线)');
        } else {
            showToast('更新失败');
            ui.restoreCard(note);
        }
    });

    window.addEventListener('note:request-update', async (e) => {
        const { id, content, tags, is_public, is_capsule, capsule_date, capsule_hint, doc_ids } = e.detail;
        const note = state.notes.find(n => n.id == id);
        const updatePayload = { content, tags, is_public, is_capsule, capsule_date, capsule_hint, doc_ids };

        const syncNoteState = (note) => {
            if (!note) return;
            note.content = content;
            note.tags = tags;
            note.is_public = is_public;
            note.is_capsule = is_capsule;
            note.capsule_date = capsule_date;
            note.capsule_hint = capsule_hint;
        };

        if (!navigator.onLine || state.sessionRevoked) {
            handleOfflineUpdate(id, updatePayload);
            syncNoteState(note);
            if (note) ui.restoreCard(note);
            showToast('已保存 (离线)');
            loadTags();
            return;
        }

        const res = await api.notes.update(id, updatePayload);
        if (res && res.ok) {
            syncNoteState(note);
            if (note) ui.restoreCard(note);
            showToast('保存成功');
            loadTags();
        } else if (res === null) {
            handleOfflineUpdate(id, updatePayload);
            syncNoteState(note);
            if (note) ui.restoreCard(note);
            showToast('已保存 (离线)');
            loadTags();
        } else {
            showToast('保存失败');
            if (note) ui.restoreCard(note);
        }
    });

    window.addEventListener('note:history', async (e) => {
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持查看历史版本');
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
                        preview.innerHTML = `<div class="version-preview-header">预览版本: ${v.created_at}</div>`;
                        const contentDiv = document.createElement('div');
                        preview.appendChild(contentDiv);
                        renderMarkdownToContainer(v.content, contentDiv, ui);
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

    // 文档阅读面板：打开关联到本笔记的文档（或上传新文档）
    window.addEventListener('note:open-doc', async (e) => {
        const noteId = e.detail;
        window.__currentNoteId = noteId;
        if (!window.readerModule) return showToast('阅读面板未就绪，请刷新页面');

        const { reader, uploadAndOpenDocument, triggerDocUpload } = window.readerModule;

        try {
            const res = await api.documents?.listByNote(noteId);
            if (res && res.ok) {
                const docs = await res.json();
                if (docs.length === 1) {
                    reader.open(docs[0].id, noteId);
                    reader.setActiveNote(noteId);
                } else if (docs.length > 1) {
                    _showDocPicker(docs, noteId);
                } else {
                    triggerDocUpload(noteId);
                }
            } else {
                showToast('查询关联文档失败');
            }
        } catch (err) {
            console.error('[Events] note:open-doc 失败', err);
            showToast('操作失败，请重试');
        }
    });

    function _showDocPicker(docs, noteId) {
        const existing = document.querySelector('.doc-picker-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'doc-picker-modal';
        modal.innerHTML = `
            <div class="doc-picker-box">
                <div class="doc-picker-header">
                    <span>选择文档</span>
                    <button class="doc-picker-close"><i class="fas fa-times"></i></button>
                </div>
                <div class="doc-picker-list">
                    ${docs.map(d => `
                        <div class="doc-picker-item" data-doc-id="${d.id}">
                            <i class="fas fa-${d.file_type === 'pdf' ? 'file-pdf' : 'file-word'}"></i>
                            <span class="doc-picker-name">${d.original_filename}</span>
                            <span class="doc-picker-meta">${d.page_count ? d.page_count + '页' : ''}</span>
                        </div>
                    `).join('')}
                    <div class="doc-picker-item doc-picker-upload" id="docPickerUpload">
                        <i class="fas fa-plus"></i>
                        <span>上传新文档</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.doc-picker-close').onclick = () => modal.remove();
        modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.remove(); });

        modal.querySelectorAll('.doc-picker-item:not(.doc-picker-upload)').forEach(item => {
            item.onclick = () => {
                modal.remove();
                const { reader } = window.readerModule;
                reader.open(item.dataset.docId, noteId);
                reader.setActiveNote(noteId);
            };
        });

        document.getElementById('docPickerUpload')?.addEventListener('click', () => {
            modal.remove();
            window.readerModule?.triggerDocUpload(noteId);
        });
    }

    window.addEventListener('note:share', async (e) => {
        if (!navigator.onLine || state.sessionRevoked) return showToast('离线模式暂不支持分享');
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
            cardContent.classList.add('markdown-body');
            renderMarkdownToContainer(note.content, cardContent, ui);
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
                    } else if (res) {
                        const errorData = await res.json();
                        showToast(errorData.message || '创建分享失败');
                    } else {
                        showToast('网络连接失败，请稍后重试');
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
                    } else if (res) {
                        const errorData = await res.json();
                        showToast(errorData.message || '更新失败');
                    } else {
                        showToast('网络连接失败');
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

}

function handleOfflineDelete(id) {
    offlineStore.addDelete(id);
    removeCardFromUI(id);
    showToast('已删除 (离线)');
}

function handleOfflineUpdate(id, updates) {
    offlineStore.addUpdate(id, updates);
}

function initCapsuleModal(loadNotes) {
    document.getElementById('navCapsules')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const modal = document.getElementById('capsuleModal');
        const list = document.getElementById('capsuleList');

        if (modal) {
            modal.style.display = 'block';
            list.innerHTML = '<div style="text-align:center; padding:40px; color:#999;"><i class="fas fa-spinner fa-spin"></i> 加载陈列室中...</div>';

            // 激活导航高亮
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById('navCapsules')?.classList.add('active');

            const closeCapsuleModal = () => {
                modal.style.display = 'none';
                window.removeEventListener('click', outsideClick);
                document.getElementById('navCapsules')?.classList.remove('active');
                document.getElementById('navAllNotes')?.classList.add('active');
            };

            const outsideClick = (ev) => { if (ev.target === modal) closeCapsuleModal(); };
            window.addEventListener('click', outsideClick);

            const closeBtn = modal.querySelector('.close-capsule');
            if (closeBtn) closeBtn.onclick = closeCapsuleModal;

            try {
                const response = await api.notes.capsules();
                if (response && response.ok) {
                    const capsules = await response.json();
                    renderCapsules(capsules, loadNotes, closeCapsuleModal);
                } else {
                    list.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:#ef4444;"><i class="fas fa-exclamation-circle"></i> 加载失败</div>';
                }
            } catch (err) {
                console.error(err);
                list.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:#ef4444;"><i class="fas fa-wifi"></i> 网络错误</div>';
            }
        }
    });
}

function renderCapsules(capsules, loadNotes, closeCapsuleModal) {
    const list = document.getElementById('capsuleList');
    if (!list) return;

    if (capsules.length === 0) {
        list.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:80px 20px; color:#94a3b8;"><i class="fas fa-hourglass" style="font-size:48px; margin-bottom:20px; opacity:0.3;"></i><p>还没有封存的时光胶囊<br><span style="font-size:13px;">在编辑器中点击 ⏳ 按钮封存一段记忆吧</span></p></div>';
        return;
    }

    const formatCapsuleDate = (dateStr) => {
        if (!dateStr) return '—';
        return new Date(dateStr).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    };

    list.innerHTML = capsules.map(c => {
        const isLocked = c.capsule_status === 'locked';
        const isReady = c.capsule_status === 'ready';
        const isOpened = c.capsule_status === 'opened';
        
        let statusHtml = '';
        let cardStyle = '';
        let actionBtn = '';

        if (isLocked) {
            statusHtml = `<span class="capsule-badge locked"><i class="far fa-clock"></i> 封存中</span>`;
            cardStyle = 'opacity: 0.75;';
            if (c.capsule_date) {
                const remaining = new Date(c.capsule_date) - new Date();
                const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
                actionBtn = `<div class="capsule-timer">${days > 0 ? `还有 ${days} 天解锁` : '即将解锁'}</div>`;
            } else {
                actionBtn = `<div class="capsule-timer">未设解锁日期</div>`;
            }
        } else if (isReady) {
            statusHtml = `<span class="capsule-badge ready"><i class="far fa-envelope"></i> 可查看</span>`;
            cardStyle = '';
            actionBtn = `<button class="btn btn-secondary open-capsule-btn" data-id="${c.id}" style="width:100%; margin-top:10px;">打开</button>`;
        } else {
            statusHtml = `<span class="capsule-badge opened"><i class="far fa-envelope-open"></i> 已查看</span>`;
            actionBtn = `<button class="btn btn-secondary view-capsule-btn" data-id="${c.id}" style="width:100%; margin-top:10px;">查看内容</button>`;
        }

        return `
            <div class="capsule-card" style="${cardStyle}">
                <div class="capsule-card-header">
                    ${statusHtml}
                    <span class="capsule-date">${formatCapsuleDate(c.capsule_date)}</span>
                </div>
                <div class="capsule-card-body">
                    <div class="capsule-hint">"${escapeHtml(c.capsule_hint || '没有寄语')}"</div>
                    ${isOpened ? `<div class="capsule-title">${escapeHtml(c.title)}</div>` : '<div class="capsule-locked-placeholder">🔒 内容已封存</div>'}
                </div>
                <div class="capsule-card-footer">
                    ${actionBtn}
                </div>
            </div>
        `;
    }).join('');

    // 绑定开启事件
    list.querySelectorAll('.open-capsule-btn').forEach(btn => {
        btn.onclick = async () => {
            const id = btn.dataset.id;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在开启...';
            
            try {
                const res = await fetch(`/api/notes/capsules/${id}/open`, { method: 'POST' });
                if (res.ok) {
                    showToast('⌛ 时光胶囊已拆开');
                    const capsulesRes = await api.notes.capsules();
                    if (capsulesRes && capsulesRes.ok) {
                        const updatedCapsules = await capsulesRes.json();
                        renderCapsules(updatedCapsules, loadNotes, closeCapsuleModal);
                    }
                    loadNotes(true);
                } else {
                    const data = await res.json().catch(() => ({}));
                    showToast(data.error || '开启失败');
                    btn.disabled = false;
                    btn.innerHTML = '拆开信封';
                }
            } catch (err) {
                console.error(err);
                showToast('网络错误');
                btn.disabled = false;
                btn.innerHTML = '拆开信封';
            }
        };
    });

    list.querySelectorAll('.view-capsule-btn').forEach(btn => {
        btn.onclick = () => {
            if (typeof closeCapsuleModal === 'function') closeCapsuleModal();
            const targetId = btn.dataset.id;

            // 确保在全部笔记视图，刷新后再跳转
            window.dispatchEvent(new CustomEvent('note:refresh-list'));

            const tryJump = (attempt = 0) => {
                const el = document.getElementById(`note-${targetId}`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('jump-highlight');
                    setTimeout(() => el.classList.remove('jump-highlight'), 2000);
                } else if (attempt < 4) {
                    setTimeout(() => tryJump(attempt + 1), 500);
                } else {
                    showToast('笔记已加载，请在列表中查看');
                }
            };
            setTimeout(() => tryJump(), 300);
        };
    });
}

function removeCardFromUI(id) {
    const card = document.getElementById(`note-${id}`);
    if (card) {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 300);
    }
}