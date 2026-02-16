import re

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}

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
