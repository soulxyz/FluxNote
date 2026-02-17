// Toast notification system
function showToast(message, type = 'success') {
    // Remove existing toast
    const existing = document.getElementById('comment-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'comment-toast';
    toast.className = `comment-toast comment-toast-${type}`;

    const icons = {
        success: '<i class="fas fa-check-circle"></i>',
        error: '<i class="fas fa-exclamation-circle"></i>',
        warning: '<i class="fas fa-exclamation-triangle"></i>',
        info: '<i class="fas fa-info-circle"></i>'
    };

    toast.innerHTML = `
        <span class="comment-toast-icon">${icons[type] || icons.info}</span>
        <span class="comment-toast-message">${message}</span>
    `;

    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Expose init function globally for SPA
window.initCommentWidget = function() {
    const postIdInput = document.getElementById('comment-post-id');
    if (postIdInput && postIdInput.value) {
        loadComments(postIdInput.value);
    }
    
    // Auto-fill visitor info from localStorage
    const authorInput = document.getElementById('comment-author');
    const emailInput = document.getElementById('comment-email');
    const websiteInput = document.getElementById('comment-website');
    
    if (authorInput && localStorage.getItem('comment_author')) {
        authorInput.value = localStorage.getItem('comment_author');
    }
    if (emailInput && localStorage.getItem('comment_email')) {
        emailInput.value = localStorage.getItem('comment_email');
    }
    if (websiteInput && localStorage.getItem('comment_website')) {
        websiteInput.value = localStorage.getItem('comment_website');
    }
};

// Auto-init when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initCommentWidget);
} else {
    window.initCommentWidget();
}

let isAdmin = false;

async function loadComments(postId) {
    const list = document.getElementById('comments-list');
    const countSpan = document.getElementById('comment-count');

    try {
        const response = await fetch(`/api/comments/${postId}`);
        const data = await response.json();

        if (data.error) {
            list.innerHTML = `<div style="color:var(--slate-500); text-align:center; padding:2rem;"><i class="fas fa-exclamation-circle"></i> ${data.error}</div>`;
            return;
        }

        countSpan.innerText = data.count;
        isAdmin = data.is_admin; // Store admin status

        list.innerHTML = '';

        if (data.comments.length === 0) {
            list.innerHTML = '<div style="text-align:center; color:var(--slate-400); padding:2rem;"><i class="far fa-comment-dots" style="font-size:2rem; margin-bottom:0.5rem; display:block;"></i>暂无评论，来抢沙发吧~</div>';
            return;
        }

        data.comments.forEach(comment => {
            const el = createCommentElement(comment);
            list.appendChild(el);
        });

    } catch (error) {
        console.error('Failed to load comments', error);
        list.innerHTML = '<div style="color:var(--slate-500); text-align:center; padding:2rem;"><i class="fas fa-exclamation-triangle"></i> 加载失败，请刷新重试</div>';
    }
}

function createCommentElement(comment) {
    const item = document.createElement('div');
    item.className = 'comment-item';
    item.id = `comment-${comment.id}`;

    let repliesHtml = '';
    if (comment.replies && comment.replies.length > 0) {
        repliesHtml = `<div class="comment-replies">
            ${comment.replies.map(reply => createReplyHtml(reply)).join('')}
        </div>`;
    }

    // Admin Controls
    let adminControls = '';
    if (isAdmin) {
        const approveBtn = comment.status === 'pending' 
            ? `<button class="comment-action-btn approve" onclick="approveComment(${comment.id})"><i class="fas fa-check"></i> 通过</button>` 
            : '';
        adminControls = `
            ${approveBtn}
            <button class="comment-action-btn delete" onclick="deleteComment(${comment.id})"><i class="fas fa-trash"></i> 删除</button>
        `;
    }

    const statusBadge = comment.status === 'pending' ? '<span class="comment-status-pending">待审核</span>' : '';

    item.innerHTML = `
        <img src="${comment.avatar}" class="comment-avatar" alt="${comment.author_name}">
        <div class="comment-body">
            <div class="comment-meta">
                ${comment.author_website 
                    ? `<a href="${comment.author_website}" target="_blank" class="comment-author ${comment.is_admin ? 'is-admin' : ''}">${comment.author_name}</a>` 
                    : `<span class="comment-author ${comment.is_admin ? 'is-admin' : ''}">${comment.author_name}</span>`
                }
                <span class="comment-date">${comment.created_at}</span>
                ${statusBadge}
            </div>
            <div class="comment-content">${comment.html}</div>
            <div class="comment-actions">
                <button class="comment-action-btn" onclick="replyTo(${comment.id}, '${comment.author_name}')"><i class="fas fa-reply"></i> 回复</button>
                ${adminControls}
            </div>
            ${repliesHtml}
        </div>
    `;
    return item;
}

function createReplyHtml(reply) {
    // Reuse similar logic for replies
    let adminControls = '';
    if (isAdmin) {
        const approveBtn = reply.status === 'pending' 
            ? `<button class="comment-action-btn approve" onclick="approveComment(${reply.id})"><i class="fas fa-check"></i> 通过</button>` 
            : '';
        adminControls = `
            ${approveBtn}
            <button class="comment-action-btn delete" onclick="deleteComment(${reply.id})"><i class="fas fa-trash"></i> 删除</button>
        `;
    }
    
    const statusBadge = reply.status === 'pending' ? '<span class="comment-status-pending">待审核</span>' : '';

    return `
        <div class="comment-item" id="comment-${reply.id}">
            <img src="${reply.avatar}" class="comment-avatar">
            <div class="comment-body">
                <div class="comment-meta">
                    ${reply.author_website 
                        ? `<a href="${reply.author_website}" target="_blank" class="comment-author ${reply.is_admin ? 'is-admin' : ''}">${reply.author_name}</a>` 
                        : `<span class="comment-author ${reply.is_admin ? 'is-admin' : ''}">${reply.author_name}</span>`
                    }
                    <span class="comment-date">${reply.created_at}</span>
                    ${statusBadge}
                </div>
                <div class="comment-content">${reply.html}</div>
                <div class="comment-actions">
                    <button class="comment-action-btn" onclick="replyTo(${reply.id}, '${reply.author_name}')"><i class="fas fa-reply"></i> 回复</button>
                    ${adminControls}
                </div>
            </div>
        </div>
    `;
}

async function deleteComment(id) {
    if (!confirm('确定要删除这条评论吗？')) return;
    try {
        const response = await fetch(`/api/comments/${id}`, { method: 'DELETE' });
        if (response.ok) {
            // Remove element or reload
            const el = document.getElementById(`comment-${id}`);
            if (el) el.remove();
            showToast('评论已删除', 'success');
            // Or reload to update counts correctly
            // loadComments(document.getElementById('comment-post-id').value);
        } else {
            showToast('删除失败', 'error');
        }
    } catch (e) {
        showToast('网络错误', 'error');
    }
}

async function approveComment(id) {
    try {
        const response = await fetch(`/api/comments/${id}/approve`, { method: 'POST' });
        if (response.ok) {
            // Reload to show updated status
            loadComments(document.getElementById('comment-post-id').value);
            showToast('评论已通过', 'success');
        } else {
            showToast('操作失败', 'error');
        }
    } catch (e) {
        showToast('网络错误', 'error');
    }
}

function replyTo(commentId, authorName) {
    document.getElementById('comment-parent-id').value = commentId;
    document.getElementById('reply-to-user').innerText = authorName;
    document.getElementById('reply-preview').style.display = 'flex';
    
    // Scroll to form
    document.getElementById('comment-form-wrapper').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('comment-content').focus();
}

function cancelReply() {
    document.getElementById('comment-parent-id').value = '';
    document.getElementById('reply-preview').style.display = 'none';
}

async function submitComment(event) {
    event.preventDefault();
    const btn = document.getElementById('comment-submit-btn');
    const originalText = btn.innerText;
    
    btn.disabled = true;
    btn.innerText = '提交中...';

    const postId = document.getElementById('comment-post-id').value;
    const parentId = document.getElementById('comment-parent-id').value;
    const content = document.getElementById('comment-content').value;
    
    const data = {
        post_id: postId,
        parent_id: parentId || null,
        content: content
    };

    // If visitor, get extra fields
    const authorInput = document.getElementById('comment-author');
    if (authorInput) {
        data.author_name = authorInput.value;
        data.author_email = document.getElementById('comment-email').value;
        data.author_website = document.getElementById('comment-website').value;
    }

    try {
        const response = await fetch(`/api/comments/${postId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Save visitor info to localStorage
            if (authorInput) {
                localStorage.setItem('comment_author', authorInput.value);
                localStorage.setItem('comment_email', document.getElementById('comment-email').value);
                localStorage.setItem('comment_website', document.getElementById('comment-website').value);
            }

            // Reset form
            document.getElementById('comment-content').value = '';
            cancelReply();
            
            // Reload comments
            loadComments(postId);

            // Show success toast
            showToast(result.message, 'success');
        } else {
            showToast(result.error || '提交失败', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('网络错误，请稍后重试', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}
