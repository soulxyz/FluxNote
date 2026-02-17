/**
 * 公共登录模块
 * 提供登录、注册、WebAuthn 生物识别等功能
 * 主题可以调用这些方法来实现登录功能
 */

class AuthModule {
    constructor() {
        this.modal = null;
        this.isInitialized = false;
        this.onLoginSuccess = null;
        this.canRegister = true; // 默认允许注册，后续会从API获取
    }

    /**
     * 检查是否允许注册
     */
    async checkRegisterStatus() {
        try {
            const response = await fetch('/api/auth/can-register');
            const data = await response.json();
            this.canRegister = data.can_register;
            return this.canRegister;
        } catch (e) {
            console.error('Failed to check register status:', e);
            return false;
        }
    }

    /**
     * 初始化登录模块
     * @param {Object} options
     * @param {Function} options.onSuccess - 登录成功回调
     * @param {string} options.modalContainer - 模态框容器选择器（可选，默认创建）
     */
    init(options = {}) {
        this.onLoginSuccess = options.onSuccess || (() => window.location.reload());

        if (options.modalContainer) {
            this.modal = document.querySelector(options.modalContainer);
        } else {
            this.createModal();
        }

        this.bindEvents();
        this.isInitialized = true;
    }

    /**
     * 创建登录模态框
     */
    createModal() {
        const modalHTML = `
            <div id="authModal" class="modal">
                <div class="modal-content auth-modal-content">
                    <div class="modal-header">
                        <h2 id="authModalTitle">登录</h2>
                        <span class="close-auth">&times;</span>
                    </div>
                    <div class="modal-body">
                        <div class="form-group">
                            <label>用户名</label>
                            <input type="text" id="authUsername" placeholder="请输入用户名">
                        </div>
                        <div class="form-group">
                            <label>密码</label>
                            <input type="password" id="authPassword" placeholder="请输入密码">
                        </div>
                    </div>
                    <div class="modal-footer" style="flex-direction: column; gap: 10px;">
                        <div style="display:flex; gap:10px; width:100%;">
                            <button id="authSubmitBtn" class="btn btn-primary" style="flex:1;">登录</button>
                            <button id="webauthnLoginBtn" class="btn btn-secondary" title="使用指纹/面容登录" style="padding: 10px 15px;">
                                <i class="fas fa-fingerprint"></i>
                            </button>
                        </div>
                        <div class="auth-switch" style="text-align: center; font-size: 13px; color: #666;">
                            <span id="authSwitchText">没有账号？</span>
                            <a href="#" id="authSwitchBtn" style="color: var(--primary); font-weight: 600;">去注册</a>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.modal = document.getElementById('authModal');
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // 关闭按钮
        this.modal.querySelectorAll('.close-auth').forEach(btn => {
            btn.addEventListener('click', () => this.closeModal());
        });

        // 点击外部关闭
        window.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });

        // 提交按钮
        document.getElementById('authSubmitBtn').addEventListener('click', () => this.handleSubmit());

        // WebAuthn 登录
        document.getElementById('webauthnLoginBtn').addEventListener('click', () => this.loginWithWebAuthn());

        // 切换登录/注册
        document.getElementById('authSwitchBtn').addEventListener('click', (e) => {
            e.preventDefault();
            const isLogin = this.modal.dataset.mode === 'login';
            this.openModal(!isLogin);
        });

        // 回车提交
        document.getElementById('authPassword').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleSubmit();
        });
    }

    /**
     * 打开登录/注册模态框
     * @param {boolean} isLogin - true 为登录，false 为注册
     */
    async openModal(isLogin = true) {
        if (!this.isInitialized) this.init();

        // 检查注册状态
        await this.checkRegisterStatus();

        // 如果不允许注册且尝试打开注册模式，强制切换到登录模式
        if (!isLogin && !this.canRegister) {
            isLogin = true;
            this.showToast('系统已注册，请登录');
        }

        this.modal.style.display = 'block';
        this.modal.dataset.mode = isLogin ? 'login' : 'register';

        document.getElementById('authModalTitle').textContent = isLogin ? '登录' : '注册';
        document.getElementById('authSubmitBtn').textContent = isLogin ? '登录' : '注册';

        // 根据是否允许注册显示/隐藏注册切换
        const switchContainer = this.modal.querySelector('.auth-switch');
        if (switchContainer) {
            switchContainer.style.display = this.canRegister ? 'block' : 'none';
        }

        if (this.canRegister) {
            document.getElementById('authSwitchText').textContent = isLogin ? '没有账号？' : '已有账号？';
            document.getElementById('authSwitchBtn').textContent = isLogin ? '去注册' : '去登录';
        }

        document.getElementById('authUsername').focus();
    }

    /**
     * 关闭模态框
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    /**
     * 智能登录（优先尝试生物识别）
     */
    async smartLogin() {
        if (!this.isInitialized) this.init();

        // 如果此设备曾绑定 WebAuthn，优先尝试生物识别
        if (localStorage.getItem('has_webauthn') === 'true' && window.PublicKeyCredential) {
            try {
                const success = await this.loginWithWebAuthn();
                if (success) return true;
            } catch (e) {
                // 生物识别失败，显示模态框
            }
        }

        this.openModal(true);
        return false;
    }

    /**
     * 处理登录/注册提交
     */
    async handleSubmit() {
        const mode = this.modal.dataset.mode;
        const username = document.getElementById('authUsername').value.trim();
        const password = document.getElementById('authPassword').value;

        if (!username || !password) {
            this.showToast('请输入用户名和密码');
            return;
        }

        // 如果是注册模式，再次检查是否允许注册
        if (mode === 'register') {
            await this.checkRegisterStatus();
            if (!this.canRegister) {
                this.showToast('系统已注册，不允许新用户注册');
                return;
            }
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
                this.showToast(mode === 'login' ? '登录成功' : '注册成功');
                this.closeModal();
                this.onLoginSuccess(data);
            } else {
                this.showToast(data.error || '操作失败');
            }
        } catch (e) {
            this.showToast('网络错误');
        }
    }

    /**
     * WebAuthn 生物识别登录
     */
    async loginWithWebAuthn() {
        const username = document.getElementById('authUsername')?.value?.trim() || '';

        try {
            // 开始认证
            const resp = await fetch('/api/auth/webauthn/login/begin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            });

            if (!resp || !resp.ok) {
                throw new Error('API_START_FAILED');
            }

            const options = await resp.json();

            // 转换数据格式
            options.challenge = Uint8Array.from(atob(options.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            if (options.allowCredentials) {
                options.allowCredentials.forEach(cred => {
                    cred.id = Uint8Array.from(atob(cred.id.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
                });
            }

            const assertion = await navigator.credentials.get({ publicKey: options });

            // 编码响应
            const body = {
                id: assertion.id,
                rawId: btoa(String.fromCharCode(...new Uint8Array(assertion.rawId))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
                type: assertion.type,
                response: {
                    authenticatorData: btoa(String.fromCharCode(...new Uint8Array(assertion.response.authenticatorData))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
                    clientDataJSON: btoa(String.fromCharCode(...new Uint8Array(assertion.response.clientDataJSON))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
                    signature: btoa(String.fromCharCode(...new Uint8Array(assertion.response.signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
                    userHandle: assertion.response.userHandle ? btoa(String.fromCharCode(...new Uint8Array(assertion.response.userHandle))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '') : null
                }
            };

            const completeResp = await fetch('/api/auth/webauthn/login/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (completeResp && completeResp.ok) {
                this.showToast('登录成功');
                this.closeModal();
                this.onLoginSuccess(await completeResp.json());
                return true;
            } else {
                const errData = await completeResp.json();
                this.showToast(errData.error || '生物识别认证失败');
                return false;
            }
        } catch (e) {
            console.error('WebAuthn Login Error:', e);
            if (e.name === 'NotAllowedError' || e.name === 'AbortError') {
                this.openModal(true);
            } else {
                this.showToast('生物识别过程中出错');
                this.openModal(true);
            }
            return false;
        }
    }

    /**
     * 注销登录
     */
    async logout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
            window.location.reload();
        } catch (e) {
            this.showToast('注销失败');
        }
    }

    /**
     * 检查登录状态
     */
    async checkStatus() {
        try {
            const response = await fetch('/api/auth/status');
            return await response.json();
        } catch (e) {
            return { is_authenticated: false };
        }
    }

    /**
     * 显示提示
     */
    showToast(message) {
        // 检查是否已有 toast
        let toast = document.getElementById('authToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'authToast';
            toast.className = 'toast';
            document.body.appendChild(toast);
        }

        toast.textContent = message;
        toast.className = 'toast show';
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
}

// 导出单例
export const auth = new AuthModule();
export default auth;
