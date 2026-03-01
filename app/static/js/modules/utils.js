export function showToast(message) {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = message;
        toast.className = 'toast show';
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    } else {
        const t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast show';
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(() => { t.className = 'toast'; }, 3000);
    }
}

export function showConfirm(arg1, arg2) {
    return new Promise((resolve) => {
        let title, message, confirmText, cancelText, type;

        // 兼容两种调用方式：
        // showConfirm(message, options) 或 showConfirm(title, message)
        if (typeof arg2 === 'string') {
            // 旧方式: showConfirm(title, message)
            title = arg1;
            message = arg2;
            confirmText = '确定';
            cancelText = '取消';
            type = 'danger';
        } else {
            // 新方式: showConfirm(message, options)
            message = arg1;
            const options = arg2 || {};
            title = options.title || '确认操作';
            confirmText = options.confirmText || '确定';
            cancelText = options.cancelText || '取消';
            type = options.type || 'warning';
        }

        // Remove existing modal
        const existing = document.querySelector('.confirm-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'confirm-modal';
        modal.innerHTML = `
            <div class="confirm-modal-backdrop"></div>
            <div class="confirm-modal-content">
                <div class="confirm-modal-header">
                    <i class="confirm-modal-icon fas fa-exclamation-triangle" style="color: ${type === 'danger' ? '#ef4444' : '#f59e0b'}"></i>
                    <h3>${title}</h3>
                </div>
                <div class="confirm-modal-body">${message}</div>
                <div class="confirm-modal-footer">
                    <button class="btn btn-secondary cancel-btn">${cancelText}</button>
                    <button class="btn ${type === 'danger' ? 'btn-danger' : 'btn-primary'} confirm-btn">${confirmText}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Show animation
        requestAnimationFrame(() => modal.classList.add('show'));

        const close = (result) => {
            modal.classList.remove('show');
            setTimeout(() => modal.remove(), 250);
            resolve(result);
        };

        modal.querySelector('.cancel-btn').onclick = () => close(false);
        modal.querySelector('.confirm-btn').onclick = () => close(true);
        modal.querySelector('.confirm-modal-backdrop').onclick = () => close(false);
    });
}

// 挂载到全局，供非 module 脚本使用
window.showConfirm = showConfirm;
window.showToast = showToast;

export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

export function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return mins < 1 ? '刚刚' : `${mins}分钟前`;
    }

    if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)}小时前`;
    }

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });
}

// 格式化过期时间（支持未来时间）
export function formatExpiresAt(dateString) {
    if (!dateString) return '永久有效';

    const date = new Date(dateString);
    const now = new Date();
    const diff = date - now; // 未来时间为正数

    // 已过期
    if (diff < 0) {
        return '已过期';
    }

    // 1小时内
    if (diff < 3600000) {
        const mins = Math.floor(diff / 60000);
        return mins < 1 ? '即将过期' : `${mins}分钟后过期`;
    }

    // 24小时内
    if (diff < 86400000) {
        return `${Math.floor(diff / 3600000)}小时后过期`;
    }

    // 7天内
    if (diff < 604800000) {
        return `${Math.floor(diff / 86400000)}天后过期`;
    }

    // 更长时间显示具体日期
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' 过期';
}

export function parseWikiLinks(content) {
    if (!content) return '';
    return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, title, display) => {
        // We will handle the click via event delegation or global handler
        return `<a href="#" class="wiki-link" data-wiki-title="${escapeHtml(title.trim())}">${(display || title).trim()}</a>`;
    });
}

export function getCaretCoordinates(element, position) {
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
