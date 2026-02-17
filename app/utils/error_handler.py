"""
统一错误处理模块
防止在生产环境中泄露敏感错误信息
"""
from functools import wraps
from flask import jsonify
from app.models import Config


def is_debug_mode():
    """检查是否开启调试模式"""
    return Config.get('debug_mode', 'false').lower() == 'true'


def safe_error(error, default_message='服务器内部错误，请稍后重试'):
    """
    根据调试模式返回错误信息

    Args:
        error: 异常对象或错误消息字符串
        default_message: 生产环境下显示的通用错误消息

    Returns:
        dict: 包含错误信息的字典
    """
    if is_debug_mode():
        # 调试模式：返回详细错误信息
        if isinstance(error, Exception):
            return {
                'error': str(error),
                'error_type': type(error).__name__,
                'debug': True
            }
        return {'error': str(error), 'debug': True}
    else:
        # 生产模式：返回通用错误信息
        return {'error': default_message}


def api_error_handler(default_message='服务器内部错误，请稍后重试'):
    """
    API错误处理装饰器

    用法:
        @api_error_handler('获取数据失败')
        def get_data():
            # 业务逻辑
            pass

    Args:
        default_message: 生产环境下显示的通用错误消息
    """
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            try:
                return f(*args, **kwargs)
            except Exception as e:
                # 记录错误日志（可以在调试模式下打印）
                if is_debug_mode():
                    print(f"[API Error] {type(e).__name__}: {str(e)}")
                    import traceback
                    traceback.print_exc()

                error_response = safe_error(e, default_message)
                return jsonify(error_response), 500
        return wrapped
    return decorator


def api_response(data=None, success=True, error=None, status=200):
    """
    统一API响应格式

    Args:
        data: 响应数据
        success: 是否成功
        error: 错误信息（如果失败）
        status: HTTP状态码

    Returns:
        tuple: (jsonify响应, 状态码)
    """
    if success:
        response = {'success': True}
        if data is not None:
            if isinstance(data, dict):
                response.update(data)
            else:
                response['data'] = data
    else:
        response = {'success': False}
        if error:
            # 根据调试模式处理错误信息
            if isinstance(error, Exception):
                if is_debug_mode():
                    response['error'] = str(error)
                    response['error_type'] = type(error).__name__
                else:
                    response['error'] = '服务器内部错误'
            else:
                response['error'] = error

    return jsonify(response), status
