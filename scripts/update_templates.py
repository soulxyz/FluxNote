import os
import re

def process_file(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Matches href="/static/path/to/file?v={{ app_version }}"
    # and replaces with href="{{ static_v('path/to/file') }}"
    # Use triple quotes to avoid quote escape issues
    pattern = r'(href|src)=([\'"])/static/(.*?)\?v=\{\{\s*app_version\s*\}\}\2'
    new_content = re.sub(pattern, r'\1={{ static_v(\2\3\2) }}', content)
    
    if new_content != content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        return True
    return False

if __name__ == '__main__':
    for root, dirs, files in os.walk('app/templates'):
        for file in files:
            if file.endswith('.html'):
                full_path = os.path.join(root, file)
                if process_file(full_path):
                    print(f'Updated {full_path}')
