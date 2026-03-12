import socket
import os
import sys
import traceback

class TeeStream:
    """同时输出到终端和日志文件"""
    def __init__(self, file, original):
        self.file = file
        self.original = original
    def write(self, data):
        self.original.write(data)
        self.file.write(data)
    def flush(self):
        self.original.flush()
        self.file.flush()

log_file = open('fluxnote_runtime.log', 'w', encoding='utf-8')
sys.stdout = TeeStream(log_file, sys.__stdout__)
sys.stderr = TeeStream(log_file, sys.__stderr__)

try:
    from waitress import serve
    from app import create_app

    def get_free_port(start_port=5001):
        """从指定的起始端口开始寻找空闲端口"""
        port = start_port
        while port <= 65535:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                try:
                    sock.bind(('0.0.0.0', port))
                    return port
                except OSError:
                    port += 10
        return start_port

    app = create_app()

    if __name__ == "__main__":
        if "--prewarm" in sys.argv:
            print("Prewarm finished successfully! Gracefully exiting...")
            sys.exit(0)

        target_port = get_free_port(int(os.environ.get("PORT", 5001)))

        with open('.port', 'w', encoding='utf-8') as f:
            f.write(str(target_port))

        print(f"Starting production server on http://0.0.0.0:{target_port}")

        serve(app, host="0.0.0.0", port=target_port)

except Exception as e:
    print("=============== FATAL CRASH ===============")
    traceback.print_exc()

finally:
    log_file.flush()
    log_file.close()
