import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';

// DOM Elements
const authModal = document.getElementById('authModal');
const authTitle = document.getElementById('authModalTitle');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authSwitchText = document.getElementById('authSwitchText');
const authSwitchBtn = document.getElementById('authSwitchBtn');
const authUsernameInput = document.getElementById('authUsername');
const authPasswordInput = document.getElementById('authPassword');
const authSwitchContainer = document.querySelector('.auth-switch');

// 状态：是否允许注册
let canRegister = true;

export const auth = {
    async checkStatus(callbacks = {}) {
        try {
            // 同时检查登录状态和注册状态
            const [statusResp, registerResp] = await Promise.all([
                api.auth.status(),
                fetch('/api/auth/can-register')
            ]);

            if (!statusResp) return;
            const data = await statusResp.json();

            // 更新注册状态
            if (registerResp && registerResp.ok) {
                const registerData = await registerResp.json();
                canRegister = registerData.can_register;
            }

            if (data.is_authenticated) {
                state.currentUser = data.user;
                this.updateUI(true);
                if (callbacks.onLogin) callbacks.onLogin();
            } else {
                state.currentUser = null;
                this.updateUI(false);
                if (callbacks.onLogout) callbacks.onLogout();
            }
        } catch (e) {
            console.error("Auth check failed", e);
        }
    },

    updateUI(isLoggedIn) {
        const userProfile = document.getElementById('userProfile');
        const blogBrand = document.getElementById('blogBrand');
        const ownerNav = document.getElementById('ownerNav');
        const guestFooter = document.getElementById('guestFooter');

        const noteInputSection = document.getElementById('noteInputSection');
        const userNameDisplay = document.getElementById('userName');
        const statsSection = document.getElementById('statsSection');

        const show = (el, display = 'block') => {
            if (el) {
                el.style.display = display;
                el.classList.remove('animate-fade-in');
                void el.offsetWidth; // Trigger reflow
                el.classList.add('animate-fade-in');
            }
        };
        const hide = (el) => { if (el) el.style.display = 'none'; };

        if (isLoggedIn) {
            // Owner Mode
            show(userProfile, 'flex');
            hide(blogBrand);

            show(ownerNav);
            hide(guestFooter);

            show(noteInputSection);
            if (userNameDisplay) userNameDisplay.textContent = state.currentUser.username;
            show(statsSection);
        } else {
            // Guest/Blog Mode
            hide(userProfile);
            show(blogBrand);

            hide(ownerNav);
            show(guestFooter);

            hide(noteInputSection);
            show(statsSection);
        }
    },

    openModal(isLogin) {
        if (authModal) {
            // 如果不允许注册且尝试打开注册模式，强制切换到登录模式
            if (!isLogin && !canRegister) {
                isLogin = true;
                showToast('系统已注册，请登录');
            }

            authModal.style.display = 'block';
            authModal.dataset.mode = isLogin ? 'login' : 'register';
            if (authTitle) authTitle.textContent = isLogin ? '登录' : '注册';
            if (authSubmitBtn) authSubmitBtn.textContent = isLogin ? '登录' : '注册';

            // 根据是否允许注册显示/隐藏注册切换区域
            if (authSwitchContainer) {
                authSwitchContainer.style.display = canRegister ? 'block' : 'none';
            }

            if (canRegister && authSwitchText && authSwitchBtn) {
                authSwitchText.textContent = isLogin ? '没有账号？' : '已有账号？';
                authSwitchBtn.textContent = isLogin ? '去注册' : '去登录';
            }

            if (authUsernameInput) authUsernameInput.focus();
        }
    },

    closeModal() {
        if (authModal) authModal.style.display = 'none';
    },

    async loginWithWebAuthn(onSuccess) {
        try {
            const username = authUsernameInput.value.trim();
            // Start Authentication
            const resp = await api.auth.webauthn.loginBegin(username);
            if (!resp || !resp.ok) {
                throw new Error('API_START_FAILED');
            }
            const options = await resp.json();

            // Transform some fields from base64 back to Uint8Array
            options.challenge = Uint8Array.from(atob(options.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            if (options.allowCredentials) {
                options.allowCredentials.forEach(cred => {
                    cred.id = Uint8Array.from(atob(cred.id.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
                });
            }

            const assertion = await navigator.credentials.get({ publicKey: options });

            // Encode response for server
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

            const completeResp = await api.auth.webauthn.loginComplete(body);
            if (completeResp && completeResp.ok) {
                showToast('登录成功');
                this.closeModal();
                await this.checkStatus({ onLogin: onSuccess });
                return true;
            } else {
                const errData = await completeResp.json();
                showToast(errData.error || '生物识别认证失败');
                return false;
            }
        } catch (e) {
            console.error("WebAuthn Login Error:", e);
            if (e.name === 'NotAllowedError' || e.name === 'AbortError') {
                // User cancelled or timeout
                auth.openModal(true);
            } else {
                showToast('生物识别过程中出错');
                auth.openModal(true);
            }
            return false;
        }
    },

    async registerWebAuthn() {
        try {
            const resp = await api.auth.webauthn.registerBegin();
            if (!resp || !resp.ok) {
                showToast('注册请求失败');
                return;
            }
            const options = await resp.json();

            // Transform back
            options.challenge = Uint8Array.from(atob(options.challenge.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            options.user.id = Uint8Array.from(atob(options.user.id.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            if (options.excludeCredentials) {
                options.excludeCredentials.forEach(cred => {
                    cred.id = Uint8Array.from(atob(cred.id.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
                });
            }

            const credential = await navigator.credentials.create({ publicKey: options });

            const body = {
                id: credential.id,
                rawId: btoa(String.fromCharCode(...new Uint8Array(credential.rawId))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
                type: credential.type,
                response: {
                    attestationObject: btoa(String.fromCharCode(...new Uint8Array(credential.response.attestationObject))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''),
                    clientDataJSON: btoa(String.fromCharCode(...new Uint8Array(credential.response.clientDataJSON))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
                }
            };

            const completeResp = await api.auth.webauthn.registerComplete(body);
            if (completeResp && completeResp.ok) {
                localStorage.setItem('has_webauthn', 'true'); // 标记本设备已绑定
                showToast('指纹/面容绑定成功');
            } else {
                showToast('绑定失败');
            }
        } catch (e) {
            console.error(e);
            showToast('注册失败或取消');
        }
    },

    async handleSubmit(onSuccess) {
        const mode = authModal.dataset.mode;
        const username = authUsernameInput.value;
        const password = authPasswordInput.value;

        if (!username || !password) {
            showToast('请输入用户名和密码');
            return;
        }

        // 如果是注册模式，再次检查是否允许注册
        if (mode === 'register' && !canRegister) {
            showToast('系统已注册，不允许新用户注册');
            return;
        }

        const action = mode === 'login' ? api.auth.login : api.auth.register;
        const response = await action(username, password);

        if (response) {
            const data = await response.json();
            if (response.ok) {
                showToast(mode === 'login' ? '登录成功' : '注册成功');
                this.closeModal();
                await this.checkStatus({ onLogin: onSuccess });
            } else {
                showToast(data.error || '操作失败');
                // 如果是注册失败（可能因为系统已有用户），更新 canRegister 状态
                if (mode === 'register' && response.status === 403) {
                    canRegister = false;
                }
            }
        }
    },

    async logout() {
        await api.auth.logout();
        window.location.reload();
    }
};

// Event Listeners setup
export function initAuthEvents(onLoginSuccess) {
    const showLoginBtn = document.getElementById('showLoginBtn');
    const showRegisterBtn = document.getElementById('showRegisterBtn');
    const logoutBtn = document.getElementById('logoutBtn');

    if (showLoginBtn) {
        showLoginBtn.addEventListener('click', async () => {
            // Smart Toggle: Try WebAuthn first if this device has used it before
            if (localStorage.getItem('has_webauthn') === 'true' && window.PublicKeyCredential) {
                try {
                    const success = await auth.loginWithWebAuthn(onLoginSuccess);
                    // If logic inside loginWithWebAuthn handles success and closeModal, we are done.
                    // But we need to know if it was cancelled to show the modal.
                    return; 
                } catch (e) {
                    auth.openModal(true);
                }
            } else {
                auth.openModal(true);
            }
        });
    }
    if (showRegisterBtn) showRegisterBtn.addEventListener('click', () => auth.openModal(false));

    document.querySelectorAll('.close, .close-auth').forEach(btn => {
        btn.addEventListener('click', auth.closeModal);
    });

    if (authSubmitBtn) authSubmitBtn.addEventListener('click', () => auth.handleSubmit(onLoginSuccess));

    const webauthnLoginBtn = document.getElementById('webauthnLoginBtn');
    if (webauthnLoginBtn) {
        webauthnLoginBtn.addEventListener('click', () => auth.loginWithWebAuthn(onLoginSuccess));
    }

    if (logoutBtn) logoutBtn.addEventListener('click', auth.logout);

    const bindWebAuthnBtn = document.getElementById('bindWebAuthnBtn');
    if (bindWebAuthnBtn) {
        bindWebAuthnBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.registerWebAuthn();
        });
    }

    if (authPasswordInput) {
        authPasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') auth.handleSubmit(onLoginSuccess);
        });
    }

    if (authSwitchBtn) {
        authSwitchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            // 如果不允许注册，阻止切换到注册模式
            if (!canRegister) {
                showToast('系统已注册，不允许新用户注册');
                return;
            }
            const isLogin = authModal.dataset.mode === 'login';
            auth.openModal(!isLogin);
        });
    }

    window.addEventListener('click', (e) => {
        if (e.target === authModal) auth.closeModal();
    });

    window.addEventListener('auth:unauthorized', () => {
        state.currentUser = null;
        auth.updateUI(false);
        // Optional: show login modal
        // auth.openModal(true);
    });
}
