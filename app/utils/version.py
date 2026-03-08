from flask import current_app
import os
import hashlib
import time

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


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
    return f"v-{hash_md5.hexdigest()[:8]}"

def get_static_manifest():
    """
    计算 app/static 目录下所有核心 CSS 和 JS 文件的细粒度哈希字典。
    返回: { "/static/js/main.js": "hash123", ... }
    """
    static_folder = os.path.join(current_app.root_path, 'static')
    manifest = {}
    
    # 遍历 static 目录下的所有 js 和 css 文件
    for root, dirs, files in os.walk(static_folder):
        # 忽略第三方库以提升计算速度
        if 'lib' in root.replace('\\', '/').split('/'):
            continue
            
        for file in files:
            if file.endswith('.js') or file.endswith('.css') or file == 'manifest.json' or file == 'sw.js':
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
