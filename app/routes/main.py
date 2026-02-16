from flask import Blueprint, render_template
from app.extensions import db
from app.models import Share, Config

main_bp = Blueprint('main', __name__)

@main_bp.route('/')
def index():
    """Home Page"""
    return render_template('index.html')


@main_bp.route('/s/<share_id>')
def share_page(share_id):
    """分享页面（HTML）"""
    share = db.session.get(Share, share_id)

    # 获取站点信息
    site_title = Config.get('site_title', '轻笔记')
    site_desc = Config.get('site_desc', '记录思维的碎片')

    if not share:
        return render_template('share.html',
            error='分享链接不存在',
            site_title=site_title,
            site_desc=site_desc)

    if share.is_expired():
        return render_template('share.html',
            error='分享链接已过期',
            site_title=site_title,
            site_desc=site_desc)

    # 如果有密码，显示密码输入页面
    if share.password:
        return render_template('share.html',
            need_password=True,
            share_id=share_id,
            site_title=site_title,
            site_desc=site_desc)

    # 无密码，增加计数并显示内容
    share.view_count += 1
    db.session.commit()

    note = share.note
    return render_template('share.html',
        note=note,
        share_id=share_id,
        site_title=site_title,
        site_desc=site_desc)
