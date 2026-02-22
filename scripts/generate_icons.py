"""
图标生成脚本
从源 PNG 文件生成各尺寸的 PWA 图标

使用方法:
    python scripts/generate_icons.py

需要安装: pip install Pillow
"""

import os
import sys

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from PIL import Image
except ImportError:
    print("错误: 需要安装 Pillow")
    print("请运行: pip install Pillow")
    sys.exit(1)

# 图标尺寸配置
SIZES = [72, 96, 128, 144, 152, 180, 192, 384, 512]

# 路径配置
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
ICONS_DIR = os.path.join(PROJECT_ROOT, 'app', 'static', 'img', 'icons')

# 源文件路径 (优先使用您提供的PNG)
SOURCE_PNG = os.path.join(PROJECT_ROOT, 'svg_1771765590204.png')


def generate_icons():
    print("开始生成 PWA 图标...")
    print(f"源文件: {SOURCE_PNG}")
    print(f"输出目录: {ICONS_DIR}")

    if not os.path.exists(SOURCE_PNG):
        print(f"错误: 未找到源文件 {SOURCE_PNG}")
        return

    if not os.path.exists(ICONS_DIR):
        os.makedirs(ICONS_DIR)

    try:
        # 打开源图片
        with Image.open(SOURCE_PNG) as img:
            # 确保是 RGBA 模式以保留透明度
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            
            print(f"源图片尺寸: {img.size}")

            # 1. 生成各尺寸标准图标
            for size in SIZES:
                output_filename = f'icon-{size}.png'
                output_path = os.path.join(ICONS_DIR, output_filename)
                
                # 高质量缩放
                resized_img = img.resize((size, size), Image.Resampling.LANCZOS)
                resized_img.save(output_path, 'PNG')
                print(f"  ✓ 生成 {output_filename}")

            # 2. 生成 Apple Touch Icon (180x180)
            apple_output = os.path.join(ICONS_DIR, 'apple-touch-icon.png')
            apple_img = img.resize((180, 180), Image.Resampling.LANCZOS)
            
            # iOS 图标通常不需要透明背景，虽然 PNG 支持。
            # 这里保持透明，或者可以加一个白色背景
            # apple_bg = Image.new('RGB', (180, 180), (255, 255, 255))
            # apple_bg.paste(apple_img, (0, 0), apple_img)
            # apple_bg.save(apple_output, 'PNG')
            
            apple_img.save(apple_output, 'PNG')
            print(f"  ✓ 生成 apple-touch-icon.png")

    except Exception as e:
        print(f"生成过程中出错: {e}")

    print("\n所有图标生成完成!")


if __name__ == '__main__':
    generate_icons()
