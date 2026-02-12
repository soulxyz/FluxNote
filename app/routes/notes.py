from flask import Blueprint, request, jsonify, current_app, send_from_directory
from flask_login import login_required, current_user
from sqlalchemy import func
from app.extensions import db
from app.models import Note, User, Tag, NoteReference, NoteVersion
from app.utils import allowed_file, extract_title_and_links
from werkzeug.utils import secure_filename
from datetime import datetime
import os
import json
import uuid

notes_bp = Blueprint('notes', __name__)

def update_note_tags(note, tag_names):
    """Helper to update tags for a note"""
    # Clear existing tags
    note.tags_list = []

    for name in tag_names:
        name = name.strip()
        if not name:
            continue

        tag = Tag.query.filter_by(name=name).first()
        if not tag:
            tag = Tag(name=name)
            db.session.add(tag)

        if tag not in note.tags_list:
            note.tags_list.append(tag)

def update_note_references(note, links_list):
    """Helper to update backlinks (NoteReference)"""
    # Remove old references
    NoteReference.query.filter_by(source_id=note.id).delete()
    
    # Add new references
    # Use set to avoid duplicates
    for title in set(links_list):
        ref = NoteReference(source_id=note.id, target_title=title)
        db.session.add(ref)

@notes_bp.route('/notes', methods=['GET'])
def get_notes():
    """Get notes with pagination"""
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        tag = request.args.get('tag', '').strip()
        date_str = request.args.get('date', '').strip() # YYYY-MM-DD

        query = Note.query.filter(Note.is_deleted == False)

        if current_user.is_authenticated:
            # Show public notes AND user's own notes
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            # Show only public notes
            query = query.filter(Note.is_public == True)

        # Apply Filters
        if tag:
            query = query.join(Note.tags_list).filter(Tag.name == tag)

        if date_str:
            # SQLite specific date function
            query = query.filter(func.date(Note.created_at) == date_str)

        # Pagination
        pagination = query.order_by(Note.created_at.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )

        return jsonify({
            'notes': [note.to_dict() for note in pagination.items],
            'total': pagination.total,
            'pages': pagination.pages,
            'current_page': page,
            'has_next': pagination.has_next
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/titles', methods=['GET'])
def get_note_titles():
    """Get list of titles for autocomplete"""
    try:
        query = Note.query.filter(Note.is_deleted == False)
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        notes = query.with_entities(Note.id, Note.title).all()
        return jsonify([{'id': n.id, 'title': n.title} for n in notes])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>/backlinks', methods=['GET'])
def get_backlinks(note_id):
    """Get backlinks for a note using optimized NoteReference table"""
    try:
        target_note = db.session.get(Note, note_id)
        if not target_note:
            return jsonify({'error': 'Note not found'}), 404

        target_title = target_note.title
        if not target_title:
             return jsonify([])

        # Efficient Query: Find all notes that reference this title
        query = db.session.query(Note).join(NoteReference, NoteReference.source_id == Note.id)\
            .filter(NoteReference.target_title == target_title)\
            .filter(Note.is_deleted == False)

        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        results = query.all()
        
        backlinks = [{
            'id': n.id,
            'title': n.title,
            'updated_at': n.updated_at.strftime('%Y-%m-%d %H:%M:%S')
        } for n in results]

        return jsonify(backlinks)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        # Generate unique filename to prevent overwrites
        unique_filename = f"{uuid.uuid4().hex}_{filename}"
        file.save(os.path.join(current_app.config['UPLOAD_FOLDER'], unique_filename))
        return jsonify({'url': f'/uploads/{unique_filename}'}), 201
    return jsonify({'error': 'File type not allowed'}), 400

@notes_bp.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(current_app.config['UPLOAD_FOLDER'], filename)

@notes_bp.route('/notes', methods=['POST'])
@login_required
def create_note():
    """Create a new note"""
    try:
        data = request.json
        content = data.get('content', '').strip()
        tags = data.get('tags', [])
        is_public = data.get('is_public', False)

        if not content:
            return jsonify({'error': '内容不能为空'}), 400

        title, links = extract_title_and_links(content)

        new_note = Note(
            content=content,
            title=title,
            links=json.dumps(links, ensure_ascii=False),
            # tags column is deprecated, we update relation below
            tags=json.dumps(tags, ensure_ascii=False), # Keep for backup if needed, or set empty
            user_id=current_user.id,
            is_public=is_public
        )

        # Update Tags Relation
        update_note_tags(new_note, tags)
        
        # Update Backlinks Relation (New)
        update_note_references(new_note, links)

        db.session.add(new_note)
        db.session.commit()

        return jsonify(new_note.to_dict()), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>', methods=['GET'])
@login_required
def get_note(note_id):
    """Get a single note"""
    try:
        note = db.session.get(Note, note_id)
        if not note:
            return jsonify({'error': '笔记不存在'}), 404

        # Check permission (public notes are readable by everyone, but for editing we usually need owner)
        # But this endpoint might be used for viewing too.
        # Logic: If public, anyone can view. If private, only owner.
        if not note.is_public and note.user_id != current_user.id:
            return jsonify({'error': '无权查看'}), 403

        return jsonify(note.to_dict())
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>', methods=['PUT'])
@login_required
def update_note(note_id):
    """Update a note"""
    try:
        data = request.json
        content = data.get('content', '').strip()
        tags = data.get('tags', [])
        is_public = data.get('is_public', False)

        if not content:
            return jsonify({'error': '内容不能为空'}), 400

        note = db.session.get(Note, note_id)
        if not note:
            return jsonify({'error': '笔记不存在'}), 404

        if note.user_id != current_user.id:
            return jsonify({'error': '无权修改此笔记'}), 403

        # === Create Version History ===
        if note.content != content:
            version = NoteVersion(
                note_id=note.id,
                content=note.content,
                title=note.title,
                created_at=datetime.now()
            )
            db.session.add(version)

        title, links = extract_title_and_links(content)

        note.content = content
        note.title = title
        note.links = json.dumps(links, ensure_ascii=False)
        note.tags = json.dumps(tags, ensure_ascii=False) # Keep legacy column sync for now
        note.is_public = is_public
        note.updated_at = datetime.now()

        # Update Tags Relation
        update_note_tags(note, tags)
        
        # Update Backlinks Relation (New)
        update_note_references(note, links)

        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>/versions', methods=['GET'])
@login_required
def get_note_versions(note_id):
    """Get version history for a note"""
    try:
        note = db.session.get(Note, note_id)
        if not note:
            return jsonify({'error': 'Note not found'}), 404
        if note.user_id != current_user.id:
            return jsonify({'error': 'Unauthorized'}), 403
            
        versions = [v.to_dict() for v in note.versions]
        return jsonify(versions)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>/versions/<int:version_id>/restore', methods=['POST'])
@login_required
def restore_note_version(note_id, version_id):
    """Restore a specific version"""
    try:
        note = db.session.get(Note, note_id)
        if not note: return jsonify({'error': 'Note not found'}), 404
        if note.user_id != current_user.id: return jsonify({'error': 'Unauthorized'}), 403
        
        version = db.session.get(NoteVersion, version_id)
        if not version or version.note_id != note.id:
            return jsonify({'error': 'Version not found'}), 404
            
        # Save current state as a new version before restoring
        backup_version = NoteVersion(
            note_id=note.id,
            content=note.content,
            title=note.title,
            created_at=datetime.now()
        )
        db.session.add(backup_version)
        
        # Restore content
        note.content = version.content
        note.title = version.title
        note.updated_at = datetime.now()
        
        # Re-extract links
        title, links = extract_title_and_links(note.content)
        note.links = json.dumps(links, ensure_ascii=False)
        update_note_references(note, links)
        
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>', methods=['DELETE'])
@login_required
def delete_note(note_id):
    """Soft delete a note (move to trash)"""
    try:
        note = db.session.get(Note, note_id)
        if note:
            if note.user_id != current_user.id:
                return jsonify({'error': '无权删除此笔记'}), 403
            
            note.is_deleted = True
            note.deleted_at = datetime.now()
            db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>/restore', methods=['POST'])
@login_required
def restore_note(note_id):
    """Restore a note from trash"""
    try:
        note = db.session.get(Note, note_id)
        if not note:
            return jsonify({'error': '笔记不存在'}), 404
            
        if note.user_id != current_user.id:
            return jsonify({'error': '无权操作此笔记'}), 403
            
        note.is_deleted = False
        note.deleted_at = None
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/<note_id>/permanent', methods=['DELETE'])
@login_required
def permanent_delete_note(note_id):
    """Permanently delete a note"""
    try:
        note = db.session.get(Note, note_id)
        if note:
            if note.user_id != current_user.id:
                return jsonify({'error': '无权删除此笔记'}), 403
            db.session.delete(note)
            db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/trash', methods=['GET'])
@login_required
def get_trash_notes():
    """Get notes in trash"""
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        
        query = Note.query.filter_by(user_id=current_user.id, is_deleted=True)
        
        pagination = query.order_by(Note.deleted_at.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )

        return jsonify({
            'notes': [note.to_dict() for note in pagination.items],
            'total': pagination.total,
            'pages': pagination.pages,
            'current_page': page,
            'has_next': pagination.has_next
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/notes/search', methods=['GET'])
def search_notes():
    """Search notes"""
    try:
        keyword = request.args.get('keyword', '').strip()
        tag = request.args.get('tag', '').strip()

        if not keyword and not tag:
            return get_notes()

        query = Note.query.filter(Note.is_deleted == False)

        # Apply Auth Filters
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        if keyword:
            query = query.filter(Note.content.contains(keyword))

        # Optimized Tag Search
        if tag:
            query = query.join(Note.tags_list).filter(Tag.name == tag)

        results = query.order_by(Note.created_at.desc()).all()

        return jsonify([note.to_dict() for note in results])
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@notes_bp.route('/tags', methods=['GET'])
def get_tags():
    """Get all unique tags"""
    try:
        # Improved: Fetch from Tag table directly
        # However, we might only want tags that are used in visible notes.
        # For simplicity and performance, showing all tags is usually fine,
        # but technically we should filter.

        # If we want strictly visible tags:
        # query = db.session.query(Tag.name).join(Note.tags_list)
        # Apply auth filters on Note...
        # distinct()...

        # Let's stick to the simple approach first (all tags), or the safe approach (visible only)
        # Safe approach:
        query = db.session.query(Tag.name).join(Note.tags_list).filter(Note.is_deleted == False)
        if current_user.is_authenticated:
             query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
             query = query.filter(Note.is_public == True)

        tags = [r[0] for r in query.distinct().order_by(Tag.name).all()]
        return jsonify(tags)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
