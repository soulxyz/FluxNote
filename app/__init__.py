from flask import Flask, send_from_directory, jsonify, render_template
from .extensions import db, login_manager, cors, migrate, compress
from .models import User, Config
from .routes.auth import auth_bp
from .routes.notes import notes_bp
from .routes.main import main_bp
from .routes.settings import settings_bp
from .routes.ai import ai_bp
from .routes.stats import stats_bp
from .routes.auth_webauthn import webauthn_bp
from .routes.share import share_bp
from .routes.blog import blog_bp
from .routes.comment import comment_bp
import os
from sqlalchemy import text, inspect
import traceback

# 应用版本号 - 每次部署更新时递增此版本号以清除客户端缓存
APP_VERSION = '1.0.8'


def is_debug_mode():
    """检查是否开启调试模式"""
    try:
        return Config.get('debug_mode', 'false').lower() == 'true'
    except:
        return False


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

    # 默认关闭调试模式，稍后根据数据库配置更新
    app.config['DEBUG'] = False
    # 禁止异常传播，防止显示详细错误
    app.config['PROPAGATE_EXCEPTIONS'] = False
    # 隐藏服务器信息
    app.config['SERVER_NAME'] = None

    # Initialize Extensions
    db.init_app(app)
    migrate.init_app(app, db)
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'
    cors.init_app(app)
    compress.init_app(app)

    @login_manager.user_loader
    def load_user(user_id):
        return db.session.get(User, user_id)

    # Register Blueprints
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(notes_bp, url_prefix='/api')
    app.register_blueprint(webauthn_bp, url_prefix='/api/auth')
    app.register_blueprint(settings_bp)
    app.register_blueprint(ai_bp, url_prefix='/api')
    app.register_blueprint(stats_bp)
    app.register_blueprint(main_bp)
    app.register_blueprint(share_bp, url_prefix='/api')  # 分享功能
    app.register_blueprint(blog_bp)  # 博客功能
    app.register_blueprint(comment_bp, url_prefix='/api') # 评论功能

    # Register Upload Route (Global)
    @app.route('/uploads/<filename>')
    def uploaded_file(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    # Service Worker Route - Dynamically inject version and debug flag
    @app.route('/static/sw.js')
    def service_worker():
        sw_path = os.path.join(app.root_path, 'static', 'sw.js')
        try:
            with open(sw_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Inject current version into SW
            import re
            content = re.sub(r"const CACHE_VERSION = ['\"]DEV['\"];", f"const CACHE_VERSION = '{APP_VERSION}';", content)
            
            # Inject Debug Flag
            is_debug = 'true' if is_debug_mode() else 'false'
            content = re.sub(r"const IS_DEBUG = (true|false);", f"const IS_DEBUG = {is_debug};", content)
            
            response = app.response_class(content, mimetype='application/javascript')
            response.headers['Service-Worker-Allowed'] = '/'
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            return response
        except Exception as e:
            # Log error and return a safe response (not HTML)
            print(f"Error loading SW: {str(e)}")
            return "console.error('Service Worker load failed');", 500, {'Content-Type': 'application/javascript'}

    # 注入全局模板变量
    @app.context_processor
    def inject_version():
        return dict(app_version=APP_VERSION)

    # ===== Global Error Handlers =====
    # 防止在生产环境中泄露敏感错误信息

    @app.errorhandler(404)
    def not_found_error(error):
        # 判断是否是 API 请求
        if hasattr(error, 'description') and '/api/' in getattr(error, 'description', ''):
            return jsonify({'code': 404, 'message': '资源不存在'}), 404
        try:
            return render_template('error.html', error_code=404, error_message='页面不存在'), 404
        except:
            return '<h1>404 - 页面不存在</h1>', 404

    @app.errorhandler(500)
    def internal_error(error):
        db.session.rollback()
        debug = is_debug_mode()
        if debug:
            # 调试模式：显示详细错误
            print(f"[Error 500] {type(error).__name__}: {str(error)}")
            traceback.print_exc()
            return jsonify({
                'code': 500,
                'message': str(error),
                'error_type': type(error).__name__
            }), 500
        return jsonify({'code': 500, 'message': '服务器内部错误'}), 500

    @app.errorhandler(Exception)
    def handle_exception(error):
        """捕获所有未处理的异常"""
        debug = is_debug_mode()

        # 记录错误日志
        print(f"[Unhandled Exception] {type(error).__name__}: {str(error)}")
        if debug:
            traceback.print_exc()

        db.session.rollback()

        if debug:
            # 调试模式：返回详细错误
            return jsonify({
                'code': 500,
                'message': str(error),
                'error_type': type(error).__name__,
                'traceback': traceback.format_exc()
            }), 500

        # 生产模式：返回通用错误
        return jsonify({'code': 500, 'message': '服务器内部错误'}), 500

    # Initialize DB logic
    with app.app_context():
        db.create_all()
        # 根据数据库配置更新调试模式
        app.config['DEBUG'] = is_debug_mode()

    return app
