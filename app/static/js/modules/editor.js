import { api } from './api.js';
import { state } from './state.js';
import { ui } from './ui.js';
import { showToast, getCaretCoordinates, debounce, sanitizeHtml } from './utils.js';

export const editor = {
    init(textareaId) {
        const textarea = document.getElementById(textareaId);
        if (!textarea) return;

        this.setupAutoSave(textarea);
        this.setupAutocomplete(textarea);
        this.setupSlashCommands(textarea);
        this.setupPasteImage(textarea);
        this.setupDragDropImage(textarea);
        this.setupMarkdownShortcuts(textarea);
        this.setupAITools(textarea);
        this.setupCapsuleTool(textarea);
        this.setupVoiceInput(textarea);
        this.setupAutoHeight(textarea);
        this.setupDocButton(textarea);
    },

    setupDocButton(textarea) {
        const btn = document.getElementById('editorDocBtn');
        if (!btn) return;

        const showBtn = () => { btn.style.display = ''; };
        window.addEventListener('auth:login', showBtn);
        setTimeout(() => {
            if (document.getElementById('userProfile')?.style.display !== 'none') showBtn();
        }, 1000);

        btn.addEventListener('click', () => {
            if (window.readerModule?.triggerDocUpload) {
                window.readerModule.triggerDocUpload(window.__currentNoteId || null);
            } else {
                showToast('阅读面板未就绪，请刷新页面');
            }
        });
    },

    setupAutoSave(textarea) {
        // Create indicator
        let indicator = document.querySelector('.save-status-indicator');
        if (!indicator) {
            // Try to find the footer to insert status
            const footer = textarea.closest('.memo-editor')?.querySelector('.editor-footer .editor-tools');
            if (footer) {
                indicator = document.createElement('span');
                indicator.className = 'save-status-indicator';
                // Append to the end instead of inserting at the beginning
                footer.appendChild(indicator);
            }
        }

        const showStatus = (msg, type) => {
            if (!indicator) return;
            indicator.textContent = msg;
            indicator.className = 'save-status-indicator visible';
            if (type === 'saving') indicator.classList.add('saving');
            else indicator.classList.remove('saving');
        };

        // Load draft
        const draft = localStorage.getItem('note_draft_content');
        if (draft && draft.trim() !== '') {
            textarea.value = draft;
            showStatus('已恢复草稿', 'saved');
            setTimeout(() => {
                if(indicator.textContent === '已恢复草稿') indicator.classList.remove('visible');
            }, 3000);
        }

        // Debounced Save
        const saveToLocal = debounce(() => {
            const val = textarea.value;
            localStorage.setItem('note_draft_content', val);
            showStatus('草稿已保存', 'saved');
            // Hide after delay
            setTimeout(() => {
                if (indicator.textContent === '草稿已保存') indicator.classList.remove('visible');
            }, 2000);
        }, 1000);

        textarea.addEventListener('input', () => {
            showStatus('正在保存...', 'saving');
            saveToLocal();
        });
    },

    setupPasteImage(textarea) {
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

            const response = await api.upload(formData);
            if (response) {
                const data = await response.json();
                if (response.ok) {
                    const md = `\n![${data.filename || 'image'}](${data.url})\n`;
                    if (textarea.setRangeText) {
                        textarea.setRangeText(md);
                    } else {
                        const pos = textarea.selectionStart;
                        textarea.value = textarea.value.slice(0, pos) + md + textarea.value.slice(pos);
                    }
                    showToast('图片上传成功');
                } else {
                    showToast(data.error || '上传失败');
                }
            }
        });
    },

    setupAutocomplete(textarea) {
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

                const response = await api.notes.titles();
                if (!response) return;

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
                    // Basic positioning, might need adjustment for scroll
                    dropdown.style.left = `${rect.left + coords.left}px`;
                    dropdown.style.top = `${rect.top + coords.top + 20}px`;
                    dropdown.style.display = 'block';
                } else {
                    dropdown.style.display = 'none';
                }
            } else {
                if (dropdown) dropdown.style.display = 'none';
            }
        }, 200));

        // Hide dropdown on click elsewhere
        document.addEventListener('click', (e) => {
            if (dropdown && e.target !== textarea && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });
    },

    setupSlashCommands(textarea) {
        let dropdown = null;

        // AI 命令教程提示
        this.setupCommandTutorial(textarea);

        const commands = [
            { label: '一级标题', value: '# ', icon: 'fas fa-heading', match: 'h1' },
            { label: '二级标题', value: '## ', icon: 'fas fa-heading', match: 'h2' },
            { label: '三级标题', value: '### ', icon: 'fas fa-heading', match: 'h3' },
            { label: '待办列表', value: '- [ ] ', icon: 'fas fa-check-square', match: 'todo' },
            { label: '无序列表', value: '- ', icon: 'fas fa-list-ul', match: 'list' },
            { label: '代码块', value: '```\n\n```', icon: 'fas fa-code', match: 'code' },
            { label: '当前日期', value: () => new Date().toLocaleDateString(), icon: 'far fa-calendar-alt', match: 'date' },
            { label: '分隔线', value: '\n---\n', icon: 'fas fa-minus', match: 'hr' },
            { label: '上传文件', action: 'upload', icon: 'fas fa-upload', match: 'upload' },
            { label: 'B站视频', action: 'bilibili', icon: 'fas fa-video', match: 'bilibili' },
            { label: 'AI 助手', action: 'ai', icon: 'fas fa-magic', match: 'ai' },
            { label: '语音输入', action: 'voice', icon: 'fas fa-microphone', match: 'voice' },
            { label: '导入文档', action: 'doc', icon: 'fas fa-file-pdf', match: 'doc' }
        ];

        textarea.addEventListener('input', debounce((e) => {
            const cursor = textarea.selectionStart;
            const textBefore = textarea.value.substring(0, cursor);
            
            // Check for slash command at end (preceded by start or whitespace)
            const match = textBefore.match(/(?:^|[\s\n])(\/([a-z0-9]*))$/i);

            if (match) {
                const slashCmd = match[1]; // e.g. "/todo"
                const query = match[2].toLowerCase(); // e.g. "todo"
                
                if (!dropdown) {
                    dropdown = document.createElement('div');
                    dropdown.className = 'autocomplete-dropdown slash-dropdown';
                    document.body.appendChild(dropdown);
                }

                const filtered = commands.filter(c => 
                    c.match.startsWith(query) || c.label.includes(query)
                );

                if (filtered.length > 0) {
                    dropdown.innerHTML = filtered.map((c, i) => `
                        <div class="ac-item" data-idx="${i}">
                            <i class="${c.icon}"></i>
                            <span class="command-key">/${c.match}</span>
                            <span class="command-label">${c.label}</span>
                        </div>
                    `).join('');

                    dropdown.querySelectorAll('.ac-item').forEach(item => {
                        item.onclick = () => {
                            const cmd = filtered[item.dataset.idx];
                            this.executeSlashCommand(textarea, cmd, slashCmd, cursor);
                            dropdown.style.display = 'none';
                        };
                    });

                    const coords = getCaretCoordinates(textarea, cursor);
                    const rect = textarea.getBoundingClientRect();
                    dropdown.style.left = `${rect.left + coords.left}px`;
                    dropdown.style.top = `${rect.top + coords.top + 24}px`;
                    dropdown.style.display = 'block';
                } else {
                    dropdown.style.display = 'none';
                }
            } else {
                if (dropdown) dropdown.style.display = 'none';
            }
        }, 100));

        // Close on click out
        document.addEventListener('click', (e) => {
            if (dropdown && e.target !== textarea && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
                activeIndex = -1;
            }
        });

        // 添加下拉菜单键盘导航
        let activeIndex = -1;
        const updateActiveItem = (index) => {
            if (!dropdown || dropdown.style.display === 'none') return;

            // 移除所有active状态
            dropdown.querySelectorAll('.ac-item').forEach(item => {
                item.classList.remove('active');
            });

            // 设置新的active状态
            const items = dropdown.querySelectorAll('.ac-item');
            if (items.length > 0) {
                activeIndex = (index + items.length) % items.length;
                items[activeIndex].classList.add('active');
                // 滚动到当前选中项
                items[activeIndex].scrollIntoView({ block: 'nearest' });
            }
        };

        // 为下拉菜单添加键盘事件
        const handleDropdownKeydown = (e) => {
            if (!dropdown || dropdown.style.display === 'none') return;

            const items = dropdown.querySelectorAll('.ac-item');
            if (items.length === 0) return;

            switch(e.key) {
                case 'ArrowDown':
                case 'ArrowUp':
                    e.preventDefault();
                    if (activeIndex === -1) {
                        // 首次按下方向键
                        updateActiveItem(e.key === 'ArrowDown' ? 0 : items.length - 1);
                    } else {
                        // 移动选择
                        updateActiveItem(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (activeIndex >= 0 && activeIndex < items.length) {
                        items[activeIndex].click();
                    } else if (items.length > 0) {
                        items[0].click();
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    dropdown.style.display = 'none';
                    activeIndex = -1;
                    break;
            }
        };

        // 全局键盘监听
        document.addEventListener('keydown', handleDropdownKeydown);

        // 当下拉菜单显示时，聚焦到第一个项目
        const showDropdown = () => {
            if (dropdown && dropdown.style.display === 'block') {
                activeIndex = -1;
                const items = dropdown.querySelectorAll('.ac-item');
                if (items.length > 0) {
                    updateActiveItem(0);
                }
            }
        };

        // 简化显示逻辑：在显示下拉时直接调用
        const safeShowDropdown = () => {
            if (dropdown) {
                setTimeout(showDropdown, 0);
            }
        };

        // 在输入事件中显示下拉后调用
        textarea.addEventListener('input', () => {
            if (dropdown && dropdown.style.display === 'block') {
                safeShowDropdown();
            }
        });

        // Handle Enter key to auto-apply command when typing
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && dropdown && dropdown.style.display === 'block') {
                e.preventDefault();
                const items = dropdown.querySelectorAll('.ac-item');
                if (items.length > 0) {
                    if (activeIndex >= 0 && activeIndex < items.length) {
                        items[activeIndex].click();
                    } else {
                        items[0].click();
                    }
                }
            }
        });

        // Handle Enter key for direct command execution (without dropdown)
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (!dropdown || dropdown.style.display === 'none')) {
                const cursor = textarea.selectionStart;
                const textBefore = textarea.value.substring(0, cursor);
                const match = textBefore.match(/(?:^|[\s\n])(\/([a-z0-9]+))$/i);

                if (match) {
                    e.preventDefault();
                    const slashCmd = match[1];
                    const commandName = match[2].toLowerCase();

                    // Find matching command
                    const matchingCommand = commands.find(cmd => cmd.match === commandName);
                    if (matchingCommand) {
                        this.executeSlashCommand(textarea, matchingCommand, slashCmd, cursor);
                        // 重置activeIndex
                        activeIndex = -1;
                    }
                }
            }
        });

        // 清理函数
        const cleanup = () => {
            document.removeEventListener('keydown', handleDropdownKeydown);
            if (dropdown) {
                dropdown.removeEventListener('mousedown', (e) => e.preventDefault());
            }
            activeIndex = -1;
        };

        // 在页面卸载时清理
        window.addEventListener('unload', cleanup);
    },

    executeSlashCommand(textarea, cmd, matchStr, cursor) {
        let replacement = typeof cmd.value === 'function' ? cmd.value() : cmd.value;
        
        if (cmd.action === 'ai' || cmd.action === 'voice') {
            replacement = '';
            let controls = null;
            const memoEditor = textarea.closest('.memo-editor');
            if (memoEditor) controls = memoEditor.querySelector('.editor-footer .input-controls');
            if (!controls) {
                const inlineContainer = textarea.closest('.inline-editor-container');
                if (inlineContainer) controls = inlineContainer.querySelector('.inline-tools-left');
            }
            if (controls) {
                const selector = cmd.action === 'voice' ? '.voice-trigger' : '.ai-trigger';
                const btn = controls.querySelector(selector);
                if (btn) setTimeout(() => btn.click(), 50);
            }
        }

        if (cmd.action === 'upload') {
            replacement = '';
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'image/*,audio/*,video/*,.pdf,.zip,.rar,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md';
            input.onchange = async () => {
                for (const file of Array.from(input.files)) {
                    if (/\.(pdf|docx|doc)$/i.test(file.name)) {
                        if (window.readerModule?.uploadAndOpenDocument) {
                            await window.readerModule.uploadAndOpenDocument(file, window.__currentNoteId || null);
                        } else { showToast('阅读面板未就绪'); }
                        continue;
                    }
                    // 其他文件 → 普通上传
                    const fd = new FormData();
                    fd.append('file', file);
                    showToast('正在上传...');
                    try {
                        const res = await api.upload(fd);
                        if (res && res.ok) {
                            const d = await res.json();
                            let md;
                            if (d.type === 'image') md = `![${d.filename}](${d.url})`;
                            else if (d.type === 'audio') md = `[${d.filename}](${d.url})`;
                            else if (d.type === 'video') md = `[${d.filename}](${d.url})`;
                            else md = `[${d.filename}](${d.url})`;
                            textarea.setRangeText ? textarea.setRangeText('\n' + md + '\n') : (textarea.value += '\n' + md + '\n');
                            showToast('上传成功');
                        } else {
                            const e = await res.json().catch(() => ({}));
                            showToast(e.error || '上传失败');
                        }
                    } catch { showToast('上传失败'); }
                }
            };
            input.click();
        }

        if (cmd.action === 'bilibili') {
            replacement = '';
            this._showBilibiliDialog(textarea);
            return;
        }

        if (cmd.action === 'doc') {
            replacement = '';
            if (window.readerModule?.triggerDocUpload) {
                window.readerModule.triggerDocUpload(window.__currentNoteId || null);
            } else {
                showToast('阅读面板未就绪，请刷新页面后重试');
            }
        }

        const text = textarea.value;
        const start = cursor - matchStr.length;
        const end = cursor;
        
        if (textarea.setRangeText) {
            textarea.setRangeText(replacement, start, end, 'end');
        } else {
            textarea.value = text.substring(0, start) + replacement + text.substring(end);
        }
        
        textarea.focus();
        
        // Special case for code block: move cursor inside
        if (cmd.match === 'code') {
            const newCursor = start + 4; // after ```\n
            textarea.setSelectionRange(newCursor, newCursor);
        }
    },

    _showBilibiliDialog(textarea) {
        const existing = document.querySelector('.bilibili-input-dialog');
        if (existing) existing.remove();

        const dialog = document.createElement('div');
        dialog.className = 'bilibili-input-dialog';
        dialog.innerHTML = `
            <div class="bili-dialog-backdrop"></div>
            <div class="bili-dialog-box">
                <div class="bili-dialog-header">
                    <span class="bili-dialog-icon"><i class="fas fa-video"></i></span>
                    <span class="bili-dialog-title">插入 B 站视频</span>
                    <button class="bili-dialog-close" type="button"><i class="fas fa-times"></i></button>
                </div>
                <div class="bili-dialog-body">
                    <input class="bili-dialog-input" type="url" placeholder="https://www.bilibili.com/video/BV..." autocomplete="off" spellcheck="false">
                    <p class="bili-dialog-hint">支持 BV 号链接，如 bilibili.com/video/BV1...</p>
                </div>
                <div class="bili-dialog-footer">
                    <button class="bili-dialog-cancel btn btn-secondary" type="button">取消</button>
                    <button class="bili-dialog-confirm btn btn-primary" type="button"><i class="fas fa-check"></i> 插入</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);
        requestAnimationFrame(() => dialog.classList.add('show'));

        const input = dialog.querySelector('.bili-dialog-input');
        setTimeout(() => input.focus(), 80);

        const close = () => {
            dialog.classList.remove('show');
            setTimeout(() => dialog.remove(), 200);
            textarea.focus();
        };

        const confirm = () => {
            const url = input.value.trim();
            if (!url) { input.focus(); return; }
            const md = `\n[${url}](${url})\n`;
            textarea.setRangeText ? textarea.setRangeText(md) : (textarea.value += md);
            textarea.dispatchEvent(new Event('input'));
            close();
        };

        dialog.querySelector('.bili-dialog-close').onclick = close;
        dialog.querySelector('.bili-dialog-cancel').onclick = close;
        dialog.querySelector('.bili-dialog-confirm').onclick = confirm;
        dialog.querySelector('.bili-dialog-backdrop').onclick = close;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirm(); }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        };
    },

    setupAITools(textarea) {
        let controls = null;
        
        // 1. Try Main Editor structure: .memo-editor -> .editor-footer -> .input-controls
        const memoEditor = textarea.closest('.memo-editor');
        if (memoEditor) {
            controls = memoEditor.querySelector('.editor-footer .input-controls');
        }

        // 2. Try Inline Editor structure: .inline-editor-container -> .inline-tools-bar -> .inline-tools-left
        if (!controls) {
            const inlineContainer = textarea.closest('.inline-editor-container');
            if (inlineContainer) {
                controls = inlineContainer.querySelector('.inline-tools-left');
            }
        }

        // 3. Fallback to any sibling tools bar
        if (!controls && textarea.parentElement) {
            controls = textarea.parentElement.querySelector('.input-controls, .inline-tools-left');
        }

        if (!controls) return;

        // Check if button already exists
        if (controls.querySelector('.ai-trigger')) return;

        const aiBtn = document.createElement('button');
        aiBtn.className = 'tool-btn ai-trigger';
        aiBtn.innerHTML = '<i class="fas fa-magic"></i>';
        aiBtn.title = 'AI 助手';
        aiBtn.onclick = (e) => this.showAIMenu(e, textarea);
        controls.appendChild(aiBtn);
    },

    setupCapsuleTool(textarea) {
        const memoEditor = textarea.closest('.memo-editor');
        if (memoEditor) {
            // 主编辑器：把胶囊按钮放入右侧 editor-actions（发布选项区），而非工具区
            const actions = memoEditor.querySelector('.editor-footer .editor-actions');
            if (actions && !actions.querySelector('.capsule-trigger')) {
                const capsuleBtn = document.createElement('button');
                capsuleBtn.type = 'button';
                capsuleBtn.className = 'capsule-trigger capsule-action-icon';
                capsuleBtn.innerHTML = '<i class="far fa-hourglass"></i>';
                capsuleBtn.title = '封存为时光胶囊';
                capsuleBtn.onclick = (e) => this.showCapsuleMenu(e, textarea);
                // 插入到公开开关之前
                const pubSwitch = actions.querySelector('.public-switch');
                actions.insertBefore(capsuleBtn, pubSwitch || actions.firstChild);
            }
            return;
        }
        // 内联编辑器：放入左侧工具区
        const inlineContainer = textarea.closest('.inline-editor-container');
        if (!inlineContainer) return;
        const controls = inlineContainer.querySelector('.inline-tools-left');
        if (!controls || controls.querySelector('.capsule-trigger')) return;
        const capsuleBtn = document.createElement('button');
        capsuleBtn.type = 'button';
        capsuleBtn.className = 'tool-btn capsule-trigger tool-btn-subtle';
        capsuleBtn.innerHTML = '<i class="far fa-hourglass"></i>';
        capsuleBtn.title = '封存为时光胶囊';
        capsuleBtn.onclick = (e) => this.showCapsuleMenu(e, textarea);
        controls.appendChild(capsuleBtn);
    },

    showCapsuleMenu(event, textarea) {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;

        const existing = document.getElementById('capsuleMenu');
        if (existing) {
            existing.remove();
            return;
        }

        const menu = document.createElement('div');
        menu.id = 'capsuleMenu';
        menu.className = 'ai-dropdown-menu capsule-menu';
        menu.style.padding = '15px';
        menu.style.width = '260px';

        // 获取当前值
        const isCapsule = textarea.dataset.isCapsule === 'true';
        const capsuleDate = textarea.dataset.capsuleDate || '';
        const capsuleHint = textarea.dataset.capsuleHint || '';

        const inputStyle = 'width:100%; font-size:13px; padding:7px 10px; border:1px solid var(--slate-200); border-radius:6px; outline:none; transition:border 0.2s; box-sizing:border-box;';
        menu.innerHTML = `
            <div style="margin-bottom: 12px; font-size: 13px; font-weight: 500; color: var(--slate-600); display: flex; align-items: center; gap: 7px;">
                <i class="far fa-hourglass" style="color: var(--slate-400);"></i> 封存为时光胶囊
            </div>
            <div style="margin-bottom: 10px;">
                <label style="display: block; font-size: 12px; margin-bottom: 4px; color: #888;">解锁日期</label>
                <input type="datetime-local" id="capsule-date-input" style="${inputStyle}" value="${capsuleDate}">
            </div>
            <div style="margin-bottom: 15px;">
                <label style="display: block; font-size: 12px; margin-bottom: 4px; color: #888;">寄语（可选）</label>
                <input type="text" id="capsule-hint-input" style="${inputStyle}" placeholder="写给未来的自己..." value="${capsuleHint}">
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button class="btn btn-secondary" id="capsule-cancel" style="padding: 4px 12px; font-size: 12px;">取消</button>
                <button class="btn btn-primary" id="capsule-save" style="padding: 4px 12px; font-size: 12px;">封存</button>
            </div>
        `;

        document.body.appendChild(menu);

        const rect = button.getBoundingClientRect();
        menu.style.top = `${rect.bottom + window.scrollY + 5}px`;
        menu.style.left = `${rect.left + window.scrollX}px`;
        menu.style.display = 'block';

        // 给输入框添加 focus 高亮
        menu.querySelectorAll('input').forEach(input => {
            input.addEventListener('focus', () => { input.style.borderColor = 'var(--primary)'; input.style.boxShadow = '0 0 0 2px var(--primary-light)'; });
            input.addEventListener('blur', () => { input.style.borderColor = 'var(--slate-200)'; input.style.boxShadow = 'none'; });
        });

        // 事件处理
        menu.querySelector('#capsule-save').onclick = () => {
            const date = menu.querySelector('#capsule-date-input').value;
            const hint = menu.querySelector('#capsule-hint-input').value;
            
            if (!date) {
                showToast('请选择解锁日期');
                return;
            }

            textarea.dataset.isCapsule = 'true';
            textarea.dataset.capsuleDate = date.replace('T', ' ') + ':00'; // 转为后端需要的格式
            textarea.dataset.capsuleHint = hint;
            
            button.innerHTML = '<i class="fas fa-hourglass-half"></i>';
            button.classList.add('active');
            button.style.color = '';
            button.title = '时光胶囊已设置';
            
            showToast('将在发布后封存');
            menu.remove();
        };

        menu.querySelector('#capsule-cancel').onclick = () => {
            textarea.dataset.isCapsule = 'false';
            delete textarea.dataset.capsuleDate;
            delete textarea.dataset.capsuleHint;
            
            button.innerHTML = '<i class="far fa-hourglass"></i>';
            button.classList.remove('active');
            button.style.color = '';
            button.title = '封存为时光胶囊';
            
            showToast('已取消封存');
            menu.remove();
        };

        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !button.contains(e.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
    },

    showAIMenu(event, textarea) {
        event.preventDefault();
        event.stopPropagation();
        
        const button = event.currentTarget; // Capture button reference immediately

        api.ai.customPrompts().then(async res => {
            if (!res) return;
            const prompts = await res.json();

            const existing = document.getElementById('aiMenu');
            if (existing) existing.remove();

            const menu = document.createElement('div');
            menu.id = 'aiMenu';
            menu.className = 'ai-dropdown-menu';

            let html = `
                <div class="ai-menu-item" data-action="tags"><i class="fas fa-tags"></i> 自动标签</div>
                <div class="ai-menu-item" data-action="summary"><i class="fas fa-align-left"></i> 生成摘要</div>
                <div class="ai-menu-item" data-action="polish"><i class="fas fa-pen-fancy"></i> 润色文本</div>
            `;

            if (prompts && prompts.length > 0) {
                html += `<div style="border-top:1px solid #eee; margin:5px 0;"></div>`;
                prompts.forEach(p => {
                     html += `<div class="ai-menu-item" data-action="custom" data-id="${p.id}"><i class="fas fa-star"></i> ${p.name}</div>`;
                });
            }

            html += `<div style="border-top:1px solid #eee; margin:5px 0;"></div>
                     <div class="ai-menu-item" onclick="window.location.href='/settings'"><i class="fas fa-cog"></i> 设置</div>`;

            menu.innerHTML = html;
            document.body.appendChild(menu);

            // Event delegation for items
            menu.querySelectorAll('.ai-menu-item').forEach(item => {
                if (item.dataset.action) {
                    item.onclick = () => {
                        this.aiActionStream(textarea, item.dataset.action, item.dataset.id, prompts);
                        menu.remove();
                    };
                }
            });

            const rect = button.getBoundingClientRect(); // Use captured button
            menu.style.top = `${rect.bottom + window.scrollY + 5}px`;
            menu.style.left = `${rect.left + window.scrollX}px`;
            menu.style.display = 'block';

            const closeMenu = () => {
                if(document.body.contains(menu)) menu.remove();
                document.removeEventListener('click', closeMenu);
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
        });
    },

    async aiActionStream(textarea, type, customId, allPrompts) {
        const content = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd) || textarea.value.trim();

        if (!content) return showToast('请先选择或输入内容');

        // Remove any existing preview
        document.querySelectorAll('.ai-preview-box').forEach(el => el.remove());

        const previewId = `ai-preview-${Date.now()}`;
        const previewBox = document.createElement('div');
        previewBox.className = 'ai-preview-box';
        previewBox.id = previewId;
        // Keep this strictly on one line to avoid text-node whitespace
        previewBox.innerHTML = `<div class="ai-preview-content"><span class="ai-streaming-indicator"></span></div><div class="ai-preview-actions" style="display:none"><button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" id="discard-${previewId}">放弃</button></div>`;


        // Insert after textarea
        textarea.parentNode.insertBefore(previewBox, textarea.nextSibling);

        const contentDiv = previewBox.querySelector('.ai-preview-content');
        const actionsDiv = previewBox.querySelector('.ai-preview-actions');

        let payload = {};

        if (type === 'custom' && customId) {
            // For custom prompts, we still build it here or we could move it to backend too.
            // For now, let's keep custom prompts logic here as it depends on `allPrompts` passed in.
            let systemPrompt = "你是一个乐于助人的助手。";
            let userPrompt = "";
            const promptObj = allPrompts?.find(p => p.id == customId);
            if (promptObj) {
                systemPrompt = promptObj.system_prompt || systemPrompt;
                userPrompt = promptObj.template.replace('{content}', content);
            }
            payload = { prompt: userPrompt, system_prompt: systemPrompt };
        } else {
            // For built-in actions (tags, summary, polish), delegate to server
            payload = { action: type, content: content };
        }

        try {
            const response = await api.ai.stream(payload);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullText = "";

            contentDiv.innerHTML = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                fullText += chunk;
                
                // If we only have whitespace/newlines so far, don't render yet
                if (!fullText.trim()) continue;

                // Extremely aggressive whitespace cleaning
                const cleanText = fullText.trim().replace(/\n{3,}/g, '\n\n');

                // Render Markdown
                if (typeof marked !== 'undefined') {
                    contentDiv.innerHTML = sanitizeHtml(marked.parse(cleanText));
                } else {
                    contentDiv.textContent = cleanText;
                }
            }

            actionsDiv.style.display = 'flex';
            actionsDiv.innerHTML = ''; 

            const createBtn = (text, label, isPrimary=false) => {
                const btn = document.createElement('button');
                btn.className = isPrimary ? 'btn btn-primary' : 'btn btn-secondary';
                btn.style.padding = '4px 10px';
                btn.style.fontSize = '12px';
                btn.textContent = label;
                btn.onclick = () => {
                    const cleanOutput = text.trim().replace(/\n{3,}/g, '\n\n');
                    if (type === 'tags') {
                        let tags = [];
                        try {
                            // Attempt to parse as JSON if it looks like an array
                            if (cleanOutput.startsWith('[') && cleanOutput.endsWith(']')) {
                                tags = JSON.parse(cleanOutput);
                            } else {
                                throw new Error('Not a JSON array');
                            }
                        } catch (e) {
                            // Fallback to splitting by common separators
                            tags = cleanOutput.split(/[\s,，#]+/).filter(t => t.trim() !== '');
                        }

                        if (!Array.isArray(tags)) tags = [tags];

                        const currentTarget = textarea.classList.contains('inline-editor-textarea') ? 'edit' : 'input';
                        tags.forEach(t => {
                            const cleanTag = String(t).trim().replace(/^#/, '');
                            if (cleanTag) {
                                if (currentTarget === 'input' && !state.currentTags.includes(cleanTag)) state.currentTags.push(cleanTag);
                                else if (currentTarget === 'edit' && !state.editTags.includes(cleanTag)) state.editTags.push(cleanTag);
                            }
                        });
                        if (currentTarget === 'input') ui.renderTags('input');
                        else ui.renderInlineTags(textarea.parentElement.querySelector('.inline-tags-area'), textarea.parentElement.querySelector('.inline-tag-input'));
                        showToast('标签已提取');
                    } else {
                        if (textarea.selectionStart !== textarea.selectionEnd) textarea.setRangeText(cleanOutput);
                        else textarea.value = textarea.value + "\n" + cleanOutput;
                        showToast('已应用');
                    }
                    previewBox.remove();
                };
                return btn;
            };

            // Improved Parsing: Split by ### and filter empty
            const sections = fullText.split(/###\s+/);
            const discardBtn = document.createElement('button');
            discardBtn.className = 'btn btn-secondary';
            discardBtn.textContent = '放弃';
            discardBtn.style.padding = '4px 10px';
            discardBtn.style.fontSize = '12px';
            discardBtn.onclick = () => previewBox.remove();
            actionsDiv.appendChild(discardBtn);

            let hasValidSection = false;
            sections.forEach(section => {
                if (!section.trim()) return;
                const lines = section.split('\n');
                const title = lines[0].trim();
                const contentText = lines.slice(1).join('\n').trim();
                
                if (title && contentText) {
                    hasValidSection = true;
                    actionsDiv.appendChild(createBtn(contentText, `应用: ${title}`, true));
                }
            });

            if (!hasValidSection) {
                actionsDiv.appendChild(createBtn(fullText, '应用全部', true));
            }

        } catch (e) {
            console.error("AI Action Error:", e);
            contentDiv.textContent = "请求出错: " + e.message;
            setTimeout(() => previewBox.remove(), 3000);
        }
    },

    // AI 命令提示教程
    setupCommandTutorial(textarea) {
        // 检查是否已经显示过教程
        if (sessionStorage.getItem('ai_tutorial_shown')) {
            return;
        }

        // 设置标记，避免重复显示
        sessionStorage.setItem('ai_tutorial_shown', 'true');

        // 添加一次性的聚焦事件监听器
        textarea.addEventListener('focus', () => {
            // 创建提示元素
            const hint = document.createElement('div');
            hint.className = 'slash-command-hint';
            hint.innerHTML = '<span>尝试输入 <code>/</code> 体验AI助手</span>';

            // 找到编辑器容器
            const editorContainer = textarea.closest('.memo-editor') || textarea.closest('.inline-editor-container');
            if (editorContainer) {
                editorContainer.appendChild(hint);

                // 3秒后自动移除
                setTimeout(() => {
                    if (hint.parentNode) {
                        hint.parentNode.removeChild(hint);
                    }
                }, 3000);
            }
        }, { once: true });
    },

    setupAutoHeight(textarea) {
        // 防止重复绑定
        if (textarea.dataset.autoHeightInitialized) return;

        textarea.dataset.autoHeightInitialized = 'true';

        const maxHeight = parseInt(getComputedStyle(textarea).maxHeight, 10) || 600;

        const adjustHeight = () => {
            // 保存当前滚动位置
            const scrollTop = textarea.scrollTop;

            // 临时移除最大高度限制以获取真实内容高度
            const originalMaxHeight = textarea.style.maxHeight;
            textarea.style.maxHeight = 'none';

            // 设置高度为内容高度
            textarea.style.height = 'auto';
            const contentHeight = textarea.scrollHeight;

            // 恢复最大高度限制
            textarea.style.maxHeight = originalMaxHeight;

            // 应用新高度，不超过最大高度
            const newHeight = Math.min(contentHeight, maxHeight);
            textarea.style.height = `${newHeight}px`;

            // 恢复滚动位置
            textarea.scrollTop = scrollTop;
        };

        // 初始调整
        adjustHeight();

        // 监听输入事件
        textarea.addEventListener('input', adjustHeight);

        // 监听窗口大小变化
        window.addEventListener('resize', adjustHeight);

        // 监听粘贴事件
        textarea.addEventListener('paste', () => setTimeout(adjustHeight, 50));

        // 监听焦点事件，确保在聚焦时高度正确
        textarea.addEventListener('focus', adjustHeight);
    },

    // 拖拽上传图片
    setupDragDropImage(textarea) {
        const memoEditor = textarea.closest('.memo-editor');
        if (!memoEditor) return;

        let dragOverlay = null;

        const showOverlay = () => {
            if (!dragOverlay) {
                dragOverlay = document.createElement('div');
                dragOverlay.className = 'drag-drop-overlay';
                dragOverlay.innerHTML = '<i class="fas fa-cloud-upload-alt"></i><span>释放以上传文件（PDF/Word 自动打开阅读面板）</span>';
                memoEditor.appendChild(dragOverlay);
            }
            dragOverlay.classList.add('active');
            textarea.classList.add('drag-over');
        };

        const hideOverlay = () => {
            if (dragOverlay) {
                dragOverlay.classList.remove('active');
            }
            textarea.classList.remove('drag-over');
        };

        const handleDrop = async (e) => {
            hideOverlay();
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;

            e.preventDefault();

            for (const file of Array.from(files)) {
                if (/\.(pdf|docx|doc)$/i.test(file.name)) {
                    if (window.readerModule?.uploadAndOpenDocument) {
                        await window.readerModule.uploadAndOpenDocument(file, window.__currentNoteId || null);
                    } else { showToast('阅读面板未就绪'); }
                    continue;
                }

                const formData = new FormData();
                formData.append('file', file);
                showToast('正在上传...');

                try {
                    const response = await api.upload(formData);
                    if (response && response.ok) {
                        const data = await response.json();
                        let md;
                        if (data.type === 'image') {
                            md = `\n![${data.filename || 'image'}](${data.url})\n`;
                        } else if (data.type === 'audio') {
                            md = `\n[${data.filename || '音频'}](${data.url})\n`;
                        } else if (data.type === 'video') {
                            md = `\n[${data.filename || '视频'}](${data.url})\n`;
                        } else {
                            md = `\n[${data.filename || file.name}](${data.url})\n`;
                        }
                        if (textarea.setRangeText) {
                            textarea.setRangeText(md);
                        } else {
                            textarea.value += md;
                        }
                        showToast('上传成功');
                    } else {
                        const err = await response.json().catch(() => ({}));
                        showToast(err.error || '上传失败');
                    }
                } catch (err) {
                    console.error('Upload error:', err);
                    showToast('上传失败');
                }
            }
        };

        // 阻止默认拖拽行为
        textarea.addEventListener('dragenter', (e) => {
            e.preventDefault();
            showOverlay();
        });

        textarea.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        textarea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            // 检查是否真的离开了编辑器区域
            if (!memoEditor.contains(e.relatedTarget)) {
                hideOverlay();
            }
        });

        textarea.addEventListener('drop', (e) => {
            e.preventDefault();
            handleDrop(e);
        });

        // 覆盖层也要响应 drop 事件
        memoEditor.addEventListener('drop', (e) => {
            if (e.target !== textarea) {
                e.preventDefault();
                handleDrop(e);
            }
        });
    },

    // 语音输入（基于 MediaRecorder + 后端 AI 转写）
    setupVoiceInput(textarea) {
        if (!navigator.mediaDevices || !window.MediaRecorder) return;

        let controls = null;
        const memoEditor = textarea.closest('.memo-editor');
        if (memoEditor) {
            controls = memoEditor.querySelector('.editor-footer .input-controls');
        }
        if (!controls) {
            const inlineContainer = textarea.closest('.inline-editor-container');
            if (inlineContainer) {
                controls = inlineContainer.querySelector('.inline-tools-left');
            }
        }
        if (!controls || controls.querySelector('.voice-trigger')) return;

        const voiceBtn = document.createElement('button');
        voiceBtn.type = 'button';
        voiceBtn.className = 'tool-btn voice-trigger';
        voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
        voiceBtn.title = '语音输入';
        voiceBtn.onclick = () => this.toggleVoiceRecording(textarea, voiceBtn);
        controls.appendChild(voiceBtn);
    },

    _voiceMaxDuration: 300,

    async toggleVoiceRecording(textarea, button) {
        if (this._voiceActive) {
            this._stopRecording(false);
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
            });
        } catch (e) {
            const msgs = {
                NotAllowedError: '麦克风权限被拒绝，请在浏览器设置中允许麦克风访问',
                NotFoundError: '未检测到麦克风设备，请连接后重试',
                NotReadableError: '麦克风被其他应用占用，请关闭后重试',
            };
            showToast(msgs[e.name] || '无法访问麦克风，请检查设备连接');
            return;
        }

        const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        const mimeType = preferred.find(t => MediaRecorder.isTypeSupported(t)) || '';
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
        const chunks = [];

        this._voiceActive = true;
        this._voiceRecorder = recorder;
        this._voiceStream = stream;
        this._voiceButton = button;
        this._voiceTextarea = textarea;
        this._voiceCancelled = false;

        button.classList.add('voice-active');
        button.innerHTML = '<i class="fas fa-stop"></i>';
        button.title = '停止录音';

        const overlay = this._createVoiceOverlay(textarea);
        this._voiceOverlay = overlay;

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            this._clearTimer();

            if (this._voiceCancelled) {
                if (this._voiceOverlay) { this._voiceOverlay.remove(); this._voiceOverlay = null; }
                return;
            }

            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            if (blob.size < 1000) {
                showToast('录音时间太短，请至少说一句话');
                if (this._voiceOverlay) { this._voiceOverlay.remove(); this._voiceOverlay = null; }
                return;
            }

            await this._transcribeAndShow(textarea, blob, overlay);
        };

        recorder.start(1000);
        this._startTimer(overlay);
    },

    _startTimer(overlay) {
        const timerEl = overlay.querySelector('.voice-timer');
        let seconds = 0;
        this._voiceTimerInterval = setInterval(() => {
            seconds++;
            const m = String(Math.floor(seconds / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            if (timerEl) timerEl.textContent = `${m}:${s}`;
            if (seconds >= this._voiceMaxDuration) {
                showToast('已达到最大录音时长（5分钟），自动停止');
                this._stopRecording(false);
            }
        }, 1000);
    },

    _clearTimer() {
        if (this._voiceTimerInterval) {
            clearInterval(this._voiceTimerInterval);
            this._voiceTimerInterval = null;
        }
    },

    _createVoiceOverlay(textarea) {
        document.querySelectorAll('.voice-overlay').forEach(el => el.remove());

        const barCount = 16;
        const barsHtml = Array.from({ length: barCount }, () =>
            '<span class="voice-bar"></span>'
        ).join('');

        const overlay = document.createElement('div');
        overlay.className = 'voice-overlay';
        overlay.innerHTML = `
            <div class="voice-header">
                <span class="voice-rec-dot"></span>
                <span class="voice-status">录音中</span>
                <div class="voice-bars">${barsHtml}</div>
                <span class="voice-timer">00:00</span>
                <button class="btn btn-secondary btn-xs voice-cancel-btn">取消</button>
                <button class="btn btn-primary btn-xs voice-done-btn"><i class="fas fa-check"></i> 完成</button>
            </div>
        `;

        textarea.parentNode.insertBefore(overlay, textarea.nextSibling);

        overlay.querySelector('.voice-cancel-btn').onclick = () => this._stopRecording(true);
        overlay.querySelector('.voice-done-btn').onclick = () => this._stopRecording(false);

        this._startWaveform(overlay);
        return overlay;
    },

    _startWaveform(overlay) {
        const bars = overlay.querySelectorAll('.voice-bar');
        if (!bars.length) return;

        let analyser = null, dataArray = null;
        if (this._voiceStream) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const source = ctx.createMediaStreamSource(this._voiceStream);
                analyser = ctx.createAnalyser();
                analyser.fftSize = 64;
                source.connect(analyser);
                dataArray = new Uint8Array(analyser.frequencyBinCount);
                this._voiceAudioCtx = ctx;
            } catch (e) {}
        }

        const animate = () => {
            if (!this._voiceActive) return;
            if (analyser && dataArray) {
                analyser.getByteFrequencyData(dataArray);
                bars.forEach((bar, i) => {
                    const val = dataArray[Math.floor(i * dataArray.length / bars.length)] || 0;
                    bar.style.height = Math.max(3, (val / 255) * 20) + 'px';
                });
            } else {
                bars.forEach(bar => {
                    bar.style.height = (3 + Math.random() * 17) + 'px';
                });
            }
            this._voiceWaveRAF = requestAnimationFrame(animate);
        };
        this._voiceWaveRAF = requestAnimationFrame(animate);
    },

    _stopRecording(cancelled) {
        this._voiceActive = false;
        this._voiceCancelled = cancelled;

        if (this._voiceWaveRAF) { cancelAnimationFrame(this._voiceWaveRAF); this._voiceWaveRAF = null; }
        if (this._voiceAudioCtx) { this._voiceAudioCtx.close().catch(() => {}); this._voiceAudioCtx = null; }

        if (this._voiceButton) {
            this._voiceButton.classList.remove('voice-active');
            this._voiceButton.innerHTML = '<i class="fas fa-microphone"></i>';
            this._voiceButton.title = '语音输入';
        }

        if (this._voiceRecorder && this._voiceRecorder.state !== 'inactive') {
            this._voiceRecorder.stop();
        }

        if (cancelled && this._voiceStream) {
            this._voiceStream.getTracks().forEach(t => t.stop());
        }
    },

    async _transcribeAndShow(textarea, blob, overlay) {
        overlay.classList.add('voice-transcribing-state');
        const statusEl = overlay.querySelector('.voice-status');
        if (statusEl) statusEl.textContent = '转写中…';

        const extMap = { 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
        const ext = extMap[blob.type] || (blob.type.includes('mp4') ? 'mp4' : 'webm');
        const formData = new FormData();
        formData.append('audio', blob, `recording.${ext}`);

        try {
            const res = await api.ai.transcribe(formData);
            if (!res) throw new Error('network');

            const data = await res.json();

            if (data.error) {
                overlay.remove();
                this._voiceOverlay = null;
                if (data.type === 'config') {
                    this._showVoiceConfigError(textarea, data.error);
                } else {
                    showToast(data.error);
                }
                return;
            }

            const text = (data.text || '').trim();
            if (!text) {
                overlay.remove();
                this._voiceOverlay = null;
                showToast('未识别到有效语音内容');
                return;
            }

            overlay.remove();
            this._voiceOverlay = null;
            this._showVoiceResult(textarea, text, blob);
        } catch (e) {
            console.error('Transcribe error:', e);
            overlay.remove();
            this._voiceOverlay = null;
            showToast('语音转写失败，请检查网络连接和 STT 服务配置');
        }
    },

    _showVoiceConfigError(textarea, errorMsg) {
        document.querySelectorAll('.voice-result-box').forEach(el => el.remove());
        const box = document.createElement('div');
        box.className = 'voice-result-box';
        box.style.borderColor = '#fecaca';
        box.innerHTML = `
            <div class="voice-result-meta"><i class="fas fa-exclamation-triangle" style="color:#ef4444;"></i> 语音转写配置有误</div>
            <div class="voice-result-content" style="color:#92400e;">${errorMsg.replace(/\n/g, '<br>')}</div>
            <div class="voice-result-actions">
                <button class="btn btn-secondary btn-xs voice-cfg-close">关闭</button>
                <button class="btn btn-primary btn-xs voice-cfg-settings"><i class="fas fa-cog"></i> 前往设置</button>
            </div>
        `;
        textarea.parentNode.insertBefore(box, textarea.nextSibling);
        box.querySelector('.voice-cfg-close').onclick = () => box.remove();
        box.querySelector('.voice-cfg-settings').onclick = () => { box.remove(); window.location.href = '/settings'; };
    },

    _showVoiceResult(textarea, rawText, blob) {
        document.querySelectorAll('.voice-result-box').forEach(el => el.remove());

        const resultBox = document.createElement('div');
        resultBox.className = 'voice-result-box';
        resultBox.innerHTML = `
            <div class="voice-result-meta"><i class="fas fa-microphone"></i> 识别结果 · ${rawText.length} 字</div>
            <div class="voice-result-content">${rawText.replace(/\n/g, '<br>')}</div>
            <div class="voice-result-actions">
                <button class="btn btn-secondary btn-xs voice-result-discard">放弃</button>
                <button class="btn btn-secondary btn-xs voice-result-audio" title="将录音文件也嵌入笔记"><i class="fas fa-volume-up"></i> 附带录音</button>
                <button class="btn btn-secondary btn-xs voice-result-insert"><i class="fas fa-plus"></i> 插入文字</button>
                <button class="btn btn-primary btn-xs voice-result-organize"><i class="fas fa-magic"></i> AI 整理</button>
            </div>
        `;

        textarea.parentNode.insertBefore(resultBox, textarea.nextSibling);

        resultBox.querySelector('.voice-result-discard').onclick = () => resultBox.remove();

        const insertText = (text) => {
            const pos = textarea.selectionStart;
            const before = textarea.value.substring(0, pos);
            const after = textarea.value.substring(pos);
            const insert = (before && !before.endsWith('\n') ? '\n' : '') + text;
            textarea.value = before + insert + after;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        };

        resultBox.querySelector('.voice-result-insert').onclick = () => {
            insertText(rawText);
            showToast('已插入语音文字');
            resultBox.remove();
        };

        resultBox.querySelector('.voice-result-audio').onclick = async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 上传中';
            try {
                const extMap = { 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
                const ext = extMap[blob.type] || (blob.type.includes('mp4') ? 'mp4' : 'webm');
                const fd = new FormData();
                fd.append('audio', blob, `recording.${ext}`);
                const res = await api.ai.saveAudio(fd);
                if (!res) throw new Error('上传失败');
                const data = await res.json();
                if (data.error) throw new Error(data.error);
                const audioTag = `\n<audio controls src="${data.url}"></audio>\n`;
                insertText(audioTag + rawText);
                showToast('已插入录音和文字');
                resultBox.remove();
            } catch (e) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-volume-up"></i> 附带录音';
                showToast('录音上传失败：' + e.message);
            }
        };

        resultBox.querySelector('.voice-result-organize').onclick = () => {
            this._organizeVoiceWithAI(textarea, rawText, resultBox, blob);
        };
    },

    async _organizeVoiceWithAI(textarea, rawText, resultBox, blob) {
        const actionsDiv = resultBox.querySelector('.voice-result-actions');
        const contentDiv = resultBox.querySelector('.voice-result-content');

        actionsDiv.innerHTML = '<span class="ai-streaming-indicator"></span><span style="color:var(--slate-400);font-size:12px;margin-left:8px;">AI 整理中...</span>';

        try {
            const response = await api.ai.stream({
                action: 'voice_organize',
                content: rawText
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullText += decoder.decode(value);
                if (!fullText.trim()) continue;

                const cleanText = fullText.trim().replace(/\n{3,}/g, '\n\n');
                if (typeof marked !== 'undefined') {
                    contentDiv.innerHTML = sanitizeHtml(marked.parse(cleanText));
                } else {
                    contentDiv.textContent = cleanText;
                }
            }

            const finalText = fullText.trim().replace(/\n{3,}/g, '\n\n');
            actionsDiv.innerHTML = '';

            const metaEl = resultBox.querySelector('.voice-result-meta');
            if (metaEl) metaEl.innerHTML = `<i class="fas fa-magic"></i> AI 整理结果 · ${finalText.length} 字`;

            const discardBtn = document.createElement('button');
            discardBtn.className = 'btn btn-secondary btn-xs';
            discardBtn.textContent = '放弃';
            discardBtn.onclick = () => resultBox.remove();

            const insertRawBtn = document.createElement('button');
            insertRawBtn.className = 'btn btn-secondary btn-xs';
            insertRawBtn.textContent = '插入原文';
            insertRawBtn.onclick = () => {
                const pos = textarea.selectionStart;
                const before = textarea.value.substring(0, pos);
                const after = textarea.value.substring(pos);
                const insert = (before && !before.endsWith('\n') ? '\n' : '') + rawText;
                textarea.value = before + insert + after;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                showToast('已插入原文');
                resultBox.remove();
            };

            const insertContent = async (text, withAudio) => {
                if (withAudio && blob) {
                    const extMap = { 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
                    const ext = extMap[blob.type] || (blob.type.includes('mp4') ? 'mp4' : 'webm');
                    const fd = new FormData();
                    fd.append('audio', blob, `recording.${ext}`);
                    try {
                        const r = await api.ai.saveAudio(fd);
                        if (r) {
                            const d = await r.json();
                            if (d.url) text = `<audio controls src="${d.url}"></audio>\n` + text;
                        }
                    } catch (e) {}
                }
                const pos = textarea.selectionStart;
                const before = textarea.value.substring(0, pos);
                const after = textarea.value.substring(pos);
                textarea.value = before + (before && !before.endsWith('\n') ? '\n' : '') + text + after;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                resultBox.remove();
            };

            const applyBtn = document.createElement('button');
            applyBtn.className = 'btn btn-primary btn-xs';
            applyBtn.innerHTML = '<i class="fas fa-check"></i> 应用';
            applyBtn.onclick = () => { insertContent(finalText, false); showToast('已应用整理结果'); };

            const applyWithAudioBtn = document.createElement('button');
            applyWithAudioBtn.className = 'btn btn-secondary btn-xs';
            applyWithAudioBtn.innerHTML = '<i class="fas fa-volume-up"></i> 附带录音';
            applyWithAudioBtn.title = '同时嵌入原始录音文件';
            applyWithAudioBtn.onclick = async () => {
                applyWithAudioBtn.disabled = true;
                applyWithAudioBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                await insertContent(finalText, true);
                showToast('已应用整理结果并附带录音');
            };

            actionsDiv.appendChild(discardBtn);
            actionsDiv.appendChild(insertRawBtn);
            if (blob) actionsDiv.appendChild(applyWithAudioBtn);
            actionsDiv.appendChild(applyBtn);
        } catch (e) {
            console.error('Voice AI organize error:', e);
            contentDiv.textContent = rawText;
            actionsDiv.innerHTML = '';

            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn btn-secondary btn-xs';
            closeBtn.textContent = '关闭';
            closeBtn.onclick = () => resultBox.remove();
            actionsDiv.appendChild(closeBtn);

            const insertBtn = document.createElement('button');
            insertBtn.className = 'btn btn-primary btn-xs';
            insertBtn.textContent = '插入原文';
            insertBtn.onclick = () => {
                const pos = textarea.selectionStart;
                const before = textarea.value.substring(0, pos);
                const after = textarea.value.substring(pos);
                textarea.value = before + (before && !before.endsWith('\n') ? '\n' : '') + rawText + after;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                resultBox.remove();
            };
            actionsDiv.appendChild(insertBtn);

            showToast('AI 整理失败，可直接插入原文');
        }
    },

    // Markdown 快捷键
    setupMarkdownShortcuts(textarea) {
        const shortcuts = {
            // Ctrl+B: 加粗
            'b': { prefix: '**', suffix: '**', name: '加粗' },
            // Ctrl+I: 斜体
            'i': { prefix: '*', suffix: '*', name: '斜体' },
            // Ctrl+K: 链接
            'k': { prefix: '[', suffix: '](url)', name: '链接' },
            // Ctrl+`: 代码
            '`': { prefix: '`', suffix: '`', name: '行内代码' },
            // Ctrl+Shift+`: 代码块
            'codeblock': { prefix: '```\n', suffix: '\n```', name: '代码块' }
        };

        textarea.addEventListener('keydown', (e) => {
            // 检查是否按下 Ctrl (Windows) 或 Cmd (Mac)
            const isMod = e.ctrlKey || e.metaKey;

            if (!isMod) return;

            const key = e.key.toLowerCase();
            let shortcut = null;

            // 特殊处理代码块 Ctrl+Shift+`
            if (e.shiftKey && key === '`') {
                shortcut = shortcuts['codeblock'];
            } else if (shortcuts[key]) {
                shortcut = shortcuts[key];
            }

            if (shortcut) {
                e.preventDefault();

                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                const selectedText = text.substring(start, end);

                // 如果有选中文本，包裹它；否则插入占位符
                const { prefix, suffix } = shortcut;
                let newText;
                let newCursorStart, newCursorEnd;

                if (selectedText) {
                    newText = prefix + selectedText + suffix;
                    newCursorStart = start + prefix.length;
                    newCursorEnd = end + prefix.length;
                } else {
                    // 无选中文本，插入占位符并选中
                    const placeholder = key === 'k' ? '链接文字' : '文本';
                    newText = prefix + placeholder + suffix;
                    newCursorStart = start + prefix.length;
                    newCursorEnd = newCursorStart + placeholder.length;
                }

                if (textarea.setRangeText) {
                    textarea.setRangeText(newText, start, end, 'end');
                    // 选中新插入的文本（占位符）
                    textarea.setSelectionRange(newCursorStart, newCursorEnd);
                } else {
                    textarea.value = text.substring(0, start) + newText + text.substring(end);
                }

                textarea.focus();

                // 触发 input 事件以更新草稿保存等
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }
};
