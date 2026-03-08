import os
import sys
import re
import json
import hashlib
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

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PRESERVE_PATHS = {'data', 'uploads', 'venv', '.venv', '.env', '.git', 'migrations',
                  '__pycache__', '.cursor', '.vscode', '.idea', 'settings.json'}

DEFAULT_MIRRORS = [
    'https://gh-proxy.com/',
    'https://gh.llkk.cc/',
    'https://ghproxy.net/',
]

DEFAULT_DOWNLOAD_TIMEOUT = 120
DEFAULT_AUTO_CHECK_INTERVAL = 6  # 小时


# ───── 辅助函数 ─────

def _github_repo():
    return Config.get('github_repo', 'soulxyz/FluxNote').strip()


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


def _get_mirror_config():
    """读取镜像下载配置"""
    use_mirror = Config.get('update_use_mirror', 'true').lower() == 'true'
    mirrors_raw = Config.get('update_mirrors', '')
    if mirrors_raw:
        try:
            mirrors = json.loads(mirrors_raw)
        except Exception:
            mirrors = DEFAULT_MIRRORS
    else:
        mirrors = DEFAULT_MIRRORS
    try:
        timeout = int(Config.get('update_download_timeout', str(DEFAULT_DOWNLOAD_TIMEOUT)))
    except (ValueError, TypeError):
        timeout = DEFAULT_DOWNLOAD_TIMEOUT
    return use_mirror, mirrors, timeout


def _get_download_url(release, repo):
    """
    从 release 数据中提取最佳下载 URL（github.com 域名，镜像可加速）。
    优先级：release assets 中的 .zip 文件 > 源码归档 URL
    """
    assets = release.get('assets', [])
    for asset in assets:
        name = asset.get('name', '')
        if name.endswith('.zip') and asset.get('browser_download_url'):
            return asset['browser_download_url']

    # 回退到源码归档（github.com 域名，可被镜像加速）
    tag = release.get('tag_name', '')
    if tag and repo:
        return f'https://github.com/{repo}/archive/refs/tags/{tag}.zip'

    return ''


def _extract_md5(release):
    """
    从 release 信息中提取 MD5 hash。
    来源优先级：release assets 中的 checksums 文件 > release body 中的内联 MD5
    仅解析 body 中的内联 MD5，checksums 文件需网络请求暂不下载。
    返回 (md5_hash_str, source_desc) 或 (None, None)
    """
    # 1. 从 release body 中提取 MD5 标记
    body = release.get('body', '') or ''
    patterns = [
        r'[Mm][Dd]5[:\s]+`?([a-fA-F0-9]{32})`?',
        r'`[Mm][Dd]5:\s*([a-fA-F0-9]{32})`',
        r'md5sum[:\s]+([a-fA-F0-9]{32})',
    ]
    for pat in patterns:
        m = re.search(pat, body)
        if m:
            return m.group(1).lower(), 'release body'

    # 2. 检查 assets 中是否有 checksums 文件（只记录存在，实际下载由调用方决定）
    assets = release.get('assets', [])
    for asset in assets:
        name = asset.get('name', '').lower()
        if name in ('checksums.md5', 'md5sums.txt', 'md5.txt', 'checksums.txt'):
            return None, f'asset:{asset["browser_download_url"]}'

    return None, None


def _download_with_mirrors(github_url, use_mirror, mirrors, timeout, log_fn=None):
    """
    带镜像回退和超时的下载函数。
    返回 (content_bytes, source_description)
    失败时抛出异常。
    """
    errors = []

    if use_mirror and mirrors and github_url.startswith('https://github.com'):
        for mirror in mirrors:
            mirror_url = mirror.rstrip('/') + '/' + github_url
            try:
                if log_fn:
                    log_fn(f'尝试镜像源: {mirror}')
                with httpx.Client(timeout=timeout, follow_redirects=True) as http:
                    resp = http.get(mirror_url)
                if resp.status_code == 200:
                    if log_fn:
                        log_fn(f'镜像下载成功: {mirror}')
                    return resp.content, f'镜像: {mirror}'
                else:
                    msg = f'镜像 {mirror} 返回 HTTP {resp.status_code}'
                    errors.append(msg)
                    if log_fn:
                        log_fn(msg)
            except httpx.TimeoutException:
                msg = f'镜像 {mirror} 超时'
                errors.append(msg)
                if log_fn:
                    log_fn(msg)
            except Exception as e:
                msg = f'镜像 {mirror} 错误: {e}'
                errors.append(msg)
                if log_fn:
                    log_fn(msg)

    # 回退直连 GitHub
    if log_fn:
        log_fn('所有镜像失败，尝试直连 GitHub...' if errors else '直连 GitHub 下载...')
    with httpx.Client(timeout=timeout, follow_redirects=True) as http:
        resp = http.get(github_url)
    if resp.status_code != 200:
        raise RuntimeError(f'下载失败 (HTTP {resp.status_code})')
    if log_fn:
        log_fn('GitHub 直连下载成功')
    return resp.content, 'GitHub 直连'


def _verify_md5(content: bytes, expected_md5: str) -> bool:
    """校验文件内容 MD5"""
    actual = hashlib.md5(content).hexdigest().lower()
    return actual == expected_md5.lower()


# 后台更新任务状态（进程内单例）
_update_status: dict = {
    'running': False,
    'done': False,
    'success': False,
    'error': None,
    'source': None,
    'restarting': False,
}


def _do_apply_update(download_url, target_version, expected_md5,
                     use_mirror, mirrors, timeout, repo):
    """在后台线程中执行完整的更新流程，调用前需已进入 app_context。"""
    global _update_status

    _append_update_log(f'开始更新到 {target_version}...')

    # 1. 备份数据库
    db_path = os.path.join(_BASE_DIR, 'data', 'notes.db')
    if os.path.exists(db_path):
        backup_name = f'notes_backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}.db'
        backup_path = os.path.join(_BASE_DIR, 'data', backup_name)
        shutil.copy2(db_path, backup_path)
        _append_update_log(f'数据库已备份: {backup_name}')

    # 2. 下载更新包（带镜像回退和超时）
    _append_update_log(f'正在下载更新包（{"使用镜像" if use_mirror else "直连 GitHub"}）...')
    content, source = _download_with_mirrors(
        download_url, use_mirror, mirrors, timeout, log_fn=_append_update_log
    )
    _update_status['source'] = source
    _append_update_log(f'下载完成，来源: {source}，大小: {len(content) // 1024} KB')

    # 3. MD5 校验
    if expected_md5:
        _append_update_log(f'正在验证 MD5: {expected_md5}')
        if _verify_md5(content, expected_md5):
            _append_update_log('MD5 校验通过')
        else:
            actual_md5 = hashlib.md5(content).hexdigest()
            msg = f'MD5 校验失败! 期望: {expected_md5}, 实际: {actual_md5}'
            _append_update_log(msg)
            raise RuntimeError(msg)
    else:
        _append_update_log('无 MD5 校验信息，跳过完整性验证')

    # 4. 解压到临时目录
    _append_update_log('正在解压...')
    tmp_dir = tempfile.mkdtemp(prefix='fluxnote_update_')
    zip_path = os.path.join(tmp_dir, 'release.zip')
    try:
        with open(zip_path, 'wb') as f:
            f.write(content)
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(tmp_dir)
    except zipfile.BadZipFile:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        _append_update_log('解压失败: 文件损坏或不是有效的 ZIP')
        raise RuntimeError('解压失败: 下载的文件损坏，请重试')

    extracted_dirs = [d for d in os.listdir(tmp_dir) if os.path.isdir(os.path.join(tmp_dir, d))]
    if not extracted_dirs:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        _append_update_log('解压失败: 找不到内容目录')
        raise RuntimeError('解压失败: ZIP 内容为空')

    source_dir = os.path.join(tmp_dir, extracted_dirs[0])

    # 5. 复制文件（跳过需要保留的目录）
    _append_update_log('正在替换文件...')
    updated_count = 0
    for item in os.listdir(source_dir):
        if item in PRESERVE_PATHS:
            continue
        src = os.path.join(source_dir, item)
        dst = os.path.join(_BASE_DIR, item)
        if os.path.isdir(src):
            if os.path.exists(dst):
                # 使用 dirs_exist_ok=True 避免删除整个目录，从而保留用户自定义文件
                shutil.copytree(src, dst, dirs_exist_ok=True)
            else:
                shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        updated_count += 1

    _append_update_log(f'已替换 {updated_count} 个文件/目录')

    # 6. 安装依赖
    req_file = os.path.join(_BASE_DIR, 'requirements.txt')
    if os.path.exists(req_file):
        _append_update_log('正在安装依赖（可能需要几分钟）...')
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

    # 7. 清理临时目录
    shutil.rmtree(tmp_dir, ignore_errors=True)

    _append_update_log(f'更新完成! 版本: {target_version}，服务即将重启...')


# ───── Routes ─────

@update_bp.route('/api/update/current', methods=['GET'])
@login_required
def get_current_version():
    response, status = api_response(data={
        'version': get_app_version(),
        'github_repo': _github_repo(),
    })
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response, status


@update_bp.route('/api/update/config', methods=['POST'])
@login_required
def save_update_config():
    data = request.json or {}
    repo = data.get('github_repo', '').strip()
    if repo and '/' not in repo:
        return api_response(code=400, message='格式应为 owner/repo，例如 myname/my-blog')
    Config.set('github_repo', repo)
    return api_response(message='已保存')


@update_bp.route('/api/update/mirror-config', methods=['GET'])
@login_required
def get_mirror_config():
    """返回镜像源和自动更新配置"""
    use_mirror, mirrors, timeout = _get_mirror_config()
    auto_check_enabled = Config.get('update_auto_check_enabled', 'true').lower() == 'true'
    try:
        auto_check_interval = int(Config.get('update_auto_check_interval', str(DEFAULT_AUTO_CHECK_INTERVAL)))
    except (ValueError, TypeError):
        auto_check_interval = DEFAULT_AUTO_CHECK_INTERVAL

    return api_response(data={
        'use_mirror': use_mirror,
        'mirrors': mirrors,
        'download_timeout': timeout,
        'auto_check_enabled': auto_check_enabled,
        'auto_check_interval': auto_check_interval,
        'default_mirrors': DEFAULT_MIRRORS,
    })


@update_bp.route('/api/update/mirror-config', methods=['POST'])
@login_required
def save_mirror_config():
    """保存镜像源和自动更新配置"""
    data = request.json or {}

    if 'use_mirror' in data:
        Config.set('update_use_mirror', 'true' if data['use_mirror'] else 'false')

    if 'mirrors' in data:
        mirrors = data['mirrors']
        if not isinstance(mirrors, list):
            return api_response(code=400, message='mirrors 必须是数组')
        mirrors = [m.strip() for m in mirrors if isinstance(m, str) and m.strip()]
        Config.set('update_mirrors', json.dumps(mirrors))

    if 'download_timeout' in data:
        try:
            timeout = max(10, int(data['download_timeout']))
        except (ValueError, TypeError):
            return api_response(code=400, message='超时时间必须是整数')
        Config.set('update_download_timeout', str(timeout))

    if 'auto_check_enabled' in data:
        Config.set('update_auto_check_enabled', 'true' if data['auto_check_enabled'] else 'false')

    if 'auto_check_interval' in data:
        try:
            interval = max(1, int(data['auto_check_interval']))
        except (ValueError, TypeError):
            return api_response(code=400, message='检查间隔必须是整数')
        Config.set('update_auto_check_interval', str(interval))

    return api_response(message='镜像配置已保存')


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

    download_url = _get_download_url(release, repo)
    md5_hash, md5_source = _extract_md5(release)

    return api_response(data={
        'has_update': has_update,
        'local_version': get_app_version(),
        'remote_version': remote_tag,
        'release_name': release.get('name', remote_tag),
        'changelog': release.get('body', ''),
        'published_at': release.get('published_at', ''),
        'download_url': download_url,
        'zip_url': download_url,  # 向后兼容
        'html_url': release.get('html_url', ''),
        'md5': md5_hash,
        'md5_source': md5_source,
    })


@update_bp.route('/api/update/apply', methods=['POST'])
@login_required
def apply_update():
    """下载并应用更新"""
    data = request.json or {}
    download_url = (data.get('download_url') or data.get('zip_url', '')).strip()
    target_version = data.get('version', '').strip()
    expected_md5 = (data.get('md5') or '').strip().lower()
    client_use_mirror = data.get('use_mirror', None)  # 前端可覆盖

    if not download_url:
        return api_response(code=400, message='缺少下载地址')

    repo = _github_repo()
    if not repo:
        return api_response(code=400, message='未配置 GitHub 仓库')

    use_mirror, mirrors, timeout = _get_mirror_config()
    # 允许前端在本次请求中覆盖镜像开关
    if client_use_mirror is not None:
        use_mirror = bool(client_use_mirror)

    _append_update_log(f'开始更新到 {target_version}...')

    try:
        # 1. 备份数据库
        db_path = os.path.join(_BASE_DIR, 'data', 'notes.db')
        if os.path.exists(db_path):
            backup_name = f'notes_backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}.db'
            backup_path = os.path.join(_BASE_DIR, 'data', backup_name)
            shutil.copy2(db_path, backup_path)
            _append_update_log(f'数据库已备份: {backup_name}')

        # 2. 下载更新包（带镜像回退和超时）
        _append_update_log(f'正在下载更新包（{"使用镜像" if use_mirror else "直连 GitHub"}）...')
        content, source = _download_with_mirrors(
            download_url, use_mirror, mirrors, timeout, log_fn=_append_update_log
        )
        _append_update_log(f'下载完成，来源: {source}，大小: {len(content) // 1024} KB')

        # 3. MD5 校验
        if expected_md5:
            _append_update_log(f'正在验证 MD5: {expected_md5}')
            if _verify_md5(content, expected_md5):
                _append_update_log('MD5 校验通过')
            else:
                actual_md5 = hashlib.md5(content).hexdigest()
                _append_update_log(f'MD5 校验失败! 期望: {expected_md5}, 实际: {actual_md5}')
                return api_response(code=500, message=f'MD5 校验失败，更新已中止。期望: {expected_md5}, 实际: {actual_md5}')
        else:
            _append_update_log('无 MD5 校验信息，跳过完整性验证')

        # 4. 解压到临时目录
        _append_update_log('正在解压...')
        tmp_dir = tempfile.mkdtemp(prefix='fluxnote_update_')
        zip_path = os.path.join(tmp_dir, 'release.zip')
        try:
            with open(zip_path, 'wb') as f:
                f.write(content)

            with zipfile.ZipFile(zip_path, 'r') as zf:
                zf.extractall(tmp_dir)
        except zipfile.BadZipFile:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _append_update_log('解压失败: 文件损坏或不是有效的 ZIP')
            return api_response(code=500, message='解压失败: 下载的文件损坏，请重试')

        # GitHub 源码 zip 内通常有一层 owner-repo-hash 目录
        extracted_dirs = [d for d in os.listdir(tmp_dir) if os.path.isdir(os.path.join(tmp_dir, d))]
        if not extracted_dirs:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _append_update_log('解压失败: 找不到内容目录')
            return api_response(code=500, message='解压失败: ZIP 内容为空')

        source_dir = os.path.join(tmp_dir, extracted_dirs[0])

        # 5. 复制文件（跳过需要保留的目录）
        _append_update_log('正在替换文件...')
        updated_count = 0
        for item in os.listdir(source_dir):
            if item in PRESERVE_PATHS:
                continue
            src = os.path.join(source_dir, item)
            dst = os.path.join(_BASE_DIR, item)
            if os.path.isdir(src):
                if os.path.exists(dst):
                    # 使用 dirs_exist_ok=True 避免删除整个目录，从而保留用户自定义文件
                    shutil.copytree(src, dst, dirs_exist_ok=True)
                else:
                    shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            updated_count += 1

        _append_update_log(f'已替换 {updated_count} 个文件/目录')

        # 6. 安装依赖
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

        # 7. 清理临时目录
        shutil.rmtree(tmp_dir, ignore_errors=True)

        _append_update_log(f'更新完成! 版本: {target_version}，服务即将重启...')

        # 8. 延迟重启（先让响应返回给前端）
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
            'source': source,
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
        download_url = _get_download_url(r, repo)
        md5_hash, _ = _extract_md5(r)
        result.append({
            'tag': tag,
            'name': r.get('name', tag),
            'changelog': r.get('body', ''),
            'published_at': r.get('published_at', ''),
            'download_url': download_url,
            'zip_url': download_url,  # 向后兼容
            'html_url': r.get('html_url', ''),
            'md5': md5_hash,
            'is_current': (ver == local_ver) if ver and local_ver else False,
            'is_newer': (ver > local_ver) if ver and local_ver else False,
        })

    return api_response(data=result)


# ───── 后台自动检查 ─────

def _do_background_check(app):
    """后台线程：定期检查更新，结果存入 Config 缓存。间隔和开关均可由用户配置。"""
    time.sleep(30)
    while True:
        try:
            with app.app_context():
                auto_enabled = Config.get('update_auto_check_enabled', 'true').lower() == 'true'
                try:
                    interval_hours = int(Config.get('update_auto_check_interval', str(DEFAULT_AUTO_CHECK_INTERVAL)))
                except (ValueError, TypeError):
                    interval_hours = DEFAULT_AUTO_CHECK_INTERVAL
                interval_secs = max(1, interval_hours) * 3600

                if auto_enabled:
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
                            download_url = _get_download_url(release, repo)
                            md5_hash, _ = _extract_md5(release)
                            Config.set('update_check_cache', json.dumps({
                                'has_update': has_update,
                                'local_version': get_app_version(),
                                'remote_version': remote_tag,
                                'release_name': release.get('name', remote_tag),
                                'changelog': release.get('body', ''),
                                'published_at': release.get('published_at', ''),
                                'download_url': download_url,
                                'zip_url': download_url,
                                'html_url': release.get('html_url', ''),
                                'md5': md5_hash,
                                'checked_at': datetime.now().isoformat(),
                            }))
                            logger.info(f'Background update check done: has_update={has_update}, remote={remote_tag}')
        except Exception as e:
            logger.debug(f'Background update check failed: {e}')
        time.sleep(interval_secs)


def start_background_update_checker(app):
    """启动后台更新检查线程（应在 app 创建完成后调用）"""
    t = threading.Thread(target=_do_background_check, args=(app,), daemon=True)
    t.name = 'update-checker'
    t.start()
    logger.info('Background update checker started')
