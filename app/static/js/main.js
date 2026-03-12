import { api } from './modules/api.js';
import { state, setState } from './modules/state.js';
import { ui } from './modules/ui.js';
import { auth, initAuthEvents } from './modules/auth.js';
import { editor } from './modules/editor.js';
import { showToast } from './modules/utils.js';
import { initGlobalEvents } from './modules/events.js';
import { offlineStore } from './modules/offline.js';
import './pwa.js';

// === Offline Data Sync ===
let _isSyncing = false;

async function syncOfflineData() {
    if (!navigator.onLine || state.sessionRevoked || _isSyncing) return;
    _isSyncing = true;

    try {
        const drafts  = offlineStore.getDrafts();
        const updates = offlineStore.getUpdates();
        const deletes = offlineStore.getDeletes();

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
                    const el = document.getElementById(`note-offline-${draft._id}`);
                    if (el) el.remove();
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
        offlineStore.saveDrafts(remainingDrafts);

        // 2. Sync Updates（跳过已被删除的笔记 ID）
        const deleteIds = new Set(deletes.map(d => d.id));
        const updateIds = Object.keys(updates);
        const remainingUpdates = { ...updates };

        for (const id of updateIds) {
            if (deleteIds.has(id)) {
                delete remainingUpdates[id];
                successCount++;
                continue;
            }
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
        offlineStore.saveUpdates(remainingUpdates);

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
        offlineStore.saveDeletes(remainingDeletes);

        if (successCount > 0) showToast(`同步完成: ${successCount} 项成功`);
        if (failCount > 0) showToast(`同步警告: ${failCount} 项失败，将在下次重试`, 5000);

        return successCount > 0;
    } finally {
        _isSyncing = false;
    }
}

window.addEventListener('online', async () => {
    if (!state.currentUser || state.sessionRevoked) return;
    console.log('[Offline] Network restored, syncing data...');
    const synced = await syncOfflineData();
    if (synced) {
        loadNotes(true);
        loadTags();
    }
});

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
    initGlobalEvents({
        loadNotes,
        loadTags,
        switchView
    });
    
    initAuthEvents(loadData);

    ui.renderSkeleton();
    ui.updateHeaderDate();

    const list = document.getElementById('notesList');
    if (list && typeof Viewer !== 'undefined') {
        state.galleryViewer = new Viewer(list, {
            button: true, navbar: false, title: false,
            toolbar: { zoomIn:1, zoomOut:1, oneToOne:1, reset:1 },
            filter(image) { return image.closest('.note-content'); }
        });
    }

    editor.init('noteContent');

    await auth.checkStatus({
        onLogin: loadData,
        onLogout: loadData,
        onSessionRevoked: loadLocalData
    });

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('action') === 'new') {
        setTimeout(() => {
            const textarea = document.getElementById('noteContent');
            if (textarea) {
                if (state.isTrashMode) switchView('all');
                textarea.focus();
                textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 500);
    }
});

async function loadData() {
    if (state.currentUser && navigator.onLine && !state.sessionRevoked) {
        await syncOfflineData();
    }
    await loadNotes(true);
    loadTags();
    ui.renderHeatmap();
    ui.renderOverviewStats();
    ui.updateHeaderDate();
    ui.handleHashJump();
    
    if (state.currentUser) {
        checkAndNotifyCapsules();
        // 登录后显示文档导入按钮
        const docBtn = document.getElementById('editorDocBtn');
        if (docBtn) docBtn.style.display = '';
    }
}

async function loadLocalData() {
    await loadNotes(true);
    loadTags();
    ui.renderHeatmap();
    ui.renderOverviewStats();
    ui.updateHeaderDate();
}

async function checkAndNotifyCapsules() {
    try {
        const res = await api.notes.capsules();
        if (res && res.ok) {
            const capsules = await res.json();
            const readyOnes = capsules.filter(c => c.capsule_status === 'ready');
            if (readyOnes.length > 0) {
                const navCaps = document.getElementById('navCapsules');
                if (navCaps && !navCaps.querySelector('.capsule-ready-dot')) {
                    const dot = document.createElement('span');
                    dot.className = 'capsule-ready-dot';
                    navCaps.appendChild(dot);
                }
            }
        }
    } catch (e) {
        console.warn('Check capsules failed', e);
    }
}

// === Note Logic ===

async function loadNotes(reset = false) {
    if (!reset && state.isLoading) return;

    if (reset) {
        setState('currentPage', 1);
        setState('notes', []);
        setState('hasNextPage', true);
    }

    setState('isLoading', true);

    const list = document.getElementById('notesList');
    const searchVal = document.getElementById('searchInput')?.value.trim() || '';
    const userId = state.currentUser ? state.currentUser.id : -1;

    // 离线 / 会话失效 → 客户端查询
    if (!navigator.onLine || state.sessionRevoked) {
        console.log('[Notes] Offline query — tag:', state.currentFilterTag, 'date:', state.currentDateFilter, 'search:', searchVal);
        const notes = offlineStore.queryNotes({
            tag:    state.currentFilterTag,
            date:   state.currentDateFilter,
            search: searchVal,
            userId
        });
        setState('notes', notes);
        setState('hasNextPage', false);
        ui.renderNotes(notes, true);
        setState('isLoading', false);
        hideScrollLoading();
        return;
    }

    // 在线模式
    if (reset && list) {
        ui.renderSkeleton();
    }
    if (!reset) {
        showScrollLoading();
    }

    try {
        let response;

        if (state.isTrashMode) {
             response = await api.notes.trash(state.currentPage, searchVal);
        } else if (searchVal) {
             response = await api.notes.search(searchVal, state.currentFilterTag, state.currentPage);
        } else {
             response = await api.notes.list(state.currentPage, state.currentFilterTag, state.currentDateFilter);
        }

        if (!response) {
            console.log('[Notes] Server unreachable, falling back to local cache');
            const notes = offlineStore.applyOfflineChanges(offlineStore.getNotes(), userId);
            setState('notes', notes);
            ui.renderNotes(notes, true);
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

        if (reset && newNotes.length > 0) {
            offlineStore.setNotes(newNotes);
            console.log('[Notes] Cached', newNotes.length, 'notes for offline use');
        }

        ui.renderNotes(newNotes, reset);
        setState('currentPage', state.currentPage + 1);

    } catch (e) {
        console.error("Load notes failed", e);
        const cachedNotes = offlineStore.getNotes();
        if (cachedNotes.length > 0) {
            setState('notes', cachedNotes);
            ui.renderNotes(cachedNotes, true);
            showToast('网络错误 - 显示缓存内容');
        }
    } finally {
        setState('isLoading', false);
        hideScrollLoading();
    }
}

async function loadTags() {
    if (!navigator.onLine || state.sessionRevoked) {
        const cached = offlineStore.getTags();
        if (cached.length > 0) ui.renderSidebarTags(cached);
        return;
    }

    const res = await api.tags.list();
    if (res) {
        const tags = await res.json();
        ui.renderSidebarTags(tags);
        offlineStore.setTags(tags);
    } else {
        const cached = offlineStore.getTags();
        if (cached.length > 0) ui.renderSidebarTags(cached);
    }
}

function switchView(view) {
    const navAll = document.getElementById('navAllNotes');
    const navTrash = document.getElementById('navTrash');
    const emptyTrashBtn = document.getElementById('emptyTrashBtn');

    if (view === 'trash') {
        setState('isTrashMode', true);
        navTrash?.classList.add('active');
        navAll?.classList.remove('active');
        document.getElementById('noteInputSection').style.display = 'none';
        document.querySelector('.header-left span:last-child').textContent = '回收站';
        if (emptyTrashBtn) emptyTrashBtn.style.display = 'flex';
    } else {
        setState('isTrashMode', false);
        navAll?.classList.add('active');
        navTrash?.classList.remove('active');
        if (state.currentUser) {
            document.getElementById('noteInputSection').style.display = 'block';
        }
        ui.updateHeaderDate();
        if (emptyTrashBtn) emptyTrashBtn.style.display = 'none';
    }

    setState('currentFilterTag', '');
    setState('currentDateFilter', '');
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    loadNotes(true);
}
