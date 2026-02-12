let notes = [];
let currentTags = [];
let currentFilterTag = '';
let currentDateFilter = '';
let editNoteId = null;
let editTags = [];
let currentUser = null;
let currentPage = 1;
let isLoading = false;
let hasNextPage = true;
let galleryViewer = null;
let isTrashMode = false; // New

// DOM加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    checkAuthStatus();
    initEventListeners();
    initImageViewer(); // New
    loadNotes(true);
    loadTags();
    initHeatmap();
    initMobileMenu();
    initSidebarToggle(); // New
    updateHeaderDate();
    loadOverviewStats();
});

// === View Switching ===
window.switchView = function(view) {
    const navAll = document.getElementById('navAllNotes');
    const navTrash = document.getElementById('navTrash');
    
    if (view === 'trash') {
        isTrashMode = true;
        navTrash?.classList.add('active');
        navAll?.classList.remove('active');
        // Hide input section in trash mode
        document.getElementById('noteInputSection').style.display = 'none';
        document.querySelector('.header-left span:last-child').textContent = '回收站';
    } else {
        isTrashMode = false;
        navAll?.classList.add('active');
        navTrash?.classList.remove('active');
        if (currentUser) {
            document.getElementById('noteInputSection').style.display = 'block';
        }
        updateHeaderDate();
    }
    
    // Reset filters
    currentFilterTag = '';
    currentDateFilter = '';
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    
    loadNotes(true);
};

// === Initialization & Events ===

function initEventListeners() {
    // Auth UI
    const showLoginBtn = document.getElementById('showLoginBtn');
    const showRegisterBtn = document.getElementById('showRegisterBtn');
    const closeAuthBtn = document.querySelector('.close-auth'); // Ensure this exists in HTML
    const authSubmitBtn = document.getElementById('authSubmitBtn');
    const logoutBtn = document.getElementById('logoutBtn');

    if (showLoginBtn) showLoginBtn.addEventListener('click', () => openAuthModal(true));
    if (showRegisterBtn) showRegisterBtn.addEventListener('click', () => openAuthModal(false));
    // If close button is a class or id, handle accordingly. HTML usually has <span class="close">&times;</span>
    document.querySelectorAll('.close, .close-auth').forEach(btn => {
        btn.addEventListener('click', closeAuthModal);
    });

    if (authSubmitBtn) authSubmitBtn.addEventListener('click', handleAuthSubmit);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

    document.getElementById('authPassword')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleAuthSubmit();
    });

    // Note Operations
    document.getElementById('saveNote')?.addEventListener('click', saveNote);

    // Tag Input Toggle
    const tagInput = document.getElementById('tagInput');
    const toggleTagBtn = document.getElementById('toggleTagInputBtn');

    if (toggleTagBtn && tagInput) {
        toggleTagBtn.addEventListener('click', () => {
            if (tagInput.style.display === 'none') {
                tagInput.style.display = 'inline-block';
                tagInput.focus();
            } else {
                tagInput.style.display = 'none';
            }
        });
    }

    // Auth Switch
    const authSwitchBtn = document.getElementById('authSwitchBtn');
    if (authSwitchBtn) {
        authSwitchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const modal = document.getElementById('authModal');
            const isLogin = modal.dataset.mode === 'login';
            openAuthModal(!isLogin);
        });
    }

    // Tag Input Enter
    document.getElementById('tagInput')?.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            addTag(this.value.trim(), 'input');
            this.value = '';
        }
    });

    // Search
    document.getElementById('searchInput')?.addEventListener('input', debounce(function() {
        loadNotes(true);
    }, 300));

    // Global Modal Close
    window.addEventListener('click', function(e) {
        const authModal = document.getElementById('authModal');
        if (e.target === authModal) closeAuthModal();
    });

    // Infinite Scroll
    window.addEventListener('scroll', () => {
        const searchInput = document.getElementById('searchInput');
        // Disable scroll loading if searching
        if (searchInput && searchInput.value.trim() !== '') return;

        if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) {
            if (!isLoading && hasNextPage) {
                loadNotes(false);
            }
        }
    });

    // Editor Features
    const mainInput = document.getElementById('noteContent');
    if (mainInput) {
        // Load draft
        const draft = localStorage.getItem('note_draft_content');
        if (draft) {
            mainInput.value = draft;
            // Optional: notify user
        }

        // Auto-save draft
        mainInput.addEventListener('input', debounce(function() {
            localStorage.setItem('note_draft_content', this.value);
        }, 1000));

        setupAutocomplete(mainInput);
        setupPasteImage(mainInput);
        setupAITools(mainInput);
    }

    // Home Button Reset
    document.querySelector('.header-left')?.addEventListener('click', () => {
        currentFilterTag = '';
        currentDateFilter = '';
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = '';
        loadNotes(true);
        updateHeaderDate();
        // Reset heatmap selection
        document.querySelectorAll('rect').forEach(r => r.setAttribute('stroke', 'none'));
        // Reset tags
        document.querySelectorAll('.filter-tag').forEach(btn => {
            if (btn.textContent === '全部') btn.classList.add('active');
            else btn.classList.remove('active');
        });
    });
}

// === Auth Functions ===

async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth/status');
        const data = await response.json();
        if (data.is_authenticated) {
            currentUser = data.user;
            updateAuthUI(true);
        } else {
            currentUser = null;
            updateAuthUI(false);
        }
    } catch (e) {
        console.error("Auth check failed", e);
    }
}

function updateAuthUI(isLoggedIn) {
    const authActions = document.getElementById('authActions');
    const userProfile = document.getElementById('userProfile');
    const loginPrompt = document.getElementById('loginPrompt');
    const noteInputSection = document.getElementById('noteInputSection');
    const userNameDisplay = document.getElementById('userName');

    if (isLoggedIn) {
        if (authActions) authActions.style.display = 'none';
        // if (userProfile) userProfile.style.display = 'flex'; // Old profile
        // Show compact profile
        const userProfile = document.getElementById('userProfile');
        if (userProfile) userProfile.style.display = 'flex';

        if (loginPrompt) loginPrompt.style.display = 'none';
        if (noteInputSection) noteInputSection.style.display = 'block';
        if (userNameDisplay) userNameDisplay.textContent = currentUser.username;

        loadOverviewStats(); // Load stats on login
    } else {
        if (authActions) authActions.style.display = 'block';
        const userProfile = document.getElementById('userProfile');
        if (userProfile) userProfile.style.display = 'none';

        document.getElementById('statsSection').style.display = 'none'; // Hide stats

        if (loginPrompt) loginPrompt.style.display = 'block';
        if (noteInputSection) noteInputSection.style.display = 'none';
    }
}

function openAuthModal(isLogin) {
    const modal = document.getElementById('authModal');
    const title = document.getElementById('authModalTitle');
    const submitBtn = document.getElementById('authSubmitBtn');
    const switchText = document.getElementById('authSwitchText');
    const switchBtn = document.getElementById('authSwitchBtn');

    if (modal) {
        modal.style.display = 'block';
        modal.dataset.mode = isLogin ? 'login' : 'register';
        if (title) title.textContent = isLogin ? '登录' : '注册';
        if (submitBtn) submitBtn.textContent = isLogin ? '登录' : '注册';

        if (switchText && switchBtn) {
            switchText.textContent = isLogin ? '没有账号？' : '已有账号？';
            switchBtn.textContent = isLogin ? '去注册' : '去登录';
        }
    }
}

function closeAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.style.display = 'none';
}

async function handleAuthSubmit() {
    const modal = document.getElementById('authModal');
    const mode = modal.dataset.mode;
    const username = document.getElementById('authUsername').value;
    const password = document.getElementById('authPassword').value;

    if (!username || !password) {
        showToast('请输入用户名和密码');
        return;
    }

    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await response.json();

        if (response.ok) {
            showToast(mode === 'login' ? '登录成功' : '注册成功');
            closeAuthModal();
            checkAuthStatus();
            loadNotes(true);
            // Refresh heatmap
            initHeatmap();
        } else {
            showToast(data.error || '操作失败');
        }
    } catch (e) {
        showToast('网络错误');
    }
}

async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
}

// === Note Logic ===

async function loadNotes(reset = false) {
    if (isLoading) return;
    if (reset) {
        currentPage = 1;
        notes = [];
        hasNextPage = true;
    }

    isLoading = true;
    const list = document.getElementById('notesList');
    if (reset && list) list.innerHTML = ''; // Clear properly

    try {
        // Build query
        let url;
        const searchVal = document.getElementById('searchInput')?.value.trim() || '';

        if (isTrashMode) {
             url = `/api/notes/trash?page=${currentPage}&per_page=20`;
        } else {
             // Unified Query: Search can now be combined with Tag and Date
             url = `/api/notes/search?page=${currentPage}&per_page=20`;
             if (searchVal) url += `&keyword=${encodeURIComponent(searchVal)}`;
             if (currentFilterTag) url += `&tag=${encodeURIComponent(currentFilterTag)}`;
             // Note: Backend /search endpoint might need to support 'date' parameter if we want to combine all three.
             // Currently notes.py/search_notes doesn't seem to support date, but let's check notes.py again.
             // If not, we fallback to /notes for non-search, or update backend.
             // For now, let's keep it simple: If searchVal exists, use search endpoint. 
             // If not, use standard list endpoint which supports date/tag.
             
             if (searchVal) {
                 // The search endpoint in notes.py (checked earlier) returns a list (all results), not pagination object? 
                 // Let's re-verify notes.py content. 
                 // It returns `jsonify([note.to_dict() for note in results])`. No pagination.
                 // This is a limitation. For now, let's stick to the previous logic but improving the UI reset.
                 url = `/api/notes/search?keyword=${encodeURIComponent(searchVal)}`;
                 if (currentFilterTag) url += `&tag=${encodeURIComponent(currentFilterTag)}`;
             } else {
                 url = `/api/notes?page=${currentPage}&per_page=20`;
                 if (currentFilterTag) url += `&tag=${encodeURIComponent(currentFilterTag)}`;
                 if (currentDateFilter) url += `&date=${encodeURIComponent(currentDateFilter)}`;
             }
        }

        const response = await fetch(url);
        const data = await response.json();

        // Handle pagination response structure
        let newNotes = [];
        
        // Check if data is array (Search endpoint) or Object (Paginated endpoint)
        if (Array.isArray(data)) {
            newNotes = data;
            hasNextPage = false; // Search endpoint currently returns all matches
        } else if (data.notes && Array.isArray(data.notes)) {
            newNotes = data.notes;
            // Update pagination status
            if (data.has_next !== undefined) hasNextPage = data.has_next;
            else if (newNotes.length < 20) hasNextPage = false;
        }

        if (reset) notes = newNotes;
        else notes = [...notes, ...newNotes];

        renderNotes(newNotes, reset);
        if (!Array.isArray(data)) currentPage++; // Only increment page if using pagination

    } catch (e) {
        console.error("Load notes failed", e);
    } finally {
        isLoading = false;
    }
}

function renderNotes(notesToRender, reset = false) {
    const list = document.getElementById('notesList');
    if (!list) return;

    if (reset) list.innerHTML = '';

    if (notesToRender.length === 0 && notes.length === 0) {
        list.innerHTML = '<div class="empty-state" style="text-align:center; padding:40px; color:#999;">还没有笔记，记录下第一条吧</div>';
        return;
    }

    notesToRender.forEach(note => {
        const isOwner = currentUser && note.user_id === currentUser.id;
        const card = document.createElement('div');
        card.className = 'note-card';
        card.id = `note-${note.id}`;

        let content = note.content;
        try {
            if (typeof marked !== 'undefined') {
                content = DOMPurify.sanitize(marked.parse(parseWikiLinks(note.content)));
            } else {
                // Fallback if marked is missing
                content = DOMPurify.sanitize(parseWikiLinks(note.content)).replace(/\n/g, '<br>');
            }
        } catch (e) {
            console.error('Markdown rendering failed', e);
            content = note.content; // Fallback to raw text
        }

        card.innerHTML = `
            <div class="note-header">
                <span>${formatDate(note.created_at)}</span>
                ${note.is_public ? '<i class="fas fa-globe" title="公开"></i>' : '<i class="fas fa-lock" title="私密"></i>'}
            </div>
            <div class="note-content markdown-body">${content}</div>

            <div class="note-tags">
                ${note.tags.map(t => `<span class="note-tag" onclick="filterByTag('${escapeHtml(t)}')">#${escapeHtml(t)}</span>`).join('')}
            </div>

            ${isOwner ? (isTrashMode ? `
            <div class="note-actions">
                <span class="note-action restore" onclick="restoreNote('${note.id}')" title="恢复"><i class="fas fa-undo"></i></span>
                <span class="note-action delete-forever" onclick="permanentDeleteNote('${note.id}')" title="彻底删除" style="color:#ef4444;"><i class="fas fa-ban"></i></span>
            </div>
            ` : `
            <div class="note-actions">
                <span class="note-action edit" onclick="startInlineEdit('${note.id}')" title="编辑"><i class="fas fa-edit"></i></span>
                <span class="note-action history" onclick="showHistory('${note.id}')" title="历史版本"><i class="fas fa-history"></i></span>
                <span class="note-action delete" onclick="deleteNote('${note.id}')" title="删除"><i class="fas fa-trash"></i></span>
            </div>`) : ''}

            <div id="backlinks-${note.id}" class="backlinks-section" style="display: none; margin-top:10px; padding-top:10px; border-top:1px dashed #eee; font-size:0.8rem; color:#888;"></div>
        `;
        list.appendChild(card);
        if (!isTrashMode) loadBacklinks(note.id); 
    });

    // Initialize syntax highlighting
    if (window.hljs) hljs.highlightAll();

    // Add Copy Button to Code Blocks
    document.querySelectorAll('pre code').forEach((block) => {
        // Check if button already exists (in case of re-render issues)
        if (block.parentNode.querySelector('.copy-code-btn')) return;

        const button = document.createElement('button');
        button.className = 'copy-code-btn';
        button.innerHTML = '<i class="far fa-copy"></i>';
        button.title = '复制/Copy';
        
        // Style the button (can also be moved to CSS)
        button.style.position = 'absolute';
        button.style.right = '10px';
        button.style.top = '10px';
        button.style.background = 'rgba(255,255,255,0.1)';
        button.style.border = 'none';
        button.style.color = '#fff';
        button.style.padding = '4px 8px';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
        button.style.fontSize = '12px';
        button.style.opacity = '0.6';
        button.style.transition = 'opacity 0.2s';
        
        // Ensure parent (pre) is positioned
        block.parentNode.style.position = 'relative';
        
        button.onmouseover = () => button.style.opacity = '1';
        button.onmouseout = () => button.style.opacity = '0.6';
        
        button.onclick = () => {
            const code = block.innerText; // Get raw text
            navigator.clipboard.writeText(code).then(() => {
                button.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => button.innerHTML = '<i class="far fa-copy"></i>', 2000);
            });
        };
        
        block.parentNode.appendChild(button);
    });

    // Update Image Viewer
    if (galleryViewer) galleryViewer.update();
}

// === Version History Logic ===

async function showHistory(noteId) {
    const modal = document.getElementById('versionModal');
    const list = document.getElementById('versionList');
    const preview = document.getElementById('versionPreview');
    
    if (modal) {
        modal.style.display = 'block';
        list.innerHTML = '<div style="text-align:center; padding:20px; color:#999;">加载中...</div>';
        preview.style.display = 'none';
        
        // Close handler
        const closeBtn = modal.querySelector('.close-version');
        if (closeBtn) closeBtn.onclick = () => modal.style.display = 'none';
        window.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        
        try {
            const response = await fetch(`/api/notes/${noteId}/versions`);
            const versions = await response.json();
            
            if (versions.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:20px; color:#666;">暂无历史版本</div>';
                return;
            }
            
            list.innerHTML = versions.map(v => `
                <div class="version-item">
                    <div class="version-info">
                        <span class="version-date">${v.created_at}</span>
                        <span class="version-meta">${v.title || '无标题'}</span>
                    </div>
                    <div class="version-actions">
                        <button class="btn btn-secondary btn-sm" onclick='previewVersion(${JSON.stringify(v).replace(/'/g, "&#39;")})'>预览</button>
                        <button class="btn btn-primary btn-sm" onclick="restoreVersion('${noteId}', ${v.id})">恢复</button>
                    </div>
                </div>
            `).join('');
            
        } catch (e) {
            list.innerHTML = '<div style="text-align:center; color:red;">加载失败</div>';
        }
    }
}

window.previewVersion = function(version) {
    const preview = document.getElementById('versionPreview');
    if (preview) {
        let content = version.content;
        try {
            if (typeof marked !== 'undefined') content = DOMPurify.sanitize(marked.parse(content));
        } catch(e) {}
        
        preview.innerHTML = `<div class="version-preview-header">预览版本: ${version.created_at}</div>` + content;
        preview.style.display = 'block';
    }
};

async function restoreVersion(noteId, versionId) {
    if (!confirm('确定要恢复到此版本吗？当前内容将保存为新版本。')) return;
    
    try {
        const response = await fetch(`/api/notes/${noteId}/versions/${versionId}/restore`, { method: 'POST' });
        if (response.ok) {
            showToast('已恢复版本');
            document.getElementById('versionModal').style.display = 'none';
            loadNotes(true); // Force reset list to show updated content
        } else {
            showToast('恢复失败');
        }
    } catch (e) {
        showToast('网络错误');
    }
}

async function restoreNote(id) {
    try {
        const response = await fetch(`/api/notes/${id}/restore`, { method: 'POST' });
        if (response.ok) {
            const card = document.getElementById(`note-${id}`);
            if (card) {
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            }
            showToast('已恢复');
        } else {
            showToast('恢复失败');
        }
    } catch (e) {
        showToast('网络错误');
    }
}

async function permanentDeleteNote(id) {
    if (!confirm('彻底删除后无法恢复，确定吗？')) return;
    try {
        const response = await fetch(`/api/notes/${id}/permanent`, { method: 'DELETE' });
        if (response.ok) {
            const card = document.getElementById(`note-${id}`);
            if (card) {
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            }
            showToast('已彻底删除');
        } else {
            showToast('删除失败');
        }
    } catch (e) {
        showToast('网络错误');
    }
}

async function saveNote() {
    const content = document.getElementById('noteContent').value.trim();
    const isPublic = document.getElementById('noteIsPublic').checked;
    const saveBtn = document.getElementById('saveNote');
    const originalText = saveBtn.innerText;

    if (!content) return showToast('内容不能为空');

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
        const response = await fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, tags: currentTags, is_public: isPublic })
        });

        if (response.ok) {
            document.getElementById('noteContent').value = '';
            localStorage.removeItem('note_draft_content'); // Clear draft
            currentTags = [];
            renderTags('input');
            // Reload stream
            loadNotes(true);
            loadTags(); // Refresh sidebar tags
            initHeatmap(); // Refresh heatmap
            loadOverviewStats(); // Refresh stats
            showToast('已记录');
        } else {
            showToast('保存失败');
        }
    } catch (e) {
        showToast('网络错误');
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = originalText; // Or "记录"
        saveBtn.innerHTML = '记录';
    }
}

async function deleteNote(id) {
    if (!confirm('确定要删除这条笔记吗？')) return;
    try {
        const response = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
        if (response.ok) {
            const card = document.getElementById(`note-${id}`);
            if (card) {
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            }
            showToast('已删除');
            initHeatmap();
        } else {
            showToast('删除失败');
        }
    } catch (e) {
        showToast('网络错误');
    }
}

async function searchNotes(query) {
    if (!query) {
        loadNotes(true);
        return;
    }

    const list = document.getElementById('notesList');
    list.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">搜索中...</div>';

    try {
        // Fix: Backend expects 'keyword', not 'q'
        const response = await fetch(`/api/notes/search?keyword=${encodeURIComponent(query)}`);
        const data = await response.json();

        notes = data; // Update local cache if needed, or just render
        renderNotes(data, true);
    } catch (e) {
        console.error(e);
        list.innerHTML = '<div style="text-align:center; color:#999;">搜索失败</div>';
    }
}

// === Tag Logic ===

async function loadTags() {
    try {
        const response = await fetch('/api/tags');
        const tags = await response.json();
        const container = document.querySelector('.filter-tags-list');
        if (container) {
            // Keep "All" button
            // Use 'sidebar-tag' class which is defined in CSS
            container.innerHTML = `<button class="sidebar-tag ${currentFilterTag === '' ? 'active' : ''}" onclick="filterByTag('')" style="width:100%; border:none; background:transparent;">
                <span style="font-weight:600;">全部</span>
            </button>`;

            tags.forEach(t => {
                const btn = document.createElement('button');
                // Use 'sidebar-tag' class
                btn.className = `sidebar-tag ${currentFilterTag === t ? 'active' : ''}`;
                btn.style.width = '100%'; // Ensure full width
                btn.style.border = 'none';
                btn.style.background = 'transparent';
                btn.innerHTML = `<span># ${escapeHtml(t)}</span>`;
                btn.onclick = () => filterByTag(t);
                container.appendChild(btn);
            });
        }
    } catch (e) {}
}

function filterByTag(tagName) {
    currentFilterTag = tagName;
    loadNotes(true);
    // Update UI active state
    document.querySelectorAll('.sidebar-tag').forEach(btn => {
        // Simple check for text content or attribute
        // The "All" button has specific HTML structure now, so we need to be careful
        const textSpan = btn.querySelector('span');
        const text = textSpan ? textSpan.textContent.replace('# ', '') : btn.textContent;

        if (tagName === '' && text === '全部') btn.classList.add('active');
        else if (text === tagName) btn.classList.add('active');
        else btn.classList.remove('active');
    });
}

function addTag(tag, type) {
    if (!tag) return;
    const tags = type === 'input' ? currentTags : editTags;
    if (!tags.includes(tag)) {
        tags.push(tag);
        renderTags(type);
    }
}

function renderTags(type) {
    const container = document.getElementById(type === 'input' ? 'tagsList' : 'editTagsList');
    if (!container) return;
    const tags = type === 'input' ? currentTags : editTags;

    container.innerHTML = tags.map(t => `
        <span class="filter-tag active" style="font-size:0.8rem; margin-right:5px; display:inline-flex; align-items:center;">
            ${escapeHtml(t)} <span style="cursor:pointer;margin-left:5px;" onclick="removeTag('${escapeHtml(t)}', '${type}')">&times;</span>
        </span>
    `).join('');
}

window.removeTag = function(tag, type) {
    if (type === 'input') currentTags = currentTags.filter(t => t !== tag);
    else editTags = editTags.filter(t => t !== tag);
    renderTags(type);
};

// === Heatmap Logic ===
async function initHeatmap() {
    const container = document.getElementById('heatmapGrid');
    if (!container) return;

    // Ensure tooltip element exists
    let tooltip = document.getElementById('heatmapTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'heatmapTooltip';
        tooltip.className = 'custom-tooltip';
        document.body.appendChild(tooltip);
    }

    try {
        const response = await fetch('/api/stats/heatmap');
        if (!response.ok) return;
        const data = await response.json();

        container.innerHTML = '';

        // SVG Config
        const boxSize = 12; // Slightly smaller for cleaner look
        const gap = 3;
        const weeks = 12;
        const days = 7;
        const width = weeks * (boxSize + gap);
        const height = days * (boxSize + gap);

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.style.height = "auto";
        svg.style.display = "block";
        svg.style.margin = "0 auto";

        // Calculate start date
        const today = new Date();
        const startDate = new Date();
        const dayOfWeek = startDate.getDay();
        startDate.setDate(startDate.getDate() - dayOfWeek);
        startDate.setDate(startDate.getDate() - ((weeks - 1) * 7));

        const formatDate = d => d.toISOString().split('T')[0];

        for (let w = 0; w < weeks; w++) {
            for (let d = 0; d < days; d++) {
                const currentDate = new Date(startDate);
                currentDate.setDate(startDate.getDate() + (w * 7) + d);

                if (currentDate > today) continue;

                const dateStr = formatDate(currentDate);
                const count = data[dateStr] || 0;

                let color = '#F1F5F9'; // slate-100
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
                rect.setAttribute("class", "heatmap-cell");
                rect.style.cursor = 'pointer';

                // Mouse Events for Custom Tooltip
                rect.addEventListener('mouseenter', (e) => {
                    const dateText = new Date(dateStr).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
                    tooltip.innerHTML = `<strong>${dateText}</strong> · ${count} 条笔记`;
                    tooltip.style.opacity = '1';
                    
                    // Initial Position
                    const rectBox = rect.getBoundingClientRect();
                    tooltip.style.left = `${rectBox.left + rectBox.width / 2}px`;
                    tooltip.style.top = `${rectBox.top}px`; // Set to top edge, CSS transform moves it up
                });

                rect.addEventListener('mouseleave', () => {
                    tooltip.style.opacity = '0';
                });

                // Click Filter
                rect.addEventListener('click', () => {
                    svg.querySelectorAll('rect').forEach(r => {
                        // Reset color based on its original fill logic, or just remove stroke
                        // Simple way: reset stroke
                        r.setAttribute('stroke', 'none');
                    });
                    rect.setAttribute('stroke', '#1E293B');
                    rect.setAttribute('stroke-width', '2');
                    filterByDate(dateStr);
                });

                svg.appendChild(rect);
            }
        }
        container.appendChild(svg);
        container.style.display = 'block';
        container.style.borderTop = 'none';

    } catch (e) {
        console.error("Heatmap load failed", e);
    }
}

// === Sidebar Toggle (New) ===
function initSidebarToggle() {
    const toggleBtn = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const appContainer = document.querySelector('.app-container');

    // Create floating button for reopening if not exists
    let floatBtn = document.querySelector('.floating-menu-btn');
    if (!floatBtn) {
        floatBtn = document.createElement('button');
        floatBtn.className = 'floating-menu-btn';
        floatBtn.innerHTML = '<i class="fas fa-bars"></i>';
        floatBtn.title = '展开侧边栏';
        floatBtn.onclick = () => {
            sidebar.classList.remove('collapsed');
            appContainer.classList.remove('sidebar-closed');
            floatBtn.style.display = 'none';
        };
        document.body.appendChild(floatBtn);
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            sidebar.classList.add('collapsed');
            appContainer.classList.add('sidebar-closed');
            floatBtn.style.display = 'block';
        });
    }
}

// === Stats & Header Logic (New) ===
function updateHeaderDate() {
    const el = document.getElementById('currentDateDisplay');
    const icon = document.querySelector('.header-left i');

    if (currentDateFilter) {
        // Show filtered date
        const dateObj = new Date(currentDateFilter);
        // Add clickable breadcrumb class
        el.innerHTML = `<span class="clickable-crumb" onclick="clearDateFilter()">首页</span> <span class="divider">/</span> <span style="color:var(--slate-800); font-weight:600;">${currentDateFilter}</span>`;
        if (icon) icon.className = "fas fa-filter";
    } else {
        // Show today's date
        const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
        const todayStr = new Date().toLocaleDateString('zh-CN', options);
        el.innerHTML = todayStr;
        if (icon) icon.className = "fas fa-home";
    }
}

function clearDateFilter() {
    currentDateFilter = '';
    loadNotes(true);
    updateHeaderDate();
    // Reset heatmap selection styling if any
    document.querySelectorAll('.day-cell').forEach(c => c.style.border = 'none');
}

function filterByDate(dateStr) {
    if (currentDateFilter === dateStr) {
        clearDateFilter();
        return;
    }
    currentDateFilter = dateStr;
    loadNotes(true);
    updateHeaderDate();

    // Highlight selected cell
    document.querySelectorAll('.day-cell').forEach(c => {
        if (c.dataset.date === dateStr) {
            c.style.border = '2px solid var(--slate-800)';
        } else {
            c.style.border = 'none';
        }
    });
}

async function loadOverviewStats() {
    // Only load if user is logged in
    if (!currentUser) {
        document.getElementById('statsSection').style.display = 'none';
        return;
    }

    try {
        const response = await fetch('/api/stats/overview');
        if (response.ok) {
            const data = await response.json();
            document.getElementById('statsSection').style.display = 'block';

            // Animate numbers? Simple text set for now
            document.getElementById('statNoteCount').textContent = data.notes;
            document.getElementById('statTagCount').textContent = data.tags;
            document.getElementById('statDayCount').textContent = data.days;
        }
    } catch (e) {
        console.error("Stats load failed", e);
    }
}

// === Mobile Menu ===
function initMobileMenu() {
    const btn = document.getElementById('mobileMenuBtn');
    const sidebar = document.querySelector('.sidebar');

    if (!btn || !sidebar) return;

    btn.addEventListener('click', () => {
        sidebar.classList.toggle('mobile-open');
    });

    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', (e) => {
        if (window.innerWidth <= 900 &&
            sidebar.classList.contains('mobile-open') &&
            !sidebar.contains(e.target) &&
            !btn.contains(e.target)) {
            sidebar.classList.remove('mobile-open');
        }
    });
}

// === AI Features ===
function setupAITools(textarea) {
    const footer = textarea.parentElement.querySelector('.editor-footer');
    const controls = footer.querySelector('.input-controls');
    if (!controls) return;

    const aiBtn = document.createElement('button');
    // Change 'icon-btn' to 'tool-btn' to match other editor buttons
    aiBtn.className = 'tool-btn ai-trigger';
    aiBtn.innerHTML = '<i class="fas fa-magic"></i>';
    aiBtn.title = 'AI 助手';
    aiBtn.onclick = (e) => showAIMenu(e, textarea);
    controls.appendChild(aiBtn);
}

function showAIMenu(event, textarea) {
    event.preventDefault();
    event.stopPropagation();

    fetch('/api/ai/custom_prompts')
        .then(res => res.json())
        .then(prompts => {
            const existing = document.getElementById('aiMenu');
            if (existing) existing.remove();

            const menu = document.createElement('div');
            menu.id = 'aiMenu';
            menu.className = 'ai-dropdown-menu';

            let html = `
                <div class="ai-menu-item" onclick="aiActionStream('${textarea.id}', 'tags')"><i class="fas fa-tags"></i> 自动标签</div>
                <div class="ai-menu-item" onclick="aiActionStream('${textarea.id}', 'summary')"><i class="fas fa-align-left"></i> 生成摘要</div>
                <div class="ai-menu-item" onclick="aiActionStream('${textarea.id}', 'polish')"><i class="fas fa-pen-fancy"></i> 润色文本</div>
            `;

            if (prompts && prompts.length > 0) {
                html += `<div style="border-top:1px solid #eee; margin:5px 0;"></div>`;
                window.currentCustomPrompts = prompts;
                prompts.forEach(p => {
                     html += `<div class="ai-menu-item" onclick="aiActionStream('${textarea.id}', 'custom', '${p.id}')"><i class="fas fa-star"></i> ${p.name}</div>`;
                });
            }

            html += `<div style="border-top:1px solid #eee; margin:5px 0;"></div>
                     <div class="ai-menu-item" onclick="window.location.href='/settings'"><i class="fas fa-cog"></i> 设置</div>`;

            menu.innerHTML = html;
            document.body.appendChild(menu);

            const rect = event.currentTarget.getBoundingClientRect();
            menu.style.top = `${rect.bottom + 5}px`;
            menu.style.left = `${rect.left}px`;
            menu.style.display = 'block';

            const closeMenu = () => {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
        });
}

async function aiActionStream(textareaId, type, customId = null) {
    const textarea = document.getElementById(textareaId);
    const content = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd) || textarea.value.trim();

    if (!content) return showToast('请先选择或输入内容');

    // Remove any existing preview
    document.querySelectorAll('.ai-preview-box').forEach(el => el.remove());

    const previewId = `ai-preview-${Date.now()}`;
    const previewBox = document.createElement('div');
    previewBox.className = 'ai-preview-box';
    previewBox.id = previewId;
    previewBox.innerHTML = `
        <div class="ai-preview-content"><span class="ai-streaming-indicator"></span></div>
        <div class="ai-preview-actions" style="display:none">
            <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="discardAI('${previewId}')">放弃</button>
            <button class="btn btn-primary" style="padding:4px 10px; font-size:12px;" onclick="applyAI('${previewId}', '${textareaId}')">应用</button>
        </div>
    `;

    textarea.parentNode.insertBefore(previewBox, textarea.nextSibling);
    const contentDiv = previewBox.querySelector('.ai-preview-content');
    const actionsDiv = previewBox.querySelector('.ai-preview-actions');

    let systemPrompt = "你是一个乐于助人的助手。";
    let userPrompt = "";

    if (type === 'tags') {
        userPrompt = `分析以下文本并建议3-5个标签。只返回标签，用空格分隔。文本：${content}`;
    } else if (type === 'summary') {
        userPrompt = `简洁总结：${content}`;
    } else if (type === 'polish') {
        userPrompt = `润色此文本：${content}`;
    } else if (type === 'custom' && customId) {
        const promptObj = window.currentCustomPrompts?.find(p => p.id === customId);
        if (promptObj) {
            systemPrompt = promptObj.system_prompt || systemPrompt;
            userPrompt = promptObj.template.replace('{content}', content);
        }
    }

    try {
        const response = await fetch('/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: userPrompt, system_prompt: systemPrompt })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        // Remove loading indicator initially
        contentDiv.innerHTML = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            fullText += chunk;
            contentDiv.textContent = fullText;
        }

        previewBox.dataset.fullText = fullText;
        actionsDiv.style.display = 'flex';

    } catch (e) {
        contentDiv.textContent = "请求出错";
        setTimeout(() => previewBox.remove(), 2000);
    }
}

window.discardAI = function(previewId) {
    document.getElementById(previewId)?.remove();
};

window.applyAI = function(previewId, textareaId) {
    const box = document.getElementById(previewId);
    const textarea = document.getElementById(textareaId);
    const text = box.dataset.fullText;

    if (text && textarea) {
        if (textarea.selectionStart !== textarea.selectionEnd) {
            textarea.setRangeText(text);
        } else {
            // Append with newline
            textarea.value = textarea.value + "\n" + text;
        }
        showToast('已应用');
    }
    box.remove();
};

// === Utils ===

function initImageViewer() {
    const list = document.getElementById('notesList');
    if (list && typeof Viewer !== 'undefined') {
        galleryViewer = new Viewer(list, {
            button: true,
            navbar: false,
            title: false,
            toolbar: {
                zoomIn: 1,
                zoomOut: 1,
                oneToOne: 1,
                reset: 1,
                prev: 0,
                next: 0,
                rotateLeft: 0,
                rotateRight: 0,
                flipHorizontal: 0,
                flipVertical: 0,
            },
            filter(image) {
                return image.closest('.note-content'); // Only note images
            }
        });
    }
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = message;
        toast.className = 'toast show';
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    } else {
        // Create toast if not exists
        const t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast show';
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(() => { t.className = 'toast'; }, 3000);
    }
}

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    // Within 1 hour
    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return mins < 1 ? '刚刚' : `${mins}分钟前`;
    }

    // Within 24 hours
    if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)}小时前`;
    }

    // Otherwise Date
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
}

function parseWikiLinks(content) {
    if (!content) return '';
    return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, title, display) => {
        return `<a href="#" class="wiki-link" onclick="handleWikiLinkClick(event, '${title.trim()}')">${(display || title).trim()}</a>`;
    });
}

function handleWikiLinkClick(e, title) {
    e.preventDefault();
    const searchInput = document.getElementById('searchInput');
    if(searchInput) {
        searchInput.value = title;
        searchNotes(title);
    }
}

async function loadBacklinks(noteId) {
    try {
        const response = await fetch(`/api/notes/${noteId}/backlinks`);
        const backlinks = await response.json();
        const container = document.getElementById(`backlinks-${noteId}`);
        if (backlinks.length > 0 && container) {
            container.style.display = 'block';
            container.innerHTML = `引用: ` +
                backlinks.map(l => `<a href="#note-${l.id}" style="margin-right:10px; color:var(--primary-color); text-decoration:none;">${l.title}</a>`).join('');
        }
    } catch(e) {}
}

// === Editor Plugins ===

function setupPasteImage(textarea) {
    textarea.addEventListener('paste', async function(e) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        let file = null;

        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                file = items[i].getAsFile();
                break;
            }
        }

        if (!file) return;
        e.preventDefault();

        const formData = new FormData();
        formData.append('file', file);
        showToast('正在上传图片...');

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            if (response.ok) {
                const pos = textarea.selectionStart;
                const md = `\n![image](${data.url})\n`;
                textarea.setRangeText(md);
                showToast('图片上传成功');
            } else {
                showToast('上传失败');
            }
        } catch (e) {
            showToast('上传出错');
        }
    });
}

function setupAutocomplete(textarea) {
    let dropdown = null;

    textarea.addEventListener('input', debounce(async function(e) {
        const cursor = this.selectionStart;
        const textBefore = this.value.substring(0, cursor);
        const match = textBefore.match(/\[\[([^\]]*)$/);

        if (match) {
            const query = match[1];
            if (!dropdown) {
                dropdown = document.createElement('div');
                dropdown.className = 'autocomplete-dropdown';
                document.body.appendChild(dropdown);
            }

            const coords = getCaretCoordinates(this, cursor);

            try {
                const response = await fetch('/api/notes/titles');
                const titles = await response.json();
                const filtered = titles.filter(t => t.title.toLowerCase().includes(query.toLowerCase()) && t.title !== 'Untitled').slice(0, 5);

                if (filtered.length > 0) {
                    dropdown.innerHTML = filtered.map(t =>
                        `<div class="ac-item">${t.title}</div>`
                    ).join('');

                    dropdown.querySelectorAll('.ac-item').forEach((item, index) => {
                        item.onclick = () => {
                            const title = filtered[index].title;
                            const newText = textBefore.substring(0, textBefore.lastIndexOf('[[')) + `[[${title}]]`;
                            const rest = this.value.substring(cursor);
                            this.value = newText + rest;
                            dropdown.style.display = 'none';
                            this.focus();
                        };
                    });

                    const rect = this.getBoundingClientRect();
                    dropdown.style.left = `${rect.left + coords.left}px`;
                    dropdown.style.top = `${rect.top + coords.top + 20}px`;
                    dropdown.style.display = 'block';
                } else {
                    dropdown.style.display = 'none';
                }
            } catch(e) {}
        } else {
            if (dropdown) dropdown.style.display = 'none';
        }
    }, 200));
}

// Simple caret coordinates helper
function getCaretCoordinates(element, position) {
    const div = document.createElement('div');
    const style = getComputedStyle(element);
    Array.from(style).forEach(prop => div.style[prop] = style.getPropertyValue(prop));
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.whiteSpace = 'pre-wrap';
    div.textContent = element.value.substring(0, position);
    const span = document.createElement('span');
    span.textContent = element.value.substring(position) || '.';
    div.appendChild(span);
    document.body.appendChild(div);
    const coords = { top: span.offsetTop, left: span.offsetLeft };
    document.body.removeChild(div);
    return coords;
}

// Editor Inline Edit
function startInlineEdit(id) {
    const card = document.getElementById(`note-${id}`);
    const contentDiv = card.querySelector('.note-content');
    const tagsDiv = card.querySelector('.note-tags');
    const actionsDiv = card.querySelector('.note-actions'); // Hide original actions
    
    // Hide parts we are replacing/covering
    if (tagsDiv) tagsDiv.style.display = 'none';
    if (actionsDiv) actionsDiv.style.display = 'none';

    // Fetch full note details first
    fetch(`/api/notes/${id}`).then(res => res.json()).then(note => {
        // Initialize edit state
        editTags = [...note.tags]; // Copy tags

        // Wrapper
        const container = document.createElement('div');
        container.className = 'inline-editor-container';

        // 1. Textarea
        const textarea = document.createElement('textarea');
        textarea.value = note.content;
        textarea.id = `edit-textarea-${id}`; // For AI targeting
        textarea.className = 'inline-editor-textarea';
        
        // Auto-resize
        setTimeout(() => {
            textarea.style.height = 'auto';
            textarea.style.height = (textarea.scrollHeight + 10) + 'px';
        }, 0);
        textarea.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight + 10) + 'px';
        });

        // 2. Tools Bar (AI)
        const toolsBar = document.createElement('div');
        toolsBar.className = 'inline-tools-bar';
        
        const toolsLeft = document.createElement('div');
        toolsLeft.className = 'inline-tools-left input-controls'; // 'input-controls' for setupAITools to find
        
        // Image Upload Button
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
                
                try {
                    const res = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });
                    const data = await res.json();
                    if (res.ok) {
                        const pos = textarea.selectionStart;
                        const md = `\n![image](${data.url})\n`;
                        textarea.setRangeText(md);
                        showToast('图片上传成功');
                    } else {
                        showToast('上传失败');
                    }
                } catch(err) {
                    showToast('上传出错');
                }
            };
            fileInput.click();
        };
        
        toolsLeft.appendChild(imgBtn);
        
        // We will call setupAITools later to fill this
        toolsBar.appendChild(toolsLeft);

        // 3. Tags Area
        const tagsArea = document.createElement('div');
        tagsArea.className = 'inline-tags-area';
        tagsArea.id = 'editTagsList'; // Reuse renderTags logic by temporarily using this ID? 
        // Actually, renderTags uses global `editTags` variable and target ID.
        // Let's customize renderTags logic slightly or create a specific renderer for inline.
        
        const tagInput = document.createElement('input');
        tagInput.className = 'inline-tag-input';
        tagInput.placeholder = '+ 标签 (回车)';
        tagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = tagInput.value.trim();
                if (val && !editTags.includes(val)) {
                    editTags.push(val);
                    renderInlineTags(tagsArea, tagInput);
                    tagInput.value = '';
                }
            }
        });
        
        // Initial render
        renderInlineTags(tagsArea, tagInput);

        // 4. Footer (Public Switch & Actions)
        const footer = document.createElement('div');
        footer.className = 'inline-footer';

        // Public Switch
        const publicSwitch = document.createElement('div');
        publicSwitch.className = 'public-switch';
        publicSwitch.innerHTML = `
            <input type="checkbox" id="edit-public-${id}" ${note.is_public ? 'checked' : ''}>
            <label for="edit-public-${id}" title="设为公开"><i class="fas fa-globe-americas"></i> <span style="font-size:12px">公开</span></label>
        `;

        // Buttons
        const btnsDiv = document.createElement('div');
        btnsDiv.className = 'inline-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.className = 'btn btn-secondary btn-sm';
        cancelBtn.onclick = () => {
            loadNotes(true); // Reset list to restore original view
        };

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存修改';
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.onclick = async () => {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中';
            const isPublic = document.getElementById(`edit-public-${id}`).checked;
            
            try {
                const res = await fetch(`/api/notes/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        content: textarea.value,
                        tags: editTags, 
                        is_public: isPublic
                    })
                });
                
                if (res.ok) {
                    showToast('保存成功');
                    loadNotes(true); // Reload list to reflect changes
                } else {
                    throw new Error('Save failed');
                }
            } catch(e) {
                showToast('保存失败');
                saveBtn.disabled = false;
                saveBtn.textContent = '保存修改';
            }
        };

        btnsDiv.appendChild(cancelBtn);
        btnsDiv.appendChild(saveBtn);

        footer.appendChild(publicSwitch);
        footer.appendChild(btnsDiv);

        // Assemble
        container.appendChild(textarea);
        
        // Add a hidden footer container for setupAITools to find 'input-controls'
        // Actually, we can just append toolsBar.
        // Wait, setupAITools looks for `.editor-footer` -> `.input-controls`.
        // Let's mock that structure or adjust setupAITools.
        // Adjusting structure to match what setupAITools expects:
        const dummyFooter = document.createElement('div');
        dummyFooter.className = 'editor-footer'; // Used by setupAITools selector
        dummyFooter.style.border = 'none';
        dummyFooter.style.marginTop = '0';
        dummyFooter.style.paddingTop = '0';
        dummyFooter.appendChild(toolsLeft); // toolsLeft is .input-controls
        
        container.appendChild(dummyFooter); 
        container.appendChild(tagsArea);
        container.appendChild(footer);

        contentDiv.innerHTML = '';
        contentDiv.appendChild(container);
        
        // Setup AI
        setupAITools(textarea);
        
        textarea.focus();

    }).catch(e => {
        console.error(e);
        showToast('加载失败');
        if (tagsDiv) tagsDiv.style.display = 'flex';
        if (actionsDiv) actionsDiv.style.display = 'flex';
    });
}

function renderInlineTags(container, inputElement) {
    // Clear current tags (keep input)
    container.innerHTML = '';
    
    editTags.forEach(t => {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'note-tag';
        tagSpan.style.background = '#e2e8f0';
        tagSpan.style.color = '#475569';
        tagSpan.style.display = 'flex';
        tagSpan.style.alignItems = 'center';
        tagSpan.style.gap = '4px';
        tagSpan.innerHTML = `#${escapeHtml(t)} <span style="cursor:pointer; font-weight:bold" onclick="removeInlineTag('${escapeHtml(t)}')">&times;</span>`;
        // We need a way to pass the container and input back to render, or use global state better.
        // Closure issue with onclick string.
        // Better: attach event listener directly.
        tagSpan.querySelector('span').onclick = (e) => {
            e.stopPropagation();
            editTags = editTags.filter(x => x !== t);
            renderInlineTags(container, inputElement);
        };
        container.appendChild(tagSpan);
    });
    
    container.appendChild(inputElement);
    inputElement.focus();
}
