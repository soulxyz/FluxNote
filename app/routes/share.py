from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user
from app.extensions import db
from app.models import Note, Share, ShareAttempt, Config
from app.utils.error_handler import safe_error
from datetime import datetime, timedelta
import secrets
import string

share_bp = Blueprint('share', __name__)


def generate_share_id():
    """生成安全的随机分享ID（使用secrets模块）"""
    # 使用secrets模块生成加密安全的随机ID
    # 8位字符约62^8 ≈ 2^47种组合，配合安全随机足够防止枚举
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(8))


def get_base_url():
    """获取应用基础URL"""
    # 尝试从配置获取
    base_url = Config.get('base_url')
    if base_url:
        return base_url.rstrip('/')

    # 从请求中构建完整 URL
    if request:
        scheme = request.scheme
        host = request.host
        return f"{scheme}://{host}"

    return ''


@share_bp.route('/share', methods=['POST'])
@login_required
def create_share():
    """创建分享链接"""
    data = request.json
    note_id = data.get('note_id')
    password = data.get('password', '').strip()
    expires_in = data.get('expires_in')  # 小时数: None=永久, 24=1天, 168=7天, 720=30天

    if not note_id:
        return jsonify({'error': '缺少笔记ID'}), 400

    # 验证笔记归属
    note = db.session.get(Note, note_id)
    if not note:
        return jsonify({'error': '笔记不存在'}), 404

    if note.user_id != current_user.id:
        return jsonify({'error': '无权分享此笔记'}), 403

    # 检查是否已有相同的有效分享（可选：避免重复创建）
    # 这里选择每次都创建新分享

    # 创建分享
    share = Share(
        id=generate_share_id(),
        note_id=note_id
    )

    # 设置密码
    if password:
        share.set_password(password)

    # 设置过期时间
    if expires_in:
        try:
            hours = int(expires_in)
            share.expires_at = datetime.now() + timedelta(hours=hours)
        except ValueError:
            pass

    db.session.add(share)
    db.session.commit()

    # 构建分享链接
    base_url = get_base_url()
    share_url = f"{base_url}/s/{share.id}" if base_url else f"/s/{share.id}"

    return jsonify({
        'success': True,
        'share': {
            **share.to_dict(),
            'url': share_url
        }
    })


@share_bp.route('/share/<share_id>', methods=['GET'])
def get_share(share_id):
    """获取分享信息（公开访问）"""
    share = db.session.get(Share, share_id)

    if not share:
        return jsonify({'error': '分享链接不存在'}), 404

    if share.is_expired():
        return jsonify({'error': '分享链接已过期', 'expired': True}), 410

    # 返回基本信息（不包含内容）
    return jsonify({
        'has_password': bool(share.password),
        'expires_at': share.expires_at.strftime('%Y-%m-%d %H:%M:%S') if share.expires_at else None,
        'is_expired': share.is_expired()
    })


@share_bp.route('/share/<share_id>/verify', methods=['POST'])
def verify_share(share_id):
    """验证密码并获取分享内容"""
    share = db.session.get(Share, share_id)

    if not share:
        return jsonify({'error': '分享链接不存在'}), 404

    if share.is_expired():
        return jsonify({'error': '分享链接已过期', 'expired': True}), 410

    # 获取客户端IP
    ip_address = request.remote_addr
    if request.headers.get('X-Forwarded-For'):
        # 代理情况下获取真实IP
        ip_address = request.headers.get('X-Forwarded-For').split(',')[0].strip()

    # 检查IP是否被锁定
    attempt_record = ShareAttempt.get_or_create(share_id, ip_address)
    if attempt_record.is_locked():
        remaining = attempt_record.get_remaining_lock_minutes()
        return jsonify({
            'error': f'密码错误次数过多，请 {remaining} 分钟后再试',
            'locked': True,
            'remaining_minutes': remaining
        }), 429

    # 验证密码
    if share.password:
        password = request.json.get('password', '')
        if not share.check_password(password):
            # 记录失败尝试（基于IP）
            attempt_record.record_failed_attempt()

            remaining_attempts = attempt_record.get_remaining_attempts()
            if remaining_attempts > 0:
                return jsonify({
                    'error': f'密码错误，还剩 {remaining_attempts} 次尝试机会',
                    'remaining_attempts': remaining_attempts
                }), 403
            else:
                return jsonify({
                    'error': '密码错误次数过多，已被锁定30分钟',
                    'locked': True
                }), 429

        # 密码正确，重置该IP的失败计数
        attempt_record.reset()

    # 增加访问计数
    share.view_count += 1
    db.session.commit()

    # 返回笔记内容
    note = share.note
    return jsonify({
        'success': True,
        'note': note.to_dict()
    })


@share_bp.route('/share/<share_id>', methods=['DELETE'])
@login_required
def delete_share(share_id):
    """删除分享链接"""
    share_id = share_id.strip()
    share = db.session.get(Share, share_id)

    if not share:
        return jsonify({'error': '分享链接不存在'}), 404

    # 验证归属
    if share.note.user_id != current_user.id:
        return jsonify({'error': '无权删除此分享'}), 403

    db.session.delete(share)
    db.session.commit()

    return jsonify({'success': True})


@share_bp.route('/share/<share_id>', methods=['PUT'])
@login_required
def update_share(share_id):
    """更新分享设置"""
    share = db.session.get(Share, share_id)

    if not share:
        return jsonify({'error': '分享链接不存在'}), 404

    # 验证归属
    if share.note.user_id != current_user.id:
        return jsonify({'error': '无权修改此分享'}), 403

    data = request.json

    # 立即过期
    if data.get('expire_now'):
        share.expires_at = datetime.now() - timedelta(seconds=1)
        db.session.commit()
        return jsonify({
            'success': True,
            'share': share.to_dict()
        })

    # 更新密码
    password = data.get('password')
    if password is not None:
        if password.strip():
            share.set_password(password.strip())
        else:
            share.password = None

    # 更新过期时间
    expires_in = data.get('expires_in')
    if expires_in is not None:
        if expires_in:
            try:
                hours = int(expires_in)
                share.expires_at = datetime.now() + timedelta(hours=hours)
            except ValueError:
                return jsonify({'error': '无效的过期时间'}), 400
        else:
            share.expires_at = None

    db.session.commit()

    return jsonify({
        'success': True,
        'share': share.to_dict()
    })


@share_bp.route('/notes/<note_id>/shares', methods=['GET'])
@login_required
def get_note_shares(note_id):
    """获取笔记的所有分享"""
    note = db.session.get(Note, note_id)

    if not note:
        return jsonify({'error': '笔记不存在'}), 404

    if note.user_id != current_user.id:
        return jsonify({'error': '无权查看'}), 403

    shares = Share.query.filter_by(note_id=note_id).order_by(Share.created_at.desc()).all()

    base_url = get_base_url()
    shares_data = []
    for s in shares:
        share_dict = s.to_dict()
        share_dict['url'] = f"{base_url}/s/{s.id}" if base_url else f"/s/{s.id}"
        shares_data.append(share_dict)

    return jsonify(shares_data)


@share_bp.route('/shares', methods=['GET'])
@login_required
def get_user_shares():
    """获取当前用户的所有分享"""
    # 查询当前用户所有笔记的分享
    # 由于 Share 模型没有直接关联 user，需要通过 Note 关联
    shares = db.session.query(Share).join(Note).filter(Note.user_id == current_user.id).order_by(Share.created_at.desc()).all()

    base_url = get_base_url()
    shares_data = []
    for s in shares:
        share_dict = s.to_dict()
        share_dict['url'] = f"{base_url}/s/{s.id}" if base_url else f"/s/{s.id}"
        # 添加笔记标题方便展示
        share_dict['note_title'] = s.note.title if s.note.title else f"无标题笔记 ({s.note.created_at.strftime('%Y-%m-%d')})"
        shares_data.append(share_dict)

    return jsonify(shares_data)
