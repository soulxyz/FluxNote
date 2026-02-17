from flask import Blueprint, request, jsonify, current_app
from flask_login import current_user, login_required
from app.models import Comment, Note, Config, User
from app.extensions import db
from app.utils.email import send_email, render_new_comment_email, render_reply_email
from app.utils.error_handler import safe_error
import markdown
import bleach
from datetime import datetime

comment_bp = Blueprint('comment', __name__)

def sanitize_html(html_content):
    """
    Sanitize HTML content using bleach
    """
    allowed_tags = ['a', 'abbr', 'acronym', 'b', 'blockquote', 'code', 'em', 'i', 'li', 'ol', 'strong', 'ul', 'p', 'br', 'pre']
    allowed_attrs = {
        'a': ['href', 'title', 'target'],
        'img': ['src', 'alt', 'title'] # Removed img for safety, user can only use text/links
    }
    return bleach.clean(html_content, tags=allowed_tags, attributes=allowed_attrs, strip=True)

@comment_bp.route('/comments/<post_id>', methods=['GET'])
def get_comments(post_id):
    """
    获取文章评论列表 (嵌套结构)
    """
    # 检查文章是否存在
    note = Note.query.get(post_id)
    if not note:
        return jsonify({'error': 'Note not found'}), 404

    # 获取评论
    # 如果是管理员，可以看到所有评论；否则只能看到 approved
    query = Comment.query.filter_by(post_id=post_id)
    
    if not current_user.is_authenticated:
        query = query.filter_by(status='approved')
    
    # 按照创建时间排序
    comments = query.order_by(Comment.created_at.asc()).all()

    # 加载配置用于头像渲染
    settings = {
        'avatar_source': Config.get('avatar_source', 'cravatar'),
        'blogger_avatar': Config.get('blogger_avatar')
    }

    # 构建评论树 (只做两层: Root -> Replies)
    root_comments = []
    replies_map = {} # parent_id -> [replies]

    for comment in comments:
        # Pass settings to to_dict
        comment_dict = comment.to_dict(settings)
        
        if comment.parent_id is None:
            root_comments.append(comment_dict)
        else:
            if comment.parent_id not in replies_map:
                replies_map[comment.parent_id] = []
            replies_map[comment.parent_id].append(comment_dict)

    # 将回复挂载到根评论
    for root in root_comments:
        root['replies'] = replies_map.get(root['id'], [])
        
    return jsonify({
        'comments': root_comments,
        'count': len(comments),
        'is_admin': current_user.is_authenticated # 告诉前端当前是否管理员
    })

@comment_bp.route('/comments/<post_id>', methods=['POST'])
def post_comment(post_id):
    """
    提交评论
    """
    data = request.json
    
    # 1. 基础验证
    content = data.get('content', '').strip()
    if not content:
        return jsonify({'error': '评论内容不能为空'}), 400

    note = Note.query.get(post_id)
    if not note:
        return jsonify({'error': '文章不存在'}), 404

    # 2. 用户身份处理
    if current_user.is_authenticated:
        author_name = current_user.username or "Admin"
        author_email = Config.get('notify_email') or "admin@example.com" # Fallback
        author_website = "/"
        is_admin = True
        status = 'approved' # 管理员无需审核
    else:
        author_name = data.get('author_name', '').strip()
        author_email = data.get('author_email', '').strip()
        author_website = data.get('author_website', '').strip()
        is_admin = False
        
        if not author_name or not author_email:
            return jsonify({'error': '昵称和邮箱为必填项'}), 400

        # 审核策略（配置值可能是 'True' 或 'true'，统一小写比较）
        audit_enabled = Config.get('comment_audit', 'false').lower() == 'true'
        status = 'pending' if audit_enabled else 'approved'

    # 3. 处理父级评论 (强制两层嵌套)
    parent_id = data.get('parent_id')
    reply_to_user = None # 用于通知被回复的人
    
    if parent_id:
        parent_comment = Comment.query.get(parent_id)
        if not parent_comment:
            return jsonify({'error': '回复的评论不存在'}), 404
            
        # 如果父评论本身就是回复（有parent_id），则将新评论挂载到根评论下
        if parent_comment.parent_id:
            parent_id = parent_comment.parent_id
            # 但我们需要记录它是回复谁的吗？
            # 简化起见，我们认为它是对该楼层的回复。
            # 如果需要显示 "回复 @某人"，可以在 content 前面手动加上，或者前端处理。
            # 这里简单处理：强制挂载到根节点。
            pass
        
        reply_to_user = parent_comment

    # 4. Markdown 渲染与清洗
    # 允许的 Markdown 扩展
    md_html = markdown.markdown(content, extensions=['fenced_code'])
    # 清洗 HTML 防止 XSS
    safe_html = sanitize_html(md_html)

    # 5. 创建评论
    new_comment = Comment(
        post_id=post_id,
        parent_id=parent_id,
        author_name=author_name,
        author_email=author_email,
        author_website=author_website,
        content=content,
        html=safe_html,
        status=status,
        is_admin=is_admin,
        ip_address=request.remote_addr
    )
    
    db.session.add(new_comment)
    db.session.commit()

    # 6. 发送邮件通知 (异步)
    # 只有当评论被批准（或者审核关闭）时，或者进入审核队列时都需要通知博主
    # 通知的逻辑：
    # A. 通知博主：有新评论 (除非是博主自己发的)
    # B. 通知被回复者：有人回复了你 (状态必须是 approved)

    notify_email = Config.get('notify_email')
    site_title = Config.get('site_title', '轻笔记')
    post_url = f"{request.host_url}p/{post_id}"

    # A. 通知博主
    if not is_admin and notify_email:
        html_body, text_body = render_new_comment_email(
            note_title=note.title or '无标题',
            author_name=author_name,
            content=content,
            status=status,
            post_url=post_url,
            site_title=site_title
        )
        subject = f"[{site_title}] 新评论: {note.title or '无标题'}"
        send_email(subject, notify_email, text_body, html_body)

    # B. 通知被回复者
    # 条件：回复已批准、有被回复者、被回复者有邮箱、不是博主（避免重复）、不是自己回复自己
    if status == 'approved' and reply_to_user and reply_to_user.author_email:
        # 检查是否是博主（避免重复通知）
        is_blogger = reply_to_user.author_email.lower() == (notify_email or '').lower()
        # 检查是否是自己回复自己（相同邮箱）
        is_self_reply = reply_to_user.author_email.lower() == author_email.lower()

        if not is_blogger and not is_self_reply:
            html_body, text_body = render_reply_email(
                note_title=note.title or '无标题',
                author_name=author_name,
                content=content,
                post_url=post_url,
                site_title=site_title
            )
            subject = f"[{site_title}] 你的评论有了新回复"
            send_email(subject, reply_to_user.author_email, text_body, html_body)

    return jsonify({
        'success': True,
        'message': '评论已提交' if status == 'approved' else '评论已提交，等待审核',
        'comment': new_comment.to_dict()
    })

@comment_bp.route('/comments/<int:comment_id>', methods=['DELETE'])
@login_required # 只有管理员能删除
def delete_comment(comment_id):
    comment = Comment.query.get(comment_id)
    if not comment:
        return jsonify({'error': 'Comment not found'}), 404
        
    db.session.delete(comment)
    db.session.commit()
    return jsonify({'success': True})

@comment_bp.route('/comments/<int:comment_id>/approve', methods=['POST'])
@login_required
def approve_comment(comment_id):
    comment = Comment.query.get(comment_id)
    if not comment:
        return jsonify({'error': 'Comment not found'}), 404

    comment.status = 'approved'
    db.session.commit()
    return jsonify({'success': True})


# === 后台评论管理 API ===

@comment_bp.route('/admin/comments', methods=['GET'])
@login_required
def get_admin_comments():
    """获取所有评论（管理后台）"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    status_filter = request.args.get('status', '')  # pending, approved, spam, all

    query = Comment.query

    if status_filter and status_filter != 'all':
        query = query.filter_by(status=status_filter)

    pagination = query.order_by(Comment.created_at.desc()).paginate(
        page=page,
        per_page=per_page,
        error_out=False
    )

    # 加载配置
    settings = {
        'avatar_source': Config.get('avatar_source', 'cravatar'),
        'blogger_avatar': Config.get('blogger_avatar')
    }

    comments_data = []
    for c in pagination.items:
        c_dict = c.to_dict(settings)
        # 添加文章标题
        c_dict['note_title'] = c.note.title if c.note else '文章已删除'
        comments_data.append(c_dict)

    return jsonify({
        'comments': comments_data,
        'total': pagination.total,
        'pages': pagination.pages,
        'current_page': page
    })


@comment_bp.route('/admin/comments/<int:comment_id>/status', methods=['PUT'])
@login_required
def update_comment_status(comment_id):
    """更新评论状态"""
    comment = Comment.query.get(comment_id)
    if not comment:
        return jsonify({'error': 'Comment not found'}), 404

    data = request.json
    new_status = data.get('status')

    if new_status not in ['pending', 'approved', 'spam', 'trashed']:
        return jsonify({'error': 'Invalid status'}), 400

    comment.status = new_status
    db.session.commit()
    return jsonify({'success': True})


@comment_bp.route('/admin/comments/batch', methods=['POST'])
@login_required
def batch_update_comments():
    """批量操作评论"""
    data = request.json
    action = data.get('action')  # approve, spam, delete
    ids = data.get('ids', [])

    if not ids:
        return jsonify({'error': 'No comments selected'}), 400

    comments = Comment.query.filter(Comment.id.in_(ids)).all()

    if action == 'approve':
        for c in comments:
            c.status = 'approved'
    elif action == 'spam':
        for c in comments:
            c.status = 'spam'
    elif action == 'delete':
        for c in comments:
            db.session.delete(c)
    else:
        return jsonify({'error': 'Invalid action'}), 400

    db.session.commit()
    return jsonify({'success': True, 'affected': len(comments)})


@comment_bp.route('/admin/comments/stats', methods=['GET'])
@login_required
def get_comment_stats():
    """获取评论统计"""
    from sqlalchemy import func

    stats = db.session.query(
        Comment.status,
        func.count(Comment.id)
    ).group_by(Comment.status).all()

    result = {
        'total': 0,
        'pending': 0,
        'approved': 0,
        'spam': 0
    }

    for status, count in stats:
        result[status] = count
        result['total'] += count

    return jsonify(result)
