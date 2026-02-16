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

def render_theme_template(template_name, **context):
    """渲染主题模板，支持自动降级到创作主题"""
    # 优先从 context 中获取 theme_override (由路由逻辑传递)
    theme = context.get('theme_override') or get_current_theme()
    
    theme_template = f"themes/{theme}/{template_name}"

    # 检查主题模板是否存在，不存在则回退到创作主题
    template_dir = os.path.join(current_app.root_path, 'templates', 'themes', theme)
    if not os.path.exists(os.path.join(template_dir, template_name)):
        theme_template = f"themes/{get_writer_theme()}/{template_name}"

    return render_template(theme_template, **context)

def get_theme_css_url(theme_override=None):
    """获取指定主题或当前主题的主 CSS URL"""
    theme = theme_override or get_current_theme()
    return f"/static/css/themes/{theme}.css"
