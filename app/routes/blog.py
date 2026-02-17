from flask import Blueprint, render_template, request, jsonify, send_from_directory, abort
from app.extensions import db
from app.models import Note, Tag, Config
from sqlalchemy import func
from collections import OrderedDict
from datetime import datetime, timedelta
from app.utils.theme import render_theme_template, get_current_theme, get_theme_css_url, get_writer_theme
import os

blog_bp = Blueprint('blog', __name__)

# 配置项
POSTS_PER_PAGE = 10


def get_heatmap_data():
    """获取热力图数据（最近12周的每日笔记数量）"""
    # 计算12周前的日期
    end_date = datetime.now().date()
    start_date = end_date - timedelta(weeks=12)

    # 查询每天的公开笔记数量
    daily_counts = db.session.query(
        func.date(Note.created_at).label('date'),
        func.count(Note.id).label('count')
    ).filter(
        Note.is_public == True,
        Note.is_deleted == False,
        func.date(Note.created_at) >= start_date
    ).group_by(
        func.date(Note.created_at)
    ).all()

    # 转换为字典 {date: count}
    return {str(row.date): row.count for row in daily_counts}


def get_site_config(theme_override=None):
    """获取站点配置"""
    return {
        'site_title': Config.get('site_title', '轻笔记'),
        'site_desc': Config.get('site_desc', '记录思维的碎片'),
        'blog_footer': Config.get('blog_footer', '由 <a href="/">轻笔记</a> 提供支持'),
        'theme': theme_override or get_current_theme(),
        'writer_theme_id': get_writer_theme(),
        'theme_css': get_theme_css_url(theme_override)
    }


@blog_bp.route('/blog')
def index():
    """博客首页 - 显示公开笔记列表"""
    theme_override = request.args.get('theme')
    config = get_site_config(theme_override)
    page = request.args.get('page', 1, type=int)
    search = request.args.get('search', '')
    date_str = request.args.get('date', '')

    # 基础查询
    query = Note.query.filter_by(is_public=True, is_deleted=False)

    # 搜索过滤
    if search:
        query = query.filter(Note.content.contains(search))
    
    # 日期过滤
    if date_str:
        try:
            target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            query = query.filter(func.date(Note.created_at) == target_date)
        except ValueError:
            pass # Ignore invalid date format

    # 按创建时间倒序
    pagination = query.order_by(Note.created_at.desc()).paginate(
        page=page,
        per_page=POSTS_PER_PAGE,
        error_out=False
    )

    # 统计数据
    notes_count = Note.query.filter_by(is_public=True, is_deleted=False).count()
    tags_count = Tag.query.count()

    # 活跃天数
    active_days = db.session.query(func.count(func.distinct(func.date(Note.created_at)))).filter(
        Note.is_public == True,
        Note.is_deleted == False
    ).scalar() or 0

    stats = {
        'notes': notes_count,
        'tags': tags_count,
        'active_days': active_days
    }

    # 热门标签
    popular_tags = db.session.query(Tag).join(
        Note.tags_list
    ).filter(
        Note.is_public == True,
        Note.is_deleted == False
    ).group_by(
        Tag.id
    ).order_by(
        func.count(Note.id).desc()
    ).limit(15).all()

    # 热力图数据
    heatmap_data = get_heatmap_data()

    return render_theme_template('index.html',
        notes=pagination.items,
        page=page,
        total_pages=pagination.pages,
        stats=stats,
        popular_tags=popular_tags,
        heatmap_data=heatmap_data,
        today=datetime.now().strftime('%Y年%m月%d日'),
        search=search,
        current_date=date_str,
        theme_override=theme_override,
        **config
    )


@blog_bp.route('/p/<note_id>')
def post(note_id):
    """文章详情页"""
    theme_override = request.args.get('theme')
    config = get_site_config(theme_override)

    note = db.session.get(Note, note_id)

    if not note or not note.is_public or note.is_deleted:
        return render_theme_template('post.html',
            note=None,
            error='文章不存在或已被删除',
            theme_override=theme_override,
            **config
        ), 404

    return render_theme_template('post.html',
        note=note,
        theme_override=theme_override,
        **config
    )


@blog_bp.route('/archive')
def archive():
    """归档页 - 按年月分组"""
    theme_override = request.args.get('theme')
    config = get_site_config(theme_override)

    # 查询所有公开且未删除的笔记
    notes = Note.query.filter_by(
        is_public=True,
        is_deleted=False
    ).order_by(
        Note.created_at.desc()
    ).all()

    # 按年月分组
    archives = OrderedDict()
    for note in notes:
        year = note.created_at.year
        month = note.created_at.month

        if year not in archives:
            archives[year] = OrderedDict()
        if month not in archives[year]:
            archives[year][month] = []
        archives[year][month].append(note)

    return render_theme_template('archive.html',
        archives=archives,
        total_count=len(notes),
        theme_override=theme_override,
        **config
    )


@blog_bp.route('/tags')
def tags():
    """标签云"""
    theme_override = request.args.get('theme')
    config = get_site_config(theme_override)

    # 查询所有标签及其公开笔记数量
    tag_counts = db.session.query(
        Tag.name,
        func.count(Note.id).label('count')
    ).join(
        Note.tags_list
    ).filter(
        Note.is_public == True,
        Note.is_deleted == False
    ).group_by(
        Tag.id
    ).order_by(
        func.count(Note.id).desc()
    ).all()

    tags_list = [{'name': name, 'count': count} for name, count in tag_counts]

    return render_theme_template('tags.html',
        tags=tags_list,
        theme_override=theme_override,
        **config
    )


@blog_bp.route('/tags/<tag_name>')
def tag_notes(tag_name):
    """标签筛选 - 显示指定标签下的笔记"""
    theme_override = request.args.get('theme')
    config = get_site_config(theme_override)

    tag = Tag.query.filter_by(name=tag_name).first()
    if not tag:
        return render_theme_template('tag_notes.html',
            tag_name=tag_name,
            notes=[],
            theme_override=theme_override,
            **config
        )

    # 查询该标签下公开且未删除的笔记
    notes = Note.query.filter(
        Note.tags_list.contains(tag),
        Note.is_public == True,
        Note.is_deleted == False
    ).order_by(
        Note.created_at.desc()
    ).all()

    return render_theme_template('tag_notes.html',
        tag_name=tag_name,
        notes=notes,
        theme_override=theme_override,
        **config
    )


# ===== Theme Static Files =====

@blog_bp.route('/theme/<theme_name>/static/<path:filename>')
def theme_static(theme_name, filename):
    """
    提供主题静态文件（CSS、JS、图片等）
    支持主题自包含，便于分发
    """
    # 获取主题目录
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    theme_dir = os.path.join(base_dir, 'templates', 'themes', theme_name)

    # 检查主题是否存在
    if not os.path.isdir(theme_dir):
        abort(404)

    # 静态文件目录
    static_dir = os.path.join(theme_dir, 'static')

    # 检查静态文件是否存在
    if not os.path.isdir(static_dir):
        abort(404)

    # 安全检查：防止目录遍历攻击
    safe_path = os.path.normpath(os.path.join(static_dir, filename))
    if not safe_path.startswith(static_dir):
        abort(403)

    # 发送文件
    return send_from_directory(static_dir, filename)
