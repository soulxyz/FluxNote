from waitress import serve
from app import create_app
import os

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Starting production server on http://0.0.0.0:{port}")
    serve(app, host="0.0.0.0", port=port)
