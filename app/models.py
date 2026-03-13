from .extensions import db
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
import json
import uuid
import re
import markdown
import hashlib


from .utils import sanitize_html

_BILI_SVG_SM = '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fb7299" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>'
_BILI_SVG_LG = '<svg viewBox="0 0 24 24" width="36" height="36" fill="rgba(255,255,255,0.85)" aria-hidden="true"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L7.547 4.653h8.907l1.387-1.4a1.234 1.234 0 0 1 .92-.373c.347 0 .653.124.92.373.267.249.4.551.4.907a1.234 1.234 0 0 1-.4.906l-1.267 1.187zM2.547 17.347c-.014.627.204 1.16.654 1.6.45.44.987.663 1.613.667h13.44c.627-.004 1.16-.227 1.6-.667.44-.44.663-.973.667-1.6v-7.36c-.004-.627-.227-1.16-.667-1.6-.44-.44-.973-.663-1.6-.667H4.814c-.626.004-1.163.227-1.613.667-.45.44-.668.973-.654 1.6v7.36zM8 13.333a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0zm10.667 0a1.333 1.333 0 1 1-2.667 0 1.333 1.333 0 0 1 2.667 0z"/></svg>'


def _bilibili_card_html(bvid):
    """生成 B站视频卡片 HTML（与前端 createBilibiliCardHtml 保持结构一致）"""
    return (
        f'<div class="bilibili-card" data-bvid="{bvid}" role="button" tabindex="0">'
        f'<div class="bili-card-thumb">'
        f'<div class="bili-thumb-placeholder">{_BILI_SVG_LG}</div>'
        f'<div class="bili-play-btn"><i class="fas fa-play"></i></div>'
        f'</div>'
        f'<div class="bili-card-content">'
        f'<div class="bili-card-brand-row">{_BILI_SVG_SM}<span class="bili-brand-name">bilibili</span></div>'
        f'<div class="bili-card-title" data-loading="true">加载中…</div>'
        f'<div class="bili-card-meta"><span class="bili-card-bvid">{bvid}</span></div>'
        f'</div>'
        f'<div class="bili-card-arrow"><i class="fas fa-chevron-right"></i></div>'
        f'</div>'
    )


# Association Table for Many-to-Many relationship between Note and Tag
note_tags = db.Table('note_tags',
    db.Column('note_id', db.String(36), db.ForeignKey('note.id'), primary_key=True),
    db.Column('tag_id', db.Integer, db.ForeignKey('tag.id'), primary_key=True)
)

class Tag(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), unique=True, nullable=False)

    def to_dict(self):
        return {'id': self.id, 'name': self.name}

class User(UserMixin, db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(120), nullable=False)
    
    # WebAuthn Credentials
    credentials = db.relationship('UserCredential', backref='user', lazy=True, cascade='all, delete-orphan')

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class UserCredential(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(36), db.ForeignKey('user.id'), nullable=False)
    credential_id = db.Column(db.LargeBinary, unique=True, nullable=False)
    public_key = db.Column(db.LargeBinary, nullable=False)
    sign_count = db.Column(db.Integer, default=0)
    transports = db.Column(db.String(255)) # Store as comma-separated string
    created_at = db.Column(db.DateTime, default=datetime.now)

class NoteReference(db.Model):
    __tablename__ = 'note_reference'
    source_id = db.Column(db.String(36), db.ForeignKey('note.id'), primary_key=True)
    target_id = db.Column(db.String(36), db.ForeignKey('note.id'), primary_key=True)
    
    # Relationships
    source_note = db.relationship('Note', foreign_keys=[source_id], backref=db.backref('outgoing_references', cascade='all, delete-orphan'))
    target_note = db.relationship('Note', foreign_keys=[target_id], backref=db.backref('incoming_references', cascade='all, delete-orphan'))

class NoteVersion(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    note_id = db.Column(db.String(36), db.ForeignKey('note.id'), nullable=False)
    content = db.Column(db.Text, nullable=False)
    title = db.Column(db.String(255), default='')
    created_at = db.Column(db.DateTime, default=datetime.now)
    
    # Relationship
    note = db.relationship('Note', backref=db.backref('versions', cascade='all, delete-orphan', order_by='desc(NoteVersion.created_at)'))

    def to_dict(self):
        return {
            'id': self.id,
            'note_id': self.note_id,
            'content': self.content,
            'title': self.title,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S')
        }

class Note(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    content = db.Column(db.Text, nullable=False)
    title = db.Column(db.String(255), default='')

    created_at = db.Column(db.DateTime, default=datetime.now)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)
    user_id = db.Column(db.String(36), db.ForeignKey('user.id'), nullable=True) # Nullable for existing notes
    is_public = db.Column(db.Boolean, default=False)
    is_deleted = db.Column(db.Boolean, default=False)
    deleted_at = db.Column(db.DateTime, nullable=True)

    # 时光胶囊 (Time Capsule) 字段
    is_capsule = db.Column(db.Boolean, default=False)
    capsule_date = db.Column(db.DateTime, nullable=True)
    capsule_hint = db.Column(db.String(255), nullable=True)
    capsule_status = db.Column(db.String(20), default='none') # none, locked, ready, opened

    # Relationship to Tags
    tags_list = db.relationship('Tag', secondary=note_tags, lazy='subquery',
        backref=db.backref('notes', lazy=True))

    def to_dict(self, include_documents=False):
        result = {
            'id': self.id,
            'content': self.content,
            'title': self.title,
            'links': [ref.target_note.title for ref in self.outgoing_references if ref.target_note],
            'backlinks': [
                {'id': ref.source_note.id, 'title': ref.source_note.title}
                for ref in self.incoming_references
                if ref.source_note and not ref.source_note.is_deleted
            ],
            'tags': [tag.name for tag in self.tags_list],
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': self.updated_at.strftime('%Y-%m-%d %H:%M:%S'),
            'user_id': self.user_id,
            'is_public': self.is_public,
            'is_deleted': self.is_deleted,
            'deleted_at': self.deleted_at.strftime('%Y-%m-%d %H:%M:%S') if self.deleted_at else None,
            'is_capsule': self.is_capsule,
            'capsule_date': self.capsule_date.strftime('%Y-%m-%d %H:%M:%S') if self.capsule_date else None,
            'capsule_hint': self.capsule_hint,
            'capsule_status': self.capsule_status,
        }
        
        if hasattr(self, 'documents'):
            if include_documents:
                result['documents'] = [doc.to_dict() for doc in self.documents]
            else:
                result['documents'] = [{'id': doc.id} for doc in self.documents]
        else:
            result['documents'] = []
            
        return result

    @staticmethod
    def get_visible_filter():
        """返回SQLAlchemy过滤条件：用于获取普通可见的笔记（排除未拆开的胶囊）
        注意：is_capsule 为 NULL 的旧数据视同普通笔记（非胶囊），需一并放行。
        """
        return db.or_(Note.is_capsule == None, Note.is_capsule == False, db.and_(Note.is_capsule == True, Note.capsule_status == 'opened'))

    def is_viewable_by_owner(self):
        """判断当前胶囊是否对所有者可见真实内容"""
        return not self.is_capsule or self.capsule_status == 'opened'

    def to_obfuscated_dict(self):
        """返回脱敏后的字典数据（用于未拆开的胶囊）"""
        d = self.to_dict(include_documents=False)
        d['title'] = '🔒 时光胶囊'
        d['content'] = '内容已封存,请在解锁时间到达后拆开。'
        d['links'] = []
        d['backlinks'] = []
        d['tags'] = []
        d['documents'] = []
        return d

    def get_excerpt(self, max_length=150):
        if self.is_capsule and self.capsule_status != 'opened':
            return '🔒 内容已封存，请在解锁时间到达后拆开。'
        """
        从 Markdown 内容中提取智能摘要
        - 移除代码块（包括 mermaid、mindmap 等）
        - 移除 Markdown 语法标记
        - 将待办事项转换为友好显示
        - 提取纯文本
        """
        if not self.content:
            return ''

        text = self.content

        # 1. 移除代码块（```...```）
        text = re.sub(r'```[\s\S]*?```', '', text)

        # 2. 移除行内代码（`code`）
        text = re.sub(r'`[^`]+`', '', text)

        # 3. 移除图片 ![alt](url)
        text = re.sub(r'!\[[^\]]*\]\([^)]+\)', '', text)

        # 4. 移除链接 [text](url)，保留文字
        text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)

        # 5. 处理待办事项 - [ ] 和 - [x]
        text = re.sub(r'-\s*\[x\]\s*', '✓ ', text)  # 已完成
        text = re.sub(r'-\s*\[\s*\]\s*', '○ ', text)  # 未完成

        # 6. 移除标题标记 # ## ### 等
        text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)

        # 7. 移除粗体和斜体标记
        text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)  # 粗体
        text = re.sub(r'\*([^*]+)\*', r'\1', text)  # 斜体
        text = re.sub(r'__([^_]+)__', r'\1', text)  # 粗体
        text = re.sub(r'_([^_]+)_', r'\1', text)  # 斜体

        # 8. 移除删除线
        text = re.sub(r'~~([^~]+)~~', r'\1', text)

        # 9. 移除引用标记 >
        text = re.sub(r'^>\s*', '', text, flags=re.MULTILINE)

        # 10. 移除列表标记 - * +
        text = re.sub(r'^[\-\*\+]\s+', '', text, flags=re.MULTILINE)

        # 11. 移除有序列表标记 1. 2. 等
        text = re.sub(r'^\d+\.\s+', '', text, flags=re.MULTILINE)

        # 12. 移除 WikiLinks [[...]]
        text = re.sub(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', r'\1', text)

        # 13. 移除 HTML 标签
        text = re.sub(r'<[^>]+>', '', text)

        # 14. 移除水平线 --- *** ___
        text = re.sub(r'^[-*_]{3,}\s*$', '', text, flags=re.MULTILINE)

        # 15. 清理多余空白
        text = re.sub(r'\n+', ' ', text)  # 换行转空格
        text = re.sub(r'\s+', ' ', text)  # 多个空格合并
        text = text.strip()

        # 16. 截断到指定长度
        if len(text) > max_length:
            text = text[:max_length].rstrip() + '...'

        return text

    @property
    def display_title(self):
        """返回适合显示的标题，过滤掉纯符号/单字符无意义标题"""
        t = (self.title or '').strip()
        if not t or not re.search(r'[\w\u4e00-\u9fff]', t):
            return ''
        return t

    @property
    def reading_time(self):
        """估算阅读时间（分钟）"""
        if not self.content:
            return 1
        return max(1, len(self.content) // 400)

    @property
    def first_image(self):
        """
        从Markdown内容中提取第一张图片的URL
        支持格式：![alt](url) 或 <img src="url">
        """
        if not self.content:
            return None
        
        # 1. 尝试匹配 Markdown 图片语法 ![...](url)
        # 非贪婪匹配，获取第一个捕获组
        md_match = re.search(r'!\[.*?\]\((.*?)\)', self.content)
        if md_match:
            return md_match.group(1).split()[0]  # 处理可能存在的 title 部分: "url title"

        # 2. 尝试匹配 HTML 图片标签 <img src="url">
        html_match = re.search(r'<img\s+[^>]*src=["\'](.*?)["\']', self.content, re.IGNORECASE)
        if html_match:
            return html_match.group(1)

        return None

    def render_html(self, max_length=None):
        """
        渲染Markdown内容为HTML（用于服务端渲染）
        已添加XSS防护
        """
        if not self.content:
            return ''

        text = self.content

        # 截断长度
        if max_length and len(text) > max_length:
            text = text[:max_length]

        try:
            # 预处理：修复 **引号内容** 格式的粗体解析问题
            # 处理英文引号 **"content"**
            text = re.sub(r'\*\*"([^"]+)"([^\*]*?)\*\*', r'<strong>"\1"\2</strong>', text)
            # 处理中文引号 **"content"** (U+201C, U+201D)
            text = re.sub('\\*\\*\u201C([^\u201D]+)\u201D([^\\*]*?)\\*\\*', '<strong>\u201C\\1\u201D\\2</strong>', text)
            # 处理 **「content」**
            text = re.sub(r'\*\*「([^」]+)」([^\*]*?)\*\*', r'<strong>「\1」\2</strong>', text)
            # 处理 **『content』**
            text = re.sub(r'\*\*『([^』]+)』([^\*]*?)\*\*', r'<strong>『\1』\2</strong>', text)

            html = markdown.markdown(text, extensions=['fenced_code', 'tables', 'toc'])

            _audio_exts = re.compile(r'\.(mp3|wav|m4a|flac|aac)$', re.I)
            _video_exts = re.compile(r'\.(mp4|webm|ogg|mov)$', re.I)
            def _media_replace(m):
                href = m.group(1)
                if _audio_exts.search(href):
                    return f'<audio controls preload="metadata" src="{href}"></audio>'
                if _video_exts.search(href):
                    return f'<div class="video-wrapper"><video controls preload="metadata" src="{href}"></video></div>'
                return m.group(0)
            html = re.sub(r'<a\s+href="([^"]+)"[^>]*>.*?</a>', _media_replace, html)

            html = sanitize_html(html)

            html = re.sub(
                r'<a\s+href="https?://(?:www\.)?bilibili\.com/video/(BV[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+)[^"]*"[^>]*>.*?</a>',
                lambda m: _bilibili_card_html(m.group(1)), html)
            html = re.sub(
                r'<a\s+href="https?://(?:www\.)?bilibili\.com/video/av(\d+)[^"]*"[^>]*>.*?</a>',
                lambda m: _bilibili_card_html(f'av{m.group(1)}'), html)
        except Exception as e:
            import traceback
            traceback.print_exc()
            html = text.replace('\n', '<br>')

        return html

class Config(db.Model):
    key = db.Column(db.String(128), primary_key=True)
    value = db.Column(db.Text)
    description = db.Column(db.String(255))

    @staticmethod
    def get(key, default=None):
        conf = db.session.get(Config, key)
        return conf.value if conf else default

    @staticmethod
    def set(key, value, description=None):
        # 统一处理布尔值，转换为小写字符串
        if isinstance(value, bool):
            value = 'true' if value else 'false'
        conf = db.session.get(Config, key)
        if not conf:
            conf = Config(key=key, value=str(value), description=description)
            db.session.add(conf)
        else:
            conf.value = str(value)
            if description:
                conf.description = description
        db.session.commit()


class Share(db.Model):
    """分享链接模型"""
    __tablename__ = 'share'

    id = db.Column(db.String(8), primary_key=True)  # 分享ID，8位安全随机字符
    note_id = db.Column(db.String(36), db.ForeignKey('note.id'), nullable=False)
    password = db.Column(db.String(128), nullable=True)  # 可选密码，存储hash
    expires_at = db.Column(db.DateTime, nullable=True)  # 可选过期时间
    view_count = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.now)

    # 关联
    note = db.relationship('Note', backref=db.backref('shares', cascade='all, delete-orphan'))

    def set_password(self, password):
        """设置分享密码"""
        self.password = generate_password_hash(password)

    def check_password(self, password):
        """验证分享密码"""
        if not self.password:
            return True  # 无密码时直接通过
        return check_password_hash(self.password, password)

    def is_expired(self):
        """检查是否已过期"""
        if not self.expires_at:
            return False
        return datetime.now() > self.expires_at

    def to_dict(self):
        return {
            'id': self.id,
            'note_id': self.note_id,
            'has_password': bool(self.password),
            'expires_at': self.expires_at.strftime('%Y-%m-%d %H:%M:%S') if self.expires_at else None,
            'view_count': self.view_count,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'is_expired': self.is_expired()
        }


class ShareAttempt(db.Model):
    """分享密码尝试记录（用于IP锁定防暴力破解）"""
    __tablename__ = 'share_attempt'

    id = db.Column(db.Integer, primary_key=True)
    share_id = db.Column(db.String(8), db.ForeignKey('share.id'), nullable=False)
    ip_address = db.Column(db.String(45), nullable=False)  # IPv6最长45字符
    attempt_count = db.Column(db.Integer, default=0)
    first_attempt_at = db.Column(db.DateTime, default=datetime.now)
    last_attempt_at = db.Column(db.DateTime, default=datetime.now)
    locked_until = db.Column(db.DateTime, nullable=True)

    # 关联
    share = db.relationship('Share', backref=db.backref('attempts', cascade='all, delete-orphan'))

    # 安全配置
    MAX_FAILED_ATTEMPTS = 5  # 最大失败次数
    LOCKOUT_MINUTES = 30  # 锁定时长（分钟）
    ATTEMPT_WINDOW_HOURS = 24  # 尝试计数窗口（小时）

    @classmethod
    def get_or_create(cls, share_id, ip_address):
        """获取或创建尝试记录"""
        # 清理过期的记录
        cutoff = datetime.now() - timedelta(hours=cls.ATTEMPT_WINDOW_HOURS)
        cls.query.filter(cls.last_attempt_at < cutoff).delete()
        db.session.commit()

        record = cls.query.filter_by(share_id=share_id, ip_address=ip_address).first()
        if not record:
            record = cls(share_id=share_id, ip_address=ip_address)
            db.session.add(record)
            db.session.commit()
        return record

    def is_locked(self):
        """检查IP是否被锁定"""
        if not self.locked_until:
            return False
        if datetime.now() > self.locked_until:
            # 锁定已过期，重置
            self.locked_until = None
            self.attempt_count = 0
            db.session.commit()
            return False
        return True

    def record_failed_attempt(self):
        """记录一次失败的密码尝试"""
        self.attempt_count += 1
        self.last_attempt_at = datetime.now()
        if self.attempt_count >= self.MAX_FAILED_ATTEMPTS:
            self.locked_until = datetime.now() + timedelta(minutes=self.LOCKOUT_MINUTES)
        db.session.commit()

    def reset(self):
        """重置记录（密码验证成功后调用）"""
        self.attempt_count = 0
        self.locked_until = None
        db.session.commit()

    def get_remaining_attempts(self):
        """获取剩余尝试次数"""
        return max(0, self.MAX_FAILED_ATTEMPTS - self.attempt_count)

    def get_remaining_lock_minutes(self):
        """获取剩余锁定分钟数"""
        if not self.locked_until:
            return 0
        remaining = (self.locked_until - datetime.now()).total_seconds() / 60
        return max(0, int(remaining) + 1)


class Annotation(db.Model):
    """PDF/Word 文档上的批注（高亮 + 可选边注文字）"""
    __tablename__ = 'annotation'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id = db.Column(db.String(36), db.ForeignKey('document.id'), nullable=False)
    user_id = db.Column(db.String(36), db.ForeignKey('user.id'), nullable=False)
    note_id = db.Column(db.String(36), db.ForeignKey('note.id'), nullable=True)  # 关联笔记（可选）
    page = db.Column(db.Integer, nullable=True)      # PDF 页码，Word 文档为 None
    selected_text = db.Column(db.Text, nullable=False)  # 高亮选中的原文
    color = db.Column(db.String(20), default='yellow')  # yellow / green / pink / blue
    ann_note = db.Column(db.Text, nullable=True)     # 可选：边注文字
    created_at = db.Column(db.DateTime, default=datetime.now)

    document = db.relationship('Document', backref=db.backref('annotations', cascade='all, delete-orphan'))
    user = db.relationship('User', backref=db.backref('annotations', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'document_id': self.document_id,
            'note_id': self.note_id,
            'page': self.page,
            'selected_text': self.selected_text,
            'color': self.color,
            'ann_note': self.ann_note,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
        }


class Document(db.Model):
    """关联笔记的文档（PDF 直读 / Word 转 MD）"""
    __tablename__ = 'document'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    note_id = db.Column(db.String(36), db.ForeignKey('note.id'), nullable=True)
    user_id = db.Column(db.String(36), db.ForeignKey('user.id'), nullable=False)
    original_filename = db.Column(db.String(256), nullable=False)
    stored_filename = db.Column(db.String(256), nullable=False)
    file_type = db.Column(db.String(10), nullable=False)   # 'pdf' | 'docx'
    page_count = db.Column(db.Integer, nullable=True)
    file_size = db.Column(db.Integer, nullable=True)       # bytes
    text_content = db.Column(db.Text, nullable=True)       # 全文文本（搜索 / AI 摘要用）
    md_content = db.Column(db.Text, nullable=True)         # Word 转换的 Markdown
    ai_summary = db.Column(db.Text, nullable=True)         # AI 一句话摘要
    created_at = db.Column(db.DateTime, default=datetime.now)

    note = db.relationship('Note', backref=db.backref('documents'))
    user = db.relationship('User', backref=db.backref('documents', lazy=True))

    def to_dict(self):
        return {
            'id': self.id,
            'note_id': self.note_id,
            'original_filename': self.original_filename,
            'file_type': self.file_type,
            'page_count': self.page_count,
            'file_size': self.file_size,
            'ai_summary': self.ai_summary,
            'has_md': bool(self.md_content),
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
        }


class Comment(db.Model):
    """评论模型"""
    __tablename__ = 'comments'
    
    id = db.Column(db.Integer, primary_key=True)
    post_id = db.Column(db.String(36), db.ForeignKey('note.id'), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey('comments.id'), nullable=True)
    
    author_name = db.Column(db.String(80), nullable=False)
    author_email = db.Column(db.String(120), nullable=False)
    author_website = db.Column(db.String(200), nullable=True)
    
    content = db.Column(db.Text, nullable=False) # Markdown原始内容
    html = db.Column(db.Text, nullable=False)    # 清洗后的HTML
    
    status = db.Column(db.String(20), default='pending') # pending, approved, spam
    is_admin = db.Column(db.Boolean, default=False)
    notification_sent = db.Column(db.Boolean, default=False)
    ip_address = db.Column(db.String(45), nullable=True)
    
    created_at = db.Column(db.DateTime, default=datetime.now)

    # Relationships
    # Self-referential relationship for replies
    replies = db.relationship('Comment', backref=db.backref('parent', remote_side=[id]), lazy='dynamic')
    
    # Relationship to Note
    note = db.relationship('Note', backref=db.backref('comments', lazy='dynamic', cascade='all, delete-orphan'))

    def to_dict(self, settings=None):
        """
        转换为字典，供API使用
        :param settings: 配置字典，避免N+1查询
        """
        if settings is None:
            settings = {}

        # 1. 确定头像源
        source = settings.get('avatar_source', 'cravatar') # Default to Cravatar for speed in CN
        base_urls = {
            'gravatar': 'https://www.gravatar.com/avatar/',
            'cravatar': 'https://cravatar.cn/avatar/',
            'weavatar': 'https://weavatar.com/avatar/'
        }
        base_url = base_urls.get(source, base_urls['cravatar'])

        # 2. 生成头像链接
        if self.is_admin and settings.get('blogger_avatar'):
            avatar_url = settings.get('blogger_avatar')
        else:
            email_hash = hashlib.md5(self.author_email.lower().strip().encode('utf-8')).hexdigest()
            avatar_url = f"{base_url}{email_hash}?s=48&d=identicon"

        return {
            'id': self.id,
            'post_id': self.post_id,
            'parent_id': self.parent_id,
            'author_name': self.author_name,
            'author_website': self.author_website,
            'content': self.content, # 原始内容用于编辑
            'html': self.html,       # 显示用
            'status': self.status,
            'is_admin': self.is_admin,
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'avatar': avatar_url,
            'replies': [reply.to_dict(settings) for reply in self.replies.order_by(Comment.created_at.asc())] if self.replies else []
        }
