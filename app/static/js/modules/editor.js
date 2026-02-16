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
        this.setupAITools(textarea);
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
                            <i class="${c.icon}" style="width:20px; color:#888;"></i> 
                            <span style="font-weight:600; margin-right:8px;">/${c.match}</span> 
                            <span style="font-size:12px; color:#aaa;">${c.label}</span>
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
            }
        });
        
        // Handle Tab/Enter key navigation in dropdown? 
        // For simplicity, sticking to click or exact match handling could be added later.
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
                        const tags = cleanOutput.split(/[\s,，#]+/).filter(t => t.trim() !== '');
                        const currentTarget = textarea.classList.contains('inline-editor-textarea') ? 'edit' : 'input';
                        tags.forEach(t => {
                            if (currentTarget === 'input' && !state.currentTags.includes(t)) state.currentTags.push(t);
                            else if (currentTarget === 'edit' && !state.editTags.includes(t)) state.editTags.push(t);
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
    }
};
