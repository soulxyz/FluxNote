import sqlite3
import os

DB_PATH = os.path.join('data', 'notes.db')

def migrate():
    if not os.path.exists(DB_PATH):
        return
        
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        print("Creating 'note_version' table...")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS note_version (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id VARCHAR(36) NOT NULL,
                content TEXT NOT NULL,
                title VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(note_id) REFERENCES note(id)
            )
        """)
        conn.commit()
        print("Done.")
    except Exception as e:
        print(f"Error: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == '__main__':
    migrate()