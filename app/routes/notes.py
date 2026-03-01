from flask import Blueprint, request, jsonify, current_app, send_from_directory
from flask_login import login_required, current_user
from sqlalchemy import func
from sqlalchemy.orm import selectinload
from app.extensions import db
from app.models import Note, User, Tag, NoteReference, NoteVersion
from app.utils.cache import invalidate_stats_cache
from app.utils import allowed_file, extract_title_and_links
from app.utils.error_handler import safe_error
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

        # Check existing first
        tag = Tag.query.filter_by(name=name).first()
        if not tag:
            try:
                # Optimistic create
                tag = Tag(name=name)
                db.session.add(tag)
                # Flush to check for potential unique constraint violations immediately if configured
                db.session.flush() 
            except Exception:
                # If race condition occurred, rollback partial transaction and re-fetch
                db.session.rollback()
                tag = Tag.query.filter_by(name=name).first()

        if tag and tag not in note.tags_list:
            note.tags_list.append(tag)

def update_note_references(note, links_list):
    """Helper to update outgoing references (NoteReference) using IDs"""
    # Remove old references
    NoteReference.query.filter_by(source_id=note.id).delete()
    
    if not links_list:
        return

    # Find IDs for these titles
    # We link to any existing note that matches the title
    target_notes = Note.query.filter(Note.title.in_(links_list), Note.is_deleted == False).all()
    
    for target in target_notes:
        # Use set to avoid duplicates if multiple notes have same title (though not ideal)
        # or if content has multiple links to same title
        ref = NoteReference(source_id=note.id, target_id=target.id)
        db.session.add(ref)

@notes_bp.route('/notes/review', methods=['GET'])
@login_required
def daily_review():
    """Get random notes for daily review"""
    try:
        # Get random 3-5 notes from the past
        # SQLite random order
        query = Note.query.filter(
            Note.user_id == current_user.id,
            Note.is_deleted == False
        ).order_by(func.random()).limit(5)

        notes = query.all()
        return jsonify([note.to_dict() for note in notes])
    except Exception as e:
        return jsonify(safe_error(e, '获取回顾笔记失败')), 500

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
        pagination = query.options(selectinload(Note.outgoing_references), selectinload(Note.incoming_references)).order_by(Note.created_at.desc()).paginate(
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
        return jsonify(safe_error(e, '获取笔记列表失败')), 500

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
        return jsonify(safe_error(e, '获取笔记标题失败')), 500

@notes_bp.route('/notes/<note_id>/backlinks', methods=['GET'])
def get_backlinks(note_id):
    """Get backlinks for a note using ID-based NoteReference table"""
    try:
        target_note = db.session.get(Note, note_id)
        if not target_note:
            return jsonify({'error': 'Note not found'}), 404

        # Efficient Query: Find all notes that reference this note ID
        query = db.session.query(Note).join(NoteReference, NoteReference.source_id == Note.id)\
            .filter(NoteReference.target_id == note_id)\
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
        return jsonify(safe_error(e, '获取反向链接失败')), 500

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
            user_id=current_user.id,
            is_public=is_public
        )

        # Update Tags Relation
        update_note_tags(new_note, tags)
        
        # Update Backlinks Relation (ID-based)
        update_note_references(new_note, links)

        db.session.add(new_note)
        db.session.commit()
        invalidate_stats_cache()

        return jsonify(new_note.to_dict()), 201
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '创建笔记失败')), 500

@notes_bp.route('/notes/<note_id>', methods=['GET'])
def get_note(note_id):
    """Get a single note (Public access allowed for public notes)"""
    try:
        note = db.session.get(Note, note_id)
        if not note:
            return jsonify({'error': '笔记不存在'}), 404

        # Check permission
        if note.is_public:
            return jsonify(note.to_dict())
            
        # Private note: requires login and owner check
        if not current_user.is_authenticated or note.user_id != current_user.id:
            return jsonify({'error': '无权查看'}), 403

        return jsonify(note.to_dict())
    except Exception as e:
        return jsonify(safe_error(e, '获取笔记失败')), 500

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
        from app.models import Config
        keep_history = Config.get('keep_history', 'true').lower() == 'true'

        if keep_history and note.content != content:
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
        note.is_public = is_public
        note.updated_at = datetime.now()

        # Update Tags Relation
        update_note_tags(note, tags)
        
        # Update Backlinks Relation (ID-based)
        update_note_references(note, links)

        db.session.commit()
        invalidate_stats_cache()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '更新笔记失败')), 500

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
        return jsonify(safe_error(e, '获取历史版本失败')), 500

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
        update_note_references(note, links)
        
        db.session.commit()
        invalidate_stats_cache()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '恢复版本失败')), 500

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
        invalidate_stats_cache()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '删除笔记失败')), 500

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
        invalidate_stats_cache()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '恢复笔记失败')), 500

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
        invalidate_stats_cache()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '永久删除笔记失败')), 500

@notes_bp.route('/notes/trash', methods=['GET'])
@login_required
def get_trash_notes():
    """Get notes in trash"""
    try:
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        
        query = Note.query.filter_by(user_id=current_user.id, is_deleted=True)
        
        pagination = query.options(selectinload(Note.outgoing_references), selectinload(Note.incoming_references)).order_by(Note.deleted_at.desc()).paginate(
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
        return jsonify(safe_error(e, '获取回收站笔记失败')), 500

@notes_bp.route('/notes/search', methods=['GET'])
def search_notes():
    """Search notes with manual pagination and multi-keyword support"""
    try:
        from app.utils import strip_markdown_for_search
        keyword_input = request.args.get('keyword', '').strip()
        tag = request.args.get('tag', '').strip()
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)

        if not keyword_input and not tag:
            return get_notes()

        query = Note.query.filter(Note.is_deleted == False)

        # Apply Auth Filters
        if current_user.is_authenticated:
            query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
            query = query.filter(Note.is_public == True)

        # Optimized Tag Search
        if tag:
            query = query.join(Note.tags_list).filter(Tag.name == tag)

        if keyword_input:
            keywords = keyword_input.split()
            
            # SQL level filter: AND logic for all keywords
            # Each keyword must match (Title OR Content)
            for k in keywords:
                query = query.filter(db.or_(Note.content.contains(k), Note.title.contains(k)))
            
            # Order by creation date descending
            query = query.order_by(Note.created_at.desc())
            
            # Fetch ALL candidates
            candidates = query.all()
            
            # Filter in Python (strip markdown/URLs)
            filtered_notes = []
            
            for note in candidates:
                note_title_lower = note.title.lower()
                searchable_content_lower = strip_markdown_for_search(note.content).lower()
                
                # Check if ALL keywords are present in either title or stripped content
                all_keywords_match = True
                for k in keywords:
                    k_lower = k.lower()
                    if k_lower not in note_title_lower and k_lower not in searchable_content_lower:
                        all_keywords_match = False
                        break
                
                if all_keywords_match:
                    filtered_notes.append(note)
            
            # Manual Pagination
            total_items = len(filtered_notes)
            total_pages = (total_items + per_page - 1) // per_page
            start = (page - 1) * per_page
            end = start + per_page
            
            paginated_notes = filtered_notes[start:end]
            has_next = end < total_items
            
            return jsonify({
                'notes': [note.to_dict() for note in paginated_notes],
                'total': total_items,
                'pages': total_pages,
                'current_page': page,
                'has_next': has_next
            })

        else:
            # Tag only search (Standard SQL Pagination)
            pagination = query.options(selectinload(Note.outgoing_references), selectinload(Note.incoming_references)).order_by(Note.created_at.desc()).paginate(
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
        return jsonify(safe_error(e, '搜索笔记失败')), 500

@notes_bp.route('/tags', methods=['GET'])
def get_tags():
    """Get all unique tags associated with accessible notes"""
    try:
        # Fetch only tags that belong to visible, non-deleted notes
        query = db.session.query(Tag.name).join(Note.tags_list).filter(Note.is_deleted == False)
        if current_user.is_authenticated:
             query = query.filter(db.or_(Note.is_public == True, Note.user_id == current_user.id))
        else:
             query = query.filter(Note.is_public == True)

        tags = [r[0] for r in query.distinct().order_by(Tag.name).all()]
        return jsonify(tags)
    except Exception as e:
        return jsonify(safe_error(e, '获取标签失败')), 500

@notes_bp.route('/notes/history/clear_all', methods=['POST'])
@login_required
def clear_all_history():
    """Delete all note versions for the current user"""
    try:
        # Join with Note to ensure we only delete current user's history
        subquery = db.session.query(Note.id).filter(Note.user_id == current_user.id).subquery()
        num_deleted = db.session.query(NoteVersion).filter(NoteVersion.note_id.in_(subquery)).delete(synchronize_session=False)
        db.session.commit()
        invalidate_stats_cache()
        return jsonify({'success': True, 'count': num_deleted})
    except Exception as e:
        db.session.rollback()
        return jsonify(safe_error(e, '清除历史版本失败')), 500
