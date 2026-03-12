from flask import Blueprint, request, jsonify
from flask_login import login_user, logout_user, login_required, current_user
from app.extensions import db
from app.models import User

auth_bp = Blueprint('auth', __name__)

@auth_bp.route('/can-register', methods=['GET'])
def can_register():
    """检查是否允许注册（系统中无用户时才允许）"""
    user_count = User.query.count()
    return jsonify({
        'can_register': user_count == 0,
        'user_count': user_count
    })

@auth_bp.route('/register', methods=['POST'])
def register():
    # 检查是否已有用户存在
    user_count = User.query.count()
    if user_count > 0:
        return jsonify({'error': '系统已注册，不允许新用户注册'}), 403

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

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')

    user = User.query.filter_by(username=username).first()
    if user and user.check_password(password):
        # 懒加载密码哈希迁移：检查是否使用当前首选方案
        # Werkzeug 2.3+ 默认使用 scrypt
        if not user.password_hash.startswith('scrypt:'):
            # 使用当前首选算法重新生成哈希
            user.set_password(password)
            db.session.commit()
        
        login_user(user)
        return jsonify({'message': '登录成功', 'user': {'id': user.id, 'username': user.username}})

    return jsonify({'error': '用户名或密码错误'}), 401

@auth_bp.route('/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'message': '已退出登录'})

@auth_bp.route('/status', methods=['GET'])
def auth_status():
    if current_user.is_authenticated:
        return jsonify({'is_authenticated': True, 'user': {'id': current_user.id, 'username': current_user.username}})
    return jsonify({'is_authenticated': False})
