from flask import Flask, send_from_directory
from .extensions import db, login_manager, cors
from .models import User
from .routes.auth import auth_bp
from .routes.notes import notes_bp
from .routes.main import main_bp
from .routes.settings import settings_bp
from .routes.ai import ai_bp
from .routes.stats import stats_bp
import os
from sqlalchemy import text, inspect

def create_app():
    app = Flask(__name__)

    # Configuration
    app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-key-change-this')

    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    DB_DIR = os.path.join(BASE_DIR, 'data')
    os.makedirs(DB_DIR, exist_ok=True)

    UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)

    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(DB_DIR, 'notes.db')
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

    # Initialize Extensions
    db.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    cors.init_app(app)

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, user_id)

    # Register Blueprints
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(notes_bp, url_prefix='/api')
    app.register_blueprint(settings_bp)
    app.register_blueprint(ai_bp, url_prefix='/api')
    app.register_blueprint(stats_bp)
    app.register_blueprint(main_bp)

    # Register Upload Route (Global)
    # Since we removed it from notes_bp to avoid /api/uploads prefix issue if not desired,
    # or if we kept it in notes_bp but mapped to /api, it would be /api/uploads/filename.
    # The frontend expects /uploads/filename.
    # Let's add the route manually here or in main_bp.
    # Adding here for clarity of static serving.
    @app.route('/uploads/<filename>')
    def uploaded_file(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    # Initialize DB logic
    with app.app_context():
        db.create_all()
        check_and_migrate_db(app)

    return app

def check_and_migrate_db(app):
    try:
        inspector = inspect(db.engine)
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
