from app import create_app
import os
import sys
import socket

app = create_app()

def get_free_port(start_port=5001):
    """
    Finds an available TCP port starting at the given port.
    
    Searches for a free port from start_port up to 65535, attempting to bind to 0.0.0.0 on each candidate. If a port is in use, the search advances by 10 and retries. If no free port is found within the range, the original start_port is returned.
    
    Parameters:
        start_port (int): The port number to start searching from.
    
    Returns:
        int: The first free port found (between start_port and 65535 when stepping by 10), or start_port if none is found.
    """
    port = start_port
    while port <= 65535:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            # 尝试绑定端口，如果不报错说明端口完全可用
            try:
                sock.bind(('0.0.0.0', port))
                return port
            except OSError:
                # 如果被占用，端口号 +10 继续找
                port += 10
    return start_port

def is_debug_mode():
    """
    Determine whether the application is configured to run in debug mode.
    
    Checks the app's configuration for the 'debug_mode' setting inside an application context and treats the string 'true' (case-insensitive) as enabled. If any error occurs while reading the configuration, the function reports that debug mode is disabled.
    
    Returns:
        True if the configured 'debug_mode' value equals 'true' (case-insensitive), False otherwise.
    """
    try:
        with app.app_context():
            from app.models import Config
            return Config.get('debug_mode', 'false').lower() == 'true'
    except:
        return False

if __name__ == '__main__':
    # 预热模式检查 - 如果带有 --prewarm 参数，在环境已经部署完毕情况下，直接安全退出
    if "--prewarm" in sys.argv:
        print("Prewarm finished successfully! Gracefully exiting...")
        sys.exit(0)

    # 1. 自动寻找空闲端口 (如果 5001 被占用，顺延到 5021, 5031...)
    target_port = get_free_port(int(os.environ.get("PORT", 5001)))
    
    # 2. 将最终决定的端口写入隐藏文件，用来"通知" C 启动器
    with open('.port', 'w', encoding='utf-8') as f:
        f.write(str(target_port))
    
    debug = is_debug_mode()
    print(f"Starting development server on http://0.0.0.0:{target_port} (debug={debug})")
    app.run(debug=debug, host='0.0.0.0', port=target_port)
