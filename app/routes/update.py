import os
import sys
import json
import shutil
import zipfile
import tempfile
import threading
import subprocess
import logging
import time
from datetime import datetime

import httpx
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_required
from packaging.version import Version, InvalidVersion

from app.models import Config
from app.utils.version import get_app_version
from app.utils.response import api_response

logger = logging.getLogger(__name__)

update_bp = Blueprint('update', __name__)

_AUTO_CHECK_INTERVAL = 6 * 3600  # 每 6 小时自动检查一次

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PRESERVE_PATHS = {'data', 'uploads', 'venv', '.venv', '.env', '.git', 'migrations',
                  '__pycache__', '.cursor', '.vscode', '.idea'}


def _github_repo():
    return Config.get('github_repo', 'soulxyz/FlexNote').strip()


def _github_api(path, token=None):
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'FluxNote-Updater/1.0'}
    if token:
        headers['Authorization'] = f'token {token}'
    with httpx.Client(timeout=15, follow_redirects=True) as http:
        resp = http.get(f'https://api.github.com{path}', headers=headers)
    return resp


def _parse_version(tag: str):
    """从 tag 中提取版本号，兼容 v1.0.0 和 1.0.0 格式"""
    tag = tag.lstrip('vV')
    try:
        return Version(tag)
    except InvalidVersion:
        return None


def _append_update_log(message: str):
    logs = Config.get('update_logs', '')
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    entry = f'[{ts}] {message}'
    logs = entry + '\n' + logs
    if len(logs) > 20000:
        logs = logs[:20000]
    Config.set('update_logs', logs)


# ───── Routes ─────

@update_bp.route('/api/update/current', methods=['GET'])
@login_required
def get_current_version():
    return api_response(data={
        'version': get_app_version(),
        'github_repo': _github_repo(),
    })


@update_bp.route('/api/update/config', methods=['POST'])
@login_required
def save_update_config():
    data = request.json or {}
    repo = data.get('github_repo', '').strip()
    if repo and '/' not in repo:
        return api_response(code=400, message='格式应为 owner/repo，例如 myname/my-blog')
    Config.set('github_repo', repo)
    return api_response(message='已保存')


@update_bp.route('/api/update/check', methods=['GET'])
@login_required
def check_update():
    """检查 GitHub 最新 Release，对比本地版本"""
    repo = _github_repo()
    if not repo:
        return api_response(code=400, message='请先配置 GitHub 仓库地址')

    token = Config.get('github_token', '').strip() or None
    resp = _github_api(f'/repos/{repo}/releases/latest', token)

    if resp.status_code == 404:
        return api_response(code=404, message='未找到任何 Release，请先在 GitHub 创建一个 Release')
    if resp.status_code == 403:
        return api_response(code=403, message='GitHub API 速率限制，请稍后再试或配置 Token')
    if resp.status_code != 200:
        return api_response(code=502, message=f'GitHub API 错误 (HTTP {resp.status_code})')

    release = resp.json()
    remote_tag = release.get('tag_name', '')
    remote_ver = _parse_version(remote_tag)
    local_ver = _parse_version(get_app_version())

    has_update = False
    if remote_ver and local_ver:
        has_update = remote_ver > local_ver

    zip_url = release.get('zipball_url', '')

    return api_response(data={
        'has_update': has_update,
        'local_version': get_app_version(),
        'remote_version': remote_tag,
        'release_name': release.get('name', remote_tag),
        'changelog': release.get('body', ''),
        'published_at': release.get('published_at', ''),
        'zip_url': zip_url,
        'html_url': release.get('html_url', ''),
    })


@update_bp.route('/api/update/apply', methods=['POST'])
@login_required
def apply_update():
    """下载并应用更新"""
    data = request.json or {}
    zip_url = data.get('zip_url', '').strip()
    target_version = data.get('version', '').strip()

    if not zip_url:
        return api_response(code=400, message='缺少下载地址')

    repo = _github_repo()
    if not repo:
        return api_response(code=400, message='未配置 GitHub 仓库')

    _append_update_log(f'开始更新到 {target_version}...')

    try:
        # 1. 备份数据库
        db_path = os.path.join(_BASE_DIR, 'data', 'notes.db')
        if os.path.exists(db_path):
            backup_name = f'notes_backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}.db'
            backup_path = os.path.join(_BASE_DIR, 'data', backup_name)
            shutil.copy2(db_path, backup_path)
            _append_update_log(f'数据库已备份: {backup_name}')

        # 2. 下载 Release ZIP
        _append_update_log('正在下载更新包...')
        token = Config.get('github_token', '').strip() or None
        headers = {'User-Agent': 'FluxNote-Updater/1.0', 'Accept': 'application/vnd.github+json'}
        if token:
            headers['Authorization'] = f'token {token}'

        with httpx.Client(timeout=120, follow_redirects=True) as http:
            dl_resp = http.get(zip_url, headers=headers)

        if dl_resp.status_code != 200:
            _append_update_log(f'下载失败: HTTP {dl_resp.status_code}')
            return api_response(code=502, message=f'下载失败 (HTTP {dl_resp.status_code})')

        # 3. 解压到临时目录
        _append_update_log('正在解压...')
        tmp_dir = tempfile.mkdtemp(prefix='fluxnote_update_')
        zip_path = os.path.join(tmp_dir, 'release.zip')
        with open(zip_path, 'wb') as f:
            f.write(dl_resp.content)

        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(tmp_dir)

        # GitHub release zip 内通常有一层 owner-repo-hash 目录
        extracted_dirs = [d for d in os.listdir(tmp_dir) if os.path.isdir(os.path.join(tmp_dir, d))]
        if not extracted_dirs:
            _append_update_log('解压失败: 找不到内容目录')
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return api_response(code=500, message='解压失败: ZIP 内容为空')

        source_dir = os.path.join(tmp_dir, extracted_dirs[0])

        # 4. 复制文件（跳过需要保留的目录）
        _append_update_log('正在替换文件...')
        updated_count = 0
        for item in os.listdir(source_dir):
            if item in PRESERVE_PATHS:
                continue
            src = os.path.join(source_dir, item)
            dst = os.path.join(_BASE_DIR, item)
            if os.path.isdir(src):
                if os.path.exists(dst):
                    shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            updated_count += 1

        _append_update_log(f'已替换 {updated_count} 个文件/目录')

        # 5. 安装依赖
        req_file = os.path.join(_BASE_DIR, 'requirements.txt')
        if os.path.exists(req_file):
            _append_update_log('正在安装依赖...')
            try:
                subprocess.run(
                    [sys.executable, '-m', 'pip', 'install', '-r', req_file, '--quiet'],
                    cwd=_BASE_DIR, timeout=300, capture_output=True
                )
                _append_update_log('依赖安装完成')
            except subprocess.TimeoutExpired:
                _append_update_log('依赖安装超时，请手动运行 pip install -r requirements.txt')
            except Exception as e:
                _append_update_log(f'依赖安装异常: {e}')

        # 6. 清理临时目录
        shutil.rmtree(tmp_dir, ignore_errors=True)

        _append_update_log(f'更新完成! 版本: {target_version}，服务即将重启...')

        # 7. 延迟重启（先让响应返回给前端）
        def _delayed_restart():
            time.sleep(2)
            logger.info('Restarting application after update...')
            os.execv(sys.executable, [sys.executable] + sys.argv)

        threading.Thread(target=_delayed_restart, daemon=True).start()

        return api_response(data={
            'success': True,
            'version': target_version,
            'message': '更新完成，服务正在重启...',
            'restarting': True,
        })

    except Exception as e:
        _append_update_log(f'更新失败: {str(e)}')
        logger.exception('Update failed')
        return api_response(code=500, message=f'更新失败: {str(e)}')


@update_bp.route('/api/update/logs', methods=['GET'])
@login_required
def get_update_logs():
    logs = Config.get('update_logs', '')
    return api_response(data={'logs': logs})


@update_bp.route('/api/update/status', methods=['GET'])
@login_required
def get_update_status():
    """返回缓存的自动检查结果（不发起 GitHub 请求，供前端快速展示徽标）"""
    cache_raw = Config.get('update_check_cache', '')
    if not cache_raw:
        return api_response(data={'has_update': False, 'checked_at': None})
    try:
        data = json.loads(cache_raw)
        return api_response(data=data)
    except Exception:
        return api_response(data={'has_update': False, 'checked_at': None})


@update_bp.route('/api/update/releases', methods=['GET'])
@login_required
def list_releases():
    """获取所有 Release 列表，用于查看历史版本"""
    repo = _github_repo()
    if not repo:
        return api_response(code=400, message='请先配置 GitHub 仓库地址')

    token = Config.get('github_token', '').strip() or None
    resp = _github_api(f'/repos/{repo}/releases?per_page=10', token)

    if resp.status_code != 200:
        return api_response(code=502, message=f'GitHub API 错误 (HTTP {resp.status_code})')

    releases = resp.json()
    local_ver = _parse_version(get_app_version())

    result = []
    for r in releases:
        tag = r.get('tag_name', '')
        ver = _parse_version(tag)
        result.append({
            'tag': tag,
            'name': r.get('name', tag),
            'changelog': r.get('body', ''),
            'published_at': r.get('published_at', ''),
            'zip_url': r.get('zipball_url', ''),
            'html_url': r.get('html_url', ''),
            'is_current': (ver == local_ver) if ver and local_ver else False,
            'is_newer': (ver > local_ver) if ver and local_ver else False,
        })

    return api_response(data=result)


# ───── 后台自动检查 ─────

def _do_background_check(app):
    """后台线程：每隔 _AUTO_CHECK_INTERVAL 秒检查一次更新，结果存入 Config 缓存"""
    # 启动时稍等，让 app 完全就绪后再检查
    time.sleep(30)
    while True:
        try:
            with app.app_context():
                repo = _github_repo()
                if repo:
                    token = Config.get('github_token', '').strip() or None
                    resp = _github_api(f'/repos/{repo}/releases/latest', token)
                    if resp.status_code == 200:
                        release = resp.json()
                        remote_tag = release.get('tag_name', '')
                        remote_ver = _parse_version(remote_tag)
                        local_ver = _parse_version(get_app_version())
                        has_update = bool(remote_ver and local_ver and remote_ver > local_ver)
                        Config.set('update_check_cache', json.dumps({
                            'has_update': has_update,
                            'local_version': get_app_version(),
                            'remote_version': remote_tag,
                            'release_name': release.get('name', remote_tag),
                            'changelog': release.get('body', ''),
                            'published_at': release.get('published_at', ''),
                            'zip_url': release.get('zipball_url', ''),
                            'html_url': release.get('html_url', ''),
                            'checked_at': datetime.now().isoformat(),
                        }))
                        logger.info(f'Background update check done: has_update={has_update}, remote={remote_tag}')
        except Exception as e:
            logger.debug(f'Background update check failed: {e}')
        time.sleep(_AUTO_CHECK_INTERVAL)


def start_background_update_checker(app):
    """启动后台更新检查线程（应在 app 创建完成后调用）"""
    t = threading.Thread(target=_do_background_check, args=(app,), daemon=True)
    t.name = 'update-checker'
    t.start()
    logger.info('Background update checker started')
