import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header
from email.utils import formataddr
from threading import Thread
from flask import current_app
from app.models import Config

def get_email_base_style():
    """获取邮件基础样式"""
    return """
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb; }
        .email-container { background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .email-header { text-align: center; padding-bottom: 24px; border-bottom: 1px solid #e5e7eb; margin-bottom: 24px; }
        .email-header h1 { color: #1f2937; font-size: 24px; margin: 0; font-weight: 600; }
        .email-header .subtitle { color: #6b7280; font-size: 14px; margin-top: 8px; }
        .email-content { color: #374151; font-size: 15px; }
        .email-content h2 { color: #1f2937; font-size: 18px; margin: 24px 0 12px 0; }
        .comment-box { background: #f9fafb; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
        .comment-author { font-weight: 600; color: #1f2937; margin-bottom: 8px; }
        .comment-text { color: #4b5563; white-space: pre-wrap; }
        .meta-item { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: #6b7280; font-size: 14px; }
        .meta-item .label { font-weight: 500; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; }
        .status-pending { background: #fef3c7; color: #d97706; }
        .status-approved { background: #d1fae5; color: #059669; }
        .email-button { display: inline-block; background: #3b82f6; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500; margin: 16px 0; }
        .email-footer { text-align: center; padding-top: 24px; border-top: 1px solid #e5e7eb; margin-top: 24px; color: #9ca3af; font-size: 13px; }
        .email-footer a { color: #6b7280; }
    </style>
    """

def render_new_comment_email(note_title, author_name, content, status, post_url, site_title="流光笔记"):
    """渲染新评论通知邮件"""
    status_class = "status-pending" if status == "pending" else "status-approved"
    status_text = "待审核" if status == "pending" else "已通过"

    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8">{get_email_base_style()}</head>
    <body>
        <div class="email-container">
            <div class="email-header">
                <h1>💬 新评论通知</h1>
                <div class="subtitle">来自 {site_title}</div>
            </div>
            <div class="email-content">
                <p>您的文章收到了一条新评论：</p>

                <div class="meta-item">
                    <span class="label">📝 文章：</span>
                    <span>{note_title}</span>
                </div>
                <div class="meta-item">
                    <span class="label">👤 评论者：</span>
                    <span>{author_name}</span>
                </div>
                <div class="meta-item">
                    <span class="label">📊 状态：</span>
                    <span class="status-badge {status_class}">{status_text}</span>
                </div>

                <h2>评论内容</h2>
                <div class="comment-box">
                    <div class="comment-text">{content}</div>
                </div>

                <a href="{post_url}" class="email-button">查看详情</a>
            </div>
            <div class="email-footer">
                此邮件由系统自动发送，请勿回复。<br>
                <a href="{post_url}">{site_title}</a>
            </div>
        </div>
    </body>
    </html>
    """

    text = f"""【新评论通知】

文章：{note_title}
评论者：{author_name}
状态：{status_text}

评论内容：
{content}

查看详情：{post_url}
"""
    return html, text

def render_reply_email(note_title, author_name, content, post_url, site_title="流光笔记"):
    """渲染回复通知邮件"""
    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8">{get_email_base_style()}</head>
    <body>
        <div class="email-container">
            <div class="email-header">
                <h1>🔔 您的评论有了新回复</h1>
                <div class="subtitle">来自 {site_title}</div>
            </div>
            <div class="email-content">
                <p>您好！您在文章《{note_title}》下的评论收到了新回复：</p>

                <div class="meta-item">
                    <span class="label">👤 回复者：</span>
                    <span>{author_name}</span>
                </div>

                <h2>回复内容</h2>
                <div class="comment-box">
                    <div class="comment-text">{content}</div>
                </div>

                <a href="{post_url}" class="email-button">查看完整对话</a>
            </div>
            <div class="email-footer">
                此邮件由系统自动发送，请勿回复。<br>
                <a href="{post_url}">{site_title}</a>
            </div>
        </div>
    </body>
    </html>
    """

    text = f"""【您的评论有了新回复】

文章：{note_title}
回复者：{author_name}

回复内容：
{content}

查看详情：{post_url}
"""
    return html, text

def render_test_email(site_title="流光笔记"):
    """渲染测试邮件"""
    html = f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8">{get_email_base_style()}</head>
    <body>
        <div class="email-container">
            <div class="email-header">
                <h1>✉️ 邮件配置测试</h1>
                <div class="subtitle">来自 {site_title}</div>
            </div>
            <div class="email-content">
                <p>恭喜！这是一封来自 <strong>{site_title}</strong> 的测试邮件。</p>

                <div class="comment-box">
                    <p style="margin:0; color:#059669; font-weight:500;">✅ SMTP 配置正确，邮件发送成功！</p>
                </div>

                <p>如果您收到这封邮件，说明您的邮件通知功能已经可以正常工作了。</p>

                <h2>接下来</h2>
                <p>当有访客在您的博客上发表评论时，您将会收到邮件通知。同时，被回复的访客也会收到通知邮件。</p>
            </div>
            <div class="email-footer">
                此邮件由系统自动发送，请勿回复。<br>
                {site_title}
            </div>
        </div>
    </body>
    </html>
    """

    text = f"""【邮件配置测试】

恭喜！这是一封来自 {site_title} 的测试邮件。

✅ SMTP 配置正确，邮件发送成功！

如果您收到这封邮件，说明您的邮件通知功能已经可以正常工作了。
"""
    return html, text


def send_async_email(app, msg):
    """
    异步发送邮件的具体实现
    """
    with app.app_context():
        try:
            # 获取配置
            smtp_server = Config.get('smtp_server')
            smtp_port = int(Config.get('smtp_port', 465))
            smtp_user = Config.get('smtp_user')
            smtp_password = Config.get('smtp_password')

            if not all([smtp_server, smtp_user, smtp_password]):
                print("SMTP settings incomplete")
                return

            # 根据端口选择连接方式
            if smtp_port == 465:
                server = smtplib.SMTP_SSL(smtp_server, smtp_port)
            else:
                server = smtplib.SMTP(smtp_server, smtp_port)
                # 尝试启用 TLS
                try:
                    server.starttls()
                except Exception as e:
                    print(f"STARTTLS failed (might not be supported or needed): {e}")

            server.login(smtp_user, smtp_password)
            server.send_message(msg)
            server.quit()
            print(f"Email sent successfully to {msg['To']}")

        except Exception as e:
            print(f"Failed to send email: {e}")

def send_email(subject, recipient, body, html_body=None):
    """
    发送邮件接口
    :param subject: 邮件主题
    :param recipient: 收件人邮箱
    :param body: 纯文本内容
    :param html_body: HTML内容 (可选)
    :return: (success, message)
    """
    # 获取发件人配置
    sender_email = Config.get('smtp_user')
    sender_name = Config.get('smtp_sender_name', '流光笔记')  # 发件人名称
    site_title = Config.get('site_title', '流光笔记')

    if not sender_email:
        return False, "SMTP user not configured"

    # 构建邮件对象
    msg = MIMEMultipart('alternative')
    msg['Subject'] = Header(subject, 'utf-8')
    msg['From'] = formataddr((sender_name, sender_email))
    msg['To'] = recipient

    # 添加正文
    part1 = MIMEText(body, 'plain', 'utf-8')
    msg.attach(part1)

    if html_body:
        part2 = MIMEText(html_body, 'html', 'utf-8')
        msg.attach(part2)

    # 启动线程异步发送
    # 获取当前的 app 实例传递给线程，因为线程中没有请求上下文
    try:
        app = current_app._get_current_object()
        thr = Thread(target=send_async_email, args=(app, msg))
        thr.start()
        return True, "Email queued for delivery"
    except Exception as e:
        return False, str(e)
