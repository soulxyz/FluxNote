import { showToast } from './utils.js';

// 离线状态管理
let isOffline = false;

export function checkOnlineStatus() {
    return navigator.onLine;
}

window.addEventListener('online', () => {
    if (isOffline) {
        isOffline = false;
        showToast('网络已恢复');
        window.dispatchEvent(new CustomEvent('app:online'));
    }
});

window.addEventListener('offline', () => {
    isOffline = true;
    showToast('当前处于离线模式');
});

export async function fetchJson(url, options = {}) {
    try {
        const response = await fetch(url, options);

        // 检查是否为过期缓存数据
        if (response.headers.get('X-Cache-Status') === 'stale') {
            console.log('[API] Serving stale content from cache');
            showToast('当前显示的是缓存数据，可能不是最新的');
        }

        // 检查是否是离线响应
        if (response.status === 408) {
            console.log('[API] Offline response for:', url);
            return null;
        }

        if (response.status === 401) {
            window.dispatchEvent(new CustomEvent('auth:unauthorized'));
            return null;
        }

        if (!response.ok) {
            console.error(`HTTP error: ${response.status} ${response.statusText}`);
            return null;
        }

        return response;
    } catch (e) {
        // 网络错误
        console.log('[API] Network error:', url, e.message);
        isOffline = true;

        // 只对非认证请求显示 toast
        if (!url.includes('/api/auth/')) {
            showToast('网络连接失败');
        }

        return null;
    }
}

export const api = {
    auth: {
        status: () => fetchJson('/api/auth/status'),
        login: (username, password) => fetchJson('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        }),
        register: (username, password) => fetchJson('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        }),
        logout: () => fetchJson('/api/auth/logout', { method: 'POST' }),
        webauthn: {
            registerBegin: () => fetchJson('/api/auth/webauthn/register/begin', { method: 'POST' }),
            registerComplete: (data) => fetchJson('/api/auth/webauthn/register/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }),
            loginBegin: (username) => fetchJson('/api/auth/webauthn/login/begin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            }),
            loginComplete: (data) => fetchJson('/api/auth/webauthn/login/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            })
        }
    },
    notes: {
        list: (page = 1, tag = '', date = '') => {
            let url = `/api/notes?page=${page}&per_page=20`;
            if (tag) url += `&tag=${encodeURIComponent(tag)}`;
            if (date) url += `&date=${encodeURIComponent(date)}`;
            return fetchJson(url);
        },
        search: (keyword, tag = '', page = 1) => {
            let url = `/api/notes/search?keyword=${encodeURIComponent(keyword)}&page=${page}&per_page=20`;
            if (tag) url += `&tag=${encodeURIComponent(tag)}`;
            return fetchJson(url);
        },
        trash: (page = 1) => fetchJson(`/api/notes/trash?page=${page}&per_page=20`),
        create: (data) => fetchJson('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }),
        update: (id, data) => fetchJson(`/api/notes/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }),
        delete: (id) => fetchJson(`/api/notes/${id}`, { method: 'DELETE' }),
        permanentDelete: (id) => fetchJson(`/api/notes/${id}/permanent`, { method: 'DELETE' }),
        restore: (id) => fetchJson(`/api/notes/${id}/restore`, { method: 'POST' }),
        get: (id) => fetchJson(`/api/notes/${id}`),
        versions: (id) => fetchJson(`/api/notes/${id}/versions`),
        restoreVersion: (noteId, versionId) => fetchJson(`/api/notes/${noteId}/versions/${versionId}/restore`, { method: 'POST' }),
        backlinks: (id) => fetchJson(`/api/notes/${id}/backlinks`),
        titles: () => fetchJson('/api/notes/titles'),
        review: () => fetchJson('/api/notes/review'),
        shares: (noteId) => fetchJson(`/api/notes/${noteId}/shares`),
        capsules: () => fetchJson('/api/notes/capsules'),
        openCapsule: (id) => fetchJson(`/api/notes/capsules/${id}/open`, { method: 'POST' })
    },
    tags: {
        list: () => fetchJson('/api/tags')
    },
    stats: {
        overview: () => fetchJson('/api/stats/overview'),
        heatmap: () => fetchJson('/api/stats/heatmap')
    },
    ai: {
        customPrompts: () => fetchJson('/api/ai/custom_prompts'),
        stream: (data) => fetch('/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
    },
    share: {
        list: () => fetchJson('/api/shares'),
        create: (data) => fetchJson('/api/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }),
        get: (shareId) => fetchJson(`/api/share/${shareId}`),
        verify: (shareId, password) => fetchJson(`/api/share/${shareId}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        }),
        delete: (shareId) => fetchJson(`/api/share/${shareId}`, { method: 'DELETE' })
    },
    upload: (formData) => fetchJson('/api/upload', {
        method: 'POST',
        body: formData
    })
};
