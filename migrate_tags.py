from app import create_app
from app.extensions import db
from app.models import Note, Tag
import json

app = create_app()

def migrate_tags():
    with app.app_context():
        # Create new tables
        db.create_all()

        print("Starting tag migration...")
        notes = Note.query.all()
        count = 0

        for note in notes:
            try:
                # Parse existing JSON tags
                tag_names = json.loads(note.tags)
                if not tag_names:
                    continue

                current_tags = []
                for name in tag_names:
                    name = name.strip()
                    if not name:
                        continue

                    # Find or create tag
                    tag = Tag.query.filter_by(name=name).first()
                    if not tag:
                        tag = Tag(name=name)
                        db.session.add(tag)
                        # Flush to get ID if needed, though SQLAlchemy handles obj reference

                    if tag not in note.tags_list:
                        note.tags_list.append(tag)

                count += 1
            except Exception as e:
                print(f"Error migrating note {note.id}: {e}")

        db.session.commit()
        print(f"Successfully migrated tags for {count} notes.")

if __name__ == "__main__":
    migrate_tags()
