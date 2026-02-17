"""
主题系统工具模块 - 支持动态扫描与 theme.json 配置
"""

import os
import json
from flask import render_template, current_app, request
from app.models import Config

# 主题缓存
_THEMES_CACHE = {}

def get_all_themes():
    """动态扫描主题目录并获取所有主题信息"""
    global _THEMES_CACHE
    
    # 获取主题根目录
    themes_dir = os.path.join(current_app.root_path, 'templates', 'themes')
    if not os.path.exists(themes_dir):
        return {}

    themes = {}
    # 扫描子目录
    for theme_id in os.listdir(themes_dir):
        dir_path = os.path.join(themes_dir, theme_id)
        if not os.path.isdir(dir_path):
            continue
            
        json_path = os.path.join(dir_path, 'theme.json')
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    themes[theme_id] = json.load(f)
            except Exception as e:
                print(f"Error loading theme {theme_id}: {e}")
                # 降级处理
                themes[theme_id] = {
                    "name": theme_id,
                    "description": "暂无描述",
                    "author": "未知"
                }
        else:
            # 如果没有 theme.json，至少识别出文件夹名
            themes[theme_id] = {
                "name": theme_id,
                "description": "（未配置 theme.json）",
                "author": "未知"
            }
            
    _THEMES_CACHE = themes
    return themes

def get_current_theme():
    """获取当前访客（前台）主题名称"""
    return Config.get('blog_theme', 'spa')

def get_writer_theme():
    """获取当前创作者（后台）主题名称"""
    return Config.get('writer_theme', 'spa')

def set_theme(theme_name, role='blog'):
    """设置主题 (role: 'blog' 或 'writer')"""
    themes = get_all_themes()
    if theme_name not in themes:
        raise ValueError(f"未知主题: {theme_name}")
    
    config_key = 'blog_theme' if role == 'blog' else 'writer_theme'
    role_name = '博客主题' if role == 'blog' else '创作主题'
    Config.set(config_key, theme_name, role_name)

def get_theme_info(theme_name):
    """获取主题详细信息"""
    themes = get_all_themes()
    return themes.get(theme_name, {})

def get_theme_settings(theme_name):
    """
    获取指定主题的配置定义��并规范化为前端期望的结构。

    前端期望结构：
    - group: 分组标识
    - label: 分组显示名称
    - fields: 配置字段列表，每个字段包含 name, label, type 等

    支持的 theme.json 写法：
    1. 使用 fields 和 name（推荐，与前端一致）
    2. 使用 items 和 key（兼容旧写法）
    """
    info = get_theme_info(theme_name)
    settings = info.get('settings', [])

    normalized_settings = []
    for group in settings:
        # 兼容 items 和 fields 两种命名
        raw_fields = group.get('fields', group.get('items', []))

        new_fields = []
        for field in raw_fields:
            new_field = field.copy()
            # 确保字段有 name 属性（前端使用 name 作为字段标识）
            if 'name' not in new_field and 'key' in new_field:
                new_field['name'] = new_field['key']
            new_fields.append(new_field)

        normalized_settings.append({
            'group': group.get('group', ''),
            'label': group.get('label', ''),
            'fields': new_fields
        })

    return normalized_settings

def get_user_theme_config(theme_name, filter_sensitive=False):
    """
    获取用户配置（合并默认值）

    :param theme_name: 主题名称
    :param filter_sensitive: 是否过滤敏感配置（用于公开接口）
    :return: 合并后的配置字典
    """
    # 1. 获取默认配置
    settings_def = get_theme_settings(theme_name)
    default_config = {}

    # 遍历配置组和配置字段提取默认值
    for group in settings_def:
        fields = group.get('fields', [])
        for field in fields:
            name = field.get('name')
            if name:
                # 优先使用 default，如果没有则为 None
                default_config[name] = field.get('default')

    # 2. 获取用户保存的配置
    config_key = f'theme_config_{theme_name}'
    user_config_json = Config.get(config_key)

    user_config = {}
    if user_config_json:
        try:
            user_config = json.loads(user_config_json)
        except json.JSONDecodeError:
            print(f"Error decoding theme config for {theme_name}")
            user_config = {}

    # 3. 合并配置（用户配置覆盖默认配置）
    final_config = default_config.copy()
    if user_config:
        final_config.update(user_config)

    # 4. 过滤敏感配置
    if filter_sensitive:
        sensitive_prefixes = ('secret_', 'private_', '_')
        final_config = {
            k: v for k, v in final_config.items()
            if not k.startswith(sensitive_prefixes)
        }

    return final_config

def save_user_theme_config(theme_name, config_data):
    """保存用户配置"""
    if not theme_name:
        raise ValueError("Theme name is required")
        
    config_key = f'theme_config_{theme_name}'
    # 确保保存的是 JSON 字符串
    config_value = json.dumps(config_data, ensure_ascii=False)
    Config.set(config_key, config_value, f'Theme config for {theme_name}')

def render_theme_template(template_name, **context):
    """渲染主题模板，支持自动降级到创作主题"""
    # 优先从 context 中获取 theme_override (由路由逻辑传递)
    theme = context.get('theme_override') or get_current_theme()
    
    # 注入主题配置到上下文
    if 'theme_config' not in context:
        context['theme_config'] = get_user_theme_config(theme)
    
    theme_template = f"themes/{theme}/{template_name}"

    # 检查主题模板是否存在，不存在则回退到创作主题
    template_dir = os.path.join(current_app.root_path, 'templates', 'themes', theme)
    if not os.path.exists(os.path.join(template_dir, template_name)):
        writer_theme = get_writer_theme()
        theme_template = f"themes/{writer_theme}/{template_name}"
        # 如果回退了主题，配置也应该回退吗？
        # 通常不，因为我们是在当前主题的上下文中渲染（只是借用了模板），
        # 但如果模板依赖特定主题的配置，可能会报错。
        # 暂时保持使用当前主题的配置，因为这是用户的意图。

    return render_template(theme_template, **context)

def get_theme_css_url(theme_override=None):
    """
    获取指定主题或当前主题的主 CSS URL

    优先级：
    1. 主题自包含静态文件: /theme/{theme}/static/css/style.css
    2. 全局静态目录: /static/css/themes/{theme}.css
    """
    theme = theme_override or get_current_theme()

    # 检查主题自包含静态文件
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    theme_static_css = os.path.join(base_dir, 'templates', 'themes', theme, 'static', 'css', 'style.css')

    if os.path.isfile(theme_static_css):
        return f"/theme/{theme}/static/css/style.css"

    # 回退到全局静态目录
    return f"/static/css/themes/{theme}.css"
