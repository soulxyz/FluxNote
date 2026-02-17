# Utils package
import re
import markdown
import bleach

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}

# BLEACH 配置：允许的标签和属性
ALLOWED_TAGS = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span',
    'sup', 'sub',
]

ALLOWED_ATTRIBUTES = {
    '*': ['class', 'id'],
    'a': ['href', 'title', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    'td': ['align'],
    'th': ['align'],
    'ol': ['start'],
    'code': ['class'],
    'pre': ['class'],
    'div': ['class'],
    'span': ['class'],
}

ALLOWED_PROTOCOLS = ['http', 'https', 'mailto', 'ftp']


def sanitize_html(html_content):
    """清洗HTML内容，防止XSS攻击"""
    return bleach.clean(
        html_content,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=ALLOWED_PROTOCOLS,
        strip=False
    )

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def strip_markdown_for_search(content):
    """
    Remove URLs and syntax, keep only searchable text.
    ![alt](url) -> alt
    [title](url) -> title
    [[wiki|alias]] -> alias (or wiki)
    """
    if not content:
        return ""

    # 1. Handle Images: ![alt](url) -> alt
    text = re.sub(r'!\[(.*?)\]\(.*?\)', r'\1', content)

    # 2. Handle Links: [text](url) -> text
    text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)

    # 3. Handle WikiLinks: [[link|alias]] -> alias; [[link]] -> link
    text = re.sub(r'\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]', r'\1', text)

    # 4. Remove other MD symbols (bold, italic, headers)
    text = re.sub(r'[*_#`~>+-]', ' ', text)

    # 5. Clean up extra whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    return text

def extract_title_and_links(content):
    if not content:
        return "Untitled", []

    lines = content.split('\n')
    title = lines[0].strip()
    # Remove markdown header characters and list markers
    title = re.sub(r'^(#+\s+|[-*]\s+(\[[ xX]?\]\s+)?|\d+\.\s+)', '', title)
    if not title:
        title = "Untitled"
    if len(title) > 200:
        title = title[:200]

    # Extract links [[...]]
    links = re.findall(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', content)
    # Remove duplicates
    links = sorted(list(set([l.strip() for l in links if l.strip()])))

    return title, links


def render_markdown(content, max_length=None):
    """
    渲染Markdown内容为HTML
    用于服务端渲染博客内容
    已添加XSS防护
    """
    if not content:
        return ''

    text = content

    # 截断长度
    if max_length and len(text) > max_length:
        text = text[:max_length]

    # 移除代码块（在列表页不需要显示）
    text = re.sub(r'```[\s\S]*?```', '', text)

    # 移除Mermaid/mindmap块
    text = re.sub(r'```(?:mermaid|mindmap)[\s\S]*?```', '', text)

    # 使用markdown库渲染
    try:
        html = markdown.markdown(text, extensions=['fenced_code', 'tables', 'toc'])
        # XSS清洗
        html = sanitize_html(html)
    except:
        # 如果markdown库不可用，简单处理
        html = text.replace('\n', '<br>')

    return html
