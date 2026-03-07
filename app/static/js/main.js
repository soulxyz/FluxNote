import { api } from './modules/api.js';
import { state, setState } from './modules/state.js';
import { ui } from './modules/ui.js';
import { auth, initAuthEvents } from './modules/auth.js';
import { editor } from './modules/editor.js';
import { showToast } from './modules/utils.js';
import { initGlobalEvents } from './modules/events.js';
import './pwa.js'; // Initialize PWA

// === Offline Data Sync ===
async function syncOfflineData() {
    if (!navigator.onLine) return;

    const drafts = JSON.parse(localStorage.getItem('offline_drafts') || '[]');
    const updates = JSON.parse(localStorage.getItem('offline_updates') || '{}');
    const deletesRaw = JSON.parse(localStorage.getItem('offline_deletes') || '[]');
    
    // Normalize deletes
    const deletes = deletesRaw.map(d => (typeof d === 'string' ? { id: d, timestamp: Date.now() } : d));

    if (drafts.length === 0 && Object.keys(updates).length === 0 && deletes.length === 0) return;

    showToast('正在同步离线数据...', 2000);
    
    let successCount = 0;
    let failCount = 0;

    // 1. Sync Creates
    const remainingDrafts = [];
    for (const draft of drafts) {
        try {
            const res = await api.notes.create({
                content: draft.content,
                tags: draft.tags,
                is_public: draft.is_public,
                is_capsule: draft.is_capsule || false,
                capsule_date: draft.capsule_date || null,
                capsule_hint: draft.capsule_hint || ''
            });
            if (res && res.ok) {
                successCount++;
                // Optional: Replace DOM element if it exists
                const offlineId = `offline-${draft._id}`;
                const el = document.getElementById(`note-${offlineId}`);
                if (el) el.remove(); // Remove temporary draft from UI
            } else {
                failCount++;
                remainingDrafts.push(draft);
            }
        } catch (e) {
            console.error('[Sync] Create failed:', e);
            failCount++;
            remainingDrafts.push(draft);
        }
    }
    localStorage.setItem('offline_drafts', JSON.stringify(remainingDrafts));

    // 2. Sync Updates
    const updateIds = Object.keys(updates);
    const remainingUpdates = { ...updates };
    
    for (const id of updateIds) {
        try {
            const data = updates[id];
            const res = await api.notes.update(id, data);
            if (res && res.ok) {
                successCount++;
                delete remainingUpdates[id];
            } else {
                failCount++;
            }
        } catch (e) {
            console.error('[Sync] Update failed:', id, e);
            failCount++;
        }
    }
    if (Object.keys(remainingUpdates).length === 0) localStorage.removeItem('offline_updates');
    else localStorage.setItem('offline_updates', JSON.stringify(remainingUpdates));

    // 3. Sync Deletes
    const remainingDeletes = [];
    for (const item of deletes) {
        try {
            const res = await api.notes.delete(item.id);
            if (res && (res.ok || res.status === 404)) {
                successCount++;
            } else {
                failCount++;
                remainingDeletes.push(item);
            }
        } catch (e) {
            console.error('[Sync] Delete failed:', item.id, e);
            failCount++;
            remainingDeletes.push(item);
        }
    }
    localStorage.setItem('offline_deletes', JSON.stringify(remainingDeletes));

    // Summary Feedback
    if (successCount > 0) {
        showToast(`同步完成: ${successCount} 项成功`);
        // Only reload if we are at the top and not editing, otherwise just let the user know
        if (window.scrollY < 100 && !document.querySelector('.editing')) {
            loadData();
        } else {
            // Show a button to refresh? Or just leave it.
            // For now, let's update the sidebar tags at least
            loadTags();
        }
    }
    
    if (failCount > 0) {
        showToast(`同步警告: ${failCount} 项失败，将在下次重试`, 5000);
    }
}

// 网络恢复时同步
window.addEventListener('online', () => {
    console.log('[Offline] Network restored, syncing data...');
    syncOfflineData();
});

// 页面加载时检查是否需要同步
if (navigator.onLine) {
    syncOfflineData();
}

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
    // Inject dependencies into global events
    initGlobalEvents({
        loadNotes,
        loadTags,
        switchView
    });
    
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

    // Handle PWA Shortcuts (?action=new)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('action') === 'new') {
        setTimeout(() => {
            const textarea = document.getElementById('noteContent');
            if (textarea) {
                if (state.isTrashMode) switchView('all');
                textarea.focus();
                textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 500); // Wait a bit for initial data load/UI render
    }
});

async function loadData() {
    await loadNotes(true);
    loadTags();
    ui.renderHeatmap();
    ui.renderOverviewStats();
    ui.updateHeaderDate();
    ui.handleHashJump(); // Manually jump to anchor after notes are rendered
    
    // 时光胶囊：主动检查是否有待开启的胶囊
    if (state.currentUser) {
        checkAndNotifyCapsules();
    }
}

async function checkAndNotifyCapsules() {
    try {
        const res = await api.notes.capsules();
        if (res && res.ok) {
            const capsules = await res.json();
            const readyOnes = capsules.filter(c => c.capsule_status === 'ready');
            if (readyOnes.length > 0) {
                const count = readyOnes.length;
                setTimeout(() => {
                    showToast(`⌛ 你有 ${count} 个时光胶囊已到期，快去陈列室拆开吧！`, 8000);
                    const navCaps = document.getElementById('navCapsules');
                    if (navCaps && !navCaps.querySelector('.capsule-ready-badge')) {
                        const badge = document.createElement('span');
                        badge.className = 'capsule-ready-badge';
                        badge.style.cssText = 'background:#f39c12;color:white;border-radius:10px;padding:0 6px;font-size:10px;margin-left:4px;vertical-align:middle;';
                        badge.textContent = count;
                        navCaps.appendChild(badge);
                    }
                }, 1500);
            }
        }
    } catch (e) {
        console.warn('Check capsules failed', e);
    }
}


/**
 * 将本地存储中的离线更改（草稿、更新、删除）合并到给定的笔记列表中
 */
function applyOfflineChanges(notes) {
    const offlineDrafts = JSON.parse(localStorage.getItem('offline_drafts') || '[]');
    const offlineDeletes = JSON.parse(localStorage.getItem('offline_deletes') || '[]');
    const offlineUpdates = JSON.parse(localStorage.getItem('offline_updates') || '{}');

    // 1. 过滤已删除的笔记
    const deleteIds = offlineDeletes.map(d => (typeof d === 'string' ? d : d.id));
    let processedNotes = Array.isArray(notes) ? notes.filter(n => !deleteIds.includes(n.id)) : [];

    // 2. 应用待同步的更新
    processedNotes = processedNotes.map(n => {
        if (offlineUpdates[n.id]) {
            return { ...n, ...offlineUpdates[n.id], is_offline_update: true };
        }
        return n;
    });

    // 3. 合并离线草稿
    if (offlineDrafts.length > 0) {
        const draftNotes = offlineDrafts.map((draft, index) => ({
            id: `offline-${draft._id || (Date.now() + index)}`,
            content: draft.content,
            tags: draft.tags || [],
            is_public: draft.is_public,
            created_at: draft.created_at,
            user_id: state.currentUser ? state.currentUser.id : -1,
            backlinks: [],
            is_offline_draft: true
        })).reverse();
        
        processedNotes = [...draftNotes, ...processedNotes];
    }
    
    return processedNotes;
}

// === Note Logic ===

async function loadNotes(reset = false) {
    // 重置时强制执行
    if (!reset && state.isLoading) return;

    if (reset) {
        setState('currentPage', 1);
        setState('notes', []);
        setState('hasNextPage', true);
    }

    setState('isLoading', true);

    const list = document.getElementById('notesList');

    // 1. 网络环境预检查
    if (!navigator.onLine) {
        console.log('[Notes] Device is offline, loading from local cache');
        const cached = localStorage.getItem('cached_notes');
        let notes = [];
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                notes = (parsed && parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
            } catch (e) { console.error(e); }
        }
        const processed = applyOfflineChanges(notes);
        setState('notes', processed);
        ui.renderNotes(processed, true);
        setState('isLoading', false);
        hideScrollLoading();
        return;
    }

    // 在线模式：显示骨架屏
    if (reset && list) {
        ui.renderSkeleton();
    }

    // 无限滚动加载指示器
    if (!reset) {
        showScrollLoading();
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

        if (!response) {
            // 网络请求失败（如服务器宕机），尝试加载缓存并合并离线数据
            console.log('[Notes] Server unreachable, falling back to local cache');
            const cached = localStorage.getItem('cached_notes');
            let notes = [];
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    notes = (parsed && parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
                } catch (e) { console.error(e); }
            }
            const processed = applyOfflineChanges(notes);
            setState('notes', processed);
            ui.renderNotes(processed, true);
            showToast('网络错误 - 显示本地内容');
            setState('isLoading', false);
            hideScrollLoading();
            return;
        }
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

        // 缓存笔记供离线使用（只缓存第一页）
        if (reset && newNotes.length > 0) {
            try {
                const cacheData = {
                    version: 1,
                    timestamp: Date.now(),
                    data: newNotes
                };
                localStorage.setItem('cached_notes', JSON.stringify(cacheData));
                console.log('[Notes] Cached', newNotes.length, 'notes for offline use');
            } catch (e) {
                console.warn('[Notes] Failed to cache notes:', e);
            }
        }

        ui.renderNotes(newNotes, reset);
        setState('currentPage', state.currentPage + 1);

    } catch (e) {
        console.error("Load notes failed", e);
        // 尝试加载缓存
        const cachedNotes = localStorage.getItem('cached_notes');
        if (cachedNotes) {
            try {
                const parsed = JSON.parse(cachedNotes);
                const notes = (parsed && parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
                setState('notes', notes);
                ui.renderNotes(notes, true);
                showToast('网络错误 - 显示缓存内容');
            } catch (e2) {
                console.error('Failed to load cached notes:', e2);
            }
        }
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
