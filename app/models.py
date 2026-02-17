from .extensions import db
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
import json
import uuid
import re
import markdown
import bleach
import hashlib


# BLEACH 配置：允许的标签和属性（用于Markdown渲染后的安全清洗）
ALLOWED_TAGS = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span',
    'sup', 'sub',
]

ALLOWED_ATTRIBUTES = {
    '*': ['class', 'id'],
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'td': ['align'],
    'th': ['align'],
    'ol': ['start'],
    'code': ['class'],  # 代码高亮需要class
    'pre': ['class'],
    'div': ['class'],
    'span': ['class'],
}

ALLOWED_PROTOCOLS = ['http', 'https', 'mailto', 'ftp']


def sanitize_html(html_content):
    """清洗HTML内容，防止XSS攻击"""
    return bleach.clean(
        html_content,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=ALLOWED_PROTOCOLS,
        strip=False
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

    # Relationship to Tags
    tags_list = db.relationship('Tag', secondary=note_tags, lazy='subquery',
        backref=db.backref('notes', lazy=True))

    def to_dict(self):
        return {
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
            'deleted_at': self.deleted_at.strftime('%Y-%m-%d %H:%M:%S') if self.deleted_at else None
        }

    def get_excerpt(self, max_length=150):
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
            # 渲染Markdown
            html = markdown.markdown(text, extensions=['fenced_code', 'tables', 'toc'])
            # XSS清洗
            html = sanitize_html(html)
        except:
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
        conf = db.session.get(Config, key)
        if not conf:
            conf = Config(key=key, value=value, description=description)
            db.session.add(conf)
        else:
            conf.value = value
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
