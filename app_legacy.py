from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from datetime import datetime
import os
import json
import uuid
import re
from sqlalchemy import text, inspect

app = Flask(__name__)
app.secret_key = 'your-secret-key-change-this-in-production'  # Required for session
CORS(app)

# Database Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.path.join(BASE_DIR, 'data')
os.makedirs(DB_DIR, exist_ok=True)

# Upload Configuration
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(DB_DIR, 'notes.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max limit

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, user_id)

# Model Definition
class User(UserMixin, db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(120), nullable=False)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class Note(db.Model):
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    content = db.Column(db.Text, nullable=False)
    title = db.Column(db.String(255), default='')
    links = db.Column(db.Text, default='[]') # Storing outgoing links as JSON string
    tags = db.Column(db.Text, default='[]') # Storing tags as JSON string
    created_at = db.Column(db.DateTime, default=datetime.now)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)
    user_id = db.Column(db.String(36), db.ForeignKey('user.id'), nullable=True) # Nullable for existing notes
    is_public = db.Column(db.Boolean, default=False)

    def to_dict(self):
        return {
            'id': self.id,
            'content': self.content,
            'title': self.title,
            'links': json.loads(self.links) if self.links else [],
            'tags': json.loads(self.tags),
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'updated_at': self.updated_at.strftime('%Y-%m-%d %H:%M:%S'),
            'user_id': self.user_id,
            'is_public': self.is_public
        }

def check_and_migrate_db():
    try:
        inspector = inspect(db.engine)
        # Check if table exists first to avoid errors on fresh init
        if not inspector.has_table('note'):
            return

        columns = [c['name'] for c in inspector.get_columns('note')]

        with db.engine.connect() as conn:
            if 'title' not in columns:
                print("Migrating: Adding title column")
                conn.execute(text('ALTER TABLE note ADD COLUMN title VARCHAR(255) DEFAULT ""'))

            if 'links' not in columns:
                print("Migrating: Adding links column")
                conn.execute(text('ALTER TABLE note ADD COLUMN links TEXT DEFAULT "[]"'))

            conn.commit()
    except Exception as e:
        print(f"Migration warning: {e}")

def extract_title_and_links(content):
    if not content:
        return "Untitled", []

    lines = content.split('\n')
    title = lines[0].strip()
    # Remove markdown header characters
    title = re.sub(r'^#+\s+', '', title)
    if not title:
        title = "Untitled"
    if len(title) > 200:
        title = title[:200]

    # Extract links [[...]]
    links = re.findall(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', content)
    # Remove duplicates
    links = sorted(list(set([l.strip() for l in links if l.strip()])))

    return title, links

# Initialize DB
with app.app_context():
    db.create_all()
    check_and_migrate_db()

@app.route('/')
def index():
    """Home Page"""
    return render_template('index.html')

# Auth Routes
@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': '用户名和密码不能为空'}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({'error': '用户名已存在'}), 400

    user = User(username=username)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    login_user(user)
    return jsonify({'message': '注册成功', 'user': {'id': user.id, 'username': user.username}})

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')

    user = User.query.filter_by(username=username).first()
    if user and user.check_password(password):
        login_user(user)
        return jsonify({'message': '登录成功', 'user': {'id': user.id, 'username': user.username}})

    return jsonify({'error': '用户名或密码错误'}), 401

@app.route('/api/auth/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'message': '已退出登录'})

@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    if current_user.is_authenticated:
        return jsonify({'is_authenticated': True, 'user': {'id': current_user.id, 'username': current_user.username}})
    return jsonify({'is_authenticated': False})

@app.route('/api/notes', methods=['GET'])
def get_notes():
    """Get notes with pagination"""
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 10, type=int)

        query = Note.query

        if current_user.is_authenticated:
            # Show public notes AND user's own notes
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            # Show only public notes
            query = query.filter(Note.is_public == True)

        # Pagination
        pagination = query.order_by(Note.created_at.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )

        return jsonify({
            'notes': [note.to_dict() for note in pagination.items],
            'total': pagination.total,
            'pages': pagination.pages,
            'current_page': page,
            'has_next': pagination.has_next
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/notes/titles', methods=['GET'])
def get_note_titles():
    """Get list of titles for autocomplete"""
    try:
        query = Note.query
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        notes = query.with_entities(Note.id, Note.title).all()
        return jsonify([{'id': n.id, 'title': n.title} for n in notes])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/notes/<note_id>/backlinks', methods=['GET'])
def get_backlinks(note_id):
    """Get backlinks for a note"""
    try:
        target_note = db.session.get(Note, note_id)
        if not target_note:
            return jsonify({'error': 'Note not found'}), 404

        target_title = target_note.title
        if not target_title:
             return jsonify([])

        query = Note.query
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        query = query.filter(Note.links != '[]')

        candidates = query.all()
        backlinks = []

        for note in candidates:
            try:
                note_links = json.loads(note.links)
                if target_title in note_links:
                    backlinks.append({
                        'id': note.id,
                        'title': note.title,
                        'updated_at': note.updated_at.strftime('%Y-%m-%d %H:%M:%S')
                    })
            except:
                continue

        return jsonify(backlinks)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # Generate unique filename to prevent overwrites
        unique_filename = f"{uuid.uuid4().hex}_{filename}"
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], unique_filename))
        return jsonify({'url': f'/uploads/{unique_filename}'}), 201
    return jsonify({'error': 'File type not allowed'}), 400

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/api/notes', methods=['POST'])
@login_required
def create_note():
    """Create a new note"""
    try:
        data = request.json
        content = data.get('content', '').strip()
        tags = data.get('tags', [])
        is_public = data.get('is_public', False)

        if not content:
            return jsonify({'error': '内容不能为空'}), 400

        title, links = extract_title_and_links(content)

        new_note = Note(
            content=content,
            title=title,
            links=json.dumps(links, ensure_ascii=False),
            tags=json.dumps(tags, ensure_ascii=False),
            user_id=current_user.id,
            is_public=is_public
        )
        db.session.add(new_note)
        db.session.commit()

        return jsonify(new_note.to_dict()), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/api/notes/<note_id>', methods=['PUT'])
@login_required
def update_note(note_id):
    """Update a note"""
    try:
        data = request.json
        content = data.get('content', '').strip()
        tags = data.get('tags', [])
        is_public = data.get('is_public', False)

        if not content:
            return jsonify({'error': '内容不能为空'}), 400

        note = db.session.get(Note, note_id)
        if not note:
            return jsonify({'error': '笔记不存在'}), 404

        if note.user_id != current_user.id:
            return jsonify({'error': '无权修改此笔记'}), 403

        title, links = extract_title_and_links(content)

        note.content = content
        note.title = title
        note.links = json.dumps(links, ensure_ascii=False)
        note.tags = json.dumps(tags, ensure_ascii=False)
        note.is_public = is_public
        note.updated_at = datetime.now()

        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/api/notes/<note_id>', methods=['DELETE'])
@login_required
def delete_note(note_id):
    """Delete a note"""
    try:
        note = db.session.get(Note, note_id)
        if note:
            if note.user_id != current_user.id:
                return jsonify({'error': '无权删除此笔记'}), 403
            db.session.delete(note)
            db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/api/notes/search', methods=['GET'])
def search_notes():
    """Search notes"""
    try:
        keyword = request.args.get('keyword', '').strip()
        tag = request.args.get('tag', '').strip()

        if not keyword and not tag:
            # If no search params, return standard list (which handles auth)
            return get_notes()

        query = Note.query

        # Apply Auth Filters
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        if keyword:
            query = query.filter(Note.content.contains(keyword))

        # Initial filter by tag string existence to reduce set
        if tag:
            query = query.filter(Note.tags.contains(tag))

        results = query.order_by(Note.created_at.desc()).all()

        # Strict filtering for tags in Python
        final_results = []
        for note in results:
            include = True
            if tag:
                note_tags = json.loads(note.tags)
                # Case insensitive matching for tags
                if tag.lower() not in [t.lower() for t in note_tags]:
                    include = False

            if include:
                final_results.append(note.to_dict())

        return jsonify(final_results)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/tags', methods=['GET'])
def get_tags():
    """Get all unique tags from visible notes"""
    try:
        query = Note.query
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        notes = query.all()
        tags = set()
        for note in notes:
            note_tags = json.loads(note.tags)
            for t in note_tags:
                tags.add(t)
        return jsonify(sorted(list(tags)))
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
