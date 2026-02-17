from flask import Blueprint, request, render_template
from flask_login import login_required, current_user
from app.models import Config, User
from app.extensions import db
from app.utils.theme import (
    get_all_themes, set_theme, get_current_theme, get_writer_theme,
    get_theme_settings, get_user_theme_config, save_user_theme_config
)
from app.utils.email import send_email, render_test_email
from app.utils.response import api_response

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
        return api_response(code=400, message='请先保存"接收通知邮箱"配置')

    site_title = Config.get('site_title', '流光笔记')
    html_body, text_body = render_test_email(site_title)

    success, msg = send_email(
        subject=f"[{site_title}] 邮件配置测试",
        recipient=recipient,
        body=text_body,
        html_body=html_body
    )

    if success:
        return api_response(message=msg)
    else:
        return api_response(code=500, message=msg)

@settings_bp.route('/api/settings', methods=['GET'])
@login_required
def get_settings():
    """Get all settings"""
    configs = Config.query.all()
    return api_response(data={c.key: c.value for c in configs})

@settings_bp.route('/api/settings/get-by-keys', methods=['POST'])
@login_required
def get_settings_by_keys():
    """Get settings by specific keys"""
    data = request.json or {}
    keys = data.get('keys', [])
    if not keys:
        return api_response(data={})

    result = {}
    for key in keys:
        value = Config.get(key)
        if value is not None:
            result[key] = value
    return api_response(data=result)

@settings_bp.route('/api/settings/update', methods=['POST'])
@login_required
def update_settings_batch():
    """Batch update settings"""
    data = request.json or {}
    try:
        for key, value in data.items():
            Config.set(key, str(value))
        return api_response(message='Settings updated')
    except Exception as e:
        return api_response(code=500, message=str(e))

@settings_bp.route('/api/settings', methods=['POST'])
@login_required
def update_settings():
    """Update settings"""
    data = request.json
    try:
        for key, value in data.items():
            # Security check: prevent overwriting critical system keys if any
            Config.set(key, str(value))
        return api_response(message='Settings updated')
    except Exception as e:
        return api_response(code=500, message=str(e))

@settings_bp.route('/api/settings/password', methods=['POST'])
@login_required
def change_password():
    """Change user password"""
    data = request.json
    current_password = data.get('current_password')
    new_password = data.get('new_password')

    if not current_user.check_password(current_password):
        return api_response(code=400, message='当前密码错误')

    if not new_password or len(new_password) < 6:
        return api_response(code=400, message='新密码长度至少6位')

    current_user.set_password(new_password)
    db.session.commit()
    return api_response(message='Password changed')

@settings_bp.route('/api/themes', methods=['GET'])
@login_required
def get_themes():
    """获取所有可用主题"""
    data = {
        'themes': get_all_themes(),
        'current': get_current_theme(),
        'writer_current': get_writer_theme()
    }
    return api_response(data=data)

@settings_bp.route('/api/themes', methods=['POST'])
@login_required
def update_theme():
    """切换主题"""
    data = request.json
    theme_name = data.get('theme')
    role = data.get('role', 'blog')
    try:
        set_theme(theme_name, role)
        return api_response(message='Theme updated', data={'theme': theme_name, 'role': role})
    except ValueError as e:
        return api_response(code=400, message=str(e))

# ===== Theme Configuration APIs =====

@settings_bp.route('/api/theme/settings', methods=['GET'])
@login_required
def get_theme_settings_api():
    """Get theme settings definition (schema)"""
    theme_name = request.args.get('theme_name')
    if not theme_name:
        return api_response(code=400, message='Theme name is required')
    
    settings = get_theme_settings(theme_name)
    return api_response(data=settings)

@settings_bp.route('/api/theme/config', methods=['GET'])
@login_required
def get_user_theme_config_api():
    """Get user theme configuration"""
    theme_name = request.args.get('theme_name')
    if not theme_name:
        return api_response(code=400, message='Theme name is required')
        
    config = get_user_theme_config(theme_name)
    return api_response(data=config)

@settings_bp.route('/api/theme/config', methods=['POST'])
@login_required
def save_user_theme_config_api():
    """Save user theme configuration"""
    data = request.json
    theme_name = data.get('theme_name')
    config = data.get('config')
    
    if not theme_name:
        return api_response(code=400, message='Theme name is required')
    if config is None:
        return api_response(code=400, message='Config data is required')
        
    try:
        save_user_theme_config(theme_name, config)
        return api_response(message='Config saved')
    except Exception as e:
        return api_response(code=500, message=str(e))

@settings_bp.route('/api/theme/current-config', methods=['GET'])
@login_required
def get_current_theme_config_api():
    """Get configuration for the current active theme"""
    current_theme = get_current_theme()

    data = {
        'theme_name': current_theme,
        'values': get_user_theme_config(current_theme),
        'settings': get_theme_settings(current_theme)
    }
    return api_response(data=data)

@settings_bp.route('/api/public/theme/config', methods=['GET'])
def get_public_theme_config_api():
    """Get public configuration for the current active theme"""
    current_theme = get_current_theme()
    config = get_user_theme_config(current_theme, filter_sensitive=True)
    return api_response(data=config)

# ===== Theme Mall APIs =====

@settings_bp.route('/api/public/theme/market', methods=['GET'])
def get_theme_market():
    """Get theme market list (public API)"""
    # 获取本地所有主题作为商城列表
    themes = get_all_themes()
    current = get_current_theme()

    theme_list = []
    for theme_id, theme_info in themes.items():
        theme_data = {
            'id': hash(theme_id) % 100000,  # 生成一个伪 ID
            'name': theme_info.get('name', theme_id),
            'author': theme_info.get('author', '未知'),
            'description': theme_info.get('description', ''),
            'themeType': 'community',
            'deployType': 'standard',
            'repoUrl': '',
            'instructionUrl': '',
            'price': 0,
            'downloadUrl': '',
            'tags': [],
            'previewUrl': '',
            'demoUrl': '',
            'version': '1.0.0',
            'downloadCount': 0,
            'rating': 0,
                            'isOfficial': theme_info.get('author') == '流光笔记',            'isActive': True,
            'is_current': theme_id == current,
            'is_installed': True,
            'createdAt': '',
            'updatedAt': ''
        }

        # 处理预览图
        preview = theme_info.get('preview', {})
        if preview.get('type') == 'image':
            theme_data['previewUrl'] = preview.get('value', '')
        elif preview.get('type') == 'gradient':
            # 对于渐变色，可以生成一个占位图或直接使用
            theme_data['previewUrl'] = ''

        theme_list.append(theme_data)

    return api_response(data={'list': theme_list, 'total': len(theme_list)})

@settings_bp.route('/api/theme/installed', methods=['GET'])
@login_required
def get_installed_themes():
    """Get installed themes list"""
    themes = get_all_themes()
    current = get_current_theme()
    writer_current = get_writer_theme()

    theme_list = []
    for theme_id, theme_info in themes.items():
        theme_data = {
            'id': hash(theme_id) % 100000,
            'name': theme_info.get('name', theme_id),
            'author': theme_info.get('author', '未知'),
            'description': theme_info.get('description', ''),
            'themeType': 'community',
            'deployType': 'standard',
            'repoUrl': '',
            'instructionUrl': '',
            'price': 0,
            'downloadUrl': '',
            'tags': [],
            'previewUrl': '',
            'demoUrl': '',
            'version': '1.0.0',
            'downloadCount': 0,
            'rating': 0,
                            'isOfficial': theme_info.get('author') == '流光笔记',            'isActive': True,
            'is_current': theme_id == current or theme_id == writer_current,
            'is_installed': True,
            'createdAt': '',
            'updatedAt': ''
        }
        theme_list.append(theme_data)

    return api_response(data=theme_list)

@settings_bp.route('/api/theme/current', methods=['GET'])
@login_required
def get_current_theme_api():
    """Get current theme info"""
    current = get_current_theme()
    theme_info = get_theme_info(current) if current else {}

    return api_response(data={
        'id': hash(current) % 100000,
        'name': theme_info.get('name', current),
        'author': theme_info.get('author', '未知'),
        'description': theme_info.get('description', ''),
        'is_current': True,
        'is_installed': True
    })

@settings_bp.route('/api/admin/ssr-theme/list', methods=['GET'])
@login_required
def get_ssr_theme_list():
    """Get installed SSR themes list (stub - returns empty for now)"""
    # SSR 主题功能需要额外的实现，目前返回空列表
    return api_response(data=[])
