from flask import Flask, send_from_directory, jsonify, render_template, request, redirect, url_for
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
from .routes.update import update_bp, start_background_update_checker
from .utils.version import get_static_hash
import os
import logging
from sqlalchemy import text, inspect
import traceback

logger = logging.getLogger(__name__)

# 全局静态版本哈希生成逻辑，替代原有的硬编码 APP_VERSION
# APP_VERSION = '1.0.8'  <- 移除硬编码

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

    @login_manager.unauthorized_handler
    def unauthorized():
        # API 统一返回 401 JSON，便于前端稳定区分“会话失效”和“网络失败”。
        if request.path.startswith('/api/'):
            return jsonify({'code': 401, 'error': '未登录或会话已失效'}), 401
        return redirect(url_for('main.login_page', next=request.url))

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
    app.register_blueprint(update_bp)  # 系统更新

    # Register Upload Route (Global)
    @app.route('/uploads/<filename>')
    def uploaded_file(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    # 注入全局模板变量，使用动态生成的哈希值作为版本号
    @app.context_processor
    def inject_version():
        from .utils.version import get_static_manifest, get_static_hash, get_app_version
        manifest = get_static_manifest()
        
        def static_v(filename):
            path = f"/static/{filename}"
            v = manifest.get(path, get_static_hash())
            return f"/static/{filename}?v={v}"
            
        return dict(
            app_version=get_static_hash(),
            app_semver=get_app_version(),
            static_v=static_v
        )

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
        # 一站式自愈与诊断 (自动同步数据库、检测路由冲突等)
        from .utils.health import run_self_check
        run_self_check(app)
        # 根据数据库配置更新调试模式
        app.config['DEBUG'] = is_debug_mode()

    # 启动后台更新检查线程（非阻塞，守护线程）
    start_background_update_checker(app)

    return app
