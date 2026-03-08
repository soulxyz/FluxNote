from flask import current_app
import os
import hashlib

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CACHEABLE_STATIC_EXTENSIONS = (
    '.js', '.css', '.html', '.json',
    '.woff2', '.woff', '.ttf', '.eot',
    '.svg', '.ico'
)


def get_app_version():
    """读取 VERSION 文件中的应用版本号"""
    version_file = os.path.join(_BASE_DIR, 'VERSION')
    try:
        with open(version_file, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return '0.0.0'


def get_static_hash():
    """
    计算所有核心文件的总哈希值，作为全局版本号。
    """
    manifest = get_static_manifest()
    hash_md5 = hashlib.md5()
    # 将所有文件的路径和时间戳组合起来计算总哈希
    for path, version in sorted(manifest.items()):
        hash_md5.update(f"{path}:{version}".encode('utf-8'))
    hash_md5.update(f"app-version:{get_app_version()}".encode('utf-8'))
    hash_md5.update(f"templates:{get_template_hash()}".encode('utf-8'))
    return f"v-{hash_md5.hexdigest()[:8]}"


def get_template_hash():
    """
    计算模板目录的总哈希，确保服务端页面更新也能触发 SW 版本变更。
    """
    templates_folder = os.path.join(current_app.root_path, 'templates')
    hash_md5 = hashlib.md5()

    for root, dirs, files in os.walk(templates_folder):
        dirs.sort()
        for file in sorted(files):
            if not file.endswith('.html'):
                continue

            template_path = os.path.join(root, file)
            rel_path = os.path.relpath(template_path, templates_folder).replace('\\', '/')
            try:
                mtime = os.path.getmtime(template_path)
                hash_md5.update(f"{rel_path}:{mtime}".encode('utf-8'))
            except Exception:
                continue

    return hash_md5.hexdigest()[:8]

def get_static_manifest():
    """
    计算 app/static 目录下核心静态资源的细粒度哈希字典。
    返回: { "/static/js/main.js": "hash123", ... }
    """
    static_folder = os.path.join(current_app.root_path, 'static')
    manifest = {}
    
    # 遍历 static 目录下会影响 app shell 的静态资源
    for root, dirs, files in os.walk(static_folder):
        for file in files:
            if file.endswith(CACHEABLE_STATIC_EXTENSIONS) or file == 'manifest.json' or file == 'sw.js':
                # 计算相对路径，例如 /static/js/main.js
                rel_path = os.path.relpath(os.path.join(root, file), os.path.dirname(static_folder))
                rel_path = '/' + rel_path.replace('\\', '/')
                
                # 跳过 sw.js 自身，因为它不能被自己缓存
                if file == 'sw.js':
                    continue

                try:
                    mtime = os.path.getmtime(os.path.join(root, file))
                    # 为每个文件生成短哈希
                    manifest[rel_path] = hashlib.md5(str(mtime).encode()).hexdigest()[:8]
                except Exception:
                    pass
            
    return manifest
