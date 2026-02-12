from .extensions import db
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
import json
import uuid

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

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class NoteReference(db.Model):
    __tablename__ = 'note_reference'
    source_id = db.Column(db.String(36), db.ForeignKey('note.id'), primary_key=True)
    target_title = db.Column(db.String(255), primary_key=True, index=True) # Indexed for fast lookup
    
    # Relationship
    source_note = db.relationship('Note', backref=db.backref('outgoing_references', cascade='all, delete-orphan'))

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
    links = db.Column(db.Text, default='[]') # Storing outgoing links as JSON string
    # tags column is kept for backward compatibility/migration but deprecated in favor of relationship
    tags = db.Column(db.Text, default='[]')

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
            'links': json.loads(self.links) if self.links else [],
            'tags': [tag.name for tag in self.tags_list], # Use the relationship now
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': self.updated_at.strftime('%Y-%m-%d %H:%M:%S'),
            'user_id': self.user_id,
            'is_public': self.is_public,
            'is_deleted': self.is_deleted,
            'deleted_at': self.deleted_at.strftime('%Y-%m-%d %H:%M:%S') if self.deleted_at else None
        }

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
