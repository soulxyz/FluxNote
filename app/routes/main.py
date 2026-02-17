from flask import Blueprint, render_template, redirect, url_for
from flask_login import current_user
from app.extensions import db
from app.models import Share, Config

main_bp = Blueprint('main', __name__)

@main_bp.route('/')
def index():
    """Home Page - 登录用户显示SPA管理界面，未登录用户重定向到博客首页"""
    if current_user.is_authenticated:
        return render_template('index.html')
    else:
        return redirect(url_for('blog.index'))


@main_bp.route('/login')
def login_page():
    """登录页面 - 显示当前主题首页并触发登录"""
    if current_user.is_authenticated:
        return redirect(url_for('main.index'))
    # 重定向到博客首页，带上 show_login 参数
    return redirect(url_for('blog.index', show_login=1))


@main_bp.route('/s/<share_id>')
def share_page(share_id):
    """分享页面（HTML）"""
    share = db.session.get(Share, share_id)

    # 获取站点信息
    site_title = Config.get('site_title', '流光笔记')
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
