from flask import Blueprint, request, jsonify, render_template
from flask_login import login_required, current_user
from app.models import Config, User
from app.extensions import db

settings_bp = Blueprint('settings', __name__)

@settings_bp.route('/settings')
@login_required
def index():
    """Render settings page"""
    return render_template('settings.html')

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
