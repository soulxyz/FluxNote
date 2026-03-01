from flask import current_app
import os
import hashlib
import time

def get_static_hash():
    """
    计算 app/static 目录下核心文件的哈希值。
    主要用于生成动态的资源版本号 (app_version) 和 PWA 缓存版本号 (CACHE_VERSION)。
    在开发模式下，每次修改静态文件都会导致哈希变化，从而触发 PWA 自动更新。
    """
    static_folder = os.path.join(current_app.root_path, 'static')
    hash_md5 = hashlib.md5()
    
    # 核心文件列表，修改这些文件会触发版本更新
    core_files = [
        'css/style.css',
        'js/main.js',
        'js/pwa.js',
        'js/theme-sdk.js',
        'sw.js',
        'manifest.json'
    ]
    
    for relative_path in core_files:
        file_path = os.path.join(static_folder, relative_path)
        if os.path.exists(file_path):
            # 获取最后修改时间，基于时间戳计算哈希
            mtime = os.path.getmtime(file_path)
            hash_md5.update(f"{file_path}:{mtime}".encode('utf-8'))
            
    # 取前 8 位即可，保证版本号简短且足够防冲突
    return f"v-{hash_md5.hexdigest()[:8]}"
