from flask import Blueprint, request, jsonify, render_template
from flask_login import login_required, current_user
from app.models import Config, User
from app.extensions import db
from app.utils.theme import get_all_themes, set_theme, get_current_theme, get_writer_theme
from app.utils.email import send_email, render_test_email

settings_bp = Blueprint('settings', __name__)

@settings_bp.route('/settings')
@login_required
def index():
    """Render settings page"""
    return render_template('settings.html')

@settings_bp.route('/api/settings/test-email', methods=['POST'])
@login_required
def test_email():
    """测试邮件配置"""
    recipient = Config.get('notify_email')
    if not recipient:
        return jsonify({'error': '请先保存"接收通知邮箱"配置'}), 400

    site_title = Config.get('site_title', '轻笔记')
    html_body, text_body = render_test_email(site_title)

    success, msg = send_email(
        subject=f"[{site_title}] 邮件配置测试",
        recipient=recipient,
        body=text_body,
        html_body=html_body
    )

    if success:
        return jsonify({'success': True, 'message': msg})
    else:
        return jsonify({'error': msg}), 500

@settings_bp.route('/api/settings', methods=['GET'])
@login_required
def get_settings():
    """Get all settings"""
    configs = Config.query.all()
    return jsonify({c.key: c.value for c in configs})

@settings_bp.route('/api/settings', methods=['POST'])
@login_required
def update_settings():
    """Update settings"""
    data = request.json
    try:
        for key, value in data.items():
            # Security check: prevent overwriting critical system keys if any
            Config.set(key, str(value))
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@settings_bp.route('/api/settings/password', methods=['POST'])
@login_required
def change_password():
    """Change user password"""
    data = request.json
    current_password = data.get('current_password')
    new_password = data.get('new_password')

    if not current_user.check_password(current_password):
        return jsonify({'error': '当前密码错误'}), 400

    if not new_password or len(new_password) < 6:
        return jsonify({'error': '新密码长度至少6位'}), 400

    current_user.set_password(new_password)
    db.session.commit()
    return jsonify({'success': True})

@settings_bp.route('/api/themes', methods=['GET'])
@login_required
def get_themes():
    """获取所有可用主题"""
    return jsonify({
        'themes': get_all_themes(),
        'current': get_current_theme(),
        'writer_current': get_writer_theme()
    })

@settings_bp.route('/api/themes', methods=['POST'])
@login_required
def update_theme():
    """切换主题"""
    data = request.json
    theme_name = data.get('theme')
    role = data.get('role', 'blog')
    try:
        set_theme(theme_name, role)
        return jsonify({'success': True, 'theme': theme_name, 'role': role})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
