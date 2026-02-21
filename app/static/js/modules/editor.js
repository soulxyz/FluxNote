import { api } from './api.js';
import { state } from './state.js';
import { ui } from './ui.js';
import { showToast, getCaretCoordinates, debounce } from './utils.js';

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
        this.setupAutoHeight(textarea);
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
                    // Insert markdown
                    const pos = textarea.selectionStart;
                    const text = textarea.value;
                    const md = `\n![image](${data.url})\n`;
                    // textarea.setRangeText is better but lets support older browsers slightly or standard way
                    if (textarea.setRangeText) {
                        textarea.setRangeText(md);
                    } else {
                        textarea.value = text.slice(0, pos) + md + text.slice(pos);
                    }
                    showToast('图片上传成功');
                } else {
                    showToast('上传失败');
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
            { label: 'AI 助手', action: 'ai', icon: 'fas fa-magic', match: 'ai' }
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
        
        if (cmd.action === 'ai') {
            replacement = ''; 
            // Trigger AI menu logic
            // Assuming the AI button logic is available via existing click handler
            // We need to find the AI button for THIS textarea context
            // Reuse logic from setupAITools to find controls
            let controls = null;
            const memoEditor = textarea.closest('.memo-editor');
            if (memoEditor) controls = memoEditor.querySelector('.editor-footer .input-controls');
            if (!controls) {
                const inlineContainer = textarea.closest('.inline-editor-container');
                if (inlineContainer) controls = inlineContainer.querySelector('.inline-tools-left');
            }
            if (controls) {
                const btn = controls.querySelector('.ai-trigger');
                if (btn) setTimeout(() => btn.click(), 50); // Small delay to let UI settle
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
                if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
                    contentDiv.innerHTML = DOMPurify.sanitize(marked.parse(cleanText));
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
                dragOverlay.innerHTML = '<i class="fas fa-cloud-upload-alt"></i><span>释放以上传图片</span>';
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

            const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
            if (imageFiles.length === 0) return;

            e.preventDefault();

            for (const file of imageFiles) {
                const formData = new FormData();
                formData.append('file', file);
                showToast('正在上传图片...');

                try {
                    const response = await api.upload(formData);
                    if (response && response.ok) {
                        const data = await response.json();
                        const md = `\n![image](${data.url})\n`;
                        if (textarea.setRangeText) {
                            textarea.setRangeText(md);
                        } else {
                            textarea.value += md;
                        }
                        showToast('图片上传成功');
                    } else {
                        showToast('上传失败');
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
