import re

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_title_and_links(content):
    if not content:
        return "Untitled", []

    lines = content.split('\n')
    title = lines[0].strip()
    # Remove markdown header characters
    title = re.sub(r'^#+\s+', '', title)
    if not title:
        title = "Untitled"
    if len(title) > 200:
        title = title[:200]

    # Extract links [[...]]
    links = re.findall(r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]', content)
    # Remove duplicates
    links = sorted(list(set([l.strip() for l in links if l.strip()])))

    return title, links
