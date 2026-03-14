import { api } from './api.js';
import { editor } from './editor.js';
import { showToast, debounce } from './utils.js';

export const inlineEditor = {
    currentNoteId: null,
    originalContent: null,
    originalTags: [],
    isEditing: false,
    editorElement: null,
    tags: [],

    async open(noteId) {
        if (this.isEditing) {
            showToast('请先保存或取消当前编辑');
            return;
        }

        this.currentNoteId = noteId;
        const noteCard = document.querySelector(`.note-card[data-note-id="${noteId}"]`);
        if (!noteCard) {
            showToast('未找到文章');
            return;
        }

        // 获取原始内容和标签
        const rawContent = document.getElementById(`raw-content-${noteId}`);
        this.originalContent = rawContent ? rawContent.textContent : '';

        // 获取标签
        const tagsContainer = noteCard.querySelector('.note-tags');
        if (tagsContainer) {
            this.originalTags = Array.from(tagsContainer.querySelectorAll('.note-tag'))
                .map(tag => tag.textContent.replace(/^#/, ''));
        }
        this.tags = [...this.originalTags];

        // 获取文章公开状态（从API获取）
        this.isPublic = true; // 默认为公开
        try {
            const response = await api.notes.get(this.currentNoteId);
            if (response && response.ok) {
                const note = await response.json();
                this.isPublic = note.is_public !== false;
            }
        } catch (e) {
            console.error('Failed to fetch note status:', e);
        }

        // 创建编辑器
        this.createEditor(noteCard);
        this.isEditing = true;
    },

    createEditor(noteCard) {
        const noteContent = noteCard.querySelector('.note-content');
        const noteFooter = noteCard.querySelector('.note-footer');
        const postHeader = noteCard.querySelector('.post-header');

        // 保存原始内容显示
        this.originalDisplay = noteContent.innerHTML;
        this.originalHeader = postHeader ? postHeader.innerHTML : '';
        if (noteFooter) {
            this.originalFooter = noteFooter.innerHTML;
        }

        // 隐藏原始内容
        noteContent.style.display = 'none';
        if (postHeader) {
            postHeader.style.display = 'none';
        }
        if (noteFooter) {
            noteFooter.style.display = 'none';
        }

        // 创建编辑器容器，插入到noteCard中
        const editorContainer = document.createElement('div');
        editorContainer.className = 'inline-editor-container';
        editorContainer.innerHTML = `
            <div class="inline-tools-bar">
                <div class="inline-tools-left">
                    <button class="tool-btn" title="插入标签" onclick="window.inlineEditor.focusTagInput()">
                        <i class="fas fa-hashtag"></i>
                    </button>
                    <button class="tool-btn" title="上传图片" onclick="window.inlineEditor.uploadImage()">
                        <i class="far fa-image"></i>
                    </button>
                    <button class="tool-btn ai-trigger" title="AI 助手">
                        <i class="fas fa-magic"></i>
                    </button>
                    <button class="tool-btn voice-trigger" title="语音输入">
                        <i class="fas fa-microphone"></i>
                    </button>
                </div>
                <div class="inline-tools-right">
                    <div class="public-switch-inline">
                        <input type="checkbox" id="inline-public-${this.currentNoteId}" ${this.isPublic ? 'checked' : ''}>
                        <label for="inline-public-${this.currentNoteId}">公开</label>
                    </div>
                </div>
            </div>
            <textarea class="inline-editor-textarea" placeholder="开始编辑...">${this.originalContent}</textarea>
            <div class="inline-tags-area">
                <div class="inline-tags-list"></div>
                <input type="text" class="inline-tag-input" placeholder="输入标签按回车添加...">
            </div>
            <div class="inline-actions">
                <div class="inline-actions-left">
                    <div class="inline-status">
                        <i class="fas fa-check-circle"></i>
                        <span>已加载</span>
                    </div>
                </div>
                <div class="inline-actions-right">
                    <button class="btn-cancel" onclick="window.inlineEditor.cancel()">取消</button>
                    <button class="btn-save" onclick="window.inlineEditor.save()">
                        <i class="fas fa-save"></i> 保存
                    </button>
                </div>
            </div>
        `;

        // 将编辑器插入到noteCard中，放在所有元素之后
        noteCard.appendChild(editorContainer);

        this.editorElement = editorContainer;
        const textarea = editorContainer.querySelector('.inline-editor-textarea');

        // 渲染标签
        this.renderTags();

        // 初始化编辑器功能
        editor.init(textarea);

        // 设置自动保存
        this.setupAutoSave(textarea);

        // 绑定标签输入事件
        const tagInput = editorContainer.querySelector('.inline-tag-input');
        tagInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const tag = tagInput.value.trim();
                if (tag && !this.tags.includes(tag)) {
                    this.tags.push(tag);
                    this.renderTags();
                    tagInput.value = '';
                }
            }
        });

        // 绑定AI按钮事件
        const aiBtn = editorContainer.querySelector('.ai-trigger');
        aiBtn.onclick = (e) => editor.showAIMenu(e, textarea);

        // 绑定语音按钮事件
        const voiceBtn = editorContainer.querySelector('.voice-trigger');
        voiceBtn.onclick = () => editor.toggleVoiceRecording(textarea, voiceBtn);
    },

    renderTags() {
        if (!this.editorElement) return;
        const tagsList = this.editorElement.querySelector('.inline-tags-list');
        tagsList.innerHTML = this.tags.map(tag => `
            <span class="inline-tag">
                #${tag}
                <span class="inline-tag-remove" onclick="window.inlineEditor.removeTag('${tag}')">×</span>
            </span>
        `).join('');
    },

    removeTag(tag) {
        this.tags = this.tags.filter(t => t !== tag);
        this.renderTags();
    },

    focusTagInput() {
        if (!this.editorElement) return;
        const tagInput = this.editorElement.querySelector('.inline-tag-input');
        tagInput.focus();
    },

    async uploadImage() {
        if (!this.editorElement) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);
            showToast('正在上传图片...');

            try {
                const response = await api.upload(formData);
                if (response && response.ok) {
                    const data = await response.json();
                    const textarea = this.editorElement.querySelector('.inline-editor-textarea');
                    const md = `\n![${data.filename || 'image'}](${data.url})\n`;
                    const pos = textarea.selectionStart;
                    textarea.setRangeText(md, pos, pos, 'end');
                    textarea.focus();
                    showToast('图片上传成功');
                } else {
                    const err = await response.json().catch(() => ({}));
                    showToast(err.error || '上传失败');
                }
            } catch (err) {
                showToast('上传失败');
            }
        };
        input.click();
    },

    async save() {
        if (!this.editorElement) return;

        const textarea = this.editorElement.querySelector('.inline-editor-textarea');
        const content = textarea.value.trim();
        const isPublic = this.editorElement.querySelector('.public-switch-inline input').checked;
        const saveBtn = this.editorElement.querySelector('.btn-save');
        const statusEl = this.editorElement.querySelector('.inline-status');

        if (!content) {
            showToast('内容不能为空');
            return;
        }

        // 更新UI状态
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
        statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>保存中...</span>';
        statusEl.classList.add('saving');

        try {
            const response = await api.notes.update(this.currentNoteId, {
                content: content,
                tags: this.tags,
                is_public: isPublic
            });

            if (response && response.ok) {
                // 更新原始内容
                this.originalContent = content;
                this.originalTags = [...this.tags];

                // 更新显示
                const noteContent = document.querySelector(`#note-render-${this.currentNoteId}`);
                const rawContent = document.getElementById(`raw-content-${this.currentNoteId}`);

                if (rawContent) {
                    rawContent.textContent = content;
                }

                // 重新渲染Markdown
                if (typeof marked !== 'undefined' && noteContent) {
                    const html = marked.parse(content);
                    // 使用DOMPurify清理HTML
                    if (typeof DOMPurify !== 'undefined') {
                        noteContent.innerHTML = DOMPurify.sanitize(html);
                    } else {
                        noteContent.innerHTML = html;
                    }

                    // 重新应用代码高亮
                    if (typeof hljs !== 'undefined') {
                        noteContent.querySelectorAll('pre code').forEach((block) => {
                            hljs.highlightElement(block);
                        });
                    }
                }

                // 更新标签
                const tagsContainer = document.querySelector('.note-footer .note-tags');
                if (tagsContainer) {
                    tagsContainer.innerHTML = this.tags.map(tag => 
                        `<a href="/tags/${tag}" class="note-tag">#${tag}</a>`
                    ).join('');
                }

                // 清除草稿
                if (this._clearDraft) {
                    this._clearDraft();
                }

                showToast('保存成功');
                this.close();
            } else {
                const err = await response.json().catch(() => ({}));
                showToast(err.error || '保存失败');
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存';
                statusEl.innerHTML = '<i class="fas fa-times-circle"></i><span>保存失败</span>';
                statusEl.classList.remove('saving');
            }
        } catch (err) {
            console.error('Save error:', err);
            showToast('保存失败');
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存';
            statusEl.innerHTML = '<i class="fas fa-times-circle"></i><span>保存失败</span>';
            statusEl.classList.remove('saving');
        }
    },

    cancel() {
        if (!this.editorElement) return;

        // 恢复原始内容
        const noteContent = document.querySelector(`#note-render-${this.currentNoteId}`);
        const noteFooter = document.querySelector('.note-footer');
        const postHeader = document.querySelector('.post-header');

        if (noteContent) {
            noteContent.style.display = '';
            noteContent.innerHTML = this.originalDisplay;
        }

        if (postHeader) {
            postHeader.style.display = '';
            if (this.originalHeader) {
                postHeader.innerHTML = this.originalHeader;
            }
        }

        if (noteFooter) {
            noteFooter.style.display = '';
            if (this.originalFooter) {
                noteFooter.innerHTML = this.originalFooter;
            }
        }

        // 移除编辑器
        this.editorElement.remove();
        this.editorElement = null;
        this.isEditing = false;
        this.currentNoteId = null;
        this.tags = [];
    },

    close() {
        if (!this.editorElement) return;

        const noteContent = document.querySelector(`#note-render-${this.currentNoteId}`);
        const noteFooter = document.querySelector('.note-footer');
        const postHeader = document.querySelector('.post-header');

        if (noteContent) {
            noteContent.style.display = '';
        }

        if (postHeader) {
            postHeader.style.display = '';
        }

        if (noteFooter) {
            noteFooter.style.display = '';
        }

        // 移除编辑器
        this.editorElement.remove();
        this.editorElement = null;
        this.isEditing = false;
        this.currentNoteId = null;
        this.tags = [];
    },

    setupAutoSave(textarea) {
        const statusEl = this.editorElement.querySelector('.inline-status');

        const showStatus = (msg, type) => {
            if (!statusEl) return;
            statusEl.innerHTML = msg;
            statusEl.className = 'inline-status';
            if (type === 'saving') statusEl.classList.add('saving');
            else if (type === 'saved') statusEl.classList.add('saved');
        };

        // 保存到本地存储
        const saveToLocal = debounce(() => {
            const val = textarea.value;
            localStorage.setItem(`inline_draft_${this.currentNoteId}`, val);
            showStatus('<i class="fas fa-check-circle"></i><span>草稿已保存</span>', 'saved');
        }, 1000);

        // 加载本地草稿
        const draft = localStorage.getItem(`inline_draft_${this.currentNoteId}`);
        if (draft && draft !== this.originalContent) {
            textarea.value = draft;
            showStatus('<i class="fas fa-info-circle"></i><span>已恢复草稿</span>', 'saved');
        }

        // 监听输入事件
        textarea.addEventListener('input', () => {
            showStatus('<i class="fas fa-spinner fa-spin"></i><span>保存中...</span>', 'saving');
            saveToLocal();
        });

        // 保存成功后清除草稿
        const clearDraft = () => {
            localStorage.removeItem(`inline_draft_${this.currentNoteId}`);
        };

        // 在保存成功后调用
        this._clearDraft = clearDraft;
    }
};

// 暴露到全局
window.inlineEditor = inlineEditor;
